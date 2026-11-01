'use strict';

const { spawn: spawnProcess, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { nativePath } = require('./native-runtime.cjs');
const run = promisify(execFile);
const MAX_PENDING_INPUT = 1024 * 1024;

function failure(code) {
  const error = new Error(`Terminal backend: ${code}`);
  error.code = code;
  return error;
}

function spawn(file, args, options) {
  const child = spawnProcess(nativePath(), [], {
    // Never inherit application credentials into the helper or the terminal.
    env: options.env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const dataListeners = new Set();
  const exitListeners = new Set();
  let control = '';
  let exitStatus;
  let closed = false;
  let stopping = false;
  let ready = false;
  let forceTimer;
  let resolveReady; let rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  readyPromise.catch(() => {});
  const startupTimer = setTimeout(() => fail('startup-timeout'), 10_000);
  startupTimer.unref();

  function kill() {
    if (closed || stopping) return;
    stopping = true;
    clearTimeout(startupTimer);
    rejectReady(failure('terminal-closed'));
    child.kill('SIGTERM');
    forceTimer = setTimeout(() => child.kill('SIGKILL'), 3500);
    forceTimer.unref();
  }
  function fail(code) { rejectReady(failure(code)); kill(); }
  function send(message) {
    if (closed || stopping || child.stdin.destroyed) throw failure('terminal-closed');
    const frame = JSON.stringify(message) + '\n';
    if (Buffer.byteLength(frame) > 256 * 1024 || child.stdin.writableLength + Buffer.byteLength(frame) > MAX_PENDING_INPUT) {
      fail('input-overflow');
      throw failure('input-overflow');
    }
    child.stdin.write(frame);
  }
  function listen(listeners, callback) {
    listeners.add(callback);
    return { dispose: () => listeners.delete(callback) };
  }
  const terminal = {
    pid: undefined,
    helperPid: child.pid,
    ready: readyPromise,
    write(data) {
      if (typeof data !== 'string' || Buffer.byteLength(data) > 128 * 1024) throw failure('input-size');
      send({ type: 'write', data });
    },
    resize(cols, rows) { send({ type: 'resize', cols, rows }); },
    kill,
    onData(callback) { return listen(dataListeners, callback); },
    onExit(callback) {
      if (closed) queueMicrotask(() => callback(exitStatus));
      return listen(exitListeners, callback);
    },
  };
  // Node's streaming decoder preserves UTF-8 characters split across PTY reads.
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => { for (const callback of dataListeners) callback(data); });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', data => {
    control += data;
    if (control.length > 16 * 1024) { fail('status-overflow'); return; }
    let newline;
    while ((newline = control.indexOf('\n')) !== -1) {
      const line = control.slice(0, newline); control = control.slice(newline + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready' && !ready && !stopping && message.protocol === 1 && Number.isInteger(message.pid) && message.pid > 0) {
          ready = true; terminal.pid = message.pid; clearTimeout(startupTimer); resolveReady(terminal);
        } else if (message.type === 'exit' && Number.isInteger(message.exitCode)) {
          exitStatus = { exitCode: message.exitCode };
        } else if (message.type === 'error') fail('backend-error');
        else fail('invalid-status');
      } catch (_) { fail('invalid-status'); }
    }
  });
  child.stdin.on('error', () => fail('control-closed'));
  child.on('error', error => fail(error.code || 'backend-start'));
  // 'close' follows stdout EOF; consumers receive all trailing output first.
  child.on('close', (code, signal) => {
    closed = true;
    clearTimeout(startupTimer); clearTimeout(forceTimer);
    rejectReady(failure('backend-closed'));
    exitStatus ||= { exitCode: code ?? 1, signal };
    for (const callback of exitListeners) callback(exitStatus);
    dataListeners.clear(); exitListeners.clear();
  });
  try {
    send({ type: 'spawn', protocol: 1, file, args, cwd: options.cwd, cols: options.cols, rows: options.rows });
  } catch (error) { kill(); throw error; }
  return terminal;
}

async function getProcessCwd(pid, signal) {
  if (!Number.isInteger(pid) || pid < 1 || pid > 2147483647) throw failure('invalid-pid');
  const { stdout } = await run(nativePath(), ['cwd', String(pid)], {
    timeout: 5000, maxBuffer: 16 * 1024, signal, env: { PATH: process.env.PATH },
  });
  const { cwd } = JSON.parse(stdout);
  if (typeof cwd !== 'string') throw failure('cwd-unavailable');
  return cwd;
}

module.exports = { spawn, getProcessCwd };
