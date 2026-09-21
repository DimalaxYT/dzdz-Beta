'use strict';

/**
 * Logique métier des transferts : création, finalisation, lecture publique,
 * suppression et nettoyage. Indépendante du transport HTTP (le routeur passe
 * un contexte).
 */

import crypto from 'node:crypto';
import {
  cleanOriginalName,
  extensionOf,
  formatBytes,
  isDangerousExtension,
  makeId,
  makeTransferCode,
  normalizeCode,
  now,
  parseTtlMinutes,
  secondsBetween,
  safeStoredExtension
} from './util.mjs';
import {
  abortMultipartUpload,
  completeMultipartUpload,
  createMultipartUpload,
  deleteObject,
  headObject,
  listMultipartParts,
  objectKey,
  presignUploadPart,
  presignUrl
} from './s3.mjs';

const PENDING_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Types qu'on accepte de servir en ligne dans le navigateur. */
const INLINE_SAFE_MIME = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|video\/[a-z0-9.+-]+|audio\/[a-z0-9.+-]+|application\/pdf|text\/plain)$/i;

export function sanitizeMimeType(mimeType, fileName) {
  const value = String(mimeType || '').toLowerCase().split(';')[0].trim();
  if (!value || isDangerousExtension(fileName)) return 'application/octet-stream';
  return INLINE_SAFE_MIME.test(value) ? value : 'application/octet-stream';
}

export function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function safeCompareHashes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function deleteKeyFromRequest(request) {
  return (
    request.headers.get('x-delete-key') ||
    request.headers.get('x-auth-key') ||
    ''
  );
}

export function isExpired(meta, at = now()) {
  return Number(meta.expiresAt) <= at;
}

export function isReady(meta) {
  return meta.status === 'ready';
}

export function receivePath(meta) {
  return `/r/${meta.id}`;
}

/** Charge un transfert par identifiant, en refusant ceux qui ne sont pas prêts. */
export async function loadTransfer(ctx, id, { requireReady = true } = {}) {
  if (!id || !/^[a-zA-Z0-9_-]{6,120}$/.test(String(id))) return null;
  const meta = await ctx.store.readMeta(id);
  if (!meta) return null;
  if (isExpired(meta)) {
    await deleteTransfer(ctx, meta, 'expiration');
    return null;
  }
  if (requireReady && !isReady(meta)) return null;
  return meta;
}

export async function loadTransferByCode(ctx, code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  const id = await ctx.store.readCode(normalized);
  if (!id) return null;
  return loadTransfer(ctx, id);
}

/* ------------------------------- création -------------------------------- */

export async function createPendingTransfer(ctx, { fileName, size, mimeType, ttlMinutes, deleteAfterDownload }) {
  const { params } = ctx;
  const cleanName = cleanOriginalName(fileName);
  const bytes = Number(size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw Object.assign(new Error('Taille de fichier invalide.'), { status: 400 });
  }
  if (params.maxFileSizeBytes && bytes > params.maxFileSizeBytes) {
    throw Object.assign(
      new Error(`Fichier trop volumineux. Limite actuelle : ${formatBytes(params.maxFileSizeBytes)}.`),
      { status: 413 }
    );
  }

  const id = makeId(16);
  const deleteKey = makeId(24);
  const resolvedTtl = parseTtlMinutes(ttlMinutes, {
    defaultMinutes: params.defaultTtlMinutes,
    maxMinutes: params.maxTtlMinutes
  });

  // Réserve un code libre (tirage cryptographique, index dédié, pas de collision silencieuse).
  let code = null;
  for (let attempt = 0; attempt < 6 && !code; attempt += 1) {
    const candidate = makeTransferCode(7);
    const reserved = await ctx.store.reserveCode(candidate, id);
    if (reserved) code = candidate;
  }
  if (!code) throw Object.assign(new Error('Impossible de générer un code de transfert.'), { status: 503 });

  const extension = safeStoredExtension(cleanName) || extensionOf(cleanName);
  const meta = {
    id,
    code,
    fileName: cleanName,
    mimeType: sanitizeMimeType(mimeType, cleanName),
    size: bytes,
    ttlMinutes: resolvedTtl,
    deleteAfterDownload: deleteAfterDownload !== false,
    createdAt: now(),
    expiresAt: now() + resolvedTtl * 60 * 1000,
    downloads: 0,
    status: 'pending',
    storage: params.storageMode,
    objectKey: objectKey(params.s3, `${id}${extension}`),
    // En mode serveur, l'objet vit sur le disque sous cette clé.
    storageKey: `${id}${extension}`,
    deleteKeyHash: hashSecret(deleteKey),
    upload: { mode: bytes > params.multipartThresholdBytes ? 'multipart' : 'single', partSize: params.partSizeBytes }
  };

  await ctx.store.writeMeta(meta);

  // Prépare les URL d'envoi (le navigateur écrit directement dans le stockage objet).
  meta.upload = await prepareUpload(ctx, meta);
  await ctx.store.writeMeta(meta);

  return { meta, deleteKey };
}

