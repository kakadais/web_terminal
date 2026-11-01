import { TrzszTransfer } from '../lib/trzsz/transfer.mjs';
import { TrzszError } from '../lib/trzsz/comm.mjs';
import { createDownload, safeDownloadName, prepareDownloads } from './browser-download.mjs';

const magic = /::TRZSZ:TRANSFER:([SRD]):(\d+\.\d+\.\d+)(?::(\d+))?(?::\d+)?\r*\n/;

export function fileReaders(files, directory) {
  const roots = new Map(); const directories = new Set(); const readers = [];
  for (const file of files) {
    const rel = directory && file.webkitRelativePath ? file.webkitRelativePath.split('/') : [file.name];
    if (rel.some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) throw new Error('파일 경로를 확인해 주세요.');
    if (!roots.has(rel[0])) roots.set(rel[0], roots.size);
    const pathId = roots.get(rel[0]);
    const reader = (parts, dir) => {
      let position = 0;
      return { getPathId: () => pathId, getRelPath: () => parts, isDir: () => dir, getSize: () => dir ? 0 : file.size,
        closeFile() {}, async readFile(buffer) { const bytes = new Uint8Array(await file.slice(position, position + buffer.byteLength).arrayBuffer()); position += bytes.length; return bytes; } };
    };
    for (let i = 1; i < rel.length; i++) {
      const key = rel.slice(0, i).join('/');
      if (!directories.has(key)) { directories.add(key); readers.push(reader(rel.slice(0, i), true)); }
    }
    readers.push(reader(rel, false));
  }
  return readers;
}

export class TerminalTransfer {
  constructor({ send, write, update }) {
    this.send = send; this.write = write; this.update = update; this.tail = ''; this.seen = new Set();
  }
  async output(data) {
    if (this.transfer) { this.transfer.addReceivedData(data); return; }
    const text = this.tail + data; const found = text.match(magic); this.tail = text.slice(-512);
    if (!found || (found[3] && this.seen.has(found[3]))) { await this.write(data); return; }
    this.tail = ''; if (found[3]) this.seen.add(found[3]);
    if (this.seen.size > 100) this.seen.delete(this.seen.values().next().value);
    // The transfer owns all subsequent terminal input/output until it finishes.
    this.transfer = new TrzszTransfer(this.send, false, 32 * 1024);
    this.running = this.run(found[1], found[3] === '1' || (found[3]?.length === 13 && found[3].endsWith('10')));
  }
  input(data) {
    if (!this.transfer) return this.send(data);
    if (data === '\x03') this.cancel();
  }
  choose(files) { this.choice?.(files); this.choice = null; }
  cancel() {
    this.cancelled = true; this.choose(null);
    this.controller?.abort();
    for (const writer of this.writers || []) writer.abortFile();
    void this.transfer?.stopTransferring();
  }
  dispose() { this.disposed = true; this.cancel(); }
  async run(mode, windows) {
    const transfer = this.transfer; this.cancelled = false; this.writers = []; this.controller = new AbortController();
    const report = fields => { if (!this.disposed) this.update(fields); };
    const progress = { onNum: count => report({ count }), onName: name => report({ name, progress: 0 }),
      onSize: size => { this.size = size; report({ size }); }, onStep: step => report({ progress: this.size ? Math.floor(step / this.size * 100) : 100 }), onDone() {} };
    try {
      report({ phase: mode === 'S' ? 'download' : 'upload', direction: mode === 'S' ? 'download' : 'upload', directory: mode === 'D', name: '', error: '', progress: 0, size: 0 });
      const selected = await new Promise(resolve => { this.choice = resolve; });
      if (!selected || this.cancelled) { await transfer.sendAction(false, windows); return; }
      if (mode === 'S') await prepareDownloads();
      if (this.cancelled) { await transfer.sendAction(false, windows); return; }
      report({ phase: 'sending' });
      await transfer.sendAction(true, windows);
      const config = await transfer.recvConfig();
      if (mode === 'S') {
        if (config.directory) throw new Error('폴더 다운로드는 tar/zip으로 압축한 뒤 tsz로 보내 주세요.');
        await transfer.recvFiles(null, async (_params, name) => {
          const safeName = safeDownloadName(name); let download; let complete = false; let aborted = false;
          const opening = createDownload(safeName, this.controller.signal).then(value => { download = value; if (aborted) value.abort(); return value; });
          opening.catch(() => {});
          const writer = { getFileName: () => name, getLocalName: () => safeName, isDir: () => false,
            async writeFile(bytes) { const target = await opening; if (aborted) throw new Error('전송 취소'); await target.write(bytes); },
            async closeFile() { const target = await opening; if (aborted) throw new Error('전송 취소'); await target.close(); complete = true; },
            abortFile() { if (!complete) { aborted = true; download?.abort(); } },
            async deleteFile() { this.abortFile(); return ''; } };
          this.writers.push(writer); return writer;
        }, progress);
      } else await transfer.sendFiles(fileReaders(selected, mode === 'D'), progress);
      await transfer.clientExit(mode === 'S' ? '브라우저로 파일을 전송했습니다.' : '파일 업로드를 완료했습니다.');
      report({ phase: 'done', progress: 100 });
    } catch (error) {
      if (!this.disposed) {
        try { await transfer.clientError(error instanceof TrzszError ? error : new TrzszError(error.message)); } catch (_) {}
        report({ phase: 'error', error: this.cancelled ? '파일 전송을 취소했습니다.' : error.message });
      }
    } finally {
      transfer.cleanup(); this.controller.abort(); this.transfer = null; this.choice = null; this.tail = '';
      if (this.cancelled && !this.disposed) report({ phase: 'error', error: '파일 전송을 취소했습니다.' });
    }
  }
}
