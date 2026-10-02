'use strict';
// Small shared UI helpers for Settings and Onboarding.

window.UI = (() => {
  const api = window.buddy;

  /** Segmented control: <div class="segmented" data-options='[["a","A"],["b","B"]]'>. */
  function segmented(el, value, onChange) {
    const options = JSON.parse(el.dataset.options);
    el.innerHTML = '';
    const thumb = document.createElement('span');
    thumb.className = 'thumb';
    el.append(thumb);
    const buttons = options.map(([val, label]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.dataset.value = val;
      b.addEventListener('click', () => { set(val); onChange && onChange(val); });
      el.append(b);
      return b;
    });
    function set(val) {
      buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === val)));
      const active = buttons.find((b) => b.dataset.value === val) || buttons[0];
      requestAnimationFrame(() => {
        thumb.style.left = `${active.offsetLeft}px`;
        thumb.style.width = `${active.offsetWidth}px`;
      });
    }
    set(value);
    return { set };
  }

  function switchControl(input, value, onChange) {
    input.checked = Boolean(value);
    input.addEventListener('change', () => onChange(input.checked));
  }

  /**
   * Secret key field. Shows "saved" state without ever receiving the key; saves on Enter/blur.
   * opts: { input, status, reveal, remove, key, has, validate(value) -> Promise<{ok,message}> }
   */
  function keyField(opts) {
    const { input, status, reveal, remove, key } = opts;
    let has = opts.has;
    const keyName = () => (typeof key === 'function' ? key() : key);
    const render = (msg, cls) => {
      input.placeholder = has ? 'Saved. Paste a new key to replace it' : (typeof opts.placeholder === 'function' ? opts.placeholder() : opts.placeholder) || 'Paste your API key';
      if (remove) remove.hidden = !has;
      if (status) {
        status.className = `status ${cls || (has ? 'ok' : '')}`;
        status.querySelector('.text').textContent = msg || (has ? 'Saved' : 'Not set');
      }
    };
    let saving = null;
    async function save() {
      const value = input.value.trim();
      if (!value || saving === value) return;
      saving = value;
      try {
        render('Checking…', 'busy');
        if (opts.validate) {
          const res = await opts.validate(value);
          if (!res.ok) { render(res.message, 'bad'); return; }
        }
        await api.invoke('settings:update', { [keyName()]: value });
        has = true;
        input.value = '';
        render(opts.validate ? 'Connected' : 'Saved', 'ok');
        opts.onSaved && opts.onSaved();
      } finally {
        saving = null;
      }
    }
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    input.addEventListener('change', save);
    input.addEventListener('paste', () => setTimeout(save, 0));
    if (reveal) {
      reveal.addEventListener('click', () => {
        input.type = input.type === 'password' ? 'text' : 'password';
        reveal.classList.toggle('on', input.type === 'text');
      });
    }
    if (remove) {
      remove.addEventListener('click', async () => {
        await api.invoke('settings:update', { [keyName()]: '' });
        has = false;
        render();
        opts.onSaved && opts.onSaved();
      });
    }
    render();
    return { setHas(v) { has = v; render(); }, save };
  }

  /**
   * Bigfoot's voices as cards: pick one, or press its play button to hear it. While a voice plays,
   * its card shows a moving wave and the button pauses it. onPick(id) saves the choice.
   */
  async function voicePicker(el, current, { onPick, onMessage = () => {} }) {
    const res = await api.invoke('voices:list');
    const voices = (res && res.voices) || [];
    el.classList.add('voice-picker');
    el.setAttribute('role', 'radiogroup');
    el.innerHTML = '';
    let playing = null; // { id, done: Promise }
    const cards = new Map();
    const ICON_PLAY = '<svg viewBox="0 0 16 16"><path d="M5 3.5v9l7-4.5z"/></svg>';
    const ICON_PAUSE = '<svg viewBox="0 0 16 16"><rect x="4" y="3.5" width="2.8" height="9" rx="0.8"/><rect x="9.2" y="3.5" width="2.8" height="9" rx="0.8"/></svg>';
    const select = (id) => cards.forEach((card, vid) => {
      const on = vid === id;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', String(on));
    });
    for (const v of voices) {
      const card = document.createElement('div');
      card.className = 'voice-card';
      card.tabIndex = 0;
      card.setAttribute('role', 'radio');
      card.innerHTML = `<img class="voice-avatar" alt="" src="assets/voices/${v.id}.svg"><span class="voice-text"><span class="voice-name"></span><span class="voice-note"></span></span><span class="voice-wave" aria-hidden="true">${'<i></i>'.repeat(7)}</span><button class="voice-play" type="button" aria-label="Play ${v.name}">${ICON_PLAY}</button>`;
      card.querySelector('.voice-name').textContent = v.name;
      card.querySelector('.voice-note').textContent = `${v.gender === 'female' ? 'Female' : 'Male'} · ${v.note}`;
      const pick = () => { select(v.id); onPick(v.id); };
      card.addEventListener('click', (e) => { if (!e.target.closest('.voice-play')) pick(); });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
      const button = card.querySelector('.voice-play');
      const show = (on) => {
        card.classList.toggle('playing', on);
        button.innerHTML = on ? ICON_PAUSE : ICON_PLAY;
        button.setAttribute('aria-label', `${on ? 'Pause' : 'Play'} ${v.name}`);
      };
      button.addEventListener('click', async () => {
        if (playing && playing.id === v.id) { api.invoke('voice:stop'); playing = null; show(false); onMessage(''); return; } // pause
        if (playing) { api.invoke('voice:stop'); await playing.done; } // another voice: stop that one first
        pick();
        show(true);
        onMessage(`Playing ${v.name}…`);
        const done = api.invoke('voice:preview', v.id).catch((err) => ({ ok: false, message: err.message }));
        playing = { id: v.id, done };
        const r = await done;
        if (!playing || playing.done !== done) return; // paused, or another voice took over
        playing = null;
        show(false);
        onMessage(r && r.ok === false ? r.message : '');
      });
      cards.set(v.id, card);
      el.append(card);
    }
    select(voices.some((v) => v.id === current) ? current : voices[0] && voices[0].id);
    return { select };
  }

  /** 5-bar level meter driven by the engine's microphone level. */
  function meter(el) {
    el.innerHTML = '<i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>';
    const bars = [...el.children];
    return (level) => {
      const lit = Math.round(Math.min(1, Math.pow(Math.max(level - 0.006, 0) * 4, 0.7)) * bars.length);
      bars.forEach((b, i) => b.classList.toggle('on', i < lit));
    };
  }

  function titlebar() {
    const close = document.querySelector('.traffic .close');
    const min = document.querySelector('.traffic .min');
    if (close) close.addEventListener('click', () => api.invoke('window:close'));
    if (min) min.addEventListener('click', () => api.invoke('window:minimize'));
  }

  return { segmented, switchControl, keyField, voicePicker, meter, titlebar };
})();
