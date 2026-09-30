'use strict';
// The buddy: the Bigfoot paw, springing after the cursor. It becomes a waveform while listening
// and a spinner while thinking, and flies in an arc to point at things.

(() => {
  const api = window.buddy;
  const params = new URLSearchParams(location.search);
  const displayId = Number(params.get('displayId'));

  const $buddy = document.getElementById('buddy');
  const $paw = document.getElementById('paw');
  const $bars = [...document.querySelectorAll('#wave i')];
  const $bubble = document.getElementById('bubble');
  const $banner = document.getElementById('banner');

  const OFFSET = { x: 35, y: 25 };        // where the buddy sits relative to the cursor
  const SPRING = { response: 0.2, damping: 0.6 };
  const k = (2 * Math.PI / SPRING.response) ** 2;
  const c = 2 * SPRING.damping * Math.sqrt(k);
  const PHRASES = ['right here!', 'this one!', 'over here!', 'here it is!', 'found it!'];

  let mode = 'following';                  // following | flying | pointing
  let returning = false;
  let visibleSetting = true;
  let voiceState = 'idle';
  let cursorGlobal = null;                 // dip
  let pos = { x: -100, y: -100 };
  let vel = { x: 0, y: 0 };
  const REST = -18;                        // the paw's tilt beside the cursor
  let rotation = REST;
  let scale = 1;
  let audioLevel = 0;
  let navStartCursor = null;
  let lastFrame = performance.now();
  let flight = null;
  let pointTimers = [];

  const origin = () => ({ x: window.screenX, y: window.screenY });
  const localCursor = () => (cursorGlobal ? { x: cursorGlobal.x - origin().x, y: cursorGlobal.y - origin().y } : null);
  const onThisScreen = () => {
    const p = localCursor();
    return p && p.x >= 0 && p.y >= 0 && p.x < window.innerWidth && p.y < window.innerHeight;
  };

  // ------------------------------------------------------------------ frame loop
  function frame(now) {
    const dt = Math.min((now - lastFrame) / 1000, 1 / 30);
    lastFrame = now;
    const cur = localCursor();

    if (mode === 'following' && cur) {
      const target = { x: cur.x + OFFSET.x, y: cur.y + OFFSET.y };
      if (pos.x < -50) { pos = { ...target }; vel = { x: 0, y: 0 }; } // first sighting: no swoop in from nowhere
      // damped spring, integrated in small substeps for stability
      const steps = 4;
      for (let i = 0; i < steps; i++) {
        const h = dt / steps;
        const ax = -k * (pos.x - target.x) - c * vel.x;
        const ay = -k * (pos.y - target.y) - c * vel.y;
        vel.x += ax * h; vel.y += ay * h;
        pos.x += vel.x * h; pos.y += vel.y * h;
      }
      rotation += (REST - rotation) * Math.min(1, dt * 12);
    } else if (mode === 'flying' && flight) {
      stepFlight(now);
      if (returning && cur && navStartCursor && Math.hypot(cur.x - navStartCursor.x, cur.y - navStartCursor.y) > 100) {
        endNavigation();
      }
    }

    const show = visibleSetting && (mode !== 'following' || onThisScreen());
    $buddy.classList.toggle('hidden', !show);
    $buddy.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    $paw.style.transform = `translate(-50%, -50%) rotate(${rotation}deg) scale(${scale})`;
    const glow = Math.max(0, (scale - 1) / 0.3); // only while flying
    $paw.style.filter = `drop-shadow(0 1px 1.5px rgba(0,0,0,0.45))${glow > 0.02 ? ` drop-shadow(0 0 ${4 + glow * 8}px rgba(51,128,255,${0.9 * glow}))` : ''}`;
    if (voiceState === 'listening') drawWave(now);
    placeBubble();
    requestAnimationFrame(frame);
  }

  function drawWave(now) {
    const profile = [0.4, 0.7, 1.0, 0.7, 0.4];
    const eased = Math.pow(Math.min(Math.max(audioLevel - 0.008, 0) * 2.85, 1), 0.76);
    $bars.forEach((bar, i) => {
      const phase = (now / 1000) * 3.6 + i * 0.35;
      const idle = ((Math.sin(phase) + 1) / 2) * 1.5;
      bar.style.height = `${3 + eased * 10 * profile[i] + idle}px`;
    });
  }

  // ------------------------------------------------------------------ flight (quadratic bezier arc)
  function flyTo(dest, onDone) {
    const start = { ...pos };
    const dist = Math.hypot(dest.x - start.x, dest.y - start.y);
    const duration = Math.min(Math.max(dist / 800, 0.6), 1.4) * 1000;
    const mid = { x: (start.x + dest.x) / 2, y: (start.y + dest.y) / 2 };
    const control = { x: mid.x, y: mid.y - Math.min(dist * 0.2, 80) };
    flight = { start, dest, control, t0: performance.now(), duration, onDone };
    mode = 'flying';
  }

  function stepFlight(now) {
    const f = flight;
    const linear = Math.min((now - f.t0) / f.duration, 1);
    const t = linear * linear * (3 - 2 * linear); // smoothstep: ease in, ease out
    const u = 1 - t;
    pos = {
      x: u * u * f.start.x + 2 * u * t * f.control.x + t * t * f.dest.x,
      y: u * u * f.start.y + 2 * u * t * f.control.y + t * t * f.dest.y,
    };
    const tx = 2 * u * (f.control.x - f.start.x) + 2 * t * (f.dest.x - f.control.x);
    const ty = 2 * u * (f.control.y - f.start.y) + 2 * t * (f.dest.y - f.control.y);
    if (Math.hypot(tx, ty) > 0.01) rotation = (Math.atan2(ty, tx) * 180) / Math.PI + 90;
    scale = 1 + Math.sin(linear * Math.PI) * 0.3;
    if (linear >= 1) {
      pos = { ...f.dest };
      scale = 1;
      flight = null;
      vel = { x: 0, y: 0 };
      f.onDone && f.onDone();
    }
  }

  function clearPointTimers() {
    pointTimers.forEach(clearTimeout);
    pointTimers = [];
  }

  /** Fly to (x, y) local dip, type a label, then either hand back (agent) or hold and return (reply). */
  function pointAt({ x, y, label, id, hold }) {
    clearPointTimers();
    const dest = {
      x: Math.max(20, Math.min(x + 8, window.innerWidth - 20)),
      y: Math.max(20, Math.min(y + 12, window.innerHeight - 20)),
    };
    returning = false;
    navStartCursor = localCursor();
    flyTo(dest, () => {
      mode = 'pointing';
      rotation = REST;
      const phrase = label || PHRASES[Math.floor(Math.random() * PHRASES.length)];
      typeBubble(phrase, { nav: true, speed: [30, 60] }).then(() => {
        if (!hold) {
          // Agent flight: tell the main process we've arrived so it can click, then keep following.
          pointTimers.push(setTimeout(() => {
            api.send('overlay:fly-done', id);
            mode = 'following';
            pointTimers.push(setTimeout(() => hideBubble(), 900));
          }, 180));
          return;
        }
        pointTimers.push(setTimeout(() => {
          hideBubble();
          pointTimers.push(setTimeout(flyBack, 500));
        }, 3000));
      });
    });
  }

  function flyBack() {
    const cur = localCursor();
    if (!cur) { endNavigation(); return; }
    navStartCursor = cur;
    returning = true;
    flyTo({ x: cur.x + OFFSET.x, y: cur.y + OFFSET.y }, endNavigation);
  }

  function endNavigation() {
    flight = null;
    returning = false;
    mode = 'following';
    scale = 1;
    vel = { x: 0, y: 0 };
    if (pendingBubble) {
      const p = pendingBubble;
      pendingBubble = null;
      typeBubble(p.text, { ttl: p.ttl || 0 });
    }
  }

  // ------------------------------------------------------------------ bubble
  let bubbleToken = 0;
  let bubbleNav = false;
  let pendingBubble = null; // text that arrived while pointing; shown when the buddy is back

  function placeBubble() {
    if (!$bubble.classList.contains('show') && !$bubble.textContent) return;
    const w = $bubble.offsetWidth;
    const h = $bubble.offsetHeight;
    let left = pos.x + 10;
    let top = h > 26 ? pos.y + 8 : pos.y + 18 - h / 2;
    if (left + w > window.innerWidth - 8) left = pos.x - 10 - w;   // flip to the left near the edge
    if (top + h > window.innerHeight - 8) top = window.innerHeight - 8 - h;
    $bubble.style.left = `${Math.max(8, left)}px`;
    $bubble.style.top = `${Math.max(8, top)}px`;
  }

  function hideBubble() {
    bubbleToken++;
    $bubble.classList.remove('show');
    setTimeout(() => { if (!$bubble.classList.contains('show')) $bubble.textContent = ''; }, 420);
  }

  function typeBubble(text, { nav = false, speed = [14, 26], ttl = 0 } = {}) {
    const token = ++bubbleToken;
    bubbleNav = nav;
    $bubble.textContent = '';
    $bubble.classList.toggle('long', text.length > 60);
    $bubble.style.transform = 'scale(0.5)';
    $bubble.classList.add('show', 'pop');
    return new Promise((resolve) => {
      let i = 0;
      const step = () => {
        if (token !== bubbleToken) return resolve();
        if (i === 0) {
          $bubble.style.transform = 'scale(1)';
          setTimeout(() => $bubble.classList.remove('pop'), 120);
        }
        // type in small chunks so long replies don't take forever
        const chunk = text.length > 160 ? 3 : text.length > 80 ? 2 : 1;
        $bubble.textContent += text.slice(i, i + chunk);
        i += chunk;
        if (i >= text.length) {
          if (ttl > 0) setTimeout(() => { if (token === bubbleToken) hideBubble(); }, ttl);
          return resolve();
        }
        setTimeout(step, speed[0] + Math.random() * (speed[1] - speed[0]));
      };
      step();
    });
  }

  // ------------------------------------------------------------------ banner
  let bannerTimer = null;
  let bannerToken = 0;
  function showBanner({ kind, title, message, displayId: target }) {
    if (target != null && target !== displayId) return;
    const token = ++bannerToken;
    clearTimeout(bannerTimer);
    $banner.className = kind === 'info' ? 'info' : 'error-shake';
    if (kind !== 'info') feel('shake');
    $banner.querySelector('.banner-title').textContent = title;
    const $typed = $banner.querySelector('.typed');
    const $progress = $banner.querySelector('.banner-progress');
    $typed.textContent = '';
    $progress.style.transition = 'none';
    $progress.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => $banner.classList.add('show'));
    let i = 0;
    const text = String(message || '');
    const type = () => {
      if (token !== bannerToken) return;
      $typed.textContent = text.slice(0, ++i);
      if (i < text.length) {
        setTimeout(type, 18 + Math.random() * 22);
        return;
      }
      $banner.classList.add('done');
      const hold = Math.max(5000, text.length * 55);
      requestAnimationFrame(() => {
        $progress.style.transition = `transform ${hold}ms linear`;
        $progress.style.transform = 'scaleX(0)';
      });
      bannerTimer = setTimeout(() => { if (token === bannerToken) $banner.classList.remove('show'); }, hold);
    };
    setTimeout(type, 280);
  }

  // ------------------------------------------------------------------ welcome
  function welcome({ text }) {
    if (!onThisScreen()) return;
    setTimeout(() => typeBubble(text, { speed: [30, 30], ttl: 2000 }), 2000);
  }

  // ------------------------------------------------------------------ wiring
  api.on('cursor', (p) => { cursorGlobal = p; });
  const $fx = document.getElementById('buddy-fx');
  function feel(kind) {
    $fx.classList.remove('fx-pulse', 'fx-bounce', 'fx-shake');
    void $fx.offsetWidth; // restart the animation if it's already running
    $fx.classList.add(`fx-${kind}`);
  }
  $fx.addEventListener('animationend', () => $fx.classList.remove('fx-pulse', 'fx-bounce', 'fx-shake'));

  api.on('state', (s) => {
    const prev = voiceState;
    voiceState = s;
    $buddy.dataset.state = s;
    if (s === 'listening' && prev !== 'listening') feel('pulse');
    else if (s === 'responding' && prev !== 'responding') feel('bounce');
  });
  api.on('level', (l) => { audioLevel = Number(l) || 0; });
  api.on('buddy:visible', (v) => { visibleSetting = Boolean(v); });
  api.on('fly', (target) => {
    if (target.displayId != null && target.displayId !== displayId) return;
    pointAt(target);
  });
  api.on('bubble', ({ text, ttl, displayId: target }) => {
    if (target != null && target !== displayId) return;
    if (!onThisScreen() && mode === 'following') { if (!text) hideBubble(); return; }
    if (!text) { pendingBubble = null; if (!bubbleNav || mode === 'following') hideBubble(); return; }
    if (mode === 'pointing' || (mode === 'flying' && !returning)) { // don't talk over a pointing label
      if (ttl === 0 || !ttl) pendingBubble = { text, ttl };
      return;
    }
    typeBubble(text, { ttl: ttl || 0 });
  });
  // A reply that's still being written: update it in place, no typing animation.
  api.on('bubble-live', ({ text, displayId: target }) => {
    if (target != null && target !== displayId) return;
    if (!onThisScreen() && mode === 'following') return;
    if (mode === 'pointing' || (mode === 'flying' && !returning)) { pendingBubble = { text, ttl: 0 }; return; }
    bubbleToken++;
    bubbleNav = false;
    $bubble.textContent = text;
    $bubble.classList.toggle('long', text.length > 60);
    $bubble.style.transform = 'scale(1)';
    $bubble.classList.add('show');
  });
  api.on('banner', showBanner);
  api.on('welcome', welcome);

  $buddy.dataset.state = 'idle';
  requestAnimationFrame((t) => { lastFrame = t; requestAnimationFrame(frame); });
  setTimeout(() => $buddy.classList.add('ready'), 50);
  api.send('overlay:ready');
})();
