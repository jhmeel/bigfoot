'use strict';
// Claude through the Anthropic SDK, using the native computer toolset.
//
// History here is append-only: Claude's thinking blocks are bound to the exact conversation that
// produced them, and edits also break the prompt cache. Old screenshots are cleared server-side by
// context editing instead of being removed from the history.

const Anthropic = require('@anthropic-ai/sdk');
const { ProviderError } = require('./errors');

const TOOLSET = 'computer';
const MAX_TOKENS = 16000;

const blockType = (b) => (b && b.type) || '';

/** After a mid-output refusal fallback, only text survives from before the last fallback block. */
function echoContent(content) {
  let last = -1;
  content.forEach((b, i) => { if (blockType(b) === 'fallback') last = i; });
  if (last < 0) return content.slice();
  return content.slice(0, last).filter((b) => blockType(b) === 'text').concat(content.slice(last));
}

function toBlocks(content) {
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'image'
    ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: c.data } }
    : { type: 'text', text: c.text }));
}

class AnthropicProvider {
  constructor({ apiKey, model, effort, system, tools }) {
    this.id = 'anthropic';
    this.model = model;
    this.effort = effort;
    this.system = system;
    this.tools = tools;
    this.client = new Anthropic({ apiKey, maxRetries: 4, timeout: 180000 });
    this.messages = [];
    this.lean = false;
  }

  addUserMessage(text, images = []) {
    const blocks = [...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })), { type: 'text', text }];
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === 'user') {
      // An unsent user turn (tool results left after a stop): extend it rather than send two user turns.
      if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
      last.content.push(...blocks);
    } else {
      this.messages.push({ role: 'user', content: images.length ? blocks : text });
    }
  }

  addToolResults(results) {
    this.messages.push({
      role: 'user',
      content: results.map(({ call, content, isError }) => {
        const r = { type: 'tool_result', tool_use_id: call.id, content: toBlocks(content) };
        if (call.computer) r.toolset_name = TOOLSET;
        if (isError) r.is_error = true;
        return r;
      }),
    });
  }

  params() {
    // "lean" drops the optional betas if an account or model rejects them.
    const extras = !this.lean;
    const betas = ['context-management-2025-06-27'];
    if (extras) betas.push('thinking-display-updates-2026-08-18', 'server-side-fallback-2026-07-01');
    const params = {
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: this.system,
      tools: [{ type: 'computer_toolset_20260801' }, ...this.tools],
      messages: this.messages,
      betas,
      thinking: extras ? { type: 'adaptive', display: 'updates' } : { type: 'adaptive' },
      output_config: { effort: this.effort },
      cache_control: { type: 'ephemeral' },
      context_management: {
        edits: [{
          type: 'clear_tool_uses_20250919',
          trigger: { type: 'input_tokens', value: 60000 },
          keep: { type: 'tool_uses', value: 6 },
          clear_at_least: { type: 'input_tokens', value: 8000 },
        }],
      },
    };
    if (extras) params.fallbacks = 'default';
    return params;
  }

  async step(signal, onNotice) {
    let response;
    try {
      response = await this.client.beta.messages.stream(this.params(), { signal }).finalMessage();
    } catch (err) {
      if (signal.aborted) throw err;
      const msg = String((err && err.message) || '');
      const firstTurn = !this.messages.some((m) => m.role === 'assistant');
      if (!this.lean && firstTurn && err instanceof Anthropic.BadRequestError && /beta|fallback|display/i.test(msg)) {
        onNotice(`Optional API features were rejected; continuing without them. (${msg})`);
        this.lean = true;
        return this.step(signal, onNotice);
      }
      throw translate(err, this.model);
    }

    const content = echoContent(response.content);
    this.messages.push({ role: 'assistant', content });
    const texts = [];
    const progress = [];
    const calls = [];
    for (const b of content) {
      const t = blockType(b);
      if (t === 'text' && b.text && b.text.trim()) texts.push(b.text.trim());
      else if (t === 'thinking' && b.thinking && b.thinking.trim()) progress.push(b.thinking.trim());
      else if (t === 'tool_use') calls.push({ id: b.id, name: b.name, input: b.input || {}, computer: b.toolset_name === TOOLSET });
    }
    const stop = { tool_use: 'tool_use', end_turn: 'end', stop_sequence: 'end', max_tokens: 'max_tokens', refusal: 'refusal', pause_turn: 'pause' }[response.stop_reason] || 'end';
    return {
      model: response.model,
      usage: response.usage,
      text: texts.join(' '),
      progress,
      calls,
      stop,
      refusalCategory: response.stop_details && response.stop_details.category,
    };
  }
}

function translate(err, model) {
  if (err instanceof Anthropic.AuthenticationError) return new ProviderError('Your Anthropic API key was rejected. Check it in Settings › Models.', 'Invalid API key');
  if (err instanceof Anthropic.PermissionDeniedError) return new ProviderError(`Your Anthropic key doesn't have access to ${model}. Pick another model in Settings.`, 'No access to model');
  if (err instanceof Anthropic.NotFoundError) return new ProviderError(`The model ${model} wasn't found. Pick another model in Settings.`, 'Model not found');
  if (err instanceof Anthropic.RateLimitError) return new ProviderError('Anthropic is rate limiting requests. Wait a minute and try again.', 'Too many requests');
  if (err instanceof Anthropic.BadRequestError) {
    const msg = (err.error && err.error.error && err.error.error.message) || err.message;
    if (/credit balance/i.test(msg)) return new ProviderError('Your Anthropic account is out of credits. Add credits in the Claude Console.', 'Out of credits');
    return new ProviderError(`Anthropic rejected the request: ${msg}`, 'Request rejected');
  }
  if (err instanceof Anthropic.APIConnectionError) return new ProviderError('Couldn’t reach Anthropic. Check your internet connection.', 'You’re offline');
  if (err instanceof Anthropic.APIError) return new ProviderError(`Anthropic returned an error${err.status ? ` (${err.status})` : ''}. Try again in a moment.`, 'Service unavailable');
  return err;
}

async function listModels(apiKey) {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 20000 });
  const out = [];
  try {
    for await (const m of client.models.list({ limit: 100 })) out.push({ id: m.id, name: m.display_name || m.id });
  } catch (err) {
    throw translate(err, '');
  }
  return out;
}

async function testKey(apiKey, model) {
  try {
    await new Anthropic({ apiKey, maxRetries: 1, timeout: 20000 }).models.retrieve(model);
  } catch (err) {
    throw translate(err, model);
  }
}

async function ask({ apiKey, model, prompt, image, maxTokens = 300, signal }) {
  const content = [
    ...(image ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }] : []),
    { type: 'text', text: prompt },
  ];
  try {
    const res = await new Anthropic({ apiKey, maxRetries: 1, timeout: 30000 })
      .messages.create({ model, max_tokens: maxTokens, messages: [{ role: 'user', content }] }, { signal });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw translate(err, model);
  }
}

module.exports = { AnthropicProvider, listModels, testKey, ask, echoContent, translate };
