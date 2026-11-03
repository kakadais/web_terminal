#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd "${1:?Project directory is required}" && pwd)"
[[ -f "$source_dir/.env.local" ]] || { printf '[deploy][error] Missing .env.local\n' >&2; exit 1; }
command -v rsync >/dev/null || { printf '[deploy][error] Missing rsync\n' >&2; exit 1; }
workspace="$(mktemp -d "${TMPDIR:-/tmp}/web-terminal-deploy.XXXXXXXX")"
chmod 700 "$workspace"
succeeded=false
cleanup() {
  # Keep failed build artifacts for inspection, without another secret copy.
  rm -f -- "$workspace/.env.local"
  if [[ "$succeeded" == true ]]; then rm -rf -- "$workspace";
  else printf '[deploy] Failed build retained: %s\n' "$workspace" >&2; fi
}
trap cleanup EXIT
case "$workspace/" in "$source_dir/"*) printf '[deploy][error] TMPDIR must be outside the project\n' >&2; exit 1;; esac

rsync -a --exclude=.git --exclude=.deploy --exclude=node_modules \
  --exclude=.meteor/local --exclude=.meteor/build --exclude=.vscode \
  --exclude='.env*' --exclude='*.log' --exclude=native/terminal/target \
  "$source_dir/" "$workspace/"
install -m 600 "$source_dir/.env.local" "$workspace/.env.local"
printf '[deploy] Isolated build workspace: %s\n' "$workspace"
if (cd "$workspace" && WEB_TERMINAL_DEPLOY_ISOLATED=1 bash deploy.sh); then
  succeeded=true
else
  deploy_exit=$?
  exit "$deploy_exit"
fi
