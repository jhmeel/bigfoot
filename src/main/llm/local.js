'use strict';
// Qwen3-VL on this PC via llama.cpp's OpenAI-compatible server. Qwen3-VL points on a 0-1000 grid
// regardless of image size, so coordinates are converted to and from screenshot pixels here.

const { OpenAIProvider, ask } = require('./openai');
const { computerFunction } = require('./computer-schema');
const { ProviderError, requestJson } = require('./errors');

const GRID = 1000;
const SAMPLING = { temperature: 0.2, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 };

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
    super({ apiKey: '', model, system: system + GRID_NOTE, tools, screen, computer: localComputerFunction() });
    this.id = 'local';
    this.label = label || 'Local AI';
    this.runtime = runtime;
    this.screen = screen;
    this.keepImages = 4;
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

  /** Read the fixed part of every request (instructions and tools) ahead of time. */
  async warm() {
    const { url, key } = await this.endpoint();
    await requestJson(`${url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: [this.messages[0], { role: 'user', content: 'hi' }], tools: this.tools, max_tokens: 1 }),
    }, this.label);
  }

  /** Streams the answer so it can be shown while it's being written. */
  async request(signal) {
    if (!this.onText) return super.request(signal);
    const { url, key } = await this.endpoint();
    let res;
    try {
      res = await fetch(`${url}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, messages: this.messages, tools: this.tools, tool_choice: 'auto',
          ...this.requestExtras(), stream: true, stream_options: { include_usage: true },
        }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000),
      });
    } catch (err) {
      if (signal && signal.aborted) throw err;
      throw new ProviderError(`Couldn’t reach ${this.label}.`, 'You’re offline');
    }
    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = (b.error && (b.error.message || JSON.stringify(b.error))) || ''; } catch { /* not JSON */ }
      throw new ProviderError(`${this.label} rejected the request${detail ? `: ${detail}` : ` (${res.status})`}`, 'Request rejected');
    }
    return readStream(res, (text) => this.onText(text));
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
      } else if (err instanceof ProviderError && err.title === 'You’re offline') {
        this.runtime.stop(); // the server died mid-request: restart once
        out = await this.runtime.use(() => super.step(signal));
      } else {
        throw err;
      }
    }
    return { ...out, text: this.convertText(out.text), calls: out.calls.map((c) => this.convertCall(c)) };
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
async function readStream(res, onText) {
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
    url: `${e.baseUrl}/v1`, key: e.apiKey, model: e.model, label: 'The local AI', prompt, image, signal,
    extras: { ...SAMPLING, temperature: 0, max_tokens: maxTokens, max_completion_tokens: undefined },
  }));
}

module.exports = { LocalProvider, askLocal, readStream, GRID, GRID_NOTE, localComputerFunction };
