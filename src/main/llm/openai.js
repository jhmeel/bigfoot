'use strict';
// OpenAI through the Chat Completions API with function calling (also the base of the local provider).
// Tool messages can't carry images, so screenshots follow the tool results as a user message.

const { requestJson } = require('./errors');
const { computerFunction, toComputerCall, portableSchema } = require('./computer-schema');

const API = 'https://api.openai.com/v1';
const KEEP_IMAGES = 3; // older screenshots are replaced with a note to keep requests small

class OpenAIProvider {
  constructor({ apiKey, model, system, tools, screen, computer = computerFunction(screen.width, screen.height) }) {
    this.id = 'openai';
    this.label = 'OpenAI';
    this.apiKey = apiKey;
    this.model = model;
    this.keepImages = KEEP_IMAGES;
    this.timeoutMs = 180000;
    this.messages = [{ role: 'system', content: system }];
    this.tools = [computer, ...tools.map((t) => ({ name: t.name, description: t.description, parameters: t.input_schema }))]
      .map((f) => ({ type: 'function', function: { ...f, parameters: portableSchema(f.parameters) } }));
  }

  async endpoint() {
    return { url: API, key: this.apiKey };
  }

  requestExtras() {
    return { parallel_tool_calls: true };
  }

  addUserMessage(text, images = []) {
    this.messages.push({ role: 'user', content: [...images.map(imagePart), { type: 'text', text }] });
  }

  addToolResults(results) {
    const images = [];
    for (const { call, content, isError } of results) {
      const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n') || (isError ? 'Error' : 'OK');
      for (const p of parts) if (p.type === 'image') images.push(p.data);
      this.messages.push({ role: 'tool', tool_call_id: call.id, content: isError ? `Error: ${text.replace(/^Error:\s*/, '')}` : text });
    }
    if (images.length) {
      this.messages.push({ role: 'user', content: [{ type: 'text', text: 'Screen after those actions:' }, ...images.map(imagePart)] });
    }
  }

  trimImages() {
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (!Array.isArray(m.content)) continue;
      m.content = m.content.map((p) => {
        if (p.type !== 'image_url') return p;
        seen += 1;
        return seen > this.keepImages ? { type: 'text', text: '[older screenshot removed]' } : p;
      });
    }
  }

  async request(signal) {
    const { url, key } = await this.endpoint();
    return requestJson(`${url}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages: this.messages, tools: this.tools, tool_choice: 'auto', ...this.requestExtras() }),
    }, this.label, signal, this.timeoutMs);
  }

  async step(signal) {
    this.trimImages();
    const body = await this.request(signal);

    const choice = body.choices && body.choices[0];
    const msg = (choice && choice.message) || { role: 'assistant', content: '' };
    this.messages.push({ role: 'assistant', content: msg.content || null, ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });

    const calls = (msg.tool_calls || []).map((tc) => {
      let args = {};
      let parseError = null;
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch (err) { parseError = err.message; }
      if (tc.function.name === 'computer' && !parseError) {
        try {
          const { name, input } = toComputerCall(args);
          return { id: tc.id, name, input, computer: true };
        } catch (err) {
          parseError = err.message;
        }
      }
      return { id: tc.id, name: tc.function.name, input: args, computer: false, parseError };
    });
    const finish = choice && choice.finish_reason;
    return {
      model: body.model || this.model,
      usage: { input_tokens: body.usage ? body.usage.prompt_tokens : 0, output_tokens: body.usage ? body.usage.completion_tokens : 0 },
      text: (msg.content || '').trim(),
      progress: [],
      calls,
      stop: finish === 'content_filter' ? 'refusal' : finish === 'length' && !calls.length ? 'max_tokens' : calls.length ? 'tool_use' : 'end',
    };
  }
}

function imagePart(data) {
  return { type: 'image_url', image_url: { url: `data:image/png;base64,${data}`, detail: 'high' } };
}

const CHAT_MODEL = /^(gpt-|o\d|chatgpt-)/;
const NOT_CHAT = /(audio|realtime|tts|transcribe|embedding|image|search|moderation|instruct|codex|dall-e|whisper)/;

async function listModels(apiKey) {
  const body = await requestJson(`${API}/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, 'OpenAI');
  return (body.data || [])
    .map((m) => m.id)
    .filter((id) => CHAT_MODEL.test(id) && !NOT_CHAT.test(id))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((id) => ({ id, name: id }));
}

async function testKey(apiKey) {
  await listModels(apiKey);
}

async function ask({ url = API, key, model, label = 'OpenAI', prompt, image, maxTokens = 300, signal, extras = {}, timeoutMs }) {
  const body = await requestJson(`${url}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: [...(image ? [imagePart(image)] : []), { type: 'text', text: prompt }] }],
      max_completion_tokens: maxTokens,
      ...extras,
    }),
  }, label, signal, timeoutMs);
  const msg = body.choices && body.choices[0] && body.choices[0].message;
  return String((msg && msg.content) || '').trim();
}

module.exports = { OpenAIProvider, listModels, testKey, ask, imagePart };
