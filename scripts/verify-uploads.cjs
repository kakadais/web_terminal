const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const dotenv = require('dotenv');
const { chromium } = require('playwright-core');
const { quoteShell } = require('../lib/ssh-connection.cjs');

const root = path.resolve(__dirname, '..');
const env = { ...dotenv.parse(fs.readFileSync(process.env.ENV_FILE || path.join(root, '.env.local'))), ...process.env };
const target = env.VERIFY_URL || env.ROOT_URL;
const out = path.join(root, 'test-results');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = buffer => crypto.createHash('sha256').update(buffer).digest('hex');

// Modify only this run's otherwise-unused Include file. Existing config bytes stay intact.
const nonce = crypto.randomBytes(6).toString('hex');
const syncAlias = `__verify_sync_${nonce}`;
function configFixture(text) {
  return execFileSync('ssh', ['server', 'python3 -'], { encoding: 'utf8', timeout: 20000,
    input: `import pathlib, json, os\ndata=json.loads(${JSON.stringify(JSON.stringify({ nonce, text }))})\np=pathlib.Path.home()/'.config/ssh/local.d'/('__web_terminal_'+data['nonce']+'.conf')\nif data['text'] is None:\n    p.unlink(missing_ok=True)\nelse:\n    p.parent.mkdir(parents=True, exist_ok=True)\n    p.write_text(data['text'])\n    p.chmod(0o600)\nprint('Fixture removed' if data['text'] is None else 'Fixture written')\n` }).trim();
}

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const sockets = [];
  const responses = [];
  let current;
  let fixtureWritten = false;
  const created = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', response => { if (response.url().endsWith('/terminal/upload')) responses.push(response.status()); });
  page.on('websocket', ws => {
    if (!ws.url().includes('/terminal/ws')) return;
    const state = { output: '', sessionId: null, closed: false };
    sockets.push(state);
    ws.on('framereceived', ({ payload }) => {
      try {
        const message = JSON.parse(payload.toString());
        if (message.type === 'output') state.output += message.data;
        if (message.type === 'ready') state.sessionId = message.sessionId;
        if (message.type === 'error') state.error = message.message;
      } catch (_) {}
    });
    ws.on('close', () => { state.closed = true; });
  });
  const wait = async (condition, message, timeout = 35000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) { if (await condition()) return; await sleep(100); }
    throw new Error(`${message}; ${current?.socket.error || ''}; ${current?.socket.output.slice(-1200) || ''}`);
  };
  const method = (name, ...args) => page.evaluate(({ name, args }) => Meteor.callAsync(name, ...args), { name, args });
  const login = async () => {
    await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 });
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.locator('.sidebar').waitFor();
    await page.getByText('서버를 불러오는 중…', { exact: true }).waitFor({ state: 'hidden', timeout: 20000 });
  };
  const input = async command => {
    await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus();
    await page.keyboard.type(command);
    await page.keyboard.press('Enter');
  };
  const command = async commandText => {
    const id = crypto.randomBytes(6).toString('hex');
    const marker = `WTERM_DONE_${id}`;
    const start = current.socket.output.length;
    await input(`${commandText}; printf '\\nWTERM_%s_%s\\n' DONE ${id}`);
    await wait(() => current.socket.output.slice(start).includes(marker), 'Terminal command did not execute');
    return current.socket.output.slice(start);
  };
  const open = async (name, source) => {
    const count = sockets.length;
    await page.locator(`.server-row[data-source=${source}]`).filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) }).locator('.server-connect').click();
    await wait(() => sockets.length > count && sockets.at(-1).sessionId, `Terminal ${name} failed to open`);
    current = { name, source, socket: sockets.at(-1), directory: `/tmp/web-terminal-upload-${nonce}-${source}-${name} 한글 ' folder` };
    await wait(() => /[$#%➜>]\s/.test(current.socket.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), `Terminal ${name} has no shell prompt`);
    await command(`mkdir -p -- ${quoteShell(current.directory)}; cd -- ${quoteShell(current.directory)}`);
    const directoryMarker = crypto.randomBytes(6).toString('hex');
    const resolved = await command(`printf '\\nWTPATH_%s__%s\\n' ${directoryMarker} "$(pwd -P)"`);
    current.canonical = resolved.match(new RegExp(`WTPATH_${directoryMarker}__(/[^\\r\\n]+)`))?.[1];
    assert.ok(current.canonical, 'Physical working directory must be printed');
  };
  const close = async () => {
    if (!current) return;
    const saved = current;
    if (!saved.socket.closed) {
      await command(`cd /tmp; rm -rf -- ${quoteShell(saved.directory)}`);
      await page.getByRole('button', { name: `${saved.name} 연결 종료`, exact: true }).click();
      await wait(() => saved.socket.closed, 'Closing a tab must close its terminal');
    }
    current = null;
  };
  const drop = async files => {
    await page.locator('.terminal-pane.visible').evaluate((element, files) => {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(new File([Uint8Array.from(atob(file.base64), character => character.charCodeAt(0))], file.name));
      element.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, files.map(({ name, data }) => ({ name, base64: data.toString('base64') })));
    await wait(async () => await page.locator('.terminal-pane.visible .upload-item').count() >= files.length, 'Files must appear in the upload panel');
    await wait(async () => await page.locator('.terminal-pane.visible .upload-item.preparing, .terminal-pane.visible .upload-item.queued, .terminal-pane.visible .upload-item.sending').count() === 0, 'Files did not finish uploading', 120000);
  };
  const verifyHash = async (file, directory = current.directory) => {
    const result = await command(`if command -v sha256sum >/dev/null 2>&1; then sha256sum -- ${quoteShell(`${directory}/${file.name}`)}; else shasum -a 256 -- ${quoteShell(`${directory}/${file.name}`)}; fi`);
    assert.ok(result.includes(digest(file.data)), `Saved binary hash differs for ${file.name}`);
  };
  const success = async files => {
    await drop(files);
    assert.equal(await page.locator('.terminal-pane.visible .upload-item.error').count(), 0, await page.locator('.terminal-pane.visible .upload-item.error').allTextContents().then(items => items.join('; ')));
    assert.equal(await page.locator('.terminal-pane.visible .upload-item.done').count(), files.length);
    for (const file of files) await verifyHash(file, await page.locator('.terminal-pane.visible .upload-heading > span').innerText());
  };
  const syncRecord = () => page.evaluate(alias => Meteor.connection._mongo_livedata_collections.servers.findOne({ source: 'config', sshAlias: alias }), syncAlias);
  try {
    assert.equal((await fetch(new URL('/health', target))).status, 200);
    assert.equal((await fetch(new URL('/terminal/upload', target), { method: 'POST', headers: { Origin: new URL(target).origin, 'X-Upload-Ticket': 'invalid' }, body: 'invalid' })).status, 401);
    assert.equal((await fetch(new URL('/terminal/upload', target), { method: 'POST', headers: { Origin: 'https://invalid.example' }, body: 'invalid' })).status, 403);
    await login();
    const before = await page.locator('.server-row').count();
    await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '서버를 동기화했습니다.' }).waitFor({ timeout: 30000 });
    console.log(`Initial full Sync: ${before} → ${await page.locator('.server-row').count()} rows`);
    configFixture(`Host ${syncAlias}\n    HostName 127.0.0.1\n    User sync-before\n    Port 2222\n`); fixtureWritten = true;
    await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
    await wait(async () => (await syncRecord())?.username === 'sync-before', 'Sync must import a new external alias');
    const original = await syncRecord();
    configFixture(`Host ${syncAlias}\n    HostName 192.0.2.47\n    User sync-after\n    Port 2223\n    ProxyJump nginx\n`);
    await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
    await wait(async () => (await syncRecord())?.username === 'sync-after', 'Sync must reload changed User');
    const changed = await syncRecord();
    assert.equal(changed._id, original._id); assert.equal(changed.host, '192.0.2.47'); assert.equal(changed.port, 2223); assert.equal(changed.proxyJump, 'nginx');
    configFixture(null); fixtureWritten = false;
    await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
    await wait(async () => !(await syncRecord()), 'Sync must delete an externally removed alias');
    assert.equal(await page.locator('.pinned-servers .server-row').count(), 1);
    console.log('Sync imported, updated and removed an external Include alias; pinned server preserved');

    const pinnedName = await page.locator('.pinned-servers .server-row strong').innerText();
    const targets = [[pinnedName, 'local'], [env.VERIFY_CONFIG_ALIAS || 'nginx', 'config']];
    if (env.VERIFY_JUMP_ALIAS) targets.push([env.VERIFY_JUMP_ALIAS, 'config']);
    const qaPath = path.join(root, '.deploy/qa.json');
    if (fs.existsSync(qaPath) && !env.VERIFY_UPLOAD_ALIAS) {
      const qa = JSON.parse(fs.readFileSync(qaPath));
      for (const authType of ['password', 'key']) {
        const name = `__verify_upload_${authType}_${nonce}`;
        await page.getByRole('button', { name: '새 서버 추가', exact: true }).first().click();
        await page.getByLabel('SSH config 블록', { exact: true }).fill(`Host ${name}\n    HostName ${qa.host}\n    User ${qa.username}\n    Port ${qa.port}\n`);
        await page.getByRole('combobox').selectOption(authType);
        if (authType === 'password') await page.getByLabel('SSH 비밀번호', { exact: true }).fill(qa.password);
        else {
          await page.locator('input[type=file]').setInputFiles(path.join(root, '.deploy/qa_identity'));
          await page.getByLabel('키 암호 (선택)', { exact: true }).fill(qa.passphrase);
        }
        await page.getByRole('button', { name: '저장', exact: true }).click();
        await page.locator('.dialog').waitFor({ state: 'hidden', timeout: 30000 });
        const record = await page.evaluate(name => Meteor.connection._mongo_livedata_collections.servers.findOne({ sshAlias: name }), name);
        assert.ok(record); created.push(record._id); targets.push([name, 'config']);
      }
      await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
      await sleep(1000);
      for (const id of created) {
        const record = await page.evaluate(id => Meteor.connection._mongo_livedata_collections.servers.findOne(id), id);
        assert.ok(record.authType === 'password' ? record.hasPassword : record.hasPrivateKey && record.hasPassphrase, 'Sync must preserve stored SSH authentication');
      }
    }
    for (const [name, source] of targets.filter(([name]) => !env.VERIFY_UPLOAD_ALIAS || name === env.VERIFY_UPLOAD_ALIAS)) {
      await open(name, source);
      const binary = { name: "한글 ' $() `literal` binary.bin", data: crypto.randomBytes(5 * 1024 * 1024 + 37) };
      const empty = { name: 'empty.txt', data: Buffer.alloc(0) };
      await success([binary, empty]);
      assert.equal(await page.locator('.terminal-pane.visible .upload-heading > span').innerText(), current.canonical);
      await drop([{ name: binary.name, data: Buffer.from('do not overwrite') }]);
      assert.equal(await page.locator('.terminal-pane.visible .upload-item.error').count(), 1);
      assert.ok(await page.getByText('같은 이름의 파일이 이미 있습니다. 기존 파일은 변경하지 않았습니다.', { exact: true }).count());
      await verifyHash(binary);
      await page.locator('.terminal-pane.visible .upload-heading').getByRole('button', { name: '닫기', exact: true }).click();

      const nested = `${current.directory}/next directory`;
      await command(`mkdir -p -- ${quoteShell(nested)}; cd -- ${quoteShell(nested)}`);
      // Drop with a foreground process running: no pwd or upload command may be typed into it.
      await input('cat'); await sleep(300);
      const during = { name: 'while-cat.txt', data: Buffer.from('independent SSH channel\n') };
      await drop([during]);
      assert.equal(await page.locator('.terminal-pane.visible .upload-item.error').count(), 0);
      assert.equal(await page.locator('.terminal-pane.visible .upload-heading > span').innerText(), `${current.canonical}/next directory`);
      await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus(); await page.keyboard.press('Control+C');
      await verifyHash(during, nested);

      await page.getByLabel('파일 저장 경로', { exact: true }).fill(current.directory);
      const manual = { name: 'manual path.txt', data: Buffer.from('manual absolute directory\n') };
      await success([manual]);
      await page.getByLabel('파일 저장 경로', { exact: true }).fill('');

      // The HTTP capability is bound to a live authenticated terminal and works once.
      const apiFile = { name: 'one-use.txt', data: Buffer.from('one-use upload\n') };
      const prepared = await method('terminal.upload.prepare', current.socket.sessionId, [{ name: apiFile.name, size: apiFile.data.length }], current.directory);
      const capability = prepared.items[0].token;
      const post = () => page.evaluate(async ({ token, base64 }) => (await fetch('/terminal/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Ticket': token }, body: Uint8Array.from(atob(base64), c => c.charCodeAt(0)) })).status, { token: capability, base64: apiFile.data.toString('base64') });
      assert.equal(await post(), 201); assert.equal(await post(), 401); await verifyHash(apiFile);

      // Hold a partially-written request, cancel from the UI's method, then check cleanup.
      const cancelled = await method('terminal.upload.prepare', current.socket.sessionId, [{ name: 'cancelled.bin', size: 128 * 1024 * 1024 }], current.directory);
      const pending = fetch(new URL('/terminal/upload', target), { method: 'POST', duplex: 'half',
        headers: { Origin: new URL(target).origin, 'X-Upload-Ticket': cancelled.items[0].token },
        body: (async function* () { yield Buffer.alloc(128 * 1024); await sleep(3500); yield Buffer.alloc(128 * 1024); })() }).catch(() => null);
      await sleep(1200); await method('terminal.upload.cancel', current.socket.sessionId); await pending; await sleep(600);
      const cleanup = await command(`if [ ! -e ${quoteShell(`${current.directory}/cancelled.bin`)} ] && [ -z "$(find ${quoteShell(current.directory)} -name '.web-terminal-upload.*' -print)" ]; then printf 'CANCEL_%s\\n' CLEAN; fi`);
      assert.ok(cleanup.includes('CANCEL_CLEAN'), 'Cancellation must leave no published or staging file');
      await page.screenshot({ path: path.join(out, `upload-${name}-${source}.png`) });
      if (source === 'local') {
        await page.setViewportSize({ width: 390, height: 844 });
        await wait(async () => (await page.locator('.sidebar').boundingBox()).x + (await page.locator('.sidebar').boundingBox()).width <= 1, 'Mobile sidebar must finish closing');
        await page.screenshot({ path: path.join(out, 'upload-mobile.png') });
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      console.log(`Upload passed: ${name} (${source}), 5MB binary + empty file, current/changed/manual directory, active cat, no overwrite, single-use and cancellation`);
      await close();
      await sleep(2500);
    }
    assert.ok(responses.includes(201)); assert.ok(responses.includes(409));
    assert.deepEqual(errors, [], 'Browser must have no runtime errors');
    console.log('File drop and full config Sync verification passed');
  } finally {
    if (fixtureWritten) { configFixture(null); try { await method('servers.sync'); } catch (_) {} }
    try { await close(); } catch (error) { console.error(`Isolated upload fixture cleanup needed: ${current?.directory}`); }
    for (const id of created) {
      try { const editor = await method('servers.editor', id); await method('servers.remove', id, editor.version); }
      catch (error) { console.error(`Temporary SSH config cleanup needed: ${id}`); }
    }
    await browser.close();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
