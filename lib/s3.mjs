'use strict';

/**
 * Client S3 minimaliste (Cloudflare R2, Backblaze B2, AWS S3, MinIO).
 *
 * Deux usages :
 *  - signature d'URL (presign) pour que le NAVIGATEUR envoie ou lise les octets
 *    directement sur le stockage objet, sans passer par une fonction serverless
 *    (indispensable sur Netlify, limité à ~6 Mo par requête) ;
 *  - requêtes signées côté serveur (HEAD, DELETE, multipart) pour les opérations
 *    de contrôle.
 *
 * Aucune dépendance externe : tout est fait avec node:crypto.
 */

import crypto from 'node:crypto';

const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
const EMPTY_PAYLOAD_SHA = crypto.createHash('sha256').update('').digest('hex');

function hmac(key, value) {
  return crypto.createHmac('sha256', key).update(value).digest();
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Encodage conforme RFC 3986 (S3 est plus strict que encodeURIComponent). */
export function s3Encode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Lit la configuration S3 depuis les variables d'environnement.
 * Les noms R2_* sont acceptés comme alias de S3_*.
 */
export function readS3Config(env = process.env) {
  const accountId = String(env.R2_ACCOUNT_ID || '').trim();
  const explicitEndpoint = String(env.S3_ENDPOINT || '').trim();
  const endpoint = (explicitEndpoint || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''))
    .replace(/\/+$/, '');

  const config = {
    endpoint,
    bucket: String(env.S3_BUCKET || env.R2_BUCKET || '').trim(),
    region: String(env.S3_REGION || 'auto').trim() || 'auto',
    accessKeyId: String(env.S3_ACCESS_KEY_ID || env.R2_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.S3_SECRET_ACCESS_KEY || env.R2_SECRET_ACCESS_KEY || '').trim(),
    forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === 'true' : true,
    publicBaseUrl: String(env.S3_PUBLIC_BASE_URL || '').trim().replace(/\/+$/, ''),
    prefix: String(env.S3_PREFIX || 'dropqr').trim().replace(/^\/+|\/+$/g, '')
  };

  if (config.forcePathStyle && config.endpoint.includes('amazonaws.com') && !explicitEndpoint) {
    config.forcePathStyle = false;
  }

  return config;
}

export function isS3Configured(config) {
  return Boolean(
    config &&
      config.endpoint &&
      config.bucket &&
      config.accessKeyId &&
      config.secretAccessKey
  );
}

export function objectKey(config, id, extension = '') {
  const safeExt = String(extension || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 16);
  const base = config.prefix ? `${config.prefix}/` : '';
  return `${base}${id}${safeExt}`;
}

function splitEndpoint(endpoint) {
  const url = new URL(endpoint);
  return { protocol: url.protocol, host: url.host, hostname: url.hostname, port: url.port };
}

function buildObjectUrl(config, key) {
  const { protocol, host } = splitEndpoint(config.endpoint);
  const encodedKey = String(key)
    .split('/')
    .map(s3Encode)
    .join('/');

  if (config.forcePathStyle) {
    return {
      url: `${protocol}//${host}/${s3Encode(config.bucket)}/${encodedKey}`,
      host,
      canonicalUri: `/${s3Encode(config.bucket)}/${encodedKey}`
    };
  }

  const virtualHost = `${config.bucket}.${host}`;
  return {
    url: `${protocol}//${virtualHost}/${encodedKey}`,
    host: virtualHost,
    canonicalUri: `/${encodedKey}`
  };
}

