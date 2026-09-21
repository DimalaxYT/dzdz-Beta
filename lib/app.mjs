'use strict';

/**
 * Routeur unique, écrit pour l'API Web (Request / Response).
 *
 * Le même fichier sert de :
 *  - gestionnaire de fonction Netlify (netlify/functions/api.mjs) ;
 *  - application du serveur Node autonome (server.js).
 *
 * Aucune dépendance à Express : uniquement les objets standards de Node 20.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { APP_NAME, APP_VERSION, maxFileSizeHuman, readParams, resolveBaseUrl } from './params.mjs';
import { createStore } from './store.mjs';
import { formatBytes, makeId, now, secondsBetween } from './util.mjs';
import { renderQrPngBuffer, renderQrSvg } from './qr.mjs';
import {
  buildPublicPayload,
  completeTransfer,
  createPendingTransfer,
  deleteKeyFromRequest,
  deleteTransfer,
  loadTransfer,
  loadTransferByCode,
  prepareParts,
  purge,
  purgeDiscordMessages,
  registerDownload,
  safeCompareHashes,
  hashSecret
} from './transfers.mjs';
import {
  renderDashboard,
  renderHelp,
  renderHome,
  renderMessagePage,
  renderOfflinePage,
  renderReceive,
  renderSharePage,
  renderUpload
} from './views.mjs';

const PUBLIC_DIR = path.join(process.cwd(), 'public');
const STORAGE_ROOT = process.env.DROPQR_STORAGE_DIR
  ? path.resolve(process.env.DROPQR_STORAGE_DIR)
  : path.join(process.cwd(), 'storage');
const MAX_PENDING_PURGE_AGE_MS = 5 * 60 * 1000;

const MIME_BY_EXTENSION = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm'
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'"
].join('; ');

function securityHeaders(headers = {}) {
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': CSP,
    ...headers
  };
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: securityHeaders({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    })
  });
}

function json(payload, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: securityHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders
    })
  });
}

function apiError(message, status = 400) {
  return json({ error: message }, status);
}

/** Limiteur simple en mémoire (par instance) : freine les abus les plus directs. */
function createRateLimiter({ windowMs = 60_000, max = 60 }) {
  const hits = new Map();
  return function check(key) {
    const timestamp = Date.now();
    const entry = hits.get(key);
    if (!entry || timestamp - entry.start > windowMs) {
      hits.set(key, { start: timestamp, count: 1 });
      return true;
    }
    entry.count += 1;
    if (hits.size > 5000) hits.clear();
    return entry.count <= max;
  };
}

function clientKey(request) {
  const forwarded = request.headers.get('x-nf-client-connection-ip') || request.headers.get('x-forwarded-for') || '';
  return forwarded.split(',')[0].trim() || 'local';
}

