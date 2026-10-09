# Web Terminal

Meteor 3.5.2 + React 기반의 로그인형 SSH 서버 관리 화면입니다. 운영 주소는 https://terminal.digix.kr 이고, nginx가 `server`의 `192.168.1.4:5160`으로 HTTP 및 WebSocket을 전달합니다.

로그인하면 왼쪽에 서버 목록이 표시됩니다. 서버를 클릭하면 오른쪽에 SSH 터미널이 열리며, 여러 서버를 탭으로 사용할 수 있습니다. `Sync`는 **앱이 실행되는 서버**의 SSH config를 읽습니다. `+`로 직접 서버를 추가하고 비밀번호 또는 SSH 개인 키를 등록할 수 있습니다. 설정 메뉴에서 수정·삭제하며, 개인 키는 붙여 넣거나 파일로 선택합니다.

## 환경변수

```bash
cp .env.example .env.local
chmod 600 .env.local
```

`.env.local`에 실제 설정을 기록합니다. `.env.example`은 비밀값 없는 참고 파일이며 Git에 포함됩니다. Meteor settings는 사용하지 않습니다. `.env.local`은 dotenv 형식으로 파싱하며 셸 코드로 실행하지 않습니다. 기존 프로세스 환경변수가 파일보다 우선합니다.

| 변수 | 용도 |
| --- | --- |
| `PORT`, `BIND_IP` | 운영 포트와 수신 IP. 현재 `5160`, `192.168.1.4`. |
| `ROOT_URL` | 공개 주소. 현재 `https://terminal.digix.kr`. |
| `HTTP_FORWARDED_COUNT` | 프록시 홉 수. 현재 nginx 1개. |
| `MONGO_URL` | `127.0.0.1:27777/web_terminal`의 인증 URI. URI의 비밀번호는 URL 인코딩. |
| `MONGO_OPLOG_URL` | 선택. 현재 비워 두고 MongoDB Change Streams 사용. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | 최초 관리자 생성 시 사용. 기존 계정의 비밀번호를 재설정하지 않음. |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-256-GCM 키. `openssl rand -hex 32`로 생성하고 배포 간 유지. |
| `SSH_CONFIG_PATH` | 운영 서버의 SSH config. 기본 `~/.ssh/config`. |
| `SSH_KNOWN_HOSTS_PATH` | 호스트 키 저장 위치. 기본 `~/deploy/web_terminal/shared/known_hosts`. |
| `SSH_COMMAND` | OpenSSH 실행 파일. 기본 `/usr/bin/ssh`. |
| `TERMINAL_MAX_SESSIONS` | 사용자별 동시 터미널 수. 기본 12. |
| `TERMINAL_TICKET_SECONDS` | 1회용 터미널 접속권 유효 시간. 기본 30초. |
| `TERMINAL_IDLE_MINUTES` | 입력 없이 유지할 시간. 기본 60분. |
| `DEV_PORT` | 로컬 개발 포트. 기본 5160. |

MongoDB에는 `users`, `servers`, `connection_history`가 저장됩니다. 앱 전용 DB 계정은 `web_terminal`의 `readWrite` 권한과 Meteor Change Streams에 필요한 `getDefaultRWConcern` 조회 권한만 사용합니다. 별도 관리자 URI를 알고 있는 운영 환경에서는 `ops/provision-database.py`를 참고해 계정을 준비합니다. 이 스크립트는 현재 서버의 PM2에 저장된 MongoDB 관리자 URI를 읽고, 이름이 고정된 앱 전용 계정만 생성합니다. 비밀번호를 로그로 출력하거나 기존 계정 비밀번호를 바꾸지 않습니다.

접속 정보의 암호화 키와 DB는 함께 백업해야 합니다. 키를 바꾸면 기존 접속 정보를 복호화할 수 없으므로 서버별 비밀번호·개인 키를 다시 등록해야 합니다. 로그인 암호는 Meteor Accounts가 해시로 저장하며, 화면의 `비밀번호 변경`으로 변경합니다.

