import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config({ path: process.env.ENV_FILE || path.resolve('.env.local'), quiet: true });

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} must be configured in .env.local`);
  return value;
}

export const config = {
  adminUsername: required('ADMIN_USERNAME'),
  adminPassword: required('ADMIN_PASSWORD'),
  encryptionKey: required('CREDENTIAL_ENCRYPTION_KEY'),
  sshConfig: path.resolve((process.env.SSH_CONFIG_PATH || '~/.ssh/config').replace(/^~(?=\/|$)/, os.homedir())),
  knownHosts: path.resolve((process.env.SSH_KNOWN_HOSTS_PATH || '~/.ssh/known_hosts').replace(/^~(?=\/|$)/, os.homedir())),
  sshCommand: process.env.SSH_COMMAND || '/usr/bin/ssh',
  sshConfigBackup: path.resolve((process.env.SSH_CONFIG_BACKUP_DIR || '~/deploy/web_terminal/shared/ssh-config-backups').replace(/^~(?=\/|$)/, os.homedir())),
  localServerName: process.env.DEPLOY_SERVER_NAME?.trim() || 'server',
  rootUrl: required('ROOT_URL'),
  maxSessions: Number(process.env.TERMINAL_MAX_SESSIONS || 12),
  ticketSeconds: Number(process.env.TERMINAL_TICKET_SECONDS || 30),
  idleMinutes: Number(process.env.TERMINAL_IDLE_MINUTES || 60),
};
if (!/^[a-f0-9]{64}$/i.test(config.encryptionKey)) {
  throw new Error('CREDENTIAL_ENCRYPTION_KEY must contain 64 hexadecimal characters');
}
for (const name of ['maxSessions', 'ticketSeconds', 'idleMinutes']) {
  if (!Number.isInteger(config[name]) || config[name] < 1) throw new Error(`Invalid ${name}`);
}
