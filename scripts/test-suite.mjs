'use strict';

/**
 * Suite de tests DropQR — aucune dépendance externe.
 *
 * Couvre : rendu des pages, absence d'emoji, en-têtes de sécurité, génération
 * des codes, cycle complet d'un transfert en mode serveur, contrôle des clés,
 * nettoyage automatique, requêtes Range, limite de débit, vérification de
 * signature S3 (SigV4) et expiration.
 *
 * Trois cibles :
 *   node scripts/test-suite.mjs                          → serveur Node (stockage disque)
 *   node scripts/test-suite.mjs --netlify                → fonction Netlify
 *   node scripts/test-suite.mjs --netlify --blobs         → configuration du déploiement réel
 *                                                          (fonction Netlify + métadonnées Blobs)
 *
 * Usage : npm test
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const ROOT = path.join(os.tmpdir(), `dropqr-tests-${process.pid}`);
process.env.DROPQR_STORAGE = 'local';
process.env.DROPQR_META = 'local';
process.env.DROPQR_STORAGE_DIR = ROOT;
process.env.DEFAULT_TTL_MINUTES = '30';
process.env.MAX_TTL_MINUTES = '1440';
process.env.MAX_FILE_SIZE = '50mb';

const { createApp } = await import('../lib/app.mjs');
const { presignUrl, readS3Config } = await import('../lib/s3.mjs');
const { makeTransferCode, CODE_ALPHABET } = await import('../lib/util.mjs');

let failures = 0;
let checks = 0;
const group = (title) => console.log(`\n${title}`);

function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? 'ok  ' : 'ÉCHEC'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

const TARGET_NETLIFY = process.argv.includes('--netlify');
const TARGET_BLOBS = process.argv.includes('--blobs');

/**
 * Netlify Blobs n'existe que sur la plateforme. Le paquet officiel embarque
 * cependant le serveur local utilisé par le CLI : on démarre ce serveur et on
 * déclare son contexte exactement comme Netlify le ferait, ce qui permet de
 * tester la vraie chaîne de production des métadonnées.
 */
let blobsServer = null;
if (TARGET_BLOBS) {
  process.env.DROPQR_META = 'blobs';
  const { BlobsServer } = await import('@netlify/blobs/server');
  blobsServer = new BlobsServer({
    directory: path.join(os.tmpdir(), `dropqr-blobs-${process.pid}`),
    logger: () => {},
    token: 'jeton-de-test'
  });
  const { port } = await blobsServer.start();
  const address = `http://127.0.0.1:${port}`;
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(
    JSON.stringify({ siteID: 'dropqr-tests', token: 'jeton-de-test', apiURL: address, edgeURL: address, uncachedEdgeURL: address })
  ).toString('base64');
}

console.log(`Cible : ${TARGET_NETLIFY ? 'fonction Netlify' : 'serveur Node'} + métadonnées ${TARGET_BLOBS ? 'Netlify Blobs' : 'disque'}`);

await fsp.rm(ROOT, { recursive: true, force: true });
// `instance` sert aux accès internes (store, purge), y compris en mode Netlify.
const instance = createApp();
const app = TARGET_NETLIFY
  ? { handleRequest: (await import('../netlify/functions/api.mjs')).default }
  : instance;

const request = (route, { method = 'GET', body, deleteKey, headers = {} } = {}) => {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) {
    const binary = Buffer.isBuffer(body) || body instanceof Uint8Array || body instanceof ArrayBuffer;
    init.body = typeof body === 'string' || binary ? body : JSON.stringify(body);
    if (!binary) init.headers['Content-Type'] = 'application/json';
  }
  if (deleteKey) init.headers['X-Delete-Key'] = deleteKey;
  return app.handleRequest(new Request(`http://localhost${route}`, init), {});
};

const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2700}-\u{27BF}]/u;

/* ------------------------------ 1. Les pages ------------------------------ */

