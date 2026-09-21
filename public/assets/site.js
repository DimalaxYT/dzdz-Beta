(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const items = [...document.querySelectorAll('[data-parallax]')];
  if (reducedMotion || !items.length) return;

  let frame = null;
  const update = () => {
    frame = null;
    const viewport = window.innerHeight || 1;
    items.forEach((item) => {
      const speed = Number(item.dataset.speed || -0.08);
      const rect = item.getBoundingClientRect();
      const distance = (rect.top + rect.height / 2 - viewport / 2) * speed;
      item.style.setProperty('--parallax-y', `${distance.toFixed(2)}px`);
    });
  };

  const requestUpdate = () => {
    if (frame === null) frame = window.requestAnimationFrame(update);
  };

  window.addEventListener('scroll', requestUpdate, { passive: true });
  window.addEventListener('resize', requestUpdate, { passive: true });
  requestUpdate();
})();
