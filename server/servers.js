import os from 'node:os';
import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { Servers, ConnectionHistory } from '../imports/api/collections';
import { config } from './config';
import { encrypt } from '../lib/credentials.cjs';
import { readAliases, resolveAlias } from '../lib/ssh-config.cjs';
import { getEditor, planSave, planRemove, validatePlan, commitPlan } from '../lib/ssh-config-editor.cjs';
import { validateServer } from '../lib/server-input.cjs';

const publicFields = {
  ownerId: 1, name: 1, host: 1, port: 1, username: 1, source: 1, authType: 1, pinned: 1,
  sshAlias: 1, proxyJump: 1, identityFile: 1, configAvailable: 1,
  hasPassword: 1, hasPrivateKey: 1, hasPassphrase: 1, createdAt: 1, updatedAt: 1,
  lastConnectedAt: 1, lastSyncedAt: 1,
};
// The config is shared by all owners. Serialize mutations and imports across users.
let configWork = Promise.resolve();
function withConfigLock(work) {
  const next = configWork.then(work);
  configWork = next.catch(() => {});
  return next;
}
export function requireUser(context) {
  if (!context.userId) throw new Meteor.Error('unauthorized', '로그인이 필요합니다.');
  return context.userId;
}
function configError(error) {
  if (error instanceof Meteor.Error) return error;
  return new Meteor.Error(error.code?.startsWith('config-') || ['invalid-config', 'alias-exists'].includes(error.code) ? error.code : 'config-failed',
    ['config-conflict', 'invalid-config', 'alias-exists'].includes(error.code) ? error.message : 'SSH config를 처리하지 못했습니다. 파일 권한과 백업 경로를 확인해 주세요.');
}
export async function ensureLocalServer(ownerId) {
  const _id = `local-${ownerId}`;
  await Servers.upsertAsync(_id, { $set: { ownerId, name: config.localServerName, host: os.hostname(),
    username: os.userInfo().username, source: 'local', authType: 'local', pinned: true, configAvailable: true,
    updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } });
}
function metadata(resolved) {
  return { host: resolved.host, port: resolved.port, username: resolved.username,
    proxyJump: resolved.proxyJump, identityFile: resolved.identityFile, configAvailable: true };
}
async function importServers(ownerId) {
  await ensureLocalServer(ownerId);
  const aliases = readAliases(config.sshConfig);
  const imported = []; const skipped = [];
  for (const alias of aliases) {
    try {
      const resolved = await resolveAlias(alias, config.sshConfig, config.sshCommand);
      validateServer({ ...resolved, name: alias, authType: 'config' });
      const now = new Date();
      const existing = await Servers.findOneAsync({ ownerId, source: 'config', sshAlias: alias });
      const fields = { ...metadata(resolved), lastSyncedAt: now, updatedAt: now };
      if (existing) await Servers.updateAsync(existing._id, { $set: fields });
      else await Servers.insertAsync({ ...fields, ownerId, name: alias, sshAlias: alias,
        source: 'config', authType: 'config', createdAt: now, hasPassword: false, hasPrivateKey: false, hasPassphrase: false });
      imported.push(alias);
    } catch (_) { skipped.push(alias); }
  }
  const removed = await Servers.removeAsync({ ownerId, source: 'config', sshAlias: { $nin: aliases } });
  await Servers.updateAsync({ ownerId, source: 'config', sshAlias: { $nin: imported } },
    { $set: { configAvailable: false, updatedAt: new Date() } }, { multi: true });
  return { imported: imported.length, removed, skipped, total: aliases.length };
}
export function syncServers(ownerId) {
  return withConfigLock(async () => {
    try { return await importServers(ownerId); } catch (error) { throw configError(error); }
  });
}
function initialBlock(record) {
  if (!record) return undefined;
  const alias = record.sshAlias || record.name.replace(/[^a-zA-Z0-9_.-]/g, '-') || 'new-server';
  return `Host ${alias}\n    HostName ${record.host}\n    User ${record.username}\n    Port ${record.port || 22}\n`;
}
async function editableRecord(ownerId, serverId) {
  const record = serverId ? await Servers.findOneAsync({ _id: serverId, ownerId }) : null;
  if (serverId && !record) throw new Meteor.Error('not-found', '서버를 찾을 수 없습니다.');
  if (record?.source === 'local') throw new Meteor.Error('pinned-server', '배포 서버 항목은 자동으로 관리됩니다.');
  return record;
}

Meteor.publish('servers', function () {
  if (!this.userId) return this.ready();
  return Servers.find({ ownerId: this.userId }, { fields: publicFields, sort: { pinned: -1, name: 1 } });
});
Meteor.publish('connectionHistory', function () {
  if (!this.userId) return this.ready();
  return ConnectionHistory.find({ ownerId: this.userId }, { sort: { startedAt: -1 }, limit: 30,
    fields: { serverId: 1, serverName: 1, startedAt: 1, endedAt: 1, status: 1, exitCode: 1 } });
});

