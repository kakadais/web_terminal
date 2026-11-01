const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
function checkBinary(binary) {
  fs.accessSync(binary, fs.constants.X_OK);
  const info = JSON.parse(execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }));
  if (info.name !== 'web-terminal-pty' || info.protocol !== 1) throw new Error('Incompatible terminal backend');
  return binary;
}

function buildNative(env = process.env) {
  if (env.WEB_TERMINAL_PTY_PATH) return checkBinary(path.resolve(env.WEB_TERMINAL_PTY_PATH.replace(/^~(?=\/|$)/, os.homedir())));
  const candidates = [env.CARGO,
    env.CARGO_HOME && path.join(env.CARGO_HOME, 'bin', 'cargo'), 'cargo',
    path.join(os.homedir(), '.cargo', 'bin', 'cargo')].filter(Boolean);
  const cargo = candidates.find(candidate => spawnSync(candidate, ['--version'], { env, stdio: 'ignore' }).status === 0);
  if (!cargo) throw new Error('Rust/Cargo is required. Install Rust 1.95+ or set CARGO / WEB_TERMINAL_PTY_PATH.');
  const target = path.join(root, '.deploy', 'native-target');
  const result = spawnSync(cargo, ['build', '--release', '--locked', '--manifest-path',
    path.join(root, 'native', 'terminal', 'Cargo.toml'), '--target-dir', target], { cwd: root, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Rust terminal build failed (${result.status ?? result.signal})`);
  const source = path.join(target, 'release', 'web-terminal-pty');
  const binary = path.join(root, '.deploy', 'native', 'bin', 'web-terminal-pty');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  if (!fs.existsSync(binary) || !fs.readFileSync(source).equals(fs.readFileSync(binary))) {
    const temporary = `${binary}.${process.pid}.tmp`;
    try { fs.copyFileSync(source, temporary); fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, binary); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  return checkBinary(binary);
}

if (require.main === module) {
  try { console.log(`Terminal backend: ${buildNative()}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildNative, checkBinary };
