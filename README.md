# Web Terminal

Meteor 3.5.2 + React 기반의 로그인형 SSH 서버 관리 화면입니다. 운영 주소는 https://terminal.digix.kr 이고, nginx가 `server`의 `192.168.1.4:5160`으로 HTTP 및 WebSocket을 전달합니다.

로그인하면 왼쪽에 서버 목록이 표시됩니다. 최상단의 `server`는 배포 서버의 로컬 셸을 바로 열고, 다른 서버는 SSH 터미널로 연결합니다. 여러 서버를 탭으로 사용할 수 있습니다. `Sync`는 **앱이 실행되는 서버**의 SSH config를 읽습니다. `+`와 `⋯` 설정에서 실제 config 블록을 등록·편집·삭제하며, 비밀번호 또는 SSH 개인 키·키 암호도 저장할 수 있습니다.

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
| `SSH_CONFIG_BACKUP_DIR` | config 변경 전 원본 백업 경로. 기본 `~/deploy/web_terminal/shared/ssh-config-backups`. |
| `DEPLOY_SERVER_NAME` | 목록 최상단에 고정할 배포 서버 이름. 기본 `server`. |
| `TERMINAL_MAX_SESSIONS` | 사용자별 동시 터미널 수. 기본 12. |
| `TERMINAL_TICKET_SECONDS` | 1회용 터미널 접속권 유효 시간. 기본 30초. |
| `TERMINAL_IDLE_MINUTES` | 입력 없이 유지할 시간. 기본 60분. |
| `UPLOAD_MAX_MB` | 파일 하나의 최대 크기. 기본 1024MB. nginx의 `/terminal/upload` 크기 제한도 함께 조정. |
| `UPLOAD_TIMEOUT_SECONDS` | 업로드 접속권과 전송 제한 시간. 기본 600초. nginx 시간 제한도 함께 조정. |
| `UPLOAD_MAX_CONCURRENT` | 사용자별 동시 전송 수. 기본 2. 각 터미널의 파일은 순차 전송. |
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

`meteor npm test`는 인증 정보 암호화, SSH config Include와 기본값 해석, config 블록 편집·공유 별칭 삭제·심볼릭 링크 보존·문법 오류 및 동시 수정 거부, 바이너리 업로드·기존 파일 보호·중단 처리·한글 작업 경로·PID 추적, 입력 검증, dotenv의 안전한 전달을 검사합니다. 배포 후 `meteor npm run verify`는 Chrome으로 로그인·목록·Sync·고정 배포 서버의 로컬 셸·실제 SSH 명령·config 등록/수정/삭제·모바일 화면을 확인합니다. 기본 검증 대상 SSH 별칭은 `nginx`입니다. `VERIFY_CONFIG_ALIAS`로 변경하고 `VERIFY_JUMP_ALIAS`로 기존 경유 접속과 새 ProxyJump 블록 검사 대상을 추가하며, Chrome 경로는 `CHROME_PATH`로 지정합니다. 결과 화면은 Git에서 제외한 `test-results/`에 저장합니다. 검증은 임시 `__verify_*` config 블록을 추가하고 완료 후 삭제합니다. `127.0.0.1:22561`의 LocalForward로 nginx의 HTTP 포트 80과 포워딩 중 별도 SSH 업로드도 검사하므로 이 검증 포트는 사용 중이지 않아야 합니다. 임시 `.deploy/qa.json` 및 `.deploy/qa_identity`가 있을 때만 별도 SSH 비밀번호·키 접속 검사도 실행합니다.

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
  shared/ssh-config-backups/    # config 수정 전 원본과 파일 경로 manifest, 권한 0700/0600
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

목록 최상단의 `server`는 앱이 배포된 머신에서 실행 계정의 로그인 셸을 바로 엽니다. SSH config와 별개로 자동 생성되며 검색·목록 스크롤에도 고정되고 삭제할 수 없습니다. 이름은 `DEPLOY_SERVER_NAME`으로 변경합니다. SSH로 등록된 같은 이름의 별칭은 별도의 원격 접속 항목입니다.

최초 관리자 생성 후 SSH config 목록을 가져옵니다. `Host *`·패턴은 제외하고 명시된 별칭을 가져오며, `Include`와 `ProxyJump`, `ProxyCommand`, `IdentityFile` 등의 실제 값은 OpenSSH의 `ssh -G`로 해석합니다. 기존 config에서 `User` 뒤에 `#` 주석이 붙은 경우 실제 사용자 이름만 가져오고 SSH 실행 시 그 이름을 명시합니다. 접속할 때에도 최신 config를 다시 읽습니다. Sync는 config를 다시 읽어 새 별칭을 추가하고 기존 별칭의 접속 설정을 갱신하며, 파일에서 사라진 별칭은 목록에서 삭제합니다. 유지되는 별칭의 인증 정보와 고정 배포 서버는 보존합니다. config에 남아 있지만 해석할 수 없는 별칭은 삭제하지 않고 설정 오류로 표시합니다.

