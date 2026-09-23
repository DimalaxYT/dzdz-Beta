/* Chargement progressif : l'interface est déjà opérationnelle à ce stade. */
(() => {
  'use strict';
  let loading = false;
  let loaded = false;
  const loadQR = () => new Promise((resolve, reject) => {
    if (window.qrcode) { resolve(); return; }
    const script = document.createElement('script');
    script.src = '/assets/vendor/qrcode.min.js?v=1';
    script.onload = resolve; script.onerror = reject;
    document.body.append(script);
  });
  async function loadScene() {
    if (!window.DropQRExperience?.enable3D || loading || loaded) return;
    loading = true;
    try {
      await loadQR();
      if (!window.DropQRExperience.enable3D) return;
      const { initScene } = await import('/assets/landing3d.js?v=4');
      if (!window.DropQRExperience.enable3D) return;
      initScene();
      loaded = true;
    } catch (_error) {
      document.body.classList.add('no-webgl');
      document.body.classList.remove('webgl-ready');
      // Le transfert, les liens et les trois étapes HTML restent fonctionnels.
    } finally { loading = false; }
  }
  const schedule = () => {
    if (!window.DropQRExperience?.enable3D) return;
    if ('requestIdleCallback' in window) requestIdleCallback(loadScene, { timeout: 1200 });
    else setTimeout(loadScene, 150);
  };
  schedule();
  window.addEventListener('dropqr:experience-change', schedule);
})();
