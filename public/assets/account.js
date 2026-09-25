'use strict';

/* DropQR — page Compte (v1)
   Lit la session Discord existante (/api/auth/me) : identité, expiration,
   déconnexion, état des transferts locaux. Aucun invent de compte propre :
   le produit reste anonyme par conception. */

(() => {
  const root = document.getElementById('acctRoot');
  if (!root) return;
  const UI = window.DropQRUI || null;

  const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const render = (html) => {
    root.textContent = '';
    const holder = document.createElement('div');
    holder.innerHTML = html;
    while (holder.firstElementChild) root.appendChild(holder.firstElementChild);
  };

  const localTransfers = () => {
    const store = window.DropQRStore;
    const entries = store ? store.load() : [];
    const alive = entries.filter((entry) => entry.expiresAt && Date.parse(entry.expiresAt) > Date.now());
    return { total: entries.length, alive: alive.length, entries };
  };

  const idle = () => render(`
    <div class="panel" style="padding:34px"><div class="pulse-line" aria-hidden="true"></div></div>`);

  const anonymous = (configured, nextHref = '/upload') => render(`
    <section class="panel" style="padding:clamp(28px,4vw,44px)">
      <p class="eyebrow">Session</p>
      <h2 style="font-size:clamp(1.6rem,3vw,2.2rem);margin:14px 0 10px">Tu navigues incognito — et c’est voulu.</h2>
      <p class="lead" style="max-width:56ch">DropQR ne demande aucun compte pour envoyer ou recevoir. ${configured
        ? 'Connecte-toi avec Discord si tu veux que le staff sache qui envoie tes fichiers.'
        : 'La connexion Discord n’est pas activée sur cette instance.'}
      </p>
      <div class="actions" style="margin-top:24px">
        ${configured ? `<a class="primary-btn" href="/api/auth/discord/login?next=${encodeURIComponent(nextHref)}">Se connecter avec Discord</a>` : `<a class="primary-btn" href="${nextHref}">Envoyer un fichier →</a>`}
        <a class="secondary-btn" href="/login">Écran de connexion</a>
        <a class="secondary-btn" href="/help#compte">Comment ça marche</a>
      </div>
      <div class="kv">
        <div><span class="k">Transferts de ce navigateur</span><span class="v" id="acct-local">—</span></div>
        <div><span class="k">Stockage des clés de suppression</span><span class="v">Local uniquement (localStorage)</span></div>
        <div><span class="k">Cookies tiers / tracking</span><span class="v">Aucun</span></div>
      </div>
    </section>`);

  const signedIn = (payload) => {
    const user = payload.user;
    const local = localTransfers();
    const expiry = payload.sessionExpiresAt ? UI.formatDate(payload.sessionExpiresAt) : '30 jours glissants';
    render(`
      <div class="acct-grid">
        <section class="panel" style="padding:clamp(24px,3.4vw,38px)">
          <div class="acct-id">
            <img src="${esc(user.avatar)}" alt="" referrerpolicy="no-referrer">
            <div>
              <p class="eyebrow">Compte actif</p>
              <h2 style="margin:8px 0 0">${esc(user.globalName || user.username)}</h2>
              <div class="acct-handle">@${esc(user.username)} · ${esc(user.id)}</div>
            </div>
          </div>
          <div class="kv">
            <div><span class="k">Identité</span><span class="v">Discord (OAuth2 identify)</span></div>
            <div><span class="k">Session expire</span><span class="v">${esc(expiry)}</span></div>
            <div><span class="k">Transferts actifs de ce navigateur</span><span class="v">${local.alive} / ${local.total}</span></div>
            <div><span class="k">Envois nominatifs</span><span class="v">tes fichiers seront attribués à ton pseudo côté staff</span></div>
          </div>
          <div class="actions" style="margin-top:22px">
            <a class="primary-btn" href="/upload">Envoyer un fichier →</a>
            <a class="secondary-btn" href="/dashboard">Voir mes transferts</a>
            <button class="secondary-btn danger" id="acct-logout" type="button">Se déconnecter</button>
          </div>
        </section>
        <aside class="panel" style="padding:24px">
          <h3 style="font-size:15px;margin-bottom:10px">Confidentialité</h3>
          <p style="color:var(--ink-soft);font-size:13px;line-height:1.6">Le serveur ne garde que ton id Discord, pseudo et avatar pour signer tes envois. Les fichiers, eux, restent anonymes pour les destinataires et n’existent que le temps du TTL. Tout est détaillé dans les <a href="/mentions" style="color:var(--signal)">mentions</a>.</p>
          <div class="actions" style="margin-top:16px"><button class="mini-btn" id="acct-clear" type="button">Effacer mes clés locales</button></div>
        </aside>
      </div>`);

    const logout = document.getElementById('acct-logout');
    if (logout) {
      logout.addEventListener('click', async () => {
        const ok = !UI || await UI.confirm({
          title: 'Se déconnecter ?',
          body: 'Ta session Discord locale sera supprimée. Tes transferts en cours restent actifs tant qu’ils n’ont pas expiré.',
          confirmLabel: 'Se déconnecter',
          danger: true
        });
        if (!ok) return;
        logout.disabled = true;
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_error) {}
        window.location.reload();
      });
    }
    const clear = document.getElementById('acct-clear');
    if (clear) {
      clear.addEventListener('click', async () => {
        if (!local.total) { if (UI) UI.toast('Aucune clé locale à effacer.'); return; }
        const ok = !UI || await UI.confirm({
          title: 'Effacer les clés locales ?',
          body: 'Tu perdras la possibilité de supprimer manuellement tes transferts avant expiration. Les fichiers eux-mêmes expireront normalement.',
          confirmLabel: 'Effacer',
          danger: true
        });
        if (!ok) return;
        if (window.DropQRStore) window.DropQRStore.clear();
        if (UI) UI.toast('Liste locale effacée.');
        render(idle());
        signedIn(payload);
      });
    }
  };

  idle();
  fetch('/api/auth/me', { cache: 'no-store', credentials: 'same-origin' })
    .then((response) => response.ok ? response.json() : null)
    .then((payload) => {
      if (!payload) { anonymous(false); return; }
      if (payload.user) signedIn(payload);
      else anonymous(Boolean(payload.configured));
    })
    .catch(() => anonymous(false));
})();
