const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnProcess } = require('node:child_process');
const { spawn, getProcessCwd } = require('../lib/pty.js');
const { nativePath } = require('../lib/native-runtime.cjs');
const { terminalEnv } = require('../lib/terminal-env.cjs');

async function until(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}
function gone(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }
function terminal(t, file, args, options = {}) {
  const pty = spawn(file, args, { cols: 80, rows: 24, cwd: os.tmpdir(), env: terminalEnv(), ...options });
  let output = '';
  pty.onData(data => { output += data; });
  const closed = new Promise(resolve => pty.onExit(resolve));
  t.after(async () => { pty.kill(); await closed; });
  return { pty, closed, output: () => output };
}

test('backend lookup survives Meteor cwd relocation and honors an explicit custom path', () => {
  const root = path.resolve(__dirname, '..');
  assert.equal(nativePath({}, path.join(root, '.meteor/local/build/programs/server')),
    path.join(root, '.deploy/native/bin/web-terminal-pty'));
  assert.equal(nativePath({ WEB_TERMINAL_PTY_PATH: '/custom home/bin/terminal' }), '/custom home/bin/terminal');
});

test('Rust PTY preserves split UTF-8, escapes and trailing output before a nonzero exit', { timeout: 10000 }, async t => {
  const expected = '한글🙂\x1b[31m끝\x1b[0m';
  const script = `const b = Buffer.from(${JSON.stringify(expected)}); process.stdout.write(b.subarray(0, 1)); setTimeout(() => { process.stdout.write(b.subarray(1), () => process.exit(23)); }, 50);`;
  const item = terminal(t, process.execPath, ['-e', script]);
  await item.pty.ready;
  assert.ok(item.pty.pid > 0);
  assert.notEqual(item.pty.pid, item.pty.helperPid);
  assert.equal((await item.closed).exitCode, 23);
  assert.equal(item.output(), expected);
  assert.ok(gone(item.pty.pid));
});

test('Rust PTY provides a controlling TTY, resizes it and accepts input', { timeout: 10000 }, async t => {
  const script = `console.log('INIT:' + process.stdout.columns + 'x' + process.stdout.rows); process.stdout.on('resize', () => console.log('SIZE:' + process.stdout.columns + 'x' + process.stdout.rows)); process.stdin.setRawMode(true); process.stdin.on('data', data => { console.log('INPUT:' + data.toString('hex')); if (data.toString().includes('done')) process.exit(0); });`;
  const item = terminal(t, process.execPath, ['-e', script]);
  await item.pty.ready;
  await until(() => item.output().includes('INIT:80x24'), 'initial TTY size');
  item.pty.resize(101, 39);
  await until(() => item.output().includes('SIZE:101x39'), 'resized TTY');
  item.pty.write('한글');
  await until(() => item.output().includes('INPUT:' + Buffer.from('한글').toString('hex')), 'Unicode input');
  item.pty.write('done');
  assert.equal((await item.closed).exitCode, 0);
});

test('Rust PTY streams large output completely without JSON framing or truncation', { timeout: 10000 }, async t => {
  const item = terminal(t, process.execPath, ['-e', "process.stdout.write('x'.repeat(1024 * 1024) + 'END', () => process.exit(0))"]);
  await item.pty.ready;
  assert.equal((await item.closed).exitCode, 0);
  assert.equal(item.output(), 'x'.repeat(1024 * 1024) + 'END');
});

test('a paused PTY can be killed and drains its pipe before close', { timeout: 10000 }, async t => {
  const item = terminal(t, process.execPath, ['-e', "setInterval(() => process.stdout.write('x'.repeat(65536)), 10)"]);
  await item.pty.ready;
  item.pty.pause();
  await new Promise(resolve => setTimeout(resolve, 100));
  item.pty.kill(); await item.closed;
  assert.ok(gone(item.pty.helperPid)); assert.ok(gone(item.pty.pid));
});

