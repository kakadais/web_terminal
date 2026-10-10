const os = require('node:os');
const { spawn } = require('./pty.js');
const { terminalEnv } = require('./terminal-env.cjs');

function startLocal(server, config, dimensions = {}) {
  const user = os.userInfo();
  const terminal = spawn(user.shell || process.env.SHELL || '/bin/bash', ['-l'], {
    name: 'xterm-256color', cols: dimensions.cols || 100, rows: dimensions.rows || 30,
    cwd: user.homedir, env: terminalEnv(),
  });
  return { terminal, cleanup: () => {} };
}
module.exports = { startLocal };
