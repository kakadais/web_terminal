const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('./pty.js');
const { decrypt } = require('./credentials.cjs');

function startSsh(server, config, dimensions = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-'));
  fs.chmodSync(tempDir, 0o700);
  try {
    const args = ['-tt', '-F', server.source === 'config' ? config.sshConfig : '/dev/null',
      '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${config.knownHosts}`,
      '-o', 'ConnectTimeout=12', '-o', 'ServerAliveInterval=20', '-o', 'ServerAliveCountMax=3',
      '-o', 'ClearAllForwardings=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
      '-o', 'EscapeChar=none', '-o', 'PermitLocalCommand=no', '-o', 'NumberOfPasswordPrompts=1',
      '-p', String(server.port), '-l', server.username];
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    // SSH child processes should not inherit application or database secrets.
    for (const name of Object.keys(env)) {
      if (/^(ADMIN_|MONGO_|CREDENTIAL_|MAIL_URL|METEOR_SETTINGS|TERM_TOKEN)/.test(name)) delete env[name];
    }
    const askpass = path.join(tempDir, 'askpass');
    fs.writeFileSync(askpass, '#!/bin/sh\ncase "$1" in\n  *passphrase*) printf "%s\\n" "$WEB_TERMINAL_KEY_PASSPHRASE" ;;\n  *) printf "%s\\n" "$WEB_TERMINAL_SSH_PASSWORD" ;;\nesac\n', { mode: 0o700 });
    env.SSH_ASKPASS = askpass;
    env.SSH_ASKPASS_REQUIRE = 'force';
    env.DISPLAY = env.DISPLAY || ':web-terminal';
    if (server.authType === 'password') {
      env.WEB_TERMINAL_SSH_PASSWORD = decrypt(server.credentials?.password, config.encryptionKey);
      args.push('-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no');
    } else if (server.authType === 'key') {
      const keyFile = path.join(tempDir, 'identity');
      fs.writeFileSync(keyFile, decrypt(server.credentials?.privateKey, config.encryptionKey), { mode: 0o600 });
      env.WEB_TERMINAL_KEY_PASSPHRASE = decrypt(server.credentials?.passphrase, config.encryptionKey);
      args.push('-i', keyFile, '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'PasswordAuthentication=no');
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

module.exports = { startSsh };
