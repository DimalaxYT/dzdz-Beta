(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;
  const parallaxItems = [...document.querySelectorAll('[data-parallax]')];
  const revealItems = [...document.querySelectorAll('.stat-card, .feature-card, .info-strip, .panel, .doc-section .card')];

  if (!reducedMotion) {
    root.classList.add('motion-ready');
    revealItems.forEach((item, index) => {
      item.classList.add('reveal-item');
      item.style.setProperty('--reveal-delay', `${Math.min(index, 8) * 45}ms`);
    });
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  if ('IntersectionObserver' in window && !reducedMotion) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    revealItems.forEach((item) => observer.observe(item));
  } else {
    revealItems.forEach((item) => item.classList.add('is-visible'));
  }

  if (reducedMotion || !parallaxItems.length) return;

  let frame = null;
  const updateParallax = () => {
    frame = null;
    const viewport = window.innerHeight || 1;
    parallaxItems.forEach((item) => {
      const speed = Number(item.dataset.speed || -0.08);
      const rect = item.getBoundingClientRect();
      const previous = parseFloat(item.style.getPropertyValue('--parallax-y')) || 0;
      const layoutTop = rect.top - previous;
      const rawDistance = (layoutTop + rect.height / 2 - viewport / 2) * speed;
      const distance = Math.max(-72, Math.min(72, rawDistance));
      item.style.setProperty('--parallax-y', `${distance.toFixed(2)}px`);
    });
  };

  const requestParallax = () => {
    if (frame === null) frame = window.requestAnimationFrame(updateParallax);
  };

  window.addEventListener('scroll', requestParallax, { passive: true });
  window.addEventListener('resize', requestParallax, { passive: true });
  window.addEventListener('pageshow', requestParallax, { passive: true });
  requestParallax();
})();