test('PTY retains custom home, XDG, PATH and SSH agent environment without app credentials', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal custom 한글 '));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { ...terminalEnv(), HOME: directory, XDG_CONFIG_HOME: path.join(directory, '.config'),
    SSH_AUTH_SOCK: path.join(directory, 'agent'), PATH: path.dirname(process.execPath) + ':/usr/bin:/bin' };
  const script = "console.log(JSON.stringify({home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME, agent: process.env.SSH_AUTH_SOCK, path: process.env.PATH, credential: process.env.CREDENTIAL_ENCRYPTION_KEY}));";
  const item = terminal(t, process.execPath, ['-e', script], { env, cwd: directory });
  await item.pty.ready;
  await item.closed;
  assert.deepEqual(JSON.parse(item.output()), { home: directory, xdg: env.XDG_CONFIG_HOME, agent: env.SSH_AUTH_SOCK, path: env.PATH });
});

test('native cwd follows shell cd without injecting terminal input', { timeout: 10000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal cwd 한글 \\x41 '));
  const nested = path.join(directory, 'next'); fs.mkdirSync(nested);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const item = terminal(t, '/bin/sh', ['-i'], { cwd: directory, env: { ...terminalEnv(), ENV: '/dev/null' } });
  await item.pty.ready;
  assert.equal(await getProcessCwd(item.pty.pid), fs.realpathSync(directory));
  item.pty.write("cd next; printf 'CHANGED\\n'\n");
  await until(async () => (await getProcessCwd(item.pty.pid)) === fs.realpathSync(nested), 'cwd after cd');
});

test('closing a terminal terminates a foreground job that ignores HUP and TERM', { timeout: 10000 }, async t => {
  const item = terminal(t, '/bin/sh', ['-i'], { env: { ...terminalEnv(), ENV: '/dev/null' } });
  await item.pty.ready;
  item.pty.write(`'${process.execPath.replace(/'/g, "'\\''")}' -e 'process.on("SIGHUP", () => {}); process.on("SIGTERM", () => {}); console.log("FGPID:" + process.pid); setInterval(() => {}, 1000)'\n`);
  await until(() => /\r?\nFGPID:(\d+)/.test(item.output()), 'foreground child PID');
  const foreground = Number(item.output().match(/\r?\nFGPID:(\d+)/)[1]);
  t.after(() => { try { process.kill(foreground, 'SIGKILL'); } catch (_) {} });
  item.pty.kill(); item.pty.kill();
  await item.closed;
  await until(() => gone(foreground), 'foreground child must exit');
  assert.ok(gone(item.pty.pid));
});

test('failed executable rejects readiness and exits without a live backend', { timeout: 10000 }, async t => {
  const item = terminal(t, '/no/such/web-terminal-program', []);
  await assert.rejects(item.pty.ready);
  await item.closed;
  assert.ok(gone(item.pty.helperPid));
});

test('an input flood closes the backend instead of growing its queue indefinitely', { timeout: 10000 }, async t => {
  const item = terminal(t, '/bin/sh', ['-c', 'sleep 30']);
  await item.pty.ready;
  assert.throws(() => { for (let i = 0; i < 1000; i++) item.pty.write('x'.repeat(32768)); }, { code: 'input-overflow' });
  await item.closed;
  assert.ok(gone(item.pty.pid));
});

test('loss of the parent control pipe terminates the owned terminal', { timeout: 10000 }, async t => {
  const helper = spawnProcess(nativePath(), [], { env: terminalEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => helper.kill('SIGKILL'));
  let control = ''; helper.stderr.on('data', data => { control += data; }); helper.stdout.resume();
  const closed = new Promise(resolve => helper.once('close', resolve));
  helper.stdin.write(JSON.stringify({ type: 'spawn', protocol: 1, file: '/bin/sh', args: ['-c', 'exec sleep 30'], cwd: os.tmpdir(), cols: 80, rows: 24 }) + '\n');
  await until(() => control.includes('"ready"'), 'helper ready');
  const { pid } = JSON.parse(control.split('\n').find(line => line.includes('"ready"')));
  helper.stdin.end();
  await closed;
  assert.ok(gone(pid));
});
