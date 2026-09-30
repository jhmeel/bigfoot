'use strict';
// App entry point: builds the services and wires them together.

const { app, session, screen, dialog, ipcMain, net } = require('electron');
const path = require('path');

const { Settings } = require('./settings');
const { Logger } = require('./logger');
const { InputHelper } = require('./input');
const { CostTracker } = require('./costs');
const { Agent } = require('./agent');
const { ComputerExecutor, READ_ONLY } = require('./computer');
const { ACTIONS: COMPUTER_ACTIONS } = require('./llm/computer-schema');
const { PluginRegistry } = require('./plugins/registry');
const { PluginManager } = require('./plugins/manage');
const { WindowManager } = require('./windows');
const { AudioService } = require('./audio');
const { ActivityLog } = require('./activity');
const { Controller, ONBOARDING_VERSION } = require('./controller');
const { registerIpc } = require('./ipc');
const { createTray } = require('./tray');
const { resolveProvider } = require('./llm');
const { LocalModelManager } = require('./local/manager');
const { LocalRuntime } = require('./local/runtime');
const { SpeechService } = require('./local/speech');
const catalog = require('./local/catalog');
const hardware = require('./local/hardware');

const CURSOR_POLL_MS = 16;

// QA only: a separate profile lets a test copy run beside an installed Bigfoot.
if (process.env.BIGFOOT_PROFILE_DIR) app.setPath('userData', process.env.BIGFOOT_PROFILE_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('com.bigfoot.app');
  app.whenReady().then(start).catch((err) => {
    dialog.showErrorBox('Bigfoot couldn’t start', String((err && err.stack) || err));
    app.exit(1);
  });
}

