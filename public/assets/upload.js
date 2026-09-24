'use strict';

const initUploadPage = () => {
  const form = document.getElementById('uploadForm');
  if (!form) return;
  // Ne jamais initialiser deux fois le même formulaire (double appel possible
  // après une navigation PJAX: script injecté + événement pjax:load).
  if (form.dataset.dropqrInit === '1') return;
  form.dataset.dropqrInit = '1';

  let chunkSize = 8 * 1024 * 1024;
  let uploadConcurrency = 5;
  let maxFileSizeBytes = null;
  let maxFileSizeHuman = '';

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
  const deleteTransferBtn = document.getElementById('deleteTransferBtn');
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
  let currentPayload = null;
  let currentDeleteKey = null;

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

  const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

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
    const tooLarge = Boolean(file && maxFileSizeBytes && file.size > maxFileSizeBytes);
    sendButton.disabled = !file || uploadInProgress || tooLarge;

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
    if (tooLarge) {
      dropSubtitle.textContent = `Fichier trop volumineux. Limite actuelle : ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}.`;
      setStatus(`Ce fichier dépasse la limite de ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}.`, 'error');
    }
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
      // L'envoi par morceaux exige maintenant la session init côté serveur.
      chunkedUploadAvailable = config.chunkedUpload === true && config.chunkInit === true;
      if (Number(config.maxFileSizeBytes) > 0) {
        maxFileSizeBytes = Number(config.maxFileSizeBytes);
        maxFileSizeHuman = config.maxFileSizeHuman || formatBytes(maxFileSizeBytes);
      } else {
        maxFileSizeBytes = null;
        maxFileSizeHuman = config.maxFileSizeHuman || '';
      }
      if (Number(config.recommendedChunkSizeBytes) > 0) chunkSize = Number(config.recommendedChunkSizeBytes);
      if (Number(config.uploadConcurrency) > 0) uploadConcurrency = Math.min(8, Math.max(1, Number(config.uploadConcurrency)));

      const notices = [];
      if (!chunkedUploadAvailable) {
        notices.push('<strong>Backend ancien détecté.</strong> Redéploie la dernière version et vérifie que <code>/api/health</code> affiche <code>version: 1.11.0</code> et <code>chunkInit: true</code>.');
      }
      if (config.sandboxWarning) {
        notices.push('<strong>Preview Arena détectée.</strong> Pour un vrai test mobile, utilise ton URL Railway ou Render.');
      }
      if (notices.length) {
        configNotice.classList.remove('hidden');
        configNotice.innerHTML = notices.join('<br>');
      }
    } catch (error) {
      backendReachable = false;
      chunkedUploadAvailable = false;
      configNotice.classList.remove('hidden');
      configNotice.innerHTML = '<strong>Backend API indisponible.</strong> L’upload ne peut pas fonctionner sur un déploiement statique.';
      console.warn('DropQR backend unavailable:', error);
    } finally {
      updateFileLabel();
    }
  }

  function uploadErrorMessage(xhr, payload) {
    if (payload && payload.error) return payload.error;
    if (xhr.status === 0) return 'Le navigateur n’arrive pas à joindre le backend. Vérifie l’URL de déploiement et HTTPS.';
    if (xhr.status === 400) return 'Requête refusée. Vérifie les logs backend.';
    if (xhr.status === 404) return 'Route backend introuvable. Redéploie la dernière version comme application Node.js.';
    if (xhr.status === 413) return 'Morceau refusé par la plateforme. Baisse CHUNK_SIZE_MB à 4 dans les variables de déploiement.';
    if (xhr.status === 429) return 'Trop de requêtes vers le serveur. Réessaie dans un instant.';
    if (xhr.status >= 500) return `Erreur serveur ${xhr.status}. Regarde les logs du déploiement.`;
    return `Upload impossible. Réponse serveur HTTP ${xhr.status}.`;
  }

  function makeRequestError(xhr, payload) {
    const error = new Error(uploadErrorMessage(xhr, payload));
    error.status = xhr.status;
    const retryAfter = Number(xhr.getResponseHeader('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = retryAfter * 1000;
    return error;
  }

  function isRetryable(error) {
    if (error.retryable === false) return false;
    return error.status === 0 || error.status === 429 || (Number(error.status) >= 500 && Number(error.status) < 600);
  }

  function retryDelayMs(error, attempt) {
    if (error.retryAfterMs) return Math.min(error.retryAfterMs, 30000);
    return Math.min(1000 * (2 ** (attempt - 1)) + Math.random() * 400, 8000);
  }

  function sumProgress(progress) {
    return progress.reduce((sum, value) => sum + value, 0);
  }

  async function initChunkSession(file) {
    const response = await fetch('/api/transfers/chunk/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName: file.name,
        mimeType: file.type || 'application/octet-stream',
        totalSize: file.size,
        chunkSize,
        ttlMinutes: Number(ttlMinutes.value),
        deleteAfterDownload: deleteAfterDownload.checked
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Initialisation de l’upload impossible HTTP ${response.status}.`);
      error.status = response.status;
      error.isInitError = true;
      throw error;
    }
    return payload; // { uploadId, uploadSecret, chunkSize, totalChunks }
  }

  function sendChunk({ file, session, chunkIndex, progress, startedAt, token }) {
    return new Promise((resolve, reject) => {
      const start = chunkIndex * session.chunkSize;
      const end = Math.min(file.size, start + session.chunkSize);
      const blob = file.slice(start, end);
      const body = new FormData();
      // Les champs texte sont placés AVANT le fichier pour que Multer les lise
      // systématiquement, même en cas d'erreur de taille.
      body.append('uploadId', session.uploadId);
      body.append('uploadSecret', session.uploadSecret);
      body.append('chunkIndex', String(chunkIndex));
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

      xhr.onerror = () => {
        activeRequests.delete(xhr);
        const error = new Error('Erreur réseau pendant l’envoi d’un morceau.');
        error.status = 0;
        reject(error);
      };
      xhr.onload = () => {
        activeRequests.delete(xhr);
        let payload = {};
        try { payload = JSON.parse(xhr.responseText || '{}'); }
        catch (_error) { payload = {}; }

        if (xhr.status < 200 || xhr.status >= 300) {
          reject(makeRequestError(xhr, payload));
          return;
        }
        progress[chunkIndex] = end - start;
        resolve(payload);
      };
      xhr.onabort = () => {
        activeRequests.delete(xhr);
        const error = new Error('Upload annulé.');
        error.retryable = false;
        reject(error);
      };
      xhr.send(body);
    });
  }

  async function sendChunkWithRetry(args) {
    const maxAttempts = 4;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (args.token !== currentUploadToken) throw new Error('Upload annulé.');
      try {
        return await sendChunk(args);
      } catch (error) {
        if (attempt === maxAttempts || !isRetryable(error) || args.token !== currentUploadToken) throw error;
        // Le morceau repart de zéro: on remet son compteur de progression à zéro.
        args.progress[args.chunkIndex] = 0;
        const delay = retryDelayMs(error, attempt);
        progressSpeed.textContent = error.status === 429
          ? `Limite serveur atteinte · nouvelle tentative dans ${Math.ceil(delay / 1000)} s`
          : `Connexion instable · nouvelle tentative ${attempt}/${maxAttempts - 1} dans ${Math.ceil(delay / 1000)} s`;
        await sleep(delay);
      }
    }
    throw new Error('Upload interrompu.');
  }

  async function completeUpload(session, file) {
    progressLabel.textContent = 'Finalisation';
    setProgress(100, file.size, file.size, 'Assemblage du fichier sur le serveur…');
    const response = await fetch('/api/transfers/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: session.uploadId, uploadSecret: session.uploadSecret })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Finalisation impossible HTTP ${response.status}.`);
    return payload;
  }

  function uploadClassic(file) {
    return new Promise((resolve, reject) => {
      const body = new FormData();
      body.append('ttlMinutes', ttlMinutes.value);
      body.append('deleteAfterDownload', deleteAfterDownload.checked ? 'true' : 'false');
      body.append('file', file);

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

      xhr.onerror = () => {
        activeRequests.delete(xhr);
        const error = new Error('Erreur réseau pendant l’upload.');
        error.status = 0;
        reject(error);
      };
      xhr.onload = () => {
        activeRequests.delete(xhr);
        let payload = {};
        try { payload = JSON.parse(xhr.responseText || '{}'); }
        catch (_error) { payload = {}; }
        if (xhr.status < 200 || xhr.status >= 300) {
          reject(makeRequestError(xhr, payload));
          return;
        }
        resolve(payload);
      };
      xhr.onabort = () => {
        activeRequests.delete(xhr);
        const error = new Error('Upload annulé.');
        error.retryable = false;
        reject(error);
      };
      xhr.send(body);
    });
  }

  async function uploadClassicWithRetry(file) {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await uploadClassic(file);
      } catch (error) {
        if (attempt === maxAttempts || !isRetryable(error)) throw error;
        await sleep(retryDelayMs(error, attempt));
      }
    }
    throw new Error('Upload interrompu.');
  }

  async function uploadFileInChunks(file) {
    const session = await initChunkSession(file);
    const totalChunks = session.totalChunks;
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
        await sendChunkWithRetry({ file, session, chunkIndex, progress, startedAt, token });
        completed += 1;
        progressLabel.textContent = `Upload rapide · ${completed}/${totalChunks}`;
      }
    }

    const workers = Array.from({ length: Math.min(uploadConcurrency, totalChunks) }, () => worker());
    await Promise.all(workers);
    setProgress(100, file.size, file.size, 'Tous les morceaux sont envoyés.');
    return completeUpload(session, file);
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

    currentPayload = payload;
    currentDeleteKey = payload.deleteKey || null;
    if (window.DropQRStore) window.DropQRStore.remember(payload);
    if (deleteTransferBtn) deleteTransferBtn.disabled = !currentDeleteKey;

    if (payload.sandboxWarning) {
      sandboxWarning.classList.remove('hidden');
      sandboxWarning.textContent = payload.sandboxWarning;
    }

    emptyState.style.display = 'none';
    result.classList.add('visible');
    setStatus('C’est prêt. Le code et le QR peuvent être partagés. Le transfert est aussi dans ton tableau de bord.', 'success');
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
    if (maxFileSizeBytes && file.size > maxFileSizeBytes) {
      setStatus(`Ce fichier dépasse la limite de ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}.`, 'error');
      return;
    }

    result.classList.remove('visible');
    currentPayload = null;
    currentDeleteKey = null;
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
      if (chunkedUploadAvailable && file.size > 0) {
        try {
          payload = await uploadFileInChunks(file);
        } catch (error) {
          // Backend ancien sans route /chunk/init: repli sur l'upload classique
          // uniquement pour les petits fichiers.
          if (error.isInitError && error.status === 404 && file.size <= 40 * 1024 * 1024) {
            chunkedUploadAvailable = false;
            progressLabel.textContent = 'Upload classique';
            payload = await uploadClassicWithRetry(file);
          } else {
            throw error;
          }
        }
      } else if (file.size <= 40 * 1024 * 1024) {
        progressLabel.textContent = 'Upload classique';
        payload = await uploadClassicWithRetry(file);
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
    currentPayload = null;
    currentDeleteKey = null;
    emptyState.style.display = 'grid';
    clearSelectedFile();
    fileInput.focus();
  });

  if (deleteTransferBtn) {
    deleteTransferBtn.addEventListener('click', async () => {
      if (!currentPayload || !currentDeleteKey || deleteTransferBtn.disabled) return;
      const confirmed = window.confirm(`Supprimer définitivement « ${currentPayload.fileName} » du serveur ?`);
      if (!confirmed) return;

      deleteTransferBtn.disabled = true;
      setStatus('Suppression du transfert…');
      try {
        const response = await fetch(`/api/transfers/${encodeURIComponent(currentPayload.id)}`, {
          method: 'DELETE',
          headers: { 'X-Delete-Key': currentDeleteKey }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `Suppression impossible HTTP ${response.status}.`);

        if (window.DropQRStore) window.DropQRStore.remove(currentPayload.id);
        result.classList.remove('visible');
        currentPayload = null;
        currentDeleteKey = null;
        emptyState.style.display = 'grid';
        setStatus('Transfert supprimé du serveur.', 'success');
      } catch (error) {
        setStatus(error.message, 'error');
      } finally {
        deleteTransferBtn.disabled = !currentDeleteKey;
      }
    });
  }

  updateFileLabel();
  resetProgress();
  loadConfig();
};
initUploadPage();
window.addEventListener('pjax:load', initUploadPage);
