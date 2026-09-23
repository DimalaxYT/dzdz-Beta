(() => {
  'use strict';
  let teardown = () => {};

  function initReceive() {
    const form = document.getElementById('receiveForm');
    if (form?.dataset.dropqrInit === '1') return;
    teardown();
    if (!form) return;
    form.dataset.dropqrInit = '1';
    const $ = (id) => document.getElementById(id);
    const lifecycle = new AbortController();
    let request = null;
    let payload = null;
    const input = $('transferCode');
    const result = $('receiveResult');
    const status = $('receiveStatus');
    const video = $('receiveVideo');
    const button = form.querySelector('button');
    const normalize = (value) => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
    const setStatus = (text = '', error = false) => { status.textContent = text; status.className = error ? 'status error' : 'status'; status.setAttribute('role', error ? 'alert' : 'status'); };
    const on = (node, event, handler) => node.addEventListener(event, handler, { signal: lifecycle.signal });
    function resetVideo() {
      video.pause(); video.removeAttribute('src'); video.load();
      $('receivePreview').open = false; $('receivePreview').hidden = true;
    }
    async function lookup(code) {
      const normalized = normalize(code);
      if (!normalized) { setStatus('Saisissez le code reçu pour continuer.', true); input.focus(); return; }
      request?.abort();
      const current = new AbortController();
      request = current;
      input.value = normalized;
      result.hidden = true;
      $('receiveLayout').classList.remove('has-result');
      resetVideo();
      payload = null;
      button.disabled = true;
      setStatus('Recherche de votre fichier…');
      try {
        const response = await fetch(`/api/codes/${encodeURIComponent(normalized)}`, { cache: 'no-store', signal: current.signal });
        const data = await response.json().catch(() => null);
        if (response.status === 404) throw new Error('Code introuvable. Vérifiez les caractères. Le fichier a peut-être expiré ou été supprimé.');
        if (response.status === 410) throw new Error('Ce transfert a expiré ou a déjà été supprimé.');
        if (!response.ok || !data?.downloadUrl) throw new Error(data?.error || 'Le serveur est indisponible. Réessayez dans un instant.');
        if (current.signal.aborted || lifecycle.signal.aborted) return;
        payload = data;
        $('receiveFileName').textContent = data.fileName;
        $('receiveSize').textContent = data.sizeHuman;
        $('receiveType').textContent = window.DropQR.fileType(data.mimeType, data.fileName);
        $('receiveExpiry').textContent = window.DropQR.formatDate(data.expiresAt);
        $('resultCodeBadge').textContent = data.code || normalized;
        $('receiveCleanup').textContent = data.deleteAfterDownload ? 'Le fichier sera supprimé après le premier téléchargement.' : 'Vous pouvez le télécharger jusqu’à son expiration.';
        $('downloadButton').href = data.downloadUrl;
        // L'aperçu n'est chargé qu'après une action explicite, jamais le fichier à télécharger.
        $('receivePreview').hidden = !(data.canPreview && data.previewUrl);
        $('receiveResultStatus').textContent = '';
        result.hidden = false;
        $('receiveLayout').classList.add('has-result');
        setStatus('Fichier trouvé.');
        $('receiveFileName').focus({ preventScroll: true });
        result.scrollIntoView({ block: 'start', behavior: 'auto' });
      } catch (error) {
        if (error.name !== 'AbortError' && !lifecycle.signal.aborted) setStatus(error.message || 'Erreur réseau. Vérifiez votre connexion.', true);
      } finally {
        if (request === current) button.disabled = false;
      }
    }
    on(form, 'submit', (event) => { event.preventDefault(); lookup(input.value); });
    on(input, 'input', () => { const position = input.selectionStart; input.value = normalize(input.value); input.setSelectionRange(position, position); });
    on($('receivePreview'), 'toggle', () => {
      if ($('receivePreview').open && payload?.previewUrl && !video.getAttribute('src')) video.src = payload.previewUrl;
      if (!$('receivePreview').open) video.pause();
    });
    on($('copyReceiveLink'), 'click', async () => {
      if (!payload) return;
      const copied = await window.DropQR.copyText(payload.shareUrl);
      $('receiveResultStatus').textContent = copied ? 'Lien copié.' : 'Copie automatique indisponible. Copiez l’adresse de cette page.';
    });
    on($('otherCode'), 'click', () => {
      request?.abort(); payload = null; resetVideo();
      result.hidden = true;
      $('receiveLayout').classList.remove('has-result');
      input.value = '';
      setStatus();
      input.focus();
    });
    teardown = () => { lifecycle.abort(); request?.abort(); video.pause(); video.removeAttribute('src'); };
    const code = new URLSearchParams(location.search).get('code');
    if (code) lookup(code);
  }
  initReceive();
  window.addEventListener('pjax:before', () => teardown());
  window.addEventListener('pjax:load', initReceive);
})();
