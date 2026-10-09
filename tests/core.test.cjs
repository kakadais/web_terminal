const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { encrypt, decrypt } = require('../lib/credentials.cjs');
const { readAliases, resolveAlias } = require('../lib/ssh-config.cjs');
const { validateServer } = require('../lib/server-input.cjs');

test('encrypted credentials round-trip; altered ciphertext and wrong keys are rejected', () => {
  const key = crypto.randomBytes(32).toString('hex');
  const password = '한글 secret ! $() " \'\n';
  const encrypted = encrypt(password, key);
  assert.equal(decrypt(encrypted, key), password);
  assert.ok(!JSON.stringify(encrypted).includes(password));
  assert.notDeepEqual(encrypt(password, key), encrypted);
  assert.throws(() => decrypt(encrypted, crypto.randomBytes(32).toString('hex')));
  const data = Buffer.from(encrypted.data, 'base64'); data[0] ^= 1;
  assert.throws(() => decrypt({ ...encrypted, data: data.toString('base64') }, key));
  assert.equal(decrypt(encrypt('', key), key), '');
});

test('SSH config imports explicit aliases, Includes and OpenSSH effective defaults', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config');
  fs.writeFileSync(path.join(dir, 'extra.conf'), 'Host extra\n HostName 127.0.0.2\n User demo#legacy-comment\n');
  fs.writeFileSync(config, `Include ${dir}/*.conf\nHost alpha beta\n HostName 127.0.0.1\n User ubuntu\n Port 22022\n ProxyJump extra\nHost * !excluded wildcard-*\n ServerAliveInterval 20\nHost alpha\n Port 22\n`);
  assert.deepEqual(readAliases(config), ['alpha', 'beta', 'extra']);
  const resolved = await resolveAlias('alpha', config);
  assert.equal(resolved.host, '127.0.0.1');
  assert.equal(resolved.username, 'ubuntu');
  assert.equal(resolved.port, 22022);
  assert.equal(resolved.proxyJump, 'extra');
  assert.equal((await resolveAlias('extra', config)).username, 'demo');
  assert.throws(() => readAliases(path.join(dir, 'missing')));
});

test('manual server validation rejects option injection, invalid ports and public keys', () => {
  const base = { name: 'test', host: 'localhost', username: 'ubuntu', port: 22, authType: 'password' };
  assert.equal(validateServer(base).host, 'localhost');
  for (const change of [{ host: '-oProxyCommand=bad' }, { username: '-root' }, { host: 'host; command' },
    { port: 65536 }, { port: 0 }, { port: 22.5 }, { authType: 'none' }, { privateKey: 'ssh-ed25519 AAAA' }]) {
    assert.throws(() => validateServer({ ...base, ...change }));
  }
});

test('dotenv runtime snapshot treats shell metacharacters as literal data', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, '.env.local');
  const output = path.join(dir, 'runtime.env');
  const password = "literal $(false) `false` ' $HOME !";
  fs.writeFileSync(input, `MONGO_URL=mongodb://localhost/test\nADMIN_USERNAME=test\nADMIN_PASSWORD="${password}"\nCREDENTIAL_ENCRYPTION_KEY=${'ab'.repeat(32)}\nUNRELATED_SECRET=excluded\n`);
  execFileSync(process.execPath, [path.resolve('scripts/runtime-env.cjs'), input, output]);
  const result = execFileSync('bash', ['-c', 'source "$1"; printf "%s" "$ADMIN_PASSWORD"', 'verify', output], { encoding: 'utf8' });
  assert.equal(result, password);
  assert.ok(!fs.readFileSync(output, 'utf8').includes('UNRELATED_SECRET'));
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
});
