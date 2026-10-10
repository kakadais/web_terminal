import crypto from 'node:crypto';
import { Meteor } from 'meteor/meteor';
import { WebApp } from 'meteor/webapp';
import { Accounts } from 'meteor/accounts-base';
import { check } from 'meteor/check';
import { WebSocketServer, WebSocket } from 'ws';
import { Servers, ConnectionHistory } from '../imports/api/collections';
import { config } from './config';
import { requireUser } from './servers';
import { startSsh } from '../lib/ssh-session.cjs';
import { startLocal } from '../lib/local-session.cjs';
import { readAliases, resolveAlias } from '../lib/ssh-config.cjs';
import { validateServer } from '../lib/server-input.cjs';

const tickets = new Map();
const sessions = new Map();
const connections = new Map();
const server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const origin = new URL(config.rootUrl).origin;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function closeConnection(connectionId) {
  connections.delete(connectionId);
  for (const [ticket, value] of tickets) if (value.connectionId === connectionId) tickets.delete(ticket);
  for (const session of sessions.values()) {
    if (session.connectionId === connectionId) session.socket.close(1000, 'Logged out');
  }
}
function clamp(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

Meteor.methods({
  async 'terminal.open'(serverId) {
    const ownerId = requireUser(this);
    check(serverId, String);
    const record = await Servers.findOneAsync({ _id: serverId, ownerId });
    if (!record) throw new Meteor.Error('not-found', '서버를 찾을 수 없습니다.');
    if (record.source === 'config' && !record.configAvailable) throw new Meteor.Error('config-missing', 'SSH config에 이 서버가 없습니다. 먼저 동기화해 주세요.');
    if ([...sessions.values()].filter(session => session.ownerId === ownerId).length >= config.maxSessions) {
      throw new Meteor.Error('session-limit', `터미널은 최대 ${config.maxSessions}개까지 열 수 있습니다.`);
    }
    const connectionId = this.connection.id;
    if (!connections.has(connectionId)) {
      connections.set(connectionId, ownerId);
      this.connection.onClose(() => closeConnection(connectionId));
    }
    const ticket = crypto.randomBytes(32).toString('base64url');
    tickets.set(ticket, { ownerId, serverId, connectionId, expires: Date.now() + config.ticketSeconds * 1000 });
    return { ticket, path: '/terminal/ws' };
  },
  'terminal.closeAll'() {
    requireUser(this);
    closeConnection(this.connection.id);
    return true;
  },
});
Accounts.onLogout(({ connection }) => { if (connection) closeConnection(connection.id); });

WebApp.httpServer.on('upgrade', (request, socket, head) => {
  if (request.url?.split('?')[0] !== '/terminal/ws') return;
  if (request.headers.origin !== origin) {
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    return;
  }
  server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request));
});

