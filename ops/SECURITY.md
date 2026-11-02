# 로그인 및 비밀정보 운영

이 서비스의 로그인은 배포 서버의 셸과 등록한 SSH 계정에 대한 접근 권한이다. 공개 회원가입은 막혀 있고, 모든 서버·터미널 API는 로그인과 소유자를 검사한다. 운영 주소는 `https://terminal.digix.kr`이며 nginx를 통해 `server:5160`으로 연결한다.

## 로그인 보호

- 비밀번호는 Meteor의 Argon2id(19 MiB, 2회, 병렬도 1)로 저장한다. 기존 bcrypt 계정은 다음 정상 로그인 때 자동 전환된다.
- 비밀번호 변경은 서버에서 현재 비밀번호, 새 비밀번호의 15~200자 제한과 활성화된 2단계 인증을 검사한다. 새 비밀번호는 현재 값과 달라야 하고 공백만 사용할 수 없다. 변경 후 모든 기기의 토큰을 폐기한다. 길이 검사는 유니코드 코드 포인트를 세며 최대치는 브라우저/프레임워크와 맞춰 UTF-16 200단위로 제한한다.
- 기본 Meteor `changePassword`는 해시만 받아 새 비밀번호 길이와 이 서비스의 2단계 인증을 검사할 수 없으므로 차단하고 `security.changePassword`만 사용한다. Meteor 3.5의 등록된 메서드 테이블에 대한 통합 코드이므로 프레임워크 업데이트 시 실제 DDP 거부와 새 변경 흐름을 함께 검증한다. 새 비밀번호 원문은 HTTPS/WSS로만 전달하고 로그에 남기지 않는다.
- 로그인 요청은 IP별 분당 10회, 전체 분당 60회로 제한한다. 재접속으로 IP 제한을 피할 수 없다. 계정별 실패 20회는 최초 실패로부터 10분 동안 제한하며 추가 요청으로 제한 시간을 연장하지 않는다. 이 계정별 카운터는 단일 PM2 프로세스 메모리에 있으므로 재시작 시 초기화된다. 다중 인스턴스로 확장할 때는 공유 저장소가 필요하다.
- 로그인 토큰은 브라우저 `sessionStorage`에 보관하며 유효기간은 1일이다. 탭 새로고침은 유지하지만 새 탭에서 다시 로그인해야 한다. 세션 복구 기능이 있는 브라우저는 닫은 탭의 저장소를 복구할 수 있으므로 공용 기기에서는 반드시 로그아웃한다. JavaScript 접근이 가능한 토큰이므로 XSS에 대한 완전한 방어는 아니다.
- CSP는 운영에서 인라인 JavaScript, eval, 외부 스크립트를 허용하지 않는다. 개발 빌드에서만 Meteor 호환을 위해 eval을 허용한다. 터미널 스타일은 인라인 CSS가 필요하다. 파일 다운로드용 service worker/iframe은 같은 출처만 허용한다.
- 계정 보안 화면에서 로그인 기록과 IP를 확인한다. 기록은 7일 뒤 MongoDB TTL로 삭제되며 비밀번호·OTP·토큰·등록 키는 기록하지 않는다.

## 2단계 인증

`계정 보안 → 인증 앱 등록`에서 현재 비밀번호를 확인하고 QR 코드를 인증 앱에 등록한다. 복구 코드를 안전한 곳에 보관하고 실제 6자리 코드를 입력해야 활성화된다. 배포만으로 사용자의 인증 앱을 대신 등록하지 않는다.

등록 키는 SSH 비밀정보와 같은 AES-256-GCM 키로 암호화해 비공개 users.services 필드에 저장한다. 서버와 DB를 함께 장악한 공격자는 이 키에 접근할 수 있으므로 별도 서버 침해 방어를 대체하지 않는다. OTP는 30초 주기, 앞뒤 1주기를 허용하며 DB의 원자적 카운터 갱신으로 재사용을 막는다. 복구 코드는 각각 128비트 난수이며 SHA-256 해시만 저장하고 원자적으로 한 번만 소비한다. 등록 대기 정보는 10분 유효하고 시작한 DDP 연결에 묶인다.

활성화·해제와 모든 기기 로그아웃은 모든 로그인 토큰을 폐기한다. 해제와 모든 기기 로그아웃에는 현재 비밀번호와 활성화된 2단계 인증이 필요하다. 등록 키와 복구 코드를 모두 잃어버리면 서버 관리자가 DB에서 해당 계정의 `services.webTerminalMfa`, `services.webTerminalMfaPending`, `services.resume.loginTokens`를 함께 제거해야 하므로 먼저 안전한 관리자 경로를 확보한다. 이 작업은 일반 웹 API로 제공하지 않는다.

TOTP는 피싱에 완전히 강하지 않다. 더 높은 보증이 필요하면 WebAuthn/passkey 또는 VPN·접근 프록시를 추가한다. 2단계 인증을 도입하기 전 릴리스로 롤백하면 해당 검증이 사라지므로, 활성화한 뒤에는 이전 인증 구현으로 롤백하지 않는다.

## 비밀정보가 Git에 들어갔을 때

