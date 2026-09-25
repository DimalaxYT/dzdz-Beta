'use strict';

/* DropQR — expérience de connexion (v1)
   Le produit est anonyme par conception : le compte Discord optionnel sert à
   identifier l'expéditeur auprès du staff. Cette page est la GATE d'accès à
   l'application ; le serveur redirige vers ?next= après OAuth, et refuse tout
   next absolu (même logique côté server.js). */

(() => {
  const UI = window.DropQRUI || null;
  const root = document.getElementById('authState');
  if (!root) return;

  const params = new URLSearchParams(window.location.search);
  let next = params.get('next') || '/upload';
  if (!next.startsWith('/') || next.startsWith('//')) next = '/upload';
  const mode = params.get('mode'); // 'signup' | 'forgot' => mêmes chemins, copies distinctes

  const safeNext = next;

  const buttons = () => {
    document.querySelectorAll('[data-next-href]').forEach((el) => { el.href = safeNext; });
  };
  buttons();

  const card = (html) => {
    root.textContent = '';
    const holder = document.createElement('div');
    holder.innerHTML = html;
    while (holder.firstElementChild) root.appendChild(holder.firstElementChild);
    buttons();
  };

  const loading = () => card(`
    <div class="auth-state">
      <p class="auth-note">Vérification de la session…</p>
      <div class="pulse-line" aria-hidden="true"></div>
    </div>`);

  const stateError = (offline) => card(`
    <div class="auth-state">
      <h2 style="font-size:17px">${offline ? 'Serveur injoignable' : 'Le serveur a répondu bizarrement'}</h2>
      <p class="auth-note">DropQR n’arrive pas à lire l’état de session. Réessaie — si le problème persiste, le backend n’est peut-être pas déployé sur ce domaine.</p>
      <a class="secondary-btn" href="" data-reload>Réessayer</a>
    </div>`);

  const stateSignedIn = (user) => card(`
    <div class="auth-state" style="text-align:center;justify-items:center;gap:18px">
      <div class="auth-ok-ring" aria-hidden="true">✓</div>
      <div class="row" style="justify-content:center">
        <img src="${user.avatar}" alt="" referrerpolicy="no-referrer">
        <div style="text-align:left">
          <strong style="display:block">${escapeHtml(user.globalName || user.username)}</strong>
          <span class="auth-note">@${escapeHtml(user.username)}</span>
        </div>
      </div>
      <p class="auth-note">Session active. Tu retournes dans l’application…</p>
      <div class="actions" style="justify-content:center">
        <a class="primary-btn" href="${escapeAttr(safeNext)}">Continuer</a>
        <a class="secondary-btn" href="/account">Mon compte</a>
      </div>
    </div>`);

  const stateDiscord = () => card(`
    <div class="auth-state">
      ${mode === 'forgot' ? `
        <h2 style="font-size:17px">Mot de passe oublié&nbsp;?</h2>
        <p class="auth-note">DropQR ne stocke <strong>aucun mot de passe</strong> : la connexion passe par Discord et ta sécurité est gérée chez eux. Si tu as un souci de compte Discord, récupère-le sur <a href="https://discord.com" rel="noopener" target="_blank">discord.com</a>, puis reviens ici.</p>` : `
        <h2 style="font-size:17px">${mode === 'signup' ? 'Créer un passage nominatif' : 'Continuer avec Discord'}</h2>
        <p class="auth-note">Connexion OAuth2 <strong>identify</strong> uniquement : pas d’e-mail, pas de mot de passe, aucune donnée Discord stockée au-delà de ton pseudo et avatar. Le staff sait ainsi <strong>qui</strong> envoie chaque fichier.</p>`}
      <a class="auth-btn-discord" href="/api/auth/discord/login?next=${encodeURIComponent(safeNext)}">
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.3 4.9A18 18 0 0 0 15.9 3.5l-.2.4a16 16 0 0 1 4 1.3 15 15 0 0 0-11.4 0 16 16 0 0 1 4-1.3l-.2-.4A18 18 0 0 0 3.7 4.9C1.3 8.4.6 11.9 1 15.3a18 18 0 0 0 5.5 2.8l.4-.6a12 12 0 0 1-1.9-.9l.4-.3a12.8 12.8 0 0 0 11 0l.4.3c-.6.4-1.2.7-1.9 1l.4.5a18 18 0 0 0 5.5-2.8c.5-4-.8-7.4-2.5-10.4ZM8.7 13.5c-.9 0-1.6-.8-1.6-1.9s.7-1.9 1.6-1.9 1.7.9 1.6 1.9c0 1.1-.7 1.9-1.6 1.9Zm6.6 0c-.9 0-1.6-.8-1.6-1.9s.7-1.9 1.6-1.9 1.7.9 1.6 1.9c0 1.1-.7 1.9-1.6 1.9Z"/></svg>
        <span>Continuer avec Discord</span>
      </a>
      <div class="auth-divider">ou</div>
      <a class="btn" href="${escapeAttr(safeNext)}">Entrer sans compte →</a>
      <p class="auth-note">DropQR fonctionne entièrement anonymement&nbsp;: le compte est <strong>optionnel</strong>. Sans compte, tu peux déjà envoyer, partager et recevoir&nbsp;; tu perds juste la mention «&nbsp;envoyé par&nbsp;» côté staff. <a href="/help#compte">En savoir plus</a>.</p>
    </div>`);

  const stateNotConfigured = () => card(`
    <div class="auth-state">
      <h2 style="font-size:17px">Aucun compte n’est requis</h2>
      <p class="auth-note">Cette instance DropQR ne propose pas (encore) de connexion Discord&nbsp;: le propriétaire du site ne l’a pas configurée. Le produit fonctionne <strong>à 100&nbsp;% de façon anonyme</strong> — c’est voulu, les transferts ne demandent aucune identité.</p>
      <p class="auth-note">Tu veux identifier tes envois&nbsp;? Active <code>DISCORD_CLIENT_ID</code> + <code>DISCORD_CLIENT_SECRET</code> côté serveur&nbsp;: ce bouton se transformera en «&nbsp;Continuer avec Discord&nbsp;».</p>
      <div class="actions">
        <a class="primary-btn" href="${escapeAttr(safeNext)}">Ouvrir DropQR →</a>
        <a class="secondary-btn" href="/help">Aide</a>
      </div>
    </div>`);

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function escapeAttr(value) {
    return escapeHtml(value).replace(/'/g, '&#039;');
  }

  root.addEventListener('click', (event) => {
    if (event.target.closest('[data-reload]')) { event.preventDefault(); window.location.reload(); }
  });

  loading();
  fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => { if (!response.ok) throw new Error(String(response.status)); return response.json(); })
    .then((payload) => {
      if (payload.user) {
        stateSignedIn(payload.user);
        const delay = UI && UI.reduced() ? 300 : 1400;
        setTimeout(() => { window.location.href = safeNext; }, delay);
      } else if (payload.configured) {
        stateDiscord();
      } else {
        stateNotConfigured();
      }
    })
    .catch(() => stateError(true));

  /* ---------- Fond de scène : matrice « QR vivant » (canvas 2D léger) ---------- */
  const canvas = document.getElementById('auth-matrix');
  if (canvas && canvas.getContext && !(UI && UI.reduced())) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const cell = 16;
    let w = 0; let h = 0; let raf = null; let t = 0;
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, Math.floor(rect.width)); h = Math.max(1, Math.floor(rect.height));
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const hash = (x, y, i) => {
      let v = x * 374761393 + y * 668265263 + i * 2654435761;
      v = (v ^ (v >> 13)) * 1274126177;
      return ((v ^ (v >> 16)) >>> 0) / 4294967295;
    };
    const frame = () => {
      raf = null;
      t += 1;
      ctx.clearRect(0, 0, w, h);
      const cols = Math.ceil(w / cell); const rows = Math.ceil(h / cell);
      const drift = Math.floor(t / 22);
      for (let y = 0; y < rows; y += 1) {
        for (let x = 0; x < cols; x += 1) {
          const v = hash(x, y + drift, 1);
          if (v < 0.52) continue;
          const blink = hash(x, y + drift, 2);
          const near = 1 - Math.min(1, Math.hypot(x * cell - w * 0.75, y * cell - h * 0.3) / (Math.max(w, h) * 0.7));
          const alpha = (v > 0.93 ? 0.5 : 0.14) + near * 0.2 * (blink > 0.5 ? 1 : 0.2);
          ctx.fillStyle = v > 0.97 ? `rgba(131,225,207,${alpha})` : `rgba(220,255,94,${alpha})`;
          const s = cell * (v > 0.97 ? 0.42 : 0.26);
          ctx.fillRect(x * cell + (cell - s) / 2, y * cell + (cell - s) / 2, s, s);
        }
      }
      schedule();
    };
    const schedule = () => { raf = window.setTimeout(frame, 140); }; // ~7 fps : ambiance, pas un jeu vidéo
    const start = () => { resize(); if (raf === null) frame(); };
    const stop = () => { if (raf !== null) { clearTimeout(raf); raf = null; } };
    window.addEventListener('resize', () => { if (raf !== null) resize(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stop(); else start(); });
    start();
  }
})();
