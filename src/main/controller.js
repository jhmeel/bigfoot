'use strict';
// Coordinates everything the user experiences: voice input, tasks, replies, selection, errors.

const { screen, app, Notification, nativeImage, clipboard, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { strokesToSvg } = require('./plugins/lib/vector');
const { ScreenTarget } = require('./capture');
const { AgentError, toUserError } = require('./agent');
const { resolveProvider } = require('./llm');
const { readInk, interpretInk, splitScripts, pretty } = require('./mathink');
const { solveSystem, evaluate, solveEquation, normalize: normalizeMath } = require('./math');
const cas = require('./cas');
const { matchIntent, matchTerminal } = require('./intents');
const { matchUiCommand } = require('./uicommand');
const kokoro = require('./kokoro');
const { mathmlToText } = require('./mathml');
const { latexToText } = require('./latex');
const mathread = require('./mathread');

const PTT_DELAY_MS = 150;      // ignore quick Ctrl+Alt shortcuts; only a hold starts listening
const MIN_RECORDING_MS = 350;
const ONBOARDING_VERSION = 2; // 2 added the on-device model step
// "Stop listening", "okay stop listening now", "stop listening please, Bigfoot", "that's all thanks"…
const STOP_TALKING = /^\W*(?:(?:ok(?:ay)?|hey|thanks?|please|big ?foot)\W+)*(?:stop listening|stop talking|stop voice|that'?s all|that is all|good ?bye|bye)(?:\W+(?:now|please|thanks?|thank you|big ?foot|for now))*\W*$/i;
const STATE_LABELS ={ idle: 'Ready', listening: 'Listening…', processing: 'Thinking…', acting: 'Working…', responding: 'Talking…' };

class Controller {
  constructor({ windows, settings, agent, audio, input, costs, activity, logger, local, runtime, speech, terminals = null, isOnline = () => true }) {
    Object.assign(this, { windows, settings, agent, audio, input, costs, activity, logger, local, runtime, speech, terminals, isOnline });
    this.state = 'idle';
    this.listenSource = null;   // 'ptt' | 'wake' | 'voice'
    this.voiceMode = false;     // Talk is on: keep listening after every request until it's turned off
    this.voiceTimer = null;
    this.ink = null;            // { mode: 'draw' | 'math', displayId } while an ink tool is open
    this.inkCounts = new Map(); // displayId -> strokes in the user's drawing
    this.inkWaiters = new Map();
    this.inkSeq = 0;
    this.pttDown = false;
    this.pttTimer = null;
    this.recordingStartedAt = 0;
    this.selecting = null;      // null | 'ptt' | 'panel'
    this.pendingRegion = null;  // { displayId, x, y, width, height } in display-local dip
    this.regionAsking = null;   // display showing the ask box next to the marked area
    this.wakeActive = false;
    this.replyTimer = null;
  }

  get name() { return this.settings.get('assistantName'); }

  // ------------------------------------------------------------------ state & feedback
  setState(next) {
    this.state = next;
    this.windows.broadcast('state', next);
    this.windows.send(this.windows.panel, 'state', next);
    if (this.windows.tray) this.windows.tray.setToolTip(`${this.name} · ${STATE_LABELS[next] || 'Ready'}`);
    if (next === 'idle') this.continueVoice();
    this.pauseWakeWord(next === 'processing' || next === 'acting');
  }

  // ------------------------------------------------------------------ Talk (continuous voice)
  setVoiceMode(on) {
    if (on === this.voiceMode) return;
    if (on && !this.requireKey()) return;
    if (on && this.blockedUntilReady()) return;
    this.voiceMode = on;
    this.windows.voiceMode = on;
    this.windows.broadcast('voice-mode', on);
    this.windows.send(this.windows.toolTray, 'voice-mode', on);
    if (on) {
      this.activity.add('info', 'Talk is on: listening until you turn it off.');
      if (this.state === 'responding') this.finishReply();
      this.continueVoice();
    } else {
      clearTimeout(this.voiceTimer);
      this.activity.add('info', 'Talk is off.');
      if (this.state === 'listening' && this.listenSource === 'voice') this.finishListening({ cancel: true });
      this.bubble('okay, i stopped listening', 1800);
    }
  }

  /** In Talk mode, start listening again whenever nothing else is going on. */
  continueVoice() {
    clearTimeout(this.voiceTimer);
    if (!this.voiceMode) return;
    this.voiceTimer = setTimeout(() => {
      if (this.audio.isBusy()) { this.continueVoice(); return; } // never listen to our own voice
      if (this.voiceMode && this.state === 'idle' && !this.agent.running && !this.selecting) this.startListening('voice');
    }, 400);
  }

  panelLog(kind, text) {
    this.windows.send(this.windows.panel, 'log', { kind, text, ts: Date.now() });
  }

  sendUsage() {
    this.windows.send(this.windows.panel, 'usage', { task: this.costs.task, session: this.costs.session });
  }

  cursorDisplayId() {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id;
  }

  /** Red banner typed out on screen, an error sound, and a line in the panel and terminal. */
  showError(err, fallbackTitle = 'Something went wrong') {
    const title = (err && err.title) || fallbackTitle;
    const message = (err && err.message) || String(err);
    this.logger.error(title, message, err && err.stack ? err.stack : '');
    this.windows.broadcast('banner', { kind: 'error', title, message, displayId: this.cursorDisplayId() });
    this.audio.sound('error');
    this.panelLog('error', `${title}: ${message}`);
    this.activity.add('error', `${title}: ${message}`);
  }

  showInfo(title, message) {
    this.windows.broadcast('banner', { kind: 'info', title, message, displayId: this.cursorDisplayId() });
    this.panelLog('info', `${title}: ${message}`);
  }

  /**
   * A Windows toast for anything that needs the user, so a permission request is never missed
   * while they're in another window. Clicking it brings the request to the front.
   */
  notify(title, body, onClick) {
    if (!Notification.isSupported()) return;
    const toast = new Notification({ title, body, icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.png'), urgency: 'critical', timeoutType: 'never' });
    if (onClick) toast.on('click', onClick);
    toast.show();
    this.lastToast = toast; // keep a reference so it isn't garbage-collected before it's clicked
  }

  /** Show the approval alert, sound, toast, and taskbar flash; resolves true when allowed. */
  async requestApproval(req) {
    this.activity.add('info', `Waiting for permission: ${req.title}${req.detail ? ` (${req.detail})` : ''}`);
    const allowed = await this.windows.askApproval(req, {
      onShow: (win) => {
        this.audio.sound('attention');
        win.flashFrame(true);
        this.notify(`${this.name} needs your permission`, [req.title, req.message, req.detail].filter(Boolean).join(' · ').slice(0, 200), () => {
          if (!win.isDestroyed()) { win.show(); win.focus(); }
        });
      },
    });
    if (this.lastToast) { this.lastToast.close(); this.lastToast = null; }
    this.activity.add('info', allowed ? 'Permission granted.' : 'Permission declined.');
    return allowed;
  }

  bubble(text, ttl = 0) {
    this.windows.broadcast('bubble', { text, ttl });
  }

  provider() {
    return resolveProvider(this.settings, { online: this.isOnline() });
  }

  requireKey() {
    if (this.provider()) return true;
    const dl = this.local.snapshot();
    if (this.local.active() || dl.status === 'paused') {
      this.showInfo('Your local AI is almost ready', `It’s ${Math.round((dl.fraction || 0) * 100)}% downloaded. You can follow it in Settings › Models.`);
    } else {
      this.showError(new AgentError('Download your local AI in Settings › Models to get started.', 'Set up your local AI'));
    }
    if (this.settings.get('onboarded')) this.windows.openSettings('account');
    else this.windows.openOnboarding();
    return false;
  }

  // ------------------------------------------------------------------ wake word
  async refreshWakeWord() {
    const want = this.settings.get('wakeWord') && this.settings.get('onboarded');
    try {
      if (want) {
        const language = await this.input.wake([this.name]);
        this.wakeActive = true;
        this.activity.add('info', `Listening for “Hey ${this.name}” (${language}).`);
      } else if (this.wakeActive) {
        await this.input.wakeOff();
        this.wakeActive = false;
      }
    } catch (err) {
      this.wakeActive = false;
      this.logger.error('Wake word unavailable:', err.message);
      this.activity.add('error', `Wake word is unavailable: ${err.message}. Hold Ctrl + Alt to talk instead.`);
    }
    return this.wakeActive;
  }

  /**
   * The wake-word recognizer listens continuously, which costs a CPU core (Windows audio included).
   * It's paused while the AI works, when the model needs every core and "Hey Bigfoot" does
   * nothing anyway, and resumes when Bigfoot is idle again.
   */
  pauseWakeWord(paused) {
    if (paused && this.wakeActive && !this.wakePaused) {
      this.wakePaused = true;
      this.input.wakeOff().catch(() => {});
    } else if (!paused && this.wakePaused) {
      this.wakePaused = false;
      if (this.settings.get('wakeWord')) this.input.wake([this.name]).catch(() => {});
    }
  }

  onWake(confidence) {
    if (this.state !== 'idle' || this.agent.running || this.selecting) return;
    if (!this.settings.get('wakeWord')) return;
    this.activity.add('info', `Heard “${this.name}” (confidence ${confidence.toFixed(2)}).`);
    if (!this.requireKey()) return;
    this.startListening('wake');
  }

  // ------------------------------------------------------------------ hold-to-talk
  onKeys({ ctrl, alt, shift, win }) {
    const down = ctrl && alt && !shift && !win;
    if (down && !this.pttDown) {
      this.pttDown = true;
      clearTimeout(this.pttTimer);
      this.pttTimer = setTimeout(() => {
        if (!this.pttDown) return;
        if (this.agent.running) { this.bubble('still working on it. press esc to stop me', 2500); return; }
        if (!this.requireKey()) return;
        if (this.state === 'listening' && this.listenSource !== 'ptt') {
          this.listenSource = 'ptt'; // Talk was already listening: this recording now ends when the keys are let go
          if (!this.ink) this.setSelecting('ptt');
          return;
        }
        this.startListening('ptt');
      }, PTT_DELAY_MS);
    } else if (!down && this.pttDown) {
      this.pttDown = false;
      clearTimeout(this.pttTimer);
      if (this.state === 'listening' && this.listenSource === 'ptt') this.finishListening();
    }
  }

  /** Double-clicking empty screen while a tray tool is open closes it, like Esc. */
  exitTool() {
    if (this.regionAsking != null || this.pendingRegion) this.clearRegion();
    if (this.selecting === 'panel') this.setSelecting(null);
    if (this.ink) this.stopInk();
  }

  onEsc() {
    if (this.agent.running) { this.stopTask(); return; }
    if (this.regionAsking != null) { this.clearRegion(); return; }
    if (this.voiceMode) { this.setVoiceMode(false); return; }
    if (this.ink) { this.stopInk(); return; }
    if (this.selecting === 'panel') { this.setSelecting(null); this.clearRegion(); return; }
    if (this.state === 'listening') { this.finishListening({ cancel: true }); return; }
    if (this.agent.running) { this.stopTask(); return; }
    if (this.state === 'responding') this.finishReply();
  }

  /**
   * The microphone couldn't start: say why in plain words and open the Windows page that fixes it,
   * instead of just failing. Blocked for apps → Microphone privacy; missing, off, or busy → Sound.
   */
  microphoneHelp(err) {
    const msg = String((err && err.message) || err);
    const blocked = /denied|permission|notallowed|not allowed/i.test(msg);
    const missing = /notfound|not found|no (?:audio|input|microphone)|requested device/i.test(msg);
    const page = blocked ? 'ms-settings:privacy-microphone' : 'ms-settings:sound';
    const text = blocked
      ? 'Your microphone is blocked for apps. Turn on “Microphone access” and “Let desktop apps access your microphone”, then tap Talk again. Opening the settings for you…'
      : missing
        ? 'No microphone was found. Plug one in or turn it on under Input, then tap Talk again. Opening Sound settings for you…'
        : 'Your microphone is off or another app is using it. Check it under Input, then tap Talk again. Opening Sound settings for you…';
    this.logger.error('Microphone unavailable', msg);
    this.activity.add('error', `Microphone unavailable (${msg}).`);
    this.showInfo('Turn on your microphone', text);
    setTimeout(() => shell.openExternal(page).catch(() => {}), 1200);
  }

  async startListening(source) {
    if (this.state === 'responding') this.finishReply();
    if (this.state !== 'idle') return;
    if (this.blockedUntilReady()) {
      if (this.voiceMode) this.setVoiceMode(false);
      return;
    }
    if (this.provider() === 'local') this.runtime.warm();
    try {
      await this.audio.startRecording({ vad: source !== 'ptt', patient: source === 'voice' });
    } catch (err) {
      if (source === 'voice') { this.voiceMode = false; this.windows.voiceMode = false; this.windows.broadcast('voice-mode', false); }
      this.microphoneHelp(err);
      return;
    }
    this.listenSource = source;
    this.recordingStartedAt = Date.now();
    this.setState('listening');
    this.audio.sound('listen-start');
    if (source === 'wake') this.bubble('yes?', 1500);
    // A left-drag while holding the keys highlights what you're asking about. Hands-free listening
    // never takes the mouse, so the other tools and apps keep working.
    if (source === 'ptt' && !this.ink) this.setSelecting('ptt');
  }

  async finishListening({ cancel = false, keepRegion = false } = {}) {
    if (this.state !== 'listening') return;
    const source = this.listenSource;
    this.listenSource = null;
    if (this.selecting === 'ptt') this.setSelecting(null);
    this.audio.sound('listen-stop');
    let rec = null;
    try {
      rec = await this.audio.stopRecording();
    } catch (err) {
      this.setState('idle');
      this.showError(err, 'Recording failed');
      return;
    }
    const tooShort = Date.now() - this.recordingStartedAt < MIN_RECORDING_MS;
    if (cancel || !rec || !rec.wav || !rec.heardSpeech || (tooShort && !this.pendingRegion)) {
      this.setState('idle');
      if (cancel && !keepRegion) this.clearRegion();
      else if (source === 'ptt' && tooShort) this.showInfo('Hold to talk', 'Keep holding Ctrl + Alt while you speak, then let go.');
      else if (this.pendingRegion) this.promptForRegionQuestion();
      return;
    }
    this.setState('processing');
    let text = '';
    try {
      text = await this.transcribe(Buffer.from(rec.wav));
    } catch (err) {
      this.setState('idle');
      this.showError(err, 'Couldn’t understand that');
      return;
    }
    if (!text) {
      this.setState('idle');
      if (this.pendingRegion) this.promptForRegionQuestion();
      else if (source !== 'voice') this.bubble('i didn’t catch that. try again?', 2500);
      return;
    }
    if (source === 'voice' && this.audio.heardItself(text)) {
      this.logger.info(`Ignored speech that was Bigfoot's own voice: "${text}"`);
      this.setState('idle');
      return;
    }
    if (source === 'voice' && STOP_TALKING.test(text)) {
      this.setState('idle');
      this.setVoiceMode(false);
      return;
    }
    this.runTask(text, 'voice');
  }

  /** Whisper on this PC: private, offline, and loaded ahead so a sentence takes about two seconds. */
  async transcribe(wav) {
    try {
      return await this.speech.transcribe(wav);
    } catch (err) {
      this.logger.error('Speech recognition failed', err.message);
      throw Object.assign(new Error(`Speech recognition on this PC failed: ${err.message} You can type your request instead.`), { title: 'Voice input unavailable' });
    }
  }

  // ------------------------------------------------------------------ area selection
  setSelecting(mode) {
    this.selecting = mode;
    if (mode === 'panel' && this.ink) this.stopInk();
    this.windows.setOverlaysInteractive(Boolean(mode));
    if (this.ink) this.windows.setOverlaysInteractive(true, this.ink.displayId);
    this.windows.broadcast('select', { active: Boolean(mode), mode });
    if (!mode) this.continueVoice();
  }

  clearRegion() {
    this.endRegionAsk();
    this.pendingRegion = null;
    this.windows.broadcast('region', null);
    this.windows.send(this.windows.panel, 'region', null);
  }

  startPanelSelection() {
    if (this.agent.running) { this.showInfo('Still working', 'Press Esc to stop the current task first.'); return false; }
    this.windows.hidePanel();
    this.clearRegion();
    this.windows.raiseOverlays(); // other always-on-top windows (a browser, the tray) may have moved above it
    this.setSelecting('panel');
    this.activity.add('info', 'Point: drag around what you want to ask about (Esc cancels).');
    return true;
  }

  onRegionSelected(displayId, rect) {
    if (displayId == null || !rect || rect.width < 6 || rect.height < 6) {
      this.activity.add('info', `Point: that drag was too small to mark an area${rect ? ` (${Math.round(rect.width)}×${Math.round(rect.height)})` : ''}.`);
      return;
    }
    const points = Array.isArray(rect.points)
      ? rect.points.slice(0, 400).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
      : null;
    clearTimeout(this.regionFade);
    this.endRegionAsk();
    this.pendingRegion = { displayId, x: rect.x, y: rect.y, width: rect.width, height: rect.height, points };
    for (const [id, w] of this.windows.overlays) if (id !== displayId) this.windows.send(w, 'region', null);
    this.activity.add('info', `Area selected: ${Math.round(rect.width)}×${Math.round(rect.height)} at (${Math.round(rect.x)}, ${Math.round(rect.y)}).`);
    if (this.selecting === 'panel') {
      this.setSelecting(null);
      this.promptForRegionQuestion();
    }
  }

  /** Ask right next to the marked area: a small box on the overlay (in Talk mode, speaking works too). */
  promptForRegionQuestion() {
    if (!this.pendingRegion) return;
    const id = this.pendingRegion.displayId;
    this.windows.broadcast('region', { ...this.pendingRegion, ask: true, voice: this.voiceMode });
    this.regionAsking = id;
    this.windows.setOverlaysInteractive(true, id);
    this.windows.setOverlayFocus(id, true);
  }

  /** A question typed into the box next to the marked area. */
  async askAboutRegion(text) {
    if (!text) { this.clearRegion(); return; }
    if (this.state === 'listening') await this.finishListening({ cancel: true, keepRegion: true }); // typed instead of spoken
    await this.runTask(text, 'typed');
  }

  endRegionAsk() {
    const id = this.regionAsking;
    if (id == null) return;
    this.regionAsking = null;
    if (this.ink && this.ink.displayId === id) return; // drawing keeps the overlay
    this.windows.setOverlaysInteractive(Boolean(this.selecting), id);
    this.windows.setOverlayFocus(id, false);
  }

  /**
   * Screenshot size. Claude reads coordinates reliably at full HD; OpenAI shrinks images to about
   * 1366 px internally. The local model points on its own grid, so smaller images just run faster.
   */
  screenshotEdge() {
    const provider = this.provider();
    if (provider === 'local') return this.runtime.tuning.edge;
    if (provider !== 'anthropic') return 1366;
    return this.settings.get('screenDetail') === 'standard' ? 1366 : 1920;
  }

  // ------------------------------------------------------------------ tool tray and math
  onDesktopDoubleClick(physical) {
    if (!this.settings.get('toolTray') || !this.settings.get('onboarded')) return;
    if (this.selecting || (this.ink && !this.inkThrough)) return;
    if (this.state === 'listening' && this.listenSource !== 'voice') return;
    this.windows.showToolTray(screen.screenToDipPoint(physical));
  }

  /**
   * While the local AI is starting, or reading its instructions for the first time, its tools wait:
   * anything asked now would only queue behind that (up to 15 minutes on a PC without a graphics
   * card). Returns what to tell the user, or null when ready.
   */
  aiNotReady() {
    if (this.provider() !== 'local') return null;
    const s = this.runtime.status();
    if (s.state === 'loading') return `Bigfoot’s AI is still starting (${s.percent}%).`;
    if (s.state === 'preparing') return `Bigfoot is getting ready for first use (${s.percent ? `${s.percent}%` : 'one time only'}).`;
    return null;
  }

  /** True (after telling the user) when the tools have to wait for the AI. */
  blockedUntilReady() {
    const why = this.aiNotReady();
    if (!why) return false;
    this.showInfo('Getting ready', `${why} The tools turn on as soon as it’s done.`);
    return true;
  }

  pickTool(tool) {
    this.windows.hideToolTray();
    if (tool && tool !== 'clear' && this.blockedUntilReady()) return;
    switch (tool) {
      case 'talk':
        this.setVoiceMode(!this.voiceMode);
        return;
      case 'select':
        this.startPanelSelection();
        return;
      case 'draw':
        this.startInk('draw', this.cursorDisplayId());
        return;
      case 'math':
        this.startInk('math', this.cursorDisplayId()); // sums are read by Windows; only equations need the model
        return;
      case 'type':
        this.windows.openMain('home');
        return;
      case 'clear':
        this.windows.broadcast('annotate', { shape: 'clear' });
        this.windows.broadcast('ink', { clear: true });
        this.clearRegion();
        return;
      default:
    }
  }

  /** Draw or math on one display; it takes the mouse and keyboard until closed. */
  startInk(mode, displayId, { tool = null, focus = true } = {}) {
    if (mode === 'math') {
      cas.compute('1').catch(() => {}); // load the math engine while the user writes
      mathread.warm().catch(() => {}); // and the handwriting reader (a second or two the first time)
      // Start Windows' Math Recognizer now (its first reading takes seconds), with one tiny stroke.
      if (!mathread.available() && this.mathRecognizer !== false && !this.mathRecognizerWarm) {
        this.mathRecognizerWarm = true;
        this.input.recognizeMath([[{ x: 10, y: 10 }, { x: 30, y: 10 }]]).catch(() => { this.mathRecognizerWarm = false; });
      }
    }
    if (this.ink && this.ink.mode === mode && this.ink.displayId === displayId) {
      // Already open (e.g. in pointer mode): pick up drawing again without losing it.
      if (focus) this.windows.setOverlayFocus(displayId, true);
      this.windows.broadcast('ink', { active: true, mode, displayId, tool });
      return;
    }
    if (this.ink) this.stopInk();
    this.setSelecting(null);
    this.ink = { mode, displayId };
    this.windows.setOverlaysInteractive(true, displayId);
    if (focus) this.windows.setOverlayFocus(displayId, true);
    this.windows.broadcast('ink', { active: true, mode, displayId, tool });
    if (this.agent.running) this.setInkBusy(true);
    if (mode === 'math' && this.provider() === 'local') this.runtime.warm();
  }

  /** While the AI works, its clicks must reach the apps under the drawing. */
  setInkBusy(on) {
    if (!this.ink) return;
    if (on) this.windows.setOverlayPassthrough(this.ink.displayId, true);
    this.windows.broadcast('ink', { busy: on, displayId: this.ink.displayId });
  }

  /** Ask the overlay on a display for something and wait for its answer. */
  inkRequest(displayId, payload, timeoutMs = 5000) {
    const win = this.windows.overlayFor(displayId);
    if (!win || win.isDestroyed()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const id = ++this.inkSeq;
      const timer = setTimeout(() => { this.inkWaiters.delete(id); resolve(null); }, timeoutMs);
      this.inkWaiters.set(id, (result) => { clearTimeout(timer); resolve(result); });
      this.windows.send(win, 'ink', { ...payload, id, displayId });
    });
  }

  onInkReply({ id, result }) {
    const done = this.inkWaiters.get(id);
    if (!done) return;
    this.inkWaiters.delete(id);
    done(result);
  }

  onInkState(displayId, { count }) {
    if (displayId != null) this.inkCounts.set(displayId, Number(count) || 0);
  }

  /** Screenshots can't see the overlay, so the drawing is laid over them for the model. */
  async withDrawing(displayId, png, crop) {
    if (!this.inkCounts.get(displayId)) return png;
    const overlay = await this.inkRequest(displayId, { op: 'snapshot' });
    if (!overlay) return png;
    return Buffer.from(await this.audio.call('composite', { png, overlay, crop }, 15000));
  }

  /**
   * Share a drawing: 'copy' puts the screen with the drawing on the clipboard; 'png' saves that
   * picture and 'svg' the drawing alone as vectors, both in Pictures › Bigfoot.
   */
  async shareDrawing(displayId, kind) {
    const strokes = await this.inkRequest(displayId, { op: 'strokes' });
    if (!Array.isArray(strokes) || !strokes.length) return { ok: false, message: 'Draw something first' };
    const folder = path.join(app.getPath('pictures'), 'Bigfoot');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ').replace(/:/g, '.');
    try {
      if (kind === 'svg') {
        const out = strokesToSvg(strokes, { maxPoints: 400 });
        fs.mkdirSync(folder, { recursive: true });
        const file = path.join(folder, `Drawing ${stamp}.svg`);
        fs.writeFileSync(file, out.svg);
        this.activity.add('info', `Saved the drawing to ${file}`);
        return { ok: true, message: 'Saved to Pictures › Bigfoot', file };
      }
      const display = screen.getAllDisplays().find((d) => d.id === displayId) || screen.getPrimaryDisplay();
      const edge = Math.round(Math.max(display.bounds.width, display.bounds.height) * display.scaleFactor);
      const target = new ScreenTarget(display, edge);
      const png = await this.withDrawing(displayId, await target.capturePng(), null);
      if (kind === 'copy') {
        clipboard.writeImage(nativeImage.createFromBuffer(png));
        return { ok: true, message: 'Copied. Paste it anywhere' };
      }
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, `Drawing ${stamp}.png`);
      fs.writeFileSync(file, png);
      this.activity.add('info', `Saved the drawing to ${file}`);
      return { ok: true, message: 'Saved to Pictures › Bigfoot', file };
    } catch (err) {
      this.logger.error('Sharing the drawing failed', err.message);
      return { ok: false, message: `Couldn’t share it: ${err.message}` };
    }
  }

  revealFile(file) {
    const folder = path.join(app.getPath('pictures'), 'Bigfoot');
    if (typeof file === 'string' && path.resolve(file).startsWith(folder)) shell.showItemInFolder(file);
  }

  /** The AI changing the user's drawing (the edit_drawing tool). */
  async editInk({ displayId, ...op }) {
    if (this.ink && this.ink.mode === 'math') throw new Error('The user has the math tool open; drawing would close it. Tell them to close it first.');
    if (!this.ink || this.ink.mode !== 'draw' || this.ink.displayId !== displayId) {
      this.startInk('draw', displayId, { tool: 'pointer', focus: false });
    }
    const result = await this.inkRequest(displayId, op);
    if (result == null) throw new Error('The drawing layer didn’t respond.');
    return result;
  }

  stopInk() {
    if (!this.ink) return;
    const { displayId } = this.ink;
    this.ink = null;
    this.inkThrough = false;
    this.windows.setOverlayFocus(displayId, false);
    this.windows.setOverlaysInteractive(false, displayId);
    this.windows.broadcast('ink', { active: false });
  }

  /** Draw's pointer mode: clicks go to the apps below while the drawing stays up. */
  setInkPassthrough(displayId, on) {
    if (!this.ink || this.ink.displayId !== displayId) return;
    this.inkThrough = on;
    this.windows.setOverlayPassthrough(displayId, on);
  }

  /** Live reading of the math tool's handwriting: the built-in math reader, else Windows' recognizers. */
  async readMathInk(strokes, image) {
    const clean = (Array.isArray(strokes) ? strokes : []).slice(0, 300).map((s) => (Array.isArray(s) ? s : [])
      .slice(0, 2000).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))).filter((s) => s.length);
    if (!clean.length) return { ok: true, text: '', status: 'unknown' };
    try {
      // The math reader (./mathread) reads a picture of the writing, like a person would. Without it,
      // Windows' Math Recognizer, then the plain handwriting recognizer.
      let segments = null;
      let byReader = false;
      if (image && mathread.available()) {
        try {
          const text = latexToText(await mathread.readFormula(Buffer.from(image)));
          if (text) { segments = [[text]]; byReader = true; }
        } catch (err) {
          this.logger.error('Math reader failed, using Windows recognition', err.message);
        }
      }
      if (!segments && this.mathRecognizer !== false) {
        try {
          const text = mathmlToText(await this.input.recognizeMath(clean));
          if (text) segments = [[text]];
        } catch (err) {
          if (/not installed/i.test(err.message)) this.mathRecognizer = false; // don't ask again
          this.logger.error('Math recognizer unavailable, using handwriting recognition', err.message);
        }
      }
      if (!segments) {
        // Powers (the small raised 2 in x²) are read on their own and written as ^( ).
        segments = [];
        for (const run of splitScripts(clean)) {
          const read = await this.input.recognizeInk(run.strokes);
          if (run.sup) segments.push(['^('], ...read, [')']);
          else segments.push(...read);
        }
      }
      const res = interpretInk(segments);
      // Without the math reader, a PC with a graphics card (or a cloud model) reads an image in
      // seconds: there the AI double-checks the Windows reading.
      res.aiFast = !byReader && (this.provider() !== 'local' || Boolean(this.runtime.tuning && !this.runtime.tuning.cpuOnly));
      if (res.status === 'compute') {
        try {
          const r = await cas.compute(res.compute);
          return { ok: true, ...res, status: 'solved', answer: r.decimal ? `${r.answer} ≈ ${r.decimal}` : r.answer, steps: await cas.working(res.compute) };
        } catch {
          return { ok: true, ...res, status: 'solve' }; // the model reads it from the image instead
        }
      }
      return { ok: true, ...res };
    } catch (err) {
      this.logger.error('Handwriting recognition failed', err.message);
      return { ok: false, message: `Handwriting recognition isn’t available: ${err.message}` };
    }
  }

  /**
   * The typed calculator: sums exactly, equations by the solver, and anything else (sin, log,
   * d/dx, ∫, vectors, simplifying) by the symbolic engine. Never the AI model.
   */
  async calculate(text, angle = 'deg') {
    const expr = String(text || '').trim().slice(0, 400);
    if (!expr) return { ok: false, message: 'Type something to calculate' };
    let plainError = null;
    try { const r = evaluate(expr, { angle }); return { ok: true, answer: r.text }; } catch (err) {
      // A plain sum that's mathematically invalid (1/0, √−4, tan 90°) gets that exact message, like a calculator.
      if (!/variable|equation|Unknown name|Unexpected/i.test(err.message)) plainError = err.message;
    }
    if (plainError) return { ok: false, message: plainError };
    if (expr.includes('=')) {
      try { const r = solveEquation(expr); return { ok: true, answer: r.text, steps: r.steps }; } catch { /* next */ }
    }
    const form = cas.fromHandwriting(expr) || (expr.includes('=') ? null : expr);
    if (form) {
      try {
        const r = await cas.compute(form);
        return { ok: true, answer: r.decimal ? `${r.answer} ≈ ${r.decimal}` : r.answer, steps: await cas.working(form) };
      } catch (err) {
        return { ok: false, message: err.message };
      }
    }
    return { ok: false, message: 'I couldn’t work that out' };
  }

  /** Linear equations on several lines, solved together (x + y = 5 and x − y = 1). */
  solveMathSystem(expressions) {
    try {
      const list = (Array.isArray(expressions) ? expressions : []).slice(0, 10).map(String);
      const r = solveSystem(list);
      this.activity.add('info', `Math: ${list.map(pretty).join(' ; ')} → ${r.text}`);
      return { ok: true, answer: r.text, steps: r.steps };
    } catch (err) {
      return { ok: false, message: err.message };
    }
  }

  async readMath(png) {
    try {
      const r = await readInk({ png: Buffer.from(png), settings: this.settings, runtime: this.runtime, online: this.isOnline() });
      if (r.expression) this.activity.add('info', `Math (read by the AI): ${r.expression}${r.answer ? ` = ${r.answer}` : ''}`);
      const isForm = /^(?:diff|integrate|defint|limit|dot|cross|sum|system|simplify|solve)\(/.test(r.expression || '');
      const text = !r.expression ? '' : isForm ? cas.display(r.expression) : pretty(normalizeMath(r.expression));
      return { ok: true, ...r, text };
    } catch (err) {
      this.logger.error('Math tool failed', err.message);
      return { ok: false, message: err.message };
    }
  }

  // ------------------------------------------------------------------ tasks
  stopTask() {
    if (!this.agent.running) return;
    this.agent.stop();
    if (this.windows.cancelApproval) this.windows.cancelApproval();
    this.activity.add('info', 'Stopped by the user.');
  }

  async runTask(text, source = 'typed') {
    text = String(text || '').trim();
    if (!text) return { ok: false };
    if (this.agent.running) { this.showInfo('Still working', 'Press Esc to stop the current task first.'); return { ok: false }; }
    if (!this.requireKey()) { this.setState('idle'); return { ok: false }; }
    if (this.blockedUntilReady()) { this.setState('idle'); return { ok: false }; }
    if (this.state === 'responding') this.finishReply();

    const region = this.pendingRegion;
    this.endRegionAsk();
    this.pendingRegion = null;
    this.windows.send(this.windows.panel, 'region', null);
    const wanted = region ? region.displayId : this.ink ? this.ink.displayId : null;
    const display = (wanted != null && screen.getAllDisplays().find((d) => d.id === wanted))
      || screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const target = new ScreenTarget(display, this.screenshotEdge());
    target.decorate = (png, crop) => this.withDrawing(display.id, png, crop);
    const drawing = (this.inkCounts.get(display.id) || 0) > 0;
    this.agent.setTarget(target);
    this.setInkBusy(true);
    let sentRegion = null;
    if (region) {
      const sx = target.sent.width / display.bounds.width;
      const sy = target.sent.height / display.bounds.height;
      sentRegion = {
        x0: region.x * sx, y0: region.y * sy, x1: (region.x + region.width) * sx, y1: (region.y + region.height) * sy,
        points: region.points && region.points.length > 2 ? region.points.map((p) => [p.x * sx, p.y * sy]) : null,
      };
      this.windows.broadcast('region', { ...region, analyzing: true });
      // The screenshot doesn't include the overlay; the mark only needs to show the question was taken.
      clearTimeout(this.regionFade);
      this.regionFade = setTimeout(() => this.windows.broadcast('region', null), 1600);
    }

    this.streamed = '';
    this.audio.beginStream();
    this.panelLog('user', text);
    this.logger.audit('task', { source, chars: text.length, region: Boolean(region) });
    this.setState('processing');
    const local = this.provider() === 'local';
    // Everyday commands ("search for …", "open Spotify") run at once, without the model.
    const intent = !region && !drawing ? matchIntent(text) : null;
    this.bubble(intent ? '' : local && this.runtime.preparing ? `getting ready for first use (${this.runtime.preparing.percent}%). your answer comes right after…`
      : local && !this.runtime.running ? 'one moment, my AI is still loading…' : '');
    try {
      // "open the terminal", "run npm install in the terminal": Bigfoot's own terminal, at once.
      const term = !region && !drawing && this.terminals ? matchTerminal(text) : null;
      if (term) {
        const reply = await this.terminalCommand(term);
        if (reply) await this.presentReply(reply, null, display.id);
        else this.setState('idle');
        return { ok: true };
      }
      // "click Sign in", "scroll down": done from the screen list in about a second, no model.
      const uiCommand = !intent && !region && !drawing ? matchUiCommand(text) : null;
      if (uiCommand) {
        this.setState('acting');
        const reply = await this.agent.runUiCommand(uiCommand, text).catch((err) => {
          this.logger.error('On-screen command failed, asking the AI', err.message);
          return null;
        });
        if (reply != null) {
          if (reply) await this.presentReply(reply, null, display.id);
          else this.setState('idle');
          return { ok: true };
        }
        this.setState('processing'); // not clear which element: the model decides, with the list
      }
      if (intent) {
        this.setState('acting');
        await this.agent.runDirect(intent.calls);
        if (!intent.followUp) {
          await this.presentReply(intent.reply, null, display.id);
          return { ok: true };
        }
        this.panelLog('progress', intent.reply);
        this.setState('processing');
      }
      // The local model takes a while to answer: a spoken request hears "On it." at once.
      if (local && source === 'voice') this.audio.acknowledge();
      const result = await this.agent.run(intent ? intent.followUp : text, { region: sentRegion, drawing });
      this.sendUsage();
      if (result.status === 'stopped') {
        this.audio.stopSpeaking();
        this.setState('idle');
        this.bubble('okay, stopped.', 1800);
        return { ok: true };
      }
      await this.presentReply(result.text || 'Done.', result.point, display.id);
      return { ok: true };
    } catch (err) {
      this.sendUsage();
      this.setState('idle');
      this.showError(toUserError(err));
      return { ok: false };
    } finally {
      if (region && !this.pendingRegion) { clearTimeout(this.regionFade); this.windows.broadcast('region', null); }
      this.setInkBusy(false);
    }
  }

  /**
   * Bigfoot's Terminal page: open it (with a new tab of a shell), or run a command in the user's
   * terminal where they can see and use it. The command is shown for approval first.
   */
  async terminalCommand(cmd) {
    const t = this.terminals;
    const mine = () => t.list().filter((s) => s.owner === 'user' && !s.exited && (s.shell === 'powershell' || s.shell === 'pwsh'));
    let tab = null;
    if (cmd.kind === 'open') {
      tab = cmd.shell ? t.create({ shell: cmd.shell }) : (mine().pop() || t.create({ shell: 'powershell' }));
      this.windows.openTerminal();
      this.windows.send(this.windows.main, 'term:focus', tab.id);
      return cmd.shell ? `Opened ${tab.name}.` : 'Here’s your terminal.';
    }
    await this.agent.confirm('change', { title: 'Run this in the terminal?', message: 'In your terminal', detail: cmd.command, confirm: 'Run' })
      .catch((err) => { throw Object.assign(err, { title: 'Not run' }); });
    tab = mine().find((s) => !s.busy) || t.create({ shell: 'powershell' });
    await t.ready(tab.id);
    this.windows.openTerminal();
    this.windows.send(this.windows.main, 'term:focus', tab.id);
    this.activity.add('command', cmd.command);
    t.write(tab.id, `${cmd.command}\r`);
    return `Running it in your terminal.`;
  }

  /** The local model's answer, shown next to the cursor while it's being written. */
  streamReply(text) {
    const clean = String(text || '').replace(/\[POINT[^\]]*\]?/gi, '').replace(/\s{2,}/g, ' ').trim();
    if (!clean) return;
    this.streamed = clean;
    this.audio.feedStream(clean); // speak each sentence as soon as it's complete
    this.windows.send(this.windows.panel, 'log-live', { text: clean });
    // In the chat already: don't write it out a second time next to the cursor.
    if (!this.windows.chatInView()) this.windows.broadcast('bubble-live', { text: clean, displayId: this.agent.target ? this.agent.target.display.id : null });
  }

  /** The area the user marked, as a picture with their question in the chat. */
  showRegionInChat(png) {
    try {
      let img = nativeImage.createFromBuffer(Buffer.from(png));
      const { width } = img.getSize();
      if (width > 640) img = img.resize({ width: 640, quality: 'good' });
      this.windows.send(this.windows.panel, 'log-image', { src: `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}` });
    } catch (err) {
      this.logger.error('Couldn’t show the marked area in the chat', err.message);
    }
  }

  /** The model's last words were a plan it's now being told to carry out: take them back. */
  discardStream() {
    this.streamed = '';
    this.audio.stopSpeaking();
    this.audio.beginStream();
    this.windows.send(this.windows.panel, 'log-live', { text: '' });
    this.windows.broadcast('bubble-live', { text: '' });
  }

  /** Warm the local model's cache so the first request only has to read the new screenshot and words. */
  async warmLocal() {
    if (this.provider() !== 'local' || this.agent.running || this.warming) return;
    this.warming = true;
    const started = Date.now();
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.agent.setTarget(new ScreenTarget(display, this.screenshotEdge()));
      this.runtime.setPreparing(0);
      this.pauseWakeWord(true);
      let percent = 0;
      // Some llama.cpp builds report reading progress only at the start and end: keep the clock moving.
      const tick = setInterval(() => { if (this.runtime.preparing) this.runtime.setPreparing(percent); }, 5000);
      const restored = await this.agent.warm((p) => {
        if (p && p.total) { percent = (100 * p.processed) / p.total; this.runtime.setPreparing(percent); }
      }).finally(() => clearInterval(tick));
      this.logger.info(restored
        ? `The local AI's instructions were restored from disk (${Math.round((Date.now() - started) / 1000)} s)`
        : `The local AI read its instructions once and saved them (${Math.round((Date.now() - started) / 1000)} s); later starts restore them`);
    } catch (err) {
      this.logger.error('Couldn’t prepare the local AI', err.message);
    } finally {
      this.warming = false;
      this.runtime.setPreparing(null);
      this.pauseWakeWord(this.state === 'processing' || this.state === 'acting');
    }
  }

  /** Type the reply next to the cursor and speak it; without a voice, leave it up long enough to read. */
  async presentReply(reply, point, displayId) {
    this.panelLog('assistant', reply);
    this.activity.add('reply', reply);
    this.setState('responding');
    this.audio.sound('done');
    if (point) this.windows.send(this.windows.overlayFor(point.displayId), 'fly', { ...point, hold: true });
    // Already on screen from streaming: finish it in place rather than typing it out again.
    if (this.windows.chatInView()) this.windows.broadcast('bubble-live', { text: '' }); // the chat shows it
    else if (this.streamed && reply.startsWith(this.streamed.slice(0, 40))) this.windows.broadcast('bubble-live', { text: reply, displayId });
    else this.windows.broadcast('bubble', { text: reply, ttl: 0, displayId });
    this.streamed = '';

    const used = await this.audio.finishStream(reply); // whatever wasn't already spoken while streaming
    if (this.state !== 'responding') return;
    const readingMs = used === 'none' ? Math.min(16000, Math.max(4500, 2000 + reply.length * 45)) : 1400;
    clearTimeout(this.replyTimer);
    this.replyTimer = setTimeout(() => { if (this.state === 'responding') this.finishReply(); }, readingMs);
  }

  finishReply() {
    clearTimeout(this.replyTimer);
    this.audio.stopSpeaking();
    this.bubble('');
    if (this.state === 'responding') this.setState('idle');
  }

  /** A voice saying hello: ready-made (plays at once) when it can be, else spoken now. */
  async previewVoice(voice = null) {
    const id = voice || this.settings.get('voice');
    const file = kokoro.previewFile(id, this.name, this.settings.get('speechRate'));
    if (file) return this.audio.playFile(file);
    return this.audio.speak(kokoro.previewText(this.name), { force: true, voice: id });
  }

  finishOnboarding({ launchAtLogin }) {
    this.settings.update({ onboarded: true, onboardedVersion: ONBOARDING_VERSION, launchAtLogin: launchAtLogin !== false });
    app.setLoginItemSettings({ openAtLogin: launchAtLogin !== false, args: ['--hidden'] });
    // While the model downloads, land on Models, where the banner shows its progress.
    this.windows.openMain(this.provider() ? 'home' : 'account');
    this.audio.sound('done');
    this.windows.broadcast('welcome', { text: `hey! i’m ${this.name.toLowerCase()}` });
    const hint = this.settings.get('wakeWord') ? `say “hey ${this.name.toLowerCase()}” or hold ctrl + alt` : 'hold ctrl + alt and tell me what to do';
    setTimeout(() => this.bubble(hint, 5000), 4200);
    this.refreshWakeWord();
  }
}

module.exports = { Controller, STATE_LABELS, ONBOARDING_VERSION };
