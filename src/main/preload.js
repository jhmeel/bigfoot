'use strict';
// The only bridge between the UI and the main process. Renderers never see API keys.

const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = new Set([
  'settings:get', 'settings:update', 'provider:test', 'models:list', 'provider:active',
  'voices:list', 'voice:preview', 'mic:status', 'mic:test', 'wake:status',
  'task:run', 'task:stop', 'conversation:reset', 'select:start', 'region:clear',
  'app:open-settings', 'app:open-onboarding', 'app:quit', 'app:open-logs', 'app:open-plugins', 'app:open-link', 'app:info',
  'onboarding:finish', 'window:close', 'window:minimize', 'panel:resize', 'approval:answer',
  'terminal:open', 'terminal:get', 'terminal:clear', 'terminal:reveal',
  'local:hardware', 'local:status', 'local:start', 'local:pause', 'local:resume', 'local:cancel',
  'toolbar:pick', 'math:read', 'math:ink', 'math:system', 'math:calc', 'math:share', 'ink:stop', 'tool:exit', 'ink:share', 'ink:reveal', 'loader:status', 'loader:retry',
  'plugins:list', 'plugins:pick', 'plugins:install', 'plugins:remove',
]);
const SEND = new Set([
  'overlay:ready', 'overlay:fly-done', 'overlay:region', 'overlay:region-ask', 'panel:ready',
  'engine:ready', 'engine:reply', 'engine:level', 'engine:vad', 'ink:passthrough', 'ink:reply', 'ink:state', 'loader:pointer',
]);
const RECEIVE = new Set([
  'cursor', 'state', 'bubble', 'bubble-live', 'fly', 'banner', 'welcome', 'settings', 'log', 'log-live', 'log-image', 'usage', 'level',
  'engine:cmd', 'approval:show', 'buddy:visible', 'annotate', 'select', 'region', 'terminal:line',
  'local:progress', 'local:runtime', 'toolbar:show', 'ink', 'voice-mode', 'loader',
]);

contextBridge.exposeInMainWorld('buddy', {
  invoke(channel, ...args) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked IPC channel ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  send(channel, payload) {
    if (!SEND.has(channel)) throw new Error(`Blocked IPC channel ${channel}`);
    ipcRenderer.send(channel, payload);
  },
  on(channel, fn) {
    if (!RECEIVE.has(channel)) throw new Error(`Blocked IPC channel ${channel}`);
    const listener = (_event, payload) => fn(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
