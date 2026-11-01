const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

test('compressed chunks cannot inflate beyond the bounded browser buffer', async () => {
  const { decodeBuffer } = await import('../lib/trzsz/comm.mjs');
  const encoded = require('node:zlib').deflateSync(Buffer.alloc(33 * 1024 * 1024)).toString('base64');
  assert.throws(() => decodeBuffer(encoded), /exceeds 32 MiB/);
});

test('trzsz detects a trigger split at every byte and can cancel before file selection', async () => {
  const { TerminalTransfer } = await import('../client/terminal-transfer.mjs');
  const { decodeBuffer } = await import('../lib/trzsz/comm.mjs');
  const sent = []; const updates = [];
  const filter = new TerminalTransfer({ send: data => sent.push(data), write: () => {}, update: data => updates.push(data) });
  for (const byte of 'text\r\n::TRZSZ:TRANSFER:S:1.2.0:9356049461700:38357\r\r\n') await filter.output(byte);
  assert.equal(updates[0].phase, 'download');
  filter.cancel(); await filter.running;
  const action = JSON.parse(new TextDecoder().decode(decodeBuffer(sent[0].slice(5).trim())));
  assert.equal(action.confirm, false);
  assert.equal(action.binary, false);
  assert.equal(filter.transfer, null);
});

for (const corrupt of [false, true]) test(`downloads ${corrupt ? 'discard checksum failures' : 'finalize after checksum verification'}`, async () => {
  const { TrzszTransfer } = await import('../lib/trzsz/transfer.mjs');
  const { encodeBuffer } = await import('../lib/trzsz/comm.mjs');
  const bytes = crypto.randomBytes(8193); const digest = crypto.createHash('md5').update(bytes).digest();
  if (corrupt) digest[0] ^= 1;
  const line = (type, value) => `#${type}:${value}\n`;
  const transfer = new TrzszTransfer(() => {});
  transfer.addReceivedData(line('CFG', encodeBuffer('{}')) + line('NUM', 1) + line('NAME', encodeBuffer('한글.bin'))
    + line('SIZE', bytes.length) + line('DATA', encodeBuffer(bytes)) + line('MD5', encodeBuffer(digest)));
  let closed = false; let aborted = false; const received = [];
  await transfer.recvConfig();
  const result = transfer.recvFiles(null, async () => ({ getLocalName: () => '한글.bin', getFileName: () => '한글.bin', isDir: () => false,
    writeFile: async data => received.push(Buffer.from(data)), closeFile: async () => { closed = true; }, abortFile: () => { if (!closed) aborted = true; } }), null);
  if (corrupt) await assert.rejects(result, /MD5/); else await result;
  transfer.cleanup(); assert.equal(closed, !corrupt); assert.equal(aborted, corrupt);
  assert.deepEqual(Buffer.concat(received), bytes);
});

test('browser transfer validates names and builds bounded slice readers for folder uploads', async () => {
  const { safeDownloadName } = await import('../client/browser-download.mjs');
  const { fileReaders } = await import('../client/terminal-transfer.mjs');
  assert.equal(safeDownloadName('../../한글\n.bin'), '.._.._한글_.bin');
  assert.throws(() => safeDownloadName(''), /이름/);
  const file = new File(['abcdef'], 'file.txt');
  Object.defineProperty(file, 'webkitRelativePath', { value: 'folder/sub/file.txt' });
  const readers = fileReaders([file], true);
  assert.deepEqual(readers.map(reader => reader.getRelPath().join('/')), ['folder', 'folder/sub', 'folder/sub/file.txt']);
  assert.equal(new TextDecoder().decode(await readers[2].readFile(new ArrayBuffer(2))), 'ab');
  assert.equal(new TextDecoder().decode(await readers[2].readFile(new ArrayBuffer(2))), 'cd');
});