async function start() {
  const logger = new Logger(path.join(app.getPath('userData'), 'logs'));
  logger.info(`Starting ${app.getName()} ${app.getVersion()}`);
  const settings = new Settings();
  const costs = new CostTracker();
  const activity = new ActivityLog(logger);
  const input = new InputHelper();
  const windows = new WindowManager({ onEngineClosed: () => audio.failAll('The audio engine restarted.') });
  const audio = new AudioService({ windows, settings, logger });
  const isOnline = () => net.isOnline();
  const local = new LocalModelManager({ dir: path.join(app.getPath('userData'), 'local-ai'), settings, logger, isOnline });
  const runtime = new LocalRuntime({ manager: local, logger, settings });
  const speech = new SpeechService({ logger });

  const plugins = new PluginRegistry(logger);
  plugins.loadBuiltins();
  plugins.userDir = path.join(app.getPath('userData'), 'plugins');
  const userPlugins = plugins.loadUserPlugins(plugins.userDir);
  if (userPlugins.length) logger.info(`Loaded plugins: ${userPlugins.join(', ')}`);
  const pluginManager = new PluginManager({ registry: plugins, dir: plugins.userDir, logger });
  pluginManager.ensureFolder();

  const flyTo = (target) => new Promise((resolve) => {
    const win = windows.overlayFor(target.displayId);
    if (!win || win.isDestroyed() || !settings.get('showBuddy')) return resolve();
    const id = Math.random().toString(36).slice(2);
    const done = (_e, doneId) => {
      if (doneId !== id) return;
      clearTimeout(timer);
      ipcMain.removeListener('overlay:fly-done', done);
      resolve();
    };
    const timer = setTimeout(() => { ipcMain.removeListener('overlay:fly-done', done); resolve(); }, 2500);
    ipcMain.on('overlay:fly-done', done);
    windows.send(win, 'fly', { ...target, id });
  });

  let controller = null;
  const computer = new ComputerExecutor({
    input,
    pointAt: (p) => flyTo({ ...p, displayId: agent.target.display.id }),
  });
  const agent = new Agent({
    settings, input, computer, plugins, costs, runtime, isOnline,
    hooks: {
      state: (s) => { if (controller.state !== s) controller.setState(s); },
      progress: (text) => {
        windows.broadcast('bubble', { text, ttl: 4000 });
        controller.panelLog('progress', text);
        activity.add('think', text);
      },
      action: (name, inp) => {
        // The window is invisible in screenshots but would still catch the AI's clicks, so it
        // steps aside only when the AI starts using the mouse or keyboard, never for a chat.
        if (COMPUTER_ACTIONS.includes(name) && !READ_ONLY.has(name)) windows.hidePanel();
        logger.audit('action', { name, input: name === 'type' || name === 'write_file' ? { chars: String(inp.text || inp.content || '').length, path: inp.path } : inp });
        controller.panelLog('action', actionLabel(name, inp));
        activity.add('action', `${name} ${actionArgs(name, inp)}`.trim());
        controller.sendUsage();
      },
      approve: (req) => controller.requestApproval(req),
      notice: (text) => controller.showInfo('Heads up', text),
      terminal: (kind, text) => activity.add(kind, text),
      draw: (shape) => windows.send(windows.overlayFor(shape.displayId), 'annotate', shape),
      ink: (op) => controller.editInk(op),
      stream: (text) => controller.streamReply(text),
      discard: () => controller.discardStream(),
      markImage: async (png, points) => Buffer.from(await audio.call('mark-image', { png, points }, 15000)),
    },
  });
  controller = new Controller({ windows, settings, agent, audio, input, costs, activity, logger, local, runtime, speech, isOnline });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', err);
    try { controller.showError(err); } catch { /* the UI may be gone */ }
  });
  process.on('unhandledRejection', (err) => logger.error('Unhandled rejection', err));

  // Only the hidden audio engine may use the microphone; everything else is denied.
  const isEngine = (wc) => windows.engine && wc === windows.engine.webContents;
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && isEngine(wc)));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && isEngine(wc));

  registerIpc({ controller, windows, settings, agent, audio, activity, plugins, pluginManager, logger, costs, local, runtime });

  local.on('progress', (snap) => windows.send(windows.main, 'local:progress', snap));
  local.on('installed', (id) => {
    activity.add('info', `Local AI installed: ${id}. Bigfoot now works offline.`);
    controller.notify('Your local AI is ready', 'Bigfoot can now work fully offline.');
  });
  runtime.on('state', (s) => {
    windows.send(windows.main, 'local:runtime', s);
    if (s === 'ready') controller.warmLocal();
  });

  activity.onEntry((entry) => windows.send(windows.terminal, 'terminal:line', entry));
  audio.on('level', (level) => {
    windows.broadcast('level', level);
    windows.send(windows.onboarding, 'level', level);
    windows.send(windows.settings, 'level', level);
  });
  audio.on('vad', () => { if (controller.state === 'listening' && controller.listenSource !== 'ptt') controller.finishListening(); });
  audio.on('fallback', (err) => activity.add('info', `${err.message} Using the Windows voice for now.`));

  input.on('keys', (k) => controller.onKeys(k));
  input.on('esc', () => controller.onEsc());
  input.on('wake', (confidence) => controller.onWake(confidence));
  input.on('dblclick', (p) => controller.onDesktopDoubleClick(p));
  const syncToolTray = () => input.watchDesktopDoubleClick(settings.get('toolTray')).catch(() => {});
  input.on('crash', (code) => {
    logger.error('Input helper exited', code);
    setTimeout(() => { controller.refreshWakeWord(); syncToolTray(); }, 1500);
  });

  settings.onChange((changed) => {
    const view = settings.publicView();
    windows.broadcastSettings(view);
    if ('showBuddy' in changed) windows.broadcast('buddy:visible', changed.showBuddy);
    if ('launchAtLogin' in changed) app.setLoginItemSettings({ openAtLogin: changed.launchAtLogin, args: ['--hidden'] });
    if ('assistantName' in changed || 'wakeWord' in changed) controller.refreshWakeWord();
    if ('toolTray' in changed) syncToolTray();
    if ('keepAiLoaded' in changed) runtime.applyKeepLoaded();
  });

  windows.createEngine();
  windows.syncOverlays();
  createTray({ windows, settings, controller, agent });
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, () => windows.syncOverlays());

  let lastCursor = null;
  const cursorTimer = setInterval(() => {
    const p = screen.getCursorScreenPoint();
    if (lastCursor && lastCursor.x === p.x && lastCursor.y === p.y) return;
    lastCursor = p;
    windows.broadcast('cursor', p);
  }, CURSOR_POLL_MS);

  // Re-register on every start so the login entry follows the app after updates. Login starts go to the tray.
  if (settings.get('launchAtLogin')) app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });

  local.resumeOnStart();
  const upgrading = await local.replaceRetired(async () => catalog.recommend(await hardware.detect(app.getPath('userData'))))
    .catch((err) => { logger.error('Model upgrade failed to start', err.message); return null; });
  if (upgrading) logger.info(`Replacing the retired local model with ${upgrading}`);
  setTimeout(() => { runtime.preload(); if (settings.get('keepAiLoaded') !== false) speech.preload(); }, 3000); // after the windows are up

  try {
    await input.start();
    syncToolTray();
  } catch (err) {
    logger.error('Input helper failed to start', err);
    controller.showError(Object.assign(new Error(`I can’t control the mouse or keyboard: ${err.message}. Reinstalling usually fixes this.`), { title: 'Input helper unavailable' }));
  }

  // Someone who finished an older setup (before the on-device model step) and has no model yet
  // gets that step; everyone who already has a model is simply marked as up to date.
  const oldSetup = settings.get('onboarded') && settings.get('onboardedVersion') < ONBOARDING_VERSION;
  if (oldSetup && settings.get('localModel')) settings.update({ onboardedVersion: ONBOARDING_VERSION });
  if (!settings.get('onboarded') || (oldSetup && !settings.get('localModel') && !local.active())) windows.openOnboarding();
  else if (upgrading) windows.openSettings('account');
  else if (!process.argv.includes('--hidden')) windows.openMain(resolveProvider(settings, { online: isOnline() }) ? 'home' : 'account');
  // Visual QA hooks; never set in normal use.
  if (process.env.BIGFOOT_DEMO === 'qa') global.bigfoot = { controller, windows, agent, audio, plugins, pluginManager, require };
  if (process.env.BIGFOOT_DEMO === '1') require('./demo').runDemo({ windows, controller });
  if (process.env.BIGFOOT_DEMO === 'settings') windows.openSettings(process.env.BIGFOOT_SECTION);
  if (process.env.BIGFOOT_DEMO === 'panel') setTimeout(() => windows.showPanel(), 1500);
  if (process.env.BIGFOOT_DEMO === 'outline') require('./demo').checkOutline({ audio, logger });
  if (process.env.BIGFOOT_DEMO === 'precision') require('./demo').checkPrecision({ input, logger });
  if (process.env.BIGFOOT_DEMO === 'snap') require('./demo').snapPages({ windows, logger });
  else controller.refreshWakeWord();

  app.on('second-instance', () => windows.openMain('home'));
  app.on('window-all-closed', (e) => e.preventDefault()); // lives in the tray
  app.on('before-quit', () => {
    windows.quitting = true;
    clearInterval(cursorTimer);
    agent.stop();
    input.stop();
    runtime.stop();
    speech.stop();
  });
}

