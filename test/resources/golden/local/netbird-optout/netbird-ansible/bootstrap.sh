#!/usr/bin/env bash
# Guarded, idempotent bootstrap of the NetBird control plane.
#
# Every step is conditioned on observed state, so running this twice changes
# nothing. That is what lets a one-way initialisation — which is what creating
# the first owner is — live inside desired state.
#
# The order is forced by the product, not chosen:
#   1. an owner must exist before anything can be configured, and the only
#      headless way to create one is POST /api/setup, which works exactly once;
#   2. the PAT that call returns is short-lived and cannot be reissued, so it
#      is exchanged immediately for a durable one and then destroyed;
#   3. the external IdP can only be added by an authenticated caller;
#   4. ownership transfers to the Authentik user only after that user has
#      logged in once and NetBird has imported it.
set -euo pipefail

API="https://netbird.example.com/api"
SECRETS=/etc/netbird/secrets
STATE=/etc/netbird/state
umask 077
mkdir -p "$SECRETS" "$STATE"

log() { echo "netbird-bootstrap: $*" >&2; }
api() { # api METHOD PATH [BODY]
  local m=$1 p=$2 body=${3:-}
  if [[ -n $body ]]; then
    curl -fsS -X "$m" "$API$p" -H "Authorization: Token $PAT" \
      -H 'content-type: application/json' --data "$body"
  else
    curl -fsS -X "$m" "$API$p" -H "Authorization: Token $PAT"
  fi
}

# --- 1. the durable automation credential ----------------------------------

if [[ -s $SECRETS/pat ]]; then
  PAT=$(cat "$SECRETS/pat")
  log "using the stored durable credential"
else
  log "no durable credential; attempting first-owner setup"
  setup_body=$(jq -nc \
    --arg e "breakglass@example.com" \
    --arg n "Break Glass" \
    --arg p "$(cat "$SECRETS/bootstrap_password")" \
    '{email:$e, name:$n, password:$p, create_pat:true, pat_expire_in:7}')

  # A 4xx here is the normal "already set up" answer, not a failure. It is only
  # fatal if no durable credential exists either, which means the short-lived
  # setup PAT expired before this ever ran — recoverable, but only by a human
  # with dashboard access.
  if setup_out=$(curl -fsS -X POST "$API/setup" -H 'content-type: application/json' \
                   --data "$setup_body" 2>/dev/null); then
    setup_pat=$(jq -r '.personal_access_token // empty' <<<"$setup_out")
    [[ -n $setup_pat ]] || { log "FATAL: /api/setup returned no PAT"; exit 1; }
    log "first owner created"
  else
    log "FATAL: this instance is already set up but no durable credential is stored."
    log "  The one-time setup PAT cannot be reissued. Recover by creating a PAT"
    log "  in the dashboard as the break-glass administrator and writing it to"
    log "  $SECRETS/pat with mode 0600, then converge again."
    exit 1
  fi

  # Exchange it at once. The setup PAT expires in days; everything after this
  # line, on every future converge, depends on the credential created here.
  PAT=$setup_pat
  me=$(api GET /users | jq -r '.[] | select(.is_service_user != true) | .id' | head -1)
  [[ -n $me ]] || { log "FATAL: cannot identify the bootstrap user"; exit 1; }
  durable=$(api POST "/users/$me/tokens" \
    "$(jq -nc --arg n "colors-automation" '{name:$n, expires_in:365}')" \
    | jq -r '.plain_token // empty')
  [[ -n $durable ]] || { log "FATAL: could not create the durable credential"; exit 1; }
  printf '%s' "$durable" > "$SECRETS/pat"
  chmod 0600 "$SECRETS/pat"
  PAT=$durable
  # The setup PAT is transient by construction: after the exchange it grants
  # nothing the durable credential does not. It is never written to disk and
  # never reaches a backup.
  unset setup_pat setup_out
  log "durable credential stored; setup PAT discarded"
fi

# --- 2. rotate the durable credential before it lapses ----------------------

remaining=$(api GET /tokens 2>/dev/null | jq -r \
  '[.[] | select(.name=="colors-automation")] | sort_by(.expiration_date) | last | .expiration_date // empty' \
  || true)
