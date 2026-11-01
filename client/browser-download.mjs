let workerPromise;
export function prepareDownloads() {
  if (!workerPromise) workerPromise = (async () => {
    if (!navigator.serviceWorker || !window.isSecureContext) throw new Error('파일 다운로드는 HTTPS 브라우저에서 사용할 수 있습니다.');
    const registration = await navigator.serviceWorker.register('/file-transfer-sw.js', { scope: '/', updateViaCache: 'none' });
    if (!registration.active) await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve, reject) => {
      const done = () => { if (navigator.serviceWorker.controller) { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', done); resolve(); } };
      const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', done); reject(new Error('다운로드 초기화에 실패했습니다. 새로고침 후 다시 시도해 주세요.')); }, 10000);
      navigator.serviceWorker.addEventListener('controllerchange', done); done();
    });
    return registration.active || (await navigator.serviceWorker.ready).active;
  })().catch(error => { workerPromise = null; throw error; });
  return workerPromise;
}

export function safeDownloadName(name) {
  // Always a single file name: the browser chooses the user's download directory.
  const safe = name.replace(/[\\/\x00-\x1f\x7f]/g, '_').replace(/^\.+$/, '_');
  if (!safe || safe.length > 240) throw new Error('다운로드 파일 이름을 확인해 주세요.');
  return safe;
}

export async function createDownload(name, signal) {
  name = safeDownloadName(name);
  const worker = await prepareDownloads();
  signal?.throwIfAborted();
  const token = crypto.randomUUID();
  const channel = new MessageChannel();
  const port = channel.port1;
  let pending; let failure; let ended = false;
  const wait = () => new Promise((resolve, reject) => {
    if (failure) { reject(failure); return; }
    const timer = setTimeout(() => fail(new Error('브라우저 다운로드 응답 시간이 초과되었습니다.')), 120000);
    pending = { resolve: () => { clearTimeout(timer); pending = null; resolve(); }, reject: error => { clearTimeout(timer); pending = null; reject(error); } };
  });
  const fail = error => { failure = error; pending?.reject(error); };
  let frame;
  const abort = () => { port.postMessage({ type: 'abort' }); fail(new Error('파일 전송이 취소되었습니다.')); port.close(); frame?.remove(); };
  signal?.addEventListener('abort', abort, { once: true });
  port.onmessage = ({ data }) => {
    if (data.error) fail(new Error(data.error));
    else pending?.resolve();
  };
  const ready = wait(); worker.postMessage({ token, name }, [channel.port2]); await ready;
  const started = wait();
  // A navigation uses the service worker's attachment response. An <a download>
  // can bypass the service worker and download the application's fallback HTML.
  frame = document.createElement('iframe'); frame.hidden = true; frame.src = `/terminal/browser-download/${token}`;
  document.body.appendChild(frame);
  await started;
  return {
    async write(bytes) {
      if (ended || failure) throw failure || new Error('다운로드가 종료되었습니다.');
      const ack = wait(); const copy = bytes.slice();
      port.postMessage({ type: 'chunk', bytes: copy }, [copy.buffer]); await ack;
    },
    async close() {
      if (ended) return;
      const ack = wait(); port.postMessage({ type: 'end' }); await ack; ended = true; signal?.removeEventListener('abort', abort); port.close(); frame.remove();
    },
    abort() {
      if (ended) return;
      ended = true; signal?.removeEventListener('abort', abort); abort();
    },
  };
}
