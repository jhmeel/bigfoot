'use strict';
// Qwen3-VL on this PC via llama.cpp's OpenAI-compatible server. Qwen3-VL points on a 0-1000 grid
// regardless of image size, so coordinates are converted to and from screenshot pixels here.

const crypto = require('crypto');
const { OpenAIProvider, ask } = require('./openai');
const { computerFunction } = require('./computer-schema');
const { ProviderError } = require('./errors');
const { localPost } = require('./localhttp');

const GRID = 1000;
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000; // a first, uncached request on a slow CPU can take minutes
const SAMPLING = { temperature: 0.2, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };

// Small local models tend to describe a plan instead of carrying it out; say plainly not to.
const ACTION_NOTE = `

Acting: when the user asks you to do something, call the right tool in this same reply. Never describe what you will do, never explain how, never list steps: just call the tool. Say at most one short sentence. To search the web, call open_url with https://www.google.com/search?q= and the search words. To draw something on the screen (a bird, a heart…), call edit_drawing with action "add", shape "picture" and the subject (if there is no picture of it, shape "svg" with SVG you write). To neaten the user's drawing, call edit_drawing with action "tidy". If the user only asks a question or chats, answer in one or two short sentences, with no lists.`;

const GRID_NOTE = `

Coordinates: every x,y you give (computer actions, zoom regions, annotate and edit_drawing points and regions, and [POINT] tags) is on a ${GRID}x${GRID} grid laid over the screen: [0, 0] is the top-left corner and [${GRID}, ${GRID}] the bottom-right, whatever size the screenshot is. Cursor positions you are told use the same grid.`;

function localComputerFunction() {
  const fn = computerFunction(GRID, GRID);
  fn.description = fn.description.replace(`The screen is ${GRID}x${GRID} pixels; every coordinate is in that space`, `Coordinates are on a ${GRID}x${GRID} grid over the screen`);
  return fn;
}

const scale = (v, from, to) => Math.round(((Number(v) / from) * to) * 10) / 10;

class LocalProvider extends OpenAIProvider {
  constructor({ runtime, model, label, system, tools, screen }) {
    super({ apiKey: '', model, system: system + ACTION_NOTE + GRID_NOTE, tools, screen, computer: localComputerFunction() });
    this.id = 'local';
    this.label = label || 'Local AI';
    this.runtime = runtime;
    this.screen = screen;
    this.keepImages = 4;
    this.timeoutMs = LOCAL_TIMEOUT_MS;
    this.onText = null; // (textSoFar) => void, for showing the reply as it's written
  }

  /**
   * Old screenshots are dropped in batches (down to 2 once there are 4) rather than one per turn:
   * every edit to earlier messages makes the server re-read everything after it.
   */
  trimImages() {
    let count = 0;
    for (const m of this.messages) if (Array.isArray(m.content)) count += m.content.filter((p) => p.type === 'image_url').length;
    if (count <= this.keepImages) return;
    const keep = this.keepImages;
    this.keepImages = 2;
    super.trimImages();
    this.keepImages = keep;
  }

  /**
   * Read the fixed part of every request (instructions and tools) ahead of time. The result is
   * saved to disk, so after a restart it's restored in seconds instead of read again (100 s on a
   * laptop without a graphics card).
   */
  async warm(onProgress = () => {}) {
    const { url, key } = await this.endpoint();
    const file = `${this.model}-${crypto.createHash('sha1').update(JSON.stringify([this.messages[0], this.tools])).digest('hex').slice(0, 16)}.bin`;
    const restored = await this.runtime.slot('restore', file);
    const res = await localPost(`${url}/chat/completions`, {
      key,
      waiting: () => true, // never cut off: this reading has to happen once, however slow the PC
      body: { model: this.model, messages: [this.messages[0], { role: 'user', content: 'hi' }], tools: this.tools, max_tokens: 1, stream: true, return_progress: true },
    });
    if (!res.ok) throw new ProviderError(`${this.label} couldn’t prepare (${res.status}).`, 'Local AI problem');
    await readStream(res, () => {}, onProgress);
    if (!restored && await this.runtime.slot('save', file)) this.runtime.pruneCache(file);
    return restored;
  }

