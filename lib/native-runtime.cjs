const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

function nativePath(env = process.env, cwd = process.cwd()) {
  const configured = env.WEB_TERMINAL_PTY_PATH;
  if (configured) return path.resolve(configured.replace(/^~(?=\/|$)/, os.homedir()));
  // Also support an already-running Meteor dev process (and direct meteor run)
  // whose real cwd is .meteor/local/build/programs/server. Do not use Meteor's
  // virtual __dirname to find an executable on disk.
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, '.deploy', 'native', 'bin', 'web-terminal-pty');
    if (fs.existsSync(path.join(directory, 'native', 'terminal', 'Cargo.toml')) && fs.existsSync(candidate)) return candidate;
    if (directory === path.dirname(directory)) break;
  }
  // Direct Node tests outside the checkout. Bundled deployments use the
  // explicit absolute path written into their release's runtime environment.
  return path.resolve(__dirname, '..', '.deploy', 'native', 'bin', 'web-terminal-pty');
}

module.exports = { nativePath };
