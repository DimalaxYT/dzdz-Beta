/* ==========================================================================
   DropQR — page « Mes liens »
   La liste vit dans le navigateur ; l'état réel (expiration, téléchargements)
   vient du serveur, et la suppression à distance utilise la clé privée.
   ========================================================================== */

(() => {
  'use strict';

  const { escapeHtml, formatDate, startCountdown, toast, copyText, reduceMotion } = window.DropQR;

  const list = document.getElementById('transferList');
  const empty = document.getElementById('emptyDashboard');
  const status = document.getElementById('dashboardStatus');
  const refreshButton = document.getElementById('refreshButton');
  const clearLocalButton = document.getElementById('clearLocalButton');
  const statCount = document.getElementById('statCount');
  const statSize = document.getElementById('statSize');
  const statExpired = document.getElementById('statExpired');

  let stopCountdowns = [];

  function readTransfers() {
    try {
      return JSON.parse(localStorage.getItem('dropqr.transfers') || '[]');
    } catch {
      return [];
    }
  }

  function writeTransfers(transfers) {
    localStorage.setItem('dropqr.transfers', JSON.stringify(transfers));
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message || '';
  }

  function animateNumber(element, value, suffix = '') {
    if (!element) return;
    if (reduceMotion) {
      element.textContent = `${value}${suffix}`;
      return;
    }
    const start = performance.now();
    const from = Number(String(element.textContent).replace(/[^0-9.]/g, '')) || 0;
    const duration = 600;
    function frame(timestamp) {
      const progress = Math.min(1, (timestamp - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = `${Math.round(from + (value - from) * eased)}${suffix}`;
      if (progress < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function formatRemaining(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    if (total <= 0) return 'expiré';
    if (total < 3600) return `${Math.ceil(total / 60)} min`;
    if (total < 86400) return `${Math.floor(total / 3600)} h ${String(Math.floor((total % 3600) / 60)).padStart(2, '0')}`;
    return `${Math.floor(total / 86400)} j ${String(Math.floor((total % 86400) / 3600)).padStart(2, '0')} h`;
  }

  async function remoteState(id) {
    try {
      const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { cache: 'no-store' });
      if (response.status === 404 || response.status === 410) return { missing: true };
      if (!response.ok) return { unknown: true };
      return await response.json();
    } catch {
      return { unknown: true };
    }
  }

  function renderCard(item, remote) {
    const missing = Boolean(remote && remote.missing);
    const badge = missing
      ? '<span class="badge expired">supprimé ou expiré</span>'
      : `<span class="badge ready">reste ${escapeHtml(formatRemaining(remote ? remote.secondsRemaining : 0))}</span>`;
    const codeChars = String(item.code || '')
      .split('')
      .map((char) => `<span>${escapeHtml(char)}</span>`)
      .join('');
    const size = (remote && remote.sizeHuman) || item.sizeHuman || '—';
    const expiryValue = (remote && remote.expiresAt) || item.expiresAt;
    const url = (remote && remote.shareUrl) || item.shareUrl || `${window.location.origin}/r/${item.id}`;

    return `
      <article class="transfer-card" data-id="${escapeHtml(item.id)}" data-expires="${escapeHtml(expiryValue || '')}">
        <div class="transfer-top">
          <div>
            <div class="transfer-title">${escapeHtml(item.fileName || (remote && remote.fileName) || item.id)}</div>
            <div class="transfer-sub">${escapeHtml(size)} · expire le ${escapeHtml(formatDate(expiryValue))}</div>
          </div>
          ${badge}
        </div>
        <div class="transfer-code" aria-label="Code du transfert">${codeChars}</div>
        <div class="share-link" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        ${
          missing
            ? ''
            : `<div class="countdown" data-countdown data-target="${escapeHtml(new Date(expiryValue).toISOString())}">
                 <span class="countdown-unit"><strong data-unit="days">0</strong><small>j</small></span>
                 <span class="countdown-unit"><strong data-unit="hours">00</strong><small>h</small></span>
                 <span class="countdown-unit"><strong data-unit="minutes">00</strong><small>min</small></span>
                 <span class="countdown-unit"><strong data-unit="seconds">00</strong><small>s</small></span>
               </div>`
        }
        <div class="transfer-actions">
          <button type="button" class="btn btn-small" data-action="copy" data-url="${escapeHtml(url)}">Copier le lien</button>
          <a class="btn btn-small btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir la page</a>
          ${missing ? '' : `<button type="button" class="btn btn-small btn-quiet" data-action="delete" data-id="${escapeHtml(item.id)}">Supprimer du serveur</button>`}
          <button type="button" class="btn btn-small btn-quiet" data-action="forget" data-id="${escapeHtml(item.id)}">Retirer de la liste</button>
        </div>
      </article>`;
  }

  async function render() {
    const transfers = readTransfers();
    stopCountdowns.forEach((stop) => stop());
    stopCountdowns = [];

    empty.hidden = transfers.length > 0;
    if (!transfers.length) {
      list.innerHTML = '';
      animateNumber(statCount, 0);
      animateNumber(statSize, 0);
      animateNumber(statExpired, 0);
      setStatus('Aucun transfert enregistré dans ce navigateur.');
      return;
    }

    setStatus('Vérification des statuts côté serveur…');
    list.innerHTML = '<p class="note">Chargement…</p>';

    const states = await Promise.all(transfers.map((item) => remoteState(item.id)));
    let activeBytes = 0;
    let expiredCount = 0;

    const cards = transfers.map((item, index) => {
      const remote = states[index];
      if (remote && remote.missing) expiredCount += 1;
      if (remote && !remote.missing && Number(remote.size)) activeBytes += Number(remote.size);
      return renderCard(item, remote);
    });

    list.innerHTML = cards.join('');
    list.querySelectorAll('[data-countdown]').forEach((element) => {
      stopCountdowns.push(startCountdown(element, element.dataset.target));
    });

    animateNumber(statCount, transfers.length);
    animateNumber(statSize, Math.round(activeBytes / 1024 / 1024), ' Mo');
    animateNumber(statExpired, expiredCount);
    setStatus(`${transfers.length} transfert${transfers.length > 1 ? 's' : ''} suivi${transfers.length > 1 ? 's' : ''} · ${expiredCount} expiré${expiredCount > 1 ? 's' : ''}.`, 'success');
  }

  async function removeFromServer(id, deleteKey) {
    if (!deleteKey) {
      setStatus('Clé de suppression absente : ce transfert a peut-être été créé sur un autre appareil.', 'error');
      return;
    }
    if (!window.confirm('Supprimer ce fichier du serveur maintenant ? Cette action est définitive.')) return;

    const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Delete-Key': deleteKey },
      body: JSON.stringify({ deleteKey })
    });
    if (!response.ok && response.status !== 404) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Suppression impossible.');
    }
    const transfers = readTransfers().filter((item) => item.id !== id);
    writeTransfers(transfers);
    toast('Transfert supprimé du serveur.');
    await render();
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const transfers = readTransfers();
    const item = transfers.find((entry) => entry.id === button.dataset.id);

    try {
      if (button.dataset.action === 'copy') {
        const ok = await copyText(button.dataset.url);
        toast(ok ? 'Lien copié.' : 'Copie impossible.', ok ? 'success' : 'error');
      }
      if (button.dataset.action === 'delete') {
        await removeFromServer(button.dataset.id, item && item.deleteKey);
      }
      if (button.dataset.action === 'forget') {
        writeTransfers(transfers.filter((entry) => entry.id !== button.dataset.id));
        toast('Retiré de la liste locale.');
        await render();
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  refreshButton.addEventListener('click', () => render());

  clearLocalButton.addEventListener('click', async () => {
    if (!window.confirm('Vider la liste locale ? Les fichiers déjà envoyés resteront sur le serveur jusqu’à leur expiration.')) return;
    writeTransfers([]);
    toast('Liste locale vidée.');
    await render();
  });

  render();
})();
