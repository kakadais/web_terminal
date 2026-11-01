// Focused real-browser terminal verification; does not edit SSH configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { chromium } = require('playwright-core');
const dotenv = require('dotenv');
const { quoteShell } = require('../lib/ssh-connection.cjs');

const root = path.resolve(__dirname, '..');
const env = { ...dotenv.parse(fs.readFileSync(process.env.ENV_FILE || path.join(root, '.env.local'))), ...process.env };
const target = env.VERIFY_URL || env.ROOT_URL;
async function wait(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}
function gone(pid) { try { process.kill(pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-terminal-browser 한글 '));
  const browser = await chromium.launch({ headless: true,
    executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; const sockets = []; const localPids = [];
  let active;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().includes('/terminal/ws')) return;
    const state = { output: '', ready: false, closed: false, resize: null };
    sockets.push(state);
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'output') state.output += message.data;
      if (message.type === 'ready') state.ready = true;
      if (message.type === 'error') errors.push(message.message);
    });
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'resize') state.resize = message;
    });
    socket.on('close', () => { state.closed = true; });
  });
  const input = async text => {
    await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus();
    await page.keyboard.type(text); await page.keyboard.press('Enter');
  };
  const command = async text => {
    const nonce = crypto.randomBytes(8).toString('hex');
    const offset = active.output.length;
    await input(`${text}; printf '\\nWT_OK_%s\\n' ${nonce}`);
    await wait(() => active.output.slice(offset).includes(`WT_OK_${nonce}`), 'shell command');
    return active.output.slice(offset);
  };
  const open = async row => {
    const count = sockets.length;
    await row.locator('.server-connect').click();
    await wait(() => sockets.length > count && sockets.at(-1).ready, 'terminal ready');
    active = sockets.at(-1);
    await wait(() => /[$#%➜>]\s/.test(active.output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), 'shell prompt');
  };
  const close = async name => {
    await page.getByRole('button', { name: `${name} 연결 종료`, exact: true }).click();
    await wait(() => active.closed, 'terminal close');
  };
  try {
    assert.equal((await fetch(new URL('/health', target))).status, 200);
    await page.goto(target, { waitUntil: 'networkidle' });
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const local = page.locator('.server-row[data-source=local]');
    await local.waitFor();
    const localName = await local.locator('strong').innerText();
    await open(local);
    const pidOutput = await command("printf '\\nSHELL_PID:%s\\n' \"$$\"");
    const pid = Number(pidOutput.match(/\r?\nSHELL_PID:(\d+)/)[1]);
    localPids.push(pid);
    // This script's local-file/process assertions require a server on this host.
    assert.ok(!gone(pid), 'Run this verifier against a dev server on this host');
    const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    assert.match(execFileSync('ps', ['-o', 'comm=', '-p', String(parent)], { encoding: 'utf8' }), /web-terminal-pty/);
    await command(`cd -- ${quoteShell(directory)}`);
    await input(`vim -Nu NONE -n -i NONE ${quoteShell(path.join(directory, 'tui.txt'))}`);
    await wait(() => active.output.includes('\x1b[?1049h'), 'Vim alternate screen');
    await page.keyboard.press('i');
    await page.keyboard.insertText('한글 Rust TUI');
    await page.keyboard.press('Enter');
    await page.keyboard.insertText('second line');
    await wait(() => active.output.includes('한글 Rust TUI'), 'TUI Unicode input');
    await page.setViewportSize({ width: 1024, height: 700 });
    await wait(() => active.resize?.cols < 100, 'browser resize');

    const bytes = crypto.randomBytes(8193);
    await page.locator('.terminal-pane.visible').evaluate((element, base64) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(base64), char => char.charCodeAt(0))], '한글 upload.bin'));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }, bytes.toString('base64'));
    await page.locator('.terminal-pane.visible .upload-item.done').waitFor({ timeout: 20000 });
    assert.equal(await page.locator('.terminal-pane.visible .upload-heading > span').innerText(), fs.realpathSync(directory));
    assert.deepEqual(fs.readFileSync(path.join(directory, '한글 upload.bin')), bytes);
    await page.locator('.terminal-pane.visible .xterm-helper-textarea').focus();
    await page.keyboard.press('Escape'); await input(':wq');
    await command('true');
    assert.equal(fs.readFileSync(path.join(directory, 'tui.txt'), 'utf8'), '한글 Rust TUI\nsecond line\n');
    const size = await command('stty size');
    assert.ok(size.includes(`${active.resize.rows} ${active.resize.cols}`));
    const nonce = crypto.randomBytes(8).toString('hex');
    await input(`printf 'RUN_%s\\n' ${nonce}; sleep 30`);
    await wait(() => active.output.includes(`RUN_${nonce}`), 'foreground command');
    await page.keyboard.press('Control+c');
    await command('true');
    await close(localName);
    await wait(() => gone(pid) && gone(parent), 'local shell and Rust helper cleanup');
    console.log('Browser: Rust PTY, Vim/Unicode, resize, Ctrl+C, upload during TUI, close cleanup passed');

    for (const alias of [env.VERIFY_CONFIG_ALIAS || 'nginx', env.VERIFY_JUMP_ALIAS].filter(Boolean)) {
      const row = page.locator('.server-row[data-source=config]').filter({ has: page.locator('strong', { hasText: new RegExp(`^${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
      await open(row);
      const output = await command("test -t 0 && test -t 1; stty size; printf 'SSH_%s\\n' VERIFIED");
      assert.ok(output.includes('SSH_VERIFIED'));
      await close(alias);
      console.log(`Browser SSH command passed: ${alias}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const pid of localPids) await wait(() => gone(pid), 'final local terminal cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
