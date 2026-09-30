'use strict';

/** An error with a short title for the on-screen banner and a sentence the user can act on. */
class ProviderError extends Error {
  constructor(message, title = 'Something went wrong') {
    super(message);
    this.title = title;
  }
}

/** Shared HTTP handling for the REST-based providers. */
async function requestJson(url, options, provider, signal) {
  let res;
  try {
    res = await fetch(url, { ...options, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(180000)]) : AbortSignal.timeout(30000) });
  } catch (err) {
    if (signal && signal.aborted) throw err;
    throw new ProviderError(`Couldn’t reach ${provider}. Check your internet connection.`, 'You’re offline');
  }
  let body = null;
  try { body = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return body;
  const detail = body && body.error ? (body.error.message || JSON.stringify(body.error)) : '';
  if (res.status === 401 || res.status === 403) throw new ProviderError(`Your ${provider} API key was rejected. Check it in Settings › Models.`, 'Invalid API key');
  if (res.status === 404) throw new ProviderError(`${provider} couldn’t find that model. Pick another one in Settings › Models.`, 'Model not found');
  if (res.status === 429) throw new ProviderError(`${provider} is rate limiting requests or your quota is used up. ${detail}`.trim(), 'Too many requests');
  if (res.status >= 500) throw new ProviderError(`${provider} is having trouble (${res.status}). Try again in a moment.`, 'Service unavailable');
  throw new ProviderError(`${provider} rejected the request${detail ? `: ${detail}` : ` (${res.status})`}`, 'Request rejected');
}

module.exports = { ProviderError, requestJson };
