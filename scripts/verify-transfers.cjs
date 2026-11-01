// End-to-end checks against real trzsz-go on the deployment SSH host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const { quoteShell } = require('../lib/ssh-connection.cjs');
const env = { ...require('dotenv').parse(fs.readFileSync(process.env.ENV_FILE || path.resolve(__dirname, '../.env.local'))), ...process.env };
const target = env.VERIFY_URL || 'http://127.0.0.1:5176';
const remote = script => execFileSync('ssh', ['-o', 'BatchMode=yes', 'server', 'python3 -'], { input: script, encoding: 'utf8', timeout: 30000 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function wait(predicate, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}

(async () => {
  const fixture = JSON.parse(remote("import tempfile,os,json,hashlib\np=tempfile.mkdtemp(prefix='web-terminal-trzsz-')\nfiles={}\nfor name,size in [('large.bin',16777216),('한글 공백.bin',65537),('empty.bin',0)]:\n b=os.urandom(size)\n open(os.path.join(p,name),'wb').write(b)\n files[name]=hashlib.sha256(b).hexdigest()\nprint(json.dumps({'path':p,'files':files}))\n"));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-download-'));
  const browser = await chromium.launch({ headless: true, executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
  const errors = []; let output = ''; let ready = false; let outputBytes = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().includes('/terminal/ws')) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'ready') ready = true;
      if (message.type === 'output') { output = (output + message.data).slice(-65536); outputBytes += message.data.length; }
      if (message.type === 'error') errors.push(message.message);
    });
  });
  const input = async text => {
    await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus();
    await page.keyboard.type(text); await page.keyboard.press('Enter');
  };
  const prompt = async () => {
    const nonce = crypto.randomBytes(8).toString('hex');
    await input(`printf '\\nREADY_%s\\n' ${nonce}`);
    await wait(() => output.includes(`READY_${nonce}`), 'shell recovered');
  };
  const panel = page.getByRole('status', { name: 'trzsz 파일 전송', exact: true });
  try {
    await page.goto(target, { waitUntil: 'networkidle' });
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    // hasText anchors avoid ambiguity between the pinned local row and SSH alias.
    const selectedRow = env.VERIFY_LOCAL === '1' ? page.locator('.server-row[data-source=local]') : page.locator('.server-row[data-source=config]').filter({ has: page.locator('strong', { hasText: /^server$/ }) });
    await selectedRow.locator('.server-connect').click(); await wait(() => ready, 'terminal ready');
    await delay(1500); await prompt();
    await input(`cd -- ${quoteShell(fixture.path)}`); await prompt();

    const downloadFiles = async (names, flags = '') => {
      const downloads = []; const listener = item => downloads.push(item); page.on('download', listener);
      try {
        await input(`tsz ${flags} ${names.map(quoteShell).join(' ')}`);
        await panel.getByRole('button', { name: '파일 받기', exact: true }).click({ timeout: 20000 });
        await wait(() => downloads.length === names.length, 'browser download started', 60000);
        for (const download of downloads) {
          const saved = path.join(temporary, download.suggestedFilename());
          await download.saveAs(saved); assert.equal(await download.failure(), null);
          assert.equal(hash(fs.readFileSync(saved)), fixture.files[download.suggestedFilename()]);
        }
        await panel.getByText(/전송 완료/).waitFor({ timeout: 60000 });
        await delay(1000); await prompt(); console.log('PASS browser download', names.join(', '), flags);
      } finally { page.off('download', listener); }
    };
    await downloadFiles(['large.bin']);
    await downloadFiles(['한글 공백.bin', 'empty.bin'], '-b');

    const upload = crypto.randomBytes(2 * 1024 * 1024 + 1);
    await input('trz'); await panel.getByRole('button', { name: '업로드할 파일 선택' }).waitFor();
    await page.locator('input[aria-label="trz 업로드 파일"]').setInputFiles([
      { name: 'uploaded 한글.bin', mimeType: 'application/octet-stream', buffer: upload },
      { name: 'uploaded-empty.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(0) },
    ]);
    await panel.getByText(/파일 업로드를 완료/).waitFor({ timeout: 60000 }); await delay(1000); await prompt();
    const uploaded = JSON.parse(remote(`import json,hashlib,os\np=${JSON.stringify(fixture.path)}\nprint(json.dumps({n:hashlib.sha256(open(os.path.join(p,n),'rb').read()).hexdigest() for n in ['uploaded 한글.bin','uploaded-empty.bin']}))\n`));
    assert.equal(uploaded['uploaded 한글.bin'], hash(upload)); assert.equal(uploaded['uploaded-empty.bin'], hash(Buffer.alloc(0)));
    console.log('PASS multi-file browser upload with Unicode and empty file');

    const folder = path.join(temporary, 'folder-upload'); fs.mkdirSync(path.join(folder, 'nested'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'nested', '한글.txt'), 'nested folder upload');
    await input('trz -d'); await panel.getByRole('button', { name: '업로드할 폴더 선택' }).waitFor();
    await page.locator('input[aria-label="trz 업로드 파일"]').setInputFiles(folder);
    await panel.getByText(/파일 업로드를 완료/).waitFor({ timeout: 60000 }); await delay(1000); await prompt();
    assert.equal(remote(`from pathlib import Path\nprint(Path(${JSON.stringify(fixture.path + '/folder-upload/nested/한글.txt')}).read_text(),end='')\n`), 'nested folder upload');
    console.log('PASS nested folder upload');

    await input('trz'); await panel.getByRole('button', { name: '업로드할 파일 선택' }).waitFor();
    await panel.getByRole('button', { name: '취소', exact: true }).click(); await delay(1000); await prompt();
    console.log('PASS cancel before file selection and shell reuse');

    await input('tsz large.bin');
    const cancelled = page.waitForEvent('download');
    await panel.getByRole('button', { name: '파일 받기', exact: true }).click();
    await (await cancelled).cancel();
    await panel.locator('.upload-error').waitFor({ timeout: 30000 }); await delay(1000); await prompt();
    console.log('PASS browser download cancellation and shell reuse');
    await page.screenshot({ path: path.resolve(__dirname, '../.deploy/transfer-verification.png') });
    assert.deepEqual(errors, []); console.log(JSON.stringify({ target, outputBytes, pageErrors: errors.length, result: 'PASS' }));
  } catch (error) {
    console.error('Transfer UI:', await panel.innerText().catch(() => 'none'));
    console.error('Page errors:', errors);
    throw error;
  } finally {
    await browser.close(); fs.rmSync(temporary, { recursive: true, force: true });
    remote(`import shutil\nshutil.rmtree(${JSON.stringify(fixture.path)})\n`);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
