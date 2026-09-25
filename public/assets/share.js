'use strict';

/* DropQR — pages serveur « reçu de partage » (/t, /c) et notices (v1)
   Animate l'arrivée, gère le copier/partager natif du lien. La logique de
   téléchargement reste dans le HTML (href /download/...) : ce script ne
   touche jamais à l'URL de téléchargement. */

(() => {
  const init = () => {
    const page = document.querySelector('.share-page');
    if (!page) return;
    if (!page.dataset.shareInit) {
      page.dataset.shareInit = '1';

      // Micro-révélation à l'arrivée (le lien « atterrit »).
      const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!reduce) {
        page.style.opacity = '0';
        page.style.transform = 'translateY(14px)';
        requestAnimationFrame(() => {
          page.style.transition = 'opacity .7s cubic-bezier(.16,1,.3,1), transform .7s cubic-bezier(.16,1,.3,1)';
          page.style.opacity = '1';
          page.style.transform = 'none';
        });
      }

      const copyBtn = document.getElementById('share-copy');
      if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
          const url = copyBtn.dataset.url || window.location.href;
          let done = false;
          try { await navigator.clipboard.writeText(url); done = true; }
          catch (_error) { window.prompt('Copie le lien :', url); }
          if (done) {
            copyBtn.textContent = 'Copié ✓';
            setTimeout(() => { copyBtn.textContent = 'Copier le lien'; }, 1600);
          }
        });
      }

      const shareBtn = document.getElementById('share-native');
      if (shareBtn) {
        if (typeof navigator.share === 'function') {
          shareBtn.classList.remove('hidden');
          shareBtn.addEventListener('click', async () => {
            try {
              await navigator.share({
                title: 'DropQR',
                text: document.getElementById('share-name') ? document.getElementById('share-name').textContent : 'Fichier temporaire',
                url: shareBtn.dataset.url || window.location.href
              });
            } catch (_error) { /* fermeture du panneau natif */ }
          });
        }
      }
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  window.addEventListener('pjax:load', init);
})();