  /** Streams the answer so it can be shown while it's being written. */
  async request(signal) {
    if (!this.onText) return super.request(signal);
    const { url, key } = await this.endpoint();
    let res;
    try {
      res = await localPost(`${url}/chat/completions`, {
        key,
        signal,
        waiting: () => Boolean(this.runtime.preparing), // queued behind the one-time preparation
        body: {
          model: this.model, messages: this.messages, tools: this.tools, tool_choice: 'auto',
          ...this.requestExtras(), stream: true, stream_options: { include_usage: true }, return_progress: true,
        },
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw err.stalled
        ? new ProviderError(`${this.label} stopped responding. Your PC may be too busy: close some apps and try again.`, 'Local AI problem')
        : new ProviderError(`${this.label} isn’t running. Try again in a moment.`, 'Local AI stopped');
    }
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = (b.error && (b.error.message || JSON.stringify(b.error))) || ''; } catch { /* not JSON */ }
      throw new ProviderError(`${this.label} rejected the request${detail ? `: ${detail}` : ` (${res.status})`}`, 'Request rejected');
    }
    try {
      return await readStream(res, (text) => this.onText(text), (p) => { if (this.onProgress) this.onProgress(p); });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ProviderError(err.stalled
        ? `${this.label} stopped responding. Your PC may be too busy: close some apps and try again.`
        : `${this.label} stopped while answering: ${err.message}`, 'Local AI problem');
    }
  }

  async endpoint() {
    const e = await this.runtime.ensure();
    this.model = e.model;
    return { url: `${e.baseUrl}/v1`, key: e.apiKey };
  }

  requestExtras() {
    return { ...SAMPLING, max_tokens: 2048, parallel_tool_calls: true };
  }

  toPixels([x, y]) { return [scale(x, GRID, this.screen.width), scale(y, GRID, this.screen.height)]; }
  toGrid([x, y]) { return [Math.round((x / this.screen.width) * GRID), Math.round((y / this.screen.height) * GRID)]; }

  fromScreen([x0, y0, x1, y1]) { return [...this.toGrid([x0, y0]), ...this.toGrid([x1, y1])]; }

  convertCall(call) {
    if (call.parseError) return call;
    const input = { ...call.input };
    const pt = (p) => (Array.isArray(p) && p.length === 2 ? this.toPixels(p) : p);
    if (call.computer) {
      if (input.coordinate) input.coordinate = pt(input.coordinate);
      if (input.start_coordinate) input.start_coordinate = pt(input.start_coordinate);
      if (Array.isArray(input.region) && input.region.length === 4) {
        input.region = [...this.toPixels(input.region.slice(0, 2)), ...this.toPixels(input.region.slice(2))];
      }
    } else if (call.name === 'annotate' || call.name === 'edit_drawing') {
      if (Array.isArray(input.points)) input.points = input.points.map(pt);
      if (Array.isArray(input.region) && input.region.length === 4) {
        input.region = [...this.toPixels(input.region.slice(0, 2)), ...this.toPixels(input.region.slice(2))];
      }
    }
    return { ...call, input };
  }

