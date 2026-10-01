'use strict';

(() => {
  const api = window.buddy;
  const tray = document.getElementById('tray');
  const tip = document.getElementById('tip');
  const IDLE_MS = 4000;
  let timer = null;
  let hovering = false;
  let closing = false;

  const armIdle = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!hovering) close(); }, IDLE_MS);
  };

  function close(tool) {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    tip.classList.remove('show');
    tray.classList.add('leaving');
    setTimeout(() => api.invoke('toolbar:pick', tool || null), 100);
  }

  api.on('toolbar:show', () => {
    closing = false;
    tray.classList.remove('show', 'leaving');
    tip.classList.remove('show');
    requestAnimationFrame(() => tray.classList.add('show'));
    armIdle();
  });

  const talk = tray.querySelector('[data-tool="talk"]');
  api.on('voice-mode', (on) => {
    talk.setAttribute('aria-pressed', String(Boolean(on)));
    talk.dataset.label = on ? 'Stop talking' : 'Talk (stays on until you stop it)';
  });

  // While the AI is starting or getting ready for first use, the tools wait (Clear still works).
  let blocked = null;
  api.on('tools-blocked', (why) => {
    blocked = why || null;
    tray.querySelectorAll('button').forEach((b) => {
      const off = Boolean(blocked) && b.dataset.tool !== 'clear';
      b.disabled = off;
      b.setAttribute('aria-disabled', String(off));
    });
    tray.classList.toggle('waiting', Boolean(blocked));
  });

  tray.addEventListener('mouseenter', () => { hovering = true; clearTimeout(timer); });
  tray.addEventListener('mouseleave', () => { hovering = false; tip.classList.remove('show'); armIdle(); });
  tray.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => close(b.dataset.tool));
    b.addEventListener('mouseenter', () => {
      tip.textContent = b.disabled && blocked ? `${blocked} Available when it’s done.` : b.dataset.label;
      const r = b.getBoundingClientRect();
      tip.style.transform = '';
      tip.classList.add('show');
      const w = tip.offsetWidth;
      const left = Math.max(4, Math.min(window.innerWidth - w - 4, r.left + r.width / 2 - w / 2));
      tip.style.marginLeft = `${left - (window.innerWidth - w) / 2}px`;
    });
  });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
})();
