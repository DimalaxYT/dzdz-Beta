'use strict';

/**
 * Pages publiques. Le markup est volontairement riche en points d'accroche
 * (`data-parallax`, `data-tilt`, `data-reveal`, `data-count-to`) pour que
 * app.js puisse brancher les widgets, animations et effets sans framework.
 */

import { APP_NAME, APP_VERSION, maxFileSizeHuman } from './params.mjs';
import { escapeHtml, formatBytes, humanLabel } from './util.mjs';
import { icon, publicContext, renderLayout } from './layout.mjs';

const HERO_IMAGE = '/img/hero-collage.jpg';

function modeNotice(params) {
  if (params.storageMode !== 'unavailable') return '';
  return `
    <aside class="banner banner-warn" role="note">
      ${icon('server')}
      <div>
        <strong>Stockage non configuré sur ce déploiement.</strong>
        <p>Le site est en ligne, mais aucun espace de stockage n'est branché : les envois seront refusés.
        Ajoute les variables Cloudflare R2 (ou lance le projet en serveur Node) — tout est expliqué dans
        <a href="/help#netlify">le guide Netlify</a>.</p>
      </div>
    </aside>`;
}

/* --------------------------------- accueil -------------------------------- */

export function renderHome({ params, request, qrSvg }) {
  const context = publicContext(params, request);

  const body = `
    <section class="hero">
      <div class="hero-decor" aria-hidden="true">
        <span class="blob blob-copper" data-parallax data-speed="0.16"></span>
        <span class="blob blob-jade" data-parallax data-speed="0.28"></span>
        <span class="grid-lines"></span>
      </div>
      <div class="shell hero-inner">
        <div class="hero-copy">
          <span class="chip chip-live" data-reveal><span class="pulse-dot" aria-hidden="true"></span> Transfert direct, sans compte, sans cloud permanent</span>
          <h1 data-reveal data-delay="60">Un code court.<br><em>Un QR code.</em><br>Le fichier est parti.</h1>
          <p class="lead" data-reveal data-delay="120">DropQR envoie ton fichier directement vers le stockage objet, affiche un code de sept caractères et un QR code, puis le supprime à l'expiration ou après le premier téléchargement.</p>
          <div class="hero-actions" data-reveal data-delay="180">
            <a class="btn btn-primary btn-large" href="/upload">${icon('send')} Envoyer un fichier</a>
            <a class="btn btn-ghost btn-large" href="/receive">${icon('download')} Recevoir avec un code</a>
          </div>
          <ul class="hero-facts" data-reveal data-delay="240">
            <li><span class="fact-value">${escapeHtml(context.maxFileSizeHuman)}</span><span class="fact-label">par transfert</span></li>
            <li><span class="fact-value" data-count-to="${context.partSizeBytes / 1024 / 1024}" data-count-suffix=" Mo">${context.partSizeHuman}</span><span class="fact-label">par morceau parallèle</span></li>
            <li><span class="fact-value">${escapeHtml(String(context.maxTtlMinutes / 60))} h</span><span class="fact-label">durée maximale</span></li>
          </ul>
        </div>

        <div class="hero-visual" data-reveal data-delay="140">
          <figure class="hero-media" data-parallax data-speed="-0.08">
            <img src="${HERO_IMAGE}" alt="Composition de formes de papier coloré : cercles, arcs et rubans superposés" width="1408" height="768" fetchpriority="high">
          </figure>

          <article class="widget widget-qr" data-tilt>
            <header class="widget-head">
              <span class="widget-title">${icon('qr')} QR de démonstration</span>
              <span class="chip chip-soft">/r/…</span>
            </header>
            <div class="qr-frame">
              <span class="qr-sweep" aria-hidden="true"></span>
              ${qrSvg || ''}
            </div>
            <p class="widget-foot">Ce QR ouvre la page de dépôt sur ton téléphone.</p>
          </article>

          <article class="widget widget-meter" data-tilt data-delay="80">
            <header class="widget-head">
              <span class="widget-title">${icon('gauge')} Envoi en morceaux</span>
              <span class="chip chip-jade">${context.maxParallelUploads} flux</span>
            </header>
            <div class="meter-demo" aria-hidden="true">
              <span class="meter-bar" style="--progress: 0.72"></span>
            </div>
            <div class="meter-stats">
              <span><strong>72 %</strong> envoyé</span>
              <span>reprise possible</span>
            </div>
          </article>
        </div>
      </div>
    </section>

    <div class="marquee" aria-hidden="true">
      <div class="marquee-track">
        ${(() => {
          const headline = [
            `Jusqu'à ${context.maxFileSizeHuman} par transfert`,
            'Upload parallèle',
            'QR code instantané',
            'Expiration automatique',
            'Suppression après téléchargement',
            'Vidéos et images en lecture directe',
            'Aucun compte à créer',
            'Netlify, Railway ou ton VPS',
            'Reprise après coupure',
            'Code court à dicter',
            'Stockage objet compatible S3',
            'Notification Discord',
            'Interface responsive'
          ];
          // Le contenu est répété deux fois : le défilement boucle sans à-coup.
          return [false, true]
            .map((hidden) => headline.map((label) => `<span class="marquee-item"${hidden ? ' aria-hidden="true"' : ''}>${icon('spark')} ${escapeHtml(label)}</span>`).join(''))
            .join('');
        })()}
      </div>
    </div>

    <section class="section shell" id="comment">
      <header class="section-head">
        <span class="eyebrow">Comment ça marche</span>
        <h2>Trois temps, aucun compte à créer.</h2>
        <p class="section-lead">Les octets voyagent du navigateur vers le stockage objet, sans jamais passer par une fonction serverless — c'est ce qui permet les gros fichiers sur un hébergement gratuit.</p>
      </header>
      <ol class="steps">
        <li class="step" data-reveal>
          <span class="step-index">01</span>
          <span class="step-icon">${icon('upload')}</span>
          <h3>Tu déposes le fichier</h3>
          <p>Le navigateur découpe le fichier en morceaux de ${context.partSizeHuman}, les envoie en parallèle et affiche une vitesse réelle.</p>
        </li>
        <li class="step" data-reveal data-delay="90">
          <span class="step-index">02</span>
          <span class="step-icon">${icon('code')}</span>
          <h3>Tu reçois un code</h3>
          <p>Un code de sept caractères et un QR code apparaissent. Tu les dictes, tu les colles ou tu les photographies.</p>
        </li>
        <li class="step" data-reveal data-delay="180">
          <span class="step-index">03</span>
          <span class="step-icon">${icon('shield')}</span>
          <h3>Le fichier disparaît</h3>
          <p>Suppression après le premier téléchargement ou à l'expiration, au choix. Une clé privée permet aussi de supprimer à la main.</p>
        </li>
      </ol>
    </section>

    <section class="section shell" id="widgets">
      <header class="section-head">
        <span class="eyebrow">Dans l'interface</span>
        <h2>Des widgets qui montrent ce qui se passe.</h2>
      </header>
      <div class="widget-grid">
        <article class="card card-tilt" data-tilt data-reveal>
          <span class="card-icon">${icon('gauge')}</span>
          <h3>Progression réelle</h3>
          <p>Anneau de progression, débit instantané, courbe de vitesse et temps restant estimé pendant l'envoi.</p>
        </article>
        <article class="card card-tilt" data-tilt data-reveal data-delay="70">
          <span class="card-icon">${icon('qr')}</span>
          <h3>QR vectoriel</h3>
          <p>Le QR est dessiné en SVG : net à toutes les tailles, imprimable, et fonctionne sans connexion supplémentaire.</p>
        </article>
        <article class="card card-tilt" data-tilt data-reveal data-delay="140">
          <span class="card-icon">${icon('clock')}</span>
          <h3>Compte à rebours</h3>
          <p>Chaque transfert affiche son temps restant en jours, heures, minutes et secondes, mis à jour en direct.</p>
        </article>
        <article class="card card-tilt" data-tilt data-reveal data-delay="210">
          <span class="card-icon">${icon('link')}</span>
          <h3>Liens suivis</h3>
          <p>La page Mes liens garde tes transferts dans le navigateur, avec l'état réel côté serveur et la suppression à distance.</p>
        </article>
        <article class="card card-tilt" data-tilt data-reveal data-delay="280">
          <span class="card-icon">${icon('film')}</span>
          <h3>Lecture directe</h3>
          <p>Vidéos et sons se lisent dans la page, avec requêtes partielles : pas besoin de tout télécharger pour avancer.</p>
        </article>
        <article class="card card-tilt" data-tilt data-reveal data-delay="350">
          <span class="card-icon">${icon('layers')}</span>
          <h3>Deux hébergements</h3>
          <p>Netlify en fonctions serverless avec stockage objet, ou serveur Node autonome : le même code, deux modes.</p>
        </article>
      </div>
    </section>

    <section class="section shell split">
      <figure class="split-media" data-parallax data-speed="-0.05">
        <img src="/img/devices.jpg" alt="Deux silhouettes d'appareils échangeant un document" width="1408" height="768" loading="lazy">
      </figure>
      <div class="split-copy">
        <span class="eyebrow">Entre deux appareils</span>
        <h2>Du PC au téléphone, sans câble ni compte.</h2>
        <ul class="check-list">
          <li>${icon('download')} Le téléphone scanne le QR : la page de téléchargement s'ouvre directement sur le fichier.</li>
          <li>${icon('key')} Une clé de suppression est remise à l'envoyeur, et à lui seul.</li>
          <li>${icon('shield')} Les noms de fichiers sont nettoyés et les contenus dangereux neutralisés avant d'être servis.</li>
          <li>${icon('bolt')} Aucune inscription, aucune publicité, aucune trace au-delà de l'expiration.</li>
        </ul>
        <div class="split-actions">
          <a class="btn btn-primary" href="/upload">Créer un transfert</a>
          <a class="btn btn-quiet" href="/help">Voir le guide de déploiement</a>
        </div>
      </div>
    </section>

    <section class="section shell" id="faq">
      <header class="section-head">
        <span class="eyebrow">Questions fréquentes</span>
        <h2>Ce qu'on demande le plus souvent.</h2>
      </header>
      <div class="accordion" data-accordion>
        ${[
          {
            q: "Combien de temps un fichier reste-t-il en ligne ?",
            a: `Par défaut ${params.defaultTtlMinutes} minutes, jusqu'à ${Math.round(params.maxTtlMinutes / 60)} heures au maximum. Le décompte démarre à l'envoi et le fichier est supprimé automatiquement, même si personne ne l'a téléchargé.`
          },
          {
            q: 'Pourquoi écrire le fichier en morceaux ?',
            a: `Les hébergeurs serverless refusent les requêtes volumineuses : une fonction Netlify plafonne à 6 Mo par appel. Découper en morceaux de ${context.partSizeHuman} et les envoyer en parallèle contourne cette limite et permet de reprendre après une coupure.`
          },
          {
            q: 'Faut-il un compte pour recevoir ?',
            a: "Non. La personne qui reçoit ouvre le lien, saisit le code à sept caractères ou scanne le QR, puis télécharge. Aucune inscription, aucune application."
          },
          {
            q: 'Où sont stockés les fichiers ?',
            a: "Sur le stockage objet compatible S3 que tu branches (Cloudflare R2, Backblaze B2, AWS S3, MinIO) ou, en mode serveur Node, sur le disque de la machine. Les métadonnées sont minuscules : identifiant, code, expiration, compteur."
          },
          {
            q: 'Que se passe-t-il si l\'envoi est interrompu ?',
            a: "Les morceaux déjà reçus restent six heures au maximum côté stockage, puis sont purgés. Tu peux relancer l'envoi : les morceaux manquants sont renvoyés, les URL pré-signées étant régénérées à la demande."
          }
        ]
          .map(
            (item, index) => `
          <details class="accordion-item"${index === 0 ? ' open' : ''}>
            <summary>${escapeHtml(item.q)}${icon('chevron', 'icon accordion-chevron')}</summary>
            <div class="accordion-body"><p>${escapeHtml(item.a)}</p></div>
          </details>`
          )
          .join('')}
      </div>
    </section>

    <section class="cta-band">
      <div class="cta-bg" data-parallax data-speed="0.1" aria-hidden="true">
        <img src="/img/dark-ribbon.jpg" alt="" width="1584" height="672" loading="lazy">
      </div>
      <div class="shell cta-inner">
        <div>
          <span class="eyebrow eyebrow-light">Prêt en trente secondes</span>
          <h2>Envoie ton premier fichier maintenant.</h2>
          <p>Aucune inscription. Le lien expire tout seul, et le fichier part avec lui.</p>
        </div>
        <div class="cta-actions">
          <a class="btn btn-primary btn-large" href="/upload">${icon('send')} Ouvrir l'envoi</a>
          <a class="btn btn-outline-light btn-large" href="/receive">${icon('code')} J'ai un code</a>
        </div>
      </div>
    </section>`;

  return renderLayout({
    params,
    request,
    title: 'Transfert de fichiers par code et QR',
    description:
      'DropQR envoie tes fichiers directement vers un stockage objet, génère un code court et un QR code, puis les supprime automatiquement.',
    active: 'home',
    pageClass: 'page-home',
    body,
    bodyEnd: modeNotice(params)
  });
}

/* ---------------------------------- envoi --------------------------------- */

export function renderUpload({ params, request }) {
  const context = publicContext(params, request);
  const ttlOptions = [10, 30, 60, 180, 720, 1440].filter((minutes) => minutes <= params.maxTtlMinutes);

  const body = `
    <section class="page-head shell">
      <div>
        <span class="eyebrow">Envoyer</span>
        <h1 class="page-title">Dépose, choisis la durée, partage le code.</h1>
        <p class="lead">Le fichier part directement vers le stockage : ni compte, ni étape intermédiaire. Un seul fichier par transfert.</p>
      </div>
      <ul class="stat-row">
        <li><strong>${escapeHtml(context.maxFileSizeHuman)}</strong><span>limite par fichier</span></li>
        <li><strong>${context.maxParallelUploads} flux</strong><span>en parallèle</span></li>
        <li><strong>${escapeHtml(context.partSizeHuman)}</strong><span>par morceau</span></li>
      </ul>
    </section>

    <div class="shell layout-2col">
      <section class="panel" aria-labelledby="sendTitle">
        <header class="panel-head">
          <h2 id="sendTitle" class="panel-title">${icon('upload')} Nouveau transfert</h2>
          <span class="chip chip-soft" id="modeChip">${escapeHtml(modeLabel(context))}</span>
        </header>

        <form id="uploadForm" class="upload-form">
          <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="Choisir un fichier à envoyer">
            <span class="dropzone-ring" aria-hidden="true"></span>
            <span class="dropzone-icon">${icon('upload')}</span>
            <span class="dropzone-title" id="dropTitle">Dépose ton fichier ici</span>
            <span class="dropzone-subtitle" id="dropSubtitle">ou clique pour le choisir. Vidéos, images, archives, documents.</span>
            <input type="file" id="fileInput" name="file" hidden>
          </div>

          <div class="file-chip" id="fileChip" hidden>
            <span class="file-chip-icon">${icon('layers')}</span>
            <span class="file-chip-body">
              <strong id="fileChipName">—</strong>
              <small id="fileChipSize">—</small>
            </span>
            <button type="button" class="icon-button" id="clearFile" aria-label="Retirer le fichier">${icon('trash')}</button>
          </div>

          <div class="field-row">
            <label class="field">
              <span class="field-label">${icon('clock')} Durée de vie</span>
              <select id="ttlMinutes" name="ttlMinutes">
                ${ttlOptions
                  .map(
                    (minutes) =>
                      `<option value="${minutes}"${minutes === params.defaultTtlMinutes ? ' selected' : ''}>${
                        minutes >= 1440 ? `${minutes / 1440} jour${minutes > 1440 ? 's' : ''}` : minutes >= 60 ? `${minutes / 60} heure${minutes > 60 ? 's' : ''}` : `${minutes} minutes`
                      }</option>`
                  )
                  .join('')}
              </select>
            </label>

            <label class="field switch-field">
              <span class="field-label">${icon('shield')} Suppression</span>
              <span class="switch">
                <input type="checkbox" id="deleteAfterDownload" checked>
                <span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span>
                <span class="switch-text">Après le premier téléchargement</span>
              </span>
            </label>
          </div>

          <button type="submit" class="btn btn-primary btn-block btn-large" id="sendButton" disabled>
            ${icon('send')} <span id="sendLabel">Envoyer le fichier</span>
          </button>
          <p class="status" id="status" role="status"></p>
        </form>

        <section class="progress-card" id="progressCard" hidden aria-live="polite">
          <div class="progress-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="ring-track" cx="60" cy="60" r="52"></circle>
              <circle class="ring-value" cx="60" cy="60" r="52" id="progressRing"></circle>
            </svg>
            <span class="ring-label" id="progressPercent">0 %</span>
          </div>
          <div class="progress-body">
            <div class="progress-head">
              <strong id="progressLabel">Envoi en cours</strong>
              <span id="progressEta" class="chip chip-soft">estimation…</span>
            </div>
            <div class="bar"><span class="bar-fill" id="progressBar"></span></div>
            <div class="progress-stats">
              <span id="progressLoaded">0 o / 0 o</span>
              <span id="progressSpeed">—</span>
            </div>
            <canvas class="sparkline" id="sparkline" width="520" height="90" aria-hidden="true"></canvas>
          </div>
        </section>
      </section>

      <section class="panel panel-result" id="result" hidden aria-labelledby="resultTitle">
        <header class="panel-head">
          <h2 id="resultTitle" class="panel-title">${icon('qr')} Transfert prêt</h2>
          <span class="chip chip-jade" id="resultStatus">en ligne</span>
        </header>

        <div class="result-grid">
          <div class="qr-block">
            <div class="qr-frame qr-frame-light" id="qrHolder"></div>
            <button type="button" class="btn btn-quiet btn-block" id="downloadQr">${icon('download')} Télécharger le QR</button>
          </div>

          <div class="result-body">
            <div class="code-block">
              <span class="code-label">Code à dicter</span>
              <div class="code-slots" id="resultCodeSlots"></div>
              <button type="button" class="btn btn-ghost btn-small" id="copyCode">${icon('copy')} Copier le code</button>
            </div>

            <dl class="result-meta">
              <div><dt>Fichier</dt><dd id="resultName">—</dd></div>
              <div><dt>Taille</dt><dd id="resultSize">—</dd></div>
              <div><dt>Expire le</dt><dd id="resultExpiry">—</dd></div>
              <div><dt>Nettoyage</dt><dd id="resultCleanup">—</dd></div>
              <div><dt>Discord</dt><dd id="resultDiscord">—</dd></div>
            </dl>

            <div class="countdown" id="countdown" data-countdown aria-label="Temps restant">
              <span class="countdown-unit"><strong data-unit="days">0</strong><small>j</small></span>
              <span class="countdown-unit"><strong data-unit="hours">00</strong><small>h</small></span>
              <span class="countdown-unit"><strong data-unit="minutes">00</strong><small>min</small></span>
              <span class="countdown-unit"><strong data-unit="seconds">00</strong><small>s</small></span>
            </div>

            <div class="share-row">
              <input class="share-input" id="shareLink" readonly value="">
              <button type="button" class="btn btn-primary" id="copyLink">${icon('copy')} Copier</button>
            </div>
            <div class="result-actions">
              <a class="btn btn-ghost" id="openLink" href="#" target="_blank" rel="noopener">${icon('link')} Ouvrir la page</a>
              <a class="btn btn-ghost" id="downloadFile" href="#">${icon('download')} Télécharger</a>
              <button type="button" class="btn btn-quiet" id="newTransfer">${icon('spark')} Nouveau transfert</button>
            </div>
            <p class="status" id="resultStatusText"></p>
          </div>
        </div>
      </section>

      <section class="panel panel-empty" id="emptyState">
        <figure class="empty-media" data-parallax data-speed="-0.04">
          <img src="/img/paper-texture.jpg" alt="Papier texturé et cercle de cuivre embossé" width="1408" height="768" loading="lazy">
        </figure>
        <div class="empty-copy">
          <h2 class="panel-title">Rien n'est encore parti</h2>
          <p>Choisis un fichier à gauche : la progression, le code et le QR code apparaîtront ici. Les envois restent visibles dans <a href="/dashboard">Mes liens</a>.</p>
          <ul class="mini-list">
            <li>${icon('bolt')} Envoi direct vers le stockage objet, sans passer par une fonction serverless.</li>
            <li>${icon('shield')} Clé de suppression privée remise au navigateur qui a envoyé le fichier.</li>
            <li>${icon('film')} Les vidéos se lisent directement dans la page de réception.</li>
          </ul>
        </div>
      </section>
    </div>`;

  return renderLayout({
    params,
    request,
    title: 'Envoyer un fichier',
    description: 'Dépose un fichier, choisis sa durée de vie, récupère un code court et un QR code.',
    active: 'upload',
    pageClass: 'page-upload',
    pageScript: 'upload.js',
    body,
    bodyEnd: modeNotice(params)
  });
}

function modeLabel(context) {
  if (context.storageMode === 's3') return context.onNetlify ? 'Netlify + stockage objet' : 'Stockage objet';
  if (context.storageMode === 'local') return 'Serveur Node, disque local';
  if (context.storageMode === 'blobs') return 'Netlify Blobs, sans configuration';
  return 'Stockage non configuré';
}

/* -------------------------------- réception ------------------------------- */

export function renderReceive({ params, request }) {
  const body = `
    <section class="page-head shell">
      <div>
        <span class="eyebrow">Recevoir</span>
        <h1 class="page-title">Saisis le code, le fichier arrive.</h1>
        <p class="lead">Sept caractères, sans tiret ni espace. Le collage fonctionne aussi : les caractères non reconnus sont ignorés.</p>
      </div>
      <div class="page-head-widget" data-tilt>
        <span class="chip chip-soft">${icon('shield')} lien à durée limitée</span>
        <p>Un transfert expiré est supprimé définitivement, sans copie résiduelle.</p>
      </div>
    </section>

    <div class="shell layout-narrow">
      <section class="panel" aria-labelledby="receiveTitle">
        <header class="panel-head">
          <h2 id="receiveTitle" class="panel-title">${icon('code')} Code du transfert</h2>
          <span class="chip chip-soft" id="receiveStatusChip">en attente</span>
        </header>

        <form id="receiveForm" class="receive-form">
          <div class="code-slots code-slots-input" id="codeSlots" data-length="7" role="group" aria-label="Code du transfert"></div>
          <input type="hidden" id="transferCode" name="code">
          <button type="submit" class="btn btn-primary btn-block btn-large" id="receiveButton">${icon('download')} Rechercher le fichier</button>
          <p class="status" id="receiveStatus" role="status"></p>
        </form>

        <section class="receive-result" id="receiveResult" hidden aria-live="polite">
          <header class="receive-result-head">
            <div>
              <span class="code-label">Fichier trouvé</span>
              <h3 id="receiveFileName">—</h3>
            </div>
            <span class="chip chip-jade" id="resultCodeBadge">—</span>
          </header>

          <div class="countdown" data-countdown aria-label="Temps restant">
            <span class="countdown-unit"><strong data-unit="days">0</strong><small>j</small></span>
            <span class="countdown-unit"><strong data-unit="hours">00</strong><small>h</small></span>
            <span class="countdown-unit"><strong data-unit="minutes">00</strong><small>min</small></span>
            <span class="countdown-unit"><strong data-unit="seconds">00</strong><small>s</small></span>
          </div>

          <dl class="result-meta">
            <div><dt>Taille</dt><dd id="receiveSize">—</dd></div>
            <div><dt>Expire le</dt><dd id="receiveExpiry">—</dd></div>
            <div><dt>Téléchargements</dt><dd id="receiveDownloads">—</dd></div>
            <div><dt>Nettoyage</dt><dd id="receiveCleanup">—</dd></div>
          </dl>

          <div class="media-holder" id="mediaHolder" hidden></div>

          <div class="receive-actions">
            <a class="btn btn-primary btn-large" id="downloadButton" href="#">${icon('download')} Télécharger</a>
            <button type="button" class="btn btn-ghost" id="copyReceiveLink">${icon('copy')} Copier le lien</button>
          </div>
        </section>
      </section>

      <aside class="panel panel-side">
        <h2 class="panel-title">${icon('qr')} Pas de code sous la main ?</h2>
        <p>Scanne le QR code reçu avec l'appareil photo du téléphone : il ouvre directement cette page avec le bon code, sans rien saisir.</p>
        <ul class="mini-list">
          <li>${icon('clock')} Un transfert reste en ligne le temps choisi par l'envoyeur, puis disparaît.</li>
          <li>${icon('shield')} Aucun compte, aucun historique côté serveur.</li>
          <li>${icon('film')} Les vidéos se lisent dans la page, sans téléchargement préalable.</li>
        </ul>
      </aside>
    </div>`;

  return renderLayout({
    params,
    request,
    title: 'Recevoir un fichier',
    description: 'Saisis le code à sept caractères pour récupérer un fichier envoyé avec DropQR.',
    active: 'receive',
    pageClass: 'page-receive',
    pageScript: 'receive.js',
    body
  });
}

/* -------------------------------- mes liens ------------------------------- */

export function renderDashboard({ params, request }) {
  const body = `
    <section class="page-head shell">
      <div>
        <span class="eyebrow">Mes liens</span>
        <h1 class="page-title">Tes transferts, leur état réel.</h1>
        <p class="lead">La liste vit dans ce navigateur. L'état, le compteur de téléchargements et la suppression viennent du serveur.</p>
      </div>
      <div class="page-head-widget" data-tilt>
        <div class="stat-inline">
          <span><strong id="statCount" data-count-to="0">0</strong><small>transferts</small></span>
          <span><strong id="statSize" data-count-to="0">0</strong><small>volume actif</small></span>
          <span><strong id="statExpired" data-count-to="0">0</strong><small>expirés</small></span>
        </div>
      </div>
    </section>

    <div class="shell layout-narrow">
      <section class="panel">
        <header class="panel-head">
          <h2 class="panel-title">${icon('layers')} Historique local</h2>
          <div class="panel-actions">
            <button type="button" class="btn btn-quiet btn-small" id="refreshButton">${icon('gauge')} Rafraîchir</button>
            <button type="button" class="btn btn-quiet btn-small" id="clearLocalButton">${icon('trash')} Vider la liste</button>
          </div>
        </header>
        <p class="status" id="dashboardStatus" role="status">Chargement…</p>
        <div class="transfer-list" id="transferList"></div>
        <div class="empty-state" id="emptyDashboard" hidden>
          <figure>
            <img src="/img/devices.jpg" alt="Deux appareils échangeant un document" width="1408" height="768" loading="lazy">
          </figure>
          <h3>Aucun transfert enregistré ici</h3>
          <p>Les envois faits depuis ce navigateur apparaîtront dans cette liste, avec leur code et leur compte à rebours.</p>
          <a class="btn btn-primary" href="/upload">${icon('send')} Créer un transfert</a>
        </div>
      </section>
    </div>`;

  return renderLayout({
    params,
    request,
    title: 'Mes liens',
    description: 'Suivi local des transferts créés depuis ce navigateur, avec leur état réel côté serveur.',
    active: 'dashboard',
    pageClass: 'page-dashboard',
    pageScript: 'dashboard.js',
    body
  });
}

/* ---------------------------------- aide ---------------------------------- */

export function renderHelp({ params, request }) {
  const context = publicContext(params, request);
  const rows = [
    ['R2_ACCOUNT_ID', 'identifiant de compte Cloudflare', 'obligatoire en mode Netlify'],
    ['S3_BUCKET', 'nom du compartiment (bucket)', 'obligatoire'],
    ['S3_ACCESS_KEY_ID', 'clé d’accès du jeton R2', 'obligatoire'],
    ['S3_SECRET_ACCESS_KEY', 'secret du jeton R2', 'obligatoire'],
    ['PUBLIC_URL', 'URL publique du site', `recommandé : ${escapeHtml(context.baseUrl || 'https://ton-site.netlify.app')}`],
    ['MAX_FILE_SIZE', 'limite par transfert (ex. 2gb)', `défaut : ${escapeHtml(context.maxFileSizeHuman)}`],
    ['DEFAULT_TTL_MINUTES', 'durée de vie par défaut', `défaut : ${params.defaultTtlMinutes}`],
    ['MAX_TTL_MINUTES', 'durée de vie maximale', `défaut : ${params.maxTtlMinutes}`],
    ['PART_SIZE_MB', 'taille d’un morceau', `défaut : ${Math.round(params.partSizeBytes / 1024 / 1024)}`],
    ['UPLOAD_CONCURRENCY', 'envois simultanés', `défaut : ${params.maxParallelUploads}`],
    ['DISCORD_WEBHOOK_URL', 'webhook de notification', 'optionnel'],
    ['DROPQR_STORAGE', 'force le mode de stockage', 'auto, s3 ou local']
  ];

  const body = `
    <section class="page-head shell">
      <div>
        <span class="eyebrow">Aide</span>
        <h1 class="page-title">Déployer, configurer, dépanner.</h1>
        <p class="lead">Tout ce qu'il faut pour faire tourner DropQR sur Netlify gratuitement, ou sur un serveur Node si tu préfères.</p>
      </div>
      <ul class="stat-row">
        <li><strong>${escapeHtml(context.maxFileSizeHuman)}</strong><span>par transfert</span></li>
        <li><strong>${escapeHtml(context.partSizeHuman)}</strong><span>morceaux parallèles</span></li>
        <li><strong>${escapeHtml(String(params.maxTtlMinutes / 60))} h</strong><span>expiration maximale</span></li>
      </ul>
    </section>

    <div class="shell layout-2col layout-help">
      <div class="help-main">
        <section class="panel" id="netlify">
          <header class="panel-head">
            <h2 class="panel-title">${icon('server')} Netlify, étape par étape</h2>
            <span class="chip chip-jade">gratuit</span>
          </header>
          <p>Netlify ne lance pas de serveur Node permanent : il sert les fichiers statiques et exécute des fonctions à la demande. Ces fonctions refusent les requêtes de plus de 6 Mo, donc les octets ne passent jamais par elles : le navigateur envoie le fichier directement dans un stockage objet compatible S3, et la fonction ne valide que les métadonnées.</p>
          <div class="notice notice-info">
            <p><strong>Deux façons de fonctionner, sans rien payer.</strong></p>
            <ul class="list">
              <li><strong>Sans configuration</strong> : les fichiers (jusqu'à ${escapeHtml(context.blobsLimitHuman)}) sont rangés dans Netlify Blobs, inclus dans l'offre Netlify. Rien à créer, ça marche dès le déploiement.</li>
              <li><strong>Avec un compartiment R2</strong> : jusqu'à ${escapeHtml(context.maxFileSizeHumanUnlimited)} par transfert, envoi direct et parallèle. C'est la configuration recommandée pour les vidéos.</li>
            </ul>
          </div>
          <ol class="steps steps-compact">
            <li class="step">
              <span class="step-index">01</span>
              <h3>Créer un compartiment R2</h3>
              <p>Cloudflare R2 offre 10 Go de stockage et aucun frais de sortie. Crée un bucket, puis un jeton d'API avec les droits Lecture et Écriture sur ce bucket.</p>
            </li>
            <li class="step">
              <span class="step-index">02</span>
              <h3>Renseigner les variables</h3>
              <p>Dans Netlify : Site configuration, Environment variables. Ajoute au minimum les quatre premières variables du tableau ci-dessous, puis redéploie.</p>
            </li>
            <li class="step">
              <span class="step-index">03</span>
              <h3>Configurer CORS sur R2</h3>
              <p>Autorise les requêtes PUT et GET depuis l'origine de ton site, sinon le navigateur bloquera l'envoi direct.</p>
            </li>
            <li class="step">
              <span class="step-index">04</span>
              <h3>Vérifier</h3>
              <p>Ouvre <code>/api/health</code> : la réponse doit indiquer <code>storage: "s3"</code> et <code>directUpload: true</code>. Ensuite, envoie un fichier de test.</p>
            </li>
          </ol>

          <h3 class="sub-title">Configuration CORS à coller dans R2</h3>
          <pre class="code-block"><code>[
  {
    "AllowedOrigins": ["https://ton-site.netlify.app"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]</code></pre>
          <p class="note">L'en-tête <code>ETag</code> doit être exposé : l'assemblage des morceaux en a besoin.</p>

          <h3 class="sub-title">Variables d'environnement</h3>
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>Variable</th><th>Rôle</th><th>Valeur</th></tr></thead>
              <tbody>
                ${rows
                  .map(
                    (row) => `<tr><td><code>${escapeHtml(row[0])}</code></td><td>${escapeHtml(row[1])}</td><td>${row[2]}</td></tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel" id="node">
          <header class="panel-head">
            <h2 class="panel-title">${icon('server')} Autre option : serveur Node</h2>
            <span class="chip chip-soft">Railway, Render, VPS</span>
          </header>
          <p>Le même code tourne en serveur classique, sans aucune variable de stockage objet : les fichiers sont écrits sur le disque de la machine. C'est le mode le plus simple à tester en local, mais un hébergeur Node gratuit est rarement éphémère... et souvent payant au-delà d'un quota.</p>
          <pre class="code-block"><code>npm install
npm start
# puis http://localhost:3000</code></pre>
          <p class="note">Pour tester depuis un téléphone sur le même Wi-Fi : <code>PUBLIC_URL="http://192.168.1.25:3000" npm start</code>.</p>
        </section>

        <section class="panel" id="securite">
          <header class="panel-head">
            <h2 class="panel-title">${icon('shield')} Sécurité et vie privée</h2>
          </header>
          <ul class="check-list">
            <li>${icon('key')} Chaque transfert reçoit une clé de suppression privée, stockée uniquement sous forme de condensat SHA-256.</li>
            <li>${icon('shield')} Les contenus exécutables (HTML, SVG, JavaScript) sont servis en pièce jointe, jamais exécutés sur l'origine du site.</li>
            <li>${icon('clock')} L'URL de téléchargement est pré-signée et expire en quinze minutes : elle n'est pas devinable et ne circule pas en clair dans une base.</li>
            <li>${icon('server')} Aucune donnée personnelle n'est conservée : ni compte, ni adresse, ni journal de téléchargements.</li>
          </ul>
        </section>

        <section class="panel" id="depannage">
          <header class="panel-head">
            <h2 class="panel-title">${icon('gauge')} Dépannage</h2>
          </header>
          <div class="accordion" data-accordion>
            ${[
              {
                q: 'Netlify affiche « Page not found » ou une erreur 404 sur /api/...',
                a: "Les fonctions ne sont pas déployées. Vérifie que netlify.toml déclare bien publish = \"public\" et functions = \"netlify/functions\", puis relance un déploiement complet."
              },
              {
                q: "L'envoi échoue avec une erreur réseau juste après le démarrage",
                a: "Neuf fois sur dix, c'est CORS sur R2. L'origine du site doit être autorisée en GET, PUT et HEAD, et l'en-tête ETag doit être exposé."
              },
              {
                q: 'Un fichier de 2 Go s\'arrête à mi-parcours',
                a: "Réduis PART_SIZE_MB à 8 et UPLOAD_CONCURRENCY à 2 : certains proxys coupent les requêtes longues. Les morceaux déjà envoyés ne sont pas renvoyés lors d'un nouvel essai."
              },
              {
                q: 'Le QR code ne s\'ouvre pas depuis le téléphone',
                a: "Vérifie PUBLIC_URL : si l'URL publique est fausse, le QR pointe au mauvais endroit. Sur un réseau local, utilise l'IP du PC, jamais localhost."
              }
            ]
              .map(
                (item) => `
              <details class="accordion-item">
                <summary>${escapeHtml(item.q)}${icon('chevron', 'icon accordion-chevron')}</summary>
                <div class="accordion-body"><p>${escapeHtml(item.a)}</p></div>
              </details>`
              )
              .join('')}
          </div>
        </section>
      </div>

      <aside class="help-side">
        <nav class="panel toc" aria-label="Sommaire">
          <h2 class="panel-title">Sommaire</h2>
          <a href="#netlify">Déployer sur Netlify</a>
          <a href="#node">Serveur Node</a>
          <a href="#securite">Sécurité</a>
          <a href="#depannage">Dépannage</a>
        </nav>
        <div class="panel side-cta">
          <h2 class="panel-title">${icon('bolt')} État de ce déploiement</h2>
          <dl class="kv">
            <div><dt>Mode</dt><dd>${escapeHtml(modeLabel(context))}</dd></div>
            <div><dt>Envoi direct</dt><dd>${params.directUpload ? 'activé' : 'indisponible'}</dd></div>
            <div><dt>Arrivée Discord</dt><dd>${params.discord.enabled ? 'configurée' : 'non configurée'}</dd></div>
            <div><dt>Version</dt><dd>${APP_VERSION}</dd></div>
          </dl>
          <a class="btn btn-ghost btn-block" href="/api/health" target="_blank" rel="noopener">${icon('server')} Voir /api/health</a>
        </div>
      </aside>
    </div>`;

  return renderLayout({
    params,
    request,
    title: 'Aide',
    description: 'Déployer DropQR sur Netlify gratuitement, configurer le stockage objet et résoudre les pannes courantes.',
    active: 'help',
    pageClass: 'page-help',
    body,
    bodyEnd: modeNotice(params)
  });
}

/* --------------------------- page de téléchargement ----------------------- */

export function renderSharePage({ params, request, meta, payload, qrSvg }) {
  const isVideo = /^video\//i.test(meta.mimeType);
  const isAudio = /^audio\//i.test(meta.mimeType);
  const isImage = /^image\//i.test(meta.mimeType);
  const media = isVideo
    ? `<video class="media" controls playsinline preload="metadata" src="${escapeHtml(payload.previewUrl)}"></video>`
    : isAudio
      ? `<audio class="media media-audio" controls preload="metadata" src="${escapeHtml(payload.previewUrl)}"></audio>`
      : isImage
        ? `<img class="media media-image" src="${escapeHtml(payload.previewUrl)}" alt="${escapeHtml(meta.fileName)}">`
        : '';

  const body = `
    <div class="share-shell">
      <section class="share-card">
        <header class="share-head">
          <a class="brand" href="/">
            <span class="brand-mark">${brandMarkInline()}</span>
            <span class="brand-name">${APP_NAME}</span>
          </a>
          <span class="chip chip-jade">${icon('shield')} lien privé</span>
        </header>

        <div class="share-title">
          <span class="eyebrow">Fichier prêt</span>
          <h1>${escapeHtml(meta.fileName)}</h1>
          <p class="lead">${escapeHtml(formatBytes(meta.size))} · déposé le ${escapeHtml(
            new Date(meta.createdAt).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' })
          )}</p>
        </div>

        ${media}

        <div class="countdown countdown-large" data-countdown data-target="${new Date(meta.expiresAt).toISOString()}" aria-label="Temps restant avant suppression">
          <span class="countdown-unit"><strong data-unit="days">0</strong><small>jours</small></span>
          <span class="countdown-unit"><strong data-unit="hours">00</strong><small>heures</small></span>
          <span class="countdown-unit"><strong data-unit="minutes">00</strong><small>minutes</small></span>
          <span class="countdown-unit"><strong data-unit="seconds">00</strong><small>secondes</small></span>
        </div>

        <dl class="result-meta">
          <div><dt>Code</dt><dd>${escapeHtml(meta.code)}</dd></div>
          <div><dt>Nettoyage</dt><dd>${meta.deleteAfterDownload ? 'après le premier téléchargement' : 'à l’expiration'}</dd></div>
          <div><dt>Téléchargements</dt><dd>${Number(meta.downloads || 0)}</dd></div>
          <div><dt>Type</dt><dd>${escapeHtml(meta.mimeType)}</dd></div>
        </dl>

        <div class="share-actions">
          <a class="btn btn-primary btn-large btn-block" href="${escapeHtml(payload.downloadUrl)}">${icon('download')} Télécharger le fichier</a>
          <button type="button" class="btn btn-ghost btn-block" id="copyShareLink" data-url="${escapeHtml(payload.shareUrl)}">${icon('copy')} Copier le lien de cette page</button>
        </div>

        <details class="share-qr">
          <summary>${icon('qr')} Afficher le QR code</summary>
          <div class="qr-frame qr-frame-light">${qrSvg || ''}</div>
        </details>

        ${
          meta.deleteAfterDownload
            ? `<p class="note note-warn">Ce fichier sera supprimé juste après ton téléchargement. Enregistre-le avant de fermer la page.</p>`
            : `<p class="note">Ce fichier sera supprimé automatiquement à la fin du compte à rebours.</p>`
        }
        <p class="note note-small">Généré par ${APP_NAME} ${APP_VERSION} · ${escapeHtml(modeLabel(publicContext(params, request)))}</p>
      </section>
    </div>`;

  return renderLayout({
    params,
    request,
    title: `Télécharger ${meta.fileName}`,
    description: `Fichier temporaire déposé avec DropQR : ${meta.fileName} (${formatBytes(meta.size)}).`,
    pageClass: 'page-share',
    bare: true,
    body
  });
}

function brandMarkInline() {
  return `<svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle cx="13" cy="13" r="8.5" fill="var(--mark-copper)"></circle>
    <rect x="18" y="18" width="10" height="10" rx="2.5" fill="var(--mark-jade)"></rect>
    <circle cx="23.5" cy="8.5" r="4" fill="var(--mark-marigold)"></circle>
  </svg>`;
}

/* ------------------------------ page message ------------------------------ */

export function renderMessagePage({ params, request, title, message, code = '', cta }) {
  const body = `
    <div class="share-shell">
      <section class="share-card message-card">
        <span class="message-icon">${icon(code === 'expired' ? 'clock' : 'gauge')}</span>
        <h1>${escapeHtml(title)}</h1>
        <p class="lead">${escapeHtml(message)}</p>
        <div class="share-actions">
          ${cta || `<a class="btn btn-primary btn-block btn-large" href="/receive">${icon('code')} Saisir un autre code</a>`}
          <a class="btn btn-ghost btn-block" href="/">${icon('send')} Retour à l'accueil</a>
        </div>
      </section>
    </div>`;

  return renderLayout({
    params,
    request,
    title,
    description: message,
    pageClass: 'page-message',
    bare: true,
    body
  });
}

export function renderOfflinePage({ params, request }) {
  const body = `
    <div class="share-shell">
      <section class="share-card message-card">
        <span class="message-icon">${icon('server')}</span>
        <h1>Stockage non configuré</h1>
        <p class="lead">Ce déploiement ne peut pas conserver de fichiers : aucune destination n'est branchée. Le site reste consultable, mais l'envoi et la réception sont désactivés.</p>
        <ul class="mini-list">
          <li>${icon('server')} Sur Netlify, ajoute R2_ACCOUNT_ID, S3_BUCKET, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY.</li>
          <li>${icon('layers')} Détaille la procédure dans le guide.</li>
          <li>${icon('bolt')} En local, un simple npm start suffit : les fichiers vont sur le disque.</li>
        </ul>
        <div class="share-actions">
          <a class="btn btn-primary btn-block btn-large" href="/help#netlify">${icon('server')} Ouvrir le guide Netlify</a>
          <a class="btn btn-ghost btn-block" href="/">${icon('send')} Retour à l'accueil</a>
        </div>
      </section>
    </div>`;

  return renderLayout({
    params,
    request,
    title: 'Stockage non configuré',
    description: 'Le stockage des fichiers doit être configuré pour utiliser DropQR.',
    pageClass: 'page-offline',
    bare: true,
    body
  });
}

export { APP_NAME, humanLabel, maxFileSizeHuman };
