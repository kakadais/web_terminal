const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getEditor, planSave, planRemove, validatePlan, commitPlan } = require('../lib/ssh-config-editor.cjs');
const { resolveAlias, readAliases, splitWords } = require('../lib/ssh-config.cjs');
const { validateServer } = require('../lib/server-input.cjs');
const { execFileSync } = require('node:child_process');
const { writeRuntimeConfig } = require('../lib/ssh-session.cjs');

function fixture(t, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-editor-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config'); fs.writeFileSync(config, text, { mode: 0o600 });
  return { dir, config, backup: path.join(dir, 'backups') };
}
const validate = resolved => validateServer({ ...resolved, name: resolved.alias, authType: 'config' });

test('new config entry precedes defaults and deletion restores the original bytes', async t => {
  const original = '# keep this prefix\r\nHost *\r\n    User default\r\n    Port 22\r\n';
  const { config, backup } = fixture(t, original);
  const editor = getEditor(config);
  const text = 'Host target\n    HostName 127.0.0.2\n    User demo\n    Port 2222\n    ProxyJump jump\n    LocalForward 127.0.0.1:12567 127.0.0.1:80\n';
  const plan = planSave(config, null, editor.version, [{ ...editor.blocks[0], text }]);
  const effective = await validatePlan(plan, '/usr/bin/ssh', validate);
  assert.equal(effective.port, 2222); assert.equal(effective.proxyJump, 'jump');
  commitPlan(plan, backup);
  assert.equal((await resolveAlias('target', config)).username, 'demo');
  const removed = planRemove(config, 'target', getEditor(config, 'target').version);
  await validatePlan(removed); commitPlan(removed, backup);
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
  for (const directory of fs.readdirSync(backup)) {
    assert.equal(fs.statSync(path.join(backup, directory, '0.conf')).mode & 0o777, 0o600);
  }
});

test('editing repeated Include blocks preserves symlinks, Match sections and unrelated entries', async t => {
  const { dir, config, backup } = fixture(t, '');
  const included = path.join(dir, 'extra.conf');
  const other = 'Match host untouched\n    ConnectTimeout 7\nHost other\n    HostName 127.0.0.3\n    User other\n';
  const rootText = `Include "${included}"\nHost target\n    ServerAliveInterval 12\n${other}`;
  const target = path.join(dir, 'real-config');
  fs.writeFileSync(target, rootText); fs.unlinkSync(config); fs.symlinkSync(target, config);
  fs.writeFileSync(included, 'Host target companion\n    HostName 127.0.0.1\n    User demo\n    Port 2222\n');
  const editor = getEditor(config, 'target');
  assert.equal(editor.blocks.length, 2); assert.deepEqual(editor.sharedAliases, ['companion']);
  const blocks = editor.blocks.map(block => ({ ...block, text: block.text.replace('Port 2222', 'Port 2244') }));
  const plan = planSave(config, 'target', editor.version, blocks);
  assert.equal((await validatePlan(plan, '/usr/bin/ssh', validate)).port, 2244);
  commitPlan(plan, backup);
  assert.ok(fs.lstatSync(config).isSymbolicLink()); assert.equal(fs.readlinkSync(config), target);
  assert.equal(fs.readFileSync(target, 'utf8'), rootText);
  assert.equal((await resolveAlias('target', config)).port, 2244);
  const removed = planRemove(config, 'target', getEditor(config, 'target').version);
  await validatePlan(removed); commitPlan(removed, backup);
  assert.deepEqual(readAliases(config), ['companion', 'other']);
  assert.equal((await resolveAlias('companion', config)).port, 2244);
  assert.ok(fs.readFileSync(target, 'utf8').endsWith(other));
});