group('1. Rendu des pages et direction artistique');
const pages = ['/', '/upload', '/receive', '/dashboard', '/help'];
const contents = {};
for (const route of pages) {
  const response = await request(route);
  const html = await response.text();
  contents[route] = html;
  check(`${route} répond 200`, response.status === 200, String(response.status));
  check(`${route} contient un titre`, /<title>[^<]+<\/title>/.test(html));
  check(`${route} sans emoji`, !EMOJI.test(html), EMOJI.test(html) ? `trouvé : ${(html.match(EMOJI) || [])[0]}` : '');
  // Seuls les scripts externes et le bloc de configuration JSON sont autorisés.
  const inlineScripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].filter(
    ([, attributes, content]) => !/src=/.test(attributes) && !/application\/json/.test(attributes) && content.trim()
  );
  check(`${route} sans script en ligne`, inlineScripts.length === 0, `${inlineScripts.length} bloc(s) intrusif(s)`);
}

const home = contents['/'];
check('page d’accueil : en-tête CSP stricte', /default-src 'self'/.test((await request('/')).headers.get('content-security-policy') || ''));
check('page d’accueil : media-src autorise le stockage objet', /media-src 'self' blob: https:/.test((await request('/')).headers.get('content-security-policy') || ''));
check('page d’accueil : widgets présents (parallax, tilt, reveal)', /data-parallax/.test(home) && /data-tilt/.test(home) && /data-reveal/.test(home));
check('page d’accueil : QR vectoriel en ligne', /<svg[^>]*viewBox/.test(home));
check('page d’accueil : images servies localement', /\/img\/hero-collage\.jpg/.test(home));
check('envoi : cases de code et anneau de progression', /id="codeSlots"|id="progressRing"/.test(contents['/upload']));
check('réception : sept cases de saisie', /data-length="7"/.test(contents['/receive']));

/* ------------------------- 2. Codes de transfert ------------------------- */

group('2. Génération des codes');
const codes = new Set();
let sameEdge = 0;
for (let index = 0; index < 5000; index += 1) {
  const code = makeTransferCode(7);
  codes.add(code);
  if (code[0] === code[6]) sameEdge += 1;
}
check('5000 codes, tous uniques', codes.size === 5000, String(codes.size));
check('7 caractères, alphabet sans ambiguïté', [...codes].every((code) => code.length === 7 && [...code].every((c) => CODE_ALPHABET.includes(c))));
// Si les tirages étaient dépendants (bug de la v1 : motif AB...A), on serait à 100 %.
check(
  'premier et dernier caractère indépendants',
  sameEdge > 60 && sameEdge < 320,
  `${sameEdge}/5000 collisions de bord (≈ 1/32 = 156 attendu)`
);

/* ---------------------------- 3. Cycle complet --------------------------- */

group('3. Cycle complet d’un transfert');
const bytes = crypto.randomBytes(300_000);

const created = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'vidéo du weekend.mov', size: bytes.length, mimeType: 'video/quicktime', ttlMinutes: 30, deleteAfterDownload: false }
})).json();
check('création acceptée', Boolean(created.id && created.code && created.deleteKey));
check('mode d’envoi local', created.upload.mode === 'local-single', created.upload.mode);
check('clé de suppression absente des lectures publiques', !('deleteKey' in (await (await request(`/api/transfers/${created.id}`)).json())));

const withoutKey = await request(`/api/transfers/${created.id}/content`, { method: 'PUT', body: 'x' });
check('envoi refusé sans clé de suppression', withoutKey.status === 403, String(withoutKey.status));

const earlyComplete = await request(`/api/transfers/${created.id}/complete`, { method: 'POST', body: { parts: [] }, deleteKey: created.deleteKey });
check('finalisation refusée avant envoi des octets', earlyComplete.status === 409, String(earlyComplete.status));

const uploaded = await request(`/api/transfers/${created.id}/content`, {
  method: 'PUT',
  body: bytes,
  deleteKey: created.deleteKey,
  headers: { 'Content-Type': 'application/octet-stream' }
});
check('octets écrits sur le stockage', uploaded.status === 200 && (await uploaded.json()).received === bytes.length);

