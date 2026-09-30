'use strict';
// Coordinates everything the user experiences: voice input, tasks, replies, selection, errors.

const { screen, app, Notification } = require('electron');
const path = require('path');
const { ScreenTarget } = require('./capture');
const { AgentError, toUserError } = require('./agent');
const { resolveProvider } = require('./llm');
const { readInk, interpretInk } = require('./mathink');
const voice = require('./voice');

const PTT_DELAY_MS = 150;      // ignore quick Ctrl+Alt shortcuts; only a hold starts listening
const MIN_RECORDING_MS = 350;
const ONBOARDING_VERSION = 2; // 2 added the on-device model step
const STOP_TALKING =/^\W*(?:(?:ok(?:ay)?|hey|thanks?)\W+)?(?:stop listening|stop talking|stop voice|that'?s all|that is all|good ?bye|bye)\W*$/i;
const STATE_LABELS ={ idle: 'Ready', listening: 'Listening…', processing: 'Thinking…', acting: 'Working…', responding: 'Talking…' };

class Controller {
  constructor({ windows, settings, agent, audio, input, costs, activity, logger, local, runtime, speech, isOnline = () => true }) {
    Object.assign(this, { windows, settings, agent, audio, input, costs, activity, logger, local, runtime, speech, isOnline });
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
  }

  // ------------------------------------------------------------------ Talk (continuous voice)
  setVoiceMode(on) {
    if (on === this.voiceMode) return;
    if (on && !this.requireKey()) return;
    this.voiceMode = on;
    this.windows.voiceMode = on;
    this.windows.broadcast('voice-mode', on);
    this.windows.send(this.windows.toolTray, 'voice-mode', on);
    if (on) {
      this.activity.add('info', 'Talk is on: listening until you turn it off.');
      this.bubble('i’m listening. say “stop listening” or press esc when you’re done', 4000);
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
        if (this.state === 'listening' && this.listenSource !== 'ptt') { this.listenSource = 'ptt'; return; }
        this.startListening('ptt');
      }, PTT_DELAY_MS);
    } else if (!down && this.pttDown) {
      this.pttDown = false;
      clearTimeout(this.pttTimer);
      if (this.state === 'listening' && this.listenSource === 'ptt') this.finishListening();
    }
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

  async startListening(source) {
    if (this.state === 'responding') this.finishReply();
    if (this.state !== 'idle') return;
    if (this.provider() === 'local') this.runtime.warm();
    try {
      await this.audio.startRecording({ vad: source !== 'ptt', patient: source === 'voice' });
    } catch (err) {
      if (source === 'voice') { this.voiceMode = false; this.windows.voiceMode = false; this.windows.broadcast('voice-mode', false); }
      this.showError(Object.assign(new Error(/denied|permission|notallowed/i.test(err.message)
        ? 'Allow microphone access in Windows Settings › Privacy & security › Microphone, then try again.'
        : `The microphone couldn’t start: ${err.message}`), { title: 'Microphone unavailable' }));
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

  async finishListening({ cancel = false } = {}) {
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
      if (cancel) this.clearRegion();
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
    if (source === 'voice' && STOP_TALKING.test(text)) {
      this.setState('idle');
      this.setVoiceMode(false);
      return;
    }
    this.runTask(text, 'voice');
  }

  /** Whisper on this PC, or the chosen cloud service while online. */
  async transcribe(wav) {
    const provider = this.settings.get('sttProvider');
    const key = provider === 'local' ? '' : this.settings.secret(provider === 'elevenlabs' ? 'elevenlabsKey' : 'openaiKey');
    if (key && this.isOnline()) {
      try {
        return await voice.transcribe({ provider, key, audio: wav, mimeType: 'audio/wav' });
      } catch (err) {
        this.activity.add('error', `${err.message} Using the recognizer on this PC instead.`);
      }
    }
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
    this.setSelecting('panel');
    this.showInfo('Select an area', 'Drag over the part of the screen you want to ask about. Press Esc to cancel.');
    return true;
  }

  onRegionSelected(displayId, rect) {
    if (displayId == null || !rect || rect.width < 6 || rect.height < 6) return;
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

  /** Ask right next to the marked area: a small box on the overlay, or just speak in Talk mode. */
  promptForRegionQuestion() {
    if (!this.pendingRegion) return;
    const id = this.pendingRegion.displayId;
    const ask = !this.voiceMode;
    this.windows.broadcast('region', { ...this.pendingRegion, ask });
    if (ask) {
      this.regionAsking = id;
      this.windows.setOverlaysInteractive(true, id);
      this.windows.setOverlayFocus(id, true);
    } else this.bubble('what about it?', 2500);
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

  pickTool(tool) {
    this.windows.hideToolTray();
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

  /** The AI changing the user's drawing (the edit_drawing tool). */
  async editInk({ displayId, ...op }) {
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

  /** Live reading of the math tool's handwriting with the Windows recognizer. */
  async readMathInk(strokes) {
    const clean = (Array.isArray(strokes) ? strokes : []).slice(0, 300).map((s) => (Array.isArray(s) ? s : [])
      .slice(0, 2000).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))).filter((s) => s.length);
    if (!clean.length) return { ok: true, text: '', status: 'unknown' };
    try {
      return { ok: true, ...interpretInk(await this.input.recognizeInk(clean)) };
    } catch (err) {
      this.logger.error('Handwriting recognition failed', err.message);
      return { ok: false, message: `Handwriting recognition isn’t available: ${err.message}` };
    }
  }

  async readMath(png) {
    try {
      const r = await readInk({ png: Buffer.from(png), settings: this.settings, runtime: this.runtime, online: this.isOnline() });
      if (r.expression) this.activity.add('info', `Math: ${r.expression}${r.answer ? ` = ${r.answer}` : ''}`);
      return { ok: true, ...r };
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
    this.bubble('');
    try {
      const result = await this.agent.run(text, { region: sentRegion, drawing });
      this.sendUsage();
      if (result.status === 'stopped') {
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

  /** The local model's answer, shown next to the cursor while it's being written. */
  streamReply(text) {
    const clean = String(text || '').replace(/\[POINT[^\]]*\]?/gi, '').replace(/\s{2,}/g, ' ').trim();
    if (!clean) return;
    this.streamed = clean;
    this.audio.feedStream(clean); // speak each sentence as soon as it's complete
    this.windows.send(this.windows.panel, 'log-live', { text: clean });
    this.windows.broadcast('bubble-live', { text: clean, displayId: this.agent.target ? this.agent.target.display.id : null });
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
    if (this.provider() !== 'local' || this.agent.running) return;
    try {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      this.agent.setTarget(new ScreenTarget(display, this.screenshotEdge()));
      await this.agent.warm();
    } catch (err) {
      this.logger.error('Couldn’t warm the local AI', err.message);
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
    if (this.streamed && reply.startsWith(this.streamed.slice(0, 40))) this.windows.broadcast('bubble-live', { text: reply, displayId });
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

  async previewVoice() {
    return this.audio.speak(`Hi! I’m ${this.name}. Hold Control and Alt, or just say hey ${this.name}, and tell me what to do.`, { force: true });
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