async function prepareUpload(ctx, meta) {
  const { params } = ctx;
  const totalParts = Math.max(1, Math.ceil(meta.size / params.partSizeBytes));

  if (meta.storage !== 's3') {
    // Sans stockage objet, le fichier passe par la fonction : écrit sur le
    // disque (serveur Node) ou rangé dans Netlify Blobs. En une seule fois.
    return {
      mode: 'local-single',
      partSize: params.partSizeBytes,
      maxParallel: 1,
      parts: 1,
      url: `/api/transfers/${meta.id}/content`
    };
  }

  if (totalParts === 1) {
    return {
      mode: 'single',
      partSize: params.partSizeBytes,
      maxParallel: 1,
      parts: 1,
      single: {
        url: presignUrl(params.s3, { method: 'PUT', key: meta.objectKey, expiresIn: 3600 }),
        method: 'PUT'
      }
    };
  }

  const uploadId = await createMultipartUpload(params.s3, {
    key: meta.objectKey,
    contentType: meta.mimeType
  });

  return {
    mode: 'multipart',
    partSize: params.partSizeBytes,
    maxParallel: params.maxParallelUploads,
    parts: totalParts,
    uploadId
  };
}

/** (Re)génère les URL pré-signées des morceaux, à la demande. */
export async function prepareParts(ctx, meta, { fromPart = 1 } = {}) {
  const { params } = ctx;
  const upload = meta.upload || {};
  const totalParts = Number(upload.parts || 1);
  const tail = Math.min(200, Math.max(1, Number(upload.urlBatchSize) || 40));
  const start = Math.max(1, Math.min(totalParts, Number(fromPart) || 1));
  const end = Math.min(totalParts, start + tail - 1);

  if (upload.mode === 'single' || totalParts === 1) {
    return {
      mode: 'single',
      parts: [
        {
          partNumber: 1,
          url: presignUrl(params.s3, { method: 'PUT', key: meta.objectKey, expiresIn: 3600 }),
          method: 'PUT'
        }
      ]
    };
  }

  if (upload.mode === 'local-single') {
    return {
      mode: 'local',
      parts: [
        {
          partNumber: 1,
          url: `/api/transfers/${meta.id}/content`,
          method: 'PUT'
        }
      ]
    };
  }

  if (!upload.uploadId) {
    const refreshed = await prepareUpload(ctx, meta);
    meta.upload = { ...upload, ...refreshed };
    await ctx.store.writeMeta(meta);
    if (refreshed.mode !== 'multipart') return prepareParts(ctx, meta, { fromPart });
  }

  return {
    mode: 'multipart',
    parts: Array.from({ length: end - start + 1 }, (_, index) => ({
      partNumber: start + index,
      url: presignUploadPart(params.s3, {
        key: meta.objectKey,
        uploadId: meta.upload.uploadId,
        partNumber: start + index,
        expiresIn: 3600
      }),
      method: 'PUT'
    }))
  };
}