server.on('connection', socket => {
  let session;
  let connecting = false;
  let finished = false;
  const authenticationTimer = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
  const finish = async (exitCode = null) => {
    if (finished) return;
    finished = true;
    clearTimeout(authenticationTimer);
    if (!session) return;
    sessions.delete(session.id);
    try { session.terminal.kill(); } catch (_) {}
    session.cleanup();
    try {
      await session.historyPromise;
      await ConnectionHistory.updateAsync(session.id, { $set: { endedAt: new Date(), status: 'closed', exitCode } });
    } catch (_) { console.error('[terminal] Could not update connection history'); }
  };
  socket.on('error', () => finish());
  socket.on('close', () => finish());
  socket.on('pong', () => { if (session) session.alive = true; });
  socket.on('message', async (raw, isBinary) => {
    try {
      if (isBinary) throw new Error('Invalid message');
      const message = JSON.parse(raw.toString());
      if (!session) {
        if (connecting || message.type !== 'auth' || typeof message.ticket !== 'string') throw new Error('Authentication required');
        connecting = true;
        const grant = tickets.get(message.ticket);
        tickets.delete(message.ticket);
        if (!grant || grant.expires < Date.now() || connections.get(grant.connectionId) !== grant.ownerId) throw new Error('Ticket expired');
        const record = await Servers.findOneAsync({ _id: grant.serverId, ownerId: grant.ownerId });
        if (!record || finished || socket.readyState !== WebSocket.OPEN || connections.get(grant.connectionId) !== grant.ownerId) throw new Error('Session closed');
        if ([...sessions.values()].filter(item => item.ownerId === grant.ownerId).length >= config.maxSessions) throw new Error('Session limit exceeded');
        let target = record;
        if (record.source === 'config') {
          // Use current OpenSSH values, including changes made outside this app.
          if (!readAliases(config.sshConfig).includes(record.sshAlias)) throw new Error('Config missing');
          const resolved = await resolveAlias(record.sshAlias, config.sshConfig, config.sshCommand);
          validateServer({ ...resolved, name: record.name, authType: record.authType });
          target = { ...record, ...resolved };
        }
        if (finished || socket.readyState !== WebSocket.OPEN || connections.get(grant.connectionId) !== grant.ownerId) throw new Error('Session closed');
        if ([...sessions.values()].filter(item => item.ownerId === grant.ownerId).length >= config.maxSessions) throw new Error('Session limit exceeded');
        const { terminal, cleanup } = (record.source === 'local' ? startLocal : startSsh)(target, config, {
          cols: clamp(message.cols, 20, 400, 100), rows: clamp(message.rows, 5, 200, 30),
        });
        const id = crypto.randomUUID();
        session = { id, ...grant, socket, terminal, cleanup, lastInput: Date.now(), alive: true };
        sessions.set(id, session);
        clearTimeout(authenticationTimer);
        session.historyPromise = ConnectionHistory.insertAsync({ _id: id, ownerId: grant.ownerId, serverId: record._id,
          serverName: record.name, status: 'open', startedAt: new Date() });
        terminal.onData(data => {
          if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1009, 'Output overflow'); return; }
          send(socket, { type: 'output', data });
        });
        terminal.onExit(({ exitCode }) => {
          send(socket, { type: 'exit', exitCode });
          finish(exitCode);
          socket.close(1000, 'SSH process exited');
        });
        send(socket, { type: 'ready', sessionId: id });
        await session.historyPromise;
        await Servers.updateAsync(record._id, { $set: { lastConnectedAt: new Date() } });
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string' && message.data.length <= 32 * 1024) {
        session.lastInput = Date.now();
        session.terminal.write(message.data);
      } else if (message.type === 'resize') {
        session.terminal.resize(clamp(message.cols, 20, 400, 100), clamp(message.rows, 5, 200, 30));
      } else if (message.type === 'close') socket.close(1000, 'User disconnected');
    } catch (_) {
      send(socket, { type: 'error', message: session ? '터미널 처리 중 오류가 발생했습니다.' : '연결을 시작하지 못했습니다. 다시 로그인하거나 서버 접속 정보를 확인해 주세요.' });
      socket.close(1008, 'Session rejected');
    }
  });
});

const housekeeping = setInterval(() => {
  const now = Date.now();
  for (const [ticket, grant] of tickets) if (grant.expires < now) tickets.delete(ticket);
  for (const session of sessions.values()) {
    if (!session.alive || now - session.lastInput > config.idleMinutes * 60_000) {
      send(session.socket, { type: 'error', message: '연결이 끊겼거나 사용하지 않아 터미널이 종료되었습니다.' });
      session.socket.terminate();
    } else {
      session.alive = false;
      session.socket.ping();
    }
  }
}, 20_000);
housekeeping.unref();

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, () => {
    clearInterval(housekeeping);
    for (const session of sessions.values()) {
      try { session.terminal.kill(); } catch (_) {}
      session.cleanup();
      session.socket.terminate();
    }
    setTimeout(() => process.exit(0), 250);
  });
}