function actionArgs(name, inp) {
  const i = inp || {};
  if (name === 'type') {
    const t = String(i.text || '');
    return JSON.stringify(t.length > 80 ? `${t.slice(0, 77)}…` : t);
  }
  if (name === 'write_file') return `${i.path} (${String(i.content || '').length} chars)`;
  if (name === 'run_command') return '';
  if (name === 'annotate') return `${i.shape}${i.label ? ` "${i.label}"` : ''}`;
  return Object.entries(i).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' ');
}

function actionLabel(name, inp) {
  const i = inp || {};
  const labels = {
    screenshot: 'Looked at the screen',
    zoom: 'Zoomed in for a closer look',
    type: `Typed ${String(i.text || '').length} characters`,
    key: `Pressed ${i.text}`,
    scroll: `Scrolled ${i.scroll_direction}`,
    wait: `Waited ${i.duration}s`,
    cursor_position: 'Checked the cursor position',
    annotate: i.shape === 'clear' ? 'Cleared drawings' : `Drew a ${i.shape} on screen`,
    edit_drawing: i.action === 'add' ? `Added ${/^[aeiou]/.test(i.shape || '') ? 'an' : 'a'} ${i.shape || 'stroke'} to your drawing` : i.action === 'erase' ? 'Erased part of your drawing' : 'Cleared your drawing',
    open_app: `Opened ${i.name}`,
    open_url: `Opened ${i.url}`,
    run_command: 'Ran a command',
    list_directory: `Looked in ${i.path}`,
    read_file: `Read ${i.path}`,
    write_file: `Wrote ${i.path}`,
    create_folder: `Created ${i.path}`,
    delete_path: `Moved ${i.path} to the Recycle Bin`,
    open_path: `Opened ${i.path}`,
  };
  return labels[name] || name.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}
