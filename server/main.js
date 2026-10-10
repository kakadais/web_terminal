import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { WebApp } from 'meteor/webapp';
import fs from 'node:fs';
import path from 'node:path';
import { Servers, ConnectionHistory } from '../imports/api/collections';
import { config } from './config';
import { syncServers, ensureLocalServer } from './servers';
import './terminal';

Accounts.config({ forbidClientAccountCreation: true, loginExpirationInDays: 1 });
Accounts.validateLoginAttempt(attempt => {
  if (!attempt.allowed) throw new Meteor.Error('login-failed', '아이디 또는 비밀번호를 확인해 주세요.');
  return true;
});

WebApp.handlers.use('/health', async (request, response) => {
  if (request.method !== 'GET' || request.url !== '/') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  try {
    await Servers.rawDatabase().command({ ping: 1 });
    response.writeHead(200);
    response.end(JSON.stringify({ status: 'ok', service: 'web_terminal' }));
  } catch (_) {
    response.writeHead(503);
    response.end(JSON.stringify({ status: 'unavailable' }));
  }
});

Meteor.startup(async () => {
  fs.mkdirSync(path.dirname(config.knownHosts), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(config.knownHosts)) fs.writeFileSync(config.knownHosts, '', { mode: 0o600 });
  await Servers.rawCollection().createIndex({ ownerId: 1, source: 1, sshAlias: 1 },
    { unique: true, partialFilterExpression: { source: 'config' } });
  await Servers.rawCollection().createIndex({ ownerId: 1, name: 1 });
  await ConnectionHistory.rawCollection().createIndex({ startedAt: 1 }, { expireAfterSeconds: 30 * 86400 });
  await ConnectionHistory.rawCollection().createIndex({ ownerId: 1, startedAt: -1 });
  await ConnectionHistory.updateAsync({ status: 'open' }, { $set: { status: 'closed', endedAt: new Date() } }, { multi: true });
  let admin = await Accounts.findUserByUsername(config.adminUsername);
  if (!admin) {
    const id = await Accounts.createUserAsync({ username: config.adminUsername, password: config.adminPassword });
    admin = await Meteor.users.findOneAsync(id);
    console.log('[startup] Initial administrator created');
  }
  // Bootstrap once. Restarts and deployments do not reset an existing password.
  await ensureLocalServer(admin._id);
  if (!(await Servers.findOneAsync({ ownerId: admin._id, source: 'config' }))) {
    try {
      const result = await syncServers(admin._id);
      console.log(`[startup] SSH config imported: ${result.imported}/${result.total}`);
    } catch (_) { console.error('[startup] SSH config import failed; use Sync after checking SSH_CONFIG_PATH'); }
  }
  console.log('[startup] Web Terminal ready');
});
