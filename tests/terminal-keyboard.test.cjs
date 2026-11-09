const { test } = require('node:test');
const assert = require('node:assert/strict');
const keyboard = import('../client/terminal-keyboard.mjs');

test('software keyboard sends letters and every shifted US keyboard symbol', async () => {
  const { terminalKey } = await keyboard;
  assert.equal(terminalKey('a'), 'a');
  assert.equal(terminalKey('a', { shift: true }), 'A');
  const keys = [..."`1234567890-=[]\\;',./"];
  const expected = [...'~!@#$%^&*()_+{}|:"<>?'];
  keys.forEach((key, index) => assert.equal(terminalKey(key, { shift: true }), expected[index], key));
  assert.equal(terminalKey('한'), '한');
  assert.equal(terminalKey('😀'), '😀');
  assert.equal(terminalKey('unknown'), '');
});

test('software modifiers encode shell control shortcuts and Alt combinations', async () => {
  const { terminalKey } = await keyboard;
  for (const [key, expected] of [['c', '\x03'], ['d', '\x04'], ['z', '\x1a'], ['[', '\x1b'], ['\\', '\x1c'],
    [']', '\x1d'], ['^', '\x1e'], ['_', '\x1f'], [' ', '\0'], ['2', '\0'], ['3', '\x1b'], ['8', '\x7f'], ['?', '\x7f']]) {
    assert.equal(terminalKey(key, { ctrl: true }), expected, `Ctrl+${key}`);
  }
  assert.equal(terminalKey('c', { ctrl: true, shift: true }), '\x03');
  assert.equal(terminalKey('b', { alt: true }), '\x1bb');
  assert.equal(terminalKey('x', { ctrl: true, alt: true }), '\x1b\x18');
});

test('navigation follows application cursor mode and encodes modifier parameters', async () => {
  const { terminalKey } = await keyboard;
  for (const [key, suffix] of [['ArrowUp', 'A'], ['ArrowDown', 'B'], ['ArrowRight', 'C'], ['ArrowLeft', 'D'], ['Home', 'H'], ['End', 'F']]) {
    assert.equal(terminalKey(key), `\x1b[${suffix}`);
    assert.equal(terminalKey(key, {}, { applicationCursorKeysMode: true }), `\x1bO${suffix}`);
    assert.equal(terminalKey(key, { ctrl: true }, { applicationCursorKeysMode: true }), `\x1b[1;5${suffix}`);
    assert.equal(terminalKey(key, { shift: true, alt: true, ctrl: true }), `\x1b[1;8${suffix}`);
  }
  for (const [key, code] of [['Insert', 2], ['Delete', 3], ['PageUp', 5], ['PageDown', 6]]) {
    assert.equal(terminalKey(key), `\x1b[${code}~`);
    assert.equal(terminalKey(key, { alt: true }), `\x1b[${code};3~`);
  }
});

test('F1 through F12 use terminal escape sequences, including modifiers', async () => {
  const { terminalKey } = await keyboard;
  ['P', 'Q', 'R', 'S'].forEach((suffix, index) => {
    assert.equal(terminalKey(`F${index + 1}`), `\x1bO${suffix}`);
    assert.equal(terminalKey(`F${index + 1}`, { shift: true }), `\x1b[1;2${suffix}`);
  });
  [15, 17, 18, 19, 20, 21, 23, 24].forEach((code, index) => {
    assert.equal(terminalKey(`F${index + 5}`), `\x1b[${code}~`);
    assert.equal(terminalKey(`F${index + 5}`, { ctrl: true }), `\x1b[${code};5~`);
  });
});

test('editing keys and native keyboard characters share the same encoding', async () => {
  const { terminalKey } = await keyboard;
  for (const [key, native] of [['Escape', '\x1b'], ['Tab', '\t'], ['Enter', '\r'], ['Backspace', '\x7f']]) {
    assert.equal(terminalKey(key), native);
    assert.equal(terminalKey(native, { alt: true }), terminalKey(key, { alt: true }));
  }
  assert.equal(terminalKey('Tab', { shift: true }), '\x1b[Z');
  assert.equal(terminalKey('Backspace', { ctrl: true }), '\b');
  assert.equal(terminalKey('Enter', { alt: true }), '\x1b\r');
});
