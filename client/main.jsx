import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Meteor } from 'meteor/meteor';
import { Accounts } from 'meteor/accounts-base';
import { useTracker } from 'meteor/react-meteor-data';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import './main.css';
import { Servers, ConnectionHistory } from '../imports/api/collections';

const call = (name, ...args) => Meteor.callAsync(name, ...args);
const errorMessage = error => error?.reason || error?.message || '요청을 처리하지 못했습니다.';
const labels = { config: 'SSH config', password: '비밀번호', key: '개인 키' };

function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await Meteor.loginWithPasswordAsync(username.trim(), password); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <div className="login-glow" />
    <form className="login-card" onSubmit={submit}>
      <div className="brand-icon">&gt;_</div><span className="eyebrow">DIGIX WORKSPACE</span>
      <h1>Web Terminal</h1><p className="muted">서버에 연결하고, 한 곳에서 관리하세요.</p>
      <label>아이디<input autoFocus autoComplete="username" value={username} onChange={e => setUsername(e.target.value)} required /></label>
      <label>비밀번호<input type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required /></label>
      {error && <div role="alert" className="error">{error}</div>}
      <button className="primary full" disabled={busy}>{busy ? '로그인 중…' : '로그인'}</button>
      <div className="login-note">Secure access · SSH</div>
    </form>
  </main>;
}

