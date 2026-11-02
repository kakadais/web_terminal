import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { Mongo } from 'meteor/mongo';
import { check, Match } from 'meteor/check';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import { WebApp, WebAppInternals } from 'meteor/webapp';
import { config } from './config';
import { encrypt, decrypt } from '../lib/credentials.cjs';
import { authenticator, tokenCounter, recoveryHash, recoveryCodes, validNewPassword, FailureLimiter } from '../lib/auth-security.cjs';
import { allowedOrigins } from '../lib/request-origin.cjs';

Accounts.config({ forbidClientAccountCreation: true, loginExpirationInDays: 1,
  argon2Enabled: true, argon2Type: 'argon2id', argon2MemoryCost: 19456, argon2TimeCost: 2, argon2Parallelism: 1 });

// Meteor's digest-only changePassword method cannot enforce plaintext length
// or require our MFA factor. Fail closed if this pinned Meteor integration
// changes, and route the UI through security.changePassword instead.
if (typeof Meteor.server.method_handlers.changePassword !== 'function') throw new Error('Unsupported Meteor password method registration');
Meteor.server.method_handlers.changePassword = function () {
  throw new Meteor.Error('password-change-required', '화면을 새로고침한 뒤 비밀번호 변경을 이용해 주세요.');
};

const Events = new Mongo.Collection('security_events');
const failures = new FailureLimiter();
const mfaPath = 'services.webTerminalMfa';
const pendingPath = 'services.webTerminalMfaPending';
const genericError = () => new Meteor.Error('login-failed', '로그인 정보를 확인하거나 잠시 후 다시 시도해 주세요.');
const digestValidator = { digest: Match.Where(value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)), algorithm: 'sha-256' };
async function audit(userId, event, connection) {
  try { await Events.insertAsync({ userId: userId || null, event, ip: connection?.clientAddress || '', at: new Date() }); }
  catch (_) { console.error('[security] Could not record authentication event'); }
}
async function authenticated(context, password) {
  if (!context.userId) throw new Meteor.Error('unauthorized', '로그인이 필요합니다.');
  check(password, digestValidator);
  const user = await Meteor.users.findOneAsync(context.userId);
  if (!user || (await Accounts._checkPasswordAsync(user, password)).error) throw genericError();
  return user;
}
async function consumeFactor(user, code) {
  const mfa = user.services?.webTerminalMfa;
  if (!mfa) return false;
  // Match the enrollment too, so a stale login cannot consume a replacement factor.
  const selector = { _id: user._id, [`${mfaPath}.id`]: mfa.id };
  const hash = recoveryHash(code);
  if (hash) return Boolean(await Meteor.users.updateAsync({ ...selector, [`${mfaPath}.recoveryHashes`]: hash },
    { $pull: { [`${mfaPath}.recoveryHashes`]: hash } }));
  const counter = tokenCounter(decrypt(mfa.secret, config.encryptionKey), code);
  if (counter === null) return false;
  return Boolean(await Meteor.users.updateAsync({ ...selector, [`${mfaPath}.lastCounter`]: { $lt: counter } },
    { $set: { [`${mfaPath}.lastCounter`]: counter } }));
}
async function detachCurrentLogin(context, userId) {
  // Mirror Meteor 3.5's logout method: stop observing this token before deleting
  // it. Otherwise the connection closes mid-method and DDP retries a completed
  // MFA mutation. Other connections still observe deletion and are disconnected.
  Accounts._setLoginToken(userId, context.connection, null);
  await Accounts._successfulLogout(context.connection, userId);
  await context.setUserId(null);
}
Accounts.validateLoginAttempt(async attempt => {
  const input = attempt.methodArguments?.[0];
  if (attempt.type !== 'password') {
    if (!attempt.allowed) throw genericError();
    return true;
  }
  const key = attempt.user?._id || String(input?.user?.username || input?.user?.email || '').toLowerCase().slice(0, 256);
  if (failures.blocked(key)) throw genericError();
  if (!attempt.allowed) { failures.fail(key); throw genericError(); }
  // Read afresh: the password check can yield while another connection enables MFA.
  const user = await Meteor.users.findOneAsync(attempt.user._id);
  if (user?.services?.webTerminalMfa) {
    if (!input?.code) throw new Meteor.Error('mfa-required', '인증 앱의 6자리 코드 또는 복구 코드를 입력해 주세요.');
    if (!await consumeFactor(user, input.code)) { failures.fail(key); throw genericError(); }
  }
  failures.clear(key);
  return true;
});
Accounts.onLogin(attempt => audit(attempt.user?._id, attempt.type === 'resume' ? 'session-resumed' : 'login-succeeded', attempt.connection));
Accounts.onLoginFailure(attempt => audit(attempt.user?._id, 'login-failed', attempt.connection));

