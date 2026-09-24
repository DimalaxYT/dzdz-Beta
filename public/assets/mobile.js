'use strict';

// DropQR — améliorations propres à la version téléphone.
// Les pages mobiles réutilisent upload.js / receive.js / dashboard.js (mêmes
// identifiants HTML): ce fichier n'ajoute que les gestes « natifs »:
//   - boutons Appareil photo / Galerie branchés sur le champ fichier principal;
//   - partage natif (Web Share API) du lien créé ou reçu;
//   - bouton Coller + extraction automatique du code depuis un lien DropQR;
//   - défilement vers le résultat + petite vibration quand l'envoi est prêt;
//   - barre d'onglets masquée quand le clavier virtuel est ouvert.

(() => {
  const canShare = typeof navigator.share === 'function';
  const vibrate = (pattern) => { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (_error) {} };

  async function shareUrl(url, title) {
    if (!url) return;
    try {
      await navigator.share({ title: title || 'DropQR', text: title ? `${title} — via DropQR` : 'Fichier partagé avec DropQR', url });
    } catch (error) {
      if (error && error.name === 'AbortError') return; // l'utilisateur a fermé la feuille
      try { await navigator.clipboard.writeText(url); } catch (_error) { window.prompt('Copie le lien:', url); }
    }
  }

  // Extrait un code DropQR d'un texte collé: code brut, /c/CODE, /code/CODE ou ?code=CODE.
  function extractCode(text) {
    const value = String(text || '').trim();
    if (!value) return '';
    try {
      const url = new URL(value);
      const fromQuery = url.searchParams.get('code');
      if (fromQuery) return fromQuery;
      const match = url.pathname.match(/\/(?:c|code)\/([A-Za-z0-9-]+)/);
      if (match) return match[1];
      const share = url.pathname.match(/\/(?:t|share)\/([A-Za-z0-9_-]+)/);
      if (share) return { shareUrl: url.href };
    } catch (_error) {}
    return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
  }

  function initUpload() {
    const form = document.getElementById('uploadForm');
    const fileInput = document.getElementById('fileInput');
    if (!form || !fileInput || form.dataset.mobileInit === '1') return;
    form.dataset.mobileInit = '1';

    // Appareil photo / Galerie -> on recopie le fichier dans le champ principal
    // puis on déclenche "change": upload.js fait le reste.
    ['cameraInput', 'galleryInput'].forEach((id) => {
      const input = document.getElementById(id);
      if (!input) return;
      input.addEventListener('change', () => {
        const file = input.files && input.files[0];
        if (!file) return;
        try {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          fileInput.files = transfer.files;
          fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        } catch (_error) {
          // Très vieux navigateurs sans DataTransfer: on ouvre le sélecteur classique.
          fileInput.click();
        }
        input.value = '';
      });
    });

    const result = document.getElementById('result');
    const shareBtn = document.getElementById('shareNative');
    const copyBtn = document.getElementById('copyButton');
    const resultName = document.getElementById('resultName');

    if (shareBtn && canShare) {
      shareBtn.classList.remove('hidden');
      shareBtn.addEventListener('click', () => shareUrl(copyBtn && copyBtn.dataset.url, resultName && resultName.textContent));
    }

    // Quand le résultat apparaît: vibration + défilement jusqu'au QR.
    if (result && 'MutationObserver' in window) {
      let wasVisible = result.classList.contains('visible');
      const observer = new MutationObserver(() => {
        const visible = result.classList.contains('visible');
        if (visible && !wasVisible) {
          vibrate([18, 40, 18]);
          window.setTimeout(() => result.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
        wasVisible = visible;
      });
      observer.observe(result, { attributes: true, attributeFilter: ['class'] });
    }

    // Empêche l'écran de se mettre en veille pendant un envoi (si supporté).
    let wakeLock = null;
    const progressPanel = document.getElementById('progressPanel');
    if (progressPanel && 'wakeLock' in navigator && 'MutationObserver' in window) {
      new MutationObserver(async () => {
        const uploading = progressPanel.classList.contains('visible');
        try {
          if (uploading && !wakeLock) {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
          } else if (!uploading && wakeLock) {
            await wakeLock.release();
            wakeLock = null;
          }
        } catch (_error) { wakeLock = null; }
      }).observe(progressPanel, { attributes: true, attributeFilter: ['class'] });
    }
  }

  function initReceive() {
    const form = document.getElementById('receiveForm');
    const input = document.getElementById('transferCode');
    if (!form || !input || form.dataset.mobileInit === '1') return;
    form.dataset.mobileInit = '1';

    const pasteBtn = document.getElementById('pasteCode');
    if (pasteBtn && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      pasteBtn.classList.remove('hidden');
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          const code = extractCode(text);
          if (code && typeof code === 'object' && code.shareUrl) {
            window.location.href = code.shareUrl;
            return;
          }
          if (!code) return;
          input.value = code;
          vibrate(12);
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.dispatchEvent(new Event('submit', { cancelable: true }));
        } catch (_error) {
          input.focus();
        }
      });
    }

    // Un lien complet collé directement dans le champ -> on garde juste le code.
    input.addEventListener('paste', (event) => {
      const text = event.clipboardData && event.clipboardData.getData('text');
      const code = extractCode(text);
      if (typeof code === 'string' && code && text && /[/:?]/.test(text)) {
        event.preventDefault();
        input.value = code;
      }
    });

    const shareBtn = document.getElementById('shareReceiveLink');
    const copyBtn = document.getElementById('copyReceiveLink');
    const fileName = document.getElementById('receiveFileName');
    if (shareBtn && canShare) {
      shareBtn.classList.remove('hidden');
      shareBtn.addEventListener('click', () => shareUrl(copyBtn && copyBtn.dataset.url, fileName && fileName.textContent));
    }

    const result = document.getElementById('receiveResult');
    if (result && 'MutationObserver' in window) {
      new MutationObserver(() => {
        if (!result.classList.contains('hidden')) {
          input.blur();
          vibrate(15);
          window.setTimeout(() => result.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        }
      }).observe(result, { attributes: true, attributeFilter: ['class'] });
    }
  }

  // Clavier virtuel: la visualViewport rétrécit nettement quand il s'ouvre.
  let keyboardWatch = false;
  function initKeyboardWatch() {
    if (keyboardWatch || !window.visualViewport) return;
    keyboardWatch = true;
    const root = document.documentElement;
    const update = () => {
      const open = window.visualViewport.height < window.innerHeight * 0.78;
      root.classList.toggle('kb-open', open);
    };
    window.visualViewport.addEventListener('resize', update, { passive: true });
    update();
  }

  // Onglet actif après une navigation PJAX (la barre fait partie du shell,
  // mais on resynchronise au cas où).
  function syncTabs() {
    const path = window.location.pathname.replace(/\/+$/, '') || '/';
    document.querySelectorAll('.m-tabbar a').forEach((link) => {
      const target = new URL(link.href, window.location.href).pathname.replace(/\/+$/, '') || '/';
      const active = target === path;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  const init = () => {
    initUpload();
    initReceive();
    initKeyboardWatch();
    syncTabs();
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('pjax:load', init);
})();
