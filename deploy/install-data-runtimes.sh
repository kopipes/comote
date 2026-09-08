#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql postgresql-client mysql-server redis-server sqlite3

# Redis is launched as one isolated instance per Comote application.
systemctl disable --now redis-server.service || true
systemctl enable --now postgresql.service mysql.service

echo "SQLite, PostgreSQL, MySQL, and private per-app Redis runtimes are ready."
