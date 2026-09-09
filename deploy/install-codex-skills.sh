#!/usr/bin/env bash
set -euo pipefail

source_dir=/opt/comote/current/deploy/skills/ui-ux-pro-max
skills_dir=/home/coder/.codex/skills
target_dir="$skills_dir/ui-ux-pro-max"

if [[ ! -f "$source_dir/SKILL.md" ]]; then
  echo "Comote UI/UX skill bundle is missing." >&2
  exit 1
fi

/usr/bin/install -d -m 0700 "$skills_dir" "$target_dir"
/bin/cp -a "$source_dir/." "$target_dir/"
/usr/bin/chmod -R u=rwX,go= "$target_dir"
