'use strict';

/**
 * Enveloppe HTML commune : <head>, navigation, pied de page, config injectée.
 * Toutes les pages sont rendues ici pour garder une seule source de vérité.
 * Aucun emoji : les pictogrammes sont des SVG dessinés à la main.
 */

import { APP_NAME, APP_VERSION, maxFileSizeHuman, resolveBaseUrl } from './params.mjs';
import { formatBytes } from './util.mjs';

const ICONS = {
  upload: '<path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />',
  download: '<path d="M12 4v12m0 0 4.5-4.5M12 16l-4.5-4.5" /><path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" />',
  send: '<path d="M4.5 12 20 5l-5.5 15-3-6.5z" /><path d="M11.5 13.5 20 5" />',
  code: '<path d="M9 6 4 12l5 6M15 6l5 6-5 6" />',
  qr: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.6" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.6" /><path d="M14 14h2.5v2.5H14zM19 14h1.5M14 20.5h3M20.5 17.5v3" />',
  clock: '<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3.2 2" />',
  shield: '<path d="M12 3.5 5 6v6c0 4.2 3 7.2 7 8.5 4-1.3 7-4.3 7-8.5V6z" /><path d="m9 12 2.2 2.2L15.5 10" />',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2" /><path d="M15 9V6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15H9" />',
  trash: '<path d="M4.5 7h15M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.4h6a1.5 1.5 0 0 0 1.5-1.4l1-12" />',
  play: '<circle cx="12" cy="12" r="8.5" /><path d="M10.5 9.2v5.6l4.6-2.8z" />',
  sun: '<circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />',
  moon: '<path d="M19 14.5A7.5 7.5 0 0 1 9.5 5a7.5 7.5 0 1 0 9.5 9.5z" />',
  chevron: '<path d="m7 10 5 5 5-5" />',
  spark: '<path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />',
  server: '<rect x="4" y="4.5" width="16" height="6" rx="2" /><rect x="4" y="13.5" width="16" height="6" rx="2" /><path d="M8 7.5h.01M8 16.5h.01" />',
  link: '<path d="M10 13.5a3.5 3.5 0 0 0 5 0l3-3a3.54 3.54 0 0 0-5-5l-1 1" /><path d="M14 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.54 3.54 0 0 0 5 5l1-1" />',
  layers: '<path d="M12 3.5 4 8l8 4.5L20 8z" /><path d="m4 12.5 8 4.5 8-4.5" /><path d="m4 16.5 8 4.5 8-4.5" />',
  gauge: '<path d="M4 16a8 8 0 1 1 16 0" /><path d="m12 12 4-3" />',
  film: '<rect x="3.5" y="5" width="17" height="14" rx="2.4" /><path d="M3.5 9.5h17M3.5 14.5h17M8 5v14M16 5v14" />',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.4" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 17.5 4.8-4.3 3.2 2.6 3-2.6 4 3.8" />',
  users: '<circle cx="9" cy="9" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0" /><path d="M16 6.4a3.2 3.2 0 0 1 0 5.6M17.2 20a5.6 5.6 0 0 0-1.4-3.7" />',
  key: '<circle cx="8.5" cy="13.5" r="3.5" /><path d="m11.6 11 8-8M17 6.5l2 2M14.5 9l2 2" />',
  bolt: '<path d="M13.5 3.5 6 13.5h4.5L10 20.5 18 10h-4.8z" />'
};

export function icon(name, className = 'icon') {
  const body = ICONS[name] || ICONS.spark;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

const NAV_LINKS = [
  { href: '/', label: 'Accueil', key: 'home' },
  { href: '/upload', label: 'Envoyer', key: 'upload' },
  { href: '/receive', label: 'Recevoir', key: 'receive' },
  { href: '/dashboard', label: 'Mes liens', key: 'dashboard' },
  { href: '/help', label: 'Aide', key: 'help' }
];

export function publicContext(params, request) {
  const baseUrl = resolveBaseUrl(params, request);
  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    baseUrl,
    storageMode: params.storageMode,
    maxFileSizeBytes: params.maxFileSizeBytes,
    maxFileSizeHuman: maxFileSizeHuman(params),
    // Limite du mode « sans stockage objet » et limite théorique sans plafond,
    // pour expliquer les deux fonctionnements possibles sur Netlify.
    blobsLimitHuman: formatBytes(params.blobsObjectLimitBytes),
    maxFileSizeHumanUnlimited: formatBytes(params.maxFileSizeBytes ?? 0) === '0 o' ? '2 Go' : maxFileSizeHuman({ ...params, maxFileSizeBytes: null }),
    defaultTtlMinutes: params.defaultTtlMinutes,
    maxTtlMinutes: params.maxTtlMinutes,
    partSizeBytes: params.partSizeBytes,
    partSizeHuman: formatBytes(params.partSizeBytes),
    multipartThresholdBytes: params.multipartThresholdBytes,
    maxParallelUploads: params.maxParallelUploads,
    directUpload: params.directUpload,
    discordConfigured: params.discord.enabled,
    onNetlify: params.onNetlify
  };
}

