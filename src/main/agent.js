'use strict';
// The agent loop: send the conversation to the model, run the tools it calls, repeat until it answers.
// Provider details (local Qwen3-VL, Claude, OpenAI) live in ./llm; this file only sees normalized turns.

const { systemPrompt } = require('./prompt');
const llm = require('./llm');
const { ProviderError } = require('./llm/errors');
const { StoppedError, READ_ONLY, isRisky, describeAction, sleep } = require('./computer');

const HALT_TEXT = 'Not executed: an earlier action in this turn failed.';
const STOPPED_TEXT = 'Not executed: the user stopped the agent.';
const TRUNCATED_TEXT = 'Not executed: your response hit the length limit, so this call may be incomplete. Issue it again.';
const LOOKING = new Set(['screenshot', 'zoom']);

class AgentError extends ProviderError {}

/** Parse and strip a [POINT:x,y:label] tag from a reply. */
function extractPoint(text) {
  const m = /\[POINT:\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*(?::\s*([^\]]*))?\]/i.exec(text);
  if (!m) return { text, point: null };
  const clean = (text.slice(0, m.index) + text.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim();
  return { text: clean, point: { x: Number(m[1]), y: Number(m[2]), label: (m[3] || '').trim() } };
}

const pngItem = (png) => ({ type: 'image', data: png.toString('base64') });

/**
 * A reply that announces actions without taking any: "I'll use open_url to…", "Let me open…",
 * "First, I'll…". A plain answer or a question back to the user isn't a plan.
 */
function isPlanInsteadOfAction(text) {
  const t = String(text || '');
  if (!t.trim() || /\?\s*$/.test(t.trim())) return false;
  const intent = /\b(I['’]?ll|I will|let me|I['’]?m going to|I am going to|first,? I|I can (?:help you )?(?:do|open|search|click|type|draw|use)|I need to (?:open|use|click|take))\b/i;
  const tooling = /\b(open_app|open_url|annotate|edit_drawing|run_command|screenshot|the \w+ (?:tool|function)|open (?:a |the )?(?:new )?(?:tab|browser|app|chrome|notepad|window)|search|click|type|draw)\b/i;
  return intent.test(t) && tooling.test(t);
}

class Agent {
  /**
   * @param {object} deps
   *   settings    Settings
   *   input       InputHelper (window titles, fail-safe)
   *   computer    ComputerExecutor
   *   plugins     PluginRegistry
   *   costs       CostTracker
   *   hooks       { state, progress, action, approve, notice, terminal, draw }
   *   runtime     LocalRuntime (runs the local model)
   *   isOnline    () => boolean
   */
  constructor({ settings, input, computer, plugins, costs, hooks, runtime = null, isOnline = () => true }) {
    Object.assign(this, { settings, input, computer, plugins, costs, hooks, runtime, isOnline });
    this.provider = null;
    this.providerKey = '';
    this.target = null;
    this.abort = null;
    this.running = false;
    this.approvedWindows = new Set();
  }

  reset() {
    if (this.running) return false;
    this.provider = null;
    this.approvedWindows.clear();
    return true;
  }

  stop() {
    if (this.abort) this.abort.abort();
  }

  /** A different display or resolution starts a new conversation, since coordinates change. */
  setTarget(target) {
    const same = this.target && this.target.display.id === target.display.id
      && this.target.sent.width === target.sent.width && this.target.sent.height === target.sent.height;
    if (!same) this.provider = null;
    this.target = target;
  }

  /** Reuse the conversation unless the provider, model, name, effort, or tool list changed. */
  ensureProvider({ online = this.isOnline() } = {}) {
    const s = this.settings;
    const id = llm.resolveProvider(s, { online });
    const key = [id, id && s.get(llm.PROVIDERS[id].modelSetting), s.get('assistantName'), s.get('effort'), this.plugins.version].join('|');
    if (this.provider && this.providerKey === key) return this.provider;
    this.provider = llm.createProvider(s, {
      system: systemPrompt(s.get('assistantName')),
      tools: this.plugins.definitions(),
      screen: this.target.sent,
      runtime: this.runtime,
      online,
    });
    this.providerKey = key;
    if ('onText' in this.provider && this.hooks.stream) this.provider.onText = (text) => this.hooks.stream(text);
    const chosen = s.get('provider');
    if (id !== chosen && llm.PROVIDERS[chosen]) {
      const why = llm.PROVIDERS[chosen].cloud && !online
        ? 'You’re offline'
        : chosen === 'local' ? 'The local AI isn’t installed yet' : `No ${llm.PROVIDERS[chosen].label} key is set`;
      this.hooks.terminal('info', `${why}, so ${llm.describe(s, id)} is being used.`);
    }
    return this.provider;
  }

  /** Have the local model read the fixed part of the conversation before the user asks anything. */
  async warm() {
    if (this.running || !this.target) return;
    const provider = this.ensureProvider();
    if (provider.warm) await provider.warm();
  }

