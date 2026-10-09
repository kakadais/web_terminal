import { Meteor } from 'meteor/meteor';
import { check, Match } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { Servers, ConnectionHistory } from '../imports/api/collections';
import { config } from './config';
import { encrypt } from '../lib/credentials.cjs';
import { readAliases, resolveAlias } from '../lib/ssh-config.cjs';
import { validateServer } from '../lib/server-input.cjs';

const publicFields = {
  ownerId: 1, name: 1, host: 1, port: 1, username: 1, source: 1, authType: 1,
  sshAlias: 1, proxyJump: 1, identityFile: 1, configAvailable: 1,
  hasPassword: 1, hasPrivateKey: 1, hasPassphrase: 1, createdAt: 1, updatedAt: 1,
  lastConnectedAt: 1, lastSyncedAt: 1,
};
const syncing = new Set();

export function requireUser(context) {
  if (!context.userId) throw new Meteor.Error('unauthorized', '로그인이 필요합니다.');
  return context.userId;
}

export async function syncServers(ownerId) {
  if (syncing.has(ownerId)) throw new Meteor.Error('busy', '동기화가 진행 중입니다.');
  syncing.add(ownerId);
  try {
    const aliases = readAliases(config.sshConfig);
    const imported = [];
    const skipped = [];
    for (const alias of aliases) {
      try {
        const resolved = await resolveAlias(alias, config.sshConfig, config.sshCommand);
        validateServer({ ...resolved, name: alias, authType: 'config' });
        const now = new Date();
        const existing = await Servers.findOneAsync({ ownerId, source: 'config', sshAlias: alias });
        const fields = { host: resolved.host, port: resolved.port, proxyJump: resolved.proxyJump,
          identityFile: resolved.identityFile, configAvailable: true, lastSyncedAt: now, updatedAt: now };
        if (!existing || existing.authType === 'config') fields.username = resolved.username;
        if (existing) {
          await Servers.updateAsync(existing._id, { $set: fields });
        } else {
          await Servers.insertAsync({ ...fields, ownerId, name: alias, sshAlias: alias,
            username: resolved.username, source: 'config', authType: 'config', createdAt: now,
            hasPassword: false, hasPrivateKey: false, hasPassphrase: false });
        }
        imported.push(alias);
      } catch (_) {
        // Report only aliases; OpenSSH error text may contain sensitive config comments.
        skipped.push(alias);
      }
    }
    await Servers.updateAsync({ ownerId, source: 'config', sshAlias: { $nin: imported } },
      { $set: { configAvailable: false, updatedAt: new Date() } }, { multi: true });
    return { imported: imported.length, skipped, total: aliases.length };
  } catch (error) {
    if (error instanceof Meteor.Error) throw error;
    throw new Meteor.Error('sync-failed', 'SSH config를 읽지 못했습니다. 서버의 SSH_CONFIG_PATH와 파일 권한을 확인해 주세요.');
  } finally {
    syncing.delete(ownerId);
  }
}

Meteor.publish('servers', function () {
  if (!this.userId) return this.ready();
  return Servers.find({ ownerId: this.userId }, { fields: publicFields, sort: { name: 1 } });
});
Meteor.publish('connectionHistory', function () {
  if (!this.userId) return this.ready();
  return ConnectionHistory.find({ ownerId: this.userId }, { sort: { startedAt: -1 }, limit: 30,
    fields: { serverId: 1, serverName: 1, startedAt: 1, endedAt: 1, status: 1, exitCode: 1 } });
});

Meteor.methods({
  async 'servers.sync'() {
    return syncServers(requireUser(this));
  },
  async 'servers.save'(input) {
    const ownerId = requireUser(this);
    check(input, Object);
    check(input._id, Match.Maybe(String));
    let values;
    try { values = validateServer(input); } catch (error) {
      throw new Meteor.Error('invalid-server', error.message);
    }
    const existing = input._id ? await Servers.findOneAsync({ _id: input._id, ownerId }) : null;
    if (input._id && !existing) throw new Meteor.Error('not-found', '서버를 찾을 수 없습니다.');
    if (values.authType === 'config' && existing?.source !== 'config') {
      throw new Meteor.Error('invalid-server', '직접 추가한 서버는 비밀번호 또는 SSH 키를 등록해 주세요.');
    }
    const credentials = { ...(existing?.credentials || {}) };
    const { password, privateKey, passphrase, ...fields } = values;
    if (password) credentials.password = encrypt(password, config.encryptionKey);
    if (privateKey) credentials.privateKey = encrypt(privateKey, config.encryptionKey);
    if (passphrase || input.clearPassphrase) credentials.passphrase = encrypt(passphrase, config.encryptionKey);
    if (values.authType === 'password' && !credentials.password) throw new Meteor.Error('invalid-server', 'SSH 비밀번호를 입력해 주세요.');
    if (values.authType === 'key' && !credentials.privateKey) throw new Meteor.Error('invalid-server', 'SSH 개인 키를 등록해 주세요.');
    fields.updatedAt = new Date();
    fields.hasPassword = Boolean(credentials.password);
    fields.hasPrivateKey = Boolean(credentials.privateKey);
    fields.hasPassphrase = Boolean(credentials.passphrase);
    // Switching authentication removes credentials that are no longer needed.
    if (values.authType !== 'password') { delete credentials.password; fields.hasPassword = false; }
    if (values.authType !== 'key') { delete credentials.privateKey; delete credentials.passphrase; fields.hasPrivateKey = false; fields.hasPassphrase = false; }
    if (existing) {
      if (existing.source === 'config') {
        fields.host = existing.host;
        fields.port = existing.port;
      }
      await Servers.updateAsync({ _id: existing._id, ownerId }, { $set: { ...fields, credentials } });
      return existing._id;
    }
    return Servers.insertAsync({ ...fields, credentials, ownerId, source: 'manual', createdAt: new Date(), configAvailable: true });
  },
  async 'servers.remove'(serverId) {
    const ownerId = requireUser(this);
    check(serverId, String);
    await Servers.removeAsync({ _id: serverId, ownerId });
    return true;
  },
});

DDPRateLimiter.addRule({ name: name => name.startsWith('servers.') || name.startsWith('terminal.'),
  type: 'method', connectionId: () => true }, 30, 60_000);
DDPRateLimiter.addRule({ name: 'login', type: 'method', clientAddress: () => true }, 10, 60_000);
DDPRateLimiter.addRule({ name: 'changePassword', type: 'method', connectionId: () => true }, 5, 60_000);