Meteor.methods({
  async 'security.changePassword'(password, newPassword, code) {
    check(code, Match.Maybe(String));
    const user = await authenticated(this, password);
    if (!validNewPassword(newPassword)) throw new Meteor.Error('weak-password', '새 비밀번호는 15자 이상, 200자 이하로 입력해 주세요. 공백만 사용할 수 없습니다.');
    const digest = crypto.createHash('sha256').update(newPassword).digest('hex');
    if (digest === password.digest.toLowerCase()) throw new Meteor.Error('weak-password', '현재와 다른 새 비밀번호를 입력해 주세요.');
    if (user.services?.webTerminalMfa && !await consumeFactor(user, code)) throw genericError();
    await detachCurrentLogin(this, user._id);
    await Accounts.setPasswordAsync(user._id, newPassword, { logout: true });
    await audit(user._id, 'password-changed', this.connection);
    return true;
  },
  async 'security.status'() {
    if (!this.userId) throw new Meteor.Error('unauthorized', '로그인이 필요합니다.');
    const user = await Meteor.users.findOneAsync(this.userId);
    return { enabled: Boolean(user?.services?.webTerminalMfa), recoveryRemaining: user?.services?.webTerminalMfa?.recoveryHashes?.length || 0,
      events: await Events.find({ userId: this.userId }, { sort: { at: -1 }, limit: 12, fields: { event: 1, ip: 1, at: 1 } }).fetchAsync() };
  },
  async 'security.beginMfa'(password) {
    const user = await authenticated(this, password);
    if (user.services?.webTerminalMfa) throw new Meteor.Error('already-enabled', '2단계 인증이 이미 켜져 있습니다.');
    const otp = authenticator(null, user.username);
    const codes = recoveryCodes(); const id = crypto.randomUUID();
    const pending = { id, secret: encrypt(otp.secret.base32, config.encryptionKey), recoveryHashes: codes.map(recoveryHash),
      connectionId: this.connection.id, expires: new Date(Date.now() + 10 * 60_000) };
    const changed = await Meteor.users.updateAsync({ _id: user._id, [mfaPath]: { $exists: false } }, { $set: { [pendingPath]: pending } });
    if (!changed) throw genericError();
    return { id, secret: otp.secret.base32, qr: await QRCode.toDataURL(otp.toString(), { width: 220, margin: 2 }), codes };
  },
  async 'security.confirmMfa'(id, code) {
    check(id, String); check(code, String);
    if (!this.userId) throw new Meteor.Error('unauthorized', '로그인이 필요합니다.');
    const user = await Meteor.users.findOneAsync(this.userId);
    const pending = user?.services?.webTerminalMfaPending;
    if (!pending || pending.id !== id || pending.connectionId !== this.connection.id || pending.expires <= new Date()) throw genericError();
    const counter = tokenCounter(decrypt(pending.secret, config.encryptionKey), code);
    if (counter === null) throw genericError();
    await detachCurrentLogin(this, user._id);
    const changed = await Meteor.users.updateAsync({ _id: user._id, [`${pendingPath}.id`]: id, [mfaPath]: { $exists: false } }, {
      $set: { [mfaPath]: { id, secret: pending.secret, recoveryHashes: pending.recoveryHashes, lastCounter: counter, enabledAt: new Date() } },
      $unset: { [pendingPath]: '', 'services.resume.loginTokens': '' },
    });
    if (!changed) throw genericError();
    await audit(user._id, 'mfa-enabled', this.connection);
    return true;
  },
  async 'security.disableMfa'(password, code) {
    check(code, String);
    const user = await authenticated(this, password);
    if (!await consumeFactor(user, code)) throw genericError();
    await detachCurrentLogin(this, user._id);
    const changed = await Meteor.users.updateAsync({ _id: user._id, [`${mfaPath}.id`]: user.services.webTerminalMfa.id },
      { $unset: { [mfaPath]: '', [pendingPath]: '', 'services.resume.loginTokens': '' } });
    if (!changed) throw genericError();
    await audit(user._id, 'mfa-disabled', this.connection);
    return true;
  },
  async 'security.logoutAll'(password, code) {
    check(code, Match.Maybe(String));
    const user = await authenticated(this, password);
    if (user.services?.webTerminalMfa && !await consumeFactor(user, code)) throw genericError();
    await detachCurrentLogin(this, user._id);
    await Meteor.users.updateAsync(user._id, { $unset: { 'services.resume.loginTokens': '', [pendingPath]: '' } });
    await audit(user._id, 'all-sessions-revoked', this.connection);
    return true;
  },
});

// IP limits survive reconnects; the global cap bounds expensive hash work across IPs.
DDPRateLimiter.addRule({ name: 'login', type: 'method', clientAddress: () => true }, 10, 60_000);
DDPRateLimiter.addRule({ name: 'login', type: 'method' }, 60, 60_000);
DDPRateLimiter.addRule({ name: name => name === 'changePassword' || name.startsWith('security.'), type: 'method', clientAddress: () => true }, 15, 60_000);
DDPRateLimiter.addRule({ name: name => name.startsWith('security.') && name !== 'security.status', type: 'method', userId: () => true }, 10, 60_000);

const connect = [...allowedOrigins(config.rootUrl, Meteor.isDevelopment)].flatMap(origin => [origin, origin.replace(/^http/, 'ws')]).join(' ');
const csp = `default-src 'self'; script-src 'self'${Meteor.isDevelopment ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${connect}; worker-src 'self'; frame-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'`;
WebApp.rawHandlers.use((_request, response, next) => {
  response.setHeader('Content-Security-Policy', csp);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
Meteor.startup(async () => {
  // The same Meteor hook used by browser-policy: serve runtime config as an
  // external same-origin script, without unsafe-inline or a fixed CSP nonce.
  await WebAppInternals.setInlineScriptsAllowed(false);
  await Events.rawCollection().createIndex({ at: 1 }, { expireAfterSeconds: 7 * 86400 });
  await Events.rawCollection().createIndex({ userId: 1, at: -1 });
});
