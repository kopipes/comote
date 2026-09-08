#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

domain_suffix=${1:-}
bind_address=${2:-}
case "$domain_suffix" in
  ""|*[!a-z0-9.-]*) echo "Invalid deployment domain suffix." >&2; exit 1 ;;
esac
case "$bind_address" in
  ""|*[!0-9.]*) echo "Invalid deployment bind address." >&2; exit 1 ;;
esac

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

install -d -m 711 /etc/comote/apps
install -d -m 700 /etc/comote/secrets /etc/comote/resources /var/lib/comote-deploy
install -d -m 755 /srv/comote-apps /var/lib/letsencrypt
install -m 644 "$script_dir/comote-deploy.socket" /etc/systemd/system/comote-deploy.socket
install -m 644 "$script_dir/comote-deploy@.service" /etc/systemd/system/comote-deploy@.service
install -m 644 "$script_dir/comote-app@.service" /etc/systemd/system/comote-app@.service
install -m 644 "$script_dir/comote-redis@.service" /etc/systemd/system/comote-redis@.service
install -d -m 755 /usr/local/libexec
install -m 755 "$script_dir/comote-app-runner.mjs" /usr/local/libexec/comote-app-runner.mjs
install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
install -m 755 "$script_dir/reload-nginx-after-cert-renewal" /etc/letsencrypt/renewal-hooks/deploy/reload-nginx

environment_file=$(mktemp)
trap 'rm -f "$environment_file"' EXIT HUP INT TERM
printf '%s\n' \
  "COMOTE_DEPLOY_DOMAIN=$domain_suffix" \
  "COMOTE_DEPLOY_BIND_ADDRESS=$bind_address" \
  "COMOTE_PROJECTS_ROOT=/home/coder/projects" > "$environment_file"
install -m 600 "$environment_file" /etc/comote/deploy.env

if ! grep -q '^COMOTE_DEPLOY_DOMAIN=' /etc/comote/comote.env; then
  printf '%s\n' "COMOTE_DEPLOY_DOMAIN=$domain_suffix" >> /etc/comote/comote.env
fi
if ! grep -q '^COMOTE_DEPLOY_SOCKET=' /etc/comote/comote.env; then
  printf '%s\n' 'COMOTE_DEPLOY_SOCKET=/run/comote-deploy.sock' >> /etc/comote/comote.env
fi

systemctl daemon-reload
systemctl enable --now comote-deploy.socket
ufw allow 80/tcp comment 'Public production HTTP and ACME'
ufw allow 443/tcp comment 'Public production HTTPS'

echo "Comote deployment manager configured for *.$domain_suffix on $bind_address."
