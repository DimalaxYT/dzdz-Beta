'use strict';

/**
 * Lecture de la configuration depuis l'environnement + détection du mode
 * d'hébergement. Le même code tourne :
 *  - en fonctions Netlify (stockage objet S3/R2 + Netlify Blobs) ;
 *  - sur un serveur Node classique (stockage local disque).
 */

import { isS3Configured, readS3Config } from './s3.mjs';
import { formatBytes } from './util.mjs';

export const APP_NAME = 'DropQR';
export const APP_VERSION = '2.0.0';

const UNLIMITED_VALUES = new Set(['0', 'none', 'no', 'false', 'unlimited', 'illimite', 'illimité', 'infini']);

function parseMaxFileSize(env) {
  const raw = String(env.MAX_FILE_SIZE || '').trim().toLowerCase();
  if (raw && UNLIMITED_VALUES.has(raw)) return null;

  const megabytes = Number(env.MAX_FILE_SIZE_MB);
  if (Number.isFinite(megabytes) && megabytes > 0) return Math.floor(megabytes * 1024 * 1024);

  const match = raw.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);
  if (!match) return 2 * 1024 ** 3;
  const value = Number(match[1]);
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[match[2] || 'b'];
  return Math.floor(value * factor);
}

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

export function readParams(env = process.env) {
  const s3 = readS3Config(env);
  const s3Ready = isS3Configured(s3);
  const onNetlify = Boolean(env.NETLIFY || env.NETLIFY_DEV || env.NETLIFY_BLOBS_CONTEXT);

  const requestedStorage = String(env.DROPQR_STORAGE || 'auto').trim().toLowerCase();
  let storageMode;
  if (requestedStorage === 's3') storageMode = s3Ready ? 's3' : 'unavailable';
  else if (requestedStorage === 'local') storageMode = 'local';
  else storageMode = s3Ready ? 's3' : onNetlify ? 'unavailable' : 'local';

  // Métadonnées : Netlify Blobs en production Netlify, fichiers JSON ailleurs
  // (utile pour un serveur Node branché sur R2/S3 sans Netlify).
  const requestedMeta = String(env.DROPQR_META || 'auto').trim().toLowerCase();
  const metaMode =
    requestedMeta === 'blobs' ? 'blobs' : requestedMeta === 'local' ? 'local' : onNetlify ? 'blobs' : 'local';

  const defaultTtlMinutes = Math.min(Math.max(1, Number(env.DEFAULT_TTL_MINUTES) || 30), 60 * 24 * 30);
  const maxTtlMinutes = Math.min(
    Math.max(defaultTtlMinutes, Number(env.MAX_TTL_MINUTES) || 24 * 60),
    60 * 24 * 30
  );

  const partSizeBytes = Math.max(5 * 1024 * 1024, Math.min(64 * 1024 * 1024, (Number(env.PART_SIZE_MB) || 8) * 1024 * 1024));

  return {
    appName: APP_NAME,
    appVersion: APP_VERSION,
    storageMode,
    storageRequested: requestedStorage,
    metaMode,
    onNetlify,
    s3,
    s3Ready,
    maxFileSizeBytes: parseMaxFileSize(env),
    defaultTtlMinutes,
    maxTtlMinutes,
    partSizeBytes,
    multipartThresholdBytes: partSizeBytes,
    maxParallelUploads: Math.max(1, Math.min(6, Number(env.UPLOAD_CONCURRENCY) || 3)),
    maxParts: 10_000,
    discord: {
      webhookUrl: String(env.DISCORD_WEBHOOK_URL || '').trim(),
      username: String(env.DISCORD_USERNAME || 'DropQR').trim() || 'DropQR',
      mention: String(env.DISCORD_MENTION || '').trim(),
      enabled: bool(env.DISCORD_NOTIFY, true) && Boolean(String(env.DISCORD_WEBHOOK_URL || '').trim())
    },
    publicUrl: String(env.PUBLIC_URL || '').replace(/\/+$/, ''),
    // Réglages de sécurité
    allowInlineHtml: bool(env.ALLOW_INLINE_HTML, false),
    directUpload: s3Ready
  };
}

/** URL publique utilisée pour construire les liens et le QR code. */
export function resolveBaseUrl(params, request) {
  if (params.publicUrl) return params.publicUrl;
  for (const key of ['URL', 'DEPLOY_PRIME_URL', 'DEPLOY_URL']) {
    const value = String((request && request.env && request.env[key]) || process.env[key] || '').replace(/\/+$/, '');
    if (value) return value;
  }
  if (request && request.url) {
    try {
      const url = new URL(request.url);
      return `${url.protocol}//${url.host}`;
    } catch {
      /* ignore */
    }
  }
  return '';
}

export function maxFileSizeHuman(params) {
  if (params.maxFileSizeBytes === null) return 'illimité';
  return formatBytes(params.maxFileSizeBytes);
}

/** Charge .env en développement local, sans dépendance externe. */
export async function loadDotEnv(fileUrl) {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(fileUrl, 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const index = trimmed.indexOf('=');
      if (index === -1) continue;
      const key = trimmed.slice(0, index).trim();
      let value = trimmed.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    /* pas de .env : normal */
  }
}
