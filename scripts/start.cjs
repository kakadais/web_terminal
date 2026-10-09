const { spawn } = require('node:child_process');
const path = require('node:path');
const dotenv = require('dotenv');

const root = path.resolve(__dirname, '..');
const envFile = process.env.ENV_FILE || path.join(root, '.env.local');
const result = dotenv.config({ path: envFile, quiet: true });
if (result.error) throw result.error;
const development = process.argv.includes('--dev');
const env = { ...process.env };
if (development) {
  // Use Meteor's separate local MongoDB; never write development data to production.
  delete env.MONGO_URL;
  delete env.MONGO_OPLOG_URL;
  env.PORT = env.DEV_PORT || '5160';
  env.BIND_IP = '127.0.0.1';
  env.ROOT_URL = `http://127.0.0.1:${env.PORT}`;
  env.HTTP_FORWARDED_COUNT = '0';
  env.SSH_KNOWN_HOSTS_PATH = path.join(root, '.meteor/local/known_hosts');
}
const child = spawn('meteor', ['run', '--port', env.PORT || '5160'], {
  cwd: root, env, stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', code => process.exit(code ?? 1));
