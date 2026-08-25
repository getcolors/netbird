#!/usr/bin/env bash
# What an operator runs to see whether this host is well. Deliberately local
# and queryable rather than an alerting integration: this package ships no
# monitoring stack, and pretending otherwise would be the same class of error
# as trusting an exit code.
set -uo pipefail
COMPOSE="docker compose -f /opt/netbird/compose.yml"

echo "== containers"
$COMPOSE ps --format 'table {{.Name}}\t{{.Status}}'

echo; echo "== certificates"
for h in netbird.example.com authentik.example.com; do
  exp=$(echo | openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  echo "$h expires $exp"
done

echo; echo "== backups"
if [[ -f /etc/netbird/state/first-backup-done ]]; then
  systemctl list-timers netbird-backup.timer --no-pager | sed -n '1,3p'
  systemctl is-failed netbird-backup.service >/dev/null && echo "LAST BACKUP FAILED" || true
else
  echo "no backup has completed yet"
fi

echo; echo "== ownership"
if [[ -f /etc/netbird/state/owner-transfer ]]; then
  echo "PENDING: admin@example.com has not signed in through Authentik yet"
else
  echo "transferred"
fi
