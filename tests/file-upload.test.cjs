const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { validateFile, validateDirectory, storeUpload, resolveDirectory, remoteUploadCommand, byteMeter } = require('../lib/file-upload.cjs');
const { createPidTracker } = require('../lib/terminal-tracking.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-upload-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const local = { target: { source: 'local' } };
const config = { uploadMaxBytes: 8 * 1024 * 1024 };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

test('file metadata rejects traversal, invalid sizes and control characters while preserving literal names', () => {
  for (const name of ['../secret', 'a/b', 'a\\b', '.', '..', 'a\nname', 'a\0name', '한'.repeat(100)]) assert.throws(() => validateFile({ name, size: 1 }, 10));
  for (const size of [-1, 11, 1.2, Infinity]) assert.throws(() => validateFile({ name: 'ok', size }, 10));
  assert.deepEqual(validateFile({ name: "한글 '$()`.png", size: 0 }, 10), { name: "한글 '$()`.png", size: 0 });
  for (const directory of ['', './relative', '/tmp/\nunsafe']) assert.throws(() => validateDirectory(directory));
  assert.equal(validateDirectory('/tmp/a folder'), '/tmp/a folder');
});

test('local streaming uploads preserve binary data and refuse existing files and directories', async t => {
  const dir = fixture(t); const data = crypto.randomBytes(2 * 1024 * 1024 + 37);
  const file = { name: "한글 file '$()`;.bin", size: data.length };
  const saved = await storeUpload(Readable.from([data]), local, config, dir, file, new AbortController().signal);
  assert.equal(saved.path, path.join(dir, file.name)); assert.equal(sha(fs.readFileSync(saved.path)), sha(data));
  assert.equal(fs.statSync(saved.path).mode & 0o777, 0o600);
  await assert.rejects(storeUpload(Readable.from([data]), local, config, dir, file), { code: 'file-exists' });
  fs.mkdirSync(path.join(dir, 'folder'));
  await assert.rejects(storeUpload(Readable.from([Buffer.from('a')]), local, config, dir, { name: 'folder', size: 1 }), { code: 'file-exists' });
  assert.equal(sha(fs.readFileSync(saved.path)), sha(data));
  assert.ok(fs.readdirSync(dir).every(name => !name.startsWith('.web-terminal-upload.')));
});

test('interrupted or mismatched local uploads do not publish incomplete files', async t => {
  const dir = fixture(t);
  await assert.rejects(storeUpload(Readable.from([Buffer.from('short')]), local, config, dir, { name: 'short', size: 20 }), { code: 'size-mismatch' });
  await assert.rejects(storeUpload(Readable.from([Buffer.alloc(20)]), local, config, dir, { name: 'long', size: 5 }), { code: 'size-mismatch' });
  const controller = new AbortController();
  const input = new Readable({ read() { this.push(Buffer.alloc(1024)); } });
  const cancelled = storeUpload(input, local, config, dir, { name: 'cancelled', size: 8 * 1024 * 1024 }, controller.signal, () => controller.abort());
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

async function runUploadScript(directory, file, data) {
  const marker = 'VERIFIED_UPLOAD';
  const child = spawn('/bin/sh', ['-c', remoteUploadCommand(directory, file, marker)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', value => { output += value; }); child.stderr.resume();
  const closed = new Promise(resolve => child.on('close', code => resolve(code)));
  await pipeline(Readable.from([data]), byteMeter(data.length), child.stdin);
  return { code: await closed, output };
}
test('remote shell writer handles hostile literal filenames, size mismatches and atomic conflicts', async t => {
  const dir = fixture(t); const data = crypto.randomBytes(65537);
  const name = "literal ' $(touch PWNED) `uname` ; 한글.bin";
  const file = { name, size: data.length };
  assert.deepEqual(await runUploadScript(dir, file, data), { code: 0, output: 'VERIFIED_UPLOAD\n' });
  assert.equal(sha(fs.readFileSync(path.join(dir, name))), sha(data)); assert.ok(!fs.existsSync(path.join(dir, 'PWNED')));
  assert.equal((await runUploadScript(dir, file, data)).code, 94);
  fs.mkdirSync(path.join(dir, 'folder')); assert.equal((await runUploadScript(dir, { ...file, name: 'folder' }, data)).code, 94);
  assert.equal((await runUploadScript(dir, { name: 'incomplete', size: data.length + 1 }, data)).code, 93);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['folder', name].sort());
});

test('PID handshake is removed across arbitrary chunk boundaries without losing terminal output', () => {
  let pid; const tracker = createPidTracker('nonce', value => { pid = value; });
  const text = '안녕\x1b[32mhello\x1b[0m';
  const raw = `${text}\x1b]777;web-terminal;nonce;pid;12345\x07prompt\x1b]0;title\x07`;
  let output = ''; for (const character of raw) output += tracker.push(character); output += tracker.flush();
  assert.equal(pid, 12345); assert.equal(output, text + 'prompt\x1b]0;title\x07');
});

test('native process directory is resolved without writing a command into its terminal', async () => {
  const directory = await resolveDirectory({ target: { source: 'local' }, terminal: { pid: process.pid } }, config);
  assert.equal(directory, fs.realpathSync(process.cwd()));
});

test('native cwd lookup preserves Korean paths and literal lsof-looking backslashes', async t => {
  const directory = path.join(fixture(t), "한글 ' \\x41 folder"); fs.mkdirSync(directory);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: directory, stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  t.after(() => child.kill());
  const resolved = await resolveDirectory({ target: { source: 'local' }, terminal: { pid: child.pid } }, config);
  assert.equal(resolved, fs.realpathSync(directory));
});
