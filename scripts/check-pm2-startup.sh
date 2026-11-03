#!/usr/bin/env bash
set -euo pipefail

unit="${1:-}"
[[ -n "$unit" ]] || exit 0
fail() { printf '[deploy][error] %s\n' "$*" >&2; exit 1; }
[[ "$unit" =~ ^[a-zA-Z0-9_.@-]+\.service$ ]] || fail 'Invalid PM2 startup unit'
command -v systemctl >/dev/null || fail "systemctl is required to check $unit"
[[ "$(systemctl show "$unit" --property=LoadState --value)" == loaded ]] || fail "Missing PM2 startup unit: $unit"
command_line="$(systemctl show "$unit" --property=ExecStart --value)"
executable="${command_line#*path=}"
executable="${executable%% ;*}"
[[ -n "$executable" && -x "$executable" ]] || fail "PM2 startup executable is unavailable: $unit"
systemctl is-enabled --quiet "$unit" || fail "PM2 startup unit is not enabled: $unit"
systemctl is-active --quiet "$unit" || fail "PM2 startup unit is not active: $unit"
printf '[deploy] PM2 startup verified: %s\n' "$unit"
