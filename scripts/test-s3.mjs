'use strict';

/**
 * Chaîne complète en mode stockage objet (Cloudflare R2, S3, MinIO…).
 *
 * Un faux serveur S3 local (s3rver) reçoit réellement les octets : les URL
 * pré-signées sont donc utilisées pour de vrai, en envoi simple comme en
 * multipart. Le script revérifie aussi chaque signature depuis la
 * spécification SigV4 d'AWS, car un faux serveur est trop permissif.
 *
 * Modes :
 *   node scripts/test-s3.mjs                 → serveur Node
 *   node scripts/test-s3.mjs --netlify       → fonction Netlify
 *   node scripts/test-s3.mjs --netlify --blobs → configuration de production
 *
 * Usage : npm run test:s3   (nécessite `npm install --no-save s3rver`)
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer } from 'node:http';

const require = createRequire(import.meta.url);

let S3rver;
try {
  S3rver = require('s3rver');
} catch {
  console.error('Ce test a besoin du faux serveur S3 (outil de développement) :');
  console.error('  npm install --no-save s3rver');
  process.exit(1);
}

const TARGET_NETLIFY = process.argv.includes('--netlify');
const TARGET_BLOBS = process.argv.includes('--blobs');

const PORT = 4578;
const BUCKET = 'dropqr-test';
const S3_ROOT = path.join(os.tmpdir(), `dropqr-s3-${process.pid}`);
const META_ROOT = path.join(os.tmpdir(), `dropqr-meta-${process.pid}`);
const SIZE = 12 * 1024 * 1024; // 12 Mo : trois morceaux de 5 Mo
const PART_SIZE = 5 * 1024 * 1024;

let failures = 0;
let checks = 0;
function check(label, condition, detail = '') {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? 'ok  ' : 'ÉCHEC'}] ${label}${detail ? ` — ${detail}` : ''}`);
}

/* ------------------------------ SigV4 (AWS) ------------------------------- */

const encodeComponent = (value) =>
  encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Recalcule la signature d'une URL pré-signée à partir de la spécification.
 * Indépendant du code de l'application : c'est la seule preuve acceptable
 * qu'un vrai stockage objet acceptera ces URL.
 */
