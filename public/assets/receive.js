'use strict';

/* DropQR — page Recevoir (v8)
   Recherche par code DropQR (mêmes routes API), présentée comme une scène
   de scan : cellules de code vivantes, balayage lumineux à la découverte,
   compte à rebours d'expiration en direct, carte de reprise en cas d'erreur.
   Les ids HTML partagés avec la version mobile sont conservés. */

const initReceivePage = () => {
  const form = document.getElementById('receiveForm');
  if (!form) return;
  // Ne jamais initialiser deux fois le même formulaire (navigation PJAX).
  if (form.dataset.dropqrInit === '1') return;
  form.dataset.dropqrInit = '1';

  const UI = window.DropQRUI || null;

  const input = document.getElementById('transferCode');
  const status = document.getElementById('receiveStatus');
  const result = document.getElementById('receiveResult');
  const resultCodeBadge = document.getElementById('resultCodeBadge');
  const receiveFileName = document.getElementById('receiveFileName');
  const receiveSize = document.getElementById('receiveSize');
  const receiveExpiry = document.getElementById('receiveExpiry');
  const receiveDownloads = document.getElementById('receiveDownloads');
  const receiveCleanup = document.getElementById('receiveCleanup');
  const downloadButton = document.getElementById('downloadButton');
  const copyReceiveLink = document.getElementById('copyReceiveLink');
  const receiveVideo = document.getElementById('receiveVideo');
  const cellsHost = document.getElementById('codeCells');
  const cellsField = document.getElementById('cellsField');
  const pasteBtn = document.getElementById('pasteCode');
  const errorCard = document.getElementById('receiveError');
  const errorTitle = document.getElementById('receiveErrorTitle');
  const errorBody = document.getElementById('receiveErrorBody');
  const retryBtn = document.getElementById('receiveRetry');
  const countdownEl = document.getElementById('receiveCountdown');
  const openQrNote = document.getElementById('openQrNote');

  let currentPayload = null;
  const CELLS = 7;

  function normalize(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  function showError(title, body) {
    if (!errorCard) { setStatus(body || title, 'error'); return; }
    errorCard.classList.remove('on');
    // reflow pour rejouer l'animation
    void errorCard.offsetWidth;
    if (errorTitle) errorTitle.textContent = title;
    if (errorBody) errorBody.textContent = body;
    errorCard.classList.add('on');
  }
  function hideError() {
    if (errorCard) errorCard.classList.remove('on');
  }

  /* Cellules : miroir visuel du champ réel */
  function syncCells() {
    if (!cellsHost) return;
    const value = String(input.value || '');
    const chars = cellsHost.querySelectorAll('b');
    const focusOn = document.activeElement === input;
    let caretAt = Math.min(value.length, chars.length - 1);
    chars.forEach((cell, i) => {
      const ch = value[i];
      cell.textContent = ch || '';
      cell.classList.toggle('filled', Boolean(ch));
      cell.classList.toggle('caret', focusOn && i === caretAt && !cell.classList.contains('filled'));
    });
    if (cellsField) cellsField.classList.toggle('focus', focusOn);
  }

  function extractCode(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value);
      const fromQuery = url.searchParams.get('code');
      if (fromQuery) return normalize(fromQuery);
      const match = url.pathname.match(/\/(?:c|code)\/([A-Za-z0-9-]+)/);
      if (match) return normalize(match[1]);
    } catch (_error) {}
    return normalize(value);
  }

  function formatDate(value) {
    return UI ? UI.formatDate(value) : new Date(value).toLocaleString('fr-FR');
  }

  function isVideo(payload) {
    return String((payload && payload.mimeType) || '').toLowerCase().startsWith('video/');
  }

  function hideVideo() {
    if (!receiveVideo) return;
    receiveVideo.pause();
    receiveVideo.removeAttribute('src');
    receiveVideo.load();
    receiveVideo.classList.add('hidden');
  }

  function setFoundUI() {
    if (!result) return;
    result.classList.remove('hidden');
    result.classList.remove('found');
    void result.offsetWidth;
    if (UI && !UI.reduced()) result.classList.add('found');
  }

  async function lookup(code, autoOpen = false) {
    const normalized = normalize(code);
    if (!normalized) {
      showError('Code incomplet', 'Entre le code à 7 caractères reçu par la personne qui envoie le fichier (lettres et chiffres — jamais I, O, 0 ni 1).');
      input.focus();
      return;
    }

    input.value = normalized;
    syncCells();
    hideError();
    result.classList.add('hidden');
    result.classList.remove('found');
    hideVideo();
    if (countdownEl) { delete countdownEl.dataset.expiry; countdownEl.classList.remove('expired', 'warn'); }
    setStatus('Balayage du signal…');
    if (downloadButton) downloadButton.classList.add('is-loading');

    try {
      const response = await fetch(`/api/codes/${encodeURIComponent(normalized)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) throw Object.assign(new Error('nope'), { kind: 'notfound' });
      if (response.status === 410) throw Object.assign(new Error('nope'), { kind: 'expired' });
      if (!response.ok) throw Object.assign(new Error(payload.error || `Erreur serveur HTTP ${response.status}.`), { kind: 'server' });

      currentPayload = payload;
      resultCodeBadge.textContent = payload.code || normalized;
      receiveFileName.textContent = payload.fileName;
      receiveSize.textContent = payload.sizeHuman;
      receiveExpiry.textContent = formatDate(payload.expiresAt);
      receiveDownloads.textContent = String(payload.downloads || 0);
      receiveCleanup.textContent = payload.deleteAfterDownload ? 'Après téléchargement' : 'À expiration';
      if (downloadButton) {
        downloadButton.href = payload.downloadUrl;
        downloadButton.classList.remove('is-loading');
      }
      if (copyReceiveLink) copyReceiveLink.dataset.url = payload.shareUrl;
      if (countdownEl) {
        countdownEl.dataset.expiry = payload.expiresAt || '';
        delete countdownEl.dataset.dqFired;
      }
      if (openQrNote) openQrNote.hidden = !(response.status === 200 && autoOpen);

      if (isVideo(payload) && payload.previewUrl && receiveVideo) {
        receiveVideo.src = payload.previewUrl;
        receiveVideo.classList.remove('hidden');
        downloadButton.textContent = UI ? 'Télécharger la vidéo' : 'Télécharger la vidéo';
      } else {
        hideVideo();
        downloadButton.textContent = 'Télécharger';
      }

      setFoundUI();
      setStatus(autoOpen ? 'QR reconnu — le passage est ouvert.' : 'Fichier trouvé.', 'success');
      if (UI) UI.toast('Transfert trouvé.');
    } catch (error) {
      currentPayload = null;
      hideVideo();
      if (downloadButton) downloadButton.classList.remove('is-loading');
      if (error.kind === 'notfound') {
        showError('Aucun passage avec ce code', 'Le fichier a peut-être déjà été téléchargé, ou son délai est écoulé. Rappel : un code DropQR ne contient jamais les lettres I et O ni les chiffres 0 et 1 — en cas de doute, redemande le code à l’expéditeur.');
        setStatus('Code introuvable.', 'error');
      } else if (error.kind === 'expired') {
        showError('Transfert expiré', 'Ce fichier a été supprimé automatiquement après son expiration ou son premier téléchargement. Demande à l’expéditeur de créer un nouveau passage.');
        setStatus('Ce transfert a expiré.', 'error');
      } else {
        showError('Le serveur n’a pas répondu', `${error.message} Rien n’est perdu : réessaie dans quelques secondes.`);
        setStatus(error.message, 'error');
      }
    }
  }

  input.addEventListener('input', () => {
    const selection = input.selectionStart;
    input.value = normalize(input.value);
    input.setSelectionRange(selection, selection);
    hideError();
    syncCells();
  });
  input.addEventListener('focus', syncCells);
  input.addEventListener('blur', syncCells);
  input.addEventListener('paste', (event) => {
    const text = event.clipboardData && event.clipboardData.getData('text');
    if (!text) return;
    const code = extractCode(text);
    if (code && (code.length !== text.trim().length || /[/:?]/.test(text))) {
      event.preventDefault();
      input.value = code;
      syncCells();
    }
  });

  if (retryBtn) retryBtn.addEventListener('click', () => { input.focus(); input.select(); });

  // Partage natif (desktop Chromium/Safari récents ; masqué sinon, mobile.js
  // reprend le même bouton sur la version téléphone).
  const shareBtn = document.getElementById('shareReceiveLink');
  if (shareBtn && typeof navigator.share === 'function') {
    shareBtn.classList.remove('hidden');
    shareBtn.addEventListener('click', async () => {
      const url = (copyReceiveLink && copyReceiveLink.dataset.url) || (currentPayload && currentPayload.shareUrl);
      if (!url) return;
      try {
        await navigator.share({ title: 'DropQR', text: 'Fichier à récupérer — DropQR', url });
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        await (UI ? UI.copy(url, 'Lien copié.') : Promise.resolve());
      }
    });
  }
  if (pasteBtn) {
    if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      pasteBtn.classList.remove('hidden');
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          const code = extractCode(text);
          if (!code) return;
          input.value = code;
          syncCells();
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable: true }));
        } catch (_error) {
          input.focus();
          if (UI) UI.toast('Autorise le presse-papiers, ou colle avec Ctrl+V.', { type: 'error' });
        }
      });
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await lookup(input.value);
  });

  if (copyReceiveLink) {
    copyReceiveLink.addEventListener('click', async () => {
      const url = copyReceiveLink.dataset.url || (currentPayload && currentPayload.shareUrl);
      if (!url) return;
      const done = UI ? await UI.copy(url, 'Lien copié.') : null;
      if (done === null) {
        try { await navigator.clipboard.writeText(url); } catch (_error) { window.prompt('Copie le lien:', url); }
      }
      flash(copyReceiveLink, 'Copié');
    });
  }
  function flash(button, label) {
    const original = button.textContent;
    button.textContent = label;
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  if (countdownEl) {
    countdownEl.addEventListener('dq:expired', () => {
      setStatus('Le transfert vient d’expirer : le fichier n’est plus disponible.', 'error');
      downloadButton.classList.add('is-loading');
    });
  }

  // Les cellules existent ? sinon on masque le composant (ancienne page mobile).
  if (cellsHost) {
    for (let i = 0; i < CELLS; i += 1) cellsHost.appendChild(document.createElement('b'));
  }
  syncCells();

  const params = new URLSearchParams(window.location.search);
  const code = normalize(params.get('code'));
  if (code) lookup(code, true);
  else if (input && UI && !UI.reduced() && window.matchMedia('(hover: hover)').matches) setTimeout(() => { if (!currentPayload && !input.value) input.focus(); }, 600);
};
initReceivePage();
window.addEventListener('pjax:load', initReceivePage);
