import React, { useEffect, useRef, useState } from 'react';
import { Meteor } from 'meteor/meteor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

const call = (name, ...args) => Meteor.callAsync(name, ...args);
const errorMessage = error => error?.reason || error?.message || '파일 전송에 실패했습니다.';
const sizeLabel = size => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(size / 1024)} KB`;

export default function TerminalPane({ record, visible, attempt, onStatus }) {
  const container = useRef(null);
  const connection = useRef({ sessionId: null, disposed: true, xhr: null, processing: false, queue: [], version: 0 });
  const dragDepth = useRef(0);
  const [connected, setConnected] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [directory, setDirectory] = useState('');
  const [lastDirectory, setLastDirectory] = useState('');
  const [jobs, setJobs] = useState([]);
  const [notice, setNotice] = useState('');
  const patchJob = (id, fields) => setJobs(previous => previous.map(job => job.id === id ? { ...job, ...fields } : job));

  useEffect(() => {
    const state = { sessionId: null, disposed: false, xhr: null, processing: false, queue: [], generation: 0, version: connection.current.version + 1 };
    connection.current = state; setConnected(false); setJobs([]); setNotice('');
    const terminal = new Terminal({ cursorBlink: true, fontSize: 14, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      scrollback: 10000, theme: { background: '#0b1018', foreground: '#d7e1ec', cursor: '#64d3b0', selectionBackground: '#294858' } });
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.current);
    let socket; let finished = false;
    const status = value => { if (!state.disposed) onStatus(record._id, value); };
    const stopUploads = () => { state.sessionId = null; state.generation++; state.xhr?.abort(); state.queue.length = 0;
      if (!state.disposed) { setConnected(false); setJobs(previous => previous.map(job => ['queued', 'preparing', 'sending'].includes(job.status) ? { ...job, status: 'error', message: '터미널 연결이 종료되었습니다.' } : job)); } };
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
      if (state.disposed) return;
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}${grant.path}`);
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', ticket: grant.ticket, cols: terminal.cols, rows: terminal.rows }));
      socket.onmessage = event => {
        const message = JSON.parse(event.data);
        if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'ready') { state.sessionId = message.sessionId; setConnected(true); status('connected'); resize(); terminal.focus(); }
        else if (message.type === 'exit') {
          finished = true; stopUploads(); status('closed'); terminal.writeln(`\r\n\x1b[90m터미널 종료 (exit ${message.exitCode})\x1b[0m`);
        } else if (message.type === 'error') { status('error'); terminal.writeln(`\r\n\x1b[31m${message.message}\x1b[0m`); }
      };
      socket.onerror = () => { status('error'); terminal.writeln('\r\n터미널 연결에 실패했습니다.'); };
      socket.onclose = () => { stopUploads(); if (!state.disposed && !finished) { status('closed'); terminal.writeln('\r\n\x1b[90m연결이 종료되었습니다. 다시 연결할 수 있습니다.\x1b[0m'); } };
    }).catch(error => { if (!state.disposed) { status('error'); terminal.writeln(`\r\n${errorMessage(error)}`); } });
    return () => {
      state.disposed = true; stopUploads(); observer.disconnect(); input.dispose(); socket?.close(1000, 'Tab closed'); terminal.dispose();
    };
  }, [record._id, attempt]);

  const sendFile = (state, job) => new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(); state.xhr = xhr;
    xhr.open('POST', job.endpoint); xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Upload-Ticket', job.token);
    xhr.upload.onprogress = event => { if (!state.disposed && event.lengthComputable && event.total > 0) patchJob(job.id, { progress: Math.min(99, Math.round(event.loaded / event.total * 100)) }); };
    xhr.onload = () => {
      let result; try { result = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 201) resolve(result);
      else reject(new Error(result?.error || (xhr.status === 413 ? '업로드 제한보다 큰 파일입니다.' : '서버에 파일을 저장하지 못했습니다.')));
    };
    xhr.onerror = () => reject(new Error('파일 전송 연결이 끊겼습니다.'));
    xhr.onabort = () => reject(new Error('전송을 취소했습니다.'));
    xhr.send(job.file);
  });
  const processQueue = async state => {
    if (state.processing) return;
    state.processing = true;
    try {
      while (!state.disposed && state.sessionId && state.queue.length) {
        const job = state.queue.shift();
        const generation = state.generation;
        patchJob(job.id, { status: 'sending', progress: 0 });
        try {
          if (job.expires <= Date.now()) {
            const fresh = await call('terminal.upload.prepare', state.sessionId, [{ name: job.file.name, size: job.file.size }], job.directory);
            if (fresh.items[0].error) throw new Error(fresh.items[0].error);
            Object.assign(job, fresh.items[0]);
          }
          if (state.disposed || !state.sessionId || state.generation !== generation) continue;
          const saved = await sendFile(state, job);
          if (!state.disposed) patchJob(job.id, { status: 'done', progress: 100, path: saved.path });
        } catch (error) { if (!state.disposed) patchJob(job.id, { status: 'error', message: errorMessage(error) }); }
        finally { state.xhr = null; }
      }
    } finally { state.processing = false; }
  };
  const drop = async event => {
    event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false); setNotice('');
    const state = connection.current;
    const generation = state.generation;
    if (!state.sessionId || state.disposed) { setNotice('파일을 저장할 터미널을 먼저 연결해 주세요.'); return; }
    if ([...event.dataTransfer.items].some(item => item.webkitGetAsEntry?.()?.isDirectory)) { setNotice('폴더는 지원하지 않습니다. 파일을 선택해 드롭해 주세요.'); return; }
    const files = [...event.dataTransfer.files];
    if (!files.length) return;
    if (files.length > 100 || state.queue.length + files.length > 100) { setNotice('한 번에 최대 100개 파일을 전송해 주세요.'); return; }
    const incoming = files.map(file => ({ id: crypto.randomUUID(), name: file.name, size: file.size, file, status: 'preparing', progress: 0 }));
    setJobs(previous => [...previous.filter(job => job.status !== 'done'), ...incoming]);
    try {
      const prepared = await call('terminal.upload.prepare', state.sessionId, files.map(file => ({ name: file.name, size: file.size })), directory);
      if (state.disposed || !state.sessionId || state.generation !== generation) return;
      setLastDirectory(prepared.directory);
      incoming.forEach((job, index) => {
        const item = prepared.items[index];
        if (item.error) patchJob(job.id, { status: 'error', message: item.error });
        else { const queued = { ...job, ...item, endpoint: prepared.endpoint, directory: prepared.directory }; state.queue.push(queued); patchJob(job.id, { status: 'queued' }); }
      });
      processQueue(state);
    } catch (error) { if (!state.disposed && state.generation === generation) incoming.forEach(job => patchJob(job.id, { status: 'error', message: errorMessage(error) })); }
  };
  const cancel = () => {
    const state = connection.current; state.generation++; state.queue.length = 0; state.xhr?.abort();
    if (state.sessionId) call('terminal.upload.cancel', state.sessionId).catch(() => {});
    setJobs(previous => previous.map(job => ['queued', 'preparing', 'sending'].includes(job.status) ? { ...job, status: 'error', message: '전송을 취소했습니다.' } : job));
  };
  const hasActive = jobs.some(job => ['preparing', 'queued', 'sending'].includes(job.status));
  const isFileDrag = event => [...event.dataTransfer.types].includes('Files');
  return <section className={`terminal-pane ${visible ? 'visible' : ''}`} aria-label={`${record.name} 터미널`}
    onDragEnter={event => { if (isFileDrag(event)) { event.preventDefault(); dragDepth.current++; setDragging(true); } }}
    onDragOver={event => { if (isFileDrag(event)) { event.preventDefault(); event.dataTransfer.dropEffect = connected ? 'copy' : 'none'; } }}
    onDragLeave={event => { if (isFileDrag(event) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }} onDrop={drop}>
    <div className="terminal-screen" ref={container} />
    <div className="upload-toolbar"><span>파일 드롭 →</span><input aria-label="파일 저장 경로" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="자동: 드롭 시 현재 작업 폴더" disabled={!connected} /><span className="upload-help">기존 파일 유지</span></div>
    {dragging && <div className="file-drop-overlay"><strong>{connected ? `${record.name}에 파일 저장` : '터미널을 먼저 연결하세요'}</strong><span>{directory || '현재 작업 폴더로 업로드합니다.'}</span></div>}
    {(jobs.length > 0 || notice) && <div className="upload-panel" role="status" aria-label="파일 전송 상태">
      <div className="upload-heading"><span>{lastDirectory || '파일 업로드'}</span>{hasActive ? <button onClick={cancel}>전송 취소</button> : <button onClick={() => { setJobs([]); setNotice(''); }}>닫기</button>}</div>
      {notice && <p className="upload-error">{notice}</p>}
      {jobs.map(job => <div key={job.id} className={`upload-item ${job.status}`}><span title={job.path || job.name}>{job.name}</span><small>{sizeLabel(job.size)}</small><span>{job.status === 'done' ? '저장 완료' : job.status === 'error' ? job.message : job.status === 'sending' ? `${job.progress}%${job.progress === 99 ? ' · 서버 저장 중' : ''}` : job.status === 'preparing' ? '저장 경로 확인 중…' : '대기 중'}</span>{job.status === 'sending' && <progress max="100" value={job.progress} />}</div>)}
    </div>}
  </section>;
}
