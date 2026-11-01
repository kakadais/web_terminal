const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readAliases, readSources, resolveAlias } = require('../lib/ssh-config.cjs');
const { getEditor, planSave, validatePlan, commitPlan } = require('../lib/ssh-config-editor.cjs');
const { createSshConnection, writeRuntimeConfig } = require('../lib/ssh-connection.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-layout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const managed = path.join(dir, '.home', 'ssh');
  const xdg = path.join(dir, '.config', 'ssh');
  const config = path.join(dir, '.ssh', 'config');
  for (const directory of [managed, path.dirname(xdg), path.dirname(config), path.join(managed, 'hosts')]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.symlinkSync(managed, xdg);
  fs.symlinkSync(path.join(managed, 'config'), config);
  fs.symlinkSync(path.join(managed, 'profile.conf'), path.join(managed, 'current.conf'));
  const previous = process.env.WTERM_TEST_SSH_DIR;
  process.env.WTERM_TEST_SSH_DIR = xdg;
  t.after(() => {
    if (previous === undefined) delete process.env.WTERM_TEST_SSH_DIR;
    else process.env.WTERM_TEST_SSH_DIR = previous;
  });
  fs.writeFileSync(path.join(managed, 'config'), 'Include "${WTERM_TEST_SSH_DIR}/current.conf"\nHost *\n Include "${WTERM_TEST_SSH_DIR}/common.conf"\n');
  // OpenSSH resolves this relative to the real user's ~/.ssh, not either config directory.
  const relative = path.relative(path.join(os.homedir(), '.ssh'), path.join(xdg, 'hosts', '*.conf'));
  fs.writeFileSync(path.join(managed, 'profile.conf'), `Include "${relative}"\n`);
  fs.writeFileSync(path.join(managed, 'hosts', '10-destination.conf'), 'Host destination\n HostName 127.0.0.1\n User demo\n Port 2222\n ProxyJump jump\n HostKeyAlias custom-target\n UserKnownHostsFile "${WTERM_TEST_SSH_DIR}/target hosts" "${WTERM_TEST_SSH_DIR}/trusted/%k"\n IdentityFile "${WTERM_TEST_SSH_DIR}/identity key"\n');
  fs.writeFileSync(path.join(managed, 'hosts', '20-jump.conf'), 'Host jump\n HostName 127.0.0.2\n User relay\n Port 2233\n UserKnownHostsFile "${WTERM_TEST_SSH_DIR}/jump hosts"\n');
  fs.writeFileSync(path.join(managed, 'common.conf'), 'Host *\n ServerAliveInterval 42\n');
  return { dir, managed, xdg, config };
}

function effective(config, alias) {
  return execFileSync('/usr/bin/ssh', ['-G', '-F', config, '--', alias], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).split('\n');
}

test('environment Includes, nested globs and linked XDG files survive discovery, editing and runtime use', async t => {
  const { dir, managed, xdg, config } = fixture(t);
  assert.deepEqual(readAliases(config), ['destination', 'jump']);
  assert.equal(readSources(config).size, 5);
  const editor = getEditor(config, 'destination');
  const source = path.join(managed, 'hosts', '10-destination.conf');
  assert.equal(editor.blocks[0].file, fs.realpathSync(source));
  const plan = planSave(config, 'destination', editor.version,
    editor.blocks.map(block => ({ ...block, text: block.text.replace('Port 2222', 'Port 2244') })));
  assert.equal((await validatePlan(plan)).port, 2244);
  const rollback = commitPlan(plan, path.join(dir, 'backups'));
  assert.ok(fs.lstatSync(config).isSymbolicLink());
  assert.ok(fs.lstatSync(xdg).isSymbolicLink());
  assert.ok(fs.lstatSync(path.join(managed, 'current.conf')).isSymbolicLink());
  assert.equal((await resolveAlias('destination', config)).port, 2244);
  const runtime = writeRuntimeConfig({ source: 'config' }, { sshConfig: config }, dir);
  for (const alias of ['destination', 'jump']) {
    const original = effective(config, alias);
    const wrapped = effective(runtime, alias);
    for (const setting of ['user ', 'hostname ', 'port ', 'proxyjump ', 'identityfile ', 'hostkeyalias ', 'userknownhostsfile ']) {
      assert.deepEqual(wrapped.filter(line => line.startsWith(setting)), original.filter(line => line.startsWith(setting)), `${alias}: ${setting}`);
    }
  }
  rollback();
  assert.equal((await resolveAlias('destination', config)).port, 2222);
});

test('SSH connections preserve native known_hosts unless an explicit override is provided', t => {
  const { dir, config } = fixture(t);
  const server = { source: 'config', sshAlias: 'destination', host: '127.0.0.1', port: 2222, username: 'demo', authType: 'config' };
  const connection = createSshConnection(server, { sshConfig: config });
  try {
    assert.equal(connection.env.WTERM_TEST_SSH_DIR, process.env.WTERM_TEST_SSH_DIR);
    assert.ok(!connection.args.some(arg => arg.startsWith('UserKnownHostsFile=')));
    const runtime = connection.args[connection.args.indexOf('-F') + 1];
    assert.deepEqual(effective(runtime, 'destination').filter(line => line.startsWith('userknownhostsfile ')),
      effective(config, 'destination').filter(line => line.startsWith('userknownhostsfile ')));
  } finally { connection.cleanup(); }
  assert.ok(!fs.existsSync(connection.tempDir));
  const knownHosts = path.join(dir, 'explicit hosts');
  const overridden = createSshConnection(server, { sshConfig: config, knownHosts });
  try {
    const runtime = overridden.args[overridden.args.indexOf('-F') + 1];
    for (const alias of ['destination', 'jump']) assert.ok(effective(runtime, alias).includes(`userknownhostsfile ${knownHosts}`));
    assert.ok(overridden.args.includes(`UserKnownHostsFile="${knownHosts}"`));
  } finally { overridden.cleanup(); }
});

test('unset Include variables fail discovery instead of silently dropping configured servers', t => {
  const { config } = fixture(t);
  delete process.env.WTERM_TEST_SSH_DIR;
  assert.throws(() => readAliases(config), /Include 환경변수가 설정되지 않았습니다/);
});
