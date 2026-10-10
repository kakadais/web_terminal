const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decrypt } = require('./credentials.cjs');
const { terminalEnv } = require('./terminal-env.cjs');

const quoteConfig = value => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const quoteShell = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

function writeRuntimeConfig(server, config, tempDir) {
  if (server.source !== 'config') return '/dev/null';
  const runtime = path.join(tempDir, 'config');
  // ProxyJump inherits -F, rather than the destination's command-line -o options.
  fs.writeFileSync(runtime, `StrictHostKeyChecking accept-new\nUserKnownHostsFile ${quoteConfig(config.knownHosts)}\nControlMaster no\nControlPath none\nPermitLocalCommand no\nInclude ${quoteConfig(config.sshConfig)}\n`, { mode: 0o600 });
  return runtime;
}

function createSshConnection(server, config, interactive = false) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-'));
  fs.chmodSync(tempDir, 0o700);
  let cleaned = false;
  const cleanup = () => { if (!cleaned) { cleaned = true; fs.rmSync(tempDir, { recursive: true, force: true }); } };
  try {
    const args = [interactive ? '-tt' : '-T', '-F', writeRuntimeConfig(server, config, tempDir),
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${quoteConfig(config.knownHosts)}`,
      '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-o', 'EscapeChar=none',
      '-o', 'PermitLocalCommand=no', '-o', 'NumberOfPasswordPrompts=1',
      '-p', String(server.port), '-l', server.username];
    // Pin the address of the open terminal even if its alias is subsequently edited.
    if (server.source === 'config') args.push('-o', `HostName=${server.host}`);
    if (!interactive) args.push('-o', 'ClearAllForwardings=yes', '-o', 'RemoteCommand=none',
      '-o', 'SessionType=default', '-o', 'StdinNull=no', '-o', 'ForkAfterAuthentication=no');
    const env = terminalEnv();
    const askpass = path.join(tempDir, 'askpass');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *passphrase*) printf "%s\\n" "$WEB_TERMINAL_KEY_PASSPHRASE" ;;\n  *) printf "%s\\n" "$WEB_TERMINAL_SSH_PASSWORD" ;;\nesac\n', { mode: 0o700 });
    env.SSH_ASKPASS = askpass; env.SSH_ASKPASS_REQUIRE = 'force'; env.DISPLAY = env.DISPLAY || ':web-terminal';
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
    } else args.push('-o', 'BatchMode=yes');
    return { args, env, tempDir, cleanup, destination: server.source === 'config' ? server.sshAlias : server.host };
  } catch (error) { cleanup(); throw error; }
}

module.exports = { createSshConnection, writeRuntimeConfig, quoteShell };
