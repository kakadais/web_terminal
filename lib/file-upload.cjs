const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createSshConnection, quoteShell } = require('./ssh-connection.cjs');
const { terminalEnv } = require('./terminal-env.cjs');
const run = promisify(execFile);

class UploadError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function validateFile(file, maxBytes) {
  if (!file || typeof file.name !== 'string' || !file.name || ['.', '..'].includes(file.name)
    || /[/\\\x00-\x1f\x7f]/.test(file.name) || Buffer.byteLength(file.name) > 255) {
    throw new UploadError('invalid-name', '파일 이름에 경로 구분자나 제어 문자를 사용할 수 없습니다.');
  }
  if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) {
    throw new UploadError('file-too-large', `파일은 ${Math.floor(maxBytes / 1024 / 1024)}MB 이하로 전송해 주세요.`, 413);
  }
  return { name: file.name, size: file.size };
}
function validateDirectory(directory) {
  if (typeof directory !== 'string' || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory)
    || !(directory.startsWith('/') || directory === '~' || directory.startsWith('~/'))) {
    throw new UploadError('invalid-directory', '저장 경로는 절대 경로 또는 ~/로 시작하는 경로를 입력해 주세요.');
  }
  return directory;
}

function cwdCommand(pid) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) throw new UploadError('cwd-unavailable', '현재 작업 경로를 확인하지 못했습니다. 저장 경로를 직접 입력해 주세요.');
  return `if [ -d /proc/${pid}/cwd ]; then cd /proc/${pid}/cwd && printf 'raw\\n' && pwd -P; else value=$(lsof -a -p ${pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1); [ -n "$value" ] || exit 91; printf 'lsof\\n%s\\n' "$value"; fi`;
}
// lsof escapes non-ASCII bytes and literal backslashes even in its field output.
function decodeLsofPath(value) {
  const parts = []; let cursor = 0;
  const controls = { b: 8, f: 12, r: 13, n: 10, t: 9, v: 11, '\\': 92 };
  for (const match of value.matchAll(/\\(\\|[bfrntv]|x[0-9a-fA-F]{2})/g)) {
    parts.push(Buffer.from(value.slice(cursor, match.index)), Buffer.from([match[1].startsWith('x') ? parseInt(match[1].slice(1), 16) : controls[match[1]]]));
    cursor = match.index + match[0].length;
  }
  parts.push(Buffer.from(value.slice(cursor)));
  return Buffer.concat(parts).toString('utf8');
}
function directoryCommand(directory) {
  validateDirectory(directory);
  return `directory=${quoteShell(directory)}; case "$directory" in '~') directory="$HOME" ;; '~/'*) directory="$HOME/\${directory#\~/}" ;; esac; cd -- "$directory" && pwd -P`;
}
async function runRemoteCommand(server, config, script, signal) {
  const connection = createSshConnection(server, config);
  try {
    const { stdout } = await run(config.sshCommand, [...connection.args, '--', connection.destination, `sh -c ${quoteShell(script)}`], {
      env: connection.env, cwd: os.homedir(), timeout: 15000, maxBuffer: 64 * 1024, signal,
    });
    return stdout;
  } finally { connection.cleanup(); }
}
async function resolveDirectory(session, config, requested, signal) {
  if (session.target.source === 'local') {
    let directory = requested;
    if (!directory) {
      const pid = session.terminal.pid;
      if (process.platform === 'linux') directory = await fsp.realpath(`/proc/${pid}/cwd`);
      else {
        const { stdout } = await run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000, signal, env: terminalEnv() });
        const field = stdout.split('\n').find(line => line.startsWith('n'))?.slice(1);
        directory = field === undefined ? undefined : decodeLsofPath(field);
      }
    }
    validateDirectory(directory);
    directory = directory.replace(/^~(?=\/|$)/, os.homedir());
    const real = await fsp.realpath(directory);
    if (!(await fsp.stat(real)).isDirectory()) throw new UploadError('invalid-directory', '저장할 디렉터리를 찾을 수 없습니다.');
    return real;
  }
  const marker = `WT_CWD_${crypto.randomBytes(16).toString('hex')}`;
  const script = `set -e; printf '\\n${marker}\\n'; ${requested ? `printf 'raw\\n'; ${directoryCommand(requested)}` : cwdCommand(session.remotePid)}`;
  const output = await runRemoteCommand(session.target, config, script, signal);
  if (!output.includes(`${marker}\n`)) throw new UploadError('cwd-unavailable', '현재 작업 경로를 확인하지 못했습니다. 저장 경로를 직접 입력해 주세요.');
  const result = output.slice(output.lastIndexOf(`${marker}\n`) + marker.length + 1);
  const newline = result.indexOf('\n');
  const format = result.slice(0, newline);
  let directory = result.slice(newline + 1).replace(/\r?\n$/, '');
  if (format === 'lsof') directory = decodeLsofPath(directory);
  else if (format !== 'raw') throw new UploadError('cwd-unavailable', '현재 작업 경로를 확인하지 못했습니다. 저장 경로를 직접 입력해 주세요.');
  validateDirectory(directory);
  return directory;
}