function signatureIsValid(url, { secret, method }) {
  const parsed = new URL(url);
  const entries = [...parsed.searchParams.entries()].filter(([key]) => key !== 'X-Amz-Signature');
  const canonicalQuery = entries
    .map(([key, value]) => [encodeComponent(key), encodeComponent(value)])
    .sort((first, second) => (first[0] < second[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders') || 'host';
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((header) => `${header}:${header === 'host' ? parsed.host : ''}\n`)
    .join('');
  const payloadHash = parsed.searchParams.get('X-Amz-Content-Sha256') || 'UNSIGNED-PAYLOAD';

  const canonicalRequest = [method, parsed.pathname, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = parsed.searchParams.get('X-Amz-Credential').split('/').slice(1).join('/');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    parsed.searchParams.get('X-Amz-Date'),
    scope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex')
  ].join('\n');

  const [dateStamp, region, service] = scope.split('/');
  const kDate = crypto.createHmac('sha256', `AWS4${secret}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  const expected = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return expected === parsed.searchParams.get('X-Amz-Signature');
}

/* ---------------------------------- script -------------------------------- */

async function main() {
  await fsp.rm(S3_ROOT, { recursive: true, force: true });
  await fsp.rm(META_ROOT, { recursive: true, force: true });
  await fsp.rm(path.join(os.tmpdir(), `dropqr-blobs-s3-${process.pid}`), { recursive: true, force: true });

  const server = new S3rver({
    port: PORT,
    address: '127.0.0.1',
    silent: true,
    directory: S3_ROOT,
    configureBuckets: [{ name: BUCKET }]
  });
  await server.run();

  let blobsServer = null;
  if (TARGET_BLOBS) {
    const { BlobsServer } = await import('@netlify/blobs/server');
    blobsServer = new BlobsServer({
      directory: path.join(os.tmpdir(), `dropqr-blobs-s3-${process.pid}`),
      logger: () => {},
      token: 'jeton-de-test'
    });
    const { port } = await blobsServer.start();
    const address = `http://127.0.0.1:${port}`;
    process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(
      JSON.stringify({ siteID: 'dropqr-tests', token: 'jeton-de-test', apiURL: address, edgeURL: address, uncachedEdgeURL: address })
    ).toString('base64');
  }

  Object.assign(process.env, {
    DROPQR_STORAGE: 's3',
    DROPQR_META: TARGET_BLOBS ? 'blobs' : 'local',
    DROPQR_STORAGE_DIR: META_ROOT,
    S3_ENDPOINT: `http://127.0.0.1:${PORT}`,
    S3_BUCKET: BUCKET,
    S3_ACCESS_KEY_ID: 'S3RVER',
    S3_SECRET_ACCESS_KEY: 'S3RVER',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: 'true',
    PART_SIZE_MB: '5',
    UPLOAD_CONCURRENCY: '3',
    MAX_FILE_SIZE: '100mb'
  });

  const { createApp } = await import('../lib/app.mjs');
  const instance = createApp();
  const app = TARGET_NETLIFY ? { handleRequest: (await import('../netlify/functions/api.mjs')).default } : instance;

  const payload = Buffer.alloc(SIZE);
  for (let index = 0; index < SIZE; index += 1) payload[index] = index % 251;

  const call = async (route, { method = 'GET', body, deleteKey, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    if (deleteKey) init.headers['X-Delete-Key'] = deleteKey;
    return app.handleRequest(new Request(`http://localhost${route}`, init), {});
  };

  console.log(`\n1. Configuration — ${TARGET_NETLIFY ? 'fonction Netlify' : 'serveur Node'}, métadonnées ${TARGET_BLOBS ? 'Blobs' : 'disque'}`);
  check('mode de stockage détecté comme « s3 »', instance.params.storageMode === 's3', instance.params.storageMode);
  check('métadonnées annoncées correctement', instance.params.metaMode === (TARGET_BLOBS ? 'blobs' : 'local'), instance.params.metaMode);
  const store = await instance.getStore();
  check('stockage des fichiers délégué au distant', store.objectKind === 'remote', store.kind);

  console.log('\n2. Création du transfert (12 Mo, morceaux de 5 Mo)');
  const createdAt = await call('/api/transfers', {
    method: 'POST',
    body: { fileName: 'clip final.mp4', size: SIZE, mimeType: 'video/mp4' }
  });
  const created = await createdAt.json();
  check('réponse 201', createdAt.status === 201, `${createdAt.status} ${created.error || ''}`);
  check('envoi multipart choisi', created.upload?.mode === 'multipart', created.upload?.mode);
  check('3 morceaux calculés', created.upload?.parts === 3, String(created.upload?.parts));
  check('code de 7 caractères', /^[A-HJ-NP-Z2-9]{7}$/.test(created.code || ''), created.code);

  console.log('\n3. URL pré-signées des morceaux');
  const partsResponse = await call(`/api/transfers/${created.id}/parts`, {
    method: 'POST',
    body: { fromPart: 1 },
    deleteKey: created.deleteKey
  });
  const plan = await partsResponse.json();
  check('3 URL signées renvoyées', plan.parts?.length === 3, String(plan.parts?.length));
  check('URL signée avec X-Amz-Signature', /X-Amz-Signature=/.test(plan.parts?.[0]?.url || ''));
  check(
    'signature d’envoi conforme à la spécification AWS',
    signatureIsValid(plan.parts[0].url, { secret: 'S3RVER', method: 'PUT' })
  );
  const tampered = plan.parts[0].url.replace(/X-Amz-Signature=\w{8}/, 'X-Amz-Signature=00000000');
  check('signature modifiée rejetée par le vérificateur', !signatureIsValid(tampered, { secret: 'S3RVER', method: 'PUT' }));

  console.log('\n4. Envoi réel des octets vers le stockage objet');
  const etags = [];
  for (const [index, part] of plan.parts.entries()) {
    const slice = payload.subarray((part.partNumber - 1) * PART_SIZE, Math.min(part.partNumber * PART_SIZE, SIZE));
    const sent = await fetch(part.url, { method: 'PUT', body: slice });
    etags.push({ partNumber: part.partNumber, etag: sent.headers.get('etag') || '' });
    check(`morceau ${index + 1} accepté par le stockage`, sent.status === 200, `HTTP ${sent.status}`);
  }

  console.log('\n5. Finalisation');
  const completed = await call(`/api/transfers/${created.id}/complete`, {
    method: 'POST',
    body: { parts: etags },
    deleteKey: created.deleteKey
  });
  const completedBody = await completed.json();
  check('assemblage accepté', completed.status === 200, `${completed.status} ${completedBody.error || ''}`);
  check('taille finale correcte', completedBody.size === SIZE, String(completedBody.size));
  check('type MIME conservé', completedBody.mimeType === 'video/mp4', completedBody.mimeType);

  console.log('\n6. Cas « navigateur sans ETag » (CORS sans ExposeHeaders)');
  const second = await (
    await call('/api/transfers', { method: 'POST', body: { fileName: 'sans-etag.bin', size: SIZE, mimeType: 'application/octet-stream' } })
  ).json();
  const secondPlan = await (
    await call(`/api/transfers/${second.id}/parts`, { method: 'POST', body: { fromPart: 1 }, deleteKey: second.deleteKey })
  ).json();
  for (const part of secondPlan.parts) {
    const slice = payload.subarray((part.partNumber - 1) * PART_SIZE, Math.min(part.partNumber * PART_SIZE, SIZE));
    await fetch(part.url, { method: 'PUT', body: slice });
  }
  const fallback = await call(`/api/transfers/${second.id}/complete`, {
    method: 'POST',
    body: { parts: secondPlan.parts.map((part) => ({ partNumber: part.partNumber, etag: '' })) },
    deleteKey: second.deleteKey
  });
  const fallbackBody = await fallback.json();
  // Le faux serveur n'implémente pas ListParts : on vérifie donc ici que le
  // refus est explicite et actionnable plutôt qu'une erreur opaque.
  check(
    'refus explicite quand les ETag manquent (faux serveur sans ListParts)',
    fallback.status === 400 && /morceaux/i.test(fallbackBody.error || ''),
    `${fallback.status} ${String(fallbackBody.error || '').slice(0, 70)}`
  );

  console.log('\n7. Secours ListParts (lecture des ETag côté stockage)');
  const { listMultipartParts, readS3Config } = await import('../lib/s3.mjs');
  const requested = [];
  const stub = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requested.push(url.searchParams.get('part-number-marker') || 'première page');
    const marker = Number(url.searchParams.get('part-number-marker') || 0);
    const parts =
      marker === 0
        ? '<Part><PartNumber>1</PartNumber><ETag>"etag-un"</ETag></Part><Part><PartNumber>2</PartNumber><ETag>"etag-deux"</ETag></Part>'
        : '<Part><PartNumber>3</PartNumber><ETag>"etag-trois"</ETag></Part>';
    const truncated = marker === 0 ? '<IsTruncated>true</IsTruncated><NextPartNumberMarker>2</NextPartNumberMarker>' : '<IsTruncated>false</IsTruncated>';
    response.writeHead(200, { 'Content-Type': 'application/xml' });
    response.end(`<?xml version="1.0" encoding="UTF-8"?><ListPartsResult>${truncated}${parts}</ListPartsResult>`);
  });
  await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubPort = stub.address().port;
  const listed = await listMultipartParts(
    { ...readS3Config(), endpoint: `http://127.0.0.1:${stubPort}` },
    { key: 'dossier/gros.bin', uploadId: 'identifiant' }
  );
  await new Promise((resolve) => stub.close(resolve));
  check('les trois morceaux sont retrouvés', listed.length === 3, JSON.stringify(listed));
  check('ETag conservés et guillemets retirés', listed.map((part) => part.etag).join(',') === 'etag-un,etag-deux,etag-trois', listed.map((part) => part.etag).join(','));
  check('morceaux classés par numéro', listed.map((part) => part.partNumber).join(',') === '1,2,3');
  check('pagination suivie (marqueur renvoyé)', requested.length === 2 && requested[1] === '2', requested.join(' → '));

  console.log('\n8. Redirections de lecture');
  const asset = await call(`/asset/${created.id}`);
  const location = asset.headers.get('location') || '';
  check('aperçu redirigé (302)', asset.status === 302, String(asset.status));
  check('redirection vers le stockage objet', location.includes(`127.0.0.1:${PORT}`));
  check('signature de lecture conforme à la spécification AWS', signatureIsValid(location, { secret: 'S3RVER', method: 'GET' }));
  const downloaded = Buffer.from(await (await fetch(location)).arrayBuffer());
  check('octets identiques après téléchargement', downloaded.equals(payload), `${downloaded.length} octets`);
  const download = await call(`/download/${created.id}`);
  check('pièce jointe forcée sur /download', /response-content-disposition/.test(download.headers.get('location') || ''));

  console.log('\n9. Suppression');
  const deleted = await call(`/api/transfers/${created.id}`, { method: 'DELETE', deleteKey: created.deleteKey });
  check('suppression acceptée', deleted.status === 200, String(deleted.status));
  const gone = await fetch(location);
  check('objet retiré du stockage', gone.status === 404 || gone.status === 403, `HTTP ${gone.status}`);
  const afterDelete = await call(`/api/transfers/${created.id}`);
  check('API renvoie 404 après suppression', afterDelete.status === 404, String(afterDelete.status));
  const wrongKey = await call(`/api/transfers/${second.id}`, { method: 'DELETE', deleteKey: 'mauvaise-cle' });
  check('suppression refusée avec une mauvaise clé', wrongKey.status === 403, String(wrongKey.status));

  console.log('\n10. Expiration');
  const meta = await store.readMeta(second.id);
  meta.expiresAt = Date.now() - 1000;
  await store.writeMeta(meta);
  const purge = await instance.purgeNow();
  check('transfert expiré nettoyé', purge.removed >= 1, JSON.stringify(purge));
  check('métadonnées supprimées', (await store.readMeta(second.id)) === null);

  await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  if (blobsServer) await blobsServer.stop();
  await fsp.rm(S3_ROOT, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(META_ROOT, { recursive: true, force: true }).catch(() => {});

  console.log(`\n${checks - failures}/${checks} vérifications réussies.`);
  if (failures) {
    console.error(`${failures} test(s) en échec.`);
    process.exit(1);
  }
  console.log('Tous les tests S3 sont passés.\n');
}

main().catch((error) => {
  console.error('\nTest S3 interrompu :', error);
  process.exit(1);
});
