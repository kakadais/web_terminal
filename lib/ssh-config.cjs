const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function splitWords(line) {
  const words = [];
  const regex = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|([^\s#]+)/g;
  for (const match of line.matchAll(regex)) {
    if (line.slice(0, match.index).includes('#')) break;
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

function readAliases(configFile) {
  const aliases = new Set();
  const visited = new Set();
  const homeSsh = path.dirname(configFile);
  function read(file) {
    if (!fs.existsSync(file)) return;
    const real = fs.realpathSync(file);
    if (visited.has(real)) return;
    visited.add(real);
    for (const raw of fs.readFileSync(real, 'utf8').split(/\r?\n/)) {
      const [directive, ...values] = splitWords(raw.replace(/^\s*(Host|Include)\s*=\s*/i, '$1 '));
      if (directive?.toLowerCase() === 'host') {
        for (const alias of values) {
          if (/^[a-zA-Z0-9_.\-]+$/.test(alias) && !alias.startsWith('-')) aliases.add(alias);
        }
      } else if (directive?.toLowerCase() === 'include') {
        for (const include of values) {
          const expanded = include.replace(/^~(?=\/|$)/, os.homedir());
          const pattern = path.isAbsolute(expanded) ? expanded : path.join(homeSsh, expanded);
          for (const included of fs.globSync(pattern)) read(included);
        }
      }
    }
  }
  if (!fs.existsSync(configFile)) throw new Error('SSH config 파일을 찾을 수 없습니다. SSH_CONFIG_PATH를 확인해 주세요.');
  read(configFile);
  return [...aliases].sort((a, b) => a.localeCompare(b));
}

async function resolveAlias(alias, configFile, sshCommand = '/usr/bin/ssh') {
  const { stdout } = await run(sshCommand, ['-G', '-F', configFile, '--', alias], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const fields = {};
  for (const line of stdout.split('\n')) {
    const index = line.indexOf(' ');
    if (index > 0 && !(line.slice(0, index) in fields)) fields[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  const host = fields.hostname || alias;
  const port = Number(fields.port || 22);
  if (host.includes('%') || !/^[a-zA-Z0-9_.:\-]+$/.test(host) || host.startsWith('-')) {
    throw new Error('SSH config의 HostName을 실제 주소로 설정해 주세요.');
  }
  // Old configs sometimes attach a comment directly to User (user#comment).
  // Keep that text out of metadata, and pass the actual login name with ssh -l.
  const username = (fields.user || os.userInfo().username).split('#', 1)[0].trim();
  return { alias, host, port, username, proxyJump: fields.proxyjump === 'none' ? '' : fields.proxyjump || '', identityFile: fields.identityfile || '' };
}

module.exports = { readAliases, resolveAlias };