1. **먼저 폐기·교체한다.** Git에서 지워도 복제본·캐시의 값은 회수되지 않는다. 운영 DB의 실제 비밀번호, 기존 로그인 토큰, 로컬 비밀 파일, 배포용 환경 파일을 함께 갱신한다. `.env.local` 변경만으로 기존 계정 비밀번호가 바뀌지는 않는다.
2. `git ls-remote --heads --tags origin`으로 브랜치·태그를 확인하고 PR·fork 및 협업자에게 미칠 영향을 확인한다. 작업 중인 변경은 먼저 커밋하고, 공용 브랜치 재작성은 작업자와 조율한다.
3. 별도 디렉터리에 새 mirror clone을 만들고, `git-filter-repo` 2.47 이상에서 `--sensitive-data-removal --replace-text`를 사용한다. 교체 파일은 저장소 밖 권한 600의 파일이며, `literal:<실제 노출 값>==>CHANGE_ME` 형식이다. 실제 값을 명령행·채팅·쉘 이력에 넣지 않는다. 파일 전체가 비밀정보라면 `--invert-paths --path <파일>`로 모든 이력에서 제거한다. 커밋 메시지도 노출됐으면 `--replace-message`가 필요하다.
4. 모든 reachable blob·커밋·태그에 실제 값이 없는지 대조하고 `gitleaks git --redact --log-opts=--all`로 재검사한다. 자동 탐지기는 임의의 비밀번호를 모두 인식하지 못한다. 현재 코드의 파일 트리도 비교한다.
5. 원격 커밋이 바뀌지 않았는지 확인하고 필요한 브랜치만 명시적인 `--force-with-lease=refs/heads/<브랜치>:<확인한 이전 SHA>`로 반영한다. `--mirror` push는 의도하지 않은 ref 삭제도 유발하므로 대상 ref를 검토한다. 해당 커밋과 자손의 SHA·서명은 바뀐다.
6. 기존 clone에서 예전 브랜치를 merge/push하면 오염된 이력이 돌아온다. 새 clone을 권장하고 필요한 미커밋 변경만 옮긴다. 로컬 reflog·dangling object·stash·백업·태그·worktree도 확인한다. 협업자의 작업을 보존하기 전에 강제로 GC/reset하지 않는다.
7. 원격 브랜치 재작성만으로 GitHub의 옛 SHA 주소, PR ref, 캐시, 외부 clone이 모두 삭제됐다고 판단하지 않는다. GitHub Support는 **암호 교체로 위험을 해소할 수 없는 민감정보**로 판단한 경우에만 제거를 지원한다. 이미 폐기한 비밀번호의 캐시 삭제는 지원 대상이라고 보장할 수 없으며, 이는 추가 force push로 해결할 수 없다. 지원 대상이면 저장소, 영향을 받는 PR 수, `First Changed Commit(s)`, orphaned LFS 여부를 준비한다. 실제 비밀 값은 요청 본문에 넣지 않는다.

## 재발 방지

새 clone에서 `npm ci` 후 `git config core.hooksPath .githooks`를 실행한다. 커밋 전 검사는 staged 파일만 읽고 현재 `.env.local`의 비밀 값, 개인 키, 환경 파일, 기본 인증값의 하드코딩을 차단한다. 값 자체는 출력하지 않는다. 우회 가능한 로컬 hook이므로 GitHub의 secret scanning/push protection, 전체 이력 Gitleaks Actions 검사와 함께 사용한다. PR 검사는 비밀정보가 원격으로 전송된 이후 실행되므로 폐기를 대체하지 않는다.

`.env.local`, `.deploy`, 런타임 파일과 DB 백업은 Git에 넣지 않는다. 배포 환경의 권한은 600, 상위 비밀 디렉터리는 700을 유지한다. `npm audit`, Cargo 의존성 및 Meteor 보안 공지를 정기적으로 확인한다. Dependabot은 npm/Cargo/GitHub Actions 업데이트를 제안하지만 Meteor Atmosphere 패키지까지 갱신하지는 않는다.

## 검증

`npm test`는 새 비밀번호 정책, OTP 시간 창, 복구 코드, 실패 횟수 제한, staged 비밀정보 차단과 기존 터미널 회귀 검사를 실행한다. `VERIFY_AUTH_ISOLATED=1 VERIFY_URL=http://127.0.0.1:5176 node scripts/verify-security.cjs`는 **별도 복사본과 폐기 가능한 로컬 MongoDB**에서만 실행한다. 이 검사는 비밀번호를 바꿨다가 원래 값으로 복구하고, 기본 변경 API 차단·다른 기기 세션 폐기·MFA 유지를 검사하며 로그인 제한까지 소진한다. 실패 시 QA DB는 폐기한다. 운영 또는 사용 중인 개발 DB에 실행하지 않는다. 시도 제한이 풀린 뒤 `scripts/verify-transfers.cjs`로 실제 SSH 파일 전송도 확인한다.

같은 격리 조건에서 `scripts/verify-password-terminal.cjs`는 두 브라우저 연결에 터미널을 열고 비밀번호 변경 시 양쪽 터미널과 로그인이 모두 종료되는지 검사한 뒤 QA 암호를 원래 값으로 복구한다. 로그인 시도 제한이 풀린 뒤 실행한다.

참고: [GitHub 민감정보 제거](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository), [OWASP 인증](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP 다중요소 인증](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html).
