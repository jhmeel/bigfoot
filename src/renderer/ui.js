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

  /** Fill a <select> with voices for the provider; returns the list. */
  async function loadVoices(select, provider, current, onError) {
    select.disabled = true;
    select.innerHTML = '<option>Loading voices…</option>';
    let voices = [];
    const res = await api.invoke('voices:list', provider);
    if (!res.ok && onError) onError(res.message);
    voices = res.voices;
    select.innerHTML = '';
    if (!voices.length) {
      const o = document.createElement('option');
      o.textContent = provider === 'elevenlabs' ? 'Add your ElevenLabs key to load voices' : 'No voices found';
      o.value = '';
      select.append(o);
      return voices;
    }
    for (const v of voices) {
      const o = document.createElement('option');
      o.value = v.id;
      o.textContent = v.name;
      select.append(o);
    }
    select.value = voices.some((v) => v.id === current) ? current : voices[0].id;
    select.disabled = false;
    return voices;
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

  return { segmented, switchControl, keyField, loadVoices, meter, titlebar };
})();