function byteMeter(expected, onProgress) {
  let received = 0;
  return new Transform({
    transform(chunk, encoding, callback) {
      received += chunk.length;
      if (received > expected) return callback(new UploadError('size-mismatch', '파일 크기가 등록된 정보와 다릅니다.'));
      onProgress?.(received);
      callback(null, chunk);
    },
    flush(callback) { callback(received === expected ? null : new UploadError('size-mismatch', '파일을 끝까지 받지 못했습니다.')); },
  });
}

function remoteUploadCommand(directory, file, marker) {
  validateDirectory(directory); validateFile(file, Number.MAX_SAFE_INTEGER);
  return `set -eu
umask 077
directory=${quoteShell(directory)}
name=${quoteShell(file.name)}
cd -- "$directory" || exit 91
tmp=$(mktemp './.web-terminal-upload.XXXXXXXX') || exit 95
trap 'rm -f -- "$tmp"' 0 1 2 15
cat > "$tmp" || exit 93
bytes=$(wc -c < "$tmp")
[ "$bytes" -eq ${file.size} ] || exit 93
if link "$tmp" "./$name" 2>/dev/null; then
  printf '%s\\n' ${quoteShell(marker)}
else
  if [ -e "./$name" ] || [ -L "./$name" ]; then exit 94; fi
  exit 95
fi`;
}
function remoteError(exitCode) {
  if (exitCode === 94) return new UploadError('file-exists', '같은 이름의 파일이 이미 있습니다. 기존 파일은 변경하지 않았습니다.', 409);
  if (exitCode === 91) return new UploadError('invalid-directory', '저장 경로가 없거나 접근할 수 없습니다.');
  if (exitCode === 93) return new UploadError('size-mismatch', '파일을 끝까지 전송하지 못했습니다.');
  if (exitCode === 95) return new UploadError('write-failed', '파일을 저장할 수 없습니다. 디렉터리 권한과 파일시스템을 확인해 주세요.', 403);
  return new UploadError('ssh-failed', 'SSH 파일 전송에 실패했습니다. 접속 정보와 저장 경로를 확인해 주세요.', 502);
}
async function uploadRemote(source, session, config, directory, file, signal, onProgress) {
  const connection = createSshConnection(session.target, config);
  const marker = `WT_UPLOAD_${crypto.randomBytes(16).toString('hex')}`;
  const child = spawn(config.sshCommand, [...connection.args, '--', connection.destination,
    `sh -c ${quoteShell(remoteUploadCommand(directory, file, marker))}`], { env: connection.env, cwd: os.homedir(), stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let spawnError;
  child.stdout.on('data', data => { output = (output + data.toString()).slice(-4096); });
  // Drain errors, but never expose raw SSH messages/config comments to clients.
  child.stderr.resume();
  const closed = new Promise(resolve => { child.once('error', error => { spawnError = error; }); child.once('close', code => resolve(code)); });
  let killer;
  const stop = () => { child.kill('SIGTERM'); killer = setTimeout(() => child.kill('SIGKILL'), 1000); killer.unref(); };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();
  try {
    await pipeline(source, byteMeter(file.size, onProgress), child.stdin, { signal });
    const code = await closed;
    if (spawnError || code !== 0 || !output.includes(marker)) throw remoteError(code);
  } catch (error) {
    stop(); const code = await closed;
    if (signal?.aborted || error instanceof UploadError) throw error;
    throw remoteError(code);
  } finally { clearTimeout(killer); signal?.removeEventListener('abort', stop); connection.cleanup(); }
}
async function uploadLocal(source, directory, file, signal, onProgress) {
  const real = await fsp.realpath(directory);
  const temporary = path.join(real, `.web-terminal-upload.${crypto.randomUUID()}`);
  try {
    await pipeline(source, byteMeter(file.size, onProgress), fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
    const handle = await fsp.open(temporary, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
    signal?.throwIfAborted();
    await fsp.link(temporary, path.join(real, file.name));
  } catch (error) {
    if (error.code === 'EEXIST') throw remoteError(94);
    throw error;
  } finally { await fsp.rm(temporary, { force: true }); }
}
async function storeUpload(source, session, config, directory, file, signal, onProgress) {
  validateDirectory(directory); validateFile(file, config.uploadMaxBytes);
  if (session.target.source === 'local') await uploadLocal(source, directory, file, signal, onProgress);
  else await uploadRemote(source, session, config, directory, file, signal, onProgress);
  return { name: file.name, directory, path: path.posix.join(directory, file.name), size: file.size };
}
module.exports = { UploadError, validateFile, validateDirectory, cwdCommand, directoryCommand,
  resolveDirectory, storeUpload, remoteUploadCommand, byteMeter };
