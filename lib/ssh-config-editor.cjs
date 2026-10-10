const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { readSources, directive, includeFiles, isAlias, resolveAlias } = require('./ssh-config.cjs');

const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
const conflict = () => failure('config-conflict', 'SSH config가 다른 곳에서 변경되었습니다. 편집기를 다시 열어 최신 내용을 확인해 주세요.');

function lines(text) {
  let offset = 0;
  return (text.match(/[^\n]*\n|[^\n]+$/g) || []).map(text => {
    const line = { text, start: offset }; offset += text.length; return line;
  });
}

function hostBlocks(file, text) {
  const boundaries = lines(text).flatMap(line => {
    const [name, ...aliases] = directive(line.text);
    return /^(host|match)$/i.test(name || '') ? [{ ...line, kind: name.toLowerCase(), aliases }] : [];
  });
  return boundaries.flatMap((line, index) => {
    if (line.kind !== 'host') return [];
    const end = boundaries[index + 1]?.start ?? text.length;
    return [{ id: hash(`${file}\0${line.start}`), file, start: line.start, end,
      aliases: line.aliases, text: text.slice(line.start, end) }];
  });
}

function snapshot(configFile) {
  const sources = readSources(configFile);
  const blocks = [...sources.values()].flatMap(source => hostBlocks(source.file, source.text));
  const version = hash(JSON.stringify([...sources].map(([file, source]) => [file, hash(source.text)])));
  return { sources, blocks, version, root: fs.realpathSync(configFile) };
}

function getEditor(configFile, alias, initialText) {
  const current = snapshot(configFile);
  const matching = alias ? current.blocks.filter(block => block.aliases.includes(alias)) : [];
  return { version: current.version, alias: alias || '', sharedAliases: [...new Set(matching.flatMap(block => block.aliases).filter(value => value !== alias))],
    blocks: matching.length ? matching.map(({ id, file, text }) => ({ id, file, text }))
      : [{ id: 'new', file: current.root, text: initialText || 'Host new-server\n    HostName 192.168.1.10\n    User ubuntu\n    Port 22\n    # ProxyJump nginx\n    # IdentityFile ~/.ssh/id_ed25519\n' }] };
}

function checkBlock(text) {
  if (typeof text !== 'string' || text.length > 128 * 1024 || text.includes('\0')) throw failure('invalid-config', 'config 블록은 128KB 이하로 입력해 주세요.');
  const entries = lines(text).map(line => directive(line.text)).filter(words => words.length);
  if (entries[0]?.[0]?.toLowerCase() !== 'host' || entries.filter(([name]) => /^(host|match)$/i.test(name)).length !== 1) {
    throw failure('invalid-config', '각 편집 칸에는 Host로 시작하는 블록 하나를 입력해 주세요. Match와 다른 Host 블록은 별도로 유지됩니다.');
  }
  const aliases = entries[0].slice(1).filter(isAlias);
  if (!aliases.length) throw failure('invalid-config', 'Host에 사용할 서버 별칭을 입력해 주세요. 예: Host production');
  return aliases;
}

function planSave(configFile, alias, version, inputBlocks) {
  const current = snapshot(configFile);
  if (current.version !== version) throw conflict();
  const matching = alias ? current.blocks.filter(block => block.aliases.includes(alias)) : [];
  if (!Array.isArray(inputBlocks) || inputBlocks.length !== (matching.length || 1)) throw failure('invalid-config', '편집할 config 블록을 다시 불러와 주세요.');
  const aliases = inputBlocks.map(block => checkBlock(block.text));
  const nextAlias = aliases[0].includes(alias) ? alias : aliases[0][0];
  if (aliases.some(values => !values.includes(nextAlias))) throw failure('invalid-config', '같은 서버의 모든 Host 블록에 동일한 별칭을 유지해 주세요.');
  const matchingIds = new Set(matching.map(block => block.id));
  const oldAliases = new Set(matching.flatMap(block => block.aliases));
  for (const value of new Set(aliases.flat())) {
    if (!oldAliases.has(value) && current.blocks.some(block => !matchingIds.has(block.id) && block.aliases.includes(value))) {
      throw failure('alias-exists', `이미 등록된 SSH 별칭입니다: ${value}`);
    }
  }
  const changes = new Map();
  const replacements = matching.map(block => {
    const input = inputBlocks.find(input => input.id === block.id);
    if (!input) throw failure('invalid-config', '편집할 config 블록이 일치하지 않습니다.');
    return { ...block, replacement: input.text };
  });
  for (const source of current.sources.values()) {
    let text = source.text;
    for (const block of replacements.filter(block => block.file === source.file).sort((a, b) => b.start - a.start)) {
      const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
      const replacement = block.end < source.text.length && !block.replacement.endsWith('\n') ? block.replacement + newline : block.replacement;
      text = text.slice(0, block.start) + replacement + text.slice(block.end);
    }
    if (text !== source.text) changes.set(source.file, text);
  }
  if (!matching.length) {
    if (inputBlocks[0].id !== 'new') throw failure('invalid-config', '새 config 블록을 다시 불러와 주세요.');
    const source = current.sources.get(current.root);
    const firstBlock = lines(source.text).find(line => /^(host|match)$/i.test(directive(line.text)[0] || ''));
    const position = firstBlock?.start ?? source.text.length;
    const newline = source.text.includes('\r\n') ? '\r\n' : '\n';
    const prefix = source.text.slice(0, position);
    // Specific entries must precede Host * defaults: OpenSSH uses the first value.
    changes.set(current.root, prefix + (prefix && !prefix.endsWith('\n') ? newline : '')
      + inputBlocks[0].text.replace(/\r?\n/g, newline).replace(/\s*$/, '') + newline + source.text.slice(position));
  }
  return { ...current, configFile, changes, alias: nextAlias, aliases: [...new Set(aliases.flat())] };
}

