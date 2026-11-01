// Pre-commit guard. Never include the matched value in errors or logs.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const dotenv = require('dotenv');
const git = args => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).toString().split('\0').filter(Boolean);
const secrets = new Set();
for (const filename of ['.env', '.env.local']) {
  if (!fs.existsSync(filename)) continue;
  for (const [key, value] of Object.entries(dotenv.parse(fs.readFileSync(filename)))) {
    if (/PASSWORD|TOKEN|SECRET|PRIVATE_KEY|ENCRYPTION_KEY/.test(key) && value.length >= 8 && value !== 'CHANGE_ME') secrets.add(value);
    if (key === 'MONGO_URL') {
      try {
        const encoded = new URL(value).password;
        const password = decodeURIComponent(encoded);
        if (password.length >= 8) { secrets.add(value); secrets.add(encoded); secrets.add(password); }
      } catch (_) { /* Validation is handled by the launcher. */ }
    }
  }
}
let failed = false;
for (const filename of names) {
  const contents = git(['show', `:${filename}`]);
  const text = contents.toString('utf8');
  const privateFile = /(^|\/)\.env(?:\.|$)/.test(filename) && !filename.endsWith('.env.example')
    || /(^|\/)(?:id_rsa|id_ed25519)(?:$|\.)|\.(?:key|p12|pfx)$/.test(filename);
  const privateKey = /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/.test(text);
  const literal = [...text.matchAll(/(?:TERM_TOKEN|ADMIN_PASSWORD)\s*(?:=|:|\|\|)\s*["']([^"'\r\n]{8,})["']/gi)]
    .some(match => !['CHANGE_ME', 'YOUR_PASSWORD'].includes(match[1]));
  if (privateFile || privateKey || literal || [...secrets].some(secret => contents.includes(Buffer.from(secret)))) {
    console.error(`Possible secret in staged file: ${filename}. Move it to an ignored secret file; no values were printed.`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`Secret guard: ${names.length} staged files checked.`);
