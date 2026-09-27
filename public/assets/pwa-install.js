/* DropQR — installation de la web app (PWA)
   - ajoute le bouton "Télécharger l'app" dans la barre de navigation
   - desktop Chrome/Edge : vraie install prompt via beforeinstallprompt
   - autres navigateurs : instructions (iOS / Android / menu du navigateur)
*/
(function () {
  'use strict';

  var deferredPrompt = null;
  var BTN_LABEL_INSTALL = '⬇ Télécharger l\u2019app';

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: window-controls-overlay)').matches ||
      navigator.standalone === true
    );
  }

  function platformHint() {
    var ua = navigator.userAgent || '';
    var iOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var android = /Android/.test(ua);
    var desktop = !iOS && !android;
    return { iOS: iOS, android: android, desktop: desktop };
  }

  /* ---------- Overlay d'aide (fallback quand pas de beforeinstallprompt) ---------- */

  function removeOverlay() {
    var el = document.getElementById('pwa-help-overlay');
    if (el) el.remove();
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) {
    if (e.key === 'Escape') removeOverlay();
  }

  function buildInstructions() {
    var p = platformHint();
    var steps;
    if (p.iOS) {
      steps = [
        'Ouvre cette page dans <strong>Safari</strong>.',
        'Touche le bouton <strong>Partager</strong> <span class="pwa-kbd">(carré avec une flèche vers le haut)</span>.',
        'Choisis <strong>« Sur l\u2019écran d\u2019accueil »</strong>.',
        'Valide avec <strong>Ajouter</strong> : DropQR apparaît comme une application.'
      ];
    } else if (p.android) {
      steps = [
        'Ouvre le <strong>menu ⋮</strong> de Chrome (en haut à droite).',
        'Choisis <strong>« Ajouter à l\u2019écran d\u2019accueil »</strong> ou <strong>« Installer l\u2019application »</strong>.',
        'Confirme : DropQR s\u2019installe comme une app autonome.'
      ];
    } else {
      steps = [
        'Dans Chrome ou Edge, clique sur l\u2019<strong>icône d\u2019installation</strong> <span class="pwa-kbd">(petit écran + ➕)</span> dans la barre d\u2019adresse.',
        'Ou ouvre le <strong>menu ⋯</strong> puis <strong>« Installer DropQR »</strong> / <strong>« Applications » → « Installer ce site comme application »</strong>.',
        'L\u2019app s\u2019ouvre dans sa propre fenêtre, sans barre d\u2019onglets.'
      ];
    }
    return steps;
  }

  function showHelpOverlay() {
    removeOverlay();
    var wrap = document.createElement('div');
    wrap.id = 'pwa-help-overlay';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Installer DropQR');
    var stepsHtml = buildInstructions()
      .map(function (s, i) { return '<li><span class="pwa-step-num">' + (i + 1) + '</span><span>' + s + '</span></li>'; })
      .join('');
    wrap.innerHTML =
      '<div class="pwa-help-card">' +
        '<div class="pwa-help-head">' +
          '<img src="/assets/logo.svg?v=11" alt="" aria-hidden="true">' +
          '<h3>Installer DropQR</h3>' +
          '<button type="button" class="pwa-help-close" aria-label="Fermer">✕</button>' +
        '</div>' +
        '<p class="pwa-help-lead">Ton navigateur ne propose pas l\u2019installation automatique ici. En quelques secondes :</p>' +
        '<ol class="pwa-help-steps">' + stepsHtml + '</ol>' +
        '<p class="pwa-help-note">Une fois installée, DropQR s\u2019ouvre en plein écran, comme une vraie application.</p>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', function (e) {
      if (e.target === wrap || e.target.closest('.pwa-help-close')) removeOverlay();
    });
    document.addEventListener('keydown', onEsc);
  }

  /* ---------- Bouton dans la topbar ---------- */

  function setBtnState(btn, state) {
    if (state === 'installed') {
      btn.textContent = '✓ App installée';
      btn.classList.add('installed');
      btn.disabled = true;
    } else {
      btn.textContent = BTN_LABEL_INSTALL;
      btn.classList.remove('installed');
      btn.disabled = false;
    }
  }

  function onClickInstall() {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function (choice) {
        if (choice.outcome === 'accepted') {
          var btn = document.getElementById('pwa-install-btn');
          if (btn) setBtnState(btn, 'installed');
        }
        deferredPrompt = null;
      });
    } else {
      showHelpOverlay();
    }
  }

  function injectButton() {
    if (document.getElementById('pwa-install-btn')) return;
    var nav = document.querySelector('.nav-links');
    if (!nav) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'pwa-install-btn';
    btn.className = 'btn primary pwa-install-nav';
    btn.addEventListener('click', onClickInstall);
    if (isStandalone()) {
      setBtnState(btn, 'installed');
    } else {
      btn.textContent = BTN_LABEL_INSTALL;
    }
    nav.appendChild(btn);
  }

  /* ---------- Événements PWA ---------- */

  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredPrompt = e;
    injectButton();
    var btn = document.getElementById('pwa-install-btn');
    if (btn) setBtnState(btn, 'ready');
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    var btn = document.getElementById('pwa-install-btn');
    if (btn) setBtnState(btn, 'installed');
    removeOverlay();
  });

  // Toujours afficher le bouton (même sans beforeinstallprompt) pour proposer le mode aide
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectButton);
  } else {
    injectButton();
  }
})();
