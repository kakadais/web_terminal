import React, { useEffect, useId, useState } from 'react';
import { shiftedCharacter } from './terminal-keyboard.mjs';
import './terminal-keyboard.css';

const shortcuts = [['Escape', 'Esc'], ['Tab', 'Tab'], ['ctrl', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift'],
  ['ArrowLeft', '←'], ['ArrowDown', '↓'], ['ArrowUp', '↑'], ['ArrowRight', '→']];
const names = { Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Enter: 'Enter', ' ': 'Space',
  ArrowLeft: '왼쪽 화살표', ArrowDown: '아래쪽 화살표', ArrowUp: '위쪽 화살표', ArrowRight: '오른쪽 화살표' };
const symbols = ['!@#$%^&*()', '[]{}<>/\\|`~', '-_+=;:\'",.?'];

export default function TerminalKeyboard({ connected, visible, mode, modifiers, onMode, onModifiers, onKey }) {
  const [layout, setLayout] = useState('letters');
  const panelId = useId();
  const expanded = mode === 'full';

  // iOS and Android can resize only the visual viewport when the native keyboard
  // opens. Keep the terminal and key bar inside that usable area.
  useEffect(() => {
    if (!visible || !window.visualViewport) return;
    const workspace = document.querySelector('.workspace');
    const viewport = window.visualViewport;
    const resize = () => {
      if (viewport.scale === 1) workspace?.style.setProperty('--terminal-viewport-height', `${viewport.height}px`);
    };
    resize(); viewport.addEventListener('resize', resize);
    return () => { viewport.removeEventListener('resize', resize); workspace?.style.removeProperty('--terminal-viewport-height'); };
  }, [visible]);

  // Let a finger scroll the shortcut strip without stealing focus from xterm.
  const keepFocus = event => event.preventDefault();
  const keyButton = (key, label = key, extra = '') => {
    const modifier = Object.hasOwn(modifiers, key);
    const display = !modifier && key.length === 1 && modifiers.shift ? shiftedCharacter(key) : label;
    return <button type="button" key={key} className={`terminal-key ${modifier ? 'modifier' : ''} ${extra}`}
      aria-label={modifier ? label : (names[key] || display)} aria-pressed={modifier ? modifiers[key] : undefined}
      disabled={!connected} onPointerDown={keepFocus}
      onClick={() => modifier ? onModifiers({ ...modifiers, [key]: !modifiers[key] }) : onKey(key)}>{display}</button>;
  };
  const row = text => <div className="terminal-keyboard-row" key={text}>{[...text].map(key => keyButton(key))}</div>;

  return <div className={`terminal-keyboard ${expanded ? 'expanded' : ''}`} aria-label="터미널 키보드">
    <div className="terminal-keyboard-bar">
      <div className="terminal-keyboard-shortcuts" role="group" aria-label="터미널 특수 키">{shortcuts.map(([key, label]) => keyButton(key, label))}</div>
      <button type="button" className="terminal-keyboard-toggle" aria-expanded={expanded} aria-controls={panelId}
        onPointerDown={keepFocus} onClick={() => onMode(expanded ? 'native' : 'full')}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 15h10" /></svg>
        <span>{expanded ? '기본 키보드' : '전체 키보드'}</span>
      </button>
    </div>
    {expanded && <div className="terminal-keyboard-panel" id={panelId}>
      <div className="terminal-keyboard-layouts" role="group" aria-label="키보드 배열">
        {[['letters', 'ABC'], ['symbols', '#+='], ['functions', 'F1–F12']].map(([value, label]) => <button type="button" key={value}
          aria-pressed={layout === value} onPointerDown={keepFocus} onClick={() => setLayout(value)}>{label}</button>)}
        <span>Ctrl · Alt · Shift는 다음 키에 적용</span>
      </div>
      <div className="terminal-keyboard-keys" role="group" aria-label={layout === 'letters' ? '영문 키' : layout === 'symbols' ? '기호 키' : '기능 및 이동 키'}>
        {layout === 'letters' && <>{row('1234567890')}{row('qwertyuiop')}{row('asdfghjkl')}
          <div className="terminal-keyboard-row">{[...'zxcvbnm'].map(key => keyButton(key))}{keyButton('Backspace', '⌫', 'wide')}</div></>}
        {layout === 'symbols' && <>{symbols.map(row)}<div className="terminal-keyboard-row">{keyButton('Tab', 'Tab')}{keyButton('Escape', 'Esc')}{keyButton('Backspace', '⌫', 'wide')}{keyButton('Delete', 'Del')}</div></>}
        {layout === 'functions' && <><div className="terminal-keyboard-function-grid">{Array.from({ length: 12 }, (_, index) => keyButton(`F${index + 1}`))}</div>
          <div className="terminal-keyboard-function-grid">{['Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown'].map((key, index) => keyButton(key, ['Ins', 'Del', 'Home', 'End', 'PgUp', 'PgDn'][index]))}</div>
          <div className="terminal-keyboard-row">{keyButton('Backspace', '⌫')}{keyButton('Escape', 'Esc')}{keyButton('Tab', 'Tab')}</div></>}
        <div className="terminal-keyboard-row">{keyButton('/', '/')}{keyButton('-', '-')}{keyButton(' ', 'Space', 'space')}{keyButton('.', '.')}{keyButton('Enter', '↵', 'enter wide')}</div>
      </div>
    </div>}
  </div>;
}