  canFallBackOffline(provider, err) {
    return provider.id !== 'local' && err instanceof ProviderError && err.title === 'You’re offline'
      && llm.resolveProvider(this.settings, { online: false }) === 'local';
  }

  /** Run one request from the user. Resolves to { status, text, point }. */
  async run(task, { region = null, drawing = false } = {}) {
    if (drawing) task = `${task}\n\n(I drew on the screen; my drawing shows in your screenshots. Use edit_drawing to correct or improve it if I ask.)`;
    if (this.running) throw new AgentError('I’m already working on something. Press Esc to stop it first.', 'Still working');
    if (!this.target) throw new AgentError('No screen is selected.');
    this.running = true;
    this.abort = new AbortController();
    this.costs.startTask();
    this.hooks.terminal('task', task);
    try {
      let provider = this.ensureProvider();
      this.hooks.terminal('info', `Using ${llm.describe(this.settings, provider.id)}`);
      let request = null;
      if (region) {
        const r = [region.x0, region.y0, region.x1, region.y1].map(Math.round);
        let full = await this.target.screenshot();
        const crop = await this.target.zoom(r);
        let traced = false;
        if (region.points && this.hooks.markImage) {
          try {
            full = await this.hooks.markImage(full, region.points);
            traced = true;
          } catch (err) {
            this.hooks.terminal('error', `Couldn’t draw the outline on the screenshot: ${err.message}`);
          }
        }
        request = (p) => {
          const box = (p.fromScreen ? p.fromScreen(r) : r).join(', ');
          const how = traced
            ? `I traced around something on the screen; it's outlined in blue in the first image (bounding box [${box}] in your coordinate space)`
            : `I highlighted the area [${box}] of the first image, in your coordinate space`;
          p.addUserMessage(`${task}\n\n(${how}. The second image is a close-up of that area. My question is about what I marked; identify it first if that helps.)`,
            [full.toString('base64'), crop.toString('base64')]);
        };
      } else {
        request = (p) => p.addUserMessage(task);
      }
      request(provider);
      try {
        return await this.loop(provider, this.abort.signal);
      } catch (err) {
        if (!this.canFallBackOffline(provider, err) || this.abort.signal.aborted) throw err;
        this.hooks.notice('You’re offline, so I’m switching to the local AI.');
        this.provider = null;
        provider = this.ensureProvider({ online: false });
        this.hooks.terminal('info', `Using ${llm.describe(this.settings, provider.id)}`);
        request(provider);
        return await this.loop(provider, this.abort.signal);
      }
    } catch (err) {
      if (err instanceof StoppedError || (this.abort && this.abort.signal.aborted)) return { status: 'stopped', text: '' };
      throw err;
    } finally {
      this.running = false;
      this.abort = null;
    }
  }

  async loop(provider, signal) {
    const maxTurns = this.settings.get('maxTurns');
    let nudges = 0;
    for (let turn = 0; turn < maxTurns; turn++) {
      this.hooks.state('processing');
      const step = await provider.step(signal, (msg) => this.hooks.terminal('info', msg));
      this.costs.record(step.model, step.usage);
      step.progress.forEach((p) => this.hooks.progress(p));
      // Narration between tool calls is progress; the final reply is returned below.
      if (step.text && step.calls.length) this.hooks.progress(extractPoint(step.text).text);

      if (step.stop === 'refusal') {
        if (step.calls.length) provider.addToolResults(step.calls.map((call) => ({ call, content: 'Not executed: the request was declined.', isError: true })));
        throw new AgentError(`The model declined this request${step.refusalCategory ? ` (${step.refusalCategory})` : ''}. Try rephrasing it.`, 'Request declined');
      }
      if (step.stop === 'pause') continue;
      if (!step.calls.length) {
        if (step.stop === 'max_tokens') {
          provider.addUserMessage('Your last response was cut off by the length limit. Continue.');
          continue;
        }
        // A plan with no tool call ("I'll open Chrome, then…"): have the model do it instead.
        if (provider.id === 'local' && nudges < 2 && isPlanInsteadOfAction(step.text)) {
          nudges++;
          if (this.hooks.discard) this.hooks.discard(); // don't keep or speak the narration
          this.hooks.terminal('info', 'The model described a plan instead of acting; asking it to act.');
          provider.addUserMessage('Don’t describe it: do it now by calling the tools. At most one short sentence of text.');
          continue;
        }
        const { text, point } = extractPoint(step.text);
        return { status: 'done', text, point: point && this.localPoint(point) };
      }

      this.hooks.state('acting');
      provider.addToolResults(await this.runCalls(step.calls, step.stop === 'max_tokens', signal, provider));
    }
    return { status: 'max_turns', text: `I stopped after ${maxTurns} steps. Say "continue" if you want me to keep going.` };
  }

