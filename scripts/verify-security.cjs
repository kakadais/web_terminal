// Changes passwords/MFA and revokes sessions. Use a disposable local QA DB only.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { authenticator } = require('../lib/auth-security.cjs');
const env = require('dotenv').parse(fs.readFileSync(process.env.ENV_FILE || '.env.local'));
const url = process.env.VERIFY_URL || 'http://127.0.0.1:5176';
const target = new URL(url);
if (process.env.VERIFY_AUTH_ISOLATED !== '1' || !['127.0.0.1', 'localhost'].includes(target.hostname)
  || !target.port || target.port === '5160') {
  throw Error('Use VERIFY_AUTH_ISOLATED=1 with a disposable local DB and separate port. This test changes passwords/MFA and revokes sessions.');
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cooldown = () => delay(61_000);
const temporaryPassword = crypto.randomBytes(32).toString('base64url');
setTimeout(() => { console.error('Security QA exceeded its 15 minute deadline'); process.exit(1); }, 15 * 60_000).unref();

(async () => {
  const browser = await chromium.launch({ headless: true,
    executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const response = await page.goto(url);
    await page.waitForFunction(() => globalThis.Meteor?.status().connected);
    assert.match(response.headers()['content-security-policy'], /script-src 'self'/);
    const call = (tab, name, ...args) => tab.evaluate(({ name, args }) => Promise.race([
      Meteor.callAsync(name, ...args).then(value => ({ ok: true, value }), error => ({ ok: false, code: error.error })),
      new Promise(resolve => setTimeout(() => resolve({ ok: false, code: 'qa-timeout' }), 30_000)),
    ]), { name, args });
    const hash = password => page.evaluate(value => Package['accounts-base'].Accounts._hashPassword(value), password);
    const logout = tab => tab.evaluate(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('QA logout timed out')), 30_000);
      Meteor.logout(() => { clearTimeout(timer); resolve(); });
    }));
    const token = tab => tab.evaluate(() => sessionStorage.getItem('Meteor.loginToken'));
    const resume = (tab, value) => tab.evaluate(value => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('QA resume timed out')), 30_000);
      Meteor.loginWithToken(value, error => { clearTimeout(timer); resolve(!error); });
    }), value);
    const login = async (tab, password = env.ADMIN_PASSWORD, code) => {
      for (let retry = 0; retry < 3; retry++) {
        const result = await tab.evaluate(({ username, password, code }) => new Promise(resolve => {
          const timer = setTimeout(() => resolve({ ok: false, code: 'qa-timeout' }), 30_000);
          const callback = error => { clearTimeout(timer); resolve({ ok: !error, code: error?.error }); };
          if (code) Meteor.loginWithPasswordAnd2faCode(username, password, code, callback);
          else Meteor.loginWithPassword(username, password, callback);
        }), { username: env.ADMIN_USERNAME, password, code });
        if (result.code !== 'too-many-requests') return result;
        await cooldown();
      }
      throw Error('Rate-limit retries exhausted');
    };
    const changeWithUi = async (oldPassword, newPassword, code) => {
      await page.getByRole('button', { name: '비밀번호 변경', exact: true }).click();
      await page.getByLabel('현재 비밀번호', { exact: true }).fill(oldPassword);
      await page.getByLabel('새 비밀번호', { exact: true }).fill(newPassword);
      await page.getByLabel('새 비밀번호 확인', { exact: true }).fill(newPassword);
      if (code) await page.getByLabel('인증 코드 또는 복구 코드', { exact: true }).fill(code);
      await page.getByRole('button', { name: '변경', exact: true }).click();
      await page.waitForFunction(() => !Meteor.userId());
    };
    const digest = await hash(env.ADMIN_PASSWORD);
    assert.equal((await call(page, 'security.status')).ok, false);
    assert.equal((await call(page, 'servers.sync')).ok, false);
    assert.equal((await call(page, 'security.changePassword', digest, temporaryPassword, '')).ok, false);
    assert.equal((await login(page, 'incorrect-password-for-qa')).ok, false);
    assert.equal((await login(page)).ok, true);
    assert.equal((await call(page, 'security.status')).value.enabled, false);
    assert.equal(await page.evaluate(() => localStorage.getItem('Meteor.loginToken')), null);
    assert.ok(await token(page));
    await page.reload();
    await page.waitForFunction(() => Meteor.userId());
    console.log('PASS login, private methods, tab storage and reload');

    const other = await context.newPage();
    await other.goto(url);
    await other.waitForFunction(() => globalThis.Meteor?.status().connected);
    assert.equal(await other.evaluate(() => Meteor.userId()), null);
    assert.equal((await login(other)).ok, true);
    const previousToken = await token(page);
    assert.equal((await call(page, 'changePassword', digest, await hash(temporaryPassword))).code, 'password-change-required');
    for (const weak of ['short', ' '.repeat(20), '😀'.repeat(8), env.ADMIN_PASSWORD]) {
      assert.equal((await call(page, 'security.changePassword', digest, weak, '')).code, 'weak-password');
    }
    const wrongDigest = { digest: '0'.repeat(64), algorithm: 'sha-256' };
    assert.equal((await call(page, 'security.changePassword', wrongDigest, temporaryPassword, '')).ok, false);
    await changeWithUi(env.ADMIN_PASSWORD, temporaryPassword);
    await other.waitForFunction(() => !Meteor.userId());
    assert.equal(await resume(other, previousToken), false);
    assert.equal((await login(page)).ok, false);
    assert.equal((await login(page, temporaryPassword)).ok, true);
    assert.equal((await call(page, 'security.changePassword', await hash(temporaryPassword), env.ADMIN_PASSWORD, '')).ok, true);
    await logout(page);
    assert.equal((await login(page)).ok, true);
    console.log('PASS server password policy, blocked legacy API, password-change UI, old password/token rejection and restoration');
    await cooldown();

    assert.equal((await login(other)).ok, true);
    const beforeEnrollment = await token(page);
    await page.evaluate(() => {
      const script = document.createElement('script');
      script.textContent = 'window.__securityInlineExecuted=true';
      document.head.appendChild(script);
    });
    assert.equal(await page.evaluate(() => window.__securityInlineExecuted), undefined);
    await page.getByRole('button', { name: '계정 보안', exact: true }).click();
    await page.getByLabel('현재 비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '인증 앱 등록', exact: true }).click();
    await page.locator('.recovery-codes').waitFor();
    const codes = (await page.locator('.recovery-codes').innerText()).split('\n');
    const secret = await page.locator('.mfa-secret').textContent();
    assert.equal(codes.length, 10);
    assert.ok(await page.locator('.mfa-qr').evaluate(image => image.complete && image.naturalWidth > 0));
    assert.equal(await page.evaluate(() => Boolean(Meteor.user().services)), false);
    await page.getByLabel('복구 코드를 안전한 곳에 저장했습니다').check();
    await page.getByLabel('인증 코드', { exact: true }).fill(authenticator(secret).generate());
    await page.getByRole('button', { name: '2단계 인증 켜기', exact: true }).click();
    await page.waitForFunction(() => !Meteor.userId());
    await other.waitForFunction(() => !Meteor.userId());
    assert.equal(await resume(other, beforeEnrollment), false);
    assert.equal((await login(page)).code, 'mfa-required');
    assert.equal((await login(page, env.ADMIN_PASSWORD, 'invalid-code')).ok, false);
    assert.equal((await login(page, env.ADMIN_PASSWORD, codes[0])).ok, true);
    assert.equal((await call(page, 'security.status')).value.recoveryRemaining, 9);
    assert.equal((await call(page, 'security.changePassword', digest, temporaryPassword, '')).ok, false);
    assert.equal((await call(page, 'security.changePassword', digest, temporaryPassword, 'invalid-code')).ok, false);
    assert.equal((await call(page, 'security.changePassword', digest, 'short', codes[1])).code, 'weak-password');
    assert.equal((await call(page, 'security.status')).value.recoveryRemaining, 9);
    assert.equal((await call(page, 'changePassword', digest, await hash(temporaryPassword))).code, 'password-change-required');
    console.log('PASS MFA enrollment, old sessions revoked, missing/invalid factors rejected and invalid password does not consume a recovery code');
    await cooldown();

    const beforePasswordChange = await token(page);
    assert.equal((await call(page, 'security.changePassword', digest, temporaryPassword, codes[1])).ok, true);
    await logout(page);
    assert.equal(await resume(other, beforePasswordChange), false);
    assert.equal((await login(page)).ok, false);
    assert.equal((await login(page, temporaryPassword)).code, 'mfa-required');
    assert.equal((await login(page, temporaryPassword, codes[2])).ok, true);
    assert.equal((await call(page, 'security.status')).value.enabled, true);
    await changeWithUi(temporaryPassword, env.ADMIN_PASSWORD, codes[3]);
    assert.equal((await login(page, env.ADMIN_PASSWORD, codes[4])).ok, true);
    assert.equal((await call(page, 'security.status')).value.recoveryRemaining, 5);
    assert.equal((await login(other, env.ADMIN_PASSWORD, codes[4])).ok, false);
    console.log('PASS MFA-protected password change and UI restoration; MFA remains enabled; recovery codes remain single-use');
    await cooldown();

    await logout(page);
    const concurrent = await Promise.all([login(page, env.ADMIN_PASSWORD, codes[5]), login(other, env.ADMIN_PASSWORD, codes[5])]);
    assert.equal(concurrent.filter(result => result.ok).length, 1);
    const logged = concurrent[0].ok ? page : other;
    const anonymous = concurrent[0].ok ? other : page;
    const otp = authenticator(secret).generate();
    assert.equal((await login(anonymous, env.ADMIN_PASSWORD, otp)).ok, true);
    await logout(anonymous);
    assert.equal((await login(anonymous, env.ADMIN_PASSWORD, otp)).ok, false);
    assert.equal((await call(logged, 'security.disableMfa', digest, 'invalid-code')).ok, false);
    assert.equal((await call(logged, 'security.disableMfa', digest, codes[6])).ok, true);
    await logout(logged);
    console.log('PASS concurrent recovery consumption, TOTP replay rejection and reauthenticated disable');
    await cooldown();

    assert.equal((await login(page)).ok, true);
    assert.equal((await call(page, 'security.status')).value.enabled, false);
    assert.equal((await login(other)).ok, true);
    assert.equal((await call(page, 'security.logoutAll', digest, '')).ok, true);
    await logout(page);
    await other.waitForFunction(() => !Meteor.userId());
    console.log('PASS all-device logout');
    await cooldown();

    const failures = [];
    for (let index = 0; index < 12; index++) {
      const tab = await context.newPage();
      await tab.goto(url);
      await tab.waitForFunction(() => globalThis.Meteor?.status().connected);
      failures.push(await tab.evaluate(({ username }) => new Promise(resolve => Meteor.loginWithPassword(username,
        'incorrect-password-for-qa', error => resolve(error?.error))), { username: env.ADMIN_USERNAME }));
      await tab.close();
    }
    assert.ok(failures.includes('too-many-requests'));
    assert.equal(errors.length, 0, errors.join('\n'));
    console.log('PASS rate limiting across new connections; no browser exceptions');
  } finally { await browser.close(); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