`+` 및 각 서버의 `⋯` 설정은 실제 `Host` 블록을 보여주는 편집기입니다. HostName·User·Port·경유 접속·포트 포워딩을 직접 편집합니다. Include 파일의 블록도 해당 실제 파일에 저장하며, 같은 별칭의 Host 블록이 여러 개면 모두 표시합니다. 공유 Host 블록은 다른 별칭도 영향을 받는다는 안내가 나옵니다. 새 블록은 루트 config의 첫 Host/Match 블록 앞에 추가합니다. 저장 전 별도 임시 config에서 OpenSSH 문법과 유효 주소를 검사하며, 파일이 편집 도중 외부에서 바뀌면 최신 내용을 다시 불러와야 합니다. 원본을 권한 0600으로 백업한 뒤 실제 대상 파일을 원자적으로 교체하고, `.ssh/config`와 Include의 심볼릭 링크는 유지합니다. 다른 블록·Match·주석은 그대로 보존합니다. 삭제는 실제 config에서도 해당 별칭을 제거하며, 공유 블록의 다른 별칭은 유지합니다. 기존 수동 등록 항목도 편집 후 저장하면 config 항목으로 전환됩니다.

config 인증은 운영 서버에 이미 있는 개인 키 또는 SSH agent를 사용합니다. 비밀번호가 필요한 서버는 해당 서버의 설정에서 비밀번호 인증으로 바꾸세요. 키 인증에서는 config의 IdentityFile을 사용하거나 개인 키를 업로드할 수 있습니다. 키에 암호가 있으면 키 암호도 입력합니다. 비밀번호·업로드한 개인 키·키 암호는 config에 기록하지 않고 암호화한 DB 필드에 별도 저장합니다. SSH config 경로와 IdentityFile은 앱 서버 기준이며, 경유 서버의 별도 인증은 경유 서버에 맞는 SSH config/키를 준비해야 합니다.

새 호스트 키는 known_hosts에 저장하며 변경된 호스트 키는 거부합니다. ProxyJump의 모든 경유 단계도 앱의 같은 known_hosts를 사용하도록 임시 Include config를 적용합니다. ProxyJump/ProxyCommand 및 LocalForward/RemoteForward는 SSH config를 따릅니다. 포트 포워딩의 리스닝 포트는 앱 서버에 열리고, 같은 포워딩 포트로 여러 탭을 열면 충돌할 수 있습니다. ControlMaster 공유 연결은 세션별 종료를 위해 비활성화하고, LocalCommand는 실행하지 않습니다. 연결 종료, 탭 닫기, 로그아웃, 브라우저 연결 종료 시 해당 SSH 또는 로컬 셸 프로세스와 임시 키 파일을 정리합니다. 셸에서 `exit`로 종료할 수도 있습니다. `Ctrl+C`는 실행 중인 명령을 중단하며, 터미널 연결은 유지됩니다. 연결 기록은 메타데이터만 저장하고 터미널 출력·입력은 DB에 저장하지 않습니다. 기록은 30일 후 삭제됩니다.

## 파일 드롭 업로드

터미널에서 `cd`로 저장할 폴더로 이동한 뒤 파일을 해당 터미널 위에 드롭합니다. 드롭한 시점의 셸 작업 폴더를 조회하고, 여러 파일은 그 폴더로 순서대로 전송합니다. Linux는 `/proc`를, macOS는 `lsof`를 사용하므로 별도 프로그램이나 셸 설정을 설치하지 않습니다. 셸에서 다른 프로그램을 실행 중이어도 업로드 때문에 명령어를 입력하지 않습니다. 하단의 경로 입력란에 절대 경로 또는 `~/...`를 입력하면 직접 저장 위치를 지정할 수 있습니다. 사용자 지정 RemoteCommand로 시작한 터미널 등에서 자동 경로를 확인할 수 없는 경우에도 이 입력란을 사용합니다.

고정 `server`는 배포 서버에 직접 저장합니다. 다른 서버는 기존 인증 방식과 ProxyJump/ProxyCommand를 사용하는 별도 SSH 연결로 파일을 스트리밍합니다. 업로드 연결에서는 포트 포워딩을 새로 열지 않습니다. 앱 서버에 원격 업로드 파일 전체를 임시 보관하거나 DB에 저장하지 않습니다. nginx는 업로드 요청을 버퍼링하지 않으며, 기본 파일 제한은 1GB입니다. 폴더 드롭은 지원하지 않고 한 번에 파일 100개까지 받습니다.

원래 파일 이름을 유지하며, 같은 이름의 파일·디렉터리가 있으면 오류를 표시하고 기존 항목을 보존합니다. 대상 폴더에 권한 0600의 임시 파일로 전송한 뒤 원자적으로 등록합니다. 중단·실패 시 임시 파일을 정리합니다. 화면에서 진행률, 저장 위치, 오류를 확인하고 전송을 취소할 수 있습니다. 터미널 종료·로그아웃 시 전송과 접속권도 취소합니다. 업로드 API는 로그인한 터미널에 묶인 1회용 접속권, 출처, 파일 크기를 확인합니다.

`VERIFY_JUMP_ALIAS=ibs_kakadais meteor node scripts/verify-uploads.cjs`는 실제 브라우저 파일 드롭, 로컬/Linux SSH/macOS 경유 서버의 현재 폴더, 바이너리 해시, 기존 파일 보호, 취소, 외부 config 수정 후 Sync를 검사합니다. `VERIFY_CONFIG_ALIAS`와 `VERIFY_JUMP_ALIAS`는 환경에 맞게 지정하며 경유 별칭을 생략하면 로컬과 기본 SSH 서버만 검사합니다. 임시 `.deploy/qa.json` 및 `.deploy/qa_identity`가 있으면 비밀번호와 암호가 걸린 개인 키로 업로드도 검사합니다. 검증용 임시 파일과 config는 완료 후 정리합니다.

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
