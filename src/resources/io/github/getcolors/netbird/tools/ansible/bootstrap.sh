#!/usr/bin/env bash
# Guarded, idempotent bootstrap of the NetBird control plane.
#
# Every step is conditioned on observed state, so running this twice changes
# nothing. That is what lets a one-way initialisation — which is what creating
# an account is — live inside desired state.
#
# The order is forced by the product, not chosen:
#
#   1. registering an identity provider needs an authenticated caller, and the
#      only headless way to get the first one is POST /api/setup, which works
#      exactly once and mints a local owner in a *local* account;
#   2. that PAT is short-lived and cannot be reissued, so it is exchanged at
#      once for a durable one and then destroyed;
#   3. Authentik is registered as an identity provider with that credential;
#   4. the account that matters is then created by its first federated login,
#      which is driven here rather than left to a browser.
#
# Step 4 is the one that surprises. A user arriving through an external
# identity provider does not join the local account: NetBird gives them their
# own, where they are already owner with nothing pending. There is no merge —
# `POST /api/users` creates a *local* user in the local account, and the admin
# CLI only manages embedded-IdP identities. So there is no promotion to
# perform and no approval to grant; the federated account simply has to be
# brought into existence and then used.
#
# The consequence is stated plainly in CLAUDE.md rather than papered over: the
# local owner is not a way back into the federated network. If Authentik is
# lost, recovery is a restore, or re-registering an identity provider with the
# local credential.
set -euo pipefail

API="https://<{ netbird-host }>/api"
SECRETS=/etc/netbird/secrets
STATE=/etc/netbird/state
umask 077
mkdir -p "$SECRETS" "$STATE"

log() { echo "netbird-bootstrap: $*" >&2; }

# `local` here means the embedded-IdP account, and `pat` the federated one that
# everything downstream uses.
local_pat() { cat "$SECRETS/local_pat" 2>/dev/null || true; }

api() { # api TOKEN METHOD PATH [BODY]
  local token=$1 method=$2 path=$3 body=${4:-}
  if [[ -n $body ]]; then
    curl -fsS -X "$method" "$API$path" -H "Authorization: Token $token" \
      -H 'content-type: application/json' --data "$body"
  else
    curl -fsS -X "$method" "$API$path" -H "Authorization: Token $token"
  fi
}

durable_token_for() { # durable_token_for TOKEN NAME
  local token=$1 name=$2 me
  me=$(api "$token" GET /users | jq -r '.[] | select(.is_current==true) | .id' | head -1)
  [[ -n $me ]] || return 1
  api "$token" POST "/users/$me/tokens" \
    "$(jq -nc --arg n "$name" '{name:$n, expires_in:365}')" | jq -r '.plain_token // empty'
}

# --- 1. the local account, solely to gain a credential ----------------------

if [[ -z $(local_pat) ]]; then
  log "no local credential; attempting first-owner setup"
  setup_body=$(jq -nc \
    --arg e "<{ netbird-bootstrap-email }>" \
    --arg n "<{ netbird-bootstrap-name }>" \
    --arg p "$(cat "$SECRETS/bootstrap_password")" \
    '{email:$e, name:$n, password:$p, create_pat:true, pat_expire_in:7}')

  if setup_out=$(curl -fsS -X POST "$API/setup" -H 'content-type: application/json' \
                   --data "$setup_body" 2>/dev/null); then
    setup_pat=$(jq -r '.personal_access_token // empty' <<<"$setup_out")
    [[ -n $setup_pat ]] || { log "FATAL: /api/setup returned no PAT"; exit 1; }
    log "local owner created"
  else
    log "FATAL: this instance is already set up but no local credential is stored."
    log "  The one-time setup PAT cannot be reissued. Recover by creating a PAT"
    log "  in the dashboard as <{ netbird-bootstrap-email }> and writing it to"
    log "  $SECRETS/local_pat with mode 0600, then converge again."
    exit 1
  fi

  # The setup PAT expires in days and everything after this line depends on a
  # credential that does not.
  durable=$(durable_token_for "$setup_pat" "colors-local") \
    || { log "FATAL: could not create the durable local credential"; exit 1; }
  [[ -n $durable ]] || { log "FATAL: empty durable local credential"; exit 1; }
  printf '%s' "$durable" > "$SECRETS/local_pat"; chmod 0600 "$SECRETS/local_pat"
  unset setup_pat setup_out durable
  log "local credential stored; setup PAT discarded"
fi

LOCAL=$(local_pat)

# --- 2. Authentik as an identity provider -----------------------------------

