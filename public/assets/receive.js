/* ==========================================================================
   DropQR — page de réception
   Saisie du code à sept cases, recherche, lecture directe des médias et
   compte à rebours avant suppression.
   ========================================================================== */

(() => {
  'use strict';

  const { buildCodeSlots, startCountdown, formatDate, copyText, toast } = window.DropQR;

  const form = document.getElementById('receiveForm');
  const codeSlotsHost = document.getElementById('codeSlots');
  const hiddenInput = document.getElementById('transferCode');
  const status = document.getElementById('receiveStatus');
  const statusChip = document.getElementById('receiveStatusChip');
  const result = document.getElementById('receiveResult');
  const resultCodeBadge = document.getElementById('resultCodeBadge');
  const fileName = document.getElementById('receiveFileName');
  const size = document.getElementById('receiveSize');
  const expiry = document.getElementById('receiveExpiry');
  const downloads = document.getElementById('receiveDownloads');
  const cleanup = document.getElementById('receiveCleanup');
  const mediaHolder = document.getElementById('mediaHolder');
  const downloadButton = document.getElementById('downloadButton');
  const copyReceiveLink = document.getElementById('copyReceiveLink');

  let stopCountdown = null;
  let current = null;

  const slots = buildCodeSlots(codeSlotsHost, {
    length: 7,
    onChange(value) {
      hiddenInput.value = value;
      statusChip.textContent = value.length === 7 ? 'prêt à chercher' : 'en attente';
      statusChip.className = `chip ${value.length === 7 ? 'chip-jade' : 'chip-soft'}`;
    },
    onComplete(value) {
      lookup(value);
    }
  });

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message || '';
  }

  function clearMedia() {
    mediaHolder.hidden = true;
    mediaHolder.innerHTML = '';
  }

  function renderMedia(payload) {
    clearMedia();
    const type = String(payload.mimeType || '').toLowerCase();
    const src = payload.previewUrl;
    if (payload.canPreview && type.startsWith('video/')) {
      mediaHolder.innerHTML = `<video class="media" controls playsinline preload="metadata" src="${src}"></video>`;
      mediaHolder.hidden = false;
      return;
    }
    if (payload.canPreview && type.startsWith('audio/')) {
      mediaHolder.innerHTML = `<audio class="media media-audio" controls preload="metadata" src="${src}"></audio>`;
      mediaHolder.hidden = false;
      return;
    }
    if (payload.inlineSafe && type.startsWith('image/')) {
      mediaHolder.innerHTML = `<img class="media media-image" src="${src}" alt="${window.DropQR.escapeHtml(payload.fileName)}">`;
      mediaHolder.hidden = false;
    }
  }

  async function lookup(code) {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (normalized.length < 4) {
      setStatus('Un code comporte sept caractères.', 'error');
      return;
    }

    result.hidden = true;
    clearMedia();
    setStatus('Recherche du fichier…');
    statusChip.textContent = 'recherche…';
    statusChip.className = 'chip chip-soft';

    try {
      const response = await fetch(`/api/codes/${encodeURIComponent(normalized)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) throw new Error('Code introuvable. Vérifie les caractères, ou demande un nouveau code.');
      if (response.status === 410) throw new Error('Ce transfert a expiré ou le fichier a déjà été supprimé.');
      if (!response.ok) throw new Error(payload.error || `Erreur serveur HTTP ${response.status}.`);

      current = payload;
      resultCodeBadge.textContent = payload.code;
      fileName.textContent = payload.fileName;
      size.textContent = payload.sizeHuman;
      expiry.textContent = formatDate(payload.expiresAt);
      downloads.textContent = String(payload.downloads || 0);
      cleanup.textContent = payload.deleteAfterDownload ? 'Après téléchargement' : 'À l’expiration';
      downloadButton.href = payload.downloadUrl;
      downloadButton.textContent = payload.canPreview ? 'Télécharger le fichier' : 'Télécharger';
      copyReceiveLink.dataset.copy = payload.shareUrl;

      if (stopCountdown) stopCountdown();
      stopCountdown = startCountdown(result.querySelector('[data-countdown]'), payload.expiresAt);

      renderMedia(payload);
      result.hidden = false;
      statusChip.textContent = 'fichier trouvé';
      statusChip.className = 'chip chip-jade';
      setStatus('Fichier trouvé. Tu peux le lire ou le télécharger.', 'success');
    } catch (error) {
      current = null;
      setStatus(error.message, 'error');
      statusChip.textContent = 'introuvable';
      statusChip.className = 'chip chip-soft';
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    lookup(slots.get());
  });

  copyReceiveLink.addEventListener('click', async () => {
    if (!current) return;
    const ok = await copyText(current.shareUrl);
    toast(ok ? 'Lien copié.' : 'Copie impossible.', ok ? 'success' : 'error');
  });

  const params = new URLSearchParams(window.location.search);
  const preset = params.get('code');
  if (preset) {
    slots.set(preset);
    lookup(preset);
  } else {
    slots.focus();
  }
})();
