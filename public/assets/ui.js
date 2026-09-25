'use strict';

/* DropQR — micro-interactions partagées (v1)
   - DropQRUI.toast()          notification courte, réutilisable, safe XSS
   - DropQRUI.confirm()        dialogue accessible (remplace window.confirm)
   - DropQRUI.copy()           presse-papiers + repli prompt
   - compte à rebours          tout élément [data-expiry] est tenu à jour
   - barres de vie             [data-life-start][data-life-end] (.transfer-life i)
   - boutons magnétiques       desktop only, respecte prefers-reduced-motion
   Rechargé après navigation PJAX via l'événement global pjax:load.
*/

window.DropQRUI = (() => {
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const finePointer = () => window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- Toast ---------- */
  let toastEl = null;
  let toastTimer = null;
  function toast(message, opts = {}) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'dq-toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.className = `dq-toast ${opts.type === 'error' ? 'err' : ''}`.trim();
    toastEl.textContent = '';
    const dot = document.createElement('span');
    dot.className = 't-dot';
    const label = document.createElement('span');
    label.textContent = String(message || '');
    toastEl.append(dot, label);
    requestAnimationFrame(() => toastEl.classList.add('on'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), opts.duration || 2400);
  }

  /* ---------- Dialogue de confirmation ---------- */
  let veil = null;
  function ensureVeil() {
    if (veil) return veil;
    veil = document.createElement('div');
    veil.className = 'dq-veil';
    veil.innerHTML = '<div class="dq-dialog" role="dialog" aria-modal="true" aria-labelledby="dq-dialog-title"></div>';
    document.body.appendChild(veil);
    veil.addEventListener('mousedown', (event) => { if (event.target === veil) close(false); });
    veil.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(false); }
      if (event.key === 'Tab') trap(event);
    });
    return veil;
  }
  let resolver = null;
  let lastFocus = null;
  function close(value) {
    if (!veil || !veil.classList.contains('on')) return;
    veil.classList.remove('on');
    if (resolver) { const r = resolver; resolver = null; r(value); }
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function trap(event) {
    const focusables = veil.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  function confirm(options = {}) {
    const host = ensureVeil();
    const dialog = host.querySelector('.dq-dialog');
    dialog.textContent = '';
    const title = document.createElement('h2');
    title.id = 'dq-dialog-title';
    title.textContent = options.title || 'Confirmer';
    dialog.appendChild(title);
    if (options.body) {
      const body = document.createElement('p');
      body.textContent = options.body;
      dialog.appendChild(body);
    }
    if (options.note) {
      const note = document.createElement('p');
      note.style.marginTop = '10px';
      note.style.fontSize = '12.5px';
      note.textContent = options.note;
      dialog.appendChild(note);
    }
    const actions = document.createElement('div');
    actions.className = 'actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary-btn';
    cancel.textContent = options.cancelLabel || 'Annuler';
    cancel.addEventListener('click', () => close(false));
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = options.danger ? 'primary-btn danger' : 'primary-btn';
    if (options.danger) { ok.style.background = 'var(--err)'; ok.style.color = '#fff'; }
    ok.textContent = options.confirmLabel || 'Confirmer';
    ok.addEventListener('click', () => close(true));
    actions.append(cancel, ok);
    dialog.appendChild(actions);
    lastFocus = document.activeElement;
    host.classList.add('on');
    requestAnimationFrame(() => ok.focus());
    return new Promise((resolve) => { resolver = resolve; });
  }

  /* ---------- Presse-papiers ---------- */
  async function copy(text, okMessage) {
    const value = String(text || '');
    if (!value) return false;
    let done = false;
    try {
      await navigator.clipboard.writeText(value);
      done = true;
    } catch (_error) {
      try {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:-40px;opacity:0';
        document.body.appendChild(ta);
        ta.select();
        done = document.execCommand('copy');
        ta.remove();
      } catch (_inner) { done = false; }
    }
    if (!done) {
      window.prompt('Copie manuellement :', value);
      return false;
    }
    toast(okMessage || 'Copié dans le presse-papiers');
    return true;
  }

  /* ---------- Compte à rebours & barres de vie ---------- */
  function fmtRemaining(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h} h ${String(m).padStart(2, '0')} min`;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  function tick() {
    if (document.hidden) return;
    const now = Date.now();
    // Textes [data-expiry] : « expire dans m:ss » (ou classe expired).
    document.querySelectorAll('[data-expiry]').forEach((el) => {
      const end = Date.parse(el.dataset.expiry || '');
      if (!Number.isFinite(end)) return;
      const left = Math.max(0, (end - now) / 1000);
      el.classList.toggle('warn', left > 0 && left <= 60);
      el.classList.toggle('expired', left === 0);
      const txt = left === 0 ? 'expiré' : `expire dans ${fmtRemaining(left)}`;
      if (el.dataset.countPrefix === 'none') el.textContent = left === 0 ? '0:00' : fmtRemaining(left);
      else el.textContent = el.dataset.countLabel ? `${el.dataset.countLabel} dans ${fmtRemaining(left)}` : txt;
      if (left === 0 && el.dataset.dqFired !== '1') {
        el.dataset.dqFired = '1';
        el.dispatchEvent(new CustomEvent('dq:expired', { bubbles: true }));
      }
    });
    // Barres de vie [data-life-end] (+ data-life-start pour le pourcentage).
    document.querySelectorAll('[data-life-end]').forEach((el) => {
      const end = Date.parse(el.dataset.lifeEnd || '');
      const start = Date.parse(el.dataset.lifeStart || '');
      const bar = el.querySelector('i') || el.firstElementChild;
      if (!Number.isFinite(end)) return;
      const total = Number.isFinite(start) && end > start ? end - start : 15 * 60 * 1000;
      const ratio = Math.min(1, Math.max(0, (end - now) / total));
      if (bar) bar.style.width = `${(ratio * 100).toFixed(2)}%`;
      el.classList.toggle('dead', end <= now);
    });
  }
  let ticker = null;
  function startTicker() {
    tick();
    if (ticker) return;
    ticker = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
  }

  /* ---------- Boutons magnétiques ---------- */
  let magnetBound = false;
  function bindMagnetics() {
    if (magnetBound || reduced() || !finePointer()) return;
    magnetBound = true;
    const active = new Map();
    const MAX = 5;
    document.addEventListener('mousemove', (event) => {
      const target = event.target.closest ? event.target.closest('.mag') : null;
      active.forEach((el) => {
        if (el !== target) {
          el.style.transform = '';
          active.delete(el);
        }
      });
      if (!target || target.disabled || target.closest('[disabled]')) return;
      const rect = target.getBoundingClientRect();
      const dx = (event.clientX - (rect.left + rect.width / 2)) / rect.width;
      const dy = (event.clientY - (rect.top + rect.height / 2)) / rect.height;
      target.style.transform = `translate(${(dx * MAX).toFixed(1)}px, ${(dy * (MAX - 1)).toFixed(1)}px)`;
      active.set(target, target);
    }, { passive: true });
  }

  /* ---------- Formatage ---------- */
  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }
  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} o`;
    const units = ['Ko', 'Mo', 'Go', 'To'];
    let size = value / 1024;
    let unit = units[0];
    for (let i = 0; i < units.length; i += 1) {
      unit = units[i];
      if (size < 1024 || i === units.length - 1) break;
      size /= 1024;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
  }

  /* ---------- Révélations génériques (.kinetic, .maskline) ---------- */
  let revealObserver = null;
  function bindReveals() {
    const items = [...document.querySelectorAll('.kinetic, .maskline, .feature, .live-item, .cta-inner')];
    if (!items.length) return;
    if (reduced()) { items.forEach((el) => el.classList.add('is-visible')); return; }
    if (!('IntersectionObserver' in window)) {
      document.documentElement.classList.add('motion-ready');
      items.forEach((el) => el.classList.add('is-visible'));
      return;
    }
    document.documentElement.classList.add('motion-ready');
    if (revealObserver) revealObserver.disconnect();
    revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.12 });
    items.forEach((el) => {
      if (el.classList.contains('is-visible')) return;
      if (el.getBoundingClientRect().top < window.innerHeight * 0.94) el.classList.add('is-visible');
      else revealObserver.observe(el);
    });
  }

  const init = () => { startTicker(); bindMagnetics(); bindReveals(); };
  init();
  window.addEventListener('pjax:load', init);

  return { toast, confirm, copy, fmtRemaining, formatDate, formatBytes, reduced, finePointer };
})();
