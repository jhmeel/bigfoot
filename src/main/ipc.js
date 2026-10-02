'use strict';
// Every request a renderer can make. The preload allowlist mirrors these channel names.

const { app, ipcMain, shell, systemPreferences, screen, BrowserWindow, net, dialog } = require('electron');
const path = require('path');
const llm = require('./llm');
const { VOICES } = require('./kokoro');
const hardware = require('./local/hardware');
const catalog = require('./local/catalog');

const LINKS = {
  anthropic: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  qwen: 'https://huggingface.co/Qwen',
  micSettings: 'ms-settings:privacy-microphone',
  speechSettings: 'ms-settings:speech',
};

function microphoneStatus() {
  try {
    return systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return 'unknown';
  }
}

function registerIpc({ controller, windows, settings, agent, audio, activity, plugins, pluginManager, logger, costs, local, runtime, terminals }) {
  const handle = (channel, fn) => ipcMain.handle(channel, (event, ...args) => fn(...args, event));

  // ---- settings
  handle('settings:get', () => settings.publicView());
  handle('settings:update', (patch) => settings.update(patch));
  // Validates a candidate key (or the saved one) for a model provider.
  handle('provider:test', async (id, candidate) => {
    const p = llm.PROVIDERS[id];
    if (!p || !p.cloud) return { ok: false, message: 'Unknown provider.' };
    const key = typeof candidate === 'string' && candidate.trim() ? candidate.trim() : settings.secret(p.keyName);
    if (!key) return { ok: false, message: 'Paste a key first.' };
    if (id === 'anthropic' && !/^sk-ant-/.test(key)) return { ok: false, message: 'Anthropic keys start with sk-ant-.' };
    try {
      await llm.testKey(id, key, settings.get(p.modelSetting));
      return { ok: true, message: 'Connected' };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  });
  handle('models:list', async (id) => {
    const p = llm.PROVIDERS[id];
    const key = p && p.cloud && settings.secret(p.keyName);
    if (!key) return { ok: false, models: [], message: `Add a ${p ? p.label : ''} key to see its models.` };
    try {
      return { ok: true, models: await llm.listModels(id, key) };
    } catch (err) {
      return { ok: false, models: [], message: err.message };
    }
  });
  handle('provider:active', () => {
    const online = net.isOnline();
    const id = llm.resolveProvider(settings, { online });
    return { id, label: llm.describe(settings, id), online };
  });

  // ---- local AI
  handle('local:hardware', async () => {
    const hw = await hardware.detect(app.getPath('userData'));
    return { hardware: hw, ...catalog.recommend(hw) };
  });
  handle('local:status', () => ({ ...local.snapshot(), runtime: runtime.running ? 'ready' : 'stopped', online: net.isOnline() }));
  handle('local:start', (id) => local.start(id));
  handle('local:pause', () => local.pause());
  handle('local:resume', () => local.resume());
  handle('local:cancel', () => local.cancel());

  // ---- tool tray and math
  handle('toolbar:pick', (tool) => { controller.pickTool(tool); return true; });
  handle('math:read', (png) => controller.readMath(png));
  handle('math:ink', (strokes, image) => controller.readMathInk(strokes, image));
  handle('math:system', (expressions) => controller.solveMathSystem(expressions));
  handle('math:calc', (text, angle) => controller.calculate(text, angle === 'rad' ? 'rad' : 'deg'));
  handle('math:share', (text) => {
    if (typeof text !== 'string' || !text.trim()) return { ok: false };
    require('electron').clipboard.writeText(text.slice(0, 20000));
    return { ok: true };
  });
  handle('ink:stop', () => { controller.stopInk(); return true; });
  handle('tool:exit', () => { controller.exitTool(); return true; });
  handle('ink:share', (kind, event) => controller.shareDrawing(windows.displayIdOf(event.sender), ['copy', 'png', 'svg'].includes(kind) ? kind : 'copy'));
  handle('ink:reveal', (file) => { controller.revealFile(file); return true; });
  ipcMain.on('ink:reply', (_e, msg) => controller.onInkReply(msg || {}));
  ipcMain.on('ink:state', (event, state) => controller.onInkState(windows.displayIdOf(event.sender), state || {}));
  ipcMain.on('ink:passthrough', (event, on) => controller.setInkPassthrough(windows.displayIdOf(event.sender), Boolean(on)));

  // ---- voice
  // Bigfoot's own voices (./kokoro): the choice in setup and on the Voice page.
  handle('voices:list', () => ({ ok: true, voices: VOICES }));
  handle('voice:stop', () => { audio.stopSpeaking(); return true; });
  handle('voice:preview', async (voiceId) => {
    const used = await controller.previewVoice(typeof voiceId === 'string' ? voiceId : null);
    return { ok: true, used };
  });
  handle('mic:status', () => microphoneStatus());
  handle('mic:test', async (on) => {
    try {
      await audio.monitor(Boolean(on));
      return { ok: true, status: microphoneStatus() };
    } catch (err) {
      return { ok: false, status: microphoneStatus(), message: err.message };
    }
  });
  handle('wake:status', async () => ({ enabled: settings.get('wakeWord'), active: await controller.refreshWakeWord() }));

  // ---- tasks
  handle('task:run', (text) => controller.runTask(text, 'typed'));
  handle('task:stop', () => { controller.stopTask(); return true; });
  handle('conversation:reset', () => agent.reset());
  handle('select:start', () => controller.startPanelSelection());
  handle('region:clear', () => { controller.clearRegion(); return true; });

  // ---- windows & app
  handle('app:open-settings', (section) => { windows.openSettings(section); return true; });
  handle('app:open-onboarding', () => { windows.openOnboarding(); return true; });
  handle('app:quit', () => app.quit());
  handle('app:open-logs', () => shell.openPath(logger.dir));
  handle('app:open-plugins', () => { pluginManager.ensureFolder(); return shell.openPath(plugins.userDir); });

  // ---- plugins
  handle('plugins:list', () => pluginManager.list());
  handle('plugins:pick', async (event) => {
    const template = pluginManager.ensureFolder();
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Add a plugin', buttonLabel: 'Check Plugin', properties: ['openFile'],
      defaultPath: template, // opens beside the template, ready to copy and edit
      filters: [{ name: 'Bigfoot plugin', extensions: ['js'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return pluginManager.review(res.filePaths[0]);
  });
  handle('plugins:install', async (file) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, report: { errors: ['Choose the plugin again.'] } };
    return pluginManager.install(file);
  });
  handle('plugins:remove', async (file) => {
    await pluginManager.remove(String(file), (p) => shell.trashItem(p));
    return pluginManager.list();
  });
  handle('app:open-link', (which) => { if (LINKS[which]) shell.openExternal(LINKS[which]); });
  handle('app:info', () => ({
    version: app.getVersion(), state: controller.state, running: agent.running,
    usage: { task: costs.task, session: costs.session }, plugins: plugins.list(),
  }));
  handle('onboarding:finish', (prefs) => { controller.finishOnboarding(prefs || {}); return true; });
  handle('window:close', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win === windows.main) win.hide(); // Bigfoot keeps running in the tray
    else if (win) win.close();
  });
  handle('window:minimize', (event) => { const w = BrowserWindow.fromWebContents(event.sender); if (w) w.minimize(); });
  handle('panel:resize', (height) => windows.resizePanel(height));

  // ---- Bigfoot Terminal
  handle('terminal:open', () => { windows.openTerminal(); return true; });

  // ---- real terminals (./terminals): the Terminal page's tabs
  handle('term:shells', () => terminals.shells());
  handle('term:list', () => terminals.list());
  handle('term:create', (opts = {}) => terminals.create({ shell: String(opts.shell || 'powershell'), cols: Number(opts.cols) || 100, rows: Number(opts.rows) || 30 }));
  handle('term:replay', (id) => terminals.replay(id));
  handle('term:close', (id) => { terminals.close(id); return true; });
  handle('term:open-url', (url) => {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
    return true;
  });
  ipcMain.on('term:input', (_e, msg) => { if (msg) terminals.write(msg.id, msg.data); });
  ipcMain.on('term:resize', (_e, msg) => { if (msg) terminals.resize(msg.id, msg.cols, msg.rows); });
  const toWindow = (channel) => (payload) => { if (windows.main && !windows.main.isDestroyed()) windows.send(windows.main, channel, payload); };
  terminals.on('data', toWindow('term:data'));
  terminals.on('exit', toWindow('term:exit'));
  terminals.on('list', toWindow('term:list'));
  handle('terminal:get', () => activity.entries);
  handle('terminal:clear', () => { activity.clear(); return true; });
  handle('terminal:reveal', () => shell.showItemInFolder(logger.activityLog));

  // ---- fire-and-forget messages from renderers
  ipcMain.on('overlay:region', (event, rect) => controller.onRegionSelected(windows.displayIdOf(event.sender), rect));
  ipcMain.on('overlay:region-ask', (_e, text) => controller.askAboutRegion(typeof text === 'string' ? text.trim().slice(0, 4000) : ''));
  ipcMain.on('overlay:ready', (event) => {
    event.sender.send('state', controller.state);
    event.sender.send('settings', settings.publicView());
    event.sender.send('cursor', screen.getCursorScreenPoint());
  });
  ipcMain.on('panel:ready', () => {
    windows.send(windows.panel, 'state', controller.state);
    controller.sendUsage();
  });
}

module.exports = { registerIpc, LINKS };
