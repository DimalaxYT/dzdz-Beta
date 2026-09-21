(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

  // L'ancien tableau de bord local n'existe plus: les anciennes entrées
  // éventuelles sont supprimées pour ne pas laisser d'historique côté navigateur.
  try { localStorage.removeItem('dropqr.transfers'); } catch (_error) {}

  const contactLinks = [...document.querySelectorAll('[data-discord-contact]')];
  const maxSizeLabels = [...document.querySelectorAll('[data-max-file-size]')];
  if (contactLinks.length || maxSizeLabels.length) {
    fetch('/api/config', { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : null)
      .then((config) => {
        if (!config) return;
        if (config.discordContactUrl) {
          contactLinks.forEach((link) => {
            link.href = config.discordContactUrl;
            link.hidden = false;
            link.textContent = 'Discord';
          });
        }
        if (config.maxFileSizeHuman) {
          maxSizeLabels.forEach((label) => { label.textContent = config.maxFileSizeHuman; });
        }
      })
      .catch(() => {});
  }

  const parallaxItems = [...document.querySelectorAll('[data-parallax]')];
  const revealItems = [...document.querySelectorAll('.stat-card, .feature-card, .info-strip, .doc-section .card')];

  if (!reducedMotion) {
    root.classList.add('motion-ready');
    const firstViewport = window.innerHeight * .92;
    revealItems.forEach((item, index) => {
      item.classList.add('reveal-item');
      item.style.setProperty('--reveal-delay', `${Math.min(index, 8) * 35}ms`);
      if (item.getBoundingClientRect().top < firstViewport) item.classList.add('is-visible');
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

  const prefetched = new Set();
  const internalLinks = [...document.querySelectorAll('a[href]')]
    .map((link) => ({ link, href: link.getAttribute('href') }))
    .filter(({ link, href }) => href && href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/api/') && !href.startsWith('#') && !link.target)
    .filter(({ href }, index, links) => links.findIndex((entry) => entry.href === href) === index);

  const prefetchPage = (href) => {
    if (prefetched.has(href)) return;
    prefetched.add(href);
    // fetch() remplit le cache HTTP utilisé par la navigation normale,
    // y compris dans les navigateurs qui ignorent rel=prefetch.
    fetch(href, { credentials: 'same-origin', cache: 'force-cache' }).catch(() => {});
  };

  internalLinks.forEach(({ link, href }) => {
    link.addEventListener('pointerenter', () => prefetchPage(href), { passive: true });
  });

  const warmNavigation = () => {
    internalLinks.forEach(({ href }, index) => {
      window.setTimeout(() => prefetchPage(href), index * 90);
    });
  };
  if ('requestIdleCallback' in window) window.requestIdleCallback(warmNavigation, { timeout: 900 });
  else window.setTimeout(warmNavigation, 250);

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
