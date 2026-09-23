'use strict';

const initDashboard = () => {
  const root = document.getElementById('dashboardRoot');
  if (!root) return;
  // Garde anti double-initialisation après navigation PJAX.
  if (root.dataset.dropqrInit === '1') return;
  root.dataset.dropqrInit = '1';

  const list = document.getElementById('transferList');
  const emptyState = document.getElementById('dashboardEmpty');
  const statusNode = document.getElementById('dashboardStatus');
  const countNode = document.getElementById('transferCount');
  const refreshButton = document.getElementById('refreshTransfers');
  const clearButton = document.getElementById('clearTransferList');
  const store = window.DropQRStore;

  let entries = store ? store.load() : [];
  let busy = false;

  function setStatus(message, type = '') {
    statusNode.className = `status ${type}`.trim();
    statusNode.textContent = message;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function sanitizeUrl(value) {
    const url = String(value || '');
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function persistAndRender() {
    // Re-synchronise le stockage local avec la liste affichée.
    if (store) store.saveAll(entries);
    render();
  }

  function makeButton(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = label;
    return button;
  }

  async function copyText(text, button, doneLabel) {
    const original = button.textContent;
    if (await window.DropQR.copyText(text)) {
      button.textContent = doneLabel;
      window.setTimeout(() => { button.textContent = original; }, 1400);
    } else {
      window.prompt('Copiez la valeur :', text);
    }
  }

  async function refreshEntry(entry) {
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(entry.id)}`, { cache: 'no-store' });
      if (response.status === 404 || response.status === 410) return { alive: false };
      if (!response.ok) return { alive: true, uncertain: true };
      const payload = await response.json().catch(() => ({}));
      entry.expiresAt = payload.expiresAt || entry.expiresAt;
      entry.downloads = Number(payload.downloads || 0);
      return { alive: true };
    } catch (_error) {
      // Réseau/serveur injoignable: on conserve l'entrée.
      return { alive: true, uncertain: true };
    }
  }

  function createItem(entry) {
    const item = document.createElement('article');
    item.className = 'transfer-item';

    const head = document.createElement('div');
    head.className = 'transfer-item-head';
    const name = document.createElement('div');
    name.className = 'transfer-name';
    name.textContent = entry.fileName || 'fichier';
    const pill = document.createElement('span');
    pill.className = 'state-pill';
    pill.textContent = entry.stateLabel || 'Enregistré';
    head.append(name, pill);

    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    const metaParts = [];
    if (entry.code) metaParts.push(`Code : ${entry.code}`);
    if (entry.sizeHuman) metaParts.push(`Taille : ${entry.sizeHuman}`);
    if (entry.expiresAt) metaParts.push(`Expire : ${formatDate(entry.expiresAt)}`);
    if (Number.isFinite(entry.downloads)) metaParts.push(`Téléchargements : ${entry.downloads}`);
    metaParts.push(entry.deleteAfterDownload ? 'Suppression après le 1er téléchargement' : 'Suppression à expiration');
    meta.textContent = metaParts.join(' · ');

    const keyLine = document.createElement('div');
    keyLine.className = 'key-line';
    const keyLabel = document.createElement('code');
    keyLabel.textContent = entry.deleteKey || '';
    const keyCopy = makeButton('Copier la clé', 'mini-btn');
    keyCopy.addEventListener('click', () => copyText(entry.deleteKey, keyCopy, 'Copiée'));
    keyLine.append(keyLabel, keyCopy);

    const actions = document.createElement('div');
    actions.className = 'transfer-actions';

    const shareUrl = sanitizeUrl(entry.shareUrl);
    if (shareUrl) {
      const open = document.createElement('a');
      open.className = 'mini-btn';
      open.href = shareUrl;
      open.target = '_blank';
      open.rel = 'noopener';
      open.textContent = 'Ouvrir';
      actions.appendChild(open);

      const copyLink = makeButton('Copier le lien', 'mini-btn');
      copyLink.addEventListener('click', () => copyText(shareUrl, copyLink, 'Copié'));
      actions.appendChild(copyLink);
    }

    const deleteButton = makeButton('Supprimer', 'mini-btn danger');
    deleteButton.addEventListener('click', () => deleteEntry(entry, deleteButton));
    actions.appendChild(deleteButton);

    item.append(head, meta, keyLine, actions);
    return item;
  }

  function render() {
    countNode.textContent = `${entries.length} transfert${entries.length > 1 ? 's' : ''}`;
    list.textContent = '';
    emptyState.classList.toggle('hidden', entries.length > 0);
    entries.forEach((entry) => list.appendChild(createItem(entry)));
  }

  async function deleteEntry(entry, button) {
    if (!entry.deleteKey) {
      setStatus('Clé de suppression absente pour ce transfert.', 'error');
      return;
    }
    const confirmed = window.confirm(`Supprimer définitivement « ${entry.fileName || 'ce fichier'} » du serveur ?`);
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
    } catch (error) {
      setStatus(error.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  async function refreshAll() {
    if (busy || !entries.length) return;
    busy = true;
    refreshButton.disabled = true;
    setStatus('Vérification des transferts…');
    const before = entries.length;
    const results = await Promise.all(entries.map((entry) => refreshEntry(entry)));
    entries = entries.filter((_entry, index) => results[index].alive);
    const removed = before - entries.length;
    persistAndRender();
    setStatus(removed > 0
      ? `Liste à jour. ${removed} transfert${removed > 1 ? 's' : ''} expiré${removed > 1 ? 's' : ''} ou supprimé${removed > 1 ? 's' : ''} retiré${removed > 1 ? 's' : ''}.`
      : 'Liste à jour. Tous les transferts sont encore disponibles.', removed > 0 ? '' : 'success');
    busy = false;
    refreshButton.disabled = false;
  }

  refreshButton.addEventListener('click', refreshAll);
  clearButton.addEventListener('click', () => {
    if (!entries.length) return;
    const confirmed = window.confirm('Effacer la liste locale ? Les fichiers déjà envoyés restent sur le serveur jusqu’à leur expiration, mais tu perdras les clés de suppression.');
    if (!confirmed) return;
    entries = [];
    if (store) store.clear();
    render();
    setStatus('Liste locale effacée.', 'success');
  });

  render();
  refreshAll();
};
initDashboard();
window.addEventListener('pjax:load', initDashboard);