## 개발 및 검사

Meteor 3.5.2와 OpenSSH가 필요합니다. 런타임 Node 버전은 일반 `node` 대신 `meteor node --version`으로 확인합니다.

```bash
meteor npm ci
meteor npm test
meteor npm run dev
```

`dev`는 `127.0.0.1`과 Meteor의 별도 로컬 MongoDB를 사용합니다. 운영 DB에 개발 데이터를 쓰지 않습니다. `start`는 `.env.local`의 MongoDB와 운영 설정을 사용합니다. Meteor 시작 전에 환경변수를 읽어 MongoDB 연결 설정에도 적용합니다.

개발 서버를 계속 실행하려면 다음처럼 tmux에서 실행합니다.

```bash
tmux new-session -s web-terminal-dev 'meteor npm run dev'
# 다시 접속
tmux attach -t web-terminal-dev
# 개발 종료
tmux kill-session -t web-terminal-dev
```

`meteor npm test`는 인증 정보 암호화, SSH config Include와 기본값 해석, 입력 검증, dotenv의 안전한 전달을 검사합니다. 배포 후 `meteor npm run verify`는 Chrome으로 로그인·최초 목록·Sync·실제 SSH 명령·모바일 화면을 확인합니다. 기본 검증 대상 SSH 별칭은 `nginx`입니다. `VERIFY_CONFIG_ALIAS`로 변경하고 `VERIFY_JUMP_ALIAS`로 점프 서버 경유 검사 대상을 추가하며, Chrome 경로는 `CHROME_PATH`로 지정합니다. 결과 화면은 Git에서 제외한 `test-results/`에 저장합니다. 임시 `.deploy/qa.json` 및 `.deploy/qa_identity`가 있을 때만 별도 SSH 비밀번호·키 접속 검사도 실행합니다.

## 배포

`deploy.sh`는 `~/WebstormProjects/deploy.md`의 릴리스 배포 계약에 맞춘 독립 스크립트입니다. 상위 배포 스크립트를 호출하지 않습니다.

```bash
bash -n deploy.sh
./deploy.sh
```

Linux x86-64용 Meteor 빌드 → SSH 업로드 → 운영 Node/npm 선택 → 의존성 및 node-pty 설치 → `current` 전환 → PM2의 `web_terminal` 프로세스 갱신 → 실제 PID·포트·릴리스·DB health 검사 → PM2 save 순으로 진행합니다. 실패 시 0이 아닌 종료 코드를 반환하고 산출물을 보존합니다. 현재 릴리스와 직전 정상 릴리스를 유지하고, 다른 앱의 프로세스나 데이터를 수정하지 않습니다. Meteor는 시작 후 cwd를 해당 릴리스의 `programs/server`로 바꾸므로 검증도 그 실제 경로를 확인합니다.

```text
server: ~/deploy/web_terminal/
  current -> release/YYYY-MM-DD_HH-MM-SS
  release/…/main.js
  release/…/.runtime.env        # 해당 릴리스의 안전하게 인용한 환경변수 스냅샷
  shared/.env.local             # 운영 dotenv 원본, 권한 0600
  shared/known_hosts            # 배포 간 유지되는 SSH 호스트 키
```

작업을 tmux에서 실행하려면 `tmux new-session -s web-terminal-deploy './deploy.sh'`를 사용하고 완료 후 세션을 정리합니다. 운영 앱은 기존 서버의 PM2 startup 서비스로 유지됩니다.

처음 HTTPS를 설정하는 경우:

```bash
./ops/setup-https.sh
ssh nginx 'sudo certbot renew --cert-name terminal.digix.kr --dry-run'
curl -fsS https://terminal.digix.kr/health
```