function storageLabel(context) {
  if (context.storageMode === 's3') return 'Stockage objet (S3 / R2)';
  if (context.storageMode === 'local') return 'Stockage local du serveur';
  if (context.storageMode === 'blobs') return 'Netlify Blobs (sans configuration)';
  return 'Stockage non configuré';
}

export function renderLayout({
  params,
  request,
  title,
  description = 'Transfert temporaire de fichiers par code court et QR code.',
  active = '',
  body = '',
  pageClass = '',
  pageScript = '',
  bodyEnd = '',
  bare = false
}) {
  const context = publicContext(params, request);
  const json = JSON.stringify(context).replace(/</g, '\\u003c').replace(/-->/g, '--\\u003e');
  const assets = '/assets';

  const nav = bare
    ? ''
    : `
      <header class="topbar" id="topbar">
        <div class="topbar-inner">
          <a class="brand" href="/" aria-label="${APP_NAME} — accueil">
            <span class="brand-mark">${brandMark()}</span>
            <span class="brand-name">${APP_NAME}</span>
          </a>
          <nav class="nav" aria-label="Navigation principale">
            ${NAV_LINKS.map(
              (link) =>
                `<a href="${link.href}"${link.key === active ? ' class="is-active" aria-current="page"' : ''}>${link.label}</a>`
            ).join('')}
          </nav>
          <div class="topbar-actions">
            <button type="button" class="icon-button" id="themeToggle" aria-label="Changer de thème" title="Thème clair / sombre">
              <span class="theme-icon theme-icon-sun">${icon('sun')}</span>
              <span class="theme-icon theme-icon-moon">${icon('moon')}</span>
            </button>
            <a class="btn btn-small btn-primary" href="/upload">${icon('send')} Envoyer</a>
          </div>
        </div>
        <div class="scroll-progress" aria-hidden="true"><span id="scrollProgress"></span></div>
      </header>`;

  const footer = bare
    ? ''
    : `
      <footer class="footer">
        <div class="footer-inner">
          <div class="footer-brand">
            <span class="brand-mark small">${brandMark()}</span>
            <div>
              <strong>${APP_NAME}</strong>
              <p>Transferts temporaires. Les fichiers expirent et disparaissent seuls.</p>
            </div>
          </div>
          <div class="footer-cols">
            <div>
              <h3>Produit</h3>
              <a href="/upload">Envoyer un fichier</a>
              <a href="/receive">Recevoir avec un code</a>
              <a href="/dashboard">Mes liens</a>
            </div>
            <div>
              <h3>Ressources</h3>
              <a href="/help">Aide et déploiement</a>
              <a href="/api/health">État de l'API</a>
              <a href="/help#securite">Sécurité</a>
            </div>
            <div>
              <h3>Hébergement</h3>
              <span class="footer-chip" data-mode-chip>${storageLabel(context)}</span>
              <span class="footer-muted">Version ${APP_VERSION}</span>
            </div>
          </div>
        </div>
      </footer>`;

  return `<!doctype html>
<html lang="fr" data-theme="auto" data-mode="${context.storageMode}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ${APP_NAME}</title>
  <meta name="description" content="${description}">
  <meta name="theme-color" content="#fbf5ea" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0d1a17" media="(prefers-color-scheme: dark)">
  <link rel="icon" href="${assets}/favicon.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,900&family=Outfit:wght@300;400;500;600;700&display=swap">
  <link rel="stylesheet" href="${assets}/styles.css?v=20">
  <script type="application/json" id="dropqrConfig">${json}</script>
  <script defer src="${assets}/app.js?v=20"></script>
  ${pageScript ? `<script defer src="${assets}/${pageScript}?v=20"></script>` : ''}
  <noscript><style>[data-reveal] { opacity: 1; transform: none; }</style></noscript>
</head>
<body class="page ${pageClass}">
  <a class="skip-link" href="#main">Aller au contenu</a>
  ${nav}
  <main id="main">
${body}
  </main>
  ${footer}
  <div class="toasts" id="toasts" role="status" aria-live="polite"></div>
  ${bodyEnd}
</body>
</html>`;
}

/** Marque géométrique : cercle cuivre + carré jade + point jaune. */
export function brandMark() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="13" cy="13" r="8.5" fill="var(--mark-copper)"></circle>
    <rect x="18" y="18" width="10" height="10" rx="2.5" fill="var(--mark-jade)"></rect>
    <circle cx="23.5" cy="8.5" r="4" fill="var(--mark-marigold)"></circle>
  </svg>`;
}
