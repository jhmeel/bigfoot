'use strict';
// Creates and tracks every window. Knows nothing about tasks or voice.

const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ICON = path.join(RENDERER, 'assets', 'icon.png');

function webPreferences(extra = {}) {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
    ...extra,
  };
}

/** Hide a window from screen capture so Claude never sees Bigfoot's own UI in screenshots. */
function protect(win) {
  // BIGFOOT_ALLOW_CAPTURE=1 is for visual QA only: it lets screenshots include the overlay.
  if (process.env.BIGFOOT_ALLOW_CAPTURE !== '1') win.setContentProtection(true);
}

function send(win, channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

class WindowManager {
  constructor({ onEngineClosed } = {}) {
    this.overlays = new Map(); // displayId -> BrowserWindow
    this.main = null;
    this.mainPage = null;
    this.approval = null;
    this.engine = null;
    this.tray = null;
    this.toolTray = null;
    this.quitting = false;
    this.onEngineClosed = onEngineClosed;
    this.approvalQueue = Promise.resolve();
    this.cancelApproval = null;
  }

  send(win, channel, payload) { send(win, channel, payload); }
  broadcast(channel, payload) { for (const w of this.overlays.values()) send(w, channel, payload); }
  overlayFor(displayId) { return this.overlays.get(displayId); }
  displayIdOf(webContents) {
    for (const [id, w] of this.overlays) if (!w.isDestroyed() && w.webContents === webContents) return id;
    return null;
  }

  // ------------------------------------------------------------------ overlays (one per display)
  syncOverlays() {
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, win] of this.overlays) {
      if (!ids.has(id)) { if (!win.isDestroyed()) win.destroy(); this.overlays.delete(id); }
    }
    for (const d of displays) {
      const existing = this.overlays.get(d.id);
      if (existing && !existing.isDestroyed()) {
        existing.setBounds(d.bounds);
        continue;
      }
      const win = new BrowserWindow({
        ...d.bounds,
        transparent: true, frame: false, resizable: false, movable: false, focusable: false,
        skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true, fullscreenable: false,
        backgroundColor: '#00000000',
        webPreferences: webPreferences({ backgroundThrottling: false }),
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setIgnoreMouseEvents(true);
      protect(win); // the buddy and drawings never show up in Claude's screenshots
      win.setVisibleOnAllWorkspaces(true);
      win.loadFile(path.join(RENDERER, 'overlay.html'), { query: { displayId: String(d.id) } });
      win.once('ready-to-show', () => { win.showInactive(); win.setBounds(d.bounds); });
      this.overlays.set(d.id, win);
    }
  }

  setOverlaysInteractive(on, displayId = null) {
    for (const [id, w] of this.overlays) {
      if (!w.isDestroyed() && (displayId == null || id === displayId)) w.setIgnoreMouseEvents(!on);
    }
  }

  /** Clicks pass through to the apps below but hover still reaches the page (for the ink toolbar). */
  setOverlayPassthrough(displayId, on) {
    const w = this.overlays.get(displayId);
    if (w && !w.isDestroyed()) w.setIgnoreMouseEvents(on, on ? { forward: true } : undefined);
  }

  /** Ink modes take the keyboard (undo, tool shortcuts) while they're open. */
  setOverlayFocus(displayId, on) {
    const w = this.overlays.get(displayId);
    if (!w || w.isDestroyed()) return;
    w.setFocusable(on);
    if (on) w.focus();
    else w.blur();
  }

  // ------------------------------------------------------------------ tool tray (double-click the desktop)
  showToolTray({ x, y }) {
    const W = 250;
    const H = 88;
    const { workArea: wa } = screen.getDisplayNearestPoint({ x, y });
    const bounds = {
      x: Math.round(Math.max(wa.x + 4, Math.min(x - W / 2, wa.x + wa.width - W - 4))),
      y: Math.round(Math.max(wa.y + 4, Math.min(y - H + 2, wa.y + wa.height - H - 4))),
      width: W, height: H,
    };
    if (!this.toolTray || this.toolTray.isDestroyed()) {
      const win = new BrowserWindow({
        ...bounds, frame: false, transparent: true, resizable: false, movable: false, show: false,
        skipTaskbar: true, alwaysOnTop: true, fullscreenable: false, minimizable: false, maximizable: false,
        hasShadow: false, backgroundColor: '#00000000', webPreferences: webPreferences(),
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      protect(win);
      win.loadFile(path.join(RENDERER, 'toolbar.html'));
      win.on('blur', () => this.hideToolTray());
      this.toolTray = win;
    }
    const win = this.toolTray;
    win.setBounds(bounds);
    const reveal = () => {
      if (win.isDestroyed()) return;
      send(win, 'voice-mode', Boolean(this.voiceMode));
      send(win, 'toolbar:show');
      win.show();
      win.focus();
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
    else reveal();
  }

  hideToolTray() {
    if (this.toolTray && !this.toolTray.isDestroyed() && this.toolTray.isVisible()) this.toolTray.hide();
  }

  // ------------------------------------------------------------------ audio engine (hidden)
  createEngine() {
    this.engine = new BrowserWindow({
      show: false, width: 200, height: 200, skipTaskbar: true,
      webPreferences: webPreferences({ backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' }),
    });
    this.engine.loadFile(path.join(RENDERER, 'engine.html'));
    this.engine.on('closed', () => {
      this.engine = null;
      if (!this.quitting) setTimeout(() => this.createEngine(), 500);
      if (this.onEngineClosed) this.onEngineClosed();
    });
  }

  // ------------------------------------------------------------------ the main window
  // Bigfoot has one window. It shows onboarding on first run, then Home, Settings, and the Terminal.
  get onApp() { return this.main && !this.main.isDestroyed() && this.mainPage === 'app'; }
  get panel() { return this.onApp ? this.main : null; }
  get settings() { return this.onApp ? this.main : null; }
  get terminal() { return this.onApp ? this.main : null; }
  get onboarding() { return this.main && !this.main.isDestroyed() && this.mainPage === 'onboarding' ? this.main : null; }

  createMain() {
    const { workArea: wa } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const width = Math.min(960, wa.width - 40);
    const height = Math.min(680, wa.height - 40);
    this.main = new BrowserWindow({
      width, height, minWidth: 560, minHeight: 480, center: true, show: false, frame: false, transparent: true,
      resizable: true, fullscreenable: false, maximizable: false, backgroundColor: '#00000000', title: 'Bigfoot',
      icon: ICON, webPreferences: webPreferences(),
    });
    protect(this.main); // Bigfoot's own window never appears in the screenshots it sends
    this.mainPage = null;
    // Closing hides to the tray; Quit (tray menu or Settings) really quits.
    this.main.on('close', (e) => {
      if (this.quitting) return;
      e.preventDefault();
      this.main.hide();
    });
    this.main.on('closed', () => { this.main = null; this.mainPage = null; });
  }

  /** Show the main window at a page: 'onboarding', 'home', 'terminal', or a settings section. */
  openMain(route = 'home') {
    if (!this.main || this.main.isDestroyed()) this.createMain();
    const win = this.main;
    const firstShow = !win.isVisible();
    if (route === 'onboarding') {
      if (this.mainPage !== 'onboarding') {
        this.mainPage = 'onboarding';
        win.loadFile(path.join(RENDERER, 'onboarding.html'));
      }
    } else if (this.mainPage !== 'app') {
      this.mainPage = 'app';
      win.loadFile(path.join(RENDERER, 'app.html'), { query: { section: route } });
    } else {
      send(win, 'settings', { section: route });
    }
    const reveal = () => {
      if (win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      if (firstShow) {
        // Windows won't let a background app steal focus, so briefly pin the window on top.
        win.setAlwaysOnTop(true);
        win.moveTop();
        setTimeout(() => { if (!win.isDestroyed()) win.setAlwaysOnTop(false); }, 1200);
      }
    };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', reveal);
    else reveal();
    return win;
  }

  showPanel() { this.openMain('home'); }
  openSettings(section) { this.openMain(section || 'assistant'); }
  openOnboarding() { this.openMain('onboarding'); }
  openTerminal() { this.openMain('terminal'); }

  /** Get out of the way while Bigfoot works on the screen. */
  hidePanel() {
    if (this.main && !this.main.isDestroyed() && this.main.isVisible() && !this.main.isMinimized()) this.main.minimize();
  }

  resizePanel() { /* the main window is sized by the user */ }

  // ------------------------------------------------------------------ approval alerts (one at a time)
  /** Resolves true when the user allows. */
  askApproval(req, { onShow } = {}) {
    const run = () => new Promise((resolve) => {
      const { workArea: wa } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const W = 360;
      const H = req.detail ? 318 : 238;
      const win = new BrowserWindow({
        width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: wa.y + 64,
        frame: false, transparent: true, resizable: false, alwaysOnTop: true, show: false,
        fullscreenable: false, minimizable: false, maximizable: false, backgroundColor: '#00000000', title: 'Permission',
        icon: ICON, webPreferences: webPreferences(),
      });
      this.approval = win;
      win.setAlwaysOnTop(true, 'screen-saver');
      protect(win);
      win.loadFile(path.join(RENDERER, 'approval.html'));

      let settled = false;
      const finish = (answer) => {
        if (settled) return;
        settled = true;
        ipcMain.removeHandler('approval:answer');
        this.approval = null;
        this.cancelApproval = null;
        if (!win.isDestroyed()) win.destroy();
        resolve(Boolean(answer));
      };
      ipcMain.removeHandler('approval:answer');
      ipcMain.handle('approval:answer', (_e, answer) => finish(answer));
      win.webContents.once('did-finish-load', () => {
        send(win, 'approval:show', req);
        win.show();
        win.focus();
        if (onShow) onShow(win);
      });
      win.on('focus', () => win.flashFrame(false));
      win.on('closed', () => finish(false));
      this.cancelApproval = () => finish(false);
    });
    this.approvalQueue = this.approvalQueue.then(run, run);
    return this.approvalQueue;
  }

  broadcastSettings(view) {
    send(this.main, 'settings', view);
    this.broadcast('settings', view);
  }
}

module.exports = { WindowManager, send };
