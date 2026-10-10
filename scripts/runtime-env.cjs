const fs = require('node:fs');
const dotenv = require('dotenv');
const [input, output] = process.argv.slice(2);
const env = dotenv.parse(fs.readFileSync(input));
for (const name of ['MONGO_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'CREDENTIAL_ENCRYPTION_KEY']) {
  if (!env[name]?.trim()) throw new Error(`${name} is required in .env.local`);
}
if (!/^[a-f0-9]{64}$/i.test(env.CREDENTIAL_ENCRYPTION_KEY)) throw new Error('Invalid credential encryption key');
if (!/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URL)) throw new Error('Invalid MONGO_URL');
const allowed = ['MONGO_URL', 'MONGO_OPLOG_URL', 'ADMIN_USERNAME', 'ADMIN_PASSWORD', 'CREDENTIAL_ENCRYPTION_KEY',
  'SSH_CONFIG_PATH', 'SSH_KNOWN_HOSTS_PATH', 'SSH_COMMAND', 'SSH_CONFIG_BACKUP_DIR', 'DEPLOY_SERVER_NAME',
  'TERMINAL_MAX_SESSIONS', 'TERMINAL_TICKET_SECONDS', 'TERMINAL_IDLE_MINUTES',
  'UPLOAD_MAX_MB', 'UPLOAD_TIMEOUT_SECONDS', 'UPLOAD_MAX_CONCURRENT'];
const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const content = allowed.filter(name => env[name] !== undefined).map(name => `export ${name}=${quote(env[name])}`).join('\n') + '\n';
if (output) fs.writeFileSync(output, content, { mode: 0o600 });
else console.log('Runtime configuration validated.');
