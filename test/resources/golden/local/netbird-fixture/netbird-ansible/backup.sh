#!/usr/bin/env bash
# Encrypted backup of everything needed to rebuild this deployment.
#
# The restore set is enumerated rather than gestured at, because each of these
# is individually fatal to lose: the store holds every peer and its identity,
# the secrets decrypt it, Authentik's Postgres holds the users, and the ACME
# store avoids re-issuing certificates into a rate limit.
#
# The archive therefore contains this deployment's crown jewels in plaintext,
# so it is encrypted before it leaves the host. R2 access control and TLS do
# not protect against a compromised bucket or an object exposed by accident.
set -euo pipefail

STAGE="/var/backups/netbird"
BUCKET="netbird-backup"
COMPOSE="docker compose -f /opt/netbird/compose.yml"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
work="$STAGE/work.$$"
archive="$STAGE/netbird-$stamp.tar.gz.gpg"

log() { echo "netbird-backup: $*" >&2; }
trap 'rm -rf "$work"' EXIT
umask 077
mkdir -p "$work"

# SQLite will hand out a torn copy if it is read while NetBird is writing, and
# a torn store restores into a database that opens and then fails. `.backup`
# takes a consistent snapshot of a live database; a plain `cp` does not.
log "snapshotting the NetBird store"
$COMPOSE exec -T netbird-server sh -c \
  'command -v sqlite3 >/dev/null && sqlite3 /var/lib/netbird/store.db ".backup /tmp/store.db"' 2>/dev/null \
  && $COMPOSE cp netbird-server:/tmp/store.db "$work/store.db" \
  || {
    # No sqlite3 in the image: stop the writer for the length of a file copy
    # rather than take a copy that may be inconsistent.
    log "sqlite3 unavailable in the image; stopping the server for a consistent copy"
    $COMPOSE stop netbird-server >/dev/null
    $COMPOSE cp netbird-server:/var/lib/netbird/store.db "$work/store.db" || true
    $COMPOSE start netbird-server >/dev/null
  }

log "dumping Authentik's database"
$COMPOSE exec -T authentik-postgres pg_dump -U authentik -d authentik > "$work/authentik.sql"
[[ -s $work/authentik.sql ]] || { log "FATAL: the Authentik dump is empty"; exit 1; }

log "collecting configuration, secrets and certificates"
mkdir -p "$work/etc" "$work/opt"
# The setup PAT is deliberately absent: it is destroyed after the exchange and
# has no recovery value. Everything else in this directory is create-once and
# must come back together or not at all.
cp -a /etc/netbird/secrets "$work/etc/secrets"
rm -f "$work/etc/secrets/backup_recovery_key"   # never back up the key to the backup
cp -a /opt/netbird/config.yaml "$work/opt/" 2>/dev/null || true
cp -a /opt/netbird/authentik.env "$work/opt/" 2>/dev/null || true
cp -a /opt/netbird/blueprints "$work/opt/blueprints" 2>/dev/null || true
docker run --rm -v netbird_traefik_letsencrypt:/src:ro -v "$work":/dst alpine \
  sh -c 'cp -a /src/acme.json /dst/acme.json 2>/dev/null || true'
docker run --rm -v authentik_media:/src:ro -v "$work":/dst alpine \
  sh -c 'tar -C /src -czf /dst/authentik-media.tar.gz . 2>/dev/null || true'
docker run --rm -v authentik_certs:/src:ro -v "$work":/dst alpine \
  sh -c 'tar -C /src -czf /dst/authentik-certs.tar.gz . 2>/dev/null || true'
$COMPOSE config --images > "$work/images.txt"

log "encrypting"
# Symmetric AES-256 under the operator's recovery key, with GPG's integrity
# protection so a corrupted archive fails loudly rather than restoring garbage.
# Scriptable without a terminal, which `age -p` is not.
tar -C "$work" -czf - . \
  | gpg --batch --yes --quiet --symmetric --cipher-algo AES256 \
        --passphrase-file /etc/netbird/secrets/backup_recovery_key \
        --output "$archive"
[[ -s $archive ]] || { log "FATAL: the archive is empty"; exit 1; }

set -a; . /etc/netbird/secrets/backup.env; set +a
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ENDPOINT="https://example.eu.r2.cloudflarestorage.com"
export RCLONE_CONFIG_R2_REGION="auto"
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"

# Upload under an immutable timestamped key, verify it, and only then advance
# the pointer. Verifying after overwriting a well-known key would mean a
# truncated upload had already become the newest backup.
log "uploading $stamp"
rclone copyto "$archive" "r2:$BUCKET/archives/netbird-$stamp.tar.gz.gpg"
local_sum=$(sha256sum "$archive" | cut -d' ' -f1)
remote_size=$(rclone size --json "r2:$BUCKET/archives/netbird-$stamp.tar.gz.gpg" | jq -r '.bytes')
local_size=$(stat -c%s "$archive")
[[ "$remote_size" == "$local_size" ]] || { log "FATAL: uploaded $local_size bytes, remote reports $remote_size"; exit 1; }

printf '%s\n%s\n' "netbird-$stamp.tar.gz.gpg" "$local_sum" \
  | rclone rcat "r2:$BUCKET/latest-known-good"
log "pointer advanced to $stamp"

# Prune only archives the pointer has moved past, and never the newest.
mapfile -t old < <(rclone lsf "r2:$BUCKET/archives/" | sort | head -n -1)
for f in "${old[@]}"; do
  age_days=$(( ( $(date -u +%s) - $(date -u -d "$(sed -E 's/netbird-([0-9]{8})T([0-9]{6})Z.*/\1 \2/;s/([0-9]{4})([0-9]{2})([0-9]{2}) ([0-9]{2})([0-9]{2})([0-9]{2})/\1-\2-\3 \4:\5:\6/' <<<"$f")" +%s 2>/dev/null || date -u +%s) ) / 86400 ))
  if (( age_days > 7 )); then
    rclone deletefile "r2:$BUCKET/archives/$f" && log "pruned $f"
  fi
done

rm -f "$STAGE"/netbird-*.tar.gz.gpg
touch /etc/netbird/state/first-backup-done
log "done"
