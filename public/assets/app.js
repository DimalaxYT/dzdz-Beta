/* ==========================================================================
   DropQR — noyau front
   Expose window.DropQR : configuration, widgets partagés (compte à rebours,
   code à cases, toasts, courbe de débit) et animations (révélation, parallax,
   inclinaison). Aucune dépendance, aucun emoji.
   ========================================================================== */

(() => {
  'use strict';

  function readConfig() {
    const node = document.getElementById('dropqrConfig');
    if (node) {
      try {
        return JSON.parse(node.textContent || '{}');
      } catch {
        /* bloc illisible : on retombe sur la variable globale */
      }
    }
    return window.__DROPQR__ || {};
  }

  const config = readConfig();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const listeners = new Map();

  /* ------------------------------ utilitaires ----------------------------- */

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (!Number.isFinite(value) || value <= 0) return '0 o';
    if (value < 1024) return `${value} o`;
    const units = ['Ko', 'Mo', 'Go', 'To'];
    let size = value / 1024;
    let unit = units[0];
    for (let index = 0; index < units.length; index += 1) {
      unit = units[index];
      if (size < 1024 || index === units.length - 1) break;
      size /= 1024;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Math.round(Number(seconds) || 0));
    if (total < 60) return `${total} s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min ${String(total % 60).padStart(2, '0')} s`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, '0')} min`;
    return `${Math.floor(hours / 24)} j ${String(hours % 24).padStart(2, '0')} h`;
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function emit(event, detail) {
    (listeners.get(event) || []).forEach((handler) => {
      try {
        handler(detail);
      } catch (error) {
        console.warn('[dropqr] gestionnaire en erreur', error);
      }
    });
  }

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(area);
        return ok;
      } catch {
        window.prompt('Copie le lien :', text);
        return false;
      }
    }
  }

  function toast(message, type = 'success') {
    const host = document.getElementById('toasts');
    if (!host) return;
    const node = document.createElement('div');
    node.className = `toast${type === 'error' ? ' is-error' : ''}`;
    node.textContent = message;
    host.appendChild(node);
    setTimeout(() => {
      node.style.transition = 'opacity .3s, transform .3s';
      node.style.opacity = '0';
      node.style.transform = 'translateY(8px)';
      setTimeout(() => node.remove(), 320);
    }, 3800);
  }

  /* ------------------------- code à cases (widget) ------------------------ */

  function buildCodeSlots(container, { length = 7, value = '', onChange, onComplete } = {}) {
    if (!container) return { set() {}, get: () => '' };
    container.innerHTML = '';
    const inputs = [];

    for (let index = 0; index < length; index += 1) {
      const input = document.createElement('input');
      input.className = 'code-slot';
      input.type = 'text';
      input.inputMode = 'text';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = 1;
      input.setAttribute('aria-label', `Caractère ${index + 1} sur ${length}`);
      input.dataset.index = String(index);
      container.appendChild(input);
      inputs.push(input);
    }

    const read = () => inputs.map((input) => input.value).join('').toUpperCase().replace(/[^A-Z0-9]/g, '');

    function focusNext(index) {
      const next = inputs[index + 1];
      if (next) next.focus();
    }

    inputs.forEach((input, index) => {
      input.addEventListener('input', () => {
        const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        input.value = raw.slice(-1);
        if (input.value) focusNext(index);
        if (onChange) onChange(read());
        if (read().length === length && onComplete) onComplete(read());
      });

      input.addEventListener('keydown', (event) => {
        if (event.key === 'Backspace' && !input.value && inputs[index - 1]) {
          inputs[index - 1].focus();
          inputs[index - 1].value = '';
          if (onChange) onChange(read());
        }
        if (event.key === 'ArrowLeft' && inputs[index - 1]) inputs[index - 1].focus();
        if (event.key === 'ArrowRight' && inputs[index + 1]) inputs[index + 1].focus();
        if (event.key === 'Enter' && onComplete) {
          event.preventDefault();
          onComplete(read());
        }
      });

      input.addEventListener('paste', (event) => {
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData('text') || '';
        const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
        clean.split('').forEach((char, offset) => {
          if (inputs[offset]) inputs[offset].value = char;
        });
        const nextEmpty = inputs.findIndex((item) => !item.value);
        (inputs[nextEmpty === -1 ? length - 1 : nextEmpty] || inputs[0]).focus();
        if (onChange) onChange(read());
        if (clean.length === length && onComplete) onComplete(clean);
      });
    });

    return {
      inputs,
      get: read,
      set(value) {
        const clean = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length);
        inputs.forEach((input, index) => {
          input.value = clean[index] || '';
        });
        if (onChange) onChange(read());
      },
      focus() {
        const first = inputs.find((input) => !input.value) || inputs[0];
        first.focus();
      }
    };
  }

  function renderCodeDisplay(container, code) {
    if (!container) return;
    container.innerHTML = String(code || '')
      .split('')
      .map((char) => `<span class="code-slot filled">${escapeHtml(char)}</span>`)
      .join('');
  }

  /* ---------------------------- compte à rebours -------------------------- */

  function startCountdown(element, targetIso) {
    if (!element) return () => {};
    const target = new Date(targetIso || element.dataset.target || Date.now()).getTime();
    const units = {
      days: element.querySelector('[data-unit="days"]'),
      hours: element.querySelector('[data-unit="hours"]'),
      minutes: element.querySelector('[data-unit="minutes"]'),
      seconds: element.querySelector('[data-unit="seconds"]')
    };
    let lastSecond = null;
    let stopped = false;

    function paint() {
      if (stopped) return;
      const remaining = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const days = Math.floor(remaining / 86400);
      const hours = Math.floor((remaining % 86400) / 3600);
      const minutes = Math.floor((remaining % 3600) / 60);
      const seconds = remaining % 60;

      if (units.days) units.days.textContent = String(days);
      if (units.hours) units.hours.textContent = String(hours).padStart(2, '0');
      if (units.minutes) units.minutes.textContent = String(minutes).padStart(2, '0');
      if (units.seconds) units.seconds.textContent = String(seconds).padStart(2, '0');

      if (lastSecond !== null && seconds !== lastSecond && units.seconds && !reduceMotion) {
        const wrapper = units.seconds.closest('.countdown-unit');
        if (wrapper) {
          wrapper.classList.remove('is-tick');
          void wrapper.offsetWidth;
          wrapper.classList.add('is-tick');
        }
      }
      lastSecond = seconds;

      if (remaining <= 0) {
        stopped = true;
        clearInterval(timer);
        emit('expired', { element });
        return;
      }
      element.dataset.remaining = String(remaining);
    }

    paint();
    const timer = setInterval(paint, 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  /* ------------------------------- courbe -------------------------------- */

  function createSparkline(canvas) {
    if (!canvas) return () => {};
    const context = canvas.getContext('2d');
    const samples = [];

    return function push(value) {
      samples.push(Number(value) || 0);
      if (samples.length > 60) samples.shift();

      const ratio = window.devicePixelRatio || 1;
      const width = canvas.clientWidth || 520;
      const height = 74;
      canvas.width = width * ratio;
      canvas.height = height * ratio;
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      if (samples.length < 2) return;
      const max = Math.max(...samples, 1);
      const step = width / Math.max(1, samples.length - 1);
      const style = getComputedStyle(document.documentElement);
      const jade = style.getPropertyValue('--jade').trim() || '#0f6b55';

      context.beginPath();
      samples.forEach((sample, index) => {
        const x = index * step;
        const y = height - (sample / max) * (height - 12) - 6;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.lineWidth = 2;
      context.strokeStyle = jade;
      context.lineJoin = 'round';
      context.stroke();

      context.lineTo((samples.length - 1) * step, height);
      context.lineTo(0, height);
      context.closePath();
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, `${jade}55`);
      gradient.addColorStop(1, `${jade}00`);
      context.fillStyle = gradient;
      context.fill();
    };
  }

  /* ------------------------------ animations ------------------------------ */

  function initReveal() {
    const targets = document.querySelectorAll('[data-reveal]');
    if (!targets.length) return;

    targets.forEach((target) => {
      const delay = Number(target.dataset.delay || 0);
      if (delay) target.style.setProperty('--reveal-delay', `${delay}ms`);
    });

    if (reduceMotion || !('IntersectionObserver' in window)) {
      targets.forEach((target) => target.classList.add('is-visible'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.15, rootMargin: '0px 0px -60px' }
    );
    targets.forEach((target) => observer.observe(target));
  }

  function initCounters() {
    const targets = document.querySelectorAll('[data-count-to]');
    if (!targets.length) return;

    const run = (element) => {
      const to = Number(element.dataset.countTo || 0);
      const suffix = element.dataset.countSuffix || '';
      const decimals = Number(element.dataset.countDecimals || 0);
      if (reduceMotion) {
        element.textContent = `${to.toFixed(decimals)}${suffix}`;
        return;
      }
      const duration = 900;
      const start = performance.now();
      function frame(timestamp) {
        const progress = Math.min(1, (timestamp - start) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        element.textContent = `${(to * eased).toFixed(decimals)}${suffix}`;
        if (progress < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    };

    if (!('IntersectionObserver' in window)) {
      targets.forEach(run);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          run(entry.target);
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.4 }
    );
    targets.forEach((target) => observer.observe(target));
  }

  function initTilt() {
    if (reduceMotion || window.matchMedia('(hover: none)').matches) return;
    document.querySelectorAll('[data-tilt]').forEach((element) => {
      element.addEventListener('pointermove', (event) => {
        const rect = element.getBoundingClientRect();
        const relativeX = (event.clientX - rect.left) / rect.width;
        const relativeY = (event.clientY - rect.top) / rect.height;
        element.style.setProperty('--ry', ((relativeX - 0.5) * 7).toFixed(2));
        element.style.setProperty('--rx', ((0.5 - relativeY) * 7).toFixed(2));
        element.style.setProperty('--mx', `${(relativeX * 100).toFixed(1)}%`);
        element.style.setProperty('--my', `${(relativeY * 100).toFixed(1)}%`);
      });
      element.addEventListener('pointerleave', () => {
        element.style.setProperty('--ry', '0');
        element.style.setProperty('--rx', '0');
      });
    });
  }

  function initParallax() {
    const elements = [...document.querySelectorAll('[data-parallax]')];
    if (!elements.length || reduceMotion) return;

    let ticking = false;
    function update() {
      ticking = false;
      const viewport = window.innerHeight;
      elements.forEach((element) => {
        const speed = Number(element.dataset.speed || 0.1);
        const rect = element.getBoundingClientRect();
        const center = rect.top + rect.height / 2;
        const offset = (center - viewport / 2) / viewport;
        element.style.transform = `translate3d(0, ${(-offset * speed * 100).toFixed(2)}px, 0)`;
      });
    }

    function onScroll() {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    update();
  }

  function initHeader() {
    const header = document.getElementById('topbar');
    const progress = document.getElementById('scrollProgress');
    let ticking = false;

    function update() {
      ticking = false;
      const scrolled = window.scrollY > 12;
      if (header) header.classList.toggle('is-scrolled', scrolled);
      if (progress) {
        const height = document.documentElement.scrollHeight - window.innerHeight;
        const ratio = height > 0 ? Math.min(1, window.scrollY / height) : 0;
        progress.style.width = `${(ratio * 100).toFixed(2)}%`;
      }
    }

    window.addEventListener(
      'scroll',
      () => {
        if (ticking) return;
        ticking = true;
        requestAnimationFrame(update);
      },
      { passive: true }
    );
    update();
  }

  function initTheme() {
    const root = document.documentElement;
    const saved = localStorage.getItem('dropqr.theme');
    if (saved) root.dataset.theme = saved;

    const button = document.getElementById('themeToggle');
    if (!button) return;
    const order = ['auto', 'light', 'dark'];
    button.addEventListener('click', () => {
      const current = root.dataset.theme || 'auto';
      const next = order[(order.indexOf(current) + 1) % order.length];
      root.dataset.theme = next;
      localStorage.setItem('dropqr.theme', next);
      toast(next === 'auto' ? 'Thème du système' : next === 'light' ? 'Thème clair' : 'Thème sombre');
    });
  }

  function initAccordion() {
    document.querySelectorAll('[data-accordion]').forEach((group) => {
      group.querySelectorAll('details').forEach((item) => {
        item.addEventListener('toggle', () => {
          if (!item.open) return;
          group.querySelectorAll('details[open]').forEach((other) => {
            if (other !== item) other.open = false;
          });
        });
      });
    });
  }

  function initCopyButtons() {
    document.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      const ok = await copyText(button.dataset.copy);
      toast(ok ? 'Copié dans le presse-papiers.' : 'Copie impossible.', ok ? 'success' : 'error');
    });
  }

  /* --------------------------------- export -------------------------------- */

  const baseUrlFromDom = document.querySelector('meta[name="dropqr-base-url"]');

  window.DropQR = {
    config,
    baseUrl: config.baseUrl || (baseUrlFromDom ? baseUrlFromDom.content : window.location.origin),
    reduceMotion,
    formatBytes,
    formatDate,
    formatDuration,
    escapeHtml,
    copyText,
    toast,
    on,
    emit,
    buildCodeSlots,
    renderCodeDisplay,
    startCountdown,
    createSparkline,
    storageMode: config.storageMode || 'local',
    storageUnavailable: (config.storageMode || 'local') === 'unavailable'
  };

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initHeader();
    initReveal();
    initCounters();
    initTilt();
    initParallax();
    initAccordion();
    initCopyButtons();
  });

  window.addEventListener('load', () => {
    if (!window.DropQR.storageUnavailable) return;
    toast('Stockage non configuré : l’envoi est désactivé sur ce déploiement.', 'error');
  });

  // Réveille la purge côté serveur au premier affichage (sans bloquer).
  fetch('/api/health', { cache: 'no-store' }).catch(() => {});
})();