const completed = await (await request(`/api/transfers/${created.id}/complete`, { method: 'POST', body: { parts: [] }, deleteKey: created.deleteKey })).json();
check('transfert marqué prêt', completed.status === 'ready');
check('lien partageable en /r/', completed.shareUrl.includes('/r/'), completed.shareUrl);
check('taille annoncée correcte', completed.size === bytes.length);

const blockedPreview = await request(`/asset/${created.id}`);
check('aperçu lisible sans clé (lecture publique)', blockedPreview.status === 200);

const sharePage = await (await request(`/r/${created.id}`)).text();
check('page de partage affiche le fichier', sharePage.includes('vidéo du weekend.mov'));
check('page de partage contient un QR', /<svg[^>]*viewBox/.test(sharePage));
check('page de partage propose le téléchargement', /Télécharger le fichier/.test(sharePage));

const byCode = await request(`/api/codes/${created.code}`);
check('recherche par code', byCode.status === 200);
const wrongCode = await request('/api/codes/ZZZZZZZ');
check('code inconnu refusé', wrongCode.status === 404, String(wrongCode.status));

const downloaded = await request(`/download/${created.id}`);
const downloadedBytes = Buffer.from(await downloaded.arrayBuffer());
check('téléchargement identique à l’original', downloadedBytes.length === bytes.length && downloadedBytes.compare(bytes) === 0);
check('pièce jointe forcée au téléchargement', /attachment/.test(downloaded.headers.get('content-disposition') || ''));

const ranged = await request(`/asset/${created.id}`, { headers: { Range: 'bytes=100-199' } });
check('requête Range servie en 206', ranged.status === 206, String(ranged.status));
check('plage correcte annoncée', ranged.headers.get('content-range') === `bytes 100-199/${bytes.length}`, ranged.headers.get('content-range'));

/* ---------------------- 4. Contenus dangereux et types ------------------- */

group('4. Contenus dangereux');
const trap = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'page.html', size: 200, mimeType: 'text/html', ttlMinutes: 30 }
})).json();
check('type HTML neutralisé', trap.mimeType === 'application/octet-stream', trap.mimeType);
await request(`/api/transfers/${trap.id}/content`, { method: 'PUT', body: Buffer.from('<script>alert(1)</script>'), deleteKey: trap.deleteKey });
await request(`/api/transfers/${trap.id}/complete`, { method: 'POST', body: { parts: [] }, deleteKey: trap.deleteKey });
const trapResponse = await request(`/asset/${trap.id}`);
check('contenu exécutable servi en pièce jointe', /attachment/.test(trapResponse.headers.get('content-disposition') || ''), trapResponse.headers.get('content-disposition') || '');
check('type de contenu neutre', (trapResponse.headers.get('content-type') || '').includes('octet-stream'));
check('nosniff sur les fichiers servis', trapResponse.headers.get('x-content-type-options') === 'nosniff');

const tooBig = await request('/api/transfers', { method: 'POST', body: { fileName: 'enorme.bin', size: 200 * 1024 * 1024, mimeType: 'application/octet-stream' } });
check('fichier au-delà de la limite refusé (413)', tooBig.status === 413, String(tooBig.status));
const badSize = await request('/api/transfers', { method: 'POST', body: { fileName: 'x.bin', size: -5 } });
check('taille invalide refusée (400)', badSize.status === 400, String(badSize.status));

/* ------------------ 5. Aperçu, compteurs et suppression ------------------ */

group('5. Aperçu, compteurs et suppression');
const before = await (await request(`/api/transfers/${created.id}`)).json();
check('l’aperçu n’incrémente pas le compteur', before.downloads === 1, `compteur : ${before.downloads} (1 téléchargement réel)`);