function planRemove(configFile, alias, version) {
  const current = snapshot(configFile);
  if (current.version !== version) throw conflict();
  const changes = new Map();
  for (const source of current.sources.values()) {
    let text = source.text;
    for (const block of current.blocks.filter(block => block.file === source.file && block.aliases.includes(alias)).sort((a, b) => b.start - a.start)) {
      const remaining = block.aliases.filter(value => value !== alias);
      const blockLines = lines(block.text);
      const header = blockLines[0].text;
      const newline = header.endsWith('\r\n') ? '\r\n' : '\n';
      let replacement;
      if (remaining.length) {
        const comment = header.match(/\s+#.*$/)?.[0]?.trimEnd() || '';
        replacement = `Host ${remaining.join(' ')}${comment}${newline}` + block.text.slice(header.length);
      } else {
        // Keep trailing comments/spacing that may introduce the following section.
        const lastOption = blockLines.findLastIndex(line => directive(line.text).length);
        replacement = blockLines.slice(lastOption + 1).map(line => line.text).join('');
      }
      text = text.slice(0, block.start) + replacement + text.slice(block.end);
    }
    if (text !== source.text) changes.set(source.file, text);
  }
  return { ...current, configFile, changes, alias, aliases: [] };
}

async function validatePlan(plan, sshCommand = '/usr/bin/ssh', validate = () => {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-config-check-'));
  fs.chmodSync(tempDir, 0o700);
  try {
    const sources = readSources(plan.configFile, plan.changes);
    const staged = new Map([...sources.keys()].map((file, index) => [file, path.join(tempDir, `${index}.conf`)]));
    for (const source of sources.values()) {
      const text = lines(source.text).map(line => {
        const [name, ...values] = directive(line.text);
        if (name?.toLowerCase() !== 'include') return line.text;
        const targets = includeFiles(values).map(file => staged.get(fs.realpathSync(file))).filter(Boolean);
        return targets.length ? `Include ${targets.map(file => `"${file}"`).join(' ')}\n` : '# Include: no matching files\n';
      }).join('');
      fs.writeFileSync(staged.get(source.file), text, { mode: 0o600 });
    }
    let resolved;
    for (const alias of plan.aliases.length ? plan.aliases : ['web-terminal-config-check']) {
      const result = await resolveAlias(alias, staged.get(plan.root), sshCommand);
      await validate(result);
      if (alias === plan.alias) resolved = result;
    }
    return resolved;
  } catch (error) {
    if (error.code === 'invalid-server') throw error;
    // Never echo OpenSSH stderr: it may include passwords embedded in old comments.
    throw failure('invalid-config', 'SSH config 문법 또는 주소·사용자·포트가 올바르지 않습니다. 원본 파일은 변경하지 않았습니다.');
  } finally { fs.rmSync(tempDir, { recursive: true, force: true }); }
}

function atomicWrite(file, text, mode = 0o600) {
  const temporary = path.join(path.dirname(file), `.web-terminal-${crypto.randomUUID()}`);
  try {
    const fd = fs.openSync(temporary, 'wx', mode);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function commitPlan(plan, backupDir) {
  if (snapshot(plan.configFile).version !== plan.version) throw conflict();
  if (!plan.changes.size) return () => {};
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(backupDir, 0o700);
  const backup = path.join(backupDir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`);
  fs.mkdirSync(backup, { mode: 0o700 });
  const manifest = [];
  const written = [];
  const rollback = () => {
    for (const file of [...written].reverse()) atomicWrite(file, plan.sources.get(file).text, manifest.find(entry => entry.file === file).mode);
  };
  try {
    for (const [file] of plan.changes) {
      const original = plan.sources.get(file);
      const entry = { file, backup: `${manifest.length}.conf`, mode: fs.statSync(file).mode & 0o777 };
      fs.writeFileSync(path.join(backup, entry.backup), original.text, { mode: 0o600 });
      manifest.push(entry);
    }
    fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    for (const [file, text] of plan.changes) { atomicWrite(file, text); written.push(file); }
  } catch (error) { rollback(); throw error; }
  return rollback;
}

module.exports = { getEditor, planSave, planRemove, validatePlan, commitPlan, hostBlocks };
