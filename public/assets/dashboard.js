(() => {
  const list = document.getElementById('transferList');
  const empty = document.getElementById('emptyDashboard');
  const status = document.getElementById('dashboardStatus');
  const countBadge = document.getElementById('countBadge');
  const refreshButton = document.getElementById('refreshButton');
  const clearLocalButton = document.getElementById('clearLocalButton');

  function readTransfers() {
    try {
      const value = localStorage.getItem('dropqr.transfers');
      return value ? JSON.parse(value) : [];
    } catch (_error) {
      return [];
    }
  }

  function writeTransfers(transfers) {
    localStorage.setItem('dropqr.transfers', JSON.stringify(transfers));
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatDate(value) {
    if (!value) return '—';
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function formatRemaining(seconds) {
    if (seconds <= 0) return 'expiré';
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.ceil(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.ceil(minutes / 60);
    if (hours < 24) return `${hours} h`;
    return `${Math.ceil(hours / 24)} j`;
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus('Lien copié.', 'success');
    } catch (_error) {
      window.prompt('Copie le lien:', text);
    }
  }

  async function deleteTransfer(id, deleteKey) {
    if (!deleteKey) {
      setStatus('Impossible de supprimer : clé locale absente.', 'error');
      return;
    }
    if (!confirm('Supprimer ce fichier du serveur maintenant ?')) return;

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
    setStatus('Transfert supprimé.', 'success');
    await render();
  }

  async function getRemoteStatus(id) {
    const response = await fetch(`/api/transfers/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (response.status === 404 || response.status === 410) return { missing: true, status: response.status };
    if (!response.ok) throw new Error('Statut indisponible');
    return response.json();
  }

  function renderCard(item, remote) {
    const missing = remote && remote.missing;
    const badgeClass = missing ? 'badge expired' : 'badge';
    const badgeText = missing ? 'supprimé / expiré' : `reste ${formatRemaining(remote.secondsRemaining || 0)}`;
    const downloads = missing ? '—' : String(remote.downloads || 0);
    const size = missing ? (item.sizeHuman || '—') : (remote.sizeHuman || item.sizeHuman || '—');
    const expiry = missing ? formatDate(item.expiresAt) : formatDate(remote.expiresAt);
    const url = item.shareUrl || (remote && remote.shareUrl) || `/t/${item.id}`;

    return `
      <article class="transfer-card" data-id="${escapeHtml(item.id)}">
        <div class="transfer-top">
          <div>
            <div class="transfer-title">${escapeHtml(item.fileName || remote.fileName || item.id)}</div>
            <div style="color:#94a3b8;font-size:13px;margin-top:4px">${escapeHtml(size)} · expire ${escapeHtml(expiry)} · téléchargements: ${escapeHtml(downloads)}</div>
          </div>
          <span class="${badgeClass}">${escapeHtml(badgeText)}</span>
        </div>
        <div class="share-link" title="${escapeHtml(url)}">${escapeHtml(url)}</div>
        <div class="transfer-actions">
          <a class="btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Ouvrir</a>
          <button class="btn" type="button" data-action="copy" data-url="${escapeHtml(url)}">Copier</button>
          <button class="btn" type="button" data-action="delete" data-id="${escapeHtml(item.id)}">Supprimer serveur</button>
          <button class="btn" type="button" data-action="forget" data-id="${escapeHtml(item.id)}">Retirer de la liste</button>
        </div>
      </article>`;
  }

  async function render() {
    const transfers = readTransfers();
    countBadge.textContent = `${transfers.length} lien${transfers.length > 1 ? 's' : ''}`;
    empty.classList.toggle('hidden', transfers.length > 0);
    list.innerHTML = '';

    if (!transfers.length) return;

    setStatus('Vérification des statuts…');
    const cards = [];
    for (const item of transfers) {
      try {
        const remote = await getRemoteStatus(item.id);
        cards.push(renderCard(item, remote));
      } catch (_error) {
        cards.push(renderCard(item, { missing: true }));
      }
    }
    list.innerHTML = cards.join('');
    setStatus('Statuts à jour.', 'success');
  }

  list.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const action = button.dataset.action;
    const id = button.dataset.id;
    const transfers = readTransfers();
    const item = transfers.find((entry) => entry.id === id);

    try {
      if (action === 'copy') {
        await copyText(button.dataset.url);
      }
      if (action === 'delete') {
        await deleteTransfer(id, item && item.deleteKey);
      }
      if (action === 'forget') {
        writeTransfers(transfers.filter((entry) => entry.id !== id));
        await render();
      }
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  refreshButton.addEventListener('click', render);
  clearLocalButton.addEventListener('click', async () => {
    if (!confirm('Nettoyer seulement la liste locale ? Les fichiers existants sur le serveur ne seront pas supprimés.')) return;
    writeTransfers([]);
    setStatus('Liste locale nettoyée.', 'success');
    await render();
  });

  render();
})();
