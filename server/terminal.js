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
import { createPidTracker } from '../lib/terminal-tracking.cjs';
import { UploadError, validateFile, resolveDirectory, storeUpload } from '../lib/file-upload.cjs';

const tickets = new Map();
const sessions = new Map();
const connections = new Map();
const uploadGrants = new Map();
const server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
const origin = new URL(config.rootUrl).origin;

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function closeConnection(connectionId) {
  connections.delete(connectionId);
  for (const [ticket, value] of tickets) if (value.connectionId === connectionId) tickets.delete(ticket);
  for (const session of sessions.values()) {
    if (session.connectionId === connectionId) { cancelUploads(session); session.socket.close(1000, 'Logged out'); }
  }
}
function clamp(value, min, max, fallback) {
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}
function ownedSession(context, sessionId) {
  const ownerId = requireUser(context);
  const session = sessions.get(sessionId);
  if (!session || session.ownerId !== ownerId || session.connectionId !== context.connection.id
    || connections.get(session.connectionId) !== ownerId || session.socket.readyState !== WebSocket.OPEN) {
    throw new Meteor.Error('session-closed', '파일을 저장할 터미널을 먼저 연결해 주세요.');
  }
  return session;
}
function cancelUploads(session) {
  for (const [token, grant] of uploadGrants) if (grant.sessionId === session.id) uploadGrants.delete(token);
  for (const controller of session.uploads) controller.abort();
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
  'terminal.upload.cancel'(sessionId) {
    check(sessionId, String);
    cancelUploads(ownedSession(this, sessionId));
    return true;
  },
  async 'terminal.upload.prepare'(sessionId, files, directory = '') {
    requireUser(this); check(sessionId, String); check(files, [{ name: String, size: Number }]); check(directory, String);
    if (!files.length || files.length > 100) throw new Meteor.Error('upload-count', '한 번에 최대 100개 파일을 전송해 주세요.');
    const session = ownedSession(this, sessionId);
    const pending = [...uploadGrants.values()].filter(grant => grant.ownerId === session.ownerId && grant.expires > Date.now()).length;
    if (pending + files.length > 100) throw new Meteor.Error('upload-count', '대기 중인 업로드를 마친 뒤 다시 전송해 주세요.');
    const controller = new AbortController(); session.uploads.add(controller);
    try {
      const targetDirectory = await resolveDirectory(session, config, directory, controller.signal);
      controller.signal.throwIfAborted();
      ownedSession(this, sessionId);
      const remaining = [...uploadGrants.values()].filter(grant => grant.ownerId === session.ownerId && grant.expires > Date.now()).length;
      if (remaining + files.length > 100) throw new Meteor.Error('upload-count', '대기 중인 업로드를 마친 뒤 다시 전송해 주세요.');
      const expires = Date.now() + config.uploadTimeoutSeconds * 1000;
      const items = files.map(file => {
        try {
          const metadata = validateFile(file, config.uploadMaxBytes);
          const token = crypto.randomBytes(32).toString('base64url');
          uploadGrants.set(token, { ...metadata, ownerId: session.ownerId, sessionId, directory: targetDirectory, expires });
          return { ...metadata, token, expires };
        } catch (error) { return { name: file.name, size: file.size, error: error.message }; }
      });
      session.lastInput = Date.now();
      return { directory: targetDirectory, endpoint: '/terminal/upload', items };
    } catch (error) {
      if (error instanceof Meteor.Error) throw error;
      throw new Meteor.Error(error instanceof UploadError ? error.code : 'cwd-unavailable',
        error instanceof UploadError ? error.message : '작업 경로를 확인하지 못했습니다. 저장 경로를 직접 입력하거나 SSH 접속 정보를 확인해 주세요.');
    } finally { session.uploads.delete(controller); }
  },
});
Accounts.onLogout(({ connection }) => { if (connection) closeConnection(connection.id); });

