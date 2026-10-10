const os = require('node:os');
const { spawn } = require('./pty.js');
const { createSshConnection, writeRuntimeConfig, quoteShell } = require('./ssh-connection.cjs');

function startSsh(server, config, dimensions = {}) {
  const connection = createSshConnection(server, config, true);
  try {
    const args = [...connection.args, '--', connection.destination];
    if (dimensions.trackingToken && !server.remoteCommand) {
      // Capture the login shell PID without changing dotfiles or typing into the TUI.
      const script = `printf '\\033]777;web-terminal;${dimensions.trackingToken};pid;%s\\007' "$$"; exec "\${SHELL:-/bin/sh}" -l`;
      args.push(`sh -c ${quoteShell(script)}`);
    }
    const terminal = spawn(config.sshCommand, args, {
      name: 'xterm-256color', cols: dimensions.cols || 100, rows: dimensions.rows || 30,
      cwd: os.homedir(), env: connection.env,
    });
    terminal.onExit(connection.cleanup);
    return { terminal, cleanup: connection.cleanup, tempDir: connection.tempDir };
  } catch (error) { connection.cleanup(); throw error; }
}
module.exports = { startSsh, writeRuntimeConfig };
