const { test } = require('node:test');
const assert = require('node:assert/strict');
const { authenticator, tokenCounter, recoveryCodes, recoveryHash, validNewPassword, FailureLimiter } = require('../lib/auth-security.cjs');

test('password policy rejects API bypasses, including UTF-16 length tricks and whitespace-only input', () => {
  for (const value of [null, {}, 123, '', 'a'.repeat(14), ' '.repeat(15), '😀'.repeat(8), 'a'.repeat(201)]) assert.equal(validNewPassword(value), false);
  for (const value of ['a'.repeat(15), 'a'.repeat(200), '😀'.repeat(15), '한글과 공백을 포함하는 긴 비밀번호']) assert.equal(validNewPassword(value), true);
});

test('TOTP accepts only the current time window and returns a counter for atomic replay rejection', () => {
  const otp=authenticator(null,'example'), now=1800000000000;
  for(const offset of [-1,0,1]) {
    const code=otp.generate({ timestamp:now+offset*30000 });
    assert.equal(tokenCounter(otp.secret.base32,code,now),Math.floor(now/30000)+offset);
  }
  assert.equal(tokenCounter(otp.secret.base32,otp.generate({timestamp:now-90000}),now),null);
  for(const code of ['',null,12,'0123456','12345x']) assert.equal(tokenCounter(otp.secret.base32,code,now),null);
});
test('recovery codes are unique 128-bit tokens and only hashes are stored', () => {
  const codes=recoveryCodes();assert.equal(new Set(codes).size,10);
  for(const code of codes) {
    assert.match(code,/^[a-f0-9]{8}(-[a-f0-9]{8}){3}$/);
    assert.match(recoveryHash(code),/^[a-f0-9]{64}$/);
    assert.equal(recoveryHash(code.toUpperCase().replace(/-/g,'')),recoveryHash(code));
  }
  for(const code of ['000000','',null,'a'.repeat(33)]) assert.equal(recoveryHash(code),null);
});
test('failed account attempts are bounded, expire without extension, and reset after success', () => {
  const limiter=new FailureLimiter({limit:2,windowMs:100,maxEntries:2});
  limiter.fail('a',0);limiter.fail('a',1);assert.equal(limiter.blocked('a',2),true);
  limiter.fail('a',50);assert.equal(limiter.blocked('a',100),false);
  limiter.fail('a',101);limiter.clear('a');assert.equal(limiter.blocked('a',102),false);
  for(const key of ['a','b','c'])limiter.fail(key,110);
  assert.equal(limiter.entries.size,2);
});
