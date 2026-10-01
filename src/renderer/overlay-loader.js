'use strict';
// Startup loader: a small card in the corner of the main screen while the AI and speech
// recognition load, so it's clear Bigfoot is getting ready rather than ignoring you.

(() => {
  const api = window.buddy;
  const displayId = Number(new URLSearchParams(location.search).get('displayId'));
  const card = document.getElementById('ai-loader');
  const text = card.querySelector('.ail-text');
  const pct = card.querySelector('.ail-pct');
  const bar = card.querySelector('.ail-bar i');
  const sub = card.querySelector('.ail-sub');
  let hideTimer = null;
  let shownLoading = false;

  const clock = (ms) => {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function hide(after = 0) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { card.classList.remove('show'); shownLoading = false; }, after);
  }

  function render(status) {
    if (!status || status.primaryDisplayId !== displayId) { hide(); return; }
    const { ai, voice } = status;
    const voiceText = voice.state === 'ready' ? 'Voice ready' : voice.state === 'loading' ? 'Loading voice…' : voice.state === 'failed' ? 'Voice unavailable' : '';
    card.dataset.state = ai.state;
    if (ai.state === 'loading' || (voice.state === 'loading' && ai.state !== 'failed')) {
      clearTimeout(hideTimer);
      shownLoading = true;
      const p = ai.state === 'loading' ? ai.percent : 100;
      text.textContent = ai.state === 'loading' ? `Loading Bigfoot’s AI · ${ai.label}` : 'Loading voice…';
      pct.textContent = ai.state === 'loading' ? `${p}%` : '';
      bar.style.width = `${p}%`;
      sub.textContent = [ai.state === 'loading' && ai.elapsed > 20000 ? `${clock(ai.elapsed)} · a busy PC takes longer` : '', voiceText].filter(Boolean).join(' · ');
      card.classList.add('show');
    } else if (ai.state === 'failed') {
      clearTimeout(hideTimer);
      text.textContent = 'The AI couldn’t load';
      pct.textContent = '';
      bar.style.width = '0%';
      sub.textContent = `${ai.label} Open Bigfoot to try again.`;
      card.classList.add('show');
      hide(15000);
    } else if (ai.state === 'ready' && shownLoading) {
      text.textContent = 'Bigfoot is ready';
      pct.textContent = '';
      bar.style.width = '100%';
      sub.textContent = voiceText;
      hide(2500);
    }
  }

  api.on('loader', render);
  api.invoke('loader:status').then(render).catch(() => {});
})();
