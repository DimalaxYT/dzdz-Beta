'use strict';

/**
 * Serveur Node autonome (localhost, VPS, Railway, Render...).
 *
 * Il ne fait qu'une chose : convertir les requêtes Node en objets Web standard
 * et confier le traitement au même routeur que celui utilisé par la fonction
 * Netlify (lib/app.mjs). Le comportement est donc identique des deux côtés.
 */

import http from 'node:http';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { loadDotEnv, readParams } from './lib/params.mjs';

await loadDotEnv(new URL('./.env', import.meta.url));

const { createApp } = await import('./lib/app.mjs');

const params = readParams();
const storageRoot = process.env.DROPQR_STORAGE_DIR
  ? path.resolve(process.env.DROPQR_STORAGE_DIR)
  : path.join(process.cwd(), 'storage');

const app = createApp({ params, storageRoot });

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

function toWebRequest(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const url = new URL(req.url || '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : String(value));
  }

  const init = { method: req.method, headers };
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    init.body = Readable.toWeb(req);
    init.duplex = 'half';
  }
  return new Request(url, init);
}

async function sendWebResponse(res, response, method) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  headers['X-Powered-By'] = 'DropQR';
  res.writeHead(response.status, headers);
  if (method === 'HEAD' || !response.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(response.body), res);
}

const server = http.createServer(async (req, res) => {
  try {
    const request = toWebRequest(req);
    const response = await app.handleRequest(request, {});
    await sendWebResponse(res, response, req.method);
  } catch (error) {
    const aborted = ['ECONNRESET', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code) ||
      /aborted/i.test(error.message || '');
    if (!aborted) console.error('[dropqr] erreur de requête:', error);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    }
    res.end(JSON.stringify({ error: 'Erreur serveur.' }));
  }
});

server.listen(PORT, HOST, () => {
  const label =
    params.storageMode === 's3'
      ? `stockage objet (bucket ${params.s3.bucket})`
      : params.storageMode === 'local'
        ? `disque local (${storageRoot})`
        : 'stockage non configuré';
  console.log(`DropQR ${params.appVersion} écoute sur http://${HOST}:${PORT} — ${label}`);
  console.log(`Limite par fichier : ${params.maxFileSizeBytes ? `${Math.round(params.maxFileSizeBytes / 1024 / 1024)} Mo` : 'illimitée'} · morceaux de ${Math.round(params.partSizeBytes / 1024 / 1024)} Mo · ${params.maxParallelUploads} flux`);
  if (params.publicUrl) console.log(`URL publique : ${params.publicUrl}`);
});

// Nettoyage périodique en mode serveur (les fonctions Netlify ont leur tâche planifiée).
if (params.storageMode !== 'unavailable') {
  const interval = setInterval(
    () => app.purgeNow().catch((error) => console.error('[dropqr] nettoyage:', error.message)),
    10 * 60 * 1000
  );
  interval.unref?.();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`\n[dropqr] ${signal} reçu, arrêt.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
