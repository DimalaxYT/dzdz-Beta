(() => {
  let chunkSize = 8 * 1024 * 1024;
  let uploadConcurrency = 5;

  const form = document.getElementById('uploadForm');
  const fileInput = document.getElementById('fileInput');
  const dropzone = document.getElementById('dropzone');
  const dropTitle = document.getElementById('dropTitle');
  const dropSubtitle = document.getElementById('dropSubtitle');
  const sendButton = document.getElementById('sendButton');
  const status = document.getElementById('status');
  const result = document.getElementById('result');
  const emptyState = document.getElementById('emptyState');
  const qrImage = document.getElementById('qrImage');
  const resultName = document.getElementById('resultName');
  const resultCode = document.getElementById('resultCode');
  const resultDiscord = document.getElementById('resultDiscord');
  const resultSize = document.getElementById('resultSize');
  const resultExpiry = document.getElementById('resultExpiry');
  const resultCleanup = document.getElementById('resultCleanup');
  const shareLink = document.getElementById('shareLink');
  const copyButton = document.getElementById('copyButton');
  const openLink = document.getElementById('openLink');
  const newTransfer = document.getElementById('newTransfer');
  const deleteAfterDownload = document.getElementById('deleteAfterDownload');
  const ttlMinutes = document.getElementById('ttlMinutes');
  const fileChip = document.getElementById('fileChip');
  const fileChipName = document.getElementById('fileChipName');
  const fileChipSize = document.getElementById('fileChipSize');
  const clearFile = document.getElementById('clearFile');
  const progressPanel = document.getElementById('progressPanel');
  const progressLabel = document.getElementById('progressLabel');
  const progressPercent = document.getElementById('progressPercent');
  const progressBar = document.getElementById('progressBar');
  const progressTrack = document.querySelector('.progress-track');
  const progressLoaded = document.getElementById('progressLoaded');
  const progressSpeed = document.getElementById('progressSpeed');
  const sandboxWarning = document.getElementById('sandboxWarning');
  const configNotice = document.getElementById('configNotice');

  let backendReachable = true;
  let chunkedUploadAvailable = true;
  let uploadInProgress = false;
  let currentUploadToken = null;
  let activeRequests = new Set();

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value < 1024) return `${value} o`;
    const units = ['Ko', 'Mo', 'Go', 'To'];
    let size = value / 1024;
    let unit = units[0];
    for (let i = 0; i < units.length; i += 1) {
      unit = units[i];
      if (size < 1024 || i === units.length - 1) break;
      size /= 1024;
    }
    return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  function setProgress(percent, loaded = 0, total = 0, detail = '') {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
    progressPanel.classList.add('visible');
    progressBar.style.width = `${safePercent}%`;
    progressPercent.textContent = `${safePercent}%`;
    progressTrack.setAttribute('aria-valuenow', String(safePercent));
    progressLoaded.textContent = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)} envoyés`;
    progressSpeed.textContent = detail || 'Upload en cours…';
  }

  function resetProgress() {
    progressLabel.textContent = 'Upload en cours';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    progressTrack.setAttribute('aria-valuenow', '0');
    progressLoaded.textContent = '0 o / 0 o';
    progressSpeed.textContent = 'Préparation…';
    progressPanel.classList.remove('visible');
  }

  function makeUploadId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID().replace(/-/g, '');
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }

  function updateFileLabel() {
    const file = fileInput.files[0];
    sendButton.disabled = !file || uploadInProgress;

    if (!file) {
      dropTitle.textContent = 'Dépose ton fichier ici';
      dropSubtitle.textContent = 'ou clique pour le choisir. Un seul fichier par transfert.';
      fileChip.classList.remove('visible');
      return;
    }

    const chunks = Math.max(1, Math.ceil(file.size / chunkSize));
    dropTitle.textContent = file.name;
    dropSubtitle.textContent = `${formatBytes(file.size)} · envoi rapide en ${chunks} morceau${chunks > 1 ? 'x' : ''}`;
    fileChipName.textContent = file.name;
    fileChipSize.textContent = `${formatBytes(file.size)} · ${uploadConcurrency} envois parallèles · morceaux de ${formatBytes(chunkSize)}`;
    fileChip.classList.add('visible');
  }

  function clearSelectedFile() {
    if (uploadInProgress) return;
    fileInput.value = '';
    updateFileLabel();
    setStatus('');
    resetProgress();
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/config', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const config = await response.json();
      backendReachable = true;
      chunkedUploadAvailable = config.chunkedUpload === true;
      if (Number(config.recommendedChunkSizeBytes) > 0) chunkSize = Number(config.recommendedChunkSizeBytes);
      if (Number(config.uploadConcurrency) > 0) uploadConcurrency = Math.min(8, Math.max(1, Number(config.uploadConcurrency)));

      if (!chunkedUploadAvailable) {
        configNotice.classList.remove('hidden');
        configNotice.innerHTML = `<strong>Backend ancien détecté.</strong> Redéploie la dernière version et vérifie que <code>/api/health</code> affiche <code>version: 1.7.0</code>.`;
      }
      if (config.sandboxWarning) {
        configNotice.classList.remove('hidden');
        configNotice.innerHTML = `<strong>Preview Arena détectée.</strong> Pour un vrai test mobile, utilise ton URL Railway ou Render.`;
      }
    } catch (error) {
      backendReachable = false;
      chunkedUploadAvailable = false;
      configNotice.classList.remove('hidden');
      configNotice.innerHTML = `<strong>Backend API indisponible.</strong> L’upload ne peut pas fonctionner sur un déploiement statique.`;
      console.warn('DropQR backend unavailable:', error);
    } finally {
      updateFileLabel();
    }
  }

  function uploadErrorMessage(xhr, payload) {
    if (payload && payload.error) return payload.error;
    if (xhr.status === 0) return 'Le navigateur n’arrive pas à joindre le backend. Vérifie l’URL de déploiement et HTTPS.';
    if (xhr.status === 400) return 'Requête refusée. Vérifie les logs backend Railway.';
    if (xhr.status === 404) return 'Route backend introuvable. Redéploie le dernier ZIP comme application Node.js.';
    if (xhr.status === 413) return 'Morceau refusé par la plateforme. Baisse CHUNK_SIZE_MB à 4 dans les variables Railway.';
    if (xhr.status >= 500) return `Erreur serveur ${xhr.status}. Regarde les logs du déploiement.`;
    return `Upload impossible. Réponse serveur HTTP ${xhr.status}.`;
  }

  function sumProgress(progress) {
    return progress.reduce((sum, value) => sum + value, 0);
  }

  function sendChunk({ file, uploadId, chunkIndex, totalChunks, progress, startedAt, token }) {
    return new Promise((resolve, reject) => {
      const start = chunkIndex * chunkSize;
      const end = Math.min(file.size, start + chunkSize);
      const blob = file.slice(start, end);
      const body = new FormData();
      body.append('uploadId', uploadId);
      body.append('chunkIndex', String(chunkIndex));
      body.append('totalChunks', String(totalChunks));
      body.append('totalSize', String(file.size));
      body.append('fileName', file.name);
      body.append('mimeType', file.type || 'application/octet-stream');
      body.append('ttlMinutes', ttlMinutes.value);
      body.append('deleteAfterDownload', deleteAfterDownload.checked ? 'true' : 'false');
      body.append('autoFinalize', 'false');
      body.append('chunk', blob, `${file.name}.part${chunkIndex}`);

      const xhr = new XMLHttpRequest();
      activeRequests.add(xhr);
      xhr.open('POST', '/api/transfers/chunk');
      xhr.responseType = 'text';

      xhr.upload.onprogress = (event) => {
        if (token !== currentUploadToken || !event.lengthComputable) return;
        progress[chunkIndex] = event.loaded;
        const totalLoaded = Math.min(sumProgress(progress), file.size);
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.1);
        const speed = totalLoaded / elapsedSeconds;
        const remainingBytes = Math.max(file.size - totalLoaded, 0);
        const remainingSeconds = speed > 0 ? remainingBytes / speed : 0;
        const eta = remainingSeconds > 1 ? ` · reste ~${Math.ceil(remainingSeconds)} s` : '';
        setProgress((totalLoaded / file.size) * 100, totalLoaded, file.size, `${uploadConcurrency} flux · ${formatBytes(speed)}/s${eta}`);
      };

      xhr.onerror = () => reject(new Error('Erreur réseau pendant l’envoi d’un morceau.'));
      xhr.onload = () => {
        activeRequests.delete(xhr);
        let payload = {};
        try { payload = JSON.parse(xhr.responseText || '{}'); }
        catch (_error) { payload = {}; }

        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new Error(uploadErrorMessage(xhr, payload));
          error.status = xhr.status;
          reject(error);
          return;
        }
        progress[chunkIndex] = end - start;
        resolve(payload);
      };
      xhr.onabort = () => reject(new Error('Upload annulé.'));
      xhr.send(body);
    });
  }

  async function completeUpload(uploadId, file) {
    progressLabel.textContent = 'Finalisation';
    setProgress(100, file.size, file.size, 'Assemblage du fichier sur le serveur…');
    const response = await fetch('/api/transfers/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Finalisation impossible HTTP ${response.status}.`);
    return payload;
  }

  function uploadClassic(file) {
    return new Promise((resolve, reject) => {
      const body = new FormData();
      body.append('file', file);
      body.append('ttlMinutes', ttlMinutes.value);
      body.append('deleteAfterDownload', deleteAfterDownload.checked ? 'true' : 'false');

      const xhr = new XMLHttpRequest();
      activeRequests.add(xhr);
      const startedAt = performance.now();
      xhr.open('POST', '/api/transfers');
      xhr.responseType = 'text';

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const elapsedSeconds = Math.max((performance.now() - startedAt) / 1000, 0.1);
        const speed = event.loaded / elapsedSeconds;
        setProgress((event.loaded / event.total) * 100, event.loaded, event.total, `Mode classique · ${formatBytes(speed)}/s`);
      };

      xhr.onerror = () => reject(new Error('Erreur réseau pendant l’upload.'));
      xhr.onload = () => {
        activeRequests.delete(xhr);
        let payload = {};
        try { payload = JSON.parse(xhr.responseText || '{}'); }
        catch (_error) { payload = {}; }
        if (xhr.status < 200 || xhr.status >= 300) {
          const error = new Error(uploadErrorMessage(xhr, payload));
          error.status = xhr.status;
          reject(error);
          return;
        }
        resolve(payload);
      };
      xhr.send(body);
    });
  }

  async function uploadFileInChunks(file) {
    const uploadId = makeUploadId();
    const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
    const startedAt = performance.now();
    const token = makeUploadId();
    currentUploadToken = token;
    const progress = new Array(totalChunks).fill(0);
    let nextIndex = 0;
    let completed = 0;

    progressLabel.textContent = 'Upload rapide';
    setProgress(0, 0, file.size, `${totalChunks} morceaux · ${uploadConcurrency} envois parallèles`);

    async function worker() {
      while (nextIndex < totalChunks) {
        if (currentUploadToken !== token) throw new Error('Upload annulé.');
        const chunkIndex = nextIndex;
        nextIndex += 1;
        await sendChunk({ file, uploadId, chunkIndex, totalChunks, progress, startedAt, token });
        completed += 1;
        progressLabel.textContent = `Upload rapide · ${completed}/${totalChunks}`;
      }
    }

    const workers = Array.from({ length: Math.min(uploadConcurrency, totalChunks) }, () => worker());
    await Promise.all(workers);
    setProgress(100, file.size, file.size, 'Tous les morceaux sont envoyés.');
    return completeUpload(uploadId, file);
  }

  function showResult(payload, file) {
    setProgress(100, file.size, file.size, 'QR code généré');
    progressLabel.textContent = 'Upload terminé';
    const expiry = new Date(payload.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
    qrImage.src = payload.qrDataUrl;
    resultName.textContent = payload.fileName;
    resultCode.textContent = payload.code || payload.id;
    resultDiscord.textContent = payload.discord && payload.discord.sent ? 'Envoyé' : (payload.discordConfigured ? 'Non envoyé' : 'Non configuré');
    resultSize.textContent = payload.sizeHuman || formatBytes(payload.size);
    resultExpiry.textContent = expiry;
    resultCleanup.textContent = payload.deleteAfterDownload ? 'Après le premier téléchargement' : 'À expiration';
    shareLink.textContent = payload.shareUrl;
    shareLink.title = payload.shareUrl;
    copyButton.dataset.url = payload.shareUrl;
    openLink.href = payload.shareUrl;

    if (payload.sandboxWarning) {
      sandboxWarning.classList.remove('hidden');
      sandboxWarning.textContent = payload.sandboxWarning;
    }

    emptyState.style.display = 'none';
    result.classList.add('visible');
    setStatus('C’est prêt. Le code et le QR peuvent être partagés.', 'success');
  }

  fileInput.addEventListener('change', updateFileLabel);
  clearFile.addEventListener('click', clearSelectedFile);

  ['dragenter', 'dragover'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!uploadInProgress) dropzone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragover');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer.files[0];
    if (!file || uploadInProgress) return;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    updateFileLabel();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file || uploadInProgress) return;

    result.classList.remove('visible');
    sandboxWarning.classList.add('hidden');
    emptyState.style.display = 'grid';
    setStatus('Upload en cours… garde cette page ouverte.');
    uploadInProgress = true;
    sendButton.disabled = true;
    clearFile.disabled = true;
    progressLabel.textContent = 'Préparation';
    setProgress(0, 0, file.size, `Préparation des morceaux de ${formatBytes(chunkSize)}…`);

    try {
      let payload;
      if (!backendReachable) throw new Error('Backend API indisponible sur ce domaine.');
      if (chunkedUploadAvailable) {
        payload = await uploadFileInChunks(file);
      } else if (file.size <= 40 * 1024 * 1024) {
        progressLabel.textContent = 'Upload classique';
        payload = await uploadClassic(file);
      } else {
        throw new Error('Backend déployé pas à jour. Redéploie la dernière version.');
      }
      showResult(payload, file);
    } catch (error) {
      setStatus(error.message || 'Upload impossible.', 'error');
      progressLabel.textContent = 'Upload interrompu';
      progressSpeed.textContent = backendReachable ? 'Le fichier n’a pas été enregistré.' : 'Backend API non détecté.';
    } finally {
      activeRequests.forEach((xhr) => { try { xhr.abort(); } catch (_error) {} });
      activeRequests = new Set();
      uploadInProgress = false;
      currentUploadToken = null;
      clearFile.disabled = false;
      sendButton.disabled = !fileInput.files[0];
    }
  });

  copyButton.addEventListener('click', async () => {
    const url = copyButton.dataset.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      copyButton.textContent = 'Copié';
      setTimeout(() => { copyButton.textContent = 'Copier'; }, 1400);
    } catch (_error) {
      window.prompt('Copie le lien:', url);
    }
  });

  newTransfer.addEventListener('click', () => {
    if (uploadInProgress) return;
    result.classList.remove('visible');
    emptyState.style.display = 'grid';
    clearSelectedFile();
    fileInput.focus();
  });

  updateFileLabel();
  resetProgress();
  loadConfig();
})();