WebApp.rawHandlers.use('/terminal/upload', async (request, response) => {
  const reply = (status, body) => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  if (request.url !== '/' || request.method !== 'POST') { request.resume(); reply(405, { error: 'POST 요청만 사용할 수 있습니다.' }); return; }
  if (request.headers.origin !== origin) { request.resume(); reply(403, { error: '요청 출처를 확인할 수 없습니다.' }); return; }
  const token = request.headers['x-upload-ticket'];
  const grant = typeof token === 'string' ? uploadGrants.get(token) : null;
  if (!grant || grant.expires < Date.now()) { request.resume(); reply(401, { error: '업로드 접속권이 만료되었거나 올바르지 않습니다.' }); return; }
  uploadGrants.delete(token);
  const session = sessions.get(grant.sessionId);
  if (!session || session.ownerId !== grant.ownerId || connections.get(session.connectionId) !== grant.ownerId || session.socket.readyState !== WebSocket.OPEN) {
    request.resume(); reply(409, { error: '터미널 연결이 종료되었습니다.' }); return;
  }
  const active = [...sessions.values()].filter(item => item.ownerId === grant.ownerId).reduce((total, item) => total + item.uploads.size, 0);
  if (active >= config.uploadConcurrency) { request.resume(); reply(429, { error: '다른 파일 전송을 마친 뒤 다시 시도해 주세요.' }); return; }
  if (request.headers['content-length'] !== undefined && Number(request.headers['content-length']) !== grant.size) {
    request.resume(); reply(400, { error: '파일 크기가 등록된 정보와 다릅니다.' }); return;
  }
  const controller = new AbortController(); session.uploads.add(controller);
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', () => { if (!response.writableFinished) abort(); });
  const timer = setTimeout(abort, config.uploadTimeoutSeconds * 1000);
  try {
    const result = await storeUpload(request, session, config, grant.directory, grant, controller.signal, () => { session.lastInput = Date.now(); });
    reply(201, result);
  } catch (error) {
    reply(error instanceof UploadError ? error.status : 500, { error: error instanceof UploadError ? error.message
      : controller.signal.aborted ? '전송이 취소되었거나 터미널 연결이 종료되었습니다.' : '파일을 저장하지 못했습니다. 저장 경로와 쓰기 권한을 확인해 주세요.' });
  } finally { clearTimeout(timer); request.removeListener('aborted', abort); session.uploads.delete(controller); }
});

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
    cancelUploads(session);
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
        const trackingToken = crypto.randomBytes(16).toString('hex');
        const { terminal, cleanup } = (record.source === 'local' ? startLocal : startSsh)(target, config, {
          cols: clamp(message.cols, 20, 400, 100), rows: clamp(message.rows, 5, 200, 30),
          trackingToken,
        });
        const id = crypto.randomUUID();
        session = { id, ...grant, socket, terminal, cleanup, target, uploads: new Set(), lastInput: Date.now(), alive: true };
        sessions.set(id, session);
        clearTimeout(authenticationTimer);
        session.historyPromise = ConnectionHistory.insertAsync({ _id: id, ownerId: grant.ownerId, serverId: record._id,
          serverName: record.name, status: 'open', startedAt: new Date() });
        const tracker = createPidTracker(trackingToken, pid => { session.remotePid = pid; });
        terminal.onData(raw => {
          const data = tracker.push(raw);
          if (!data) return;
          if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(1009, 'Output overflow'); return; }
          send(socket, { type: 'output', data });
        });
        terminal.onExit(({ exitCode }) => {
          const remaining = tracker.flush(); if (remaining) send(socket, { type: 'output', data: remaining });
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
  for (const [token, grant] of uploadGrants) if (grant.expires < now) uploadGrants.delete(token);
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
      cancelUploads(session);
      try { session.terminal.kill(); } catch (_) {}
      session.cleanup();
      session.socket.terminate();
    }
    setTimeout(() => process.exit(0), 250);
  });
}
