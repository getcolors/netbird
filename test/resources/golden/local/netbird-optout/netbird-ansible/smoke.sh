#!/usr/bin/env bash
# End-to-end proof that the control plane carries a data plane.
#
# A healthy dashboard, a valid certificate and complete OIDC discovery can all
# be true while no two peers can exchange a packet — management, signal and
# relay are one process here, and any of them can be misconfigured without a
# container reporting it. So this enrols two throwaway peers and moves traffic.
#
# The two peers share the stack's network — they have to, because a container
# cannot reach this host's public address — and are then explicitly prevented
# from taking a direct path: each drops UDP to that subnet except STUN, so
# WireGuard has nowhere direct to go and the relay is the only route left.
# Without that, the test would pass over a direct path and never touch the
# relay it claims to exercise.
set -euo pipefail

API="https://netbird.example.com/api"
PAT=$(cat /etc/netbird/secrets/pat)
RUN="smoke-$(date +%s)-$$"
COMPOSE="docker compose -f /opt/netbird/compose.yml"

log() { echo "netbird-smoke: $*" >&2; }
api() { curl -fsS -X "$1" "$API$2" -H "Authorization: Token $PAT" \
          -H 'content-type: application/json' ${3:+--data "$3"}; }

key_id=""
cleanup() {
  # Fixtures are revoked whether or not the test passed. Acceptance that
  # litters eventually cannot run: stale peers accumulate against the peer
  # count and stale setup keys are live credentials.
  set +e
  for p in a b; do
    docker rm -f "$RUN-$p" >/dev/null 2>&1
  done
  [[ -n $key_id ]] && api DELETE "/setup-keys/$key_id" >/dev/null 2>&1
  for id in $(api GET /peers 2>/dev/null | jq -r --arg r "$RUN" '.[] | select(.name|startswith($r)) | .id'); do
    api DELETE "/peers/$id" >/dev/null 2>&1
  done
  # Anything left over from an earlier run that died before its trap.
  for id in $(api GET /setup-keys 2>/dev/null | jq -r '.[] | select(.name|startswith("smoke-")) | .id'); do
    api DELETE "/setup-keys/$id" >/dev/null 2>&1
  done
  for id in $(api GET /peers 2>/dev/null | jq -r '.[] | select(.name|startswith("smoke-")) | .id'); do
    api DELETE "/peers/$id" >/dev/null 2>&1
  done
}
trap cleanup EXIT

# --- 1. the device-code grant ----------------------------------------------
#
# `netbird up` on a CLI client uses this, and it is a different Authentik flow
# from the browser's authorization code. A working dashboard login is not
# evidence that it exists, so ask for a grant rather than for the endpoint.
log "checking the device-code grant"
disco=$(curl -fsS "https://authentik.example.com/application/o/netbird/.well-known/openid-configuration")
dev_ep=$(jq -r '.device_authorization_endpoint' <<<"$disco")
[[ $dev_ep != null && -n $dev_ep ]] || { log "FAIL: no device_authorization_endpoint advertised"; exit 1; }
grant=$(curl -fsS -X POST "$dev_ep" -d "client_id=netbird" -d "scope=openid profile email" || true)
if ! jq -e '.device_code and .user_code and .verification_uri' >/dev/null <<<"$grant"; then
  log "FAIL: the device-code endpoint issued no grant: $grant"
  log "  the default-device-code-flow is probably not assigned as the brand default"
  exit 1
fi
log "device-code grant issued"

# --- 2. two peers, relayed --------------------------------------------------

log "creating a throwaway setup key"
key_json=$(api POST /setup-keys "$(jq -nc --arg n "$RUN" \
  '{name:$n, type:"reusable", expires_in:3600, usage_limit:4, auto_groups:[], ephemeral:true}')")
key_id=$(jq -r '.id' <<<"$key_json")
key=$(jq -r '.key' <<<"$key_json")
[[ -n $key && $key != null ]] || { log "FAIL: no setup key returned"; exit 1; }

# Both peers sit on the stack's own network, because a container cannot reach
# this host's public address — hairpin NAT drops it — and the management URL
# has to be the public one. `--add-host` sends that name to Traefik in-network,
# exactly as netbird-server reaches Authentik.
#
# Being on one network would ordinarily let the peers find each other's
# addresses and connect directly, which would make a "relayed" assertion a lie.
# So each peer drops UDP to the stack subnet, with one exception for STUN. The
# control plane is TCP 443 to Traefik and is untouched; WireGuard is UDP and
# has nowhere direct to go, so the only path left is the relay.
# Ask the running stack what its network is called rather than reproducing
# Compose's project-name rule, which derives from the directory and is not the
# profile.
NET=$(docker inspect netbird-traefik \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
[[ -n $NET ]] || { log "FAIL: cannot determine the stack network"; exit 1; }

for p in a b; do
  docker run -d --name "$RUN-$p" --network "$NET" \
    --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE \
    --add-host "netbird.example.com:172.30.0.10" \
    -e NB_SETUP_KEY="$key" \
    -e NB_MANAGEMENT_URL="https://netbird.example.com" \
    -e NB_HOSTNAME="$RUN-$p" \
    netbirdio/netbird:0.77.1 >/dev/null
done

log "forcing the relayed path"
for p in a b; do
  docker exec "$RUN-$p" sh -c '
    iptables -A OUTPUT -d 172.30.0.0/24 -p udp --dport 3478 -j ACCEPT
    iptables -A OUTPUT -d 172.30.0.0/24 -p udp -j DROP
  ' 2>/dev/null || log "warning: could not install the isolation rules in $RUN-$p"
done

log "waiting for both peers to register"
for i in $(seq 1 60); do
  n=$(api GET /peers | jq -r --arg r "$RUN" '[.[] | select(.name|startswith($r))] | length')
  [[ $n == 2 ]] && break
  [[ $i == 60 ]] && { log "FAIL: only $n of 2 peers registered"; exit 1; }
  sleep 5
done

ip_b=$(api GET /peers | jq -r --arg n "$RUN-b" '.[] | select(.name==$n) | .ip')
[[ -n $ip_b && $ip_b != null ]] || { log "FAIL: peer b has no address"; exit 1; }

log "moving traffic from a to b ($ip_b)"
ok=0
for i in $(seq 1 30); do
  if docker exec "$RUN-a" ping -c 2 -W 2 "$ip_b" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
[[ $ok == 1 ]] || { log "FAIL: no traffic between the peers"; docker exec "$RUN-a" netbird status -d >&2 || true; exit 1; }

# The path must be relayed. If it came up direct, the isolation above failed
# and this test proved something other than what it claims to.
status=$(docker exec "$RUN-a" netbird status -d 2>/dev/null || true)
if ! grep -qiE 'relayed|relay' <<<"$status"; then
  log "FAIL: traffic flowed but not over the relay; the isolation rules did not hold"
  echo "$status" >&2
  exit 1
fi

log "PASS: two peers exchanged traffic over the relay"
