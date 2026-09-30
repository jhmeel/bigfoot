'use strict';
// Token usage accounting and spend limits.

// USD per million tokens (list prices; cacheWrite is the 5-minute TTL rate).
const LIST_PRICES = {
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'qwen3-vl': { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, // runs on the user's PC
};
// Unknown models are costed at the highest rate so spend limits err on the safe side.
const FALLBACK_PRICE = LIST_PRICES['claude-fable-5-1'];

class BudgetExceeded extends Error {}

const emptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, requests: 0 });

function priceFor(model) {
  if (LIST_PRICES[model]) return LIST_PRICES[model];
  const key = Object.keys(LIST_PRICES).find((k) => String(model).startsWith(k) || String(model).endsWith(k));
  return key ? LIST_PRICES[key] : FALLBACK_PRICE;
}

/** Cost one API response. With a refusal fallback, usage.iterations lists every billed attempt. */
function costOf(model, usage) {
  const entries = usage && Array.isArray(usage.iterations) && usage.iterations.length
    ? usage.iterations.map((it) => [it.model || model, it])
    : [[model, usage || {}]];
  const total = emptyUsage();
  total.requests = 1;
  for (const [m, u] of entries) {
    const p = priceFor(m);
    const input = u.input_tokens || 0;
    const output = u.output_tokens || 0;
    const cacheRead = u.cache_read_input_tokens || 0;
    const cacheWrite = u.cache_creation_input_tokens || 0;
    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheWrite += cacheWrite;
    total.cost += (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite) / 1e6;
  }
  return total;
}

function add(a, b) {
  for (const k of Object.keys(a)) a[k] += b[k];
}

class CostTracker {
  constructor() {
    this.task = emptyUsage();
    this.session = emptyUsage();
  }
  startTask() { this.task = emptyUsage(); }
  record(model, usage) {
    const u = costOf(model, usage);
    add(this.task, u);
    add(this.session, u);
    return u;
  }
  check(maxPerTask) {
    if (maxPerTask > 0 && this.task.cost >= maxPerTask) {
      throw new BudgetExceeded(`This task reached its $${maxPerTask.toFixed(2)} spending limit. You can raise it in Settings.`);
    }
  }
}

module.exports = { CostTracker, BudgetExceeded, costOf, priceFor, LIST_PRICES };