function canonicalQueryString(params) {
  const pairs = Object.entries(params)
    // On garde les paramètres à valeur vide : « ?uploads » fait partie de la
    // signature et doit être envoyé tel quel (uploads=).
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => [s3Encode(key), s3Encode(value)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.map(([key, value]) => `${key}=${value}`).join('&');
}

function signingKey(config, dateStamp) {
  const kDate = hmac(`AWS4${config.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  return hmac(kService, 'aws4_request');
}

function amzDates(date = new Date()) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingContext(config, { method, host, canonicalUri, query, headers, payloadHash, date }) {
  const { amzDate, dateStamp } = amzDates(date);
  const normalizedHeaders = new Map();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    normalizedHeaders.set(key.toLowerCase(), String(value).replace(/\s+/g, ' ').trim());
  }
  if (!normalizedHeaders.has('host')) normalizedHeaders.set('host', host);
  normalizedHeaders.set('x-amz-date', amzDate);
  normalizedHeaders.set('x-amz-content-sha256', payloadHash);

  const sortedHeaderKeys = [...normalizedHeaders.keys()].sort();
  const canonicalHeaders = sortedHeaderKeys
    .map((key) => `${key}:${normalizedHeaders.get(key)}\n`)
    .join('');
  const signedHeaders = sortedHeaderKeys.join(';');
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString(query || {}),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest)
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(config, dateStamp))
    .update(stringToSign)
    .digest('hex');

  return { amzDate, dateStamp, credentialScope, signedHeaders, signature, normalizedHeaders };
}

/**
 * Génère une URL pré-signée utilisable directement par le navigateur.
 */
export function presignUrl(config, { method = 'GET', key, expiresIn = 900, query = {}, headers = {}, date = new Date() }) {
  const { url, host, canonicalUri } = buildObjectUrl(config, key);
  const { dateStamp } = amzDates(date);
  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const signedQuery = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDates(date).amzDate,
    'X-Amz-Expires': String(Math.max(1, Math.min(604800, Math.floor(expiresIn)))),
    'X-Amz-SignedHeaders': 'host'
  };

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQueryString(signedQuery),
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(config, dateStamp))
    .update(['AWS4-HMAC-SHA256', signedQuery['X-Amz-Date'], credentialScope, sha256Hex(canonicalRequest)].join('\n'))
    .digest('hex');

  const params = new URLSearchParams(signedQuery);
  params.set('X-Amz-Signature', signature);
  return `${url}?${params.toString()}`;
}

/**
 * Requête signée côté serveur (HEAD, DELETE, POST multipart...).
 */
export async function s3Request(config, { method = 'GET', key, query = {}, body = undefined, text = false, headers = {}, date = new Date() }) {
  const { url, host, canonicalUri } = buildObjectUrl(config, key);
  const payload = body === undefined ? '' : body;
  const payloadHash = payload === '' ? EMPTY_PAYLOAD_SHA : sha256Hex(payload);
  const allHeaders = { ...headers };
  if (payload !== '' && !allHeaders['content-type']) allHeaders['content-type'] = 'application/octet-stream';

  const ctx = signingContext(config, {
    method,
    host,
    canonicalUri,
    query,
    headers: allHeaders,
    payloadHash,
    date
  });

  const params = new URLSearchParams(query);
  const target = params.toString() ? `${url}?${params.toString()}` : url;
  const requestHeaders = Object.fromEntries(ctx.normalizedHeaders.entries());
  requestHeaders.Authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${ctx.credentialScope}, SignedHeaders=${ctx.signedHeaders}, Signature=${ctx.signature}`;

  const response = await fetch(target, {
    method,
    headers: requestHeaders,
    body: payload === '' ? undefined : payload
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`S3 ${method} ${response.status} ${detail.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  return text ? response.text() : response;
}

export async function headObject(config, key) {
  try {
    const response = await s3Request(config, { method: 'HEAD', key });
    return {
      exists: true,
      size: Number(response.headers.get('content-length') || 0),
      contentType: response.headers.get('content-type') || null,
      etag: (response.headers.get('etag') || '').replace(/"/g, '')
    };
  } catch (error) {
    if (error.status === 404) return { exists: false };
    throw error;
  }
}

export async function deleteObject(config, key) {
  try {
    await s3Request(config, { method: 'DELETE', key });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/* ------------------------------- multipart ------------------------------- */

function xmlValue(xml, tag) {
  const match = String(xml).match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return match ? match[1] : '';
}

export async function createMultipartUpload(config, { key, contentType }) {
  const query = { uploads: '' };
  const { url, host, canonicalUri } = buildObjectUrl(config, key);
  const body = '';
  const payloadHash = sha256Hex(body);
  const headers = {
    'content-type': contentType || 'application/octet-stream'
  };

  const ctx = signingContext(config, {
    method: 'POST',
    host,
    canonicalUri,
    query,
    headers,
    payloadHash
  });

  const target = `${url}?${canonicalQueryString(query)}`;
  const requestHeaders = Object.fromEntries(ctx.normalizedHeaders.entries());
  requestHeaders.Authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${ctx.credentialScope}, SignedHeaders=${ctx.signedHeaders}, Signature=${ctx.signature}`;

  const response = await fetch(target, { method: 'POST', headers: requestHeaders });
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    const error = new Error(`Création multipart impossible (${response.status}) ${text.slice(0, 200)}`);
    error.status = response.status;
    throw error;
  }

  const uploadId = xmlValue(text, 'UploadId');
  if (!uploadId) {
    const error = new Error('Réponse multipart sans UploadId.');
    error.status = 502;
    throw error;
  }
  return uploadId;
}

export function presignUploadPart(config, { key, uploadId, partNumber, expiresIn = 3600 }) {
  return presignUrl(config, {
    method: 'PUT',
    key,
    expiresIn,
    query: { partNumber: String(partNumber), uploadId }
  });
}

export async function completeMultipartUpload(config, { key, uploadId, parts }) {
  const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
  const body = [
    '<CompleteMultipartUpload>',
    ...sorted.map(
      (part) =>
        `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${String(part.etag).replace(/[<>]/g, '')}</ETag></Part>`
    ),
    '</CompleteMultipartUpload>'
  ].join('');

  const text = await s3Request(config, {
    method: 'POST',
    key,
    query: { uploadId },
    body,
    text: true,
    headers: { 'content-type': 'application/xml' }
  });

  if (/<Error>/i.test(text)) {
    const error = new Error(`Assemblage multipart refusé: ${xmlValue(text, 'Message') || text.slice(0, 200)}`);
    error.status = 502;
    throw error;
  }
  return true;
}

export async function abortMultipartUpload(config, { key, uploadId }) {
  try {
    await s3Request(config, { method: 'DELETE', key, query: { uploadId } });
    return true;
  } catch (error) {
    if (error.status === 404) return false;
    throw error;
  }
}

/**
 * Liste les morceaux déjà reçus (avec leurs ETag).
 * Sert de secours quand le navigateur ne peut pas lire l'en-tête ETag
 * (par exemple si CORS n'expose pas cet en-tête côté stockage).
 */
export async function listMultipartParts(config, { key, uploadId }) {
  const parts = [];
  let marker = null;

  for (let page = 0; page < 20; page += 1) {
    const query = { uploadId };
    if (marker) query['part-number-marker'] = String(marker);
    const xml = await s3Request(config, { method: 'GET', key, query, text: true });

    const blocks = String(xml).match(/<Part>[\s\S]*?<\/Part>/g) || [];
    blocks.forEach((block) => {
      parts.push({
        partNumber: Number(xmlValue(block, 'PartNumber')),
        etag: xmlValue(block, 'ETag').replace(/"/g, '')
      });
    });

    if (!/<IsTruncated>true<\/IsTruncated>/i.test(xml)) break;
    marker = Number(xmlValue(xml, 'NextPartNumberMarker')) || null;
    if (!marker) break;
  }

  return parts.filter((part) => Number.isInteger(part.partNumber) && part.etag).sort((a, b) => a.partNumber - b.partNumber);
}