  localPoint(point) {
    try {
      return { ...this.target.sentToLocalDip([point.x, point.y]), label: point.label, displayId: this.target.display.id };
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------ tool calls
  async runCalls(calls, truncated, signal, provider) {
    const results = [];
    let failed = false;
    for (const call of calls) {
      const known = call.computer || this.plugins.has(call.name);
      if (call.parseError || !known) {
        results.push({ call, content: call.parseError ? `Invalid call: ${call.parseError}` : `Unknown tool ${call.name}.`, isError: true });
        continue;
      }
      if (signal.aborted) { results.push({ call, content: STOPPED_TEXT, isError: true }); continue; }
      if (truncated) { results.push({ call, content: TRUNCATED_TEXT, isError: true }); continue; }
      if (failed) { results.push({ call, content: HALT_TEXT, isError: true }); continue; }

      this.hooks.action(call.name, call.input);
      try {
        const content = call.computer
          ? await this.runComputer(call.name, call.input, signal)
          : await this.plugins.run(call.name, call.input, this.pluginContext(signal));
        if (typeof content === 'string') this.hooks.terminal('result', content);
        results.push({ call, content });
      } catch (err) {
        if (err instanceof StoppedError || signal.aborted) {
          results.push({ call, content: STOPPED_TEXT, isError: true });
          for (const rest of calls.slice(results.length)) results.push({ call: rest, content: STOPPED_TEXT, isError: true });
          provider.addToolResults(results); // keep the history valid for a follow-up
          throw new StoppedError('Stopped');
        }
        this.hooks.terminal('error', err.message);
        results.push({ call, content: `Error: ${err.message}`, isError: true });
        failed = true;
      }
    }

    // If a batch of computer actions didn't end with a look at the screen, attach one.
    const lastCall = calls[calls.length - 1];
    const last = results[results.length - 1];
    if (last && !failed && !truncated && !last.isError && lastCall.computer && !LOOKING.has(lastCall.name)) {
      try {
        const text = typeof last.content === 'string' ? last.content : 'OK';
        last.content = [{ type: 'text', text }, pngItem(await this.target.screenshot())];
      } catch (err) {
        this.hooks.terminal('error', `Follow-up screenshot failed: ${err.message}`);
      }
    }
    return results;
  }

  async runComputer(name, input, signal) {
    this.computer.validate(this.target, name, input);
    if (!READ_ONLY.has(name)) {
      await this.guardSensitiveWindow();
      const mode = this.settings.get('approvalMode');
      if (mode === 'every' || (mode === 'risky' && isRisky(name, input))) {
        await this.confirm('always', { title: 'Allow this action?', message: describeAction(name, input), confirm: 'Allow' });
      }
      await this.failSafe();
    }
    if (signal.aborted) throw new StoppedError('Stopped');
    const out = await this.computer.run(this.target, name, input, signal);
    return typeof out === 'string' ? out : out.map((png) => pngItem(png));
  }

  pluginContext(signal) {
    return {
      signal,
      screen: this.target,
      settings: this.settings,
      confirm: (level, req) => this.confirm(level, req),
      log: (kind, text) => this.hooks.terminal(kind, text),
      draw: (shape) => this.hooks.draw({ ...shape, displayId: this.target.display.id }),
      ink: (op) => this.hooks.ink({ ...op, displayId: this.target.display.id }),
      sleep: (ms) => sleep(ms, signal),
    };
  }

  /** level 'read' asks only in "every" mode, 'change' unless approvals are off, 'always' every time. */
  async confirm(level, req) {
    const mode = this.settings.get('approvalMode');
    const ask = level === 'always' || (level === 'change' && mode !== 'auto') || (level === 'read' && mode === 'every');
    if (!ask) return;
    if (!(await this.hooks.approve(req))) throw new Error('The user declined this action. Ask them how to proceed.');
  }

  /** Applies in every approval mode: never act blindly inside a password manager or bank. */
  async guardSensitiveWindow() {
    let title = '';
    try { title = await this.input.windowTitle(); } catch { return; }
    if (!title || this.approvedWindows.has(title)) return;
    const keywords = this.settings.get('blockedWindowKeywords').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    if (!keywords.some((k) => title.toLowerCase().includes(k))) return;
    const ok = await this.hooks.approve({
      title: 'This window looks sensitive',
      message: `“${title}” may contain passwords or financial information. Let ${this.settings.get('assistantName')} act in this window?`,
      confirm: 'Allow',
    });
    if (!ok) throw new Error('The user declined to let you act in a sensitive window. Ask them how to proceed.');
    this.approvedWindows.add(title);
  }

  /** Slamming the mouse into the top-left corner of the primary screen stops everything. */
  async failSafe() {
    const p = await this.input.cursor();
    if (p.x <= 1 && p.y <= 1) {
      this.stop();
      throw new StoppedError('Stopped');
    }
  }
}

/** Anything unexpected becomes a readable banner rather than a stack trace. */
function toUserError(err) {
  if (err instanceof ProviderError) return err;
  return new AgentError(err && err.message ? err.message : String(err));
}

module.exports = { Agent, AgentError, extractPoint, toUserError, isPlanInsteadOfAction };