  convertText(text) {
    return String(text || '').replace(/\[POINT:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/gi,
      (_m, x, y) => `[POINT:${this.toPixels([x, y]).map(Math.round).join(',')}`);
  }

  addToolResults(results) {
    super.addToolResults(results.map((r) => {
      if (r.call.name !== 'cursor_position' || typeof r.content !== 'string') return r;
      const m = /X=(\d+),\s*Y=(\d+)/.exec(r.content);
      if (!m) return r;
      const [gx, gy] = this.toGrid([Number(m[1]), Number(m[2])]);
      return { ...r, content: `X=${gx}, Y=${gy}` };
    }));
  }

  async step(signal) {
    let out;
    try {
      out = await this.runtime.use(() => super.step(signal));
    } catch (err) {
      if (signal && signal.aborted) throw err;
      if (err instanceof ProviderError && /context/i.test(err.message)) {
        this.shrinkHistory();
        out = await this.runtime.use(() => super.step(signal));
      } else if (err instanceof ProviderError && (err.title === 'Local AI stopped' || err.title === 'You’re offline')) {
        this.runtime.stop(); // the server died mid-request: restart once
        out = await this.runtime.use(() => super.step(signal));
      } else {
        throw err;
      }
    }
    return { ...out, text: this.convertText(out.text), calls: out.calls.map((c) => this.convertCall(c)) };
  }

  /**
   * A new request from the user. Earlier turns are kept as plain text (what was asked and what was
   * answered), without their screenshots and tool steps. On a CPU each kept screenshot is read
   * again on every request (minutes each), and a stopped task leaves history that no longer matches
   * the saved instructions; then one request took over an hour. Text keeps the conversation's memory
   * and costs seconds.
   */
  startTask() {
    const text = (m) => (Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : String(m.content || '')).trim();
    const turns = [];
    for (const m of this.messages.slice(1)) {
      const t = text(m);
      if (!t) continue;
      if (m.role === 'user' && !/^(?:Screen after|Don’t describe it|Your last response|\[older screenshot)/.test(t)) {
        turns.push({ role: 'user', content: t.replace(/\n\n\((?:I traced|I highlighted|I drew)[\s\S]*$/, '').slice(0, 500) });
      } else if (m.role === 'assistant' && !(m.tool_calls && m.tool_calls.length)) {
        turns.push({ role: 'assistant', content: t.slice(0, 500) });
      }
    }
    // Two user turns in a row (a stopped request never got its answer): keep the later one.
    const clean = turns.filter((m, i) => !(m.role === 'user' && turns[i + 1] && turns[i + 1].role === 'user'));
    while (clean.length && clean[0].role !== 'user') clean.shift();
    while (clean.length && clean[clean.length - 1].role === 'user') clean.pop(); // asked, never answered (stopped)
    this.messages = [this.messages[0], ...clean.slice(-6)];
    this.keepImages = 4;
  }

  /** Context overflow: keep only the current request and one screenshot. */
  shrinkHistory() {
    const system = this.messages[0];
    let start = this.messages.length - 1;
    for (let i = this.messages.length - 1; i > 0; i--) {
      const m = this.messages[i];
      const text = Array.isArray(m.content) ? m.content.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : m.content;
      if (m.role === 'user' && !/^Screen after those actions/.test(String(text))) { start = i; break; }
    }
    this.messages = [system, ...this.messages.slice(start)];
    this.keepImages = 1;
    OpenAIProvider.prototype.trimImages.call(this);
    this.keepImages = 2; // this conversation stays lean from now on
  }
}

/** Rebuild a chat completion from its server-sent events, reporting the text as it grows. */
async function readStream(res, onText, onProgress = () => {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish = null;
  let usage = null;
  let model = '';
  const calls = [];
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk.prompt_progress) { onProgress(chunk.prompt_progress); return; } // reading the request, batch by batch
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) return;
    if (choice.finish_reason) finish = choice.finish_reason;
    const d = choice.delta || {};
    if (d.content) { content += d.content; onText(content); }
    for (const tc of d.tool_calls || []) {
      const i = tc.index || 0;
      calls[i] = calls[i] || { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function && tc.function.name) calls[i].function.name += tc.function.name;
      if (tc.function && tc.function.arguments) calls[i].function.arguments += tc.function.arguments;
    }
  };
  for await (const bytes of res.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    lines.forEach(handle);
  }
  handle(buffer);
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
  return {
    model,
    usage,
    choices: [{ finish_reason: finish, message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
  };
}

async function askLocal(runtime, { prompt, image, maxTokens = 300, signal }) {
  return runtime.use((e) => ask({
    url: `${e.baseUrl}/v1`, key: e.apiKey, model: e.model, label: 'The local AI', prompt, image, signal, timeoutMs: LOCAL_TIMEOUT_MS,
    extras: { ...SAMPLING, temperature: 0, max_tokens: maxTokens, max_completion_tokens: undefined },
  }));
}

module.exports = { LocalProvider, askLocal, readStream, GRID, GRID_NOTE, ACTION_NOTE, localComputerFunction };
