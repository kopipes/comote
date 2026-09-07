#!/bin/sh
set -eu

umask 077
exec 9>/run/lock/comote-maintenance.lock
flock -n 9 || exit 0

health_url=http://127.0.0.1:4173/api/health

if curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; then
  exit 0
fi

sleep 3
if curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null; then
  exit 0
fi

logger -t comote-healthcheck 'Health probe failed; restarting comote.service'
systemctl restart comote.service
sleep 3
curl --fail --silent --show-error --max-time 10 "$health_url" >/dev/null
logger -t comote-healthcheck 'Comote recovered after automatic restart'