test('invalid syntax, alias collisions and stale edits never overwrite a config', async t => {
  const original = 'Host alpha\n    HostName 127.0.0.1\n    User demo\nHost beta\n    HostName 127.0.0.2\n    User demo\n';
  const { config, backup } = fixture(t, original);
  const editor = getEditor(config, 'alpha');
  assert.throws(() => planSave(config, 'alpha', editor.version, [{ ...editor.blocks[0], text: 'Host beta\n User demo\n' }]), { code: 'alias-exists' });
  assert.throws(() => planSave(config, 'alpha', editor.version, [{ ...editor.blocks[0], text: 'Host alpha\nHost sneaky\n' }]), { code: 'invalid-config' });
  const invalid = planSave(config, 'alpha', editor.version, [{ ...editor.blocks[0], text: 'Host alpha\n    BadDirective yes\n' }]);
  await assert.rejects(validatePlan(invalid), { code: 'invalid-config' });
  assert.equal(fs.readFileSync(config, 'utf8'), original);
  const valid = planSave(config, 'alpha', editor.version, [{ ...editor.blocks[0], text: editor.blocks[0].text.replace('127.0.0.1', '127.0.0.4') }]);
  await validatePlan(valid, '/usr/bin/ssh', validate);
  fs.appendFileSync(config, '# external writer\n');
  assert.throws(() => commitPlan(valid, backup), { code: 'config-conflict' });
  assert.throws(() => planRemove(config, 'alpha', editor.version), { code: 'config-conflict' });
  assert.equal(fs.readFileSync(config, 'utf8'), original + '# external writer\n');
});

test('renaming a shared block updates every explicit alias while preserving quoted hashes', async t => {
  assert.deepEqual(splitWords('IdentityFile "/tmp/key #1" # comment'), ['IdentityFile', '/tmp/key #1']);
  const { config, backup } = fixture(t, 'Host alpha shared\n    HostName 127.0.0.1\n    User demo');
  const editor = getEditor(config, 'alpha');
  assert.equal(planSave(config, 'alpha', editor.version, editor.blocks).changes.size, 0, 'Saving unchanged text must preserve a missing final newline');
  const plan = planSave(config, 'alpha', editor.version, [{ ...editor.blocks[0], text: editor.blocks[0].text.replace('Host alpha shared', 'Host renamed shared') }]);
  assert.equal(plan.alias, 'renamed'); await validatePlan(plan, '/usr/bin/ssh', validate);
  const rollback = commitPlan(plan, backup);
  assert.deepEqual(readAliases(config), ['renamed', 'shared']);
  rollback(); assert.deepEqual(readAliases(config), ['alpha', 'shared']);
});

test('runtime config gives the jump and destination the same host-key policy without losing forwarding', async t => {
  const { dir, config } = fixture(t, 'Host destination\n HostName 127.0.0.1\n User demo\n Port 2222\n ProxyJump jump\n LocalForward 127.0.0.1:12567 127.0.0.1:80\nHost jump\n HostName 127.0.0.2\n User relay\n Port 2233\n UserKnownHostsFile /tmp/other-hosts\n StrictHostKeyChecking ask\n');
  const knownHosts = path.join(dir, 'shared hosts');
  const runtimeDir = path.join(dir, 'runtime'); fs.mkdirSync(runtimeDir);
  const runtime = writeRuntimeConfig({ source: 'config' }, { sshConfig: config, knownHosts }, runtimeDir);
  const resolved = await resolveAlias('destination', runtime);
  assert.equal(resolved.port, 2222); assert.equal(resolved.proxyJump, 'jump');
  const jump = await resolveAlias('jump', runtime);
  assert.equal(jump.port, 2233); assert.equal(jump.username, 'relay');
  for (const alias of ['destination', 'jump']) {
    const output = execFileSync('/usr/bin/ssh', ['-G', '-F', runtime, '--', alias], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    assert.ok(output.includes(`userknownhostsfile ${knownHosts}\n`));
    assert.ok(output.includes('stricthostkeychecking accept-new\n'));
    if (alias === 'destination') assert.match(output, /^localforward \[?127\.0\.0\.1\]?:12567 \[?127\.0\.0\.1\]?:80$/m);
  }
});
