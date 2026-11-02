const crypto = require('node:crypto');
const OTPAuth = require('otpauth');

function authenticator(secret, username = '') {
  return new OTPAuth.TOTP({ issuer: 'DIGIX Terminal', label: username, algorithm: 'SHA1', digits: 6, period: 30,
    secret: secret || new OTPAuth.Secret({ size: 20 }) });
}
function tokenCounter(secret, token, now = Date.now()) {
  if (typeof token !== 'string' || !/^\d{6}$/.test(token)) return null;
  const delta = authenticator(secret).validate({ token, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
}
function recoveryHash(code) {
  if (typeof code !== 'string') return null;
  const normalized = code.trim().replace(/-/g, '').toLowerCase();
  if (!/^[a-f0-9]{32}$/.test(normalized)) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
function recoveryCodes() {
  return Array.from({ length: 10 }, () => crypto.randomBytes(16).toString('hex').match(/.{8}/g).join('-'));
}
function validNewPassword(value) {
  return typeof value === 'string' && value.length <= 200 && [...value].length >= 15 && value.trim().length > 0;
}

// Fixed windows do not extend a lock when an attacker keeps trying. Bound memory,
// including unknown account names; the DDP limiter also caps work before hashing.
class FailureLimiter {
  constructor({ limit = 20, windowMs = 10 * 60_000, maxEntries = 10_000 } = {}) {
    Object.assign(this, { limit, windowMs, maxEntries, entries: new Map() });
  }
  blocked(key, now = Date.now()) {
    const item = this.entries.get(key);
    if (item && item.until <= now) this.entries.delete(key);
    return Boolean(item && item.until > now && item.count >= this.limit);
  }
  fail(key, now = Date.now()) {
    let item = this.entries.get(key);
    if (!item || item.until <= now) {
      if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value);
      item = { count: 0, until: now + this.windowMs }; this.entries.set(key, item);
    }
    item.count += 1;
  }
  clear(key) { this.entries.delete(key); }
}
module.exports = { authenticator, tokenCounter, recoveryHash, recoveryCodes, validNewPassword, FailureLimiter };