Meteor.methods({
  async 'servers.sync'() { return syncServers(requireUser(this)); },
  async 'servers.editor'(serverId) {
    const ownerId = requireUser(this);
    check(serverId, Match.Maybe(String));
    const record = await editableRecord(ownerId, serverId);
    try { return getEditor(config.sshConfig, record?.source === 'config' ? record.sshAlias : null, initialBlock(record)); }
    catch (error) { throw configError(error); }
  },
  async 'servers.save'(input) {
    const ownerId = requireUser(this);
    check(input, Object); check(input._id, Match.Maybe(String)); check(input.version, String);
    check(input.blocks, [{ id: String, text: String, file: Match.Maybe(String) }]);
    check(input.authType, String); check(input.name, Match.Maybe(String));
    return withConfigLock(async () => {
      const existing = await editableRecord(ownerId, input._id);
      let rollback;
      try {
        const plan = planSave(config.sshConfig, existing?.source === 'config' ? existing.sshAlias : null, input.version, input.blocks);
        const other = await Servers.findOneAsync({ ownerId, source: 'config', sshAlias: plan.alias, _id: { $ne: existing?._id || '' } });
        if (other) throw new Meteor.Error('alias-exists', '같은 SSH 별칭의 서버가 이미 있습니다.');
        const resolved = await validatePlan(plan, config.sshCommand, result => validateServer({ ...result, name: result.alias, authType: 'config' }));
        const values = validateServer({ ...input, ...resolved, name: input.name?.trim() || plan.alias });
        const credentials = { ...(existing?.credentials || {}) };
        if (values.password) credentials.password = encrypt(values.password, config.encryptionKey);
        if (values.privateKey) credentials.privateKey = encrypt(values.privateKey, config.encryptionKey);
        if (values.passphrase) credentials.passphrase = encrypt(values.passphrase, config.encryptionKey);
        if (input.clearPassphrase) delete credentials.passphrase;
        if (values.authType === 'password' && !credentials.password) throw new Meteor.Error('invalid-server', 'SSH 비밀번호를 입력해 주세요.');
        if (values.authType === 'key' && !credentials.privateKey && !resolved.identityFile) throw new Meteor.Error('invalid-server', 'IdentityFile을 설정하거나 개인 키를 등록해 주세요.');
        if (values.authType !== 'password') delete credentials.password;
        if (values.authType !== 'key') { delete credentials.privateKey; delete credentials.passphrase; }
        const now = new Date();
        const fields = { ...metadata(resolved), ownerId, name: values.name, sshAlias: plan.alias, source: 'config', authType: values.authType,
          credentials, hasPassword: Boolean(credentials.password), hasPrivateKey: Boolean(credentials.privateKey),
          hasPassphrase: Boolean(credentials.passphrase), updatedAt: now, lastSyncedAt: now };
        rollback = commitPlan(plan, config.sshConfigBackup);
        const id = existing ? existing._id : await Servers.insertAsync({ ...fields, createdAt: now });
        if (existing) await Servers.updateAsync({ _id: id, ownerId }, { $set: fields });
        rollback = null;
        await importServers(ownerId);
        return id;
      } catch (error) {
        if (rollback) rollback();
        if (error instanceof Meteor.Error) throw error;
        if (!error.code && /서버|호스트|사용자|포트|인증|개인 키|접속/.test(error.message)) throw new Meteor.Error('invalid-server', error.message);
        throw configError(error);
      }
    });
  },
  async 'servers.remove'(serverId, version) {
    const ownerId = requireUser(this); check(serverId, String); check(version, Match.Maybe(String));
    return withConfigLock(async () => {
      const record = await editableRecord(ownerId, serverId);
      let rollback;
      try {
        if (record.source === 'config') {
          const plan = planRemove(config.sshConfig, record.sshAlias, version);
          await validatePlan(plan, config.sshCommand);
          rollback = commitPlan(plan, config.sshConfigBackup);
        }
        await Servers.removeAsync({ _id: serverId, ownerId }); rollback = null;
        await importServers(ownerId);
        return true;
      } catch (error) { if (rollback) rollback(); throw configError(error); }
    });
  },
});

DDPRateLimiter.addRule({ name: name => name.startsWith('servers.') || name.startsWith('terminal.'),
  type: 'method', connectionId: () => true }, 30, 60_000);
DDPRateLimiter.addRule({ name: 'login', type: 'method', clientAddress: () => true }, 10, 60_000);
DDPRateLimiter.addRule({ name: 'changePassword', type: 'method', connectionId: () => true }, 5, 60_000);
