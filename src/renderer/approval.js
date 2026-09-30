'use strict';

(() => {
  const api = window.buddy;
  const $ = (id) => document.getElementById(id);
  let answered = false;
  let destructive = false;
  const answer = (v) => {
    if (answered) return;
    answered = true;
    api.invoke('approval:answer', v);
  };

  api.on('approval:show', (req) => {
    $('title').textContent = req.title || 'Allow this action?';
    $('message').textContent = req.message || '';
    $('detail').hidden = !req.detail;
    $('detail').textContent = req.detail || '';
    $('allow').textContent = req.confirm || 'Allow';
    destructive = Boolean(req.destructive);
    $('allow').classList.toggle('destructive', destructive);
    $('icon').classList.toggle('danger', destructive);
    // Destructive actions default to the safe choice, like macOS alerts.
    (destructive ? $('deny') : $('allow')).focus();
  });

  $('allow').addEventListener('click', () => answer(true));
  $('deny').addEventListener('click', () => answer(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer(false);
    if (e.key === 'Enter' && document.activeElement && document.activeElement.id) {
      e.preventDefault();
      answer(document.activeElement.id === 'allow');
    }
  });
})();
