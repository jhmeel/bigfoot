'use strict';
// Persistent settings. API keys are encrypted with the OS keychain (DPAPI on Windows)
// through Electron's safeStorage and never leave the main process.

const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');

const SECRET_KEYS = ['anthropicKey', 'openaiKey', 'elevenlabsKey'];
const CHOICES = {
  provider: ['local', 'anthropic', 'openai'],
  sttProvider: ['local', 'openai', 'elevenlabs'],
  ttsProvider: ['system', 'openai', 'elevenlabs'],
};

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Best for most tasks' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Faster, lower cost' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', note: 'Most capable, highest cost' },
];

const DEFAULTS = {
  assistantName: 'Bigfoot',
  wakeWord: true,                 // respond to "Hey <name>"

  provider: 'local',              // local | anthropic | openai
  localModel: '',                 // installed Qwen3-VL model id
  keepAiLoaded: true,             // load the local model at startup and keep it loaded (no cold starts)
  model: 'claude-opus-5-5',       // Claude model
  openaiModel: 'gpt-5',
  effort: 'high',
  screenDetail: 'high',           // high = 1920 px screenshots for Claude, standard = 1366 px (cheaper)
  approvalMode: 'risky',          // risky | every | auto
  maxCostPerTask: 2,              // USD, 0 = no limit
  maxTurns: 60,
  blockedWindowKeywords: 'password, 1password, bitwarden, lastpass, keepass, bank, paypal, wallet, credential',

  speakResponses: true,
  ttsProvider: 'system',          // system | elevenlabs | openai
  systemVoice: '',                // voice name from speechSynthesis
  elevenlabsVoice: '',            // voice_id
  openaiVoice: 'coral',
  speechRate: 1.0,

  sttProvider: 'local',           // local (Windows, offline) | openai | elevenlabs

  soundEffects: true,
  showBuddy: true,
  toolTray: true,                 // double-click empty desktop space for the tool tray
  launchAtLogin: false,
  onboarded: false,
};

class Settings {
  constructor() {
    this.file = path.join(app.getPath('userData'), 'settings.json');
    this.values = { ...DEFAULTS };
    this.secrets = {};
    this.listeners = new Set();
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const key of Object.keys(DEFAULTS)) {
        if (key in raw && typeof raw[key] === typeof DEFAULTS[key] && valid(key, raw[key])) this.values[key] = raw[key];
      }
      for (const key of SECRET_KEYS) {
        const enc = raw.secrets && raw.secrets[key];
        if (!enc) continue;
        try {
          this.secrets[key] = safeStorage.isEncryptionAvailable()
            ? safeStorage.decryptString(Buffer.from(enc, 'base64'))
            : '';
        } catch {
          this.secrets[key] = ''; // encrypted by another user/machine: ask again
        }
      }
      // A cloud provider without its key (the old default) falls back to the local model.
      const keyFor = { anthropic: 'anthropicKey', openai: 'openaiKey' }[this.values.provider];
      if (keyFor && !this.secrets[keyFor]) this.values.provider = 'local';
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('Settings could not be read, using defaults:', err.message);
    }
  }

  save() {
    const secrets = {};
    for (const key of SECRET_KEYS) {
      if (this.secrets[key] && safeStorage.isEncryptionAvailable()) {
        secrets[key] = safeStorage.encryptString(this.secrets[key]).toString('base64');
      }
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ ...this.values, secrets }, null, 2));
    fs.renameSync(tmp, this.file); // atomic replace so a crash never leaves a half-written file
  }

  get(key) { return this.values[key]; }
  secret(key) { return this.secrets[key] || ''; }

  /** Values safe to send to renderers: secrets are reduced to "is set" flags. */
  publicView() {
    const has = {};
    for (const key of SECRET_KEYS) has[key] = Boolean(this.secrets[key]);
    return { ...this.values, has, models: MODELS };
  }

  update(patch) {
    const changed = {};
    for (const [key, raw] of Object.entries(patch || {})) {
      let value = raw;
      if (SECRET_KEYS.includes(key)) {
        if (typeof value !== 'string') continue;
        this.secrets[key] = value.trim();
        changed[key] = true;
      } else if (key in DEFAULTS && typeof value === typeof DEFAULTS[key] && valid(key, value)) {
        if (key === 'assistantName') {
          const name = cleanName(value);
          if (!name) continue;
          value = name;
        }
        this.values[key] = value;
        changed[key] = value;
      }
    }
    this.save();
    for (const fn of this.listeners) fn(changed);
    return this.publicView();
  }

  onChange(fn) { this.listeners.add(fn); }
}

function valid(key, value) {
  return !CHOICES[key] || CHOICES[key].includes(value);
}

/** Names are what the user says out loud: letters, spaces, apostrophes and hyphens, 2-24 chars. */
function cleanName(value) {
  const name = String(value).replace(/[^\p{L}\p{M}' -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return name.length >= 2 ? name : '';
}

module.exports = { Settings, MODELS, DEFAULTS, SECRET_KEYS, CHOICES, cleanName };
