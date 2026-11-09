// Real mobile-browser keyboard verification against a local development server.
// Only opens the pinned local terminal; does not edit SSH configuration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const dotenv = require('dotenv');
const { quoteShell } = require('../lib/ssh-connection.cjs');

const root = path.resolve(__dirname, '..');
const env = { ...dotenv.parse(fs.readFileSync(process.env.ENV_FILE || path.join(root, '.env.local'))), ...process.env };
const target = env.VERIFY_URL || 'http://127.0.0.1:5160';
const out = path.join(root, 'test-results');
async function wait(predicate, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({ headless: true,
    executablePath: env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  let output = ''; let ready = false; let closed = false; let receivedOffset = 0; let acknowledgedOffset = 0;
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => {
    if (!socket.url().includes('/terminal/ws')) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'output') { output += message.data; receivedOffset = message.offset || receivedOffset; }
      if (message.type === 'ready') ready = true;
      if (message.type === 'error') errors.push(message.message);
    });
    socket.on('framesent', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'output-ack') acknowledgedOffset = message.offset;
    });
    socket.on('close', () => { closed = true; });
  });
  const pane = page.locator('.terminal-pane.visible');
  const textarea = pane.locator('.xterm-helper-textarea');
  const keyboard = pane.locator('.terminal-keyboard');
  const shortcuts = keyboard.getByRole('group', { name: '터미널 특수 키', exact: true });
  const key = name => keyboard.locator('.terminal-keyboard-keys').getByRole('button', { name, exact: true });
  const shortcut = name => shortcuts.getByRole('button', { name, exact: true });
  const layout = name => keyboard.getByRole('group', { name: '키보드 배열', exact: true }).getByRole('button', { name, exact: true }).tap();
  const input = async text => { await textarea.focus(); await page.keyboard.type(text); await page.keyboard.press('Enter'); };
  const rawKeys = async (expected, action, application = false) => {
    const nonce = crypto.randomBytes(6).toString('hex');
    const offset = output.length;
    const code = `import os,sys,tty,termios,select,time
fd=sys.stdin.fileno()
old=termios.tcgetattr(fd)
data=b''
try:
 tty.setraw(fd)
 print('\\x1b[?1${application ? 'h' : 'l'}READY_'+'${nonce}', flush=True)
 deadline=time.monotonic()+30
 while len(data)<${Buffer.byteLength(expected)} and time.monotonic()<deadline:
  if select.select([fd],[],[],0.1)[0]: data+=os.read(fd,${Buffer.byteLength(expected)}-len(data))
finally:
 termios.tcsetattr(fd,termios.TCSADRAIN,old)
 print('\\x1b[?1l\\r\\nKEYS_'+'${nonce}:'+data.hex(),flush=True)`;
    await input(`python3 -c ${quoteShell(code)}`);
    await wait(() => output.slice(offset).includes(`READY_${nonce}`), 'raw terminal reader');
    // The server can deliver output before xterm has parsed it. Wait for the
    // client's acknowledgement so application cursor mode is ready for input.
    const markerOffset = receivedOffset;
    await wait(() => acknowledgedOffset >= markerOffset, 'terminal parses keyboard mode');
    await action();
    const expectedHex = Buffer.from(expected).toString('hex');
    const result = () => output.slice(offset).match(new RegExp(`KEYS_${nonce}:([0-9a-f]*)\\r?\\n`));
    await wait(() => result(), 'raw keyboard bytes');
    assert.equal(result()[1], expectedHex, 'Software keys must reach the PTY as exact terminal bytes');
  };

  try {
    await page.goto(target, { waitUntil: 'networkidle' });
    await page.getByLabel('아이디', { exact: true }).fill(env.ADMIN_USERNAME);
    await page.getByLabel('비밀번호', { exact: true }).fill(env.ADMIN_PASSWORD);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await page.getByRole('button', { name: '☰', exact: true }).tap();
    const local = page.locator('.server-row[data-source=local]');
    await local.locator('.server-connect').tap();
    await wait(() => ready, 'local terminal');
    await wait(() => /[$#%➜>]\s/.test(output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')), 'shell prompt');
    assert.equal(await textarea.getAttribute('inputmode'), 'text');
    await keyboard.getByRole('button', { name: '전체 키보드', exact: true }).tap();
    assert.equal(await textarea.getAttribute('inputmode'), 'none');

    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const screen = await pane.locator('.terminal-screen').boundingBox();
      assert.ok(screen.height > 60, `Terminal stays usable at ${size.width}×${size.height}: ${screen.height}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'No horizontal page overflow');
      await key('Enter').scrollIntoViewIfNeeded();
      const enter = await key('Enter').boundingBox();
      assert.ok(enter.y + enter.height <= size.height, 'Enter stays reachable inside the viewport');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await rawKeys('a!\x03\x1bb\x1b[Z\x7f\r\x1b[D\x1bOP\x1b[15~\x1b[24~\x1b[3~\x1b[5~', async () => {
      await layout('ABC'); await key('a').tap();
      await shortcut('Shift').tap(); await key('!').tap();
      assert.equal(await shortcut('Shift').getAttribute('aria-pressed'), 'false');
      await shortcut('Ctrl').tap(); await key('c').tap();
      assert.equal(await shortcut('Ctrl').getAttribute('aria-pressed'), 'false');
      await shortcut('Alt').tap(); await key('b').tap();
      await shortcut('Shift').tap(); await shortcut('Tab').tap();
      await key('Backspace').tap(); await key('Enter').tap(); await shortcut('왼쪽 화살표').tap();
      await layout('F1–F12');
      for (const name of ['F1', 'F5', 'F12', 'Del', 'PgUp']) await key(name).tap();
    });
    await rawKeys('\x1bOA\x1bOH\x1b[1;5C\x1b[1;2P', async () => {
      await shortcut('위쪽 화살표').tap(); await key('Home').tap();
      await shortcut('Ctrl').tap(); await shortcut('오른쪽 화살표').tap();
      await shortcut('Shift').tap(); await key('F1').tap();
    }, true);
    await layout('#+=');
    await rawKeys('`~[]{}\\|<>_$', async () => {
      for (const name of ['`', '~', '[', ']', '{', '}', '\\', '|', '<', '>', '_', '$']) await key(name).tap();
    });
    await layout('ABC');
    await page.screenshot({ path: path.join(out, 'mobile-keyboard.png') });
    await keyboard.getByRole('button', { name: '기본 키보드', exact: true }).tap();
    assert.equal(await textarea.getAttribute('inputmode'), 'text');
    await rawKeys('c한글', async () => {
      await shortcut('Ctrl').tap();
      await textarea.evaluate(element => {
        const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', 'c');
        element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
      });
      assert.equal(await shortcut('Ctrl').getAttribute('aria-pressed'), 'false', 'Paste clears pending modifiers');
      await shortcut('Ctrl').tap(); await page.keyboard.insertText('한글');
      assert.equal(await shortcut('Ctrl').getAttribute('aria-pressed'), 'false', 'Native text composition clears pending modifiers');
    });
    const nonce = crypto.randomBytes(6).toString('hex');
    await input(`printf 'SLEEP_%s\\n' ${nonce}; sleep 30`);
    await wait(() => output.includes(`SLEEP_${nonce}`), 'foreground command');
    await shortcut('Ctrl').tap();
    assert.equal(await textarea.evaluate(element => document.activeElement === element), true, 'Touching a modifier preserves native terminal focus');
    await page.keyboard.type('c');
    await input(`printf 'INTERRUPTED_%s\\n' ${nonce}`);
    await wait(() => output.includes(`INTERRUPTED_${nonce}`), 'native keyboard Ctrl+C interrupts the command');
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await textarea.getAttribute('inputmode'), 'text');
    await input('exit');
    await wait(() => closed, 'terminal closes');
    assert.equal(await keyboard.locator('.terminal-key:enabled').count(), 0, 'Closed terminals disable software input');
    assert.deepEqual(errors, []);
    console.log('Mobile keyboard: touch, raw PTY bytes, symbols, F1–F12, modifiers, application cursor mode, portrait/landscape layout, native Ctrl+C and disconnect passed');
  } catch (error) {
    await page.screenshot({ path: path.join(out, 'mobile-keyboard-failure.png') }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
