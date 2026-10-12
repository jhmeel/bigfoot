'use strict';
// Custom OpenAI-compatible endpoint (e.g. Ollama, LM Studio, vLLM, OpenRouter, LocalAI, etc.)
// Reuses OpenAIProvider's chat completions & function calling protocol, allowing custom baseURL and optional API key.

const { OpenAIProvider, imagePart } = require('./openai');
const { requestJson, ProviderError } = require('./errors');

function cleanBaseUrl(url) {
  let u = (url || '').trim();
  if (!u) u = 'http://localhost:11434/v1';
  u = u.replace(/\/+$/, '');
  return u;
}

function authHeaders(key) {
  const h = { 'Content-Type': 'application/json' };
  if (key && key.trim()) {
    h.Authorization = `Bearer ${key.trim()}`;
  }
  return h;
}

class CustomProvider extends OpenAIProvider {
  constructor({ baseUrl, apiKey = '', model, system, tools, screen }) {
    super({ apiKey: apiKey || '', model, system, tools, screen });
    this.id = 'custom';
    this.label = 'Custom';
    this.baseUrl = cleanBaseUrl(baseUrl);
  }

  async endpoint() {
    return { url: this.baseUrl, key: this.apiKey };
  }

  async request(signal) {
    const { url, key } = await this.endpoint();
    return requestJson(`${url}/chat/completions`, {
      method: 'POST',
      headers: authHeaders(key),
      body: JSON.stringify({
        model: this.model,
        messages: this.messages,
        tools: this.tools,
        tool_choice: 'auto',
        ...this.requestExtras(),
      }),
    }, this.label, signal, this.timeoutMs);
  }
}

async function listModels(baseUrl, apiKey = '') {
  const url = cleanBaseUrl(baseUrl);
  const body = await requestJson(`${url}/models`, { headers: authHeaders(apiKey) }, 'Custom API');
  const list = Array.isArray(body) ? body : (body && body.data) || [];
  return list
    .map((m) => (typeof m === 'string' ? m : (m && (m.id || m.name))))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((id) => ({ id, name: id }));
}

async function testKey(baseUrl, apiKey = '', model = '') {
  const models = await listModels(baseUrl, apiKey);
  if (!models.length && !model) {
    throw new ProviderError('Connected to endpoint, but no models were returned. Enter a model name manually or check endpoint.', 'No models found');
  }
}

async function ask({ baseUrl, key = '', model, label = 'Custom', prompt, image, maxTokens = 300, signal, extras = {}, timeoutMs }) {
  const url = cleanBaseUrl(baseUrl);
  const body = await requestJson(`${url}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(key),
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

module.exports = { CustomProvider, cleanBaseUrl, listModels, testKey, ask };
