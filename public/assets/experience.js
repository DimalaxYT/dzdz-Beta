/* Petite détection synchrone, avant le CSS. Aucun moteur 3D n'est chargé ici. */
(() => {
  'use strict';
  const root = document.documentElement;
  const narrow = window.matchMedia('(max-width: 820px)');
  const coarse = window.matchMedia('(pointer: coarse)');
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const connection = navigator.connection;
  const ua = navigator.userAgent || '';
  const mobileDevice = Boolean(navigator.userAgentData?.mobile)
    || /Android|iPhone|iPad|iPod|IEMobile|Opera Mini/i.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const override = new URLSearchParams(location.search).get('3d');

  function update() {
    // L'identité de l'appareil reste valable en paysage. Une fenêtre de PC
    // étroite reçoit aussi la composition tactile, sans être prise pour un PC puissant.
    const mobile = mobileDevice || narrow.matches || (coarse.matches && window.innerWidth <= 1024);
    const constrained = Boolean(connection?.saveData) || (navigator.deviceMemory > 0 && navigator.deviceMemory <= 2);
    const enable3D = !motion.matches && override !== '0'
      && (override === '1' || (!mobile && !constrained));
    const previous = window.DropQRExperience;
    window.DropQRExperience = Object.freeze({ mobile, mobileDevice, reducedMotion: motion.matches, enable3D });
    root.classList.toggle('is-mobile', mobile);
    root.classList.toggle('is-desktop', !mobile);
    root.classList.toggle('reduce-motion', motion.matches);
    root.classList.toggle('flat-mode', !enable3D);
    const theme = document.querySelector('meta[name="theme-color"]');
    if (theme) theme.content = mobile ? '#F7F7F3' : '#08090b';
    if (previous && (previous.mobile !== mobile || previous.enable3D !== enable3D || previous.reducedMotion !== motion.matches)) {
      window.dispatchEvent(new CustomEvent('dropqr:experience-change', { detail: window.DropQRExperience }));
    }
  }

  update();
  for (const query of [narrow, coarse, motion]) {
    if (query.addEventListener) query.addEventListener('change', update);
    else query.addListener(update);
  }
  connection?.addEventListener?.('change', update);
})();