issuer="https://<{ netbird-authentik-host }>/application/o/netbird/"
idp=$(api "$LOCAL" GET /identity-providers | jq -r --arg i "$issuer" \
  '.[] | select(.issuer==$i) | .id' | head -1)

if [[ -z $idp ]]; then
  log "registering Authentik as an identity provider"
  idp=$(api "$LOCAL" POST /identity-providers "$(jq -nc \
    --arg i "$issuer" \
    --arg c "<{ netbird-oidc-client-id }>" \
    --arg s "$(cat "$SECRETS/oidc_client_secret")" \
    '{type:"oidc", name:"Authentik", issuer:$i, client_id:$c, client_secret:$s}')" \
    | jq -r '.id')
  [[ -n $idp && $idp != null ]] || { log "FATAL: the identity provider was not created"; exit 1; }
  log "identity provider registered as $idp"
else
  # Drift is as much a failure as absence: a client id that no longer matches
  # desired state means logins break with a green stack.
  got=$(api "$LOCAL" GET "/identity-providers/$idp" | jq -r '.client_id')
  if [[ $got != "<{ netbird-oidc-client-id }>" ]]; then
    log "identity provider drifted (client_id=$got); correcting"
    api "$LOCAL" PUT "/identity-providers/$idp" "$(jq -nc \
      --arg i "$issuer" \
      --arg c "<{ netbird-oidc-client-id }>" \
      --arg s "$(cat "$SECRETS/oidc_client_secret")" \
      '{type:"oidc", name:"Authentik", issuer:$i, client_id:$c, client_secret:$s}')" >/dev/null
  fi
fi
printf '%s' "$idp" > "$STATE/idp-id"

# --- 3. the federated account, created by its first login -------------------

if [[ -n $(cat "$SECRETS/pat" 2>/dev/null || true) ]] \
   && api "$(cat "$SECRETS/pat")" GET /users >/dev/null 2>&1; then
  log "federated credential already valid"
else
  log "signing in as <{ netbird-authentik-bootstrap-email }> through Authentik"
  token=$(/usr/local/sbin/netbird-federated-login \
            "$idp" "<{ netbird-host }>" "<{ netbird-authentik-host }>" \
            "akadmin" "$SECRETS/authentik_bootstrap_password") \
    || { log "FATAL: the federated login failed"; exit 1; }

  # The account exists from this moment. A PAT minted for that identity is what
  # every later converge, backup and acceptance run uses.
  me=$(curl -fsS "$API/users" -H "Authorization: Bearer $token" \
       | jq -r '.[] | select(.is_current==true) | .id' | head -1)
  [[ -n $me ]] || { log "FATAL: the federated identity did not resolve to a user"; exit 1; }
  pat=$(curl -fsS -X POST "$API/users/$me/tokens" -H "Authorization: Bearer $token" \
        -H 'content-type: application/json' \
        --data "$(jq -nc '{name:"colors-automation", expires_in:365}')" \
        | jq -r '.plain_token // empty')
  [[ -n $pat ]] || { log "FATAL: could not mint the federated credential"; exit 1; }
  printf '%s' "$pat" > "$SECRETS/pat"; chmod 0600 "$SECRETS/pat"
  unset token pat
  log "federated account created and credential stored"
fi

PAT=$(cat "$SECRETS/pat")

# --- 4. rotate before it lapses ---------------------------------------------

expiry=$(api "$PAT" GET /tokens 2>/dev/null | jq -r \
  '[.[] | select(.name=="colors-automation")] | sort_by(.expiration_date) | last | .expiration_date // empty' \
  || true)
if [[ -n ${expiry:-} ]]; then
  days=$(( ( $(date -d "$expiry" +%s) - $(date +%s) ) / 86400 ))
  if (( days < 30 )); then
    log "federated credential expires in ${days}d; rotating"
    if fresh=$(durable_token_for "$PAT" "colors-automation") && [[ -n $fresh ]]; then
      printf '%s' "$fresh" > "$SECRETS/pat"; chmod 0600 "$SECRETS/pat"; PAT=$fresh
      log "rotated"
    fi
  fi
fi

# --- 5. assert what was actually built --------------------------------------

owner=$(api "$PAT" GET /users | jq -r --arg e "<{ netbird-authentik-bootstrap-email }>" \
  '.[] | select(.email==$e and .is_current==true) | .role' | head -1)
if [[ $owner != owner ]]; then
  log "FATAL: <{ netbird-authentik-bootstrap-email }> is '$owner' in the federated account, not owner"
  exit 1
fi
log "federated account owned by <{ netbird-authentik-bootstrap-email }>"
log "bootstrap complete"
