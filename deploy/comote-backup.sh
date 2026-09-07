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

restore_service() {
  if [ "$restart_service" -eq 1 ]; then
    systemctl start comote.service
  fi
}

trap restore_service EXIT INT TERM
mkdir -p "$backup_dir"

if systemctl is-active --quiet comote.service; then
  restart_service=1
  systemctl stop comote.service
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
  etc/systemd/system/comote-deploy.socket \
  etc/systemd/system/comote-deploy@.service \
  srv/comote-apps \
  var/lib/comote-deploy

tar --zstd -tf "$temporary" >/dev/null
mv "$temporary" "$archive"
find "$backup_dir" -maxdepth 1 -type f -name 'comote-*.tar.zst' -mtime +13 -delete

restore_service
restart_service=0
trap - EXIT INT TERM
printf '%s\n' "$archive"