export function createApp({ env = process.env, params = readParams(env), storageRoot = STORAGE_ROOT } = {}) {
  const isServerMode = storageRoot !== null && params.storageMode === 'local';
  let storePromise = null;
  let lastPurge = 0;
  const rateLimit = createRateLimiter({ windowMs: 60_000, max: 80 });

  async function getStore() {
    if (!storePromise) {
      storePromise = createStore({
        metaMode: params.metaMode,
        objectMode: params.storageMode === 'local' ? 'local' : 'remote',
        rootDir: storageRoot
      });
    }
    return storePromise;
  }

  async function makeContext(request, context = {}) {
    const store = await getStore();
    const background = (task) => {
      if (context && typeof context.waitUntil === 'function') {
        context.waitUntil(task);
        return;
      }
      Promise.resolve(task).catch(() => {});
    };
    return {
      params,
      store,
      baseUrl: resolveBaseUrl(params, request),
      background,
      request
    };
  }

  function buildConfig(request) {
    const baseUrl = resolveBaseUrl(params, request);
    const localhostWarning = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)/i.test(baseUrl);
    return {
      app: APP_NAME,
      version: APP_VERSION,
      storageMode: params.storageMode,
      metadataMode: params.metaMode,
      storageLabel:
        params.storageMode === 's3' ? 'stockage objet (S3 / R2)' : params.storageMode === 'local' ? 'disque local' : 'non configuré',
      publicUrl: baseUrl,
      directUpload: params.directUpload,
      maxFileSizeBytes: params.maxFileSizeBytes,
      maxFileSizeHuman: maxFileSizeHuman(params),
      defaultTtlMinutes: params.defaultTtlMinutes,
      maxTtlMinutes: params.maxTtlMinutes,
      partSizeBytes: params.partSizeBytes,
      multipartThresholdBytes: params.multipartThresholdBytes,
      maxParallelUploads: params.maxParallelUploads,
      discordConfigured: params.discord.enabled,
      onNetlify: params.onNetlify,
      warning: localhostWarning
        ? 'URL publique locale : le QR code ne fonctionnera que sur cette machine. Utilise PUBLIC_URL pour tester depuis un téléphone.'
        : null
    };
  }

  /* ------------------------------ fichiers locaux ----------------------------- */

  async function serveLocalFile(request, filePath, { downloadName = '', inline = true, mimeType = '', onComplete = null } = {}) {
    const stat = await fsp.stat(filePath).catch(() => null);
    if (!stat || !stat.isFile()) return null;

    const total = stat.size;
    const type = mimeType || MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const disposition = inline
      ? `inline; filename*=UTF-8''${encodeURIComponent(downloadName || path.basename(filePath))}`
      : `attachment; filename*=UTF-8''${encodeURIComponent(downloadName || path.basename(filePath))}`;

    const headers = securityHeaders({
      'Content-Type': type,
      'Content-Disposition': disposition,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store'
    });

    const range = request.headers.get('range');
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      if (!match) {
        return new Response(null, { status: 416, headers: securityHeaders({ 'Content-Range': `bytes */${total}` }) });
      }
      let start = match[1] ? Number(match[1]) : 0;
      let end = match[2] ? Number(match[2]) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        return new Response(null, { status: 416, headers: securityHeaders({ 'Content-Range': `bytes */${total}` }) });
      }
      end = Math.min(end, total - 1);
      headers['Content-Range'] = `bytes ${start}-${end}/${total}`;
      headers['Content-Length'] = String(end - start + 1);
      const stream = Readable.toWeb(
        (await import('node:fs')).createReadStream(filePath, { start, end })
      );
      return new Response(stream, { status: 206, headers });
    }

    headers['Content-Length'] = String(total);
    const nodeStream = (await import('node:fs')).createReadStream(filePath);
    if (onComplete) {
      // Le fichier n'est considéré comme récupéré que si le flux est allé au bout.
      nodeStream.on('close', () => {
        if (nodeStream.readableEnded) onComplete();
      });
    }
    return new Response(Readable.toWeb(nodeStream), { status: 200, headers });
  }

  async function serveStatic(request, pathname) {
    const relative = pathname.replace(/^\/+/, '');
    if (!/^(assets|img)\//.test(relative)) return null;
    const target = path.join(PUBLIC_DIR, relative);
    if (!target.startsWith(PUBLIC_DIR)) return null;
    const response = await serveLocalFile(request, target);
    if (!response) return null;
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', relative.startsWith('img/') ? 'public, max-age=86400' : 'no-cache');
    return new Response(response.body, { status: response.status, headers });
  }

  /* ---------------------------------- pages ---------------------------------- */

  async function renderPage(kind, request, context, extra = {}) {
    const makers = {
      home: () => renderHome({ params, request, qrSvg: extra.qrSvg }),
      upload: () => renderUpload({ params, request }),
      receive: () => renderReceive({ params, request }),
      dashboard: () => renderDashboard({ params, request }),
      help: () => renderHelp({ params, request }),
      offline: () => renderOfflinePage({ params, request })
    };
    if (makers[kind]) return html(makers[kind]());
    return null;
  }

  /* --------------------------------- routes --------------------------------- */

  /**
   * Enveloppe de sécurité : sur Netlify, une exception non rattrapée se traduit
   * par une erreur brute de la plateforme. On préfère une réponse propre.
   */
  async function handleRequest(request, context = {}) {
    try {
      return await routeRequest(request, context);
    } catch (error) {
      console.error(`[dropqr] erreur inattendue sur ${request.method} ${request.url} :`, error);
      try {
        if (new URL(request.url).pathname.startsWith('/api/')) {
          return apiError('Erreur interne du serveur. Réessaie dans un instant.', 500);
        }
        return html(
          renderMessagePage({
            params,
            request,
            code: 'error',
            title: 'Erreur interne',
            message: "Une erreur inattendue est survenue. Réessaie dans un instant."
          }),
          500
        );
      } catch {
        return new Response('Erreur interne du serveur.', {
          status: 500,
          headers: securityHeaders({ 'Content-Type': 'text/plain; charset=utf-8' })
        });
      }
    }
  }

  async function routeRequest(request, context = {}) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method.toUpperCase();
    const ctx = await makeContext(request, context);

    // Nettoyage paresseux, au plus une fois toutes les cinq minutes.
    if (params.storageMode !== 'unavailable' && now() - lastPurge > MAX_PENDING_PURGE_AGE_MS) {
      lastPurge = now();
      ctx.background(purge(ctx).catch(() => {}));
    }

    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: securityHeaders({
          'Access-Control-Allow-Origin': ctx.baseUrl || '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'content-type,x-delete-key,x-cron-secret'
        })
      });
    }

    if (params.storageMode === 'unavailable' && /^\/(api|asset|download|view|r|t|c|code|share)\b/.test(pathname)) {
      if (pathname.startsWith('/api/health')) {
        return json({ ok: false, app: APP_NAME, version: APP_VERSION, storage: 'unavailable', directUpload: false }, 503);
      }
      return apiError(
        "Stockage non configuré : ajoute les variables R2/S3 (voir /help#netlify) ou lance le projet en serveur Node.",
        503
      );
    }

    /* --------------------------- fichiers et médias --------------------------- */

    const assetMatch = /^\/(asset|download|view)\/([a-zA-Z0-9_-]{6,120})$/.exec(pathname);
    if (assetMatch && (method === 'GET' || method === 'HEAD')) {
      const [, kind, id] = assetMatch;
      const meta = await loadTransfer(ctx, id);
      if (!meta) {
        return html(
          renderMessagePage({
            params,
            request,
            code: 'expired',
            title: 'Fichier introuvable',
            message: "Ce lien est incomplet, expiré, ou le fichier a déjà été supprimé après son téléchargement."
          }),
          404
        );
      }

      // « /download » récupère le fichier ; « /view » et « /asset » ne font que l'afficher.
      // Un aperçu vidéo ne doit ni compter comme téléchargement ni déclencher le nettoyage.
      const isDownload = kind === 'download' || url.searchParams.get('download') === '1';
      const inline = !isDownload && meta.mimeType !== 'application/octet-stream';

      if (isDownload) await registerDownload(ctx, meta);

      if (meta.storage === 's3') {
        const { presignUrl } = await import('./s3.mjs');

        // Suppression après téléchargement : on raccourcit l'expiration au lieu de
        // supprimer l'objet tout de suite, pour ne pas couper un gros transfert en cours.
        if (isDownload && meta.deleteAfterDownload) {
          const graceMs = 20 * 60 * 1000;
          if (Number(meta.expiresAt) > now() + graceMs) {
            meta.expiresAt = now() + graceMs;
            await ctx.store.writeMeta(meta);
          }
        }

        const disposition = `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.fileName)}`;
        const signed = presignUrl(params.s3, {
          method: 'GET',
          key: meta.objectKey,
          expiresIn: isDownload ? 20 * 60 : 15 * 60,
          query: { 'response-content-disposition': disposition }
        });
        return new Response(null, {
          status: 302,
          headers: securityHeaders({ Location: signed, 'Cache-Control': 'no-store' })
        });
      }

      const objectPath = ctx.store.objectPath(meta.storageKey || meta.id);
      const response = await serveLocalFile(request, objectPath, {
        downloadName: meta.fileName,
        inline,
        mimeType: meta.mimeType,
        onComplete:
          isDownload && meta.deleteAfterDownload
            ? () => {
                deleteTransfer(ctx, meta, 'après téléchargement').catch(() => {});
              }
            : null
      });
      if (!response) {
        await deleteTransfer(ctx, meta, 'fichier manquant');
        return html(
          renderMessagePage({
            params,
            request,
            code: 'expired',
            title: 'Fichier introuvable',
            message: "Le fichier n'est plus présent sur le stockage. Le transfert a été nettoyé."
          }),
          404
        );
      }
      return response;
    }

    /* ------------------------------- API JSON -------------------------------- */

    if (pathname === '/api/health' && method === 'GET') {
      return json({
        ok: true,
        app: APP_NAME,
        version: APP_VERSION,
        storage: params.storageMode,
        metadata: params.metaMode,
        directUpload: params.directUpload,
        maxFileSizeBytes: params.maxFileSizeBytes,
        maxFileSizeHuman: maxFileSizeHuman(params),
        defaultTtlMinutes: params.defaultTtlMinutes,
        maxTtlMinutes: params.maxTtlMinutes,
        partSizeBytes: params.partSizeBytes,
        maxParallelUploads: params.maxParallelUploads,
        discordConfigured: params.discord.enabled,
        onNetlify: params.onNetlify,
        uptimeSeconds: Math.round(process.uptime())
      });
    }

    if (pathname === '/api/config' && method === 'GET') {
      return json(buildConfig(request));
    }

    if (pathname === '/api/stats' && method === 'GET') {
      const ids = await ctx.store.listMetaIds();
      let bytes = 0;
      let active = 0;
      for (const id of ids) {
        const meta = await ctx.store.readMeta(id);
        if (!meta || meta.status !== 'ready') continue;
        active += 1;
        bytes += Number(meta.size || 0);
      }
      return json({ activeTransfers: active, activeBytes: bytes, activeBytesHuman: formatBytes(bytes) });
    }

    if (pathname === '/api/transfers' && method === 'POST') {
      if (!rateLimit(clientKey(request))) return apiError('Trop de requêtes, réessaie dans une minute.', 429);
      const body = await request.json().catch(() => null);
      if (!body) return apiError('Corps JSON invalide.', 400);
      try {
        const context2 = await makeContext(request, context);
        const { meta, deleteKey } = await createPendingTransfer(context2, {
          fileName: body.fileName,
          size: body.size,
          mimeType: body.mimeType,
          ttlMinutes: body.ttlMinutes,
          deleteAfterDownload: body.deleteAfterDownload
        });
        const payload = buildPublicPayload(context2, meta);
        return json(
          {
            ...payload,
            status: 'pending',
            deleteKey,
            upload: meta.upload
          },
          201
        );
      } catch (error) {
        return apiError(error.message || "Création du transfert impossible.", error.status || 500);
      }
    }

    const transferRoute = /^\/api\/transfers\/([a-zA-Z0-9_-]{6,120})(?:\/(parts|complete|content|qr\.svg))?$/.exec(pathname);
    if (transferRoute) {
      const [, id, action] = transferRoute;

      const requireAuth = async ({ allowPending = true } = {}) => {
        const meta = await ctx.store.readMeta(id);
        if (!meta) return { error: apiError('Transfert introuvable.', 404) };
        if (Number(meta.expiresAt) <= now()) {
          await deleteTransfer(ctx, meta, 'expiration');
          return { error: apiError('Transfert expiré.', 410) };
        }
        if (!allowPending && meta.status !== 'ready') return { error: apiError('Transfert pas encore prêt.', 409) };
        const provided = deleteKeyFromRequest(request);
        if (!safeCompareHashes(meta.deleteKeyHash, provided ? hashSecret(provided) : '')) {
          return { error: apiError('Clé de suppression invalide.', 403) };
        }
        return { meta };
      };

      if (action === 'qr.svg' && method === 'GET') {
        const meta = await loadTransfer(ctx, id);
        if (!meta) return apiError('Transfert introuvable.', 404);
        const svg = await renderQrSvg(`${ctx.baseUrl}/r/${meta.id}`);
        return new Response(svg, {
          status: 200,
          headers: securityHeaders({
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Cache-Control': 'public, max-age=3600'
          })
        });
      }

      if (action === 'parts' && method === 'POST') {
        if (!rateLimit(`parts:${clientKey(request)}`)) return apiError('Trop de requêtes.', 429);
        const { meta, error } = await requireAuth();
        if (error) return error;
        const body = await request.json().catch(() => ({}));
        const plan = await prepareParts(ctx, meta, { fromPart: Number(body.fromPart) || 1 });
        await ctx.store.writeMeta(meta);
        return json(plan);
      }

      if (action === 'complete' && method === 'POST') {
        const { meta, error } = await requireAuth();
        if (error) return error;
        const body = await request.json().catch(() => ({}));
        try {
          await completeTransfer(ctx, meta, Array.isArray(body.parts) ? body.parts : []);
          const payload = buildPublicPayload(ctx, meta);
          return json({ ...payload, status: 'ready' });
        } catch (completeError) {
          return apiError(completeError.message || 'Finalisation impossible.', completeError.status || 500);
        }
      }

      if (action === 'content') {
        // Mode serveur : le navigateur envoie les octets ici, écrits directement sur le disque.
        if (method === 'PUT') {
          const { meta, error } = await requireAuth();
          if (error) return error;
          const target = ctx.store.objectPath(meta.storageKey || meta.id);
          await fsp.mkdir(path.dirname(target), { recursive: true });
          const partial = `${target}.incoming`;
          await fsp.rm(partial, { force: true }).catch(() => {});
          try {
            await pipeline(Readable.fromWeb(request.body), (await import('node:fs')).createWriteStream(partial));
            await fsp.rename(partial, target);
          } catch (writeError) {
            await fsp.rm(partial, { force: true }).catch(() => {});
            return apiError(`Écriture interrompue : ${writeError.message}`, 500);
          }
          const stat = await fsp.stat(target);
          return json({ ok: true, received: stat.size });
        }
        if (method === 'GET') {
          const meta = await loadTransfer(ctx, id);
          if (!meta) return apiError('Transfert introuvable.', 404);
          const response = await serveLocalFile(request, ctx.store.objectPath(meta.storageKey || meta.id), {
            downloadName: meta.fileName,
            inline: true,
            mimeType: meta.mimeType
          });
          return response || apiError('Fichier introuvable.', 404);
        }
      }

      if (!action && method === 'GET') {
        const meta = await loadTransfer(ctx, id);
        if (!meta) return apiError('Transfert introuvable.', 404);
        return json(buildPublicPayload(ctx, meta));
      }

      if (!action && method === 'DELETE') {
        const { meta, error } = await requireAuth();
        if (error) return error;
        await deleteTransfer(ctx, meta, 'suppression manuelle');
        return json({ ok: true });
      }

      return apiError('Méthode non autorisée sur cette route.', 405);
    }

    const codeRoute = /^\/api\/codes\/([A-Za-z0-9]{4,24})$/.exec(pathname);
    if (codeRoute && method === 'GET') {
      if (!rateLimit(`code:${clientKey(request)}`)) return apiError('Trop de requêtes, réessaie dans une minute.', 429);
      const meta = await loadTransferByCode(ctx, codeRoute[1]);
      if (!meta) return apiError('Code introuvable ou expiré.', 404);
      return json(buildPublicPayload(ctx, meta));
    }

    /* ------------------------- notifications Discord ------------------------- */

    if (pathname === '/api/notify/discord' && method === 'POST') {
      if (!params.discord.enabled) return apiError('Discord non configuré sur ce déploiement.', 501);
      const body = await request.json().catch(() => null);
      if (!body || !body.id) return apiError('Identifiant manquant.', 400);
      const meta = await ctx.store.readMeta(String(body.id));
      if (!meta || meta.status !== 'ready') return apiError('Transfert introuvable.', 404);
      const provided = deleteKeyFromRequest(request);
      if (!safeCompareHashes(meta.deleteKeyHash, provided ? hashSecret(provided) : '')) {
        return apiError('Clé de suppression invalide.', 403);
      }
      if (meta.discord && meta.discord.messageId) return json({ sent: true, alreadySent: true, messageId: meta.discord.messageId });

      const payload = buildPublicPayload(ctx, meta);
      const result = await sendDiscordNotification(ctx, meta, payload);
      if (result.sent && result.messageId) {
        meta.discord = { messageId: result.messageId, deleteAt: meta.expiresAt, createdAt: now() };
        await ctx.store.writeMeta(meta);
      }
      return json(result, result.sent ? 200 : 502);
    }

    /* ------------------------------- nettoyage ------------------------------- */

    if (pathname === '/api/purge' && (method === 'POST' || method === 'GET')) {
      const secret = String(env.CRON_SECRET || '');
      const provided = request.headers.get('x-cron-secret') || url.searchParams.get('secret') || '';
      if (secret && provided !== secret) return apiError('Accès refusé.', 403);
      if (!secret && params.storageMode === 's3') return apiError('CRON_SECRET non configuré.', 503);
      const result = await purge(ctx, { force: true });
      const discord = await purgeDiscordMessages(ctx).catch(() => ({ removed: 0 }));
      return json({ ok: true, ...result, discord });
    }

    /* ---------------------------------- pages -------------------------------- */

    if (method === 'GET' || method === 'HEAD') {
      if (pathname === '/' || pathname === '/index.html') {
        const qrSvg = await renderQrSvg(`${ctx.baseUrl}/upload`, { width: 360 });
        return renderPage('home', request, ctx, { qrSvg });
      }
      if (pathname === '/upload') return renderPage('upload', request, ctx);
      if (pathname === '/receive') return renderPage('receive', request, ctx);
      if (pathname === '/dashboard') return renderPage('dashboard', request, ctx);
      if (pathname === '/help') return renderPage('help', request, ctx);
      if (pathname === '/offline' || pathname === '/api-not-available.html') return renderPage('offline', request, ctx);

      const shareMatch = /^\/(r|t|share)\/([a-zA-Z0-9_-]{6,120})$/.exec(pathname);
      if (shareMatch) {
        const meta = await loadTransfer(ctx, shareMatch[2]);
        if (!meta) {
          return html(
            renderMessagePage({
              params,
              request,
              code: 'expired',
              title: 'Transfert introuvable',
              message: "Le lien est incomplet, expiré, ou le fichier a déjà été supprimé après son téléchargement.",
              cta: `<a class="btn btn-primary btn-block btn-large" href="/receive">${'Saisir un code'}</a>`
            }),
            404
          );
        }
        const payload = buildPublicPayload(ctx, meta);
        const qrSvg = await renderQrSvg(payload.shareUrl);
        return html(renderSharePage({ params, request, meta, payload, qrSvg }));
      }

      const codePageMatch = /^\/(c|code)\/([A-Za-z0-9]{4,24})$/.exec(pathname);
      if (codePageMatch) {
        const meta = await loadTransferByCode(ctx, codePageMatch[2]);
        if (!meta) {
          return html(
            renderMessagePage({
              params,
              request,
              code: 'expired',
              title: 'Code introuvable',
              message: "Ce code n'existe plus : le transfert a expiré ou le fichier a déjà été supprimé."
            }),
            404
          );
        }
        const payload = buildPublicPayload(ctx, meta);
        const qrSvg = await renderQrSvg(payload.shareUrl);
        return html(renderSharePage({ params, request, meta, payload, qrSvg }));
      }

      if (params.storageMode === 'local') {
        const staticResponse = await serveStatic(request, pathname);
        if (staticResponse) return staticResponse;
      }
    }

    if (pathname.startsWith('/api/')) return apiError('Route API introuvable.', 404);

    return html(
      renderMessagePage({
        params,
        request,
        title: 'Page introuvable',
        message: "Cette page n'existe pas. Vérifie le lien, ou reprends depuis l'accueil."
      }),
      404
    );
  }

  /* --------------------------- notification Discord ------------------------ */

  async function sendDiscordNotification(ctx, meta, payload) {
    const { webhookUrl, username, mention } = params.discord;
    if (!webhookUrl) return { sent: false, configured: false };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const qrPng = await renderQrPngBuffer(payload.shareUrl, { width: 720 });
      const expires = new Date(meta.expiresAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
      const embed = {
        title: 'Nouveau transfert DropQR',
        description: `Code : **${payload.code}**\nLien : ${payload.shareUrl}`,
        color: 0xc2603a,
        fields: [
          { name: 'Fichier', value: String(meta.fileName).slice(0, 1000), inline: false },
          { name: 'Taille', value: payload.sizeHuman, inline: true },
          { name: 'Expiration', value: expires, inline: true },
          {
            name: 'Nettoyage',
            value: meta.deleteAfterDownload ? 'Après le premier téléchargement' : "À l'expiration",
            inline: true
          }
        ],
        image: { url: `attachment://dropqr-${payload.code}.png` },
        footer: { text: `${APP_NAME} ${APP_VERSION}` },
        timestamp: new Date(meta.createdAt).toISOString()
      };

      const form = new FormData();
      form.append(
        'payload_json',
        JSON.stringify({
          username,
          content: mention ? `${mention}\nNouveau fichier prêt.` : 'Nouveau fichier prêt.',
          embeds: [embed]
        })
      );
      form.append('files[0]', new Blob([qrPng], { type: 'image/png' }), `dropqr-${payload.code}.png`);

      const response = await fetch(`${webhookUrl.split('?')[0]}?wait=true`, {
        method: 'POST',
        body: form,
        signal: controller.signal
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        return { sent: false, configured: true, status: response.status, error: detail.slice(0, 200) };
      }
      const message = await response.json().catch(() => ({}));
      return { sent: true, configured: true, messageId: message.id || null };
    } catch (error) {
      return { sent: false, configured: true, error: error.message };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    params,
    handleRequest,
    getStore,
    async purgeNow() {
      const store = await getStore();
      const ctx = { params, store, baseUrl: '', background: (task) => Promise.resolve(task).catch(() => {}), request: null };
      const result = await purge(ctx, { force: true });
      const discord = await purgeDiscordMessages(ctx).catch(() => ({ removed: 0 }));
      return { ...result, discord };
    },
    secondsBetween
  };
}