const noKey = await request(`/api/transfers/${created.id}`, { method: 'DELETE' });
check('suppression refusée sans clé', noKey.status === 403, String(noKey.status));
const badKey = await request(`/api/transfers/${created.id}`, { method: 'DELETE', deleteKey: 'mauvaise' });
check('suppression refusée avec mauvaise clé', badKey.status === 403, String(badKey.status));
const deleted = await request(`/api/transfers/${created.id}`, { method: 'DELETE', deleteKey: created.deleteKey });
check('suppression acceptée avec la bonne clé', deleted.status === 200, String(deleted.status));
check('transfert supprimé introuvable', (await request(`/api/transfers/${created.id}`)).status === 404);
check('code libéré', (await request(`/api/codes/${created.code}`)).status === 404);
check('objet retiré du disque', (await request(`/asset/${created.id}`)).status === 404);

/* ----------------- 6. Suppression après premier téléchargement ----------- */

group('6. Nettoyage après téléchargement');
const oneShot = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'unique.png', size: 1000, mimeType: 'image/png', ttlMinutes: 30, deleteAfterDownload: true }
})).json();
await request(`/api/transfers/${oneShot.id}/content`, { method: 'PUT', body: Buffer.alloc(1000, 7), deleteKey: oneShot.deleteKey });
await request(`/api/transfers/${oneShot.id}/complete`, { method: 'POST', body: { parts: [] }, deleteKey: oneShot.deleteKey });
const first = await request(`/download/${oneShot.id}`);
await first.arrayBuffer();
await new Promise((resolve) => setTimeout(resolve, 300));
check('transfert supprimé après le premier téléchargement', (await request(`/api/transfers/${oneShot.id}`)).status === 404);

const keeper = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'garde.png', size: 1000, mimeType: 'image/png', ttlMinutes: 30, deleteAfterDownload: false }
})).json();
await request(`/api/transfers/${keeper.id}/content`, { method: 'PUT', body: Buffer.alloc(1000, 9), deleteKey: keeper.deleteKey });
await request(`/api/transfers/${keeper.id}/complete`, { method: 'POST', body: { parts: [] }, deleteKey: keeper.deleteKey });
const preview = await request(`/asset/${keeper.id}`);
await preview.arrayBuffer();
await new Promise((resolve) => setTimeout(resolve, 200));
check('un aperçu ne déclenche pas la suppression', (await request(`/api/transfers/${keeper.id}`)).status === 200);

/* ------------------------------ 7. Expiration ---------------------------- */

group('7. Expiration et purge');
const store = await instance.getStore();
check(
  'métadonnées et fichiers ont des backends indépendants',
  store.metadataKind === (TARGET_BLOBS ? 'blobs' : 'local') && store.objectKind === 'local',
  `${store.metadataKind} / ${store.objectKind}`
);
check('les fichiers restent accessibles sur le disque', typeof store.objectPath('essai.bin') === 'string');
const expiring = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'temporaire.bin', size: 1000, mimeType: 'application/octet-stream', ttlMinutes: 30 }
})).json();
const meta = await store.readMeta(expiring.id);
meta.status = 'ready';
meta.expiresAt = Date.now() - 1000;
await store.writeMeta(meta);
const expiredRead = await request(`/api/transfers/${expiring.id}`);
check('transfert expiré refusé', expiredRead.status === 404 || expiredRead.status === 410, String(expiredRead.status));
check('transfert expiré purgé', (await store.readMeta(expiring.id)) === null);

const abandoned = await (await request('/api/transfers', {
  method: 'POST',
  body: { fileName: 'abandon.bin', size: 1000, mimeType: 'application/octet-stream' }
})).json();
const abandonedMeta = await store.readMeta(abandoned.id);
abandonedMeta.createdAt = Date.now() - 12 * 60 * 60 * 1000;
await store.writeMeta(abandonedMeta);
const purgeResult = await instance.purgeNow();
check('envoi abandonné nettoyé', purgeResult.removed >= 1, JSON.stringify(purgeResult));
check('envoi abandonné introuvable', (await store.readMeta(abandoned.id)) === null);

/* ---------------------------- 8. Limite de débit ------------------------- */

group('8. Limite de débit');
let limited = 0;
for (let index = 0; index < 100; index += 1) {
  const response = await request('/api/transfers', {
    method: 'POST',
    body: { fileName: `charge-${index}.bin`, size: 1000, mimeType: 'application/octet-stream' }
  });
  if (response.status === 429) limited += 1;
}
check('trop de créations consécutives bloquées (429)', limited > 0, `${limited} refus sur 100 tentatives`);

