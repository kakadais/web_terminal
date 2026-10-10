const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

function splitWords(line) {
  const words = [];
  let word = ''; let quote = ''; let escaped = false; let started = false;
  for (const char of line) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\') { escaped = true; started = true; continue; }
    if (quote) { if (char === quote) quote = ''; else word += char; continue; }
    if (char === '#') break;
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (started) words.push(word);
  return words;
}

const isAlias = alias => /^[a-zA-Z0-9_.\-]+$/.test(alias) && !alias.startsWith('-');
const directive = line => splitWords(line.replace(/^(\s*[a-zA-Z]+)\s*=\s*/, '$1 '));

function includeFiles(values) {
  return values.flatMap(include => {
    const expanded = include.replace(/^~(?=\/|$)/, os.homedir());
    // OpenSSH resolves relative user-config Includes against ~/.ssh, even with -F.
    const pattern = path.isAbsolute(expanded) ? expanded : path.join(os.homedir(), '.ssh', expanded);
    return [...fs.globSync(pattern)].sort().filter(file => fs.statSync(file).isFile());
  });
}

function readSources(configFile, replacements = new Map()) {
  const sources = new Map();
  function read(file) {
    if (!fs.existsSync(file)) return;
    const real = fs.realpathSync(file);
    if (sources.has(real)) return;
    const text = replacements.get(real) ?? fs.readFileSync(real, 'utf8');
    sources.set(real, { file: real, text });
    for (const raw of text.split(/\r?\n/)) {
      const [name, ...values] = directive(raw);
      if (name?.toLowerCase() === 'include') for (const included of includeFiles(values)) read(included);
    }
  }
  if (!fs.existsSync(configFile)) throw new Error('SSH config 파일을 찾을 수 없습니다. SSH_CONFIG_PATH를 확인해 주세요.');
  read(configFile);
  return sources;
}

function readAliases(configFile) {
  const aliases = new Set();
  for (const { text } of readSources(configFile).values()) {
    for (const raw of text.split(/\r?\n/)) {
      const [name, ...values] = directive(raw);
      if (name?.toLowerCase() === 'host') for (const alias of values) if (isAlias(alias)) aliases.add(alias);
    }
  }
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
  return { alias, host, port, username, proxyJump: fields.proxyjump === 'none' ? '' : fields.proxyjump || '', identityFile: fields.identityfile || '',
    remoteCommand: fields.remotecommand && fields.remotecommand !== 'none' ? fields.remotecommand : '' };
}

module.exports = { readAliases, resolveAlias, readSources, splitWords, directive, includeFiles, isAlias };
