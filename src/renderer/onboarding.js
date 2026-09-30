'use strict';

(async () => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  const STEPS = ['welcome', 'name', 'voice', 'listen', 'model'];
  const NAME_IDEAS = ['Bigfoot', 'Nova', 'Sage', 'Pixel', 'Milo', 'Echo', 'Juno', 'Atlas'];
  const ACTIVE = ['queued', 'downloading', 'waiting', 'verifying', 'installing', 'paused', 'failed'];
  let s = await api.invoke('settings:get');
  let index = 0;
  let model = null;
  const update = (patch) => api.invoke('settings:update', patch).then((v) => { s = v; return v; });

  UI.titlebar();

  // ------------------------------------------------------------------ navigation
  const dots = $('dots');
  STEPS.forEach(() => dots.append(document.createElement('i')));

  const modelState = () => {
    const st = model ? model.status : { status: 'none' };
    if (ACTIVE.includes(st.status)) return 'downloading';
    return st.installed ? 'installed' : 'none';
  };

  function go(to) {
    const from = index;
    index = Math.max(0, Math.min(STEPS.length - 1, to));
    document.querySelectorAll('.step').forEach((el) => {
      const i = STEPS.indexOf(el.dataset.step);
      el.classList.toggle('active', i === index);
      el.classList.toggle('left', i < index);
    });
    [...dots.children].forEach((d, i) => d.classList.toggle('on', i === index));
    const step = STEPS[index];
    $('back').style.visibility = index === 0 ? 'hidden' : 'visible';
    if (from !== index && STEPS[from] === 'listen') stopMicTest();
    if (step === 'name') setTimeout(() => $('name').select(), 350);
    if (step === 'voice') renderVoice();
    if (step === 'listen') renderListen();
    if (step === 'model' && !model) model = LocalAI.picker($('local-ai'), { setup: true, onChange: renderNav });
    renderNav();
  }

  function renderNav() {
    const step = STEPS[index];
    const next = $('next');
    const state = modelState();
    const name = cleanName($('name').value) || 'Bigfoot';
    if (step === 'welcome') next.textContent = 'Get Started';
    else if (step !== 'model') next.textContent = 'Continue';
    else next.textContent = { none: 'Download & Install', downloading: 'Continue', installed: `Start Using ${name}` }[state];
    $('bg-note').hidden = !(step === 'model' && state === 'downloading');
    next.disabled = (step === 'name' && cleanName($('name').value).length < 2)
      || (step === 'model' && modelState() === 'none' && !(model && model.selected));
  }

  async function finish() {
    await api.invoke('onboarding:finish', { launchAtLogin: $('login').checked });
  }

  let navigating = false;
  $('next').addEventListener('click', async () => {
    if (navigating || $('next').disabled) return;
    navigating = true;
    try {
      const step = STEPS[index];
      if (step === 'name') await saveName();
      if (step !== 'model') { go(index + 1); return; }
      if (modelState() === 'none') {
        await model.start();
        renderNav();
        return;
      }
      await finish(); // downloading continues in the background; Settings shows its progress
    } finally {
      setTimeout(() => { navigating = false; }, 350);
    }
  });
  $('back').addEventListener('click', () => go(index - 1));
  // Enter only continues from the name field or the welcome screen; the download always takes a click.
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.repeat || $('next').disabled) return;
    const inName = document.activeElement === $('name') && STEPS[index] === 'name';
    if (inName || (STEPS[index] === 'welcome' && document.activeElement.tagName !== 'INPUT')) $('next').click();
  });

  // ------------------------------------------------------------------ welcome
  (() => {
    const bubble = $('hero-bubble');
    const logo = $('hero-logo');
    window.addEventListener('mousemove', (e) => {
      const r = logo.getBoundingClientRect();
      const dx = (e.clientX - (r.left + r.width / 2)) / window.innerWidth;
      const dy = (e.clientY - (r.top + r.height / 2)) / window.innerHeight;
      logo.style.rotate = `${dx * 8}deg`;
      logo.style.translate = `${dx * 6}px ${dy * 6}px`;
    });
    const msg = `hey! i’m ${s.assistantName.toLowerCase()}`;
    let i = 0;
    setTimeout(function type() {
      bubble.classList.add('show');
      bubble.textContent = msg.slice(0, ++i);
      if (i < msg.length) setTimeout(type, 45);
    }, 900);
  })();

  // ------------------------------------------------------------------ name
  function cleanName(v) {
    return String(v).replace(/[^\p{L}\p{M}' -]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 24);
  }
  function renderName() {
    const n = cleanName($('name').value) || 'Bigfoot';
    $('name-echo').textContent = n;
    $('name-bubble').textContent = `hey! i’m ${n.toLowerCase()}`;
    $('name-bubble').classList.add('bump');
    setTimeout(() => $('name-bubble').classList.remove('bump'), 160);
    [...$('name-chips').children].forEach((c) => c.setAttribute('aria-pressed', String(c.textContent === n)));
    document.querySelectorAll('.name-slot').forEach((el) => { el.textContent = n; });
    renderNav();
  }
  async function saveName() {
    const n = cleanName($('name').value);
    if (n.length >= 2) await update({ assistantName: n, wakeWord: $('wake').checked });
  }
  for (const idea of NAME_IDEAS) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.type = 'button';
    chip.textContent = idea;
    chip.addEventListener('click', () => { $('name').value = idea; renderName(); });
    $('name-chips').append(chip);
  }
  $('name').value = s.assistantName;
  $('wake').checked = s.wakeWord;
  $('name').addEventListener('input', renderName);

  // ------------------------------------------------------------------ voice (Windows voices)
  async function renderVoice() {
    if (s.ttsProvider !== 'system') await update({ ttsProvider: 'system' });
    $('voice-msg').textContent = '';
    await UI.loadVoices($('voice'), 'system', s.systemVoice, (m) => { $('voice-msg').textContent = m; });
    if ($('voice').value && $('voice').value !== s.systemVoice) await update({ systemVoice: $('voice').value });
    $('preview').disabled = !$('voice').value;
  }
  $('voice').addEventListener('change', () => update({ systemVoice: $('voice').value }));
  $('preview').addEventListener('click', async () => {
    $('preview').disabled = true;
    $('voice-msg').textContent = 'Playing…';
    const res = await api.invoke('voice:preview');
    $('voice-msg').textContent = res.ok ? '' : res.message;
    $('preview').disabled = false;
  });

  // ------------------------------------------------------------------ listening
  const drawMeter = UI.meter($('mic-meter'));
  let testing = false;
  let heard = 0;

  function micState(kind, title, sub) {
    $('mic-orb').className = `mic-orb ${kind}`;
    $('mic-title').textContent = title;
    $('mic-sub').textContent = sub;
    $('mic-settings').hidden = kind !== 'bad';
  }
  async function renderListen() {
    if (s.sttProvider !== 'local') await update({ sttProvider: 'local' });
    const status = await api.invoke('mic:status');
    if (status === 'denied' || status === 'restricted') {
      micState('bad', 'Microphone is turned off', 'Turn on “Let desktop apps access your microphone” in Windows Settings, then come back.');
    } else if (!heard) {
      micState('', 'Check your microphone', 'Click Test, then say something.');
    }
  }
  async function startMicTest() {
    testing = true;
    heard = 0;
    $('mic-test').textContent = 'Stop';
    micState('live', 'Listening…', 'Say “hello buddy”.');
    const res = await api.invoke('mic:test', true);
    if (!res.ok) {
      testing = false;
      $('mic-test').textContent = 'Test';
      micState('bad', /denied/i.test(res.message) ? 'Microphone is turned off' : 'Microphone unavailable',
        /denied/i.test(res.message) ? 'Turn on “Let desktop apps access your microphone” in Windows Settings.' : res.message);
    }
  }
  function stopMicTest() {
    if (!testing) return;
    testing = false;
    $('mic-test').textContent = 'Test';
    drawMeter(0);
    api.invoke('mic:test', false);
  }
  $('mic-test').addEventListener('click', () => (testing ? stopMicTest() : startMicTest()));
  $('mic-settings').addEventListener('click', () => api.invoke('app:open-link', 'micSettings'));
  window.addEventListener('focus', () => { if (STEPS[index] === 'listen' && !testing) renderListen(); });
  api.on('level', (l) => {
    if (!testing) return;
    drawMeter(l);
    $('mic-orb').style.boxShadow = `0 0 0 ${Math.min(10, l * 60)}px rgba(51,128,255,0.18)`;
    if (l > 0.03 && ++heard === 8) {
      micState('ok', 'Sounds great!', 'Your microphone is working.');
      setTimeout(stopMicTest, 900);
    }
  });

  renderName();
  // Re-running setup after onboarding jumps straight to the model step.
  go(s.onboarded ? STEPS.indexOf('model') : 0);
})();
