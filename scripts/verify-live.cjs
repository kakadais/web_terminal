const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dotenv = require('dotenv');
const { chromium } = require('playwright-core');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const env = { ...dotenv.parse(fs.readFileSync(process.env.ENV_FILE || path.join(root, '.env.local'))), ...process.env };
const target = process.env.VERIFY_URL || env.ROOT_URL;
const out = path.join(root, 'test-results');
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const browser = await chromium.launch({ headless: true,
    executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const inbound = [];
  const output = [];
  const terminalEvents = [];
  const created = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', ws => ws.on('framereceived', ({ payload }) => {
    if (typeof payload !== 'string') return;
    inbound.push(payload);
    try { const message = JSON.parse(payload); if (message.type === 'output') output.push(message.data);
      else if (message.type) terminalEvents.push({ type: message.type, message: message.message, exitCode: message.exitCode }); } catch (_) {}
  }));
  const method = (name, ...args) => page.evaluate(({ name, args }) => Meteor.callAsync(name, ...args), { name, args });
  const waitForOutput = async marker => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (output.join('').includes(marker)) return;
      await sleep(100);
    }
    throw new Error(`Expected SSH command output was not received: ${JSON.stringify(terminalEvents)}; ${output.join('').slice(-2000)}`);
  };
  const verifyCommand = async name => {
    const outputStart = output.length;
    const row = page.locator('.server-row').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
    await row.locator('.server-connect').click();
    await page.locator('.status-bar').filter({ hasText: 'SSH 실행 중' }).waitFor({ timeout: 20_000 });
    const promptDeadline = Date.now() + 20_000;
    while (Date.now() < promptDeadline && !/[$#➜]\s/.test(output.slice(outputStart).join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ''))) await sleep(100);
    await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus();
    const id = crypto.randomBytes(6).toString('hex');
    const marker = `WTERM_PROOF_${id}`;
    // Keep the expected marker out of the echoed command; require shell execution.
    await page.keyboard.type(`printf '\\nWTERM_%s_%s\\n' PROOF ${id}; whoami; stty size`);
    await page.keyboard.press('Enter');
    await waitForOutput(marker);
    console.log(`SSH command executed: ${name}`);
  };
  const add = async ({ name, authType, fixture }) => {
    await page.getByRole('button', { name: '새 서버 추가', exact: true }).first().click();
    await page.getByLabel('서버 이름', { exact: true }).fill(name);
    await page.getByLabel('호스트', { exact: true }).fill(fixture.host);
    await page.getByLabel('포트', { exact: true }).fill(String(fixture.port));
    await page.getByLabel('SSH 사용자', { exact: true }).fill(fixture.username);
    await page.getByRole('combobox').selectOption(authType);
    if (authType === 'password') await page.getByLabel('SSH 비밀번호', { exact: true }).fill(fixture.password);
    else {
      await page.locator('input[type=file]').setInputFiles(path.join(root, '.deploy/qa_identity'));
      await page.getByLabel('키 암호 (선택)', { exact: true }).fill(fixture.passphrase);
    }
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.locator('.dialog').waitFor({ state: 'hidden' });
    const id = await page.evaluate(name => Meteor.connection._mongo_livedata_collections.servers.findOne({ name })?._id, name);
    assert.ok(id, 'Manual server must be published');
    created.push(id);
    return id;
  };
  try {
    const health = await fetch(new URL('/health', target));
    assert.equal(health.status, 200);
    assert.equal((await health.json()).service, 'web_terminal');
    await page.goto(target, { waitUntil: 'networkidle', timeout: 25_000 });
    await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
    const denied = await page.evaluate(async () => { try { await Meteor.callAsync('servers.sync'); return false; } catch (e) { return e.error === 'unauthorized'; } });
    assert.ok(denied, 'Unauthenticated access must be rejected');
    await page.screenshot({ path: path.join(out, 'login.png') });
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.locator('.sidebar').waitFor({ timeout: 20_000 });
    await page.locator('.server-row').first().waitFor({ timeout: 20_000 });
    await page.getByText('서버를 불러오는 중…', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
    const initialCount = await page.locator('.server-row').count();
    assert.ok(initialCount > 0, 'Initial SSH config import must exist');
    await page.getByRole('button', { name: '↻ Sync', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '서버를 동기화했습니다.' }).waitFor({ timeout: 30_000 });
    const syncedCount = await page.locator('.server-row').count();
    await method('servers.sync');
    assert.equal(await page.locator('.server-row').count(), syncedCount, 'Repeated Sync must be idempotent');
    console.log(`Login, initial import and Sync passed: ${syncedCount} servers`);
    await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await page.getByLabel('현재 비밀번호', { exact: true }).fill('incorrect-password-for-verification');
    await page.getByLabel('새 비밀번호', { exact: true }).fill('verification-new-password');
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill('verification-new-password');
    await page.getByRole('button', { name: '변경', exact: true }).click();
    await page.locator('.dialog .error').waitFor();
    await page.locator('.dialog .icon-button').click();
    console.log('Password change rejects an incorrect current password');
    await verifyCommand(env.VERIFY_CONFIG_ALIAS || 'nginx');
    await page.screenshot({ path: path.join(out, 'workspace.png') });
    await page.getByRole('button', { name: 'nginx 연결 종료', exact: true }).click();
    if (env.VERIFY_JUMP_ALIAS) {
      await verifyCommand(env.VERIFY_JUMP_ALIAS);
      await page.getByRole('button', { name: `${env.VERIFY_JUMP_ALIAS} 연결 종료`, exact: true }).click();
    }

    const fixturePath = path.join(root, '.deploy/qa.json');
    if (fs.existsSync(fixturePath)) {
      const fixture = JSON.parse(fs.readFileSync(fixturePath));
      const passwordId = await add({ name: '__verify_password', authType: 'password', fixture });
      const keyId = await add({ name: '__verify_key', authType: 'key', fixture });
      const published = await page.evaluate(() => JSON.stringify(Meteor.connection._mongo_livedata_collections.servers.find().fetch()));
      assert.ok(!published.includes(fixture.password), 'Password must not be published');
      assert.ok(!published.includes(fixture.passphrase), 'Passphrase must not be published');
      assert.ok(!published.includes('BEGIN OPENSSH PRIVATE KEY'), 'Private key must not be published');
      await page.reload({ waitUntil: 'networkidle' });
      await page.locator('.server-row').filter({ hasText: '__verify_password' }).waitFor();
      await page.getByText('서버를 불러오는 중…', { exact: true }).waitFor({ state: 'hidden', timeout: 20_000 });
      assert.ok(await page.evaluate(id => !!Meteor.connection._mongo_livedata_collections.servers.findOne(id), passwordId));
      await verifyCommand('__verify_password');
      await page.getByRole('button', { name: '__verify_password 연결 종료', exact: true }).click();
      await verifyCommand('__verify_key');
      await page.screenshot({ path: path.join(out, 'ssh-key.png') });
      console.log(execFileSync('bash', [path.join(root, 'scripts/verify-database.sh')], { encoding: 'utf8', timeout: 20_000 }).trim());
      // Logout must terminate the active SSH connection.
      await page.getByRole('button', { name: '로그아웃', exact: true }).click();
      await page.getByRole('button', { name: '로그인', exact: true }).waitFor();
      const deniedAgain = await page.evaluate(async () => { try { await Meteor.callAsync('terminal.open', 'anything'); return false; } catch (e) { return e.error === 'unauthorized'; } });
      assert.ok(deniedAgain);
      console.log('Manual password/key connections, persisted list and logout passed');
      await page.evaluate(({ username, password }) => Meteor.loginWithPasswordAsync(username, password), { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD });
      await page.locator('.sidebar').waitFor();
      for (const id of [passwordId, keyId]) await method('servers.remove', id);
      created.length = 0;
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'mobile.png') });
    await page.getByRole('button', { name: '☰', exact: true }).click();
    await page.locator('.sidebar.open').waitFor();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.sidebar.open')).transform === 'matrix(1, 0, 0, 1, 0, 0)');
    await page.screenshot({ path: path.join(out, 'mobile-sidebar.png') });
    assert.deepEqual(errors, [], 'Browser must have no runtime errors');
    assert.ok(inbound.length > 0);
    console.log('Responsive UI and browser runtime passed');
  } finally {
    if (created.length) {
      try {
        await page.evaluate(({ username, password }) => Meteor.loginWithPasswordAsync(username, password), { username: env.ADMIN_USERNAME, password: env.ADMIN_PASSWORD });
        for (const id of created) await method('servers.remove', id);
      } catch (_) { console.error('Verify cleanup incomplete; remove __verify_* server records.'); }
    }
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
