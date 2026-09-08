#!/bin/sh
set -eu

umask 077
exec 9>/run/lock/comote-maintenance.lock
flock -x 9

backup_dir=/var/backups/comote
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
archive="$backup_dir/comote-$timestamp.tar.zst"
temporary="$backup_dir/.comote-$timestamp.tar.zst.tmp"
restart_service=0
stopped_app_services=""
stopped_redis_services=""

restore_service() {
  if [ "$restart_service" -eq 1 ]; then
    systemctl start comote.service
  fi
  if [ -n "$stopped_redis_services" ]; then
    systemctl start $stopped_redis_services || true
  fi
  if [ -n "$stopped_app_services" ]; then
    systemctl start $stopped_app_services || true
  fi
}

trap restore_service EXIT INT TERM
mkdir -p "$backup_dir"

if systemctl is-active --quiet comote.service; then
  restart_service=1
  systemctl stop comote.service
fi

stopped_app_services=$(systemctl list-units --type=service --state=active --no-legend 'comote-app@*.service' | awk '{print $1}')
stopped_redis_services=$(systemctl list-units --type=service --state=active --no-legend 'comote-redis@*.service' | awk '{print $1}')
if [ -n "$stopped_app_services" ]; then systemctl stop $stopped_app_services; fi
if [ -n "$stopped_redis_services" ]; then systemctl stop $stopped_redis_services; fi

database_backup_dir="$backup_dir/databases/$timestamp"
mkdir -p "$database_backup_dir"
if [ -f /var/lib/comote-deploy/apps.json ]; then
  node -e '
    const state = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const [slug, app] of Object.entries(state.apps || {})) {
      if (app.resources?.postgres?.database) console.log(`postgres\t${slug}\t${app.resources.postgres.database}`);
      if (app.resources?.mysql?.database) console.log(`mysql\t${slug}\t${app.resources.mysql.database}`);
    }
  ' /var/lib/comote-deploy/apps.json | while IFS="$(printf '\t')" read -r engine slug database; do
    case "$engine" in
      postgres) runuser -u postgres -- pg_dump --format=custom "$database" > "$database_backup_dir/$slug-postgres.dump" ;;
      mysql) mysqldump --protocol=socket --user=root --single-transaction --routines --events "$database" > "$database_backup_dir/$slug-mysql.sql" ;;
    esac
  done
fi

tar --zstd -cpf "$temporary" \
  --exclude='*/node_modules' \
  --exclude='*/.next/cache' \
  --exclude='home/coder/.codex/cache' \
  --exclude='home/coder/.codex/packages' \
  --exclude='home/coder/.codex/plugins' \
  --exclude='home/coder/.codex/skills' \
  --exclude='home/coder/.codex/tmp' \
  --exclude='home/coder/.codex/log' \
  -C / \
  home/coder/.local/share/comote \
  home/coder/.codex \
  home/coder/.ssh \
  home/coder/projects \
  etc/comote \
  etc/nginx/sites-available \
  etc/nginx/sites-enabled \
  etc/letsencrypt \
  etc/systemd/system/comote.service \
  etc/systemd/system/comote-app@.service \
  etc/systemd/system/comote-redis@.service \
  etc/systemd/system/comote-deploy.socket \
  etc/systemd/system/comote-deploy@.service \
  usr/local/libexec/comote-app-runner.mjs \
  srv/comote-apps \
  var/lib/comote-deploy \
  var/backups/comote/databases/$timestamp

tar --zstd -tf "$temporary" >/dev/null
mv "$temporary" "$archive"
find "$backup_dir" -maxdepth 1 -type f -name 'comote-*.tar.zst' -mtime +13 -delete
find "$backup_dir/databases" -mindepth 1 -maxdepth 1 -type d -mtime +13 -exec rm -rf -- {} +

restore_service
restart_service=0
trap - EXIT INT TERM
printf '%s\n' "$archive"
