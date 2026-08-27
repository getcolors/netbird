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
for h in <{ netbird-host }> <{ netbird-authentik-host }>; do
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

echo; echo "== accounts"
# Two, and deliberately so. The federated account is the deployment; the local
# one exists because registering an identity provider needs an authenticated
# caller and only /api/setup can produce the first. The local owner is not a
# way back into the federated network — see CLAUDE.md.
for pair in "federated:/etc/netbird/secrets/pat" "local:/etc/netbird/secrets/local_pat"; do
  name=${pair%%:*}; file=${pair#*:}
  if [[ -s $file ]]; then
    who=$(curl -fsS -H "Authorization: Token $(cat "$file")" \
          https://<{ netbird-host }>/api/users 2>/dev/null \
          | jq -r ".[] | select(.is_current==true) | \"\(.email) (\(.role))\"" | head -1)
    echo "  $name: ${who:-unreachable}"
  else
    echo "  $name: no credential"
  fi
done
