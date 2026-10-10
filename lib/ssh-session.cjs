const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('./pty.js');
const { decrypt } = require('./credentials.cjs');
const { terminalEnv } = require('./terminal-env.cjs');

function writeRuntimeConfig(server, config, tempDir) {
  if (server.source !== 'config') return '/dev/null';
  const quote = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const runtime = path.join(tempDir, 'config');
  // OpenSSH's ProxyJump child inherits -F, but not destination -o options.
  // A small Include wrapper applies the same host-key policy to every hop.
  fs.writeFileSync(runtime, `StrictHostKeyChecking accept-new\nUserKnownHostsFile ${quote(config.knownHosts)}\nControlMaster no\nControlPath none\nPermitLocalCommand no\nInclude ${quote(config.sshConfig)}\n`, { mode: 0o600 });
  return runtime;
}

function startSsh(server, config, dimensions = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-'));
  fs.chmodSync(tempDir, 0o700);
  try {
    const args = ['-tt', '-F', writeRuntimeConfig(server, config, tempDir),
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${config.knownHosts}`,
      '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'EscapeChar=none', '-o', 'PermitLocalCommand=no', '-o', 'NumberOfPasswordPrompts=1',
      '-p', String(server.port), '-l', server.username];
    const env = terminalEnv();
    const askpass = path.join(tempDir, 'askpass');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *passphrase*) printf "%s\\n" "$WEB_TERMINAL_KEY_PASSPHRASE" ;;\n  *) printf "%s\\n" "$WEB_TERMINAL_SSH_PASSWORD" ;;\nesac\n', { mode: 0o700 });
    env.SSH_ASKPASS = askpass;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = env.DISPLAY || ':web-terminal';
    if (server.authType === 'password') {
      env.WEB_TERMINAL_SSH_PASSWORD = decrypt(server.credentials?.password, config.encryptionKey);
      args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no');
    } else if (server.authType === 'key') {
      if (server.credentials?.privateKey) {
        const keyFile = path.join(tempDir, 'identity');
        fs.writeFileSync(keyFile, decrypt(server.credentials.privateKey, config.encryptionKey), { mode: 0o600 });
        args.push('-i', keyFile);
      }
      env.WEB_TERMINAL_KEY_PASSPHRASE = decrypt(server.credentials?.passphrase, config.encryptionKey);
      args.push('-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no');
    } else {
      // Imported configs can use their existing keys/agent, without hanging on a password prompt.
      args.push('-o', 'BatchMode=yes');
    }
    args.push('--', server.source === 'config' ? server.sshAlias : server.host);
    const terminal = spawn(config.sshCommand, args, {
      name: 'xterm-256color', cols: dimensions.cols || 100, rows: dimensions.rows || 30,
      cwd: os.homedir(), env,
    });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      fs.rmSync(tempDir, { recursive: true, force: true });
    };
    terminal.onExit(cleanup);
    return { terminal, cleanup, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { startSsh, writeRuntimeConfig };
