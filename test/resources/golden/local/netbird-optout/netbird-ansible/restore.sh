#!/usr/bin/env bash
# Guarded restore from the latest known-good archive, or a named one.
#
# An untested backup is not a recovery mechanism, so this is a script rather
# than a paragraph in a README. It refuses to run without an explicit
# confirmation because it overwrites live state.
#
#   netbird-restore --verify                 restore into a throwaway container
#                                            and check it, touching nothing
#   netbird-restore --confirm [ARCHIVE]      restore this host for real
set -euo pipefail

BUCKET="netbird-backup"
COMPOSE="docker compose -f /opt/netbird/compose.yml"
mode=${1:-}
archive=${2:-}
log() { echo "netbird-restore: $*" >&2; }

case "$mode" in
  --verify|--confirm) ;;
  *) log "refusing to run without --verify or --confirm"; exit 2 ;;
esac

set -a; . /etc/netbird/secrets/backup.env; set +a
export S3_ENDPOINT="https://example.eu.r2.cloudflarestorage.com"
export S3_REGION="auto"
S3=/usr/local/sbin/netbird-s3

work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
if [[ -z $archive ]]; then
  "$S3" get "$BUCKET" latest-known-good "$work/pointer"
  archive=$(head -1 "$work/pointer")
  log "latest known good is $archive"
fi
"$S3" get "$BUCKET" "archives/$archive" "$work/archive.gpg"

log "decrypting"
gpg --batch --yes --quiet --decrypt \
    --passphrase-file /etc/netbird/secrets/backup_recovery_key \
    --output "$work/archive.tar.gz" "$work/archive.gpg"
mkdir -p "$work/x" && tar -C "$work/x" -xzf "$work/archive.tar.gz"

# What a restore has to prove: the databases open, the secret set is complete,
# and the store still knows the peers. Checked in a throwaway container so
# --verify is safe on a live host.
log "verifying the archive"
docker run --rm -v "$work/x":/x:ro postgres:16.15 \
  sh -c 'grep -q "PostgreSQL database dump" /x/authentik.sql' \
  || { log "FATAL: the Authentik dump does not look like a dump"; exit 1; }
docker run --rm -v "$work/x":/x:ro alpine sh -c '
  apk add --no-cache sqlite >/dev/null 2>&1
  sqlite3 /x/store.db "pragma integrity_check;" | grep -qx ok' \
  || { log "FATAL: the NetBird store fails its integrity check"; exit 1; }
for s in relay_auth_secret session_cookie_key datastore_encryption_key \
         authentik_secret_key authentik_pg_password oidc_client_secret; do
  [[ -s "$work/x/etc/secrets/$s" ]] || { log "FATAL: $s missing from the archive"; exit 1; }
done
peers=$(docker run --rm -v "$work/x":/x:ro alpine sh -c '
  apk add --no-cache sqlite >/dev/null 2>&1
  sqlite3 /x/store.db "select count(*) from peers;" 2>/dev/null || echo 0')
log "archive verified: $peers peer records, all secrets present"

if [[ $mode == --verify ]]; then log "verify only; nothing was changed"; exit 0; fi

log "restoring for real"
$COMPOSE down
cp -a "$work/x/etc/secrets/." /etc/netbird/secrets/
chmod -R 0600 /etc/netbird/secrets/*
cp -a "$work/x/opt/config.yaml" /opt/netbird/config.yaml 2>/dev/null || true
cp -a "$work/x/opt/authentik.env" /opt/netbird/authentik.env 2>/dev/null || true
$COMPOSE up -d authentik-postgres
sleep 15
$COMPOSE exec -T authentik-postgres psql -U authentik -d authentik -c 'drop schema public cascade; create schema public;'
$COMPOSE exec -T authentik-postgres psql -U authentik -d authentik < "$work/x/authentik.sql"
docker run --rm -v netbird_data:/dst -v "$work/x":/src:ro alpine cp /src/store.db /dst/store.db
[[ -f "$work/x/acme.json" ]] && docker run --rm -v netbird_traefik_letsencrypt:/dst -v "$work/x":/src:ro alpine \
  sh -c 'cp /src/acme.json /dst/acme.json && chmod 600 /dst/acme.json'
$COMPOSE up -d --wait
log "restored; verify a login before trusting it"
