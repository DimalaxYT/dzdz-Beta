/* Navigation et utilitaires partagés. Aucune route de fichier n'est préchargée. */
(() => {
  'use strict';
  let configPromise = null;
  window.DropQR = {
    async getConfig() {
      if (!configPromise) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        configPromise = fetch('/api/config', { cache: 'no-store', signal: controller.signal })
          .then(async (response) => {
            if (!response.ok) throw new Error('Serveur de transfert injoignable. Réessayez.');
            const config = await response.json();
            if (config.app !== 'DropQR') throw new Error('Serveur de transfert invalide.');
            return config;
          }).catch((error) => { configPromise = null; throw error; })
          .finally(() => clearTimeout(timeout));
      }
      return configPromise;
    },
    formatBytes(bytes) {
      let size = Number(bytes) || 0;
      const units = ['o', 'Ko', 'Mo', 'Go', 'To'];
      let i = 0;
      while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
      return `${i === 0 ? size : size.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ${units[i]}`;
    },
    formatDate(value) {
      return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    },
    fileType(mime, name) {
      const extension = String(name || '').split('.');
      const ext = extension.length > 1 ? extension.pop().slice(0, 12).toUpperCase() : '';
      const category = String(mime || '').split('/')[0];
      const label = { image: 'Image', video: 'Vidéo', audio: 'Audio', text: 'Texte' }[category] || 'Fichier';
      return ext ? `${label} ${ext}` : label;
    },
    async copyText(text) {
      try {
        if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
      } catch (_error) { /* Iframe / navigateur non sécurisé : repli sans faux succès. */ }
      const field = document.createElement('textarea');
      const previous = document.activeElement;
      field.value = text;
      field.setAttribute('readonly', '');
      field.className = 'sr-only';
      document.body.appendChild(field);
      field.select();
      let copied = false;
      try { copied = document.execCommand('copy'); } catch (_error) {}
      field.remove();
      previous?.focus({ preventScroll: true });
      return copied;
    }
  };

  let lifecycle = null;
  function initSite() {
    lifecycle?.abort();
    lifecycle = new AbortController();
    const { signal } = lifecycle;
    const nav = document.getElementById('nv');
    const menu = nav?.querySelector('.nv-menu');
    const scrollNav = () => nav?.classList.toggle('scrolled', window.scrollY > 20);
    window.addEventListener('scroll', scrollNav, { passive: true, signal });
    scrollNav();
    const closeMenu = (focus = false) => {
      if (!menu?.open) return;
      menu.open = false;
      if (focus) menu.querySelector('summary').focus();
    };
    document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeMenu(true); }, { signal });
    document.addEventListener('click', (event) => {
      if (menu?.open && !menu.contains(event.target)) closeMenu();
      if (event.target.closest('.nv-menu a')) closeMenu();
    }, { signal });

    const contacts = [...document.querySelectorAll('[data-discord-contact]')];
    const sizes = [...document.querySelectorAll('[data-max-file-size]')];
    if (contacts.length || sizes.length) window.DropQR.getConfig().then((config) => {
      if (signal.aborted) return;
      sizes.forEach((node) => { node.textContent = config.maxFileSizeHuman || 'selon le serveur'; });
      if (config.discordContactUrl && /^https:\/\//i.test(config.discordContactUrl)) contacts.forEach((link) => { link.href = config.discordContactUrl; link.hidden = false; });
    }).catch(() => {});

    const slots = document.querySelectorAll('[data-discord-auth]');
    if (slots.length) fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin', signal })
      .then((response) => response.ok ? response.json() : null)
      .then((payload) => {
        if (!payload?.configured || signal.aborted) return;
        slots.forEach((slot) => {
          slot.replaceChildren();
          if (payload.user) {
            const chip = document.createElement('span'); chip.className = 'discord-chip';
            const avatar = document.createElement('img');
            avatar.src = payload.user.avatar; avatar.alt = ''; avatar.width = 28; avatar.height = 28; avatar.referrerPolicy = 'no-referrer';
            const name = document.createElement('span'); name.className = 'discord-chip-name'; name.textContent = payload.user.globalName || payload.user.username;
            const logout = document.createElement('button'); logout.type = 'button'; logout.className = 'discord-logout'; logout.textContent = '×'; logout.setAttribute('aria-label', 'Se déconnecter de Discord');
            logout.addEventListener('click', async () => {
              logout.disabled = true;
              try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); window.location.reload(); }
              catch (_error) { logout.disabled = false; logout.title = 'Connexion interrompue. Réessayez.'; }
            }, { signal });
            chip.append(avatar, name, logout); slot.append(chip);
          } else {
            const link = document.createElement('a'); link.className = 'discord-auth-btn';
            link.href = `/api/auth/discord/login?next=${encodeURIComponent(location.pathname + location.search)}`;
            link.textContent = 'Discord'; slot.append(link);
          }
        });
      }).catch(() => {});
  }

  initSite();
  window.addEventListener('pjax:load', initSite);
  window.addEventListener('beforeunload', (event) => {
    if (!window.DropQRTransferBusy) return;
    event.preventDefault(); event.returnValue = '';
  });

  // PJAX entre pages statiques uniquement. La landing 3D et les pages de
  // réception publiques utilisent une navigation native (cycle de vie complet).
  const paths = new Set(['/upload', '/receive', '/help', '/mentions', '/dashboard']);
  const scripts = new Map([...document.querySelectorAll('script[src]')].map((node) => [new URL(node.src).pathname, Promise.resolve()]));
  let pending = null;
  const loadScript = (src) => {
    const url = new URL(src, location.href);
    if (scripts.has(url.pathname)) return scripts.get(url.pathname);
    const promise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url.href;
      script.onload = resolve; script.onerror = reject;
      document.body.append(script);
    });
    scripts.set(url.pathname, promise);
    return promise;
  };

  async function navigate(url, push = true) {
    pending?.abort();
    const request = new AbortController();
    pending = request;
    document.documentElement.classList.add('pjax-loading');
    try {
      const response = await fetch(url.href, { headers: { 'X-PJAX': 'true' }, signal: request.signal });
      if (!response.ok) throw new Error('Navigation indisponible');
      const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
      const shell = doc.querySelector('.shell');
      if (!shell || !doc.body.hasAttribute('data-static-page')) throw new Error('Page non statique');
      if (request.signal.aborted) return;
      window.dispatchEvent(new Event('pjax:before'));
      lifecycle?.abort();
      document.querySelector('.shell').replaceWith(shell);
      document.querySelector('header.nv').replaceWith(doc.querySelector('header.nv'));
      document.querySelector('footer.site-footer').replaceWith(doc.querySelector('footer.site-footer'));
      document.title = doc.title;
      document.body.className = doc.body.className;
      if (push) history.pushState({ dropqr: true }, '', url.href);
      // Chargement séquentiel : store.js doit exister avant dashboard/upload.
      for (const script of doc.querySelectorAll('script[src]')) {
        await loadScript(script.getAttribute('src'));
        if (request.signal.aborted) return;
      }
      window.dispatchEvent(new Event('pjax:load'));
      document.getElementById('main')?.focus({ preventScroll: true });
      if (url.hash) document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
      else window.scrollTo({ top: 0, behavior: 'instant' });
    } catch (error) {
      if (error.name !== 'AbortError') window.location.assign(url.href);
    } finally {
      if (pending === request) { pending = null; document.documentElement.classList.remove('pjax-loading'); }
    }
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest('a[href]');
    if (!link || link.target || link.hasAttribute('download')) return;
    const url = new URL(link.href);
    if (url.origin !== location.origin || !document.body.hasAttribute('data-static-page') || !paths.has(url.pathname)) return;
    if (url.pathname === location.pathname && url.search === location.search) return;
    if (window.DropQRTransferBusy) {
      event.preventDefault();
      if (!window.confirm('Quitter cette page et interrompre l’envoi ?')) return;
      window.DropQRAbortTransfer?.();
    }
    event.preventDefault();
    navigate(url);
  });
  window.addEventListener('popstate', () => {
    if (document.body.hasAttribute('data-static-page') && paths.has(location.pathname)) navigate(new URL(location.href), false);
    else window.location.reload();
  });
})();
