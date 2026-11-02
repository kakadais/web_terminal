// This changes the password. Only use a disposable, separate local QA database.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const env = require('dotenv').parse(fs.readFileSync(process.env.ENV_FILE || '.env.local'));
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5176';
const target = new URL(url);
if (process.env.VERIFY_AUTH_ISOLATED !== '1' || !['localhost', '127.0.0.1'].includes(target.hostname)
  || !target.port || target.port === '5160') throw Error('Use a disposable local QA database and VERIFY_AUTH_ISOLATED=1.');
const temporaryPassword = crypto.randomBytes(32).toString('base64url');
setTimeout(() => { console.error('Terminal auth QA exceeded its deadline'); process.exit(1); }, 3 * 60_000).unref();
const wait = async predicate => {
  const until = Date.now() + 30_000;
  while (Date.now() < until) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Timed out waiting for password change / terminal cleanup');
};
(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext();
    const tabs = await Promise.all([context.newPage(), context.newPage()]);
    const states = tabs.map(() => ({ ready: false, closed: false }));
    for (const [index, tab] of tabs.entries()) {
      tab.on('websocket', socket => {
        if (!socket.url().includes('/terminal/ws')) return;
        socket.on('framereceived', ({ payload }) => { if (JSON.parse(String(payload)).type === 'ready') states[index].ready = true; });
        socket.on('close', () => { states[index].closed = true; });
      });
      await tab.goto(url);
      await tab.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
      await tab.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
      await tab.getByRole('button', { name: '로그인', exact: true }).click();
      await tab.locator('.server-row[data-source=local] .server-connect').click();
    }
    await wait(() => states.every(state => state.ready));
    const page = tabs[0];
    assert.equal(await page.evaluate(() => Meteor.callAsync('security.status').then(value => value.enabled)), false);
    await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
    await page.getByLabel('현재 비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByLabel('새 비밀번호', { exact: true }).fill(temporaryPassword);
    await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(temporaryPassword);
    await page.getByRole('button', { name: '변경', exact: true }).click();
    await wait(() => states.every(state => state.closed));
    for (const tab of tabs) await tab.waitForFunction(() => !Meteor.userId());
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(temporaryPassword);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.locator('.server-row[data-source=local]').waitFor();
    await page.evaluate(({ oldPassword, newPassword }) => Meteor.callAsync('security.changePassword',
      Package['accounts-base'].Accounts._hashPassword(oldPassword), newPassword, ''),
    { oldPassword: temporaryPassword, newPassword: env.ADMIN_PASSWORD });
    await page.evaluate(() => new Promise(resolve => Meteor.logout(resolve)));
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.locator('.server-row[data-source=local]').waitFor();
    await page.evaluate(() => new Promise(resolve => Meteor.logout(resolve)));
    console.log('PASS password change closes terminals on both connections, revokes both logins, and restores the QA password');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.name); process.exitCode = 1; });
