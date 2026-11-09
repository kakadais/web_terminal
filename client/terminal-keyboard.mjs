const escape = '\x1b';
const shifted = Object.fromEntries([..."`1234567890-=[]\\;',./"].map((key, index) => [key, '~!@#$%^&*()_+{}|:"<>?'[index]]));
const cursorKeys = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
const editingKeys = { Insert: 2, Delete: 3, PageUp: 5, PageDown: 6 };
const functionKeys = { F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24 };
const nativeKeys = { '\r': 'Enter', '\t': 'Tab', '\x7f': 'Backspace', '\x1b': 'Escape' };

export const emptyModifiers = () => ({ ctrl: false, alt: false, shift: false });
export const hasModifiers = modifiers => modifiers.ctrl || modifiers.alt || modifiers.shift;
export const shiftedCharacter = key => shifted[key] || (/^[a-z]$/.test(key) ? key.toUpperCase() : key);

// Match xterm's PC-style keyboard sequences, including application cursor mode.
export function terminalKey(key, modifiers = {}, modes = {}) {
  key = nativeKeys[key] || key;
  const { ctrl = false, alt = false, shift = false } = modifiers;
  const modifier = 1 + Number(shift) + 2 * Number(alt) + 4 * Number(ctrl);
  if (cursorKeys[key]) return modifier > 1 ? `${escape}[1;${modifier}${cursorKeys[key]}`
    : `${escape}${modes.applicationCursorKeysMode ? 'O' : '['}${cursorKeys[key]}`;
  if (editingKeys[key] || functionKeys[key]) return `${escape}[${editingKeys[key] || functionKeys[key]}${modifier > 1 ? `;${modifier}` : ''}~`;
  if (/^F[1-4]$/.test(key)) {
    const suffix = 'PQRS'[Number(key.slice(1)) - 1];
    return modifier > 1 ? `${escape}[1;${modifier}${suffix}` : `${escape}O${suffix}`;
  }
  if (key === 'Tab') return shift ? `${escape}[Z` : '\t';
  if (key === 'Escape') return alt ? escape + escape : escape;
  if (key === 'Enter') return `${alt ? escape : ''}\r`;
  if (key === 'Backspace') return `${alt ? escape : ''}${ctrl ? '\b' : '\x7f'}`;
  if ([...key].length !== 1) return '';
  let character = shift ? shiftedCharacter(key) : key;
  if (ctrl) {
    const upper = character.toUpperCase();
    if (/^[A-Z@\[\\\]_^]$/.test(upper)) character = String.fromCharCode(upper.charCodeAt(0) & 31);
    else if (character === ' ' || character === '2') character = '\0';
    else if (/^[3-7]$/.test(character)) character = String.fromCharCode(Number(character) + 24);
    else if (character === '?' || character === '8') character = '\x7f';
  }
  return `${alt ? escape : ''}${character}`;
}
