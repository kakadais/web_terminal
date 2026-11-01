/* Browser-local streaming downloads. No files or credentials reach an HTTP endpoint. */
const downloads = new Map();
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  const { token, name } = event.data || {};
  const port = event.ports[0];
  if (!event.source?.url || new URL(event.source.url).origin !== self.location.origin || !port
    || !/^[a-f0-9-]{36}$/.test(token) || typeof name !== 'string' || name.length > 1024 || downloads.size >= 100) return;
  let controller; let pending; let finished = false;
  const touch = () => { clearTimeout(timer); timer = setTimeout(() => abort('다운로드 시간이 초과되었습니다.'), 120000); };
  const abort = message => {
    if (finished) return;
    finished = true; clearTimeout(timer); downloads.delete(token);
    controller?.error(new Error(message)); port.postMessage({ error: message }); port.close();
  };
  let timer = setTimeout(() => abort('다운로드가 시작되지 않았습니다.'), 30000);
  const flush = () => {
    if (pending && controller.desiredSize > 0) {
      // enqueue may synchronously ask for more data: clear ownership first.
      const bytes = pending; pending = null; controller.enqueue(bytes); port.postMessage({ type: 'ack' });
    }
  };
  const stream = new ReadableStream({
    start(value) { controller = value; },
    pull() { flush(); },
    cancel() { abort('브라우저 다운로드가 취소되었습니다.'); },
  });
  port.onmessage = ({ data }) => {
    if (finished) return;
    touch();
    if (data.type === 'chunk' && data.bytes instanceof Uint8Array && data.bytes.length <= 32 * 1024 * 1024 && !pending) {
      pending = data.bytes; flush();
    } else if (data.type === 'end' && !pending) {
      finished = true; clearTimeout(timer); controller.close(); port.postMessage({ type: 'ack' }); port.close();
    } else abort('파일 전송이 중단되었습니다.');
  };
  downloads.set(token, { stream, name, port, touch });
  port.postMessage({ type: 'ready' });
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/terminal/browser-download/')) return;
  const token = url.pathname.slice('/terminal/browser-download/'.length);
  const entry = downloads.get(token);
  downloads.delete(token); // One request per unguessable, in-memory capability.
  if (!entry || event.request.method !== 'GET') {
    event.respondWith(new Response('Download expired', { status: 410 })); return;
  }
  entry.touch(); entry.port.postMessage({ type: 'started' });
  event.respondWith(new Response(entry.stream, { headers: {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(entry.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
  } }));
});
