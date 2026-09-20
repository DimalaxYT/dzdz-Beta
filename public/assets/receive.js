(() => {
  const form = document.getElementById('receiveForm');
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

  let currentPayload = null;

  function normalize(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  function formatDate(value) {
    return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
  }

  function isVideo(payload) {
    return String(payload && payload.mimeType || '').toLowerCase().startsWith('video/');
  }

  function hideVideo() {
    if (!receiveVideo) return;
    receiveVideo.pause();
    receiveVideo.removeAttribute('src');
    receiveVideo.load();
    receiveVideo.classList.add('hidden');
  }

  async function lookup(code, autoOpen = false) {
    const normalized = normalize(code);
    if (!normalized) return;

    input.value = normalized;
    result.classList.add('hidden');
    hideVideo();
    setStatus('Recherche du fichier…');

    try {
      const response = await fetch(`/api/codes/${encodeURIComponent(normalized)}`, { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) throw new Error('Code introuvable. Vérifie les caractères puis réessaie.');
      if (response.status === 410) throw new Error('Ce transfert a expiré ou a déjà été supprimé.');
      if (!response.ok) throw new Error(payload.error || `Erreur serveur HTTP ${response.status}.`);

      currentPayload = payload;
      resultCodeBadge.textContent = payload.code || normalized;
      receiveFileName.textContent = payload.fileName;
      receiveSize.textContent = payload.sizeHuman;
      receiveExpiry.textContent = formatDate(payload.expiresAt);
      receiveDownloads.textContent = String(payload.downloads || 0);
      receiveCleanup.textContent = payload.deleteAfterDownload ? 'Après téléchargement' : 'À expiration';
      downloadButton.href = payload.downloadUrl;
      copyReceiveLink.dataset.url = payload.shareUrl;

      if (isVideo(payload) && payload.previewUrl && receiveVideo) {
        receiveVideo.src = payload.previewUrl;
        receiveVideo.classList.remove('hidden');
        downloadButton.textContent = 'Télécharger la vidéo';
      } else {
        hideVideo();
        downloadButton.textContent = 'Télécharger';
      }

      result.classList.remove('hidden');
      setStatus(autoOpen ? 'QR code reconnu. Tu peux lire ou télécharger.' : 'Fichier trouvé.', 'success');
    } catch (error) {
      currentPayload = null;
      hideVideo();
      setStatus(error.message, 'error');
    }
  }

  input.addEventListener('input', () => {
    const selection = input.selectionStart;
    input.value = normalize(input.value);
    input.setSelectionRange(selection, selection);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await lookup(input.value);
  });

  copyReceiveLink.addEventListener('click', async () => {
    const url = copyReceiveLink.dataset.url || (currentPayload && currentPayload.shareUrl);
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyReceiveLink.textContent = 'Copié';
      setTimeout(() => { copyReceiveLink.textContent = 'Copier le lien'; }, 1400);
    } catch (_error) {
      window.prompt('Copie le lien:', url);
    }
  });

  const params = new URLSearchParams(window.location.search);
  const code = normalize(params.get('code'));
  if (code) lookup(code, true);
})();
