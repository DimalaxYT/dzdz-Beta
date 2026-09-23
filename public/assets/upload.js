/* Transfert partagé par l'accueil et /upload. Aucune dépendance à WebGL. */
(() => {
  'use strict';
  let teardown = () => {};

  function initUpload() {
    const form = document.getElementById('uploadForm');
    if (form?.dataset.dropqrInit === '1') return;
    teardown();
    if (!form) return;
    form.dataset.dropqrInit = '1';

    const $ = (id) => widget.querySelector(`#${id}`);
    const widget = form.closest('.transfer-widget');
    const auto = widget.dataset.autoUpload === 'true';
    const lifecycle = new AbortController();
    const on = (node, event, handler) => node.addEventListener(event, handler, { signal: lifecycle.signal });
    const fileInput = $('fileInput');
    const cameraInput = $('cameraInput');
    const sendButton = $('sendButton');
    const ttl = $('ttlMinutes');
    const oneDownload = $('deleteAfterDownload');
    const status = $('status');
    const result = $('result');
    const progressTrack = widget.querySelector('[role="progressbar"]');
    let selected = null;
    let previewURL = null;
    let config = null;
    let configRequest = null;
    let controller = null;
    let busy = false;
    let finalizing = false;
    let currentPayload = null;
    const requests = new Set();

    function signalEvent(name, detail = {}) {
      // Le moteur desktop peut écouter ces événements, mais ne gère jamais l'envoi.
      window.dispatchEvent(new CustomEvent(`dropqr:upload-${name}`, { detail }));
    }

    function setStatus(text = '', error = false) {
      status.className = error ? 'status error' : 'status';
      status.setAttribute('role', error ? 'alert' : 'status');
      status.textContent = text;
    }

    function waitFor(promise, signal) {
      return new Promise((resolve, reject) => {
        checkAbort(signal);
        const stop = () => reject(abortError());
        signal.addEventListener('abort', stop, { once: true });
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
      });
    }
    function formatBytes(value) { return window.DropQR.formatBytes(value); }
    function abortError() { return new DOMException('Envoi annulé.', 'AbortError'); }
    function checkAbort(signal) { if (signal.aborted || lifecycle.signal.aborted) throw abortError(); }
    function delay(ms, signal) {
      return new Promise((resolve, reject) => {
        checkAbort(signal);
        const stop = () => { clearTimeout(timer); reject(abortError()); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
        signal.addEventListener('abort', stop, { once: true });
      });
    }

    function updateOptions() {
      const minutes = Number(ttl.value);
      const duration = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`;
      $('optionsSummary').textContent = `${duration} · ${oneDownload.checked ? '1 téléchargement' : 'plusieurs téléchargements'}`;
    }

    function applyConfig(value) {
      config = value;
      // Respecte aussi les installations qui limitent la durée ou la taille.
      const maxTtl = Number(value.maxTtlMinutes) || 1440;
      const defaultTtl = Math.min(Number(value.defaultTtlMinutes) || 15, maxTtl);
      const options = [5, 15, 30, 60, 360, 1440, defaultTtl, maxTtl].filter((n, i, a) => n > 0 && n <= maxTtl && a.indexOf(n) === i).sort((a, b) => a - b);
      const chosen = ttl.dataset.edited === '1' && Number(ttl.value) <= maxTtl ? Number(ttl.value) : defaultTtl;
      ttl.replaceChildren(...options.map((minutes) => {
        const option = document.createElement('option');
        option.value = minutes;
        option.textContent = minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60} heure${minutes > 60 ? 's' : ''}` : `${minutes} minutes`;
        option.selected = minutes === chosen;
        return option;
      }));
      updateOptions();
      $('configNotice').hidden = true;
    }

    async function loadConfig() {
      if (config) return config;
      if (configRequest) return configRequest;
      configRequest = window.DropQR.getConfig().then((value) => {
        if (!lifecycle.signal.aborted) applyConfig(value);
        return value;
      }).catch((error) => {
        if (!lifecycle.signal.aborted) {
          $('configNotice').hidden = false;
          $('configNotice').textContent = 'Le serveur de transfert est injoignable. Vérifiez votre connexion puis réessayez. Un hébergement statique seul ne permet pas l’envoi.';
        }
        throw error;
      }).finally(() => { configRequest = null; });
      return configRequest;
    }

    function releasePreview() {
      if (previewURL) URL.revokeObjectURL(previewURL);
      previewURL = null;
      $('fileThumbnail').removeAttribute('src');
      $('fileThumbnail').hidden = true;
      widget.querySelector('.file-icon .icon').removeAttribute('hidden');
    }

    function chooseFile(file) {
      if (!file || busy) return;
      selected = file;
      releasePreview();
      $('fileChipName').textContent = file.name || 'Fichier';
      $('fileChipName').title = file.name;
      $('fileChipSize').textContent = `${window.DropQR.fileType(file.type, file.name)} · ${formatBytes(file.size)}`;
      // Aperçu local léger seulement, sans lecture ni envoi supplémentaire.
      if (/^image\/(jpeg|png|webp|gif)$/.test(file.type) && file.size <= 8 * 1024 * 1024) {
        previewURL = URL.createObjectURL(file);
        $('fileThumbnail').src = previewURL;
        $('fileThumbnail').hidden = false;
        widget.querySelector('.file-icon .icon').setAttribute('hidden', '');
      }
      $('filePicker').hidden = true;
      $('fileChip').hidden = false;
      $('progressPanel').hidden = true;
      sendButton.hidden = false;
      sendButton.disabled = false;
      sendButton.querySelector('span').textContent = 'Envoyer le fichier';
      widget.dataset.state = 'selected';
      setStatus();
      if (auto) startUpload();
    }

    function reset({ focus = true } = {}) {
      if (busy) return;
      releasePreview();
      selected = null;
      currentPayload = null;
      fileInput.value = '';
      cameraInput.value = '';
      $('filePicker').hidden = false;
      $('fileChip').hidden = true;
      $('progressPanel').hidden = true;
      $('transferOptions').hidden = false;
      sendButton.hidden = true;
      sendButton.disabled = true;
      result.hidden = true;
      form.hidden = false;
      widget.dataset.state = 'empty';
      setStatus();
      signalEvent('reset');
      if (focus) fileInput.focus({ preventScroll: true });
    }

    function progress(percent, loaded, total, detail) {
      const value = Math.min(100, Math.max(0, Math.round(percent)));
      $('progressPanel').hidden = false;
      $('progressBar').style.width = `${value}%`;
      $('progressPercent').textContent = `${value} %`;
      progressTrack.setAttribute('aria-valuenow', String(value));
      $('progressLoaded').textContent = `${formatBytes(Math.min(loaded, total))} / ${formatBytes(total)}`;
      $('progressSpeed').textContent = detail || 'Gardez cette page ouverte.';
      signalEvent('progress', { progress: value / 100 });
    }

    function requestError(statusCode, payload, retryAfter = null) {
      const messages = {
        0: 'Connexion interrompue. Vérifiez votre réseau et réessayez.',
        404: 'Le serveur de transfert est indisponible sur cette adresse.',
        413: 'Le fichier ou un morceau dépasse la limite du serveur.',
        429: 'Trop de requêtes. Patientez un instant avant de réessayer.'
      };
      const error = new Error(payload?.error || messages[statusCode] || `Envoi impossible (HTTP ${statusCode}). Réessayez.`);
      error.status = statusCode;
      error.retryAfter = Number(retryAfter) > 0 ? Math.min(Number(retryAfter) * 1000, 30000) : null;
      return error;
    }

    async function jsonRequest(url, body, signal) {
      checkAbort(signal);
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) throw requestError(response.status, payload, response.headers.get('Retry-After'));
      checkAbort(signal);
      return payload;
    }

    function postFile(url, body, signal, onProgress) {
      return new Promise((resolve, reject) => {
        checkAbort(signal);
        const xhr = new XMLHttpRequest();
        requests.add(xhr);
        const stop = () => xhr.abort();
        const finish = (error, payload) => {
          requests.delete(xhr);
          signal.removeEventListener('abort', stop);
          if (error) reject(error); else resolve(payload);
        };
        xhr.open('POST', url);
        xhr.responseType = 'text';
        xhr.timeout = 20 * 60 * 1000;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable && !signal.aborted) onProgress(event.loaded, event.total);
        };
        xhr.onload = () => {
          let payload;
          try { payload = JSON.parse(xhr.responseText); } catch (_error) { payload = null; }
          if (xhr.status < 200 || xhr.status >= 300 || !payload) finish(requestError(xhr.status, payload, xhr.getResponseHeader('Retry-After')));
          else finish(null, payload);
        };
        xhr.onerror = xhr.ontimeout = () => finish(requestError(0));
        xhr.onabort = () => finish(abortError());
        signal.addEventListener('abort', stop, { once: true });
        xhr.send(body);
      });
    }

    async function chunkedUpload(file, options, signal) {
      const session = await jsonRequest('/api/transfers/chunk/init', {
        fileName: file.name, mimeType: file.type || 'application/octet-stream', totalSize: file.size,
        chunkSize: Number(config.recommendedChunkSizeBytes) || 8 * 1024 * 1024, ...options
      }, signal);
      if (!session.uploadId || !session.uploadSecret || !Number.isInteger(session.totalChunks) || session.totalChunks < 1 || session.chunkSize <= 0) throw new Error('Réponse du serveur invalide. Réessayez.');
      const counts = new Array(session.totalChunks).fill(0);
      const concurrency = Math.min(8, Math.max(1, Number(config.uploadConcurrency) || 3), session.totalChunks);
      const started = performance.now();
      let next = 0;
      async function worker() {
        while (next < session.totalChunks) {
          checkAbort(signal);
          const index = next++;
          const chunk = file.slice(index * session.chunkSize, Math.min(file.size, (index + 1) * session.chunkSize));
          for (let attempt = 0; attempt < 4; attempt++) {
            checkAbort(signal);
            const body = new FormData();
            body.append('uploadId', session.uploadId);
            body.append('uploadSecret', session.uploadSecret);
            body.append('chunkIndex', String(index));
            body.append('chunk', chunk, `${file.name}.part${index}`);
            try {
              await postFile('/api/transfers/chunk', body, signal, (loaded, total) => {
                counts[index] = Math.min(chunk.size, Math.round(chunk.size * loaded / total));
                const sum = counts.reduce((a, b) => a + b, 0);
                const speed = sum / Math.max((performance.now() - started) / 1000, .1);
                progress(sum / file.size * 95, sum, file.size, `${formatBytes(speed)}/s`);
              });
              counts[index] = chunk.size;
              break;
            } catch (error) {
              const retryable = error.status === 0 || error.status === 429 || error.status >= 500;
              if (signal.aborted || error.name === 'AbortError' || !retryable || attempt === 3) throw error;
              counts[index] = 0;
              const wait = error.retryAfter || Math.min(1000 * 2 ** attempt, 8000);
              $('progressSpeed').textContent = `Connexion instable. Nouvelle tentative dans ${Math.ceil(wait / 1000)} s…`;
              await delay(wait, signal);
            }
          }
        }
      }
      await Promise.all(Array.from({ length: concurrency }, worker));
      checkAbort(signal);
      finalizing = true;
      $('cancelUpload').disabled = true;
      $('progressLabel').textContent = 'Création de votre lien…';
      progress(98, file.size, file.size, 'Finalisation sur le serveur.');
      return jsonRequest('/api/transfers/complete', { uploadId: session.uploadId, uploadSecret: session.uploadSecret }, signal);
    }

    async function classicUpload(file, options, signal) {
      const body = new FormData();
      body.append('ttlMinutes', String(options.ttlMinutes));
      body.append('deleteAfterDownload', String(options.deleteAfterDownload));
      body.append('file', file, file.name);
      return postFile('/api/transfers', body, signal, (loaded, total) => {
        const bytes = Math.round(file.size * loaded / total);
        progress(loaded / total * 95, bytes, file.size);
        if (loaded === total) {
          finalizing = true;
          $('cancelUpload').disabled = true;
          $('progressLabel').textContent = 'Création de votre lien…';
        }
      });
    }

    function showResult(payload) {
      if (!payload?.shareUrl || !payload.id || !(payload.qrSvgDataUrl || payload.qrDataUrl)) throw new Error('Le serveur n’a pas renvoyé de lien valide. Réessayez.');
      currentPayload = payload;
      releasePreview();
      window.DropQRStore?.remember(payload);
      const qr = payload.qrSvgDataUrl || payload.qrDataUrl;
      $('qrImage').src = qr;
      $('resultName').textContent = payload.fileName;
      $('resultSize').textContent = payload.sizeHuman || formatBytes(payload.size);
      $('resultCode').textContent = payload.code || payload.id;
      $('resultExpiry').textContent = `Disponible jusqu’au ${window.DropQR.formatDate(payload.expiresAt)}`;
      $('resultCleanup').textContent = payload.deleteAfterDownload ? 'Après le premier téléchargement' : 'À expiration';
      $('resultDiscord').textContent = payload.discord?.sent ? 'Envoyée au staff' : (payload.discordConfigured ? 'Non envoyée' : 'Désactivée');
      $('shareLink').value = payload.shareUrl;
      $('openLink').href = payload.shareUrl;
      $('downloadQR').href = qr;
      $('downloadQR').download = `dropqr-${payload.code || payload.id}.${payload.qrSvgDataUrl ? 'svg' : 'png'}`;
      $('sandboxWarning').hidden = !payload.sandboxWarning;
      $('sandboxWarning').textContent = payload.sandboxWarning || '';
      $('deleteTransferBtn').disabled = !payload.deleteKey;
      form.hidden = true;
      result.hidden = false;
      result.querySelector('details').open = false;
      widget.dataset.state = 'success';
      setStatus();
      signalEvent('complete', { shareUrl: payload.shareUrl });
      $('resultTitle').focus({ preventScroll: true });
      widget.scrollIntoView({ block: 'start', behavior: 'auto' });
    }

    async function startUpload() {
      if (!selected || busy) return;
      const file = selected;
      busy = true;
      finalizing = false;
      controller = new AbortController();
      const { signal } = controller;
      window.DropQRTransferBusy = true;
      widget.dataset.state = 'uploading';
      setStatus();
      sendButton.hidden = true;
      $('clearFile').hidden = true;
      $('transferOptions').hidden = true;
      $('cancelUpload').disabled = false;
      $('progressLabel').textContent = 'Préparation du fichier…';
      progress(0, 0, file.size);
      signalEvent('start', { file: { name: file.name, size: file.size, type: file.type } });
      try {
        await waitFor(loadConfig(), signal);
        checkAbort(signal);
        if (Number(config.maxFileSizeBytes) > 0 && file.size > Number(config.maxFileSizeBytes)) throw new Error(`Ce fichier dépasse la limite de ${config.maxFileSizeHuman || formatBytes(config.maxFileSizeBytes)}. Choisissez un fichier plus petit.`);
        $('progressLabel').textContent = 'Envoi de votre fichier…';
        const options = { ttlMinutes: Number(ttl.value), deleteAfterDownload: oneDownload.checked };
        const payload = config.chunkedUpload && config.chunkInit && file.size > 0
          ? await chunkedUpload(file, options, signal)
          : await classicUpload(file, options, signal);
        checkAbort(signal);
        progress(100, file.size, file.size, 'Votre QR est prêt.');
        showResult(payload);
      } catch (error) {
        const cancelled = error.name === 'AbortError' || signal.aborted;
        controller.abort(); // stoppe aussi les autres workers si l'un a échoué.
        if (!lifecycle.signal.aborted) {
          widget.dataset.state = 'selected';
          $('progressPanel').hidden = true;
          $('transferOptions').hidden = false;
          sendButton.hidden = false;
          sendButton.querySelector('span').textContent = cancelled ? 'Reprendre l’envoi' : 'Réessayer l’envoi';
          setStatus(cancelled ? 'Envoi arrêté. Le fichier reste sélectionné ; les morceaux temporaires seront nettoyés par le serveur.' : (error.message || 'Envoi impossible. Réessayez.'), !cancelled);
          signalEvent('error');
        }
      } finally {
        busy = false;
        finalizing = false;
        if (!lifecycle.signal.aborted) window.DropQRTransferBusy = false;
        controller = null;
        $('clearFile').hidden = false;
        sendButton.disabled = !selected;
      }
    }

    on($('fileThumbnail'), 'error', releasePreview);
    on(fileInput, 'change', () => chooseFile(fileInput.files[0]));
    on(cameraInput, 'change', () => chooseFile(cameraInput.files[0]));
    on($('cameraButton'), 'click', () => cameraInput.click());
    on($('clearFile'), 'click', () => reset());
    on($('newTransfer'), 'click', () => { reset(); widget.scrollIntoView({ block: 'start', behavior: 'auto' }); });
    on($('cancelUpload'), 'click', () => { if (!finalizing) controller?.abort(); });
    on(form, 'submit', (event) => { event.preventDefault(); startUpload(); });
    on(ttl, 'change', () => { ttl.dataset.edited = '1'; updateOptions(); });
    on(oneDownload, 'change', updateOptions);
    for (const event of ['dragenter', 'dragover']) on($('dropzone'), event, (e) => { e.preventDefault(); if (!busy) $('dropzone').classList.add('dragover'); });
    for (const event of ['dragleave', 'drop']) on($('dropzone'), event, (e) => { e.preventDefault(); $('dropzone').classList.remove('dragover'); });
    on($('dropzone'), 'drop', (event) => { if (event.dataTransfer?.files.length) chooseFile(event.dataTransfer.files[0]); });

    on($('copyButton'), 'click', async () => {
      if (!currentPayload) return;
      const copied = await window.DropQR.copyText(currentPayload.shareUrl);
      setStatus(copied ? 'Lien copié. À vous de le partager !' : 'Copiez le lien affiché dans les détails du transfert.');
      if (!copied) { result.querySelector('details').open = true; $('shareLink').focus(); $('shareLink').select(); }
    });
    on($('shareButton'), 'click', async () => {
      if (!currentPayload) return;
      // Appel direct pendant le geste utilisateur : indispensable sur iOS.
      if (navigator.share) {
        try { await navigator.share({ title: currentPayload.fileName, text: 'Un fichier vous attend sur DropQR.', url: currentPayload.shareUrl }); setStatus('Lien partagé.'); return; }
        catch (error) { if (error.name === 'AbortError') return; }
      }
      const copied = await window.DropQR.copyText(currentPayload.shareUrl);
      setStatus(copied ? 'Partage natif indisponible ici : le lien a été copié.' : 'Partage natif indisponible. Copiez le lien dans les détails du transfert.');
      if (!copied) { result.querySelector('details').open = true; $('shareLink').focus(); $('shareLink').select(); }
    });
    on($('deleteTransferBtn'), 'click', async () => {
      if (!currentPayload?.deleteKey || !window.confirm(`Supprimer définitivement « ${currentPayload.fileName} » ?`)) return;
      $('deleteTransferBtn').disabled = true;
      try {
        const response = await fetch(`/api/transfers/${encodeURIComponent(currentPayload.id)}`, { method: 'DELETE', headers: { 'X-Delete-Key': currentPayload.deleteKey }, signal: lifecycle.signal });
        if (!response.ok && response.status !== 404 && response.status !== 410) throw new Error('Suppression impossible. Réessayez.');
        window.DropQRStore?.remove(currentPayload.id);
        reset();
        setStatus('Le transfert a été supprimé.');
      } catch (error) {
        if (!lifecycle.signal.aborted) { setStatus(error.message, true); $('deleteTransferBtn').disabled = false; }
      }
    });

    window.DropQRAbortTransfer = () => controller?.abort();
    teardown = () => {
      lifecycle.abort();
      controller?.abort();
      requests.forEach((xhr) => xhr.abort());
      if (previewURL) URL.revokeObjectURL(previewURL);
      window.DropQRTransferBusy = false;
      window.DropQRAbortTransfer = null;
    };
    updateOptions();
    loadConfig().catch(() => {});
  }

  initUpload();
  window.addEventListener('pjax:before', () => teardown());
  window.addEventListener('pjax:load', initUpload);
})();