export async function completeTransfer(ctx, meta, parts = []) {
  const { params } = ctx;
  const upload = meta.upload || {};

  if (meta.storage === 's3') {
    if (upload.mode === 'multipart') {
      const expected = Number(upload.parts);
      let confirmed = parts
        .map((part) => ({ partNumber: Number(part.partNumber), etag: String(part.etag || '').replace(/"/g, '') }))
        .filter((part) => Number.isInteger(part.partNumber) && part.partNumber >= 1 && part.etag);

      // Si le navigateur n'a pas pu lire les ETag (CORS), on les demande au stockage.
      if (confirmed.length !== expected) {
        const listed = await listMultipartParts(params.s3, { key: meta.objectKey, uploadId: upload.uploadId }).catch(() => []);
        if (listed.length > confirmed.length) confirmed = listed;
      }

      if (confirmed.length !== expected) {
        throw Object.assign(
          new Error(`Il manque des morceaux : ${confirmed.length}/${expected} confirmés. Relance l'envoi, les morceaux déjà reçus sont conservés.`),
          { status: 400 }
        );
      }
      await completeMultipartUpload(params.s3, { key: meta.objectKey, uploadId: upload.uploadId, parts: confirmed });
    }

    const head = await headObject(params.s3, meta.objectKey);
    if (!head.exists) {
      throw Object.assign(new Error('Le fichier envoyé est introuvable dans le stockage.'), { status: 409 });
    }
    if (head.size && Math.abs(head.size - meta.size) > 1) {
      await deleteObject(params.s3, meta.objectKey).catch(() => {});
      throw Object.assign(
        new Error(`Taille incohérente : ${formatBytes(head.size)} reçus sur ${formatBytes(meta.size)} attendus.`),
        { status: 400 }
      );
    }
    if (head.size) meta.size = head.size;
  } else {
    const stat = await ctx.store.statObject(meta.storageKey || meta.id);
    if (!stat.exists || !stat.size) {
      throw Object.assign(new Error('Le fichier envoyé est introuvable sur le disque.'), { status: 409 });
    }
    meta.size = stat.size;
  }

  delete meta.uploadId;
  meta.upload = { ...upload, completed: true };
  meta.status = 'ready';
  meta.readyAt = now();
  await ctx.store.writeMeta(meta);
  return meta;
}

/* --------------------------------- lecture -------------------------------- */

export function buildPublicPayload(ctx, meta) {
  const base = ctx.baseUrl || '';
  return {
    id: meta.id,
    code: meta.code,
    status: meta.status,
    fileName: meta.fileName,
    size: meta.size,
    sizeHuman: formatBytes(meta.size),
    mimeType: meta.mimeType,
    createdAt: new Date(meta.createdAt).toISOString(),
    expiresAt: new Date(meta.expiresAt).toISOString(),
    secondsRemaining: secondsBetween(now(), meta.expiresAt),
    ttlMinutes: meta.ttlMinutes,
    deleteAfterDownload: Boolean(meta.deleteAfterDownload),
    downloads: Number(meta.downloads || 0),
    shareUrl: `${base}${receivePath(meta)}`,
    receiveUrl: `${base}/receive?code=${encodeURIComponent(meta.code)}`,
    contentUrl: `${base}/asset/${meta.id}`,
    downloadUrl: `${base}/download/${meta.id}`,
    previewUrl: `${base}${meta.storage === 'local' ? `/api/transfers/${meta.id}/content` : `/asset/${meta.id}`}`,
    qrUrl: `${base}/api/transfers/${meta.id}/qr.svg`,
    inlineSafe: meta.mimeType !== 'application/octet-stream',
    canPreview: /^(video|audio)\//i.test(meta.mimeType),
    storage: meta.storage
  };
}

/**
 * Incrémente le compteur de téléchargements.
 * La mise à jour est attendue avant d'envoyer le fichier : sinon elle peut
 * réécrire un transfert que la suppression « après téléchargement » vient
 * justement de retirer du stockage.
 */
export async function registerDownload(ctx, meta) {
  if (meta.deleteAfterDownload) return; // le transfert disparaît : inutile de compter
  try {
    const fresh = await ctx.store.readMeta(meta.id);
    if (!fresh || !isReady(fresh)) return;
    fresh.downloads = Number(fresh.downloads || 0) + 1;
    fresh.lastDownloadAt = now();
    await ctx.store.writeMeta(fresh);
  } catch {
    /* un compteur n'est jamais bloquant */
  }
}

/** Supprime un transfert et tout ce qui va avec (objet, code, message Discord). */
export async function deleteTransfer(ctx, metaOrId, reason = 'suppression') {
  const meta = typeof metaOrId === 'string' ? await ctx.store.readMeta(metaOrId) : metaOrId;
  if (!meta) return false;

  await ctx.store.deleteMeta(meta.id);
  if (meta.code) await ctx.store.releaseCode(meta.code);

  if (meta.storage === 's3' && meta.objectKey) {
    if (meta.upload && meta.upload.uploadId && !meta.upload.completed) {
      await abortMultipartUpload(ctx.params.s3, { key: meta.objectKey, uploadId: meta.upload.uploadId }).catch(() => {});
    }
    await deleteObject(ctx.params.s3, meta.objectKey).catch(() => {});
  } else if (meta.storageKey || meta.id) {
    await ctx.store.deleteObject(meta.storageKey || meta.id).catch(() => {});
  }

  if (meta.discord && meta.discord.messageId) {
    ctx.background(deleteDiscordMessage(ctx, meta).catch(() => {}));
  }

  console.log(`[dropqr] transfert supprimé (${reason}) ${meta.id} (${meta.fileName})`);
  return true;
}

/* -------------------------------- nettoyage ------------------------------- */

export async function purge(ctx, { force = false } = {}) {
  if (!force) {
    const lock = await ctx.store.tryLock('purge', 120_000);
    if (!lock) return { skipped: true };
    try {
      return await runPurge(ctx);
    } finally {
      await ctx.store.releaseLock(lock);
    }
  }
  return runPurge(ctx);
}

async function runPurge(ctx) {
  const ids = await ctx.store.listMetaIds();
  const timestamp = now();
  let removed = 0;

  for (const id of ids) {
    const meta = await ctx.store.readMeta(id);
    if (!meta) continue;
    const expired = isExpired(meta, timestamp);
    const abandoned = meta.status === 'pending' && timestamp - Number(meta.createdAt || 0) > PENDING_MAX_AGE_MS;
    if (expired || abandoned) {
      await deleteTransfer(ctx, meta, expired ? 'expiration' : 'envoi abandonné');
      removed += 1;
    }
  }

  return { removed, scanned: ids.length };
}

/* -------------------------------- discord --------------------------------- */

async function deleteDiscordMessage(ctx, meta) {
  const webhook = ctx.params.discord.webhookUrl;
  const messageId = meta.discord && meta.discord.messageId;
  if (!webhook || !messageId) return false;
  const base = webhook.split('?')[0].replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${base}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      signal: controller.signal
    });
    return response.ok || response.status === 404;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function purgeDiscordMessages(ctx) {
  const webhook = ctx.params.discord.webhookUrl;
  if (!webhook) return { removed: 0 };
  const ids = await ctx.store.listMetaIds();
  let removed = 0;
  for (const id of ids) {
    const meta = await ctx.store.readMeta(id);
    if (!meta || !meta.discord || !meta.discord.messageId) continue;
    if (Number(meta.discord.deleteAt || 0) > now()) continue;
    const ok = await deleteDiscordMessage(ctx, meta).catch(() => false);
    if (ok) {
      delete meta.discord;
      await ctx.store.writeMeta(meta);
      removed += 1;
    }
  }
  return { removed };
}
