'use strict';

// Même coque pour les pages de réception et les messages rendus par le serveur.
const icon = (name, className = '') => `<svg class="icon ${className}" width="20" height="20" aria-hidden="true"><use href="/assets/icons.svg#${name}"></use></svg>`;

function header(active = '') {
  const current = (name) => active === name ? ' aria-current="page"' : '';
  return `  <a class="skip-link" href="#main">Aller au contenu</a>
  <header class="nv" id="nv">
    <a class="nv-brand" href="/" aria-label="DropQR, accueil"><img class="nv-logo" src="/assets/logo.svg?v=3" alt="" width="30" height="30"><span>DropQR</span></a>
    <nav class="nv-links" aria-label="Navigation principale">
      <a href="/"${current('home')}>Accueil</a>
      <a href="/dashboard"${current('dashboard')}>Transferts</a>
      <a href="/help"${current('help')}>Comment ça marche</a>
    </nav>
    <div class="nv-right">
      <nav class="nv-actions" aria-label="Partager un fichier">
        <a class="nv-action nv-send" href="/upload"${current('upload')}>${icon('upload')}<span>Envoyer</span></a>
        <a class="nv-action nv-receive" href="/receive"${current('receive')}>${icon('download')}<span>Recevoir</span></a>
      </nav>
      <details class="nv-menu">
        <summary aria-label="Menu de navigation">${icon('menu')}</summary>
        <div class="nv-menu-panel">
          <p class="menu-label">À portée de main</p>
          <nav aria-label="Menu complémentaire">
            <a href="/"${current('home')}>Accueil ${icon('arrow-right')}</a>
            <a href="/dashboard"${current('dashboard')}>Mes transferts ${icon('arrow-right')}</a>
            <a href="/help"${current('help')}>Aide ${icon('arrow-right')}</a>
            <a href="/mentions"${current('mentions')}>Mentions et confidentialité ${icon('arrow-right')}</a>
          </nav>
          <div class="nav-auth" data-discord-auth></div>
        </div>
      </details>
    </div>
  </header>`;
}

function footer() {
  return `  <footer class="site-footer">
    <a class="foot-brand" href="/">DropQR<span class="signal-square" aria-hidden="true"></span></a>
    <nav aria-label="Application">
      <a href="/upload">Envoyer</a><a href="/receive">Recevoir</a><a href="/dashboard">Transferts</a><a href="/help">Aide</a><a href="/mentions">Mentions légales</a>
      <a data-discord-contact href="#" hidden>Discord</a>
    </nav>
    <span class="colophon">Un fichier. Un lien. C’est partagé.</span>
  </footer>`;
}

function head(title, description = '') {
  // title et description doivent déjà être échappés pour HTML.
  return `<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#08090b">
  <meta name="color-scheme" content="dark light">
${description ? `  <meta name="description" content="${description}">\n` : ''}  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg?v=3">
  <title>${title} — DropQR</title>
  <script src="/assets/experience.js?v=4"></script>
  <link rel="stylesheet" href="/assets/landing.css?v=4">
</head>`;
}

function page({ title, content, active = '', scripts = '', description = '', className = 'page-sub', staticPage = false }) {
  return `<!doctype html>
<html lang="fr">
${head(title, description)}
<body class="${className}"${staticPage ? ' data-static-page' : ''}>
${header(active)}
  <div class="shell">
    <main id="main" tabindex="-1">
${content}
    </main>
  </div>
${footer()}
  <script src="/assets/site.js?v=16" defer></script>
${scripts}
</body>
</html>\n`;
}

module.exports = { icon, header, footer, head, page };