도메인의 A 레코드는 nginx 공인 IP를 가리켜야 합니다. 설정 스크립트는 이 도메인의 전용 nginx 파일만 설치하고, `nginx -t` 통과 후 reload합니다. 기존 Certbot 계정으로 webroot 인증서를 발급하고 HTTP → HTTPS 전환과 WebSocket 프록시를 적용합니다. 인증서 자동 갱신은 기존 Certbot timer와 nginx reload hook을 사용합니다.

## 터미널과 SSH config 동작

최초 관리자 생성 후 SSH config 목록을 가져옵니다. `Host *`·패턴은 제외하고 명시된 별칭을 가져오며, `Include`와 `ProxyJump`, `IdentityFile` 등의 실제 값은 OpenSSH의 `ssh -G`로 해석합니다. 기존 config에서 `User` 뒤에 `#` 주석이 붙은 경우 실제 사용자 이름만 가져오고 SSH 실행 시 그 이름을 명시합니다. 주소 등 설정이 잘못된 별칭은 Sync 결과에 이름이 표시됩니다. Sync는 기존 수동 추가 서버와 등록된 인증 정보를 보존하고, 사라진 config 별칭은 연결할 수 없는 상태로 표시합니다. 목록 삭제는 SSH config 파일을 수정하지 않으므로 config 서버는 다음 Sync 시 다시 나타납니다.

config 인증은 운영 서버에 이미 있는 개인 키 또는 SSH agent를 사용합니다. 비밀번호가 필요한 서버는 해당 서버의 설정에서 비밀번호 인증으로 바꾸세요. 수동 추가 서버는 자신의 호스트·포트·SSH 사용자·비밀번호 또는 개인 키를 사용합니다. SSH 키는 SSL 인증서와 다르며, 공개 키 대신 개인 키 파일을 등록해야 합니다. 키에 암호가 있으면 키 암호도 입력합니다.

새 호스트 키는 known_hosts에 저장하며 변경된 호스트 키는 거부합니다. SSH config의 포트 포워딩과 공유 연결은 웹 터미널 세션에서 비활성화합니다. 연결 종료, 탭 닫기, 로그아웃, 브라우저 연결 종료 시 해당 SSH 프로세스와 임시 키 파일을 정리합니다. 원격 셸에서 `exit`로 종료할 수도 있습니다. `Ctrl+C`는 원격 실행 중인 명령을 중단하며, SSH 연결은 유지됩니다. 연결 기록은 메타데이터만 저장하고 터미널 출력·입력은 DB에 저장하지 않습니다. 기록은 30일 후 삭제됩니다.

## 복구

실패한 배포는 `.previous-release`와 `.runtime-node-version`을 보존합니다. 복구 대상이 이 프로젝트의 `release/` 아래인지 확인한 뒤, 다음 절차로 해당 릴리스의 코드와 환경변수를 함께 복원합니다. SSH config 및 DB는 릴리스 디렉터리에 보관하지 않습니다.

```bash
ssh server
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
root="$HOME/deploy/web_terminal"
restore="$(cat "$root/current/.previous-release")"
test -n "$restore" && test -f "$restore/.deploy-success"
case "$restore" in "$root/release/"*) ;; *) exit 1 ;; esac
nvm use "$(cat "$restore/.runtime-node-version")"
set -a
. "$restore/.runtime.env"
set +a
export ENV_FILE="$root/shared/.env.local"
unset METEOR_SETTINGS
ln -s "$restore" "$root/.restore-link"
mv -Tf "$root/.restore-link" "$root/current"
pm2 delete web_terminal
pm2 start "$root/current/main.js" --name web_terminal --cwd "$root/current" \
  --interpreter "$(command -v node)" --node-args="--max-old-space-size=384" --max-memory-restart 512M
curl -fsS http://192.168.1.4:5160/health
# PID, /proc/PID/cwd, ss -ltnp, 공개 HTTPS와 로그인을 확인한 뒤에 저장
pm2 save
```
