'use strict';

/* DropQR — tableau de bord des transferts (v2)
   Le registre local (DropQRStore) reste la source de vérité des clés de
   suppression. Ajoute : barres de vie en direct, états (vivant / expiré),
   copie de lien + code + clé, ouverture, suppression via dialogue accessible,
   synchronisation serveur au rafraîchissement. */

const initDashboard = () => {
  const root = document.getElementById('dashboardRoot');
  if (!root) return;
  // Garde anti double-initialisation après navigation PJAX.
  if (root.dataset.dropqrInit === '1') return;
  root.dataset.dropqrInit = '1';

  const UI = window.DropQRUI || null;
  const list = document.getElementById('transferList');
  const emptyState = document.getElementById('dashboardEmpty');
  const statusNode = document.getElementById('dashboardStatus');
  const countNode = document.getElementById('transferCount');
  const refreshButton = document.getElementById('refreshTransfers');
  const clearButton = document.getElementById('clearTransferList');
  const statsActive = document.getElementById('statActive');
  const statsBytes = document.getElementById('statBytes');
  const store = window.DropQRStore;

  let entries = store ? store.load() : [];
  let busy = false;

  function setStatus(message, type = '') {
    statusNode.className = `status ${type}`.trim();
    statusNode.textContent = message;
  }

  function formatDate(value) {
    return UI ? UI.formatDate(value) : new Date(value).toLocaleString('fr-FR');
  }

  function fileExt(name) {
    const match = String(name || '').match(/\.([a-z0-9]{1,6})$/i);
    return match ? match[1].toUpperCase() : 'FILE';
  }

  function persistAndRender() {
    if (store) store.saveAll(entries);
    render();
  }

  function copyText(text, button, doneLabel) {
    if (!text) return;
    if (UI) {
      UI.copy(text, `${doneLabel} copié.`).then((ok) => { if (ok && button) flash(button, doneLabel); });
      return;
    }
    navigator.clipboard.writeText(text)
      .then(() => flash(button, doneLabel))
      .catch(() => { window.prompt('Copie la valeur:', text); });
  }
  function flash(button, label) {
    if (!button) return;
    const original = button.textContent;
    button.textContent = label;
    window.setTimeout(() => { button.textContent = original; }, 1400);
  }

  async function refreshEntry(entry) {
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(entry.id)}`, { cache: 'no-store' });
      if (response.status === 404 || response.status === 410) return { alive: false };
      if (!response.ok) return { alive: true, uncertain: true };
      const payload = await response.json().catch(() => ({}));
      entry.expiresAt = payload.expiresAt || entry.expiresAt;
      entry.createdAt = payload.createdAt || entry.createdAt;
      entry.downloads = Number(payload.downloads || 0);
      if (payload.shareUrl) entry.shareUrl = payload.shareUrl;
      if (payload.sizeHuman) entry.sizeHuman = payload.sizeHuman;
      return { alive: true };
    } catch (_error) {
      // Réseau/serveur injoignable: on conserve l'entrée.
      return { alive: true, uncertain: true };
    }
  }

  function makeButton(label, className, title) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    if (title) button.title = title;
    return button;
  }

  function createItem(entry) {
    const item = document.createElement('article');
    item.className = 'transfer-item';

    const main = document.createElement('div');
    main.style.minWidth = '0';

    const head = document.createElement('div');
    head.className = 'transfer-item-head';
    const name = document.createElement('div');
    name.className = 'transfer-name';
    name.textContent = entry.fileName || 'fichier';
    const ext = document.createElement('span');
    ext.className = 'tag';
    ext.textContent = fileExt(entry.fileName);
    const pill = document.createElement('span');
    pill.className = 'state-pill live';
    pill.textContent = 'Vivant';
    const countdown = document.createElement('span');
    countdown.className = 'tag countdown';
    if (entry.expiresAt) countdown.dataset.expiry = entry.expiresAt;
    countdown.textContent = '—';
    head.append(name, ext, pill, countdown);

    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    const metaParts = [];
    if (entry.code) metaParts.push(`CODE ${entry.code}`);
    if (entry.sizeHuman) metaParts.push(entry.sizeHuman);
    if (entry.expiresAt) metaParts.push(`EXPIRE ${formatDate(entry.expiresAt)}`);
    if (Number.isFinite(entry.downloads)) metaParts.push(`${entry.downloads} téléchargement${entry.downloads > 1 ? 's' : ''}`);
    metaParts.push(entry.deleteAfterDownload ? 'PURGE APRÈS 1ER DL' : 'PURGE À EXPIRATION');
    meta.textContent = metaParts.join('  ·  ');

    const life = document.createElement('div');
    life.className = 'transfer-life';
    life.dataset.lifeEnd = entry.expiresAt || '';
    life.dataset.lifeStart = entry.createdAt || '';
    const lifeBar = document.createElement('i');
    life.appendChild(lifeBar);

    const keyLine = document.createElement('div');
    keyLine.className = 'key-line';
    keyLine.style.marginTop = '10px';
    const keyLabel = document.createElement('code');
    keyLabel.textContent = entry.deleteKey || '';
    keyLabel.title = 'Clé de suppression — ne jamais la partager';
    const keyCopy = makeButton('Clé', 'mini-btn', 'Copier la clé de suppression');
    keyCopy.addEventListener('click', () => copyText(entry.deleteKey, keyCopy, 'Clé'));
    keyLine.append(keyLabel, keyCopy);

    main.append(head, meta, life, keyLine);

    const side = document.createElement('div');
    side.className = 'transfer-side';
    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    const shareUrl = /^https?:\/\//i.test(String(entry.shareUrl || '')) ? entry.shareUrl : '';
    if (shareUrl) {
      const open = document.createElement('a');
      open.className = 'mini-btn';
      open.href = shareUrl;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Ouvrir le lien';
      actions.appendChild(open);

      const copyLink = makeButton('Copier', 'mini-btn');
      copyLink.addEventListener('click', () => copyText(shareUrl, copyLink, 'Lien'));
      actions.appendChild(copyLink);
    }
    if (entry.code) {
      const copyCode = makeButton(entry.code, 'mini-btn', 'Copier le code');
      copyCode.style.fontFamily = 'var(--mono)';
      copyCode.addEventListener('click', () => copyText(entry.code, copyCode, 'Code'));
      actions.appendChild(copyCode);
    }
    const deleteButton = makeButton('Supprimer', 'mini-btn danger');
    deleteButton.addEventListener('click', () => deleteEntry(entry, deleteButton));
    actions.appendChild(deleteButton);
    side.appendChild(actions);

    item.append(main, side);

    // Expiration atteinte => l'entrée devient muette (le serveur purge à son tour).
    countdown.addEventListener('dq:expired', () => {
      pill.className = 'state-pill dead';
      pill.textContent = 'Expiré';
      life.classList.add('dead');
    });
    return item;
  }

  function updateStats() {
    if (!statsActive || !statsBytes) return;
    const alive = entries.filter((entry) => entry.expiresAt && Date.parse(entry.expiresAt) > Date.now());
    statsActive.textContent = String(alive.length);
    const bytes = alive.reduce((sum, entry) => {
      const match = /([\d.,]+)\s*(o|Ko|Mo|Go|To)/i.exec(String(entry.sizeHuman || ''));
      if (!match) return sum;
      const units = { o: 1, ko: 1024, mo: 1024 ** 2, go: 1024 ** 3, to: 1024 ** 4 };
      return sum + Number(match[1].replace(',', '.')) * (units[match[2].toLowerCase()] || 0);
    }, 0);
    statsBytes.textContent = bytes ? UI.formatBytes(bytes) : '0 o';
  }

  function render() {
    countNode.textContent = entries.length ? `${entries.length} transfert${entries.length > 1 ? 's' : ''}` : 'aucun transfert';
    list.textContent = '';
    emptyState.classList.toggle('hidden', entries.length > 0);
    entries.forEach((entry) => list.appendChild(createItem(entry)));
    updateStats();
  }

  async function deleteEntry(entry, button) {
    if (!entry.deleteKey) {
      setStatus('Clé de suppression absente pour ce transfert.', 'error');
      return;
    }
    const confirmed = UI
      ? await UI.confirm({
        title: 'Supprimer ce transfert ?',
        body: `« ${entry.fileName || 'ce fichier'} » disparaîtra immédiatement du serveur. Les liens et QR en cours cesseront de fonctionner.`,
        confirmLabel: 'Supprimer maintenant',
        danger: true
      })
      : window.confirm(`Supprimer définitivement « ${entry.fileName || 'ce fichier'} » du serveur ?`);
    if (!confirmed) return;

    button.disabled = true;
    setStatus('Suppression en cours…');
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(entry.id)}`, {
        method: 'DELETE',
        headers: { 'X-Delete-Key': entry.deleteKey }
      });
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Suppression impossible HTTP ${response.status}.`);
      }
      entries = entries.filter((item) => item.id !== entry.id);
      persistAndRender();
      setStatus(`« ${entry.fileName || 'Fichier'} » a été supprimé du serveur.`, 'success');
      if (UI) UI.toast('Transfert supprimé.');
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function refreshAll() {
    if (busy || !entries.length) { updateStats(); return; }
    busy = true;
    refreshButton.disabled = true;
    setStatus('Vérification des transferts…');
    const before = entries.length;
    const results = await Promise.all(entries.map((entry) => refreshEntry(entry)));
    entries = entries.filter((_entry, index) => results[index].alive);
    const removed = before - entries.length;
    persistAndRender();
    setStatus(removed > 0
      ? `Liste à jour — ${removed} transfert${removed > 1 ? 's' : ''} expiré${removed > 1 ? 's' : ''} ou supprimé${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''}.`
      : 'Liste à jour. Tous les transferts répondent.', removed > 0 ? '' : 'success');
    busy = false;
    refreshButton.disabled = false;
  }

  refreshButton.addEventListener('click', refreshAll);
  clearButton.addEventListener('click', async () => {
    if (!entries.length) return;
    const confirmed = UI
      ? await UI.confirm({
        title: 'Effacer la liste locale ?',
        body: 'Les fichiers déjà envoyés restent sur le serveur jusqu’à leur expiration, mais tu perdras les clés de suppression et ne pourras plus les retirer avant.',
        confirmLabel: 'Effacer',
        danger: true
      })
      : window.confirm('Effacer la liste locale ? Les fichiers déjà envoyés restent sur le serveur jusqu’à leur expiration, mais tu perdras les clés de suppression.');
    if (!confirmed) return;
    entries = [];
    if (store) store.clear();
    render();
    setStatus('Liste locale effacée. Les fichiers restants expireront normalement.', 'success');
  });

  render();
  refreshAll();
  // Rafraîchit aussi quand l'onglet revient au premier plan.
  const onVisible = () => { if (!document.hidden && !busy) refreshAll(); };
  document.addEventListener('visibilitychange', onVisible);
};
initDashboard();
window.addEventListener('pjax:load', initDashboard);
