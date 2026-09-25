'use strict';

/* DropQR — page Envoyer (v18)
   Pipeline inchangée (session chunks + envois parallèles + repli classique).
   Ajoute la scène : états visuels (idle → drag → selected → uploading →
   assembling → ready), segments de durée, compte à rebours d'expiration,
   métamorphose en particules du QR, partage natif, suppression via dialogue.
   Les identifiants HTML historiques sont conservés (versions mobile incluse). */

const initUploadPage = () => {
  const form = document.getElementById('uploadForm');
  if (!form) return;
  // Ne jamais initialiser deux fois le même formulaire (double appel possible
  // après une navigation PJAX: script injecté + événement pjax:load).
  if (form.dataset.dropqrInit === '1') return;
  form.dataset.dropqrInit = '1';

  const UI = window.DropQRUI || null;

  let chunkSize = 8 * 1024 * 1024;
  let uploadConcurrency = 5;
  let maxFileSizeBytes = null;
  let maxFileSizeHuman = '';

  const stage = document.getElementById('sendStage');
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
  // Éléments de la nouvelle scène (optionnels: les anciennes pages restent compatibles).
  const ttlSeg = document.getElementById('ttlSeg');
  const dropVeil = document.getElementById('drop-veil');
  const resultCountdown = document.getElementById('resultCountdown');
  const downloadQrBtn = document.getElementById('downloadQr');
  const shareBtn = document.getElementById('shareBtn');
  const copyCodeBtn = document.getElementById('copyCode');
  const stepsHost = document.getElementById('progressSteps');

  let backendReachable = true;
  let chunkedUploadAvailable = true;
  let uploadInProgress = false;
  let currentUploadToken = null;
  let activeRequests = new Set();
  let currentPayload = null;
  let currentDeleteKey = null;

  function formatBytes(bytes) {
    return UI ? UI.formatBytes(bytes) : `${Math.round(Number(bytes || 0) / 1e6)} MB`;
  }

  const sleep = (ms) => new Promise((resolve) => { window.setTimeout(resolve, ms); });

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message;
  }

  function setPhase(phase) {
    if (stage) stage.dataset.phase = phase;
    document.documentElement.classList.toggle('is-uploading', phase === 'uploading' || phase === 'processing');
  }

  function setStep(name) {
    if (!stepsHost) return;
    const order = ['prepare', 'stream', 'assemble', 'qr'];
    const idx = order.indexOf(name);
    stepsHost.querySelectorAll('[data-step]').forEach((el) => {
      const i = order.indexOf(el.dataset.step);
      el.classList.toggle('done', i < idx);
      el.classList.toggle('on', i === idx);
    });
  }

  function setProgress(percent, loaded = 0, total = 0, detail = '') {
    const safePercent = Math.max(0, Math.min(100, Math.round(percent || 0)));
    progressPanel.classList.add('visible');
    progressBar.style.width = `${safePercent}%`;
    progressPercent.textContent = `${safePercent}%`;
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', String(safePercent));
    progressLoaded.textContent = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)} envoyés`;
    progressSpeed.textContent = detail || 'Envoi en cours…';
  }

  function resetProgress() {
    progressLabel.textContent = 'Envoi en cours';
    progressBar.style.width = '0%';
    progressPercent.textContent = '0%';
    if (progressTrack) progressTrack.setAttribute('aria-valuenow', '0');
    progressLoaded.textContent = '0 o / 0 o';
    progressSpeed.textContent = 'Préparation…';
    progressPanel.classList.remove('visible');
    setStep('');
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
      const isMobileView = document.documentElement.getAttribute('data-view') === 'mobile';
      dropTitle.textContent = isMobileView ? 'Choisir un fichier' : 'Dépose ton fichier ici';
      dropSubtitle.innerHTML = isMobileView ? 'Touche pour parcourir tes fichiers' : 'ou clique pour le choisir — un seul fichier par transfert · <kbd>Entrée</kbd> pour parcourir';
      dropzone.classList.remove('is-ready');
      fileChip.classList.remove('visible');
      if (!uploadInProgress) setPhase('idle');
      return;
    }

    const chunks = Math.max(1, Math.ceil(file.size / chunkSize));
    dropTitle.textContent = file.name;
    dropSubtitle.textContent = `${formatBytes(file.size)} · ${uploadConcurrency} flux parallèles · ${chunks} morceau${chunks > 1 ? 'x' : ''}`;
    fileChipName.textContent = file.name;
    fileChipSize.textContent = `${formatBytes(file.size)} · morceaux de ${formatBytes(chunkSize)} × ${uploadConcurrency}`;
    fileChip.classList.add('visible');
    if (!uploadInProgress) {
      dropzone.classList.add('is-ready');
      setPhase('selected');
    }
    if (tooLarge) {
      dropSubtitle.textContent = `Fichier trop volumineux. Limite actuelle : ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}.`;
      setStatus(`Ce fichier dépasse la limite de ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}. Choisis un fichier plus petit.`, 'error');
      dropzone.classList.add('shake');
      setTimeout(() => dropzone.classList.remove('shake'), 500);
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
        notices.push('<strong>Backend ancien détecté.</strong> Redéploie la dernière version et vérifie que <code>/api/health</code> affiche <code>chunkInit: true</code>.');
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

  /* ---------- Segments de durée ===== */
  function bindTtlChips() {
    if (!ttlSeg) return;
    const sync = () => {
      ttlSeg.querySelectorAll('button[data-ttl]').forEach((btn) => {
        btn.setAttribute('aria-pressed', String(btn.dataset.ttl === String(ttlMinutes.value)));
      });
    };
    ttlSeg.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-ttl]');
      if (!btn || uploadInProgress) return;
      ttlMinutes.value = btn.dataset.ttl;
      ttlMinutes.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
    });
    sync();
  }

  /* ---------- Pipeline (inchangé) ---------- */
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
        fileSize: file.size,
        mimeType: file.type || 'application/octet-stream',
        chunkSize,
        ttlMinutes: Number(ttlMinutes.value),
        deleteAfterDownload: deleteAfterDownload.checked
      })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `Session d’upload refusée (HTTP ${response.status}).`);
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
        args.progress[args.chunkIndex] = 0;
        const delay = retryDelayMs(error, attempt);
        progressSpeed.textContent = error.status === 429
          ? `Limite serveur atteinte · nouvelle tentative dans ${Math.ceil(delay / 1000)} s`
          : `Connexion instable · nouvelle tentative ${attempt}/${maxAttempts - 1} dans ${Math.ceil(delay / 1000)} s`;
        setStatus('Envoi interrompu par le réseau. Je réessaie automatiquement…');
        await sleep(delay);
      }
    }
    throw new Error('Upload interrompu.');
  }

  async function completeUpload(session, file) {
    setPhase('processing');
    setStep('assemble');
    progressLabel.textContent = 'Assemblage serveur';
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
    setStep('prepare');
    const session = await initChunkSession(file);
    const totalChunks = session.totalChunks;
    const startedAt = performance.now();
    const token = makeUploadId();
    currentUploadToken = token;
    const progress = new Array(totalChunks).fill(0);
    let nextIndex = 0;
    let completed = 0;

    setPhase('uploading');
    setStep('stream');
    progressLabel.textContent = 'Envoi parallèle';
    setProgress(0, 0, file.size, `${totalChunks} morceau${totalChunks > 1 ? 'x' : ''} · ${uploadConcurrency} flux`);

    async function worker() {
      while (nextIndex < totalChunks) {
        if (currentUploadToken !== token) throw new Error('Upload annulé.');
        const chunkIndex = nextIndex;
        nextIndex += 1;
        await sendChunkWithRetry({ file, session, chunkIndex, progress, startedAt, token });
        completed += 1;
        progressLabel.textContent = `Envoi parallèle · ${completed}/${totalChunks}`;
      }
    }

    const workers = Array.from({ length: Math.min(uploadConcurrency, totalChunks) }, () => worker());
    await Promise.all(workers);
    setProgress(100, file.size, file.size, 'Tous les morceaux sont arrivés.');
    return completeUpload(session, file);
  }

  /* ---------- Métamorphose du QR en particules ---------- */
  function materializeQr(host) {
    if (!host || !qrImage) return;
    const settled = () => host.classList.add('is-settled');
    const fx = host.querySelector('canvas.fx');
    if (!fx || !qrImage.src || (UI && UI.reduced())) { settled(); return; }
    const img = qrImage;
    const render = () => {
      const box = img.getBoundingClientRect();
      if (!box.width || !box.height) return settled();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      fx.width = Math.round(box.width * dpr);
      fx.height = Math.round(box.height * dpr);
      // Échantillonnage du QR réel → particules qui convergent sur les modules sombres.
      const grid = 74;
      const sample = document.createElement('canvas');
      sample.width = grid; sample.height = grid;
      const sx = sample.getContext('2d', { willReadFrequently: true });
      sx.drawImage(img, 0, 0, grid, grid);
      let cells;
      try { cells = sx.getImageData(0, 0, grid, grid).data; } catch (_error) { return settled(); }
      const targets = [];
      for (let y = 0; y < grid; y += 1) {
        for (let x = 0; x < grid; x += 1) {
          const i = (y * grid + x) * 4;
          const lum = (cells[i] * 299 + cells[i + 1] * 587 + cells[i + 2] * 114) / 1000;
          if (lum < 128) targets.push([x, y]);
        }
      }
      if (!targets.length) return settled();
      const ctx = fx.getContext('2d');
      const cellW = fx.width / grid;
      const particles = targets.map(([x, y]) => ({
        x: Math.random() * fx.width,
        y: -10 - Math.random() * fx.height * 0.4,
        tx: (x + 0.5) * cellW,
        ty: (y + 0.5) * cellW,
        delay: Math.random() * 0.45,
        hue: Math.random() < 0.16 ? '131,225,207' : '220,255,94'
      }));
      const dur = 1250;
      const t0 = performance.now();
      const frame = (t) => {
        const e = Math.min(1, (t - t0) / dur);
        ctx.clearRect(0, 0, fx.width, fx.height);
        const fadeOut = e > 0.82 ? Math.max(0, 1 - (e - 0.82) / 0.18) : 1;
        for (const p of particles) {
          const local = Math.min(1, Math.max(0, (e - p.delay) / (1 - 0.45)));
          const ease = 1 - Math.pow(1 - local, 3);
          const cx = p.x + (p.tx - p.x) * ease;
          const cy = p.y + (p.ty - p.y) * ease;
          const s = cellW * (0.95 + (1 - ease) * 1.6);
          ctx.fillStyle = `rgba(${p.hue},${(0.22 + 0.78 * ease) * fadeOut})`;
          ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
        }
        if (e < 1) requestAnimationFrame(frame);
        else { ctx.clearRect(0, 0, fx.width, fx.height); settled(); }
      };
      requestAnimationFrame(frame);
    };
    if (img.decode) img.decode().then(render).catch(() => settled());
    else if (img.complete) render();
    else img.addEventListener('load', render, { once: true });
  }

  /* ---------- Résultat ---------- */
  function showResult(payload, file) {
    setPhase('ready');
    setStep('qr');
    setProgress(100, file.size, file.size, 'QR code généré — le passage est ouvert.');
    progressLabel.textContent = 'Transfert prêt';
    const expiry = UI ? UI.formatDate(payload.expiresAt) : payload.expiresAt;
    qrImage.src = payload.qrDataUrl;
    resultName.textContent = payload.fileName;
    resultCode.textContent = payload.code || payload.id;
    resultDiscord.textContent = payload.discord && payload.discord.sent ? 'Envoyé' : (payload.discordConfigured ? 'Non envoyé' : 'Non configuré');
    resultSize.textContent = payload.sizeHuman || formatBytes(payload.size);
    resultExpiry.textContent = expiry;
    resultCleanup.textContent = payload.deleteAfterDownload ? 'Après le 1er téléchargement' : 'À expiration';
    shareLink.textContent = payload.shareUrl;
    shareLink.title = payload.shareUrl;
    copyButton.dataset.url = payload.shareUrl;
    openLink.href = payload.shareUrl;
    if (resultCountdown) {
      resultCountdown.dataset.expiry = payload.expiresAt || '';
      resultCountdown.classList.remove('expired', 'warn');
      delete resultCountdown.dataset.dqFired;
    }
    if (copyCodeBtn) copyCodeBtn.dataset.code = payload.code || payload.id;

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
    materializeQr(result.querySelector('.qr-stage'));
    if (UI) UI.toast('Passage ouvert — le fichier est prêt à être partagé.');
    setStatus('C’est prêt. Partage le QR, le code ou le lien. Le transfert est aussi dans ton tableau de bord.', 'success');
  }

  /* ---------- Événements ---------- */
  fileInput.addEventListener('change', updateFileLabel);
  if (clearFile) clearFile.addEventListener('click', clearSelectedFile);

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

  const acceptDroppedFile = (file) => {
    if (!file || uploadInProgress) return;
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(file);
    fileInput.files = dataTransfer.files;
    updateFileLabel();
    sendButton.focus();
  };

  dropzone.addEventListener('drop', (event) => acceptDroppedFile(event.dataTransfer.files[0]));

  // Glisser n’importe où sur la page déclenche le port d’entrée.
  const hasFiles = (event) => event.dataTransfer && [...(event.dataTransfer.types || [])].includes('Files');
  let dragDepth = 0;
  const onWindowDragEnter = (event) => {
    if (!hasFiles(event) || uploadInProgress) return;
    event.preventDefault();
    dragDepth += 1;
    if (dropVeil) dropVeil.classList.add('on');
    dropzone.classList.add('dragover');
  };
  const onWindowDragOver = (event) => { if (hasFiles(event)) event.preventDefault(); };
  const onWindowDragLeave = (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) {
      if (dropVeil) dropVeil.classList.remove('on');
      dropzone.classList.remove('dragover');
    }
  };
  const onWindowDrop = (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    if (dropVeil) dropVeil.classList.remove('on');
    dropzone.classList.remove('dragover');
    const files = event.dataTransfer && event.dataTransfer.files;
    if (files && files.length) {
      if (files.length > 1 && UI) UI.toast('Un seul fichier par transfert — le premier est utilisé.');
      acceptDroppedFile(files[0]);
    }
  };
  window.addEventListener('dragenter', onWindowDragEnter);
  window.addEventListener('dragover', onWindowDragOver);
  window.addEventListener('dragleave', onWindowDragLeave);
  window.addEventListener('drop', onWindowDrop);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    if (!file || uploadInProgress) return;
    if (maxFileSizeBytes && file.size > maxFileSizeBytes) {
      setStatus(`Ce fichier dépasse la limite de ${maxFileSizeHuman || formatBytes(maxFileSizeBytes)}.`, 'error');
      dropzone.classList.add('shake');
      setTimeout(() => dropzone.classList.remove('shake'), 500);
      return;
    }

    result.classList.remove('visible');
    const qrStage = result.querySelector('.qr-stage');
    if (qrStage) qrStage.classList.remove('is-settled');
    currentPayload = null;
    currentDeleteKey = null;
    sandboxWarning.classList.add('hidden');
    emptyState.style.display = 'grid';
    setStatus('Envoi en cours… garde cette page ouverte.');
    uploadInProgress = true;
    sendButton.disabled = true;
    sendButton.classList.add('is-loading');
    if (clearFile) clearFile.disabled = true;
    setPhase('uploading');
    setStep('prepare');
    progressLabel.textContent = 'Préparation';
    setProgress(0, 0, file.size, `Découpage en morceaux de ${formatBytes(chunkSize)}…`);

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
            progressLabel.textContent = 'Envoi classique';
            payload = await uploadClassicWithRetry(file);
          } else {
            throw error;
          }
        }
      } else if (file.size <= 40 * 1024 * 1024) {
        progressLabel.textContent = 'Envoi classique';
        setStep('stream');
        payload = await uploadClassicWithRetry(file);
      } else {
        throw new Error('Backend déployé pas à jour. Redéploie la dernière version.');
      }
      showResult(payload, file);
    } catch (error) {
      setStatus(`${error.message || 'Upload impossible.'} Ton fichier reste sur ton appareil : rien n’est perdu, tu peux réessayer.`, 'error');
      progressLabel.textContent = 'Envoi interrompu';
      progressSpeed.textContent = backendReachable ? 'Le fichier n’a pas été enregistré sur le serveur.' : 'Backend API non détecté.';
      setPhase('error');
      if (UI) UI.toast(error.message || 'Upload impossible.', { type: 'error' });
    } finally {
      activeRequests.forEach((xhr) => { try { xhr.abort(); } catch (_error) {} });
      activeRequests = new Set();
      uploadInProgress = false;
      currentUploadToken = null;
      if (clearFile) clearFile.disabled = false;
      sendButton.classList.remove('is-loading');
      sendButton.disabled = !fileInput.files[0];
    }
  });

  if (copyButton) {
    copyButton.addEventListener('click', async () => {
      const url = copyButton.dataset.url;
      if (!url) return;
      const done = UI ? await UI.copy(url, 'Lien copié — envoie-le à la personne qui doit recevoir.') : await writeFallback(url);
      if (done) flash(copyButton, 'Copié');
    });
  }
  async function writeFallback(url) {
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch (_error) {
      window.prompt('Copie le lien:', url);
      return false;
    }
  }
  function flash(button, label) {
    const original = button.textContent;
    button.textContent = label;
    setTimeout(() => { button.textContent = original; }, 1500);
  }

  if (copyCodeBtn) {
    copyCodeBtn.addEventListener('click', async () => {
      const code = copyCodeBtn.dataset.code || resultCode.textContent;
      if (code && code !== '—' && await (UI ? UI.copy(code, `Code ${code} copié.`) : writeFallback(code))) flash(copyCodeBtn, 'Copié');
    });
  }

  if (downloadQrBtn) {
    downloadQrBtn.addEventListener('click', () => {
      if (!currentPayload || !currentPayload.qrDataUrl) return;
      const a = document.createElement('a');
      a.href = currentPayload.qrDataUrl;
      a.download = `dropqr-${currentPayload.code || 'qr'}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (UI) UI.toast('QR téléchargé.');
    });
  }

  if (shareBtn) {
    const canShare = typeof navigator.share === 'function';
    shareBtn.classList.toggle('hidden', !canShare);
    shareBtn.addEventListener('click', async () => {
      const url = copyButton && copyButton.dataset.url;
      if (!url || !canShare) return;
      try {
        await navigator.share({
          title: currentPayload ? currentPayload.fileName : 'DropQR',
          text: 'Fichier temporaire via DropQR — ouvre le lien ou saisis le code sur dropqr.',
          url
        });
      } catch (error) {
        if (error && error.name === 'AbortError') return;
        await (UI ? UI.copy(url, 'Partage indisponible — lien copié à la place.') : writeFallback(url));
      }
    });
  }

  if (newTransfer) {
    newTransfer.addEventListener('click', () => {
      if (uploadInProgress) return;
      result.classList.remove('visible');
      const qrStage = result.querySelector('.qr-stage');
      if (qrStage) qrStage.classList.remove('is-settled');
      currentPayload = null;
      currentDeleteKey = null;
      emptyState.style.display = 'grid';
      clearSelectedFile();
      fileInput.focus();
    });
  }

  if (deleteTransferBtn) {
    deleteTransferBtn.addEventListener('click', async () => {
      if (!currentPayload || !currentDeleteKey || deleteTransferBtn.disabled) return;
      const confirmed = UI
        ? await UI.confirm({
          title: 'Couper le passage ?',
          body: `« ${currentPayload.fileName} » sera supprimé définitivement du serveur. Les personnes qui ne l’ont pas encore téléchargé perdront l’accès.`,
          note: 'Cette action est immédiate et irréversible.',
          confirmLabel: 'Supprimer maintenant',
          danger: true
        })
        : window.confirm(`Supprimer définitivement « ${currentPayload.fileName} » du serveur ?`);
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
        setStatus('Transfert supprimé du serveur. Le lien et le QR ne fonctionnent plus.', 'success');
        if (UI) UI.toast('Fichier supprimé du serveur.');
      } catch (error) {
        setStatus(error.message, 'error');
      } finally {
        deleteTransferBtn.disabled = !currentDeleteKey;
      }
    });
  }

  if (resultCountdown) {
    resultCountdown.addEventListener('dq:expired', () => {
      setStatus('Le délai d’expiration est atteint : le serveur a purgé ce transfert. Tu peux en créer un nouveau.', 'error');
    });
  }

  updateFileLabel();
  resetProgress();
  bindTtlChips();
  loadConfig();
};
initUploadPage();
window.addEventListener('pjax:load', initUploadPage);
