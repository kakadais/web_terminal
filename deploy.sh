#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# 프로젝트마다 지정한다. PORT와 ROOT_URL의 예시값도 반드시 바꾼다.
SSH_TARGET="server"
PROJECT_NAME="web_terminal"
REMOTE_DEPLOY_BASE="~/deploy"
RELEASE_DIR_NAME="release"
KEEP_RELEASES=2
BUILD_ARCH="os.linux.x86_64"
LOCAL_BUILD_ROOT="$PROJECT_DIR/.meteor/build"
PM2_PROCESS_NAME="$PROJECT_NAME"
PM2_MAX_MEMORY_RESTART="512M"
PM2_NODE_ARGS="--max-old-space-size=384"
PORT="5160"
BIND_IP="192.168.1.4"
ROOT_URL="https://terminal.digix.kr"
HTTP_FORWARDED_COUNT="1"
RUNTIME_ENV_FILE="$PROJECT_DIR/.env.local"
HEALTHCHECK_URL="http://$BIND_IP:$PORT/health"
HEALTHCHECK_EXPECTED_CODE="200"

log() { printf '[deploy] %s\n' "$*"; }
fail() { printf '[deploy][error] %s\n' "$*" >&2; exit 1; }
encode_b64() {
  if [[ -z "$1" ]]; then printf '%s' '-';
  else printf '%s' "$1" | base64 | tr -d '\n'; fi
}

if [[ "${1:-}" == "--help" && "$#" == 1 ]]; then
  printf 'Usage: %s\nEdit project config and .env.local before deploying.\n' "$0"
  exit 0
fi
[[ "$#" == 0 ]] || fail "Unsupported option; use --help"
for command_name in meteor ssh scp tar base64 mktemp; do
  command -v "$command_name" >/dev/null || fail "Missing command: $command_name"
