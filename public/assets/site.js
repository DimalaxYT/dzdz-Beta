
const pjaxCache = new Map();
const pjaxParser = window.DOMParser ? new DOMParser() : null;

const initSite = () => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const root = document.documentElement;

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

  const prefetchPage = async (href) => {
    if (prefetched.has(href)) return;
    prefetched.add(href);
    if (!pjaxParser) return;
    try {
      const res = await fetch(href, { credentials: 'same-origin', cache: 'force-cache' });
      if (res.ok) {
        const text = await res.text();
        const doc = pjaxParser.parseFromString(text, 'text/html');
        pjaxCache.set(href, doc);
      }
    } catch (e) {}
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
};

initSite();
window.addEventListener('pjax:load', initSite);

(() => {
  if (!pjaxParser) return;

  let isNavigating = false;

  const fetchPage = async (url) => {
    if (pjaxCache.has(url)) return pjaxCache.get(url);
    try {
      const res = await fetch(url, { headers: { 'X-PJAX': 'true' } });
      if (!res.ok) throw new Error('Page not found');
      const text = await res.text();
      const doc = pjaxParser.parseFromString(text, 'text/html');
      pjaxCache.set(url, doc);
      return doc;
    } catch (e) {
      console.error('PJAX fetch error', e);
      return null;
    }
  };

  const navigate = async (url) => {
    if (isNavigating) return;
    isNavigating = true;

    document.documentElement.classList.add('pjax-loading');
    
    const doc = await fetchPage(url);
    if (!doc) {
      window.location.href = url; // Fallback
      return;
    }

    const main = document.querySelector('main');
    const newMain = doc.querySelector('main');
    
    if (main && newMain) {
      // Swap contents instantly
      document.body.className = doc.body.className;
      document.title = doc.title;
      document.querySelector('.shell').replaceChild(newMain, main);
      
      const newNav = doc.querySelector('.topbar');
      const oldNav = document.querySelector('.topbar');
      if (newNav && oldNav) {
        oldNav.innerHTML = newNav.innerHTML;
      }

      const oldScripts = Array.from(document.querySelectorAll('script')).map(s => s.src.split('?')[0]);
      const newScripts = Array.from(doc.querySelectorAll('script'));
      
      for (const s of newScripts) {
        if (s.src) {
           const srcBase = s.src.split('?')[0];
           if (!oldScripts.includes(srcBase)) {
             const newScript = document.createElement('script');
             newScript.src = s.src;
             document.body.appendChild(newScript);
           }
        }
      }

      window.dispatchEvent(new Event('pjax:load'));
    } else {
      window.location.href = url;
    }

    document.documentElement.classList.remove('pjax-loading');
    isNavigating = false;
  };


  document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (!a || !a.href || a.target || a.hasAttribute('download')) return;

    const url = new URL(a.href);
    if (url.origin !== window.location.origin) return;
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/download') || url.pathname.startsWith('/view')) return;

    // Handle hash links on the SAME page
    if (url.pathname === window.location.pathname && url.hash) {
      // Allow default browser behavior for anchor jumps
      return; 
    }

    e.preventDefault();
    if (url.pathname !== window.location.pathname || url.search !== window.location.search) {
      history.pushState({}, '', url.href);
      navigate(url.href).then(() => {
        // After navigation finishes, handle scroll position
        if (url.hash) {
          const target = document.getElementById(url.hash.substring(1));
          if (target) target.scrollIntoView();
        } else {
          window.scrollTo(0, 0);
        }
      });
    } else {
        // If clicking same page without hash, just scroll to top
        window.scrollTo(0, 0);
    }
  });

  window.addEventListener('popstate', () => {
    navigate(window.location.href).then(() => {
      const url = new URL(window.location.href);
      if (url.hash) {
         const target = document.getElementById(url.hash.substring(1));
         if (target) target.scrollIntoView();
      } else {
         window.scrollTo(0, 0);
      }
    });
  });
})();
