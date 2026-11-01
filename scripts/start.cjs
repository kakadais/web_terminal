const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
const { startEnvironment } = require('./start-env.cjs');
const { buildNative } = require('./build-native.cjs');

const root = path.resolve(__dirname, '..');
const envFile = process.env.ENV_FILE || path.join(root, '.env.local');
const development = process.argv.includes('--dev');
const env = startEnvironment(dotenv.parse(fs.readFileSync(envFile)), process.env, development);
env.WEB_TERMINAL_PTY_PATH = buildNative(env);
const child = spawn('meteor', ['run', '--port', env.PORT || '5160'], {
  cwd: root, env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 1));