done
[[ "$PROJECT_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || fail "Invalid project name"
[[ "$PM2_PROCESS_NAME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_-]*$ ]] || fail "Invalid PM2 name"
[[ "$RELEASE_DIR_NAME" == release || "$RELEASE_DIR_NAME" == releases ]] || fail "Invalid release directory"
[[ "$KEEP_RELEASES" =~ ^[0-9]+$ ]] && (( KEEP_RELEASES >= 2 )) || fail "KEEP_RELEASES must be >= 2"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || fail "Invalid port"
[[ "$ROOT_URL" == https://* ]] || fail "Set the public HTTPS URL"
[[ -n "$HEALTHCHECK_URL" ]] || fail "Set a health check URL"
[[ -f "$RUNTIME_ENV_FILE" ]] || fail "Missing runtime env file"
# Parse dotenv as data; do not execute .env.local as shell code.
meteor node scripts/runtime-env.cjs "$RUNTIME_ENV_FILE"

node_version="$(meteor node --version | tail -n 1 | tr -d '\r')"
node_version="${node_version#v}"
npm_version="$(meteor npm --version | tr -d '\r' | sed -nE 's/^([0-9]+\.[0-9]+\.[0-9]+)$/\1/p' | tail -n 1)"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid Meteor Node version"
[[ "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Invalid Meteor npm version"

timestamp="$(date '+%Y-%m-%d_%H-%M-%S')"
mkdir -p "$LOCAL_BUILD_ROOT"
build_dir="$(mktemp -d "$LOCAL_BUILD_ROOT/.deploy-XXXXXXXX")"
chmod 700 "$build_dir"
deployment_succeeded=false
cleanup_local() {
  rm -f -- "$build_dir/.runtime.env"
  if [[ "$deployment_succeeded" == true ]]; then
    rm -rf -- "$build_dir"
  else
    log "Build artifact retained for investigation: $build_dir"
  fi
}
trap cleanup_local EXIT

log "Building $PROJECT_NAME for $BUILD_ARCH; Node $node_version / npm $npm_version"
# 프로젝트의 의존성 설치·테스트·추가 빌드 단계가 있다면 이 앞에서 실행한다.
meteor npm ci --no-audit --no-fund
meteor node --test tests/*.test.cjs
meteor node scripts/runtime-env.cjs "$RUNTIME_ENV_FILE" "$build_dir/.runtime.env"
meteor build --architecture "$BUILD_ARCH" --server-only "$build_dir/output"
shopt -s nullglob
artifacts=("$build_dir/output/"*.tar.gz)
[[ "${#artifacts[@]}" == 1 ]] || fail "Expected exactly one build archive"
artifact_tar="${artifacts[0]}"

# This snapshot contains safely quoted, allowlisted dotenv values.
printf '\nexport PORT=%q ROOT_URL=%q NODE_ENV=production HTTP_FORWARDED_COUNT=%q BIND_IP=%q\n' \
  "$PORT" "$ROOT_URL" "$HTTP_FORWARDED_COUNT" "$BIND_IP" >> "$build_dir/.runtime.env"
chmod 600 "$build_dir/.runtime.env"

ssh "$SSH_TARGET" bash -s -- \
  "$(encode_b64 "$REMOTE_DEPLOY_BASE")" "$(encode_b64 "$PROJECT_NAME")" <<'REMOTE_PATH' > "$build_dir/remote-root"
set -euo pipefail
base="$(printf '%s' "$1" | base64 -d)"
project="$(printf '%s' "$2" | base64 -d)"
case "$base" in
  '~') base="$HOME" ;;
  '~/'*) base="$HOME/${base#\~/}" ;;
esac
[[ "$base" == /* && "$base" != / && "$base" != *[^a-zA-Z0-9_./-]* ]] || exit 1
printf '%s/%s' "${base%/}" "$project"
REMOTE_PATH
remote_root="$(cat "$build_dir/remote-root")"
[[ "$remote_root" == /* && "$remote_root" != *[^a-zA-Z0-9_./-]* ]] || fail "Invalid remote path"
remote_release="$remote_root/$RELEASE_DIR_NAME/$timestamp"
ssh "$SSH_TARGET" "mkdir -p '$remote_root/$RELEASE_DIR_NAME' && mkdir '$remote_release' && chmod 700 '$remote_release'"
scp "$artifact_tar" "$SSH_TARGET:$remote_release/artifact.tar.gz"
scp "$build_dir/.runtime.env" "$SSH_TARGET:$remote_release/.runtime.env"
ssh "$SSH_TARGET" "mkdir -p '$remote_root/shared' && chmod 700 '$remote_root/shared'"
scp "$RUNTIME_ENV_FILE" "$SSH_TARGET:$remote_release/.env.local.pending"

remote_args=()
for value in "$remote_root" "$RELEASE_DIR_NAME" "$timestamp" "$node_version" "$npm_version" \
  "$PM2_PROCESS_NAME" "$PM2_MAX_MEMORY_RESTART" "$PM2_NODE_ARGS" "$PORT" "$ROOT_URL" \
  "$KEEP_RELEASES" "$HEALTHCHECK_URL" "$HEALTHCHECK_EXPECTED_CODE"; do
  remote_args+=("$(encode_b64 "$value")")
done

ssh "$SSH_TARGET" bash -s -- "${remote_args[@]}" <<'REMOTE_APPLY'
set -euo pipefail
umask 077
decode_b64() {
  if [[ "$1" == - ]]; then printf '%s' '';
  else printf '%s' "$1" | base64 -d; fi
}
fail() { printf '[remote-deploy][error] %s\n' "$*" >&2; exit 1; }
deploy_root="$(decode_b64 "$1")"
releases_dir="$deploy_root/$(decode_b64 "$2")"
timestamp="$(decode_b64 "$3")"
node_version="$(decode_b64 "$4")"
npm_version="$(decode_b64 "$5")"
pm2_name="$(decode_b64 "$6")"
max_memory="$(decode_b64 "$7")"
node_args="$(decode_b64 "$8")"
expected_port="$(decode_b64 "$9")"
expected_root_url="$(decode_b64 "${10}")"
keep_releases="$(decode_b64 "${11}")"
health_url="$(decode_b64 "${12}")"
health_code="$(decode_b64 "${13}")"
release_dir="$releases_dir/$timestamp"
current="$deploy_root/current"
for command_name in tar curl readlink ss flock; do
  command -v "$command_name" >/dev/null || fail "Missing remote command: $command_name"
done
# 같은 프로젝트의 전환·검증·정리를 직렬로 실행한다.
exec 9>"$deploy_root/.deploy.lock"
flock -n 9 || fail "Another deployment is applying this project"
[[ ! -e "$current" || -L "$current" ]] || fail "current must be a symlink"
previous_release=""
if [[ -L "$current" ]]; then
  previous_release="$(readlink -f "$current")"
  [[ "$previous_release" == "$releases_dir/"* && -d "$previous_release" ]] || fail "Invalid previous release"
fi
activated=false
report_failure() {
  local result="$?"
  if (( result != 0 )); then
    printf '[remote-deploy] Failed; activated=%s; previous=%s\n' "$activated" "$previous_release" >&2
    printf '[remote-deploy] Releases retained. Follow the documented manual rollback.\n' >&2
  fi
}
trap report_failure EXIT

# 비대화형 SSH에서 nvm을 직접 로드한다. PM2 경로는 Node 전환 전에 보관한다.
PM2_BIN="$(command -v pm2 || true)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[[ -s "$NVM_DIR/nvm.sh" ]] || fail "nvm is not installed"
set +u
source "$NVM_DIR/nvm.sh"
set -u
nvm install "$node_version"
nvm use "$node_version"
hash -r
[[ "$(node --version)" == "v$node_version" ]] || fail "Node version mismatch"
if [[ "$(npm --version)" != "$npm_version" ]]; then npm install -g "npm@$npm_version"; fi
[[ "$(npm --version)" == "$npm_version" ]] || fail "npm version mismatch"
NODE_BIN="$(command -v node)"
if [[ ! -x "$PM2_BIN" ]]; then
  PM2_BIN="$(command -v pm2 || true)"
fi
if [[ ! -x "$PM2_BIN" ]]; then
  PM2_BIN="$(find "$NVM_DIR/versions/node" -maxdepth 4 -name pm2 \( -type f -o -type l \) | sort -rV | sed -n '1p')"
fi
[[ -x "$PM2_BIN" ]] || fail "Install a compatible PM2 for this deployment user"

tar -xzf "$release_dir/artifact.tar.gz" -C "$release_dir" --strip-components=1
[[ -f "$release_dir/main.js" && -f "$release_dir/programs/server/package.json" ]] || fail "Invalid Meteor bundle"
chmod 600 "$release_dir/.runtime.env"
(cd "$release_dir/programs/server" && npm install --omit=dev --no-audit --no-fund)
# Rebuild native terminal bindings on the Linux target if Meteor copied them.
while IFS= read -r pty_package; do
  pty_dir="${pty_package%/package.json}"
  (cd "$pty_dir" && npm rebuild --no-audit --no-fund)
done < <(find "$release_dir/programs/server/npm" -type f -path "*/node-pty/package.json")
# Preserve the authoritative dotenv file outside release rotation.
ln -sfn "$deploy_root/shared/.env.local" "$release_dir/.env.local"
printf '%s\n' "$node_version" > "$release_dir/.runtime-node-version"
printf '%s\n' "$npm_version" > "$release_dir/.runtime-npm-version"
printf '%s\n' "$previous_release" > "$release_dir/.previous-release"

set -a
source "$release_dir/.runtime.env"
set +a
[[ "$PORT" == "$expected_port" && "$ROOT_URL" == "$expected_root_url" && -n "${MONGO_URL:-}" ]] || fail "Runtime env mismatch"
export MONGO_OPLOG_URL="${MONGO_OPLOG_URL:-}"
export ENV_FILE="$deploy_root/shared/.env.local"
unset METEOR_SETTINGS

pm2_state() {
  "$PM2_BIN" jlist | "$NODE_BIN" -e '
const fs = require("fs");
const [mode, name, script, cwd, interpreter, args, memory, port, rootUrl] = process.argv.slice(1);
const matches = JSON.parse(fs.readFileSync(0, "utf8")).filter(app => app.name === name);
const real = value => { try { return fs.realpathSync(value); } catch { return ""; } };
for (const app of matches) {
  const path = String(app.pm2_env?.pm_exec_path || "");
  if (!path.startsWith(cwd.replace(/\/current$/, "") + "/")) process.exit(3);
}
if (mode === "apply" && matches.length === 0) { console.log("start"); process.exit(0); }
if (matches.length !== 1) {
  if (mode === "apply") { console.log("recreate"); process.exit(0); }
  process.exit(1);
}
const app = matches[0], env = app.pm2_env || {};
const normalizeArgs = value => Array.isArray(value) ? value.join(" ") : String(value || "");
const size = /^([0-9]+)([KMG]?)$/i.exec(memory);
if (!size) process.exit(1);
const bytes = Number(size[1]) * 1024 ** ({ "": 0, K: 1, M: 2, G: 3 }[size[2].toUpperCase()]);
const samePath = (actual, expected) => actual === expected || actual === real(expected);
const configMatches = samePath(env.pm_exec_path, script) && samePath(env.pm_cwd, cwd)
  && env.exec_interpreter === interpreter && normalizeArgs(env.node_args) === args
  && Number(env.max_memory_restart) === bytes;
if (mode === "apply") { console.log(configMatches ? "reload" : "recreate"); process.exit(0); }
if (!configMatches || env.status !== "online" || !(app.pid > 0)
  || String(env.PORT) !== port || String(env.ROOT_URL) !== rootUrl) process.exit(1);
console.log(app.pid);
' "$1" "$pm2_name" "$current/main.js" "$current" "$NODE_BIN" "$node_args" "$max_memory" "$PORT" "$ROOT_URL"
}
pm2_start() {
  "$PM2_BIN" start "$current/main.js" --name "$pm2_name" --cwd "$current" \
    --interpreter "$NODE_BIN" --node-args "$node_args" --max-memory-restart "$max_memory" --update-env
}
# PM2 이름이 다른 프로젝트에 속하면 링크 전환 전에 중지한다.
pm2_state apply >/dev/null || fail "PM2 name conflicts with another project"
ln -s "$release_dir" "$deploy_root/.current-$timestamp"
mv -Tf "$deploy_root/.current-$timestamp" "$current"
install -m 600 "$release_dir/.env.local.pending" "$deploy_root/shared/.env.local"
rm -f "$release_dir/.env.local.pending"
activated=true
apply_mode="$(pm2_state apply)"
case "$apply_mode" in
  start) pm2_start ;;
  recreate) "$PM2_BIN" delete "$pm2_name"; pm2_start ;;
  reload)
    if ! "$PM2_BIN" reload "$pm2_name" --update-env; then
      "$PM2_BIN" delete "$pm2_name"
      pm2_start
    fi
    ;;
  *) fail "Invalid PM2 apply mode" ;;
esac

healthy=false
for (( attempt=1; attempt<=30; attempt++ )); do
  process_pid="$(pm2_state verify 2>/dev/null || true)"
  response_code="$(curl -sS --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$health_url" 2>/dev/null || true)"
  if [[ -n "$process_pid" && "$response_code" == "$health_code" && "$(readlink -f "$current")" == "$release_dir" \
    && "$(readlink -f "/proc/$process_pid/cwd" 2>/dev/null || true)" == "$release_dir/programs/server" ]] \
    && ss -ltnp "sport = :$PORT" | grep -Fq "pid=$process_pid,"; then
    healthy=true
    break
  fi
  sleep 2
done
[[ "$healthy" == true ]] || fail "PM2/release/port/health verification failed"
"$PM2_BIN" save
touch "$release_dir/.deploy-success"
rm -f -- "$release_dir/artifact.tar.gz"

# 검증한 current와 전환 직전의 복구본을 먼저 보호한다.
active_release="$(readlink -f "$current")"
[[ "$active_release" == "$release_dir" ]] || fail "current changed unexpectedly"
rollback_release=""
if [[ "$previous_release" == "$releases_dir/"* && -d "$previous_release" && "$previous_release" != "$active_release" ]]; then
  rollback_release="$previous_release"
fi
kept=1
[[ -z "$rollback_release" ]] || kept=2
while IFS= read -r release_name; do
  [[ "$release_name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$ ]] || continue
  candidate="$releases_dir/$release_name"
  [[ "$candidate" != "$active_release" && "$candidate" != "$rollback_release" ]] || continue
  [[ -f "$candidate/.deploy-success" ]] || continue
  if (( kept < keep_releases )); then kept=$((kept + 1)); continue; fi
  rm -rf -- "$candidate"
done < <(find "$releases_dir" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r)
printf '[remote-deploy] Verified: %s; previous: %s\n' "$active_release" "$previous_release"
REMOTE_APPLY

deployment_succeeded=true
log "Deploy completed; verify https://terminal.digix.kr and the SSH critical flow"
