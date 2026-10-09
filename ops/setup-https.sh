#!/usr/bin/env bash
set -euo pipefail
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSH_TARGET="nginx"
REMOTE_WORK="/home/ubuntu/.web-terminal-nginx"
mkdir -p "$PROJECT_DIR/.deploy"
ssh "$SSH_TARGET" "mkdir -p '$REMOTE_WORK'; chmod 700 '$REMOTE_WORK'"
scp "$PROJECT_DIR/ops/nginx-http.conf" "$PROJECT_DIR/ops/nginx-https.conf" "$SSH_TARGET:$REMOTE_WORK/"
ssh "$SSH_TARGET" bash -s <<'REMOTE_HTTPS'
set -euo pipefail
work="$HOME/.web-terminal-nginx"
site=/etc/nginx/conf.d/terminal.digix.kr.conf
timestamp="$(date '+%Y-%m-%d_%H-%M-%S')"
backup="$work/site-$timestamp.backup"
had_site=false
if sudo test -f "$site"; then sudo cp "$site" "$backup"; had_site=true; fi
apply_site() {
  sudo install -m 644 "$1" "$site"
  if ! sudo nginx -t; then
    if [[ "$had_site" == true ]]; then sudo cp "$backup" "$site";
    else sudo rm -f "$site"; fi
    exit 1
  fi
  sudo systemctl reload nginx
}
sudo install -d -m 755 /var/www/web-terminal-acme/.well-known/acme-challenge
if ! sudo test -f /etc/letsencrypt/live/terminal.digix.kr/fullchain.pem; then
  apply_site "$work/nginx-http.conf"
  sudo certbot certonly --webroot -w /var/www/web-terminal-acme \
    -d terminal.digix.kr --cert-name terminal.digix.kr --non-interactive --agree-tos
fi
apply_site "$work/nginx-https.conf"
sudo systemctl is-active certbot.timer
sudo openssl x509 -in /etc/letsencrypt/live/terminal.digix.kr/fullchain.pem -noout -dates -subject
printf 'HTTPS proxy configured for terminal.digix.kr → 192.168.1.4:5160\n'
REMOTE_HTTPS
