/* ==========================================================================
   DropQR — page d'envoi
   Le fichier ne passe jamais par la fonction serverless : le navigateur
   demande une autorisation (URL pré-signée ou route locale), puis envoie les
   octets directement. Le serveur ne valide que les métadonnées à la fin.
   ========================================================================== */

(() => {
  'use strict';

  const {
    formatBytes,
    config,
    toast,
    renderCodeDisplay,
    startCountdown,
    createSparkline,
    copyText
  } = window.DropQR;

  const $ = (id) => document.getElementById(id);

  const form = $('uploadForm');
  const fileInput = $('fileInput');
  const dropzone = $('dropzone');
  const dropTitle = $('dropTitle');
  const dropSubtitle = $('dropSubtitle');
  const fileChip = $('fileChip');
  const fileChipName = $('fileChipName');
  const fileChipSize = $('fileChipSize');
  const clearFile = $('clearFile');
  const ttlMinutes = $('ttlMinutes');
  const deleteAfterDownload = $('deleteAfterDownload');
  const sendButton = $('sendButton');
  const sendLabel = $('sendLabel');
  const status = $('status');

  const progressCard = $('progressCard');
  const progressRing = $('progressRing');
  const progressPercent = $('progressPercent');
  const progressLabel = $('progressLabel');
  const progressEta = $('progressEta');
  const progressBar = $('progressBar');
  const progressLoaded = $('progressLoaded');
  const progressSpeed = $('progressSpeed');
  const sparkline = $('sparkline');
  const pushSample = createSparkline(sparkline);

  const result = $('result');
  const emptyState = $('emptyState');
  const qrHolder = $('qrHolder');
  const resultCodeSlots = $('resultCodeSlots');
  const copyCode = $('copyCode');
  const resultName = $('resultName');
  const resultSize = $('resultSize');
  const resultExpiry = $('resultExpiry');
  const resultCleanup = $('resultCleanup');
  const resultDiscord = $('resultDiscord');
  const countdown = $('countdown');
  const shareLink = $('shareLink');
  const copyLink = $('copyLink');
  const openLink = $('openLink');
  const downloadFile = $('downloadFile');
  const downloadQr = $('downloadQr');
  const newTransfer = $('newTransfer');
  const resultStatusText = $('resultStatusText');

  const RING_CIRCUMFERENCE = 2 * Math.PI * 52;

  const state = {
    sending: false,
    cancelled: false,
    requests: new Set(),
    stopCountdown: null,
    lastPayload: null,
    partProgress: new Map(),
    startedAt: 0,
    totalParts: 0,
    partsDone: 0,
    fileSize: 0
  };

  if (window.DropQR.storageUnavailable) {
    sendButton.disabled = true;
    setStatus('Stockage non configuré sur ce déploiement : l’envoi est désactivé. Le guide Netlify explique quoi ajouter.', 'error');
    form.querySelectorAll('input, select, button').forEach((element) => {
      element.disabled = true;
    });
  }

  function setStatus(message, type = '') {
    status.className = `status ${type}`.trim();
    status.textContent = message || '';
  }

  function setProgress(percent, { loaded = 0, total = 0, detail = '', eta = '' } = {}) {
    const safe = Math.max(0, Math.min(100, Number(percent) || 0));
    progressCard.hidden = false;
    progressRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - safe / 100));
    progressPercent.textContent = `${Math.round(safe)} %`;
    progressBar.style.width = `${safe}%`;
    progressLoaded.textContent = total ? `${formatBytes(loaded)} / ${formatBytes(total)}` : `${formatBytes(loaded)} envoyés`;
    progressSpeed.textContent = detail || 'en cours';
    progressEta.textContent = eta || 'estimation…';
    progressEta.className = `chip ${safe >= 99 ? 'chip-jade' : 'chip-soft'}`;
  }

  function resetProgress() {
    progressCard.hidden = true;
    progressRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE);
    progressBar.style.width = '0%';
    progressPercent.textContent = '0 %';
    progressLoaded.textContent = '0 o / 0 o';
    progressSpeed.textContent = '—';
    progressEta.textContent = 'estimation…';
  }

  function currentFile() {
    return fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
  }

  function updateFileUi() {
    const file = currentFile();
    sendButton.disabled = !file || state.sending || window.DropQR.storageUnavailable;

    if (!file) {
      dropTitle.textContent = 'Dépose ton fichier ici';
      dropSubtitle.textContent = 'ou clique pour le choisir. Vidéos, images, archives, documents.';
      fileChip.hidden = true;
      return;
    }

    dropTitle.textContent = file.name;
    dropSubtitle.textContent = `${formatBytes(file.size)} prêt à partir`;
    fileChipName.textContent = file.name;
    fileChipSize.textContent = `${formatBytes(file.size)} · morceaux de ${formatBytes(config.partSizeBytes || 8 * 1024 * 1024)} · ${config.maxParallelUploads || 3} envois simultanés`;
    fileChip.hidden = false;
  }

  /* ------------------------------- transport ------------------------------- */

  function trackRequest(xhr) {
    state.requests.add(xhr);
    return () => state.requests.delete(xhr);
  }

  function aggregateLoaded() {
    let sum = 0;
    state.partProgress.forEach((value) => {
      sum += value;
    });
    return Math.min(sum, state.fileSize);
  }

  function reportProgress() {
    const loaded = aggregateLoaded();
    const elapsed = Math.max((performance.now() - state.startedAt) / 1000, 0.2);
    const speed = loaded / elapsed;
    const remaining = Math.max(state.fileSize - loaded, 0);
    const seconds = speed > 0 ? remaining / speed : 0;
    const detail = `${formatBytes(speed)}/s · ${state.partsDone}/${state.totalParts} morceaux`;
    const eta = seconds > 1 ? `reste ${window.DropQR.formatDuration(seconds)}` : 'presque fini';
    setProgress(state.fileSize ? (loaded / state.fileSize) * 100 : 0, {
      loaded,
      total: state.fileSize,
      detail,
      eta
    });
    pushSample(speed);
  }

  /** Envoi d'un morceau ou du fichier entier vers une URL pré-signée. */
  function put(url, body, { key = 'single', headers = {}, method = 'PUT' } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const untrack = trackRequest(xhr);
      xhr.open(method, url);
      Object.entries(headers).forEach(([name, value]) => xhr.setRequestHeader(name, value));
      xhr.responseType = 'text';

      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        state.partProgress.set(key, event.loaded);
        reportProgress();
      };

      xhr.onerror = () => {
        untrack();
        reject(new Error('Erreur réseau pendant l’envoi. Vérifie la configuration CORS du stockage (méthodes GET, PUT, HEAD autorisées).'));
      };
      xhr.onabort = () => {
        untrack();
        reject(new Error('Envoi annulé.'));
      };
      xhr.onload = () => {
        untrack();
        if (xhr.status < 200 || xhr.status >= 300) {
          let detail = '';
          try {
            detail = JSON.parse(xhr.responseText || '{}').error || '';
          } catch {
            detail = String(xhr.responseText || '').slice(0, 160);
          }
          reject(new Error(detail || `Envoi refusé par le stockage (HTTP ${xhr.status}). Si l’URL pré-signée a expiré, relance l’envoi.`));
          return;
        }
        state.partProgress.set(key, body.size || 0);
        const etag = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
        resolve({ etag: etag ? etag.replace(/"/g, '') : '' });
      };
      xhr.send(body);
    });
  }

  async function api(path, { method = 'GET', body, deleteKey } = {}) {
    const headers = {};
    if (body) headers['Content-Type'] = 'application/json';
    if (deleteKey) headers['X-Delete-Key'] = deleteKey;
    const response = await fetch(path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Erreur serveur HTTP ${response.status}.`);
    return payload;
  }

  async function fetchParts(id, deleteKey, fromPart) {
    return api(`/api/transfers/${encodeURIComponent(id)}/parts`, {
      method: 'POST',
      body: { fromPart },
      deleteKey
    });
  }

  async function sendBytes(created, file) {
    const upload = created.upload || {};
    state.startedAt = performance.now();
    state.fileSize = file.size;
    state.partProgress.clear();
    state.partsDone = 0;

    if (upload.mode === 'single' || upload.mode === 'local-single') {
      state.totalParts = 1;
      const url = upload.mode === 'single' ? upload.single.url : upload.url;
      const safeType = created.mimeType || 'application/octet-stream';
      const headers = upload.mode === 'local-single' ? { 'X-Delete-Key': created.deleteKey } : { 'Content-Type': safeType };
      progressLabel.textContent = upload.mode === 'local-single' ? 'Envoi vers le serveur' : 'Envoi direct au stockage';
      await put(url, file, { key: 'single', headers });
      return [];
    }

    if (upload.mode === 'multipart') {
      const totalParts = Number(upload.parts);
      const partSize = Number(upload.partSize);
      state.totalParts = totalParts;
      progressLabel.textContent = `Envoi en ${totalParts} morceaux`;

      const urls = new Map();
      const results = new Array(totalParts);
      let nextPart = 1;

      const first = await fetchParts(created.id, created.deleteKey, 1);
      first.parts.forEach((part) => urls.set(part.partNumber, part.url));

      async function worker() {
        for (;;) {
          if (state.cancelled) throw new Error('Envoi annulé.');
          const index = nextPart;
          nextPart += 1;
          if (index > totalParts) return;

          if (!urls.has(index)) {
            const extra = await fetchParts(created.id, created.deleteKey, index);
            extra.parts.forEach((part) => urls.set(part.partNumber, part.url));
          }

          const start = (index - 1) * partSize;
          const end = Math.min(file.size, start + partSize);
          const blob = file.slice(start, end);
          const result = await put(urls.get(index), blob, { key: `part-${index}`, headers: { 'Content-Type': 'application/octet-stream' } });
          results[index - 1] = { partNumber: index, etag: result.etag || '' };
          state.partProgress.set(`part-${index}`, blob.size);
          state.partsDone += 1;
          reportProgress();
        }
      }

      const parallel = Math.max(1, Math.min(Number(upload.maxParallel) || 3, totalParts, config.maxParallelUploads || 3));
      await Promise.all(Array.from({ length: parallel }, worker));
      return results.filter(Boolean);
    }

    throw new Error(`Mode d’envoi inconnu : ${upload.mode || 'absent'}. Le serveur n’est peut-être pas à jour.`);
  }

  async function notifyDiscord(payload) {
    if (!config.discordConfigured) {
      resultDiscord.textContent = 'non configuré';
      return;
    }
    resultDiscord.textContent = 'en cours';
    try {
      const response = await fetch('/api/notify/discord', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Delete-Key': payload.deleteKey || '' },
        body: JSON.stringify({ id: payload.id })
      });
      const body = await response.json().catch(() => ({}));
      resultDiscord.textContent = response.ok && body.sent ? 'envoyé' : 'échec';
    } catch {
      resultDiscord.textContent = 'échec';
    }
  }

  async function showResult(payload) {
    state.lastPayload = payload;
    progressLabel.textContent = 'Transfert prêt';
    setProgress(100, { loaded: payload.size, total: payload.size, detail: 'terminé', eta: 'en ligne' });
    progressEta.className = 'chip chip-jade';

    renderCodeDisplay(resultCodeSlots, payload.code);
    resultName.textContent = payload.fileName;
    resultSize.textContent = payload.sizeHuman;
    resultExpiry.textContent = window.DropQR.formatDate(payload.expiresAt);
    resultCleanup.textContent = payload.deleteAfterDownload ? 'Après le premier téléchargement' : 'À l’expiration';
    shareLink.value = payload.shareUrl;
    openLink.href = payload.shareUrl;
    downloadFile.href = payload.downloadUrl;
    copyCode.dataset.copy = payload.code;
    copyLink.dataset.copy = payload.shareUrl;
    resultStatusText.textContent = '';

    qrHolder.innerHTML = '<span class="qr-sweep" aria-hidden="true"></span>';
    try {
      const svg = await fetch(`/api/transfers/${encodeURIComponent(payload.id)}/qr.svg`, { cache: 'no-store' }).then((r) => r.text());
      qrHolder.insertAdjacentHTML('afterbegin', svg);
      qrHolder.dataset.svg = svg;
    } catch {
      qrHolder.insertAdjacentHTML('afterbegin', '<p class="note">QR indisponible.</p>');
    }

    if (state.stopCountdown) state.stopCountdown();
    state.stopCountdown = startCountdown(countdown, payload.expiresAt);

    saveToDashboard(payload);
    emptyState.hidden = true;
    result.hidden = false;
    result.scrollIntoView({ behavior: window.DropQR.reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
    toast(`Transfert ${payload.code} en ligne.`);
    notifyDiscord(payload);
  }

  function saveToDashboard(payload) {
    try {
      const list = JSON.parse(localStorage.getItem('dropqr.transfers') || '[]');
      const filtered = list.filter((item) => item.id !== payload.id);
      filtered.unshift({
        id: payload.id,
        code: payload.code,
        deleteKey: payload.deleteKey || '',
        fileName: payload.fileName,
        sizeHuman: payload.sizeHuman,
        shareUrl: payload.shareUrl,
        downloadUrl: payload.downloadUrl,
        expiresAt: payload.expiresAt,
        deleteAfterDownload: payload.deleteAfterDownload,
        createdAt: new Date().toISOString()
      });
      localStorage.setItem('dropqr.transfers', JSON.stringify(filtered.slice(0, 60)));
    } catch {
      /* stockage local indisponible : ce n'est pas bloquant */
    }
  }

  /* -------------------------------- formulaire ----------------------------- */

  ['dragenter', 'dragover'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      if (!state.sending) dropzone.classList.add('is-dragover');
    });
  });

  ['dragleave', 'drop'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-dragover');
    });
  });

  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer && event.dataTransfer.files[0];
    if (!file || state.sending) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    fileInput.files = transfer.files;
    updateFileUi();
    setStatus('');
  });

  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    updateFileUi();
    setStatus('');
  });

  clearFile.addEventListener('click', () => {
    if (state.sending) return;
    fileInput.value = '';
    updateFileUi();
    resetProgress();
    setStatus('');
  });

  function cancelUpload() {
    state.cancelled = true;
    state.requests.forEach((xhr) => {
      try {
        xhr.abort();
      } catch {
        /* déjà terminé */
      }
    });
    state.requests.clear();
    setStatus('Envoi annulé. Les morceaux déjà reçus seront purgés automatiquement.', 'error');
    toast('Envoi annulé.', 'error');
  }

  sendButton.addEventListener('click', (event) => {
    if (!state.sending) return;
    event.preventDefault();
    cancelUpload();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.sending) return;
    const file = currentFile();
    if (!file) return;
    if (window.DropQR.storageUnavailable) return;

    state.sending = true;
    state.cancelled = false;
    state.requests.clear();
    result.hidden = true;
    emptyState.hidden = false;
    progressCard.hidden = false;
    sendLabel.textContent = 'Annuler l’envoi';
    sendButton.disabled = false;
    clearFile.disabled = true;
    setStatus('Préparation du transfert…');
    resetProgress();

    try {
      const created = await api('/api/transfers', {
        method: 'POST',
        body: {
          fileName: file.name,
          size: file.size,
          mimeType: file.type || 'application/octet-stream',
          ttlMinutes: ttlMinutes.value,
          deleteAfterDownload: deleteAfterDownload.checked
        }
      });

      setStatus(`Envoi de ${formatBytes(file.size)} (mode ${created.upload.mode})…`);
      const parts = await sendBytes(created, file);

      const completed = await api(`/api/transfers/${encodeURIComponent(created.id)}/complete`, {
        method: 'POST',
        body: { parts },
        deleteKey: created.deleteKey
      });

      setStatus('Transfert enregistré. Le lien est actif.', 'success');
      await showResult({ ...created, ...completed, deleteKey: created.deleteKey });
    } catch (error) {
      const message = error.message || 'Envoi impossible.';
      setStatus(message, 'error');
      progressLabel.textContent = 'Envoi interrompu';
      progressSpeed.textContent = message;
      toast(message, 'error');
    } finally {
      state.sending = false;
      sendLabel.textContent = 'Envoyer le fichier';
      clearFile.disabled = false;
      updateFileUi();
    }
  });

  newTransfer.addEventListener('click', () => {
    if (state.sending) return;
    result.hidden = true;
    emptyState.hidden = false;
    fileInput.value = '';
    resetProgress();
    setStatus('');
    updateFileUi();
    dropzone.focus();
  });

  downloadQr.addEventListener('click', () => {
    const svg = qrHolder.dataset.svg;
    if (!svg) {
      toast('Le QR n’est pas encore prêt.', 'error');
      return;
    }
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `dropqr-${state.lastPayload ? state.lastPayload.code : 'transfert'}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  copyCode.addEventListener('click', async () => {
    if (!state.lastPayload) return;
    const ok = await copyText(state.lastPayload.code);
    toast(ok ? `Code ${state.lastPayload.code} copié.` : 'Copie impossible.', ok ? 'success' : 'error');
  });

  copyLink.addEventListener('click', async () => {
    if (!state.lastPayload) return;
    const ok = await copyText(state.lastPayload.shareUrl);
    toast(ok ? 'Lien copié.' : 'Copie impossible.', ok ? 'success' : 'error');
  });

  if (config.warning) setStatus(config.warning, 'error');
  updateFileUi();
})();
