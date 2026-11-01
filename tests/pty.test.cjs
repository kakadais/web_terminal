const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

test('macOS PTY helper resolves real npm files under Meteor instead of virtual module paths', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-pty-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const server = path.join(dir, 'programs', 'server');
  const installed = path.join(dir, 'installed node-pty');
  const modules = path.join(server, 'npm', 'node_modules');
  fs.mkdirSync(modules, { recursive: true });
  fs.mkdirSync(path.join(installed, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(installed, 'prebuilds', 'darwin-arm64'), { recursive: true });
  fs.symlinkSync(installed, path.join(modules, 'node-pty'));
  fs.writeFileSync(path.join(installed, 'package.json'), JSON.stringify({ main: 'lib/index.js' }));
  fs.writeFileSync(path.join(installed, 'lib', 'index.js'), 'module.exports = {};');
  fs.writeFileSync(path.join(installed, 'lib', 'utils.js'),
    'exports.loadNativeModule = () => ({ dir: "../prebuilds/darwin-arm64/" });');
  const helper = path.join(installed, 'prebuilds', 'darwin-arm64', 'spawn-helper');
  fs.writeFileSync(helper, '', { mode: 0o600 });
  const calls = [];
  const bundledRequire = id => {
    if (id === 'node-pty') return { spawn: (...args) => { calls.push(args); return 'terminal'; } };
    if (['fs', 'path', 'node:module'].includes(id)) return require(id);
    throw new Error(`Cannot find module ${id}`);
  };
  bundledRequire.resolve = () => '/node_modules/node-pty/lib/index.js';
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/pty.js'), 'utf8'), {
    require: bundledRequire, module, __dirname: '/lib',
    process: { platform: 'darwin', cwd: () => server },
  });
  const options = { cols: 100, rows: 30 };
  assert.equal(module.exports.spawn('/bin/sh', ['-l'], options), 'terminal');
  assert.deepEqual(calls, [['/bin/sh', ['-l'], options]]);
  assert.equal(fs.statSync(helper).mode & 0o777, 0o711);
});