function ServerDialog({ record, onClose, notify }) {
  const [form, setForm] = useState({ _id: record?._id, name: record?.name || '', host: record?.host || '',
    port: record?.port || 22, username: record?.username || '', authType: record?.authType || 'password',
    password: '', privateKey: '', passphrase: '', clearPassphrase: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (name, value) => setForm(previous => ({ ...previous, [name]: value }));
  const submit = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await call('servers.save', form); notify('서버 정보를 저장했습니다.'); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!window.confirm(`${record.name} 서버를 목록에서 삭제할까요?${record.source === 'config' ? '\nSSH config 서버는 다음 동기화 시 다시 추가됩니다.' : ''}`)) return;
    setBusy(true);
    try { await call('servers.remove', record._id); notify('서버를 삭제했습니다.'); onClose(); }
    catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  const upload = async event => {
    const file = event.target.files[0];
    if (!file) return;
    if (file.size > 65536) { setError('개인 키 파일은 64KB 이하로 등록해 주세요.'); return; }
    set('privateKey', await file.text());
  };
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="dialog" onSubmit={submit}>
      <div className="dialog-heading"><div><span className="eyebrow">SSH CONNECTION</span><h2>{record ? '서버 설정' : '새 서버 추가'}</h2></div><button type="button" className="icon-button" onClick={onClose} aria-label="닫기">×</button></div>
      <label>서버 이름<input value={form.name} onChange={e => set('name', e.target.value)} required maxLength={100} placeholder="예: production" /></label>
      <div className="form-row"><label className="grow">호스트<input value={form.host} onChange={e => set('host', e.target.value)} required disabled={record?.source === 'config'} placeholder="192.168.1.10 또는 example.com" /></label><label className="port-field">포트<input type="number" value={form.port} onChange={e => set('port', Number(e.target.value))} required min={1} max={65535} disabled={record?.source === 'config'} /></label></div>
      {record?.source === 'config' && <p className="hint">호스트와 포트는 SSH config 동기화로 갱신됩니다.{record.proxyJump && ` 경유 서버: ${record.proxyJump}`}</p>}
      <label>SSH 사용자<input value={form.username} onChange={e => set('username', e.target.value)} required placeholder="ubuntu" autoComplete="off" /></label>
      <label>인증 방식<select value={form.authType} onChange={e => set('authType', e.target.value)}>{record?.source === 'config' && <option value="config">SSH config의 키 / SSH agent</option>}<option value="password">아이디 + 비밀번호</option><option value="key">SSH 개인 키</option></select></label>
      {form.authType === 'password' && <label>SSH 비밀번호<input type="password" autoComplete="new-password" value={form.password} onChange={e => set('password', e.target.value)} required={!record?.hasPassword} placeholder={record?.hasPassword ? '저장된 비밀번호 유지 · 변경 시 입력' : ''} /></label>}
      {form.authType === 'key' && <><div className="key-heading"><label htmlFor="private-key">SSH 개인 키</label><label className="file-button">파일 선택<input type="file" onChange={upload} /></label></div>
        <textarea id="private-key" rows={5} value={form.privateKey} onChange={e => set('privateKey', e.target.value)} required={!record?.hasPrivateKey} placeholder={record?.hasPrivateKey ? '저장된 키 유지 · 변경할 개인 키를 붙여 넣거나 파일로 선택' : '-----BEGIN OPENSSH PRIVATE KEY-----'} spellCheck={false} />
        <label>키 암호 (선택)<input type="password" autoComplete="new-password" value={form.passphrase} onChange={e => set('passphrase', e.target.value)} placeholder={record?.hasPassphrase ? '저장된 키 암호 유지' : '암호 없는 키는 비워 두세요'} /></label>
        {record?.hasPassphrase && <label className="check-label"><input type="checkbox" checked={form.clearPassphrase} onChange={e => set('clearPassphrase', e.target.checked)} />저장된 키 암호 지우기</label>}
      </>}
      <p className="hint">접속 비밀번호와 개인 키는 암호화해 저장합니다.</p>
      {error && <div role="alert" className="error">{error}</div>}
      <div className="dialog-actions">{record && <button type="button" className="danger" onClick={remove} disabled={busy}>삭제</button>}<span className="grow" /><button type="button" onClick={onClose}>취소</button><button className="primary" disabled={busy}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </div>;
}

function PasswordDialog({ onClose, notify }) {
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async event => {
    event.preventDefault(); setError('');
    if (newPassword !== confirmation) { setError('새 비밀번호가 일치하지 않습니다.'); return; }
    setBusy(true);
    try { await new Promise((resolve, reject) => Accounts.changePassword(oldPassword, newPassword, error => error ? reject(error) : resolve())); notify('로그인 비밀번호를 변경했습니다.'); onClose(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <div className="modal-backdrop"><form className="dialog compact" onSubmit={submit}><div className="dialog-heading"><h2>로그인 비밀번호 변경</h2><button type="button" className="icon-button" onClick={onClose}>×</button></div>
    <label>현재 비밀번호<input type="password" value={oldPassword} onChange={e => setOldPassword(e.target.value)} autoComplete="current-password" required /></label>
    <label>새 비밀번호<input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)} autoComplete="new-password" required minLength={10} maxLength={200} /></label>
    <label>새 비밀번호 확인<input type="password" value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="new-password" required /></label>
    <p className="hint">초기 환경변수의 비밀번호는 기존 계정의 비밀번호를 재설정하지 않습니다.</p>
    {error && <div className="error" role="alert">{error}</div>}<button className="primary full" disabled={busy}>변경</button>
  </form></div>;
}

function TerminalPane({ record, visible, attempt, onStatus }) {
  const container = useRef(null);
  useEffect(() => {
    const terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: 10000, theme: { background: '#0b1018', foreground: '#d7e1ec', cursor: '#64d3b0', selectionBackground: '#294858' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current);
    let socket; let disposed = false; let finished = false;
    const status = value => { if (!disposed) onStatus(record._id, value); };
    const resize = () => {
      if (!container.current?.clientWidth || !container.current?.clientHeight) return;
      fit.fit();
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
    };
    const observer = new ResizeObserver(resize); observer.observe(container.current);
    const input = terminal.onData(data => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); });
    terminal.writeln(`\x1b[38;2;100;211;176mConnecting to ${record.name}…\x1b[0m`);
    status('connecting'); resize();
    call('terminal.open', record._id).then(grant => {
      if (disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}${grant.path}`);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket, cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'ready') { status('connected'); resize(); terminal.focus(); }
        else if (message.type === 'exit') {
          finished = true; status('closed'); terminal.writeln(`\r\n\x1b[90mSSH 연결 종료 (exit ${message.exitCode})\x1b[0m`);
        } else if (message.type === 'error') { status('error'); terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`); }
      };
      socket.onerror = () => { status('error'); terminal.writeln('\r\n터미널 연결에 실패했습니다.'); };
      socket.onclose = () => { if (!disposed && !finished) { status('closed'); terminal.writeln('\r\n\x1b[90m연결이 종료되었습니다. 다시 연결할 수 있습니다.\x1b[0m'); } };
    }).catch(error => { if (!disposed) { status('error'); terminal.writeln(`\r\n${errorMessage(error)}`); } });
    return () => {
      disposed = true; observer.disconnect(); input.dispose(); socket?.close(1000, 'Tab closed'); terminal.dispose();
    };
  }, [record._id, attempt]);
  return <div className={`terminal-pane ${visible ? 'visible' : ''}`} ref={container} aria-label={`${record.name} 터미널`} />;
}