if [[ -n ${remaining:-} ]]; then
  days=$(( ( $(date -d "$remaining" +%s) - $(date +%s) ) / 86400 ))
  if (( days < 30 )); then
    log "durable credential expires in ${days}d; rotating"
    me=$(api GET /users | jq -r '.[] | select(.is_service_user != true) | .id' | head -1)
    fresh=$(api POST "/users/$me/tokens" \
      "$(jq -nc '{name:"colors-automation", expires_in:365}')" | jq -r '.plain_token // empty')
    if [[ -n $fresh ]]; then
      printf '%s' "$fresh" > "$SECRETS/pat"; chmod 0600 "$SECRETS/pat"; PAT=$fresh
      log "rotated"
    fi
  fi
fi

# --- 3. Authentik as an identity provider -----------------------------------

issuer="https://authentik.example.com/application/o/netbird/"
existing=$(api GET /identity-providers | jq -r --arg i "$issuer" \
  '.[] | select(.issuer==$i) | .id' | head -1)

if [[ -z $existing ]]; then
  log "registering Authentik as an identity provider"
  api POST /identity-providers "$(jq -nc \
    --arg i "$issuer" \
    --arg c "netbird" \
    --arg s "$(cat "$SECRETS/oidc_client_secret")" \
    '{type:"oidc", name:"Authentik", issuer:$i, client_id:$c, client_secret:$s}')" >/dev/null
  log "identity provider registered"
else
  # Configuration drift is as much a failure as absence: an issuer or client id
  # that no longer matches desired state means logins break with a green stack.
  actual=$(api GET "/identity-providers/$existing")
  got_id=$(jq -r '.client_id' <<<"$actual")
  if [[ $got_id != "netbird" ]]; then
    log "identity provider drifted (client_id=$got_id); correcting"
    api PUT "/identity-providers/$existing" "$(jq -nc \
      --arg i "$issuer" \
      --arg c "netbird" \
      --arg s "$(cat "$SECRETS/oidc_client_secret")" \
      '{type:"oidc", name:"Authentik", issuer:$i, client_id:$c, client_secret:$s}')" >/dev/null
  fi
fi

# --- 4. transfer ownership to the Authentik user ----------------------------
#
# Configuring the IdP does not create that user. NetBird imports it the first
# time it authenticates, and the article shows what happens then: the login
# lands in "User approval pending". So this step can only complete after a
# human has signed in once with Authentik — and it completes by itself on the
# next converge, which is why it is written as a condition rather than a
# prompt.

owner_email="admin@example.com"
users=$(api GET /users)
target=$(jq -r --arg e "$owner_email" \
  '.[] | select(.email==$e and (.is_service_user != true)) | .id' <<<"$users" | head -1)

if [[ -z $target ]]; then
  echo pending > "$STATE/owner-transfer"
  log "PENDING: $owner_email has not signed in through Authentik yet."
  log "  Sign in once at https://netbird.example.com/ with the Authentik option,"
  log "  then converge again and ownership transfers automatically."
else
  current_role=$(jq -r --arg e "$owner_email" '.[] | select(.email==$e) | .role' <<<"$users" | head -1)
  if [[ $current_role != owner ]]; then
    log "promoting $owner_email to owner (currently $current_role)"
    # Approval and promotion are the same write: a pending user that becomes
    # owner is, by definition, approved.
    api PUT "/users/$target" "$(jq -nc \
      --arg r owner --arg e "$owner_email" \
      '{role:$r, auto_groups:[], is_blocked:false}')" >/dev/null
    sleep 3
  fi
  # Read the role back. Promotion transfers ownership rather than adding a
  # second owner, so this also confirms the break-glass account has become an
  # administrator rather than silently losing access.
  final=$(api GET /users | jq -r --arg e "$owner_email" '.[] | select(.email==$e) | .role' | head -1)
  if [[ $final != owner ]]; then
    log "FATAL: $owner_email is '$final' after promotion, not owner"
    exit 1
  fi
  rm -f "$STATE/owner-transfer"
  log "ownership confirmed: $owner_email is owner"
fi

log "bootstrap complete"
