'use strict';
// Requests to the model on this PC. Node's fetch gives up when a response hasn't started within
// 5 minutes, but a slow CPU can take longer than that just to read Bigfoot's instructions the
// first time. Here the only limit is progress: the request is dropped only when nothing at all
// arrives for `stallMs` (the server reports reading progress with return_progress, though some
// builds only at the start and the end, so the limit is generous).

const http = require('http');

/**
 * @returns {Promise<{ ok: boolean, status: number, body: AsyncIterable<Buffer>, json(): Promise<any>, text(): Promise<string> }>}
 */
function localPost(url, { key, body, signal, stallMs = 15 * 60 * 1000, waiting = () => false }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    });
    let timer = null;
    let response = null;
    // Errors go to the response once it exists, so whoever is reading the stream sees them.
    const fail = (err) => (response || req).destroy(err);
    // A request queued behind the one-time preparation hears nothing until it's its turn: that isn't a stall.
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (waiting() ? arm() : fail(Object.assign(new Error('The local AI stopped making progress.'), { stalled: true }))), stallMs);
    };
    const onAbort = () => fail(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
    if (signal) {
      if (signal.aborted) { onAbort(); } else signal.addEventListener('abort', onAbort, { once: true });
    }
    const done = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
    req.on('error', (err) => { done(); reject(err); });
    req.on('response', (res) => {
      response = res;
      arm();
      res.on('close', done);
      // Chunks pass straight to the reader; each one counts as progress. (Listening for 'data'
      // here would start the flow before the reader is attached and lose the first chunk.)
      const body = (async function* stream() {
        try {
          for await (const chunk of res) { arm(); yield chunk; }
        } finally {
          done();
        }
      })();
      const readAll = async () => {
        const parts = [];
        for await (const b of body) parts.push(b);
        return Buffer.concat(parts).toString('utf8');
      };
      resolve({ ok: res.statusCode < 400, status: res.statusCode, body, text: readAll, json: async () => JSON.parse(await readAll()) });
    });
    arm();
    req.end(payload);
  });
}

module.exports = { localPost };