function Workspace({ user }) {
  const { records, history, loading, online } = useTracker(() => {
    const servers = Meteor.subscribe('servers'); const connections = Meteor.subscribe('connectionHistory');
    return { records: Servers.find({}, { sort: { name: 1 } }).fetch(), history: ConnectionHistory.find({}, { sort: { startedAt: -1 }, limit: 10 }).fetch(),
      loading: !servers.ready() || !connections.ready(), online: Meteor.status().connected };
  });
  const [search, setSearch] = useState('');
  const [dialog, setDialog] = useState(null);
  const [tabs, setTabs] = useState([]);
  const [active, setActive] = useState(null);
  const [statuses, setStatuses] = useState({});
  const [attempts, setAttempts] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const notify = message => setNotice(message);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6000); return () => clearTimeout(timer); }, [notice]);
  const updateStatus = (id, value) => setStatuses(previous => ({ ...previous, [id]: value }));
  const connect = record => {
    if (record.source === 'config' && !record.configAvailable) { notify('SSH config에 없는 서버입니다. 동기화 후 확인해 주세요.'); return; }
    setTabs(previous => previous.some(item => item._id === record._id) ? previous : [...previous, record]);
    setActive(record._id); setSidebarOpen(false);
  };
  const close = id => {
    const next = tabs.filter(record => record._id !== id); setTabs(next);
    if (active === id) setActive(next.at(-1)?._id || null);
  };
  const sync = async () => {
    setSyncing(true);
    try { const result = await call('servers.sync'); notify(`${result.imported}개 서버를 동기화했습니다.${result.skipped.length ? ` 제외: ${result.skipped.join(', ')}` : ''}`); }
    catch (error) { notify(errorMessage(error)); }
    finally { setSyncing(false); }
  };
  const logout = async () => {
    setTabs([]); setActive(null);
    try { await call('terminal.closeAll'); } catch (_) {}
    Meteor.logout();
  };
  const filtered = records.filter(record => `${record.name} ${record.host} ${record.username}`.toLowerCase().includes(search.toLowerCase()));
  const selected = tabs.find(record => record._id === active);
  return <div className="workspace">
    <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
      <div className="sidebar-brand"><span className="brand-icon small">&gt;_</span><div><strong>Web Terminal</strong><span>DIGIX WORKSPACE</span></div><button className="icon-button mobile-only" onClick={() => setSidebarOpen(false)}>×</button></div>
      <div className="section-heading"><span>서버 <b>{records.length}</b></span><div className="toolbar"><button onClick={sync} disabled={syncing || !online} title="SSH config 동기화" className="sync-button">{syncing ? '동기화 중…' : '↻ Sync'}</button><button className="icon-button add-button" onClick={() => setDialog({ type: 'server' })} aria-label="새 서버 추가">+</button></div></div>
      <div className="search-box"><span>⌕</span><input aria-label="서버 검색" value={search} onChange={e => setSearch(e.target.value)} placeholder="서버 검색…" /></div>
      <div className="server-list">
        {loading && <p className="list-note">서버를 불러오는 중…</p>}
        {!loading && !filtered.length && <p className="list-note">{search ? '검색 결과가 없습니다.' : 'Sync로 목록을 가져오거나 +로 서버를 추가하세요.'}</p>}
        {filtered.map(record => <div className={`server-row ${active === record._id ? 'active' : ''}`} key={record._id}>
          <button className="server-connect" onClick={() => connect(record)}><span className={`server-dot ${statuses[record._id] || ''}`} /><span className="server-text"><strong>{record.name}</strong><small>{record.username}@{record.host}:{record.port}</small><span className="server-tags">{labels[record.authType]}{record.proxyJump && ' · Jump'}{record.configAvailable === false && ' · config 없음'}</span></span></button>
          <button className="server-edit" onClick={() => setDialog({ type: 'server', record })} title={`${record.name} 설정`} aria-label={`${record.name} 설정`}>⋯</button>
        </div>)}
      </div>
      <div className="sidebar-footer"><div className="account"><span className="avatar">{user.username?.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><small><span className={`online-dot ${online ? 'online' : ''}`} />{online ? '연결됨' : '서버 연결 중…'}</small></div></div><div className="account-actions"><button onClick={() => setDialog({ type: 'password' })}>비밀번호 변경</button><button onClick={logout}>로그아웃</button></div></div>
    </aside>
    {sidebarOpen && <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
    <main className="terminal-workspace">
      <header className="workspace-header"><div className="header-title"><button className="icon-button mobile-only" onClick={() => setSidebarOpen(true)}>☰</button><span className="breadcrumb">WORKSPACE</span><span className="header-divider">/</span><strong>{selected?.name || '터미널'}</strong></div><button className={showHistory ? 'selected' : ''} onClick={() => setShowHistory(!showHistory)}>최근 연결</button></header>
      {tabs.length > 0 && <div className="tab-bar">{tabs.map(record => <div className={`terminal-tab ${active === record._id ? 'active' : ''}`} key={record._id}><button onClick={() => setActive(record._id)}><span className={`server-dot ${statuses[record._id] || ''}`} />{record.name}</button><button className="tab-close" aria-label={`${record.name} 연결 종료`} onClick={() => close(record._id)}>×</button></div>)}</div>}
      <div className="terminal-content">
        {tabs.map(record => <TerminalPane key={record._id} record={record} visible={active === record._id} attempt={attempts[record._id] || 0} onStatus={updateStatus} />)}
        {!tabs.length && <div className="empty-state"><div className="empty-terminal"><span /><span /><span /><pre>&gt; ssh your-server<span className="cursor-block" /></pre></div><span className="eyebrow">READY TO CONNECT</span><h1>서버를 선택해 시작하세요.</h1><p>왼쪽 목록을 클릭하면 SSH 터미널이 열립니다.<br />여러 서버를 탭으로 동시에 사용할 수 있습니다.</p><div className="empty-actions"><button className="primary" onClick={() => setDialog({ type: 'server' })}>+ 새 서버 추가</button><button onClick={sync} disabled={syncing}>↻ SSH config 동기화</button></div></div>}
        {showHistory && <aside className="history-panel"><div className="dialog-heading"><h3>최근 연결</h3><button className="icon-button" onClick={() => setShowHistory(false)}>×</button></div>{!history.length && <p className="muted">연결 기록이 없습니다.</p>}{history.map(item => <div className="history-item" key={item._id}><strong>{item.serverName}</strong><small>{new Date(item.startedAt).toLocaleString('ko-KR')}</small><span>{item.status === 'open' ? '접속 중' : `종료${item.exitCode != null ? ` · exit ${item.exitCode}` : ''}`}</span></div>)}</aside>}
      </div>
      <footer className="status-bar"><span><span className={`server-dot ${selected ? statuses[active] || '' : ''}`} />{selected ? `${selected.username}@${selected.host}:${selected.port} · ${{ connecting: '연결 중', connected: 'SSH 실행 중', closed: '종료됨', error: '연결 오류' }[statuses[active]] || '준비 중'}` : 'SSH · 서버 선택 대기'}</span>{selected && <div><button onClick={() => setAttempts(previous => ({ ...previous, [active]: (previous[active] || 0) + 1 }))}>↻ 다시 연결</button><button onClick={() => close(active)}>연결 종료</button></div>}</footer>
    </main>
    {notice && <div role="status" className="toast"><span>{notice}</span><button onClick={() => setNotice('')}>×</button></div>}
    {dialog?.type === 'server' && <ServerDialog record={dialog.record} onClose={() => setDialog(null)} notify={notify} />}
    {dialog?.type === 'password' && <PasswordDialog onClose={() => setDialog(null)} notify={notify} />}
  </div>;
}

function App() {
  const { user, loggingIn } = useTracker(() => ({ user: Meteor.user(), loggingIn: Meteor.loggingIn() }));
  if (loggingIn) return <div className="boot-screen">Web Terminal을 불러오는 중…</div>;
  return user ? <Workspace user={user} /> : <Login />;
}

Meteor.startup(() => createRoot(document.getElementById('root')).render(<App />));
