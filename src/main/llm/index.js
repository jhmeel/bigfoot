'use strict';
// Picks the model provider: local Qwen3-VL by default and always offline; Claude/OpenAI optionally, online.

const anthropic = require('./anthropic');
const openai = require('./openai');
const custom = require('./custom');
const local = require('./local');
const { ProviderError } = require('./errors');
const catalog = require('../local/catalog');

const PROVIDERS = {
  local: { label: 'Qwen3-VL', keyName: null, modelSetting: 'localModel', module: local, Provider: local.LocalProvider, cloud: false },
  anthropic: { label: 'Claude', keyName: 'anthropicKey', modelSetting: 'model', module: anthropic, Provider: anthropic.AnthropicProvider, cloud: true },
  openai: { label: 'OpenAI', keyName: 'openaiKey', modelSetting: 'openaiModel', module: openai, Provider: openai.OpenAIProvider, cloud: true },
  custom: { label: 'Custom', keyName: 'customKey', modelSetting: 'customModel', module: custom, Provider: custom.CustomProvider, cloud: true },
};
const CLOUD = ['anthropic', 'openai', 'custom'];
const ORDER = ['local', ...CLOUD];

const hasKey = (settings, id) => {
  if (id === 'custom') return Boolean(settings.get('customBaseUrl'));
  return Boolean(PROVIDERS[id].keyName && settings.secret(PROVIDERS[id].keyName));
};

function resolveProvider(settings, { online = true } = {}) {
  const chosen = settings.get('provider');
  const localReady = Boolean(catalog.modelById(settings.get('localModel')));
  if (CLOUD.includes(chosen) && hasKey(settings, chosen) && (online || !localReady)) return chosen;
  if (localReady) return 'local';
  return CLOUD.find((id) => hasKey(settings, id)) || null;
}

function describe(settings, id) {
  if (!id) return 'No model';
  if (id === 'local') {
    const m = catalog.modelById(settings.get('localModel'));
    return m ? m.label : 'Qwen3-VL';
  }
  return `${PROVIDERS[id].label} · ${settings.get(PROVIDERS[id].modelSetting)}`;
}

function createProvider(settings, { system, tools, screen, runtime, online = true }) {
  const id = resolveProvider(settings, { online });
  if (!id) throw new ProviderError('Set up your local AI in Settings › Models to get started.', 'Set up your local AI');
  const p = PROVIDERS[id];
  if (id === 'local') {
    return new p.Provider({ runtime, model: settings.get('localModel'), label: describe(settings, id), system, tools, screen });
  }
  if (id === 'custom') {
    return new p.Provider({
      baseUrl: settings.get('customBaseUrl'),
      apiKey: settings.secret(p.keyName),
      model: settings.get(p.modelSetting),
      system,
      tools,
      screen,
    });
  }
  return new p.Provider({
    apiKey: settings.secret(p.keyName),
    model: settings.get(p.modelSetting),
    effort: settings.get('effort'),
    system,
    tools,
    screen,
  });
}

function listModels(id, key, baseUrl) {
  if (!PROVIDERS[id] || !PROVIDERS[id].cloud) throw new ProviderError(`Unknown provider ${id}`);
  if (id === 'custom') return PROVIDERS[id].module.listModels(baseUrl, key);
  return PROVIDERS[id].module.listModels(key);
}

function testKey(id, key, model, baseUrl) {
  if (!PROVIDERS[id] || !PROVIDERS[id].cloud) throw new ProviderError(`Unknown provider ${id}`);
  if (id === 'custom') return PROVIDERS[id].module.testKey(baseUrl, key, model);
  return PROVIDERS[id].module.testKey(key, model);
}

module.exports = { PROVIDERS, ORDER, CLOUD, resolveProvider, describe, createProvider, listModels, testKey, ProviderError };
