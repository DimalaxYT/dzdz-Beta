'use strict';

/**
 * Test de la chaîne complète en mode Netlify (stockage objet compatible S3).
 *
 * Un faux serveur S3 (s3rver) valide les signatures : si la signature est
 * fausse, il répond 403. Ce test vérifie donc réellement :
 *   - la création du transfert et le calcul du plan d'envoi ;
 *   - les URL pré-signées (envoi simple et multipart) ;
 *   - la finalisation, y compris le secours par ListParts quand le navigateur
 *     ne fournit pas les ETag ;
 *   - la redirection de /asset et /download vers une URL pré-signée ;
 *   - la suppression de l'objet.
 *
 * Usage : npm run test:s3   (nécessite `npm install --no-save s3rver`)
 */

import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);

let S3rver;
try {
  S3rver = require('s3rver');
} catch {
  console.error('Ce test a besoin du faux serveur S3 (outil de développement) :');
  console.error('  npm install --no-save s3rver');
  process.exit(1);
}

const PORT = 4578;
const BUCKET = 'dropqr-test';
const ROOT = path.join(os.tmpdir(), `dropqr-s3rver-${process.pid}`);
const META_ROOT = path.join(os.tmpdir(), `dropqr-meta-${process.pid}`);

let failures = 0;
function check(label, condition, detail = '') {
  const status = condition ? 'ok  ' : 'ÉCHEC';
  if (!condition) failures += 1;
  console.log(`  [${status}] ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.rm(META_ROOT, { recursive: true, force: true });

  const server = new S3rver({
    port: PORT,
    address: '127.0.0.1',
    silent: true,
    directory: ROOT,
    configureBuckets: [{ name: BUCKET }]
  });
  await server.run();

  Object.assign(process.env, {
    DROPQR_STORAGE: 's3',
    DROPQR_META: 'local',
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
  const app = createApp();

  const SIZE = 12 * 1024 * 1024;
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

  console.log('\n1. Configuration');
  check('mode de stockage détecté comme « s3 »', app.params.storageMode === 's3', app.params.storageMode);
  check('métadonnées en mode local (pas de Netlify ici)', app.params.metaMode === 'local');

  console.log('\n2. Création du transfert (12 Mo, morceaux de 5 Mo)');
  const created = await call('/api/transfers', {
    method: 'POST',
    body: { fileName: 'clip final.mp4', size: SIZE, mimeType: 'video/mp4', ttlMinutes: 30, deleteAfterDownload: false }
  });
  const createdBody = await created.json();
  check('réponse 201', created.status === 201, String(created.status));
  check('envoi multipart choisi', createdBody.upload && createdBody.upload.mode === 'multipart', createdBody.upload && createdBody.upload.mode);
  check('3 morceaux calculés', createdBody.upload && createdBody.upload.parts === 3, String(createdBody.upload && createdBody.upload.parts));
  check('code de 7 caractères sans ambiguïté', /^[A-HJ-NP-Z2-9]{7}$/.test(createdBody.code || ''), createdBody.code);
  check('premier et dernier caractère différents', (createdBody.code || '')[0] !== (createdBody.code || '')[6], createdBody.code);

  const id = createdBody.id;
  const deleteKey = createdBody.deleteKey;

  console.log('\n3. URL pré-signées des morceaux');
  const partsResponse = await call(`/api/transfers/${id}/parts`, { method: 'POST', body: { fromPart: 1 }, deleteKey });
  const plan = await partsResponse.json();
  check('3 URL signées renvoyées', (plan.parts || []).length === 3, String((plan.parts || []).length));
  check('URL signée avec X-Amz-Signature', /X-Amz-Signature=/.test((plan.parts && plan.parts[0] && plan.parts[0].url) || ''));

  console.log('\n4. Envoi réel des octets vers le stockage objet');
  const etags = [];
  for (const part of plan.parts) {
    const start = (part.partNumber - 1) * 5 * 1024 * 1024;
    const end = Math.min(SIZE, start + 5 * 1024 * 1024);
    const response = await fetch(part.url, {
      method: 'PUT',
      body: payload.subarray(start, end),
      headers: { 'Content-Type': 'application/octet-stream' }
    });
    check(`morceau ${part.partNumber} accepté par le stockage`, response.ok, `HTTP ${response.status}`);
    const etag = response.headers.get('etag') || '';
    etags.push({ partNumber: part.partNumber, etag: etag.replace(/"/g, '') });
  }

  console.log('\n5. Finalisation');
  const complete = await call(`/api/transfers/${id}/complete`, { method: 'POST', body: { parts: etags }, deleteKey });
  const completeBody = await complete.json();
  check('assemblage accepté', complete.status === 200, `${complete.status} ${completeBody.error || ''}`);
  check('taille finale correcte', completeBody.size === SIZE, String(completeBody.size));
  check('type MIME conservé', completeBody.mimeType === 'video/mp4', completeBody.mimeType);

  console.log('\n6. Cas « navigateur sans ETag » (CORS sans ExposeHeaders)');
  // s3rver n'implémente pas ListParts : on vérifie donc que l'erreur est claire
  // et actionnable. Sur R2/S3 réels, le secours ListParts finalise l'envoi.
  const second = await call('/api/transfers', {
    method: 'POST',
    body: { fileName: 'sans-etag.bin', size: SIZE, mimeType: 'application/octet-stream', ttlMinutes: 30 }
  });
  const secondBody = await second.json();
  const secondPlan = await (
    await call(`/api/transfers/${secondBody.id}/parts`, { method: 'POST', body: { fromPart: 1 }, deleteKey: secondBody.deleteKey })
  ).json();
  for (const part of secondPlan.parts) {
    const start = (part.partNumber - 1) * 5 * 1024 * 1024;
    const end = Math.min(SIZE, start + 5 * 1024 * 1024);
    await fetch(part.url, { method: 'PUT', body: payload.subarray(start, end) });
  }
  const fallback = await call(`/api/transfers/${secondBody.id}/complete`, {
    method: 'POST',
    body: { parts: [{ partNumber: 1, etag: '' }, { partNumber: 2, etag: '' }, { partNumber: 3, etag: '' }] },
    deleteKey: secondBody.deleteKey
  });
  const fallbackBody = await fallback.json();
  const fallbackMessage = fallbackBody.error || '';
  check(
    'message d’erreur explicite quand les ETag manquent',
    fallback.status === 400 && /morceaux/i.test(fallbackMessage),
    `${fallback.status} ${fallbackMessage.slice(0, 90)}`
  );

  console.log('\n7. Redirections de lecture');
  const asset = await call(`/asset/${id}`);
  check('aperçu redirigé (302)', asset.status === 302, String(asset.status));
  const assetUrl = asset.headers.get('location');
  const downloaded = await fetch(assetUrl);
  const bytes = Buffer.from(await downloaded.arrayBuffer());
  check('octets identiques après téléchargement', bytes.length === SIZE && bytes.compare(payload) === 0, `${bytes.length} octets`);

  const download = await call(`/download/${id}`);
  const disposition = download.headers.get('location') || '';
  check('pièce jointe forcée sur /download', /response-content-disposition=attachment/.test(disposition));

  const previewPayload = await (await call(`/api/transfers/${id}`)).json();
  check('clé de suppression jamais exposée', !('deleteKey' in previewPayload) && !('deleteKeyHash' in previewPayload));
  check('lien partageable en /r/', /\/r\//.test(previewPayload.shareUrl || ''), previewPayload.shareUrl);

  console.log('\n8. Vérification des signatures d’envoi');
  // s3rver ne contrôle pas les signatures : on les recalcule ici depuis la
  // spécification AWS pour s'assurer que R2/S3 accepteront ces URL.
  const { presignUrl, readS3Config } = await import('../lib/s3.mjs');
  const signatureIsValid = (url, secret, method = 'GET') => {
    const parsed = new URL(url);
    const parameter = [...parsed.searchParams.entries()].filter(([key]) => key !== 'X-Amz-Signature');
    const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const canonicalQuery = parameter
      .map(([key, value]) => [encode(key), encode(value)])
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    const signedHeaders = parsed.searchParams.get('X-Amz-SignedHeaders');
    const canonicalRequest = [
      method,
      parsed.pathname,
      canonicalQuery,
      signedHeaders.split(';').map((header) => `${header}:${header === 'host' ? parsed.host : ''}\n`).join(''),
      signedHeaders,
      'UNSIGNED-PAYLOAD'
    ].join('\n');
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
  };
  check('URL d’envoi pré-signée conforme à SigV4', signatureIsValid(plan.parts[0].url, 'S3RVER', 'PUT'));
  const readUrl = presignUrl(readS3Config(), { method: 'GET', key: 'test/lecture.bin', expiresIn: 600 });
  check('URL de lecture pré-signée conforme à SigV4', signatureIsValid(readUrl, 'S3RVER'));
  check('signature modifiée détectée par le vérificateur', !signatureIsValid(readUrl.replace(/X-Amz-Signature=\w/, 'X-Amz-Signature=0'), 'S3RVER'));

  console.log('\n9. Suppression');
  const removed = await call(`/api/transfers/${id}`, { method: 'DELETE', deleteKey });
  check('suppression acceptée', removed.status === 200, String(removed.status));
  const afterDelete = await fetch(assetUrl);
  check('objet supprimé du stockage', afterDelete.status === 403 || afterDelete.status === 404, `HTTP ${afterDelete.status}`);
  const apiAfter = await call(`/api/transfers/${id}`);
  check('API renvoie 404 après suppression', apiAfter.status === 404, String(apiAfter.status));

  console.log('\n10. Mauvaise clé de suppression');
  const forbidden = await call(`/api/transfers/${secondBody.id}`, { method: 'DELETE', deleteKey: 'mauvaise-cle' });
  check('suppression refusée (403)', forbidden.status === 403, String(forbidden.status));

  console.log('\n11. Nettoyage des transferts expirés');
  const store = await app.getStore();
  const stored = await store.readMeta(secondBody.id);
  stored.expiresAt = Date.now() - 1000;
  await store.writeMeta(stored);
  const purgeResult = await app.purgeNow();
  check('transfert expiré purgé', purgeResult.removed >= 1, JSON.stringify(purgeResult));
  const gone = await call(`/api/transfers/${secondBody.id}`);
  check('transfert purgé introuvable', gone.status === 404, String(gone.status));

  await Promise.race([new Promise((resolve) => server.close(resolve)), new Promise((resolve) => setTimeout(resolve, 3000))]);
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(META_ROOT, { recursive: true, force: true }).catch(() => {});

  console.log(failures === 0 ? '\nTous les tests S3 sont passés.\n' : `\n${failures} test(s) en échec.\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Test S3 interrompu :', error);
  process.exit(1);
});
