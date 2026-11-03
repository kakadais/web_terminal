const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const isolate = path.resolve(__dirname, '../scripts/deploy-isolated.sh');
const preflight = path.resolve(__dirname, '../scripts/check-pm2-startup.sh');

for (const fail of [false, true]) test(`deployment snapshot preserves live development files (${fail ? 'failure' : 'success'})`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-deploy-test-'));
  try {
    const source = path.join(root, 'project'), stages = path.join(root, 'stages'), report = path.join(root, 'report.json');
    fs.mkdirSync(source); fs.mkdirSync(stages);
    for (const folder of ['node_modules', '.meteor/local', '.deploy']) {
      fs.mkdirSync(path.join(source, folder), { recursive: true });
      fs.writeFileSync(path.join(source, folder, 'live-state'), 'keep');
    }
    fs.writeFileSync(path.join(source, '.env.local'), 'fixture configuration\n');
    fs.writeFileSync(path.join(source, 'deploy.sh'), `#!/bin/bash
set -euo pipefail
[[ "$WEB_TERMINAL_DEPLOY_ISOLATED" == 1 ]]
[[ ! -e node_modules && ! -e .meteor/local && ! -e .deploy ]]
"$DEPLOY_TEST_NODE" -e 'const fs=require("fs");fs.writeFileSync(process.env.DEPLOY_TEST_REPORT,JSON.stringify({cwd:process.cwd(),mode:fs.statSync(".env.local").mode & 511,config:fs.readFileSync(".env.local","utf8")}))'
mkdir -p node_modules
printf 'staged' > node_modules/installed
exit ${fail ? 7 : 0}
`);
    const result = spawnSync('bash', [isolate, source], { encoding: 'utf8', env: { ...process.env,
      TMPDIR: stages, DEPLOY_TEST_NODE: process.execPath, DEPLOY_TEST_REPORT: report } });
    assert.equal(result.status, fail ? 7 : 0, result.stderr);
    const data = JSON.parse(fs.readFileSync(report));
    assert.notEqual(data.cwd, source);
    assert.equal(data.mode, 0o600);
    assert.equal(data.config, 'fixture configuration\n');
    assert.equal(fs.existsSync(path.join(data.cwd, '.env.local')), false);
    assert.equal(fs.existsSync(data.cwd), fail);
    for (const folder of ['node_modules', '.meteor/local', '.deploy']) assert.equal(fs.readFileSync(path.join(source, folder, 'live-state'), 'utf8'), 'keep');
    assert.equal(fs.existsSync(path.join(source, 'node_modules/installed')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('startup preflight rejects missing executables, disabled units and failed units', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-pm2-test-'));
  try {
    const executable = path.join(root, 'pm2');
    fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(path.join(root, 'systemctl'), `#!/bin/sh
case "$*" in
  *LoadState*) printf 'loaded\\n';;
  *ExecStart*) printf '{ path=%s ; argv[]=pm2 resurrect ; }\\n' "$DEPLOY_TEST_EXECUTABLE";;
  is-enabled*) test "$DEPLOY_TEST_MODE" != disabled;;
  is-active*) test "$DEPLOY_TEST_MODE" != failed;;
  *) exit 1;;
esac
`, { mode: 0o755 });
    for (const mode of ['healthy', 'missing', 'disabled', 'failed']) {
      const result = spawnSync('bash', [preflight, 'pm2-fixture.service'], { encoding: 'utf8', env: { ...process.env,
        PATH: root + path.delimiter + process.env.PATH, DEPLOY_TEST_MODE: mode,
        DEPLOY_TEST_EXECUTABLE: mode === 'missing' ? path.join(root, 'removed/pm2') : executable } });
      assert.equal(result.status === 0, mode === 'healthy', result.stderr);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