/* ------------------------- 9. Signature S3 (SigV4) ----------------------- */

group('9. Signature des URL S3 (vérificateur indépendant)');
const s3Config = readS3Config({
  S3_ENDPOINT: 'https://abcd1234.r2.cloudflarestorage.com',
  S3_BUCKET: 'mon-bucket',
  S3_ACCESS_KEY_ID: 'AKIAEXEMPLE1234567',
  S3_SECRET_ACCESS_KEY: 'secret-tres-secret-abcdefghijklmnop',
  S3_REGION: 'auto',
  S3_FORCE_PATH_STYLE: 'true',
  S3_PREFIX: 'dropqr'
});

/** Vérifie une URL pré-signée en recalculant la signature depuis la spécification AWS. */
function verifyPresignedUrl(url) {
  const parsed = new URL(url);
  const params = [...parsed.searchParams.entries()].filter(([key]) => key !== 'X-Amz-Signature');
  const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  const canonicalQuery = params
    .map(([key, value]) => [encode(key), encode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders');
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((header) => `${header}:${header === 'host' ? parsed.host : ''}\n`)
    .join('');
  const canonicalRequest = [
    'GET',
    parsed.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    'UNSIGNED-PAYLOAD'
  ].join('\n');

  const credential = parsed.searchParams.get('X-Amz-Credential');
  const scope = credential.split('/').slice(1).join('/');
  const amzDate = parsed.searchParams.get('X-Amz-Date');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');
  const [dateStamp, region, service] = scope.split('/');
  const kDate = crypto.createHmac('sha256', `AWS4${s3Config.secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const expected = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return expected === parsed.searchParams.get('X-Amz-Signature');
}

const fixedDate = new Date('2026-09-21T10:20:30Z');
const presignedGet = presignUrl(s3Config, { method: 'GET', key: 'dropqr/fichier-abc.mov', expiresIn: 900, date: fixedDate });
check('URL GET pré-signée valide', verifyPresignedUrl(presignedGet));
const parsedGet = new URL(presignedGet);
check('chemin en style « path » avec le bucket', parsedGet.pathname === '/mon-bucket/dropqr/fichier-abc.mov', parsedGet.pathname);
check('expiration de 900 s annoncée', parsedGet.searchParams.get('X-Amz-Expires') === '900');
check('portée de signature correcte', parsedGet.searchParams.get('X-Amz-Credential') === 'AKIAEXEMPLE1234567/20260921/auto/s3/aws4_request');

const tampered = presignedGet.replace(/X-Amz-Expires=900/, 'X-Amz-Expires=901');
check('URL modifiée invalide', !verifyPresignedUrl(tampered));

/* --------------------------- 10. Santé et config ------------------------- */

group('10. Points de contrôle');
const health = await (await request('/api/health')).json();
check('santé : version 2.0.0', health.version === '2.0.0', health.version);
check('santé : mode de stockage', health.storage === 'local', health.storage);
check(
  `santé : métadonnées sur ${TARGET_BLOBS ? 'Blobs' : 'disque'}`,
  health.metadata === (TARGET_BLOBS ? 'blobs' : 'local'),
  health.metadata
);
check('santé : limite annoncée', health.maxFileSizeHuman === '50.0 Mo', health.maxFileSizeHuman);
const config = await (await request('/api/config')).json();
check('config : mode d’envoi direct signalé', config.directUpload === false);
check('config : taille des morceaux', config.partSizeBytes >= 5 * 1024 * 1024, String(config.partSizeBytes));
const unknownApi = await request('/api/inconnu');
check('route API inconnue en 404 JSON', unknownApi.status === 404 && (unknownApi.headers.get('content-type') || '').includes('json'));
const notFound = await request('/page-inconnue');
check('page inconnue en 404 HTML', notFound.status === 404 && (notFound.headers.get('content-type') || '').includes('html'));

/* ------------- 11. Cohérence entre les scripts et le HTML ----------------- */

group('11. Câblage des widgets (scripts ↔ pages)');
const idsInHtml = (html) => new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
const idsUsedByScript = (source) =>
  [...new Set([...source.matchAll(/(?:\$|getElementById)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((match) => match[1]))];

const appSource = await fsp.readFile(path.join(process.cwd(), 'public/assets/app.js'), 'utf8');
const sharedIds = ['toasts', 'themeToggle', 'topbar', 'scrollProgress', 'dropqrConfig'];
for (const id of sharedIds) {
  check(`identifiant partagé « ${id} » présent sur chaque page`, pages.every((route) => idsInHtml(contents[route]).has(id)), id);
}

const stylesheet = await fsp.readFile(path.join(process.cwd(), 'public/assets/styles.css'), 'utf8');
for (const className of ['is-visible', 'is-tick', 'is-dragover', 'filled', 'toast', 'is-error', 'code-slot', 'countdown-unit', 'qr-frame', 'sparkline', 'accordion-item', 'marquee-track', 'progress-ring', 'media-holder']) {
  check(`classe « ${className} » définie dans la feuille de style`, stylesheet.includes(`.${className}`));
}
check('orientations clair et sombre définies', stylesheet.includes('[data-theme="dark"]') && stylesheet.includes('prefers-color-scheme: dark'));
check('mouvement réduit respecté', stylesheet.includes('prefers-reduced-motion'));

for (const [script, route] of [['upload.js', '/upload'], ['receive.js', '/receive'], ['dashboard.js', '/dashboard']]) {
  const source = await fsp.readFile(path.join(process.cwd(), 'public/assets', script), 'utf8');
  const pageIds = idsInHtml(contents[route]);
  const missing = idsUsedByScript(source).filter((id) => !pageIds.has(id));
  check(`${script} ne référence que des éléments existants`, missing.length === 0, missing.join(', '));
}

/* -------------------- 12. Feuille de style : santé générale ----------------- */

group('12. Feuille de style');
const css = await fsp.readFile(path.join(process.cwd(), 'public/assets/styles.css'), 'utf8');
check('accolades équilibrées', (css.match(/{/g) || []).length === (css.match(/}/g) || []).length, `${(css.match(/{/g) || []).length} / ${(css.match(/}/g) || []).length}`);

// Une variable peut être déclarée dans le CSS, dans le JavaScript, ou porter une valeur de repli.
const customProperties = new Set([...css.matchAll(/--([a-z0-9-]+)\s*:/g)].map((match) => match[1]));
const propertiesWithFallback = new Set([...css.matchAll(/var\(\s*--([a-z0-9-]+)\s*,/g)].map((match) => match[1]));
const scriptAndMarkup = [
  await fsp.readFile(path.join(process.cwd(), 'public/assets/app.js'), 'utf8'),
  await fsp.readFile(path.join(process.cwd(), 'public/assets/upload.js'), 'utf8'),
  await fsp.readFile(path.join(process.cwd(), 'public/assets/receive.js'), 'utf8'),
  await fsp.readFile(path.join(process.cwd(), 'public/assets/dashboard.js'), 'utf8'),
  contents['/']
].join('\n');
const usedProperties = new Set([...css.matchAll(/var\(\s*--([a-z0-9-]+)/g)].map((match) => match[1]));
const undefinedProperties = [...usedProperties].filter(
  (name) => !customProperties.has(name) && !propertiesWithFallback.has(name) && !scriptAndMarkup.includes(`--${name}`)
);
check('aucune variable CSS non définie', undefinedProperties.length === 0, undefinedProperties.join(', '));

const strayHexColors = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].filter((match) => ![4, 5, 7, 9].includes(match[0].length));
// `hidden` est écrasé par toute règle de classe qui fixe un `display` :
// la feuille de style doit donc le rétablir explicitement.
check('attribut hidden réellement masquant', /\[hidden\][^{]*{[^}]*display:\s*none/.test(css));
const hiddenElements = [...Object.values(contents).join('\n').matchAll(/class="([^"]+)"[^>]*\shidden/g)].map((match) => match[1].split(' ')[0]);
check(
  'aucun bloc masqué au chargement dépourvu de la règle de repli',
  hiddenElements.length === 0 || /\[hidden\]/.test(css),
  `${hiddenElements.length} élément(s) : ${[...new Set(hiddenElements)].join(', ')}`
);
check('aucune couleur hexadécimale invalide', strayHexColors.length === 0, strayHexColors.slice(0, 3).map((match) => match[0]).join(', '));
check('aucune déclaration vide ou erronée', !/\bundefined\b|\bNaN\b/.test(css));
check('aucun emoji dans la feuille de style', !/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(css));

/* -------------------- 13. Point d'entrée Netlify (fonction) ---------------- */

group('13. Point d’entrée Netlify');
const netlifyFunction = (await import('../netlify/functions/api.mjs')).default;
const netlifyConfig = (await import('../netlify/functions/api.mjs')).config;
check('la fonction se charge et expose un gestionnaire', typeof netlifyFunction === 'function');
check('chemins déclarés pour la fonction', Array.isArray(netlifyConfig.path) && netlifyConfig.path.includes('/api/*'));
check('fichiers statiques prioritaires', netlifyConfig.preferStatic === true);
const functionHealth = await netlifyFunction(new Request('http://localhost/api/health'), {});
check('la fonction répond à /api/health', functionHealth.status === 200, String(functionHealth.status));
const functionHome = await netlifyFunction(new Request('http://localhost/'), {});
check('la fonction rend la page d’accueil', functionHome.status === 200 && /<title>/.test(await functionHome.text()));
const purgeFunction = await import('../netlify/functions/purge.mjs');
check('tâche planifiée configurée', typeof purgeFunction.config.schedule === 'string', purgeFunction.config.schedule);
const purgeResponse = await purgeFunction.default();
const purgeSummary = await purgeResponse.json();
check(
  'la tâche planifiée s’exécute et répond',
  purgeResponse.status === 200 && purgeSummary.ok === true && Number.isFinite(purgeSummary.removed),
  JSON.stringify(purgeSummary)
);

/* ------------- 14. Couverture des routes pour le déploiement --------------- */

group('14. Couverture des routes pour Netlify');
const netlifyToml = await fsp.readFile(path.join(process.cwd(), 'netlify.toml'), 'utf8');
check('en-têtes de sécurité appliqués à tout le site', /for\s*=\s*"\/\*"[\s\S]{0,200}nosniff/.test(netlifyToml));
check('version de Node épinglée', /^\s*2[02]\s*$/.test(await fsp.readFile(path.join(process.cwd(), '.nvmrc'), 'utf8').catch(() => '')));
check('publication du dossier public/', /publish\s*=\s*"public"/.test(netlifyToml));
check('fonctions prises dans netlify/functions', /functions\s*=\s*"netlify\/functions"/.test(netlifyToml));
check('mise en cache longue des ressources', (netlifyToml.match(/immutable/g) || []).length >= 2);

const manifest = JSON.parse(await fsp.readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
check('Netlify Blobs déclaré comme dépendance', Boolean(manifest.dependencies?.['@netlify/blobs']), manifest.dependencies?.['@netlify/blobs']);

const declaredPaths = netlifyConfig.path || [];
const matchesPath = (route) =>
  declaredPaths.some((pattern) => {
    if (!pattern.includes('*')) return pattern === route;
    const [prefix, suffix] = pattern.split('*');
    return route.startsWith(prefix) && (!suffix || route.endsWith(suffix));
  });

for (const route of ['/', '/upload', '/receive', '/dashboard', '/help', '/offline', '/api/health', '/r/exemple', '/c/ABC2345', '/asset/exemple']) {
  check(`route « ${route} » desservie par la fonction`, matchesPath(route));
}

// Un lien interne absent des deux listes provoquerait un 404 après déploiement.
const publicDir = path.join(process.cwd(), 'public');
const exists = async (route) => {
  try {
    await fsp.access(path.join(publicDir, route.replace(/^\/+/, '/')), 0);
    return true;
  } catch {
    return false;
  }
};
const brokenLinks = [];
const missingAssets = [];
const seen = new Set();
for (const html of Object.values(contents)) {
  for (const [, attribute, value] of html.matchAll(/(href|src)="([^"]+)"/g)) {
    if (!value.startsWith('/') || value.startsWith('//')) continue;
    const route = value.split('#')[0].split('?')[0];
    if (!route) continue;
    const staticFile = await exists(route);
    if (attribute === 'src' && !staticFile && !route.startsWith('/api/')) missingAssets.push(route);
    if (attribute === 'href' && !staticFile && !matchesPath(route) && seen.size < 200) brokenLinks.push(route);
    seen.add(route);
  }
}
check('aucun fichier référencé manquant (images, styles, scripts)', missingAssets.length === 0, [...new Set(missingAssets)].join(', '));
check('aucun lien interne menant à une page non desservie', brokenLinks.length === 0, [...new Set(brokenLinks)].join(', '));

/* --------------- 15. Configuration incomplète (cas Netlify) --------------- */

group('15. Configuration incomplète');
const { execFileSync } = await import('node:child_process');
const incomplete = execFileSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `delete process.env.NETLIFY_BLOBS_CONTEXT; // comme un Netlify sans contexte Blobs
     process.env.DROPQR_META = 'blobs';
     process.env.DROPQR_STORAGE = 'local';
     process.env.DROPQR_STORAGE_DIR = '${path.join(ROOT, 'incomplet')}';
     const { createApp } = await import('${path.join(process.cwd(), 'lib/app.mjs')}');
     const app = createApp();
     const response = await app.handleRequest(new Request('http://localhost/api/health'), {});
     console.log(JSON.stringify({ status: response.status, body: await response.json() }));
     process.exit(0); // les connexions HTTP gardées ouvertes empêchent la sortie`
  ],
  { encoding: 'utf8' }
);
const incompleteResult = JSON.parse(incomplete.trim().split('\n').pop());
check('métadonnées indisponibles : refus explicite (503)', incompleteResult.status === 503, String(incompleteResult.status));
check(
  'le message indique la marche à suivre',
  /Netlify Blobs|DROPQR_META/.test(incompleteResult.body.error || ''),
  String(incompleteResult.body.error || '').slice(0, 80)
);

/* ------------------- 16. Qualité du rendu (mise en page) ------------------ */

group('16. Qualité du rendu');
for (const route of [...pages, '/offline']) {
  if (!contents[route]) contents[route] = await (await request(route)).text();
  const html = contents[route];
  const images = [...html.matchAll(/<img([^>]*)>/g)].map((match) => match[1]);
  check(`${route} : un seul titre principal`, (html.match(/<h1/g) || []).length === 1);
  check(`${route} : langue déclarée`, /<html[^>]*lang="fr"/.test(html));
  check(`${route} : affichage mobile déclaré`, /name="viewport"[^>]*width=device-width/.test(html));
  check(`${route} : description de la page`, /name="description"/.test(html));
  check(
    `${route} : images décrites et dimensionnées (pas de saut de mise en page)`,
    images.every((attributes) => /alt="/.test(attributes) && /width="/.test(attributes) && /height="/.test(attributes)),
    `${images.length} image(s)`
  );
  check(`${route} : aucun bouton sans libellé accessible`, !/<button[^>]*>\s*<\/button>/.test(html));
  check(`${route} : thème sombre géré par le système`, /color-scheme/.test(html));
}

await fsp.rm(ROOT, { recursive: true, force: true });
if (blobsServer) await blobsServer.stop();

console.log(`\nCible testée : ${TARGET_NETLIFY ? 'fonction Netlify' : 'serveur Node'} (métadonnées : ${TARGET_BLOBS ? 'Netlify Blobs' : 'disque'})`);
console.log(`${checks - failures}/${checks} vérifications réussies.`);
console.log(failures === 0 ? 'Tous les tests sont passés.' : `${failures} test(s) en échec.`);
process.exit(failures === 0 ? 0 : 1);
