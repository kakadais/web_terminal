const crypto = require('node:crypto');

function encrypt(value, hexKey) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') };
}

function decrypt(value, hexKey) {
  if (!value) return '';
  if (value.version !== 1) throw new Error('Unknown credential format');
  const cipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(hexKey, 'hex'), Buffer.from(value.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return Buffer.concat([cipher.update(Buffer.from(value.data, 'base64')), cipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
