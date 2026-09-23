'use strict';

const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const { pipeline } = require('stream/promises');
const path = require('path');

const app = express();
const trustProxyRaw = String(process.env.TRUST_PROXY || '1').trim().toLowerCase();
const trustProxy = trustProxyRaw === 'false'
  ? false
  : (/^\d+$/.test(trustProxyRaw) ? Number(trustProxyRaw) : 1);
app.set('trust proxy', trustProxy);
app.disable('x-powered-by');

// Par défaut, le site est entièrement same-origin: aucun en-tête CORS permissif
// n'est émis. Pour exposer l'API à d'autres sites, liste les origines autorisées
// dans CORS_ORIGINS (séparées par des virgules, '*' pour tout autoriser).
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin))) {
    res.setHeader('Access-Control-Allow-Origin', CORS_ORIGINS.includes('*') ? '*' : origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Delete-Key, Range, X-Requested-With');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Disposition, Retry-After');
  }
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  next();
});


const APP_VERSION = '1.12.0';

// Le port vient toujours de l'environnement (Render, Railway, etc. l'injectent).
// En local, on retombe sur 3000 comme annoncé dans le README.
const parsedPort = Number(process.env.PORT);
const PORT = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535 ? parsedPort : 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const DISCORD_USERNAME = process.env.DISCORD_USERNAME || 'DropQR';
const DISCORD_MENTION = (process.env.DISCORD_MENTION || '').trim();
const DISCORD_NOTIFY = process.env.DISCORD_NOTIFY !== 'false';
const DISCORD_BOT_TOKEN = (process.env.DISCORD_BOT_TOKEN || '').trim();
const DISCORD_INVITE_CHANNEL_ID = (process.env.DISCORD_INVITE_CHANNEL_ID || '').trim();
const DISCORD_CONTACT_URL = (process.env.DISCORD_CONTACT_URL || '').trim();
const DISCORD_INVITE_REFRESH_HOURS = Math.min(168, Math.max(1, parsePositiveEnvNumber('DISCORD_INVITE_REFRESH_HOURS', 24)));
// Connexion Discord des visiteurs (OAuth2, scope identify uniquement). Permet
// de savoir QUI envoie un fichier: le webhook staff reçoit l'identité du compte.
// DISCORD_API_BASE_URL ne sert qu'à rediriger les appels API (tests, proxy).
const DISCORD_CLIENT_ID = (process.env.DISCORD_CLIENT_ID || '').trim();
const DISCORD_CLIENT_SECRET = (process.env.DISCORD_CLIENT_SECRET || '').trim();
const DISCORD_API_BASE_URL = (process.env.DISCORD_API_BASE_URL || 'https://discord.com/api').replace(/\/$/, '');
// URL d’autorisation affichée au navigateur (peut différer de l’API serveur, ex. démo derrière un proxy).
const DISCORD_AUTHORIZE_URL = process.env.DISCORD_AUTHORIZE_URL || `${DISCORD_API_BASE_URL}/oauth2/authorize`;
const DISCORD_AUTH_ENABLED = Boolean(DISCORD_CLIENT_ID && DISCORD_CLIENT_SECRET);
const DISCORD_SESSION_DAYS = Math.min(90, Math.max(1, Math.floor(parsePositiveEnvNumber('DISCORD_SESSION_DAYS', 30))));
const DISCORD_SESSION_COOKIE = 'dropqr_sid';
const DISCORD_OAUTH_STATE_COOKIE = 'dropqr_oauth_state';
const DEFAULT_TTL_MINUTES = parsePositiveEnvNumber('DEFAULT_TTL_MINUTES', 15);
const MAX_TTL_MINUTES = Math.max(DEFAULT_TTL_MINUTES, parsePositiveEnvNumber('MAX_TTL_MINUTES', 1440)); // 24h par défaut
const MAX_FILE_SIZE_BYTES = parseMaxFileSize(); // null = pas de limite imposée par l'app
const MAX_CHUNK_SIZE_BYTES = 256 * 1024 * 1024;
const MIN_CHUNK_SIZE_BYTES = 256 * 1024;
const MAX_CHUNKS_PER_TRANSFER = 20000;
const RECOMMENDED_CHUNK_SIZE_BYTES = Math.min(
  MAX_CHUNK_SIZE_BYTES,
  Math.max(1024 * 1024, parsePositiveEnvNumber('CHUNK_SIZE_MB', 16) * 1024 * 1024)
);
const UPLOAD_CONCURRENCY = Math.min(8, Math.max(1, Math.floor(parsePositiveEnvNumber('UPLOAD_CONCURRENCY', 5))));

// Keep-alive: le plan gratuit de Render endort le service après ~15 min sans
// trafic entrant. Quand une URL publique est connue (PUBLIC_URL ou
// KEEP_ALIVE_URL), DropQR s'appelle lui-même régulièrement pour rester éveillé.
// - intervalle normal: KEEP_ALIVE_INTERVAL_MINUTES (10 min, marge de 5 min);
// - après un échec: nouvelle tentative rapide (KEEP_ALIVE_RETRY_SECONDS, qui
//   croît jusqu'à l'intervalle normal) pour ne pas laisser 15 min de silence;
// - après plusieurs échecs d'affilée: alerte Discord (rate-limitée 1/heure),
//   car un service déjà endormi ne peut pas se réveiller tout seul: son
//   minuteur meurt avec lui. Le keep-alive prévient la veille, il ne la guérit pas.
// Désactivable avec KEEP_ALIVE=false.
const KEEP_ALIVE_URL = normalizeBaseUrl(process.env.KEEP_ALIVE_URL || PUBLIC_URL);
const KEEP_ALIVE_ENABLED = (process.env.KEEP_ALIVE || 'true').trim().toLowerCase() !== 'false' && Boolean(KEEP_ALIVE_URL);
const KEEP_ALIVE_INTERVAL_MINUTES = Math.min(14, Math.max(1, Math.floor(parsePositiveEnvNumber('KEEP_ALIVE_INTERVAL_MINUTES', 10))));
const KEEP_ALIVE_RETRY_SECONDS = Math.min(600, Math.max(5, Math.floor(parsePositiveEnvNumber('KEEP_ALIVE_RETRY_SECONDS', 60))));
const KEEP_ALIVE_ALERT_AFTER_FAILURES = Math.max(2, Math.floor(parsePositiveEnvNumber('KEEP_ALIVE_ALERT_AFTER_FAILURES', 5)));
const KEEP_ALIVE_ALERT_COOLDOWN_MS = 60 * 60 * 1000;

// Heartbeat Discord: un message de statut au démarrage puis périodiquement,
// avec l'état du keep-alive, de l'uptime et du stockage. DISCORD_HEARTBEAT=false
// pour le couper même si le webhook est configuré.
const DISCORD_HEARTBEAT_ENABLED = DISCORD_NOTIFY && Boolean(DISCORD_WEBHOOK_URL)
  && (process.env.DISCORD_HEARTBEAT || 'true').trim().toLowerCase() !== 'false';
const DISCORD_HEARTBEAT_HOURS = Math.min(168, Math.max(1, Math.floor(parsePositiveEnvNumber('DISCORD_HEARTBEAT_HOURS', 24))));

const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.join(__dirname, 'storage');
const FILES_DIR = path.join(STORAGE_DIR, 'files');
const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
const DB_PATH = path.join(STORAGE_DIR, 'db.json');
const discordDeleteTimers = new Map();
const activeDownloads = new Set();
const MAX_TIMEOUT_MS = 2_147_000_000;

let db = { transfers: {} };
let dbWriteQueue = Promise.resolve();
let currentDiscordContactUrl = DISCORD_CONTACT_URL;

function parsePositiveEnvNumber(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function parseMaxFileSize() {
  const fallback = 10 * 1024 ** 3;
  // Par défaut, DropQR accepte jusqu'à 10 Go par transfert.
  // Les limites réelles peuvent encore venir du disque ou de l'hébergeur.
  if (!process.env.MAX_FILE_SIZE_MB && !process.env.MAX_FILE_SIZE) return fallback;

  const unlimitedValues = new Set(['0', 'none', 'no', 'false', 'unlimited', 'illimite', 'illimité']);
  if (process.env.MAX_FILE_SIZE && unlimitedValues.has(String(process.env.MAX_FILE_SIZE).trim().toLowerCase())) return null;

  if (process.env.MAX_FILE_SIZE_MB) {
    const mb = Number(process.env.MAX_FILE_SIZE_MB);
    if (Number.isFinite(mb) && mb > 0) return Math.floor(mb * 1024 * 1024);
    // Une variable MB invalide ne doit jamais désactiver la limite.
    console.warn('MAX_FILE_SIZE_MB invalide: tentative avec MAX_FILE_SIZE ou valeur par défaut.');
  }

  const raw = String(process.env.MAX_FILE_SIZE || '').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);
  if (!match) return fallback;
  const value = Number(match[1]);
  const unit = match[2] || 'b';
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit];
  const bytes = value * factor;
  return Number.isSafeInteger(Math.floor(bytes)) && bytes > 0 ? Math.floor(bytes) : fallback;
}

function now() {
  return Date.now();
}

function makeId(bytes = 18) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function makeTransferCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const transfers = transferStore();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(6);
    let code = '';
    for (let i = 0; i < 7; i += 1) {
      code += alphabet[bytes[i % bytes.length] % alphabet.length];
    }
    if (!Object.values(transfers).some((item) => item.code === code)) return code;
  }
  return makeId(5).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8).toUpperCase();
}

function normalizeCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 24);
}

function findTransferByCode(code) {
  const normalized = normalizeCode(code);
  if (!normalized) return null;
  return Object.values(transferStore()).find((item) => item.code === normalized) || null;
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeCompareHash(hashA, hashB) {
  if (!hashA || !hashB || hashA.length !== hashB.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hashA), Buffer.from(hashB));
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function cleanOriginalName(name) {
  const base = path.basename(String(name || 'fichier'));
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180) || 'fichier';
}

function normalizeMimeType(value) {
  const raw = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(raw)
    ? raw
    : 'application/octet-stream';
}

function storedFilePath(storedName) {
  const name = String(storedName || '');
  if (!/^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9._-]+)?$/.test(name)) return null;
  const root = path.resolve(FILES_DIR);
  const filePath = path.resolve(root, name);
  return filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let size = value / 1024;
  let unit = units[0];
  for (let i = 0; i < units.length; i += 1) {
    unit = units[i];
    if (size < 1024 || i === units.length - 1) break;
    size /= 1024;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

function isVideoMime(mimeType) {
  return String(mimeType || '').toLowerCase().startsWith('video/');
}

function contentDispositionInline(filename) {
  const safeName = cleanOriginalName(filename).replace(/["\\]/g, '_');
  return `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/$/, '');
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function getBaseUrl(req) {
  const configuredUrl = normalizeBaseUrl(PUBLIC_URL);
  if (configuredUrl) return configuredUrl;
  const forwardedProto = req.get('x-forwarded-proto');
  const proto = forwardedProto ? forwardedProto.split(',')[0].trim() : req.protocol;
  return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function getReceivePath(meta) {
  if (meta.code) return `/receive?code=${encodeURIComponent(meta.code)}`;
  return `/t/${encodeURIComponent(meta.id)}`;
}

function isSandboxPreview(req) {
  const host = String(req.get('host') || '');
  return !PUBLIC_URL && /(^|\.)e2b\.app(?::\d+)?$/i.test(host);
}

function sandboxWarningText(req) {
  return isSandboxPreview(req)
    ? `La preview Arena/e2b nécessite un token côté navigateur. Ce QR code ne marchera pas directement depuis un téléphone externe. Pour tester sur téléphone, déploie le site ou lance-le en local avec PUBLIC_URL=http://IP_DE_TON_PC:${PORT}.`
    : null;
}

function transferStore() {
  if (!db.transfers || typeof db.transfers !== 'object' || Array.isArray(db.transfers)) db.transfers = {};
  return db.transfers;
}

function getTransferById(id) {
  const key = String(id || '');
  const transfers = transferStore();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(key)
    && Object.prototype.hasOwnProperty.call(transfers, key)
    ? transfers[key]
    : null;
}

function parseTtlMinutes(value) {
  const ttlRaw = Number(value || DEFAULT_TTL_MINUTES);
  return Math.min(
    Math.max(1, Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_TTL_MINUTES),
    MAX_TTL_MINUTES
  );
}

function parseDeleteAfterDownload(value) {
  // Multipart envoie des chaînes ('false'), les routes JSON peuvent envoyer des booléens.
  if (value === undefined || value === null || value === '') return true;
  if (typeof value === 'boolean') return value;
  return String(value).trim().toLowerCase() !== 'false';
}

function safeUploadId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(id) ? id : '';
}

function parseCookies(req) {
  const header = String(req.headers.cookie || '');
  const cookies = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(part.slice(eq + 1).trim()); }
    catch (_error) { cookies[key] = part.slice(eq + 1).trim(); }
  }
  return cookies;
}

function isHttpsRequest(req) {
  if (req.secure || req.protocol === 'https') return true;
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  return normalizeBaseUrl(PUBLIC_URL).startsWith('https://');
}

function setCookie(res, req, name, value, { maxAgeSec } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', 'HttpOnly'];
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
  // Secure uniquement en HTTPS, sinon le cookie serait invisible en dev locale HTTP.
  if (isHttpsRequest(req)) parts.push('Secure');
  const previous = res.getHeader('Set-Cookie');
  const headerValue = parts.join('; ');
  res.setHeader('Set-Cookie', previous ? [].concat(previous, headerValue) : headerValue);
}

function discordSessionStore() {
  if (!db.discordSessions || typeof db.discordSessions !== 'object' || Array.isArray(db.discordSessions)) db.discordSessions = {};
  return db.discordSessions;
}

function discordUserStore() {
  if (!db.discordUsers || typeof db.discordUsers !== 'object' || Array.isArray(db.discordUsers)) db.discordUsers = {};
  return db.discordUsers;
}

function discordAvatarUrl(du) {
  if (du.avatar) return `https://cdn.discordapp.com/avatars/${du.id}/${du.avatar}.png?size=128`;
  // Avatar par défaut Discord: (userId >> 22) % 6.
  let index = 0;
  try { index = Number((BigInt(String(du.id)) >> 22n) % 6n); } catch (_error) { index = 0; }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

// Résout l'utilisateur Discord courant depuis le cookie de session (opaque).
function getDiscordSessionUser(req) {
  const sid = parseCookies(req)[DISCORD_SESSION_COOKIE];
  if (!sid || !/^[a-f0-9]{32,64}$/.test(sid)) return null;
  const session = discordSessionStore()[sid];
  if (!session) return null;
  if (Number(session.expiresAt) <= now()) {
    delete discordSessionStore()[sid];
    saveDb().catch(() => {});
    return null;
  }
  const record = discordUserStore()[session.userId];
  if (!record || !record.user) return null;
  return { sid, userId: session.userId, user: record.user };
}

function discordRedirectUri(req) {
  return `${getBaseUrl(req)}/api/auth/discord/callback`;
}

async function buildTransferResponse(req, meta, deleteKey) {
  const baseUrl = getBaseUrl(req);
  const mimeType = normalizeMimeType(meta.mimeType);
  const shareUrl = `${baseUrl}${getReceivePath(meta)}`;
  const downloadUrl = `${baseUrl}/download/${encodeURIComponent(meta.id)}`;
  const previewUrl = `${baseUrl}/view/${encodeURIComponent(meta.id)}`;
  const qrDataUrl = await QRCode.toDataURL(shareUrl, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 420,
    color: { dark: '#020617', light: '#ffffff' }
  });

  return {
    id: meta.id,
    code: meta.code,
    deleteKey,
    fileName: meta.originalName,
    mimeType,
    size: meta.size,
    sizeHuman: formatBytes(meta.size),
    createdAt: new Date(meta.createdAt).toISOString(),
    expiresAt: new Date(meta.expiresAt).toISOString(),
    secondsRemaining: Math.max(0, Math.floor((meta.expiresAt - now()) / 1000)),
    ttlMinutes: meta.ttlMinutes,
    deleteAfterDownload: meta.deleteAfterDownload,
    shareUrl,
    downloadUrl,
    previewUrl,
    canPreview: isVideoMime(mimeType),
    qrDataUrl,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY),
    sandboxWarning: sandboxWarningText(req)
  };
}

function discordWebhookBaseUrl() {
  return String(DISCORD_WEBHOOK_URL || '').split('?')[0].replace(/\/$/, '');
}

// Envoi JSON simple vers le webhook (alertes, heartbeat). Les notifications de
// transfert restent en multipart car elles joignent le QR en pièce jointe.
async function postDiscordJsonMessage(body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(discordWebhookBaseUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: DISCORD_USERNAME, ...body }),
      signal: controller.signal
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { sent: false, status: response.status, error: text.slice(0, 200) };
    }
    return { sent: true, status: response.status };
  } catch (error) {
    return { sent: false, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

async function deleteDiscordMessage(meta, reason = 'cleanup') {
  const messageId = meta && meta.discordMessage && meta.discordMessage.id;
  const baseUrl = discordWebhookBaseUrl();
  if (!messageId || !baseUrl) return { deleted: false, skipped: true };

  const timer = discordDeleteTimers.get(meta.id);
  if (timer) {
    clearTimeout(timer);
    discordDeleteTimers.delete(meta.id);
  }

  const response = await fetch(`${baseUrl}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
  if (response.ok || response.status === 404) {
    console.log(`Message Discord supprimé (${reason}): ${messageId}`);
    return { deleted: true };
  }
  const text = await response.text().catch(() => '');
  console.error(`Suppression Discord impossible (${response.status}):`, text.slice(0, 300));
  return { deleted: false, status: response.status };
}

function scheduleDiscordMessageDeletion(meta) {
  if (!meta || !meta.id || !meta.discordMessage || !meta.discordMessage.id || !meta.discordMessage.deleteAt) return;
  if (!DISCORD_WEBHOOK_URL) return;

  const existing = discordDeleteTimers.get(meta.id);
  if (existing) clearTimeout(existing);

  const delay = Number(meta.discordMessage.deleteAt) - now();
  if (delay <= 0) {
    deleteDiscordMessage(meta, 'minuteur-expire').catch((error) => console.error('Suppression Discord échouée:', error));
    return;
  }
  if (delay > MAX_TIMEOUT_MS) return;

  const timer = setTimeout(() => {
    deleteDiscordMessage(meta, 'minuteur').catch((error) => console.error('Suppression Discord échouée:', error));
  }, delay);
  discordDeleteTimers.set(meta.id, timer);
}

function scheduleAllDiscordMessageDeletions() {
  for (const meta of Object.values(transferStore())) {
    scheduleDiscordMessageDeletion(meta);
  }
}

async function notifyDiscordTransfer(req, meta, payload) {
  if (!DISCORD_NOTIFY || !DISCORD_WEBHOOK_URL) {
    return { sent: false, configured: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const qrBuffer = await QRCode.toBuffer(payload.shareUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 640,
      color: { dark: '#020617', light: '#ffffff' }
    });

    const expiresAt = new Date(meta.expiresAt).toLocaleString('fr-FR', {
      dateStyle: 'short',
      timeStyle: 'short'
    });

    const embed = {
      title: 'Nouveau transfert DropQR',
      description: `Code: **${payload.code}**\nLien: ${payload.shareUrl}`,
      color: meta.discordUser ? 0x5865f2 : 0x67e8f9,
      fields: [
        { name: 'Fichier', value: meta.originalName.slice(0, 1024), inline: false },
        {
          name: 'Envoyé par',
          value: meta.discordUser
            ? `${meta.discordUser.globalName || meta.discordUser.username} (@${meta.discordUser.username} · ID ${meta.discordUser.id})`
            : 'Anonyme (non connecté avec Discord)',
          inline: false
        },
        { name: 'Taille', value: formatBytes(meta.size), inline: true },
        { name: 'Expiration', value: expiresAt, inline: true },
        { name: 'Nettoyage', value: meta.deleteAfterDownload ? 'Après le premier téléchargement' : 'À expiration', inline: true }
      ],
      image: { url: `attachment://dropqr-${payload.code}.png` },
      footer: { text: 'DropQR · fichier temporaire' },
      timestamp: new Date(meta.createdAt).toISOString()
    };
    if (meta.discordUser) {
      embed.author = {
        name: `${meta.discordUser.globalName || meta.discordUser.username} (@${meta.discordUser.username})`,
        icon_url: meta.discordUser.avatar
      };
      embed.thumbnail = { url: meta.discordUser.avatar };
    }

    const content = DISCORD_MENTION ? `${DISCORD_MENTION}\nNouveau fichier prêt.` : 'Nouveau fichier prêt.';
    const form = new FormData();
    form.append('payload_json', JSON.stringify({
      username: DISCORD_USERNAME,
      content,
      embeds: [embed]
    }));
    form.append('files[0]', new Blob([qrBuffer], { type: 'image/png' }), `dropqr-${payload.code}.png`);

    const response = await fetch(`${discordWebhookBaseUrl()}?wait=true`, {
      method: 'POST',
      body: form,
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { sent: false, configured: true, status: response.status, error: text.slice(0, 300) };
    }

    const message = await response.json().catch(() => ({}));
    return {
      sent: true,
      configured: true,
      messageId: message.id || null,
      deleteAt: meta.expiresAt
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function refreshDiscordContactInvite(reason = 'scheduled') {
  if (!DISCORD_BOT_TOKEN || !DISCORD_INVITE_CHANNEL_ID) {
    return { updated: false, configured: false };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const maxAge = Math.max(3600, Math.min(604800, Math.round(DISCORD_INVITE_REFRESH_HOURS * 2 * 60 * 60)));

  try {
    const response = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(DISCORD_INVITE_CHANNEL_ID)}/invites`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        max_age: maxAge,
        max_uses: 0,
        temporary: false,
        unique: true
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`Invitation Discord impossible (${response.status}):`, detail.slice(0, 240));
      return { updated: false, configured: true, status: response.status };
    }

    const invite = await response.json();
    if (!invite.code) {
      console.error('Discord n’a pas renvoyé de code d’invitation.');
      return { updated: false, configured: true, error: 'Code d’invitation absent' };
    }

    currentDiscordContactUrl = `https://discord.gg/${invite.code}`;
    console.log(`Lien Discord de contact actualisé (${reason}).`);
    return { updated: true, configured: true, url: currentDiscordContactUrl };
  } catch (error) {
    console.error('Actualisation du lien Discord impossible:', error.message);
    return { updated: false, configured: true, error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

let keepAliveLastResult = null;
let keepAliveFailureStreak = 0;
let keepAliveLastAlertAt = 0;
let keepAliveAlertArmed = false; // true qu'une alerte a été envoyée et attend une confirmation de rétablissement
let keepAliveStats = { total: 0, ok: 0 };
let keepAliveTimer = null;
let lastHeartbeatResult = null;

async function pingKeepAlive(reason = 'programmé') {
  if (!KEEP_ALIVE_ENABLED) return { ok: false, configured: false };
  const target = `${KEEP_ALIVE_URL}/api/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { 'User-Agent': `DropQR-KeepAlive/${APP_VERSION}` }
    });
    // Le but est de générer du trafic entrant: pas besoin de lire le corps.
    keepAliveLastResult = { at: new Date().toISOString(), ok: response.ok, status: response.status };
    keepAliveStats.total += 1;
    if (response.ok) {
      keepAliveStats.ok += 1;
      if (keepAliveAlertArmed) {
        // Le site répond de nouveau après une alerte: on prévient sur Discord.
        keepAliveAlertArmed = false;
        const previousStreak = keepAliveFailureStreak;
        notifyKeepAliveRecovery(previousStreak)
          .catch((error) => console.error('Notification de rétablissement keep-alive échouée:', error));
      }
      keepAliveFailureStreak = 0;
      console.log(`Keep-alive (${reason}): ${target} -> HTTP ${response.status}`);
    } else {
      keepAliveFailureStreak += 1;
      console.warn(`Keep-alive (${reason}): HTTP ${response.status} sur ${target} (échec n°${keepAliveFailureStreak})`);
    }
    return keepAliveLastResult;
  } catch (error) {
    keepAliveLastResult = { at: new Date().toISOString(), ok: false, error: error.message };
    keepAliveStats.total += 1;
    keepAliveFailureStreak += 1;
    console.error(`Keep-alive (${reason}) impossible (échec n°${keepAliveFailureStreak}):`, error.message);
    return keepAliveLastResult;
  } finally {
    clearTimeout(timeout);
  }
}

// Alerte Discord quand les pings échouent en chaîne: le service risque la veille
// et ne pourra pas se réveiller seul. Une alerte par heure maximum.
async function notifyKeepAliveAlert() {
  if (!DISCORD_NOTIFY || !DISCORD_WEBHOOK_URL) return { sent: false, configured: false };
  if (now() - keepAliveLastAlertAt < KEEP_ALIVE_ALERT_COOLDOWN_MS) return { sent: false, cooldown: true };
  keepAliveLastAlertAt = now();

  const lastError = keepAliveLastResult && (keepAliveLastResult.error || `HTTP ${keepAliveLastResult.status}`);
  const result = await postDiscordJsonMessage({
    content: `⚠️ **Keep-alive DropQR** : ${keepAliveFailureStreak} pings d’affilée en échec sur ${KEEP_ALIVE_URL}/api/health (dernier : ${lastError || 'inconnu'}). Vérifie le déploiement Render — le site risque de passer en veille.`
  });
  if (result.sent) {
    keepAliveAlertArmed = true;
    console.warn('Alerte keep-alive envoyée sur Discord.');
  } else {
    console.error('Alerte keep-alive Discord impossible:', result.error || `HTTP ${result.status}`);
  }
  return result;
}

// Confirmation de rétablissement après une alerte: sinon impossible de savoir
// si le problème est réglé sans aller regarder les logs.
async function notifyKeepAliveRecovery(previousStreak) {
  if (!DISCORD_NOTIFY || !DISCORD_WEBHOOK_URL) return { sent: false, configured: false };
  const result = await postDiscordJsonMessage({
    content: `✅ **Keep-alive DropQR** : le site répond de nouveau après ${previousStreak} échec${previousStreak > 1 ? 's' : ''} (${KEEP_ALIVE_URL}/api/health).`
  });
  if (result.sent) console.log(`Keep-alive rétabli après ${previousStreak} échec(s), notification Discord envoyée.`);
  return result;
}

// Scheduler adaptatif: setTimeout auto-reprogrammé (plutôt qu'un setInterval)
// pour choisir le délai en fonction du dernier résultat et ne jamais empiler
// deux pings si l'un d'eux traîne.
function runKeepAliveLoop(reason = 'programmé') {
  if (!KEEP_ALIVE_ENABLED) return;
  if (keepAliveTimer) {
    clearTimeout(keepAliveTimer);
    keepAliveTimer = null;
  }
  pingKeepAlive(reason)
    .catch(() => {})
    .finally(() => {
      if (!KEEP_ALIVE_ENABLED) return;
      const normalDelayMs = KEEP_ALIVE_INTERVAL_MINUTES * 60 * 1000;
      let delayMs = normalDelayMs;
      if (keepAliveFailureStreak > 0) {
        // Échec: on retente vite, en espaçant progressivement (max = intervalle normal).
        delayMs = Math.min(KEEP_ALIVE_RETRY_SECONDS * 1000 * keepAliveFailureStreak, normalDelayMs);
        if (keepAliveFailureStreak >= KEEP_ALIVE_ALERT_AFTER_FAILURES) {
          notifyKeepAliveAlert().catch((error) => console.error('Alerte keep-alive échouée:', error));
        }
      }
      keepAliveTimer = setTimeout(() => runKeepAliveLoop(), delayMs);
    });
}

function formatDuration(ms) {
  const totalMinutes = Math.floor(Number(ms || 0) / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} j ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

async function getStorageUsageBytes() {
  const entries = await fsp.readdir(FILES_DIR).catch(() => []);
  let total = 0;
  for (const entry of entries) {
    const stat = await fsp.stat(path.join(FILES_DIR, entry)).catch(() => null);
    if (stat && stat.isFile()) total += stat.size;
  }
  return total;
}

function keepAliveStatusLabel() {
  if (!KEEP_ALIVE_ENABLED) return 'Désactivé';
  if (!keepAliveLastResult) return 'En attente du premier ping';
  return keepAliveLastResult.ok
    ? `OK (HTTP ${keepAliveLastResult.status}) · ${keepAliveStats.ok}/${keepAliveStats.total} réussis`
    : `En échec ×${keepAliveFailureStreak}`;
}

// Message de statut périodique: confirme que le site est en ligne et expose
// l'essentiel (uptime, transferts, stockage, santé du keep-alive) sans ouvrir
// les logs Render.
async function sendDiscordHeartbeat(reason = 'programmé') {
  if (!DISCORD_HEARTBEAT_ENABLED) return { sent: false, configured: false };

  const transfers = Object.values(transferStore());
  const activeBytes = transfers.reduce((sum, item) => sum + Number(item.size || 0), 0);
  const storageBytes = await getStorageUsageBytes().catch(() => 0);
  const keepAliveOk = !KEEP_ALIVE_ENABLED || !keepAliveLastResult || keepAliveLastResult.ok;

  const embed = {
    title: reason === 'démarrage' ? 'DropQR en ligne' : 'Statut DropQR',
    description: KEEP_ALIVE_URL
      ? `Site : ${KEEP_ALIVE_URL}\nKeep-alive : ${keepAliveStatusLabel()}`
      : 'DropQR tourne sans URL publique configurée (keep-alive désactivé).',
    color: keepAliveOk && keepAliveFailureStreak === 0 ? 0x83e1cf : 0xff765a,
    fields: [
      { name: 'Version', value: APP_VERSION, inline: true },
      { name: 'Uptime', value: formatDuration(process.uptime() * 1000), inline: true },
      { name: 'Transferts actifs', value: `${transfers.length} · ${formatBytes(activeBytes)}`, inline: true },
      { name: 'Stockage utilisé', value: formatBytes(storageBytes), inline: true },
      { name: 'Limite fichier', value: MAX_FILE_SIZE_BYTES ? formatBytes(MAX_FILE_SIZE_BYTES) : 'aucune', inline: true },
      { name: 'Rotation du lien', value: DISCORD_BOT_TOKEN && DISCORD_INVITE_CHANNEL_ID ? `Active (${DISCORD_INVITE_REFRESH_HOURS} h)` : 'Non configurée', inline: true }
    ],
    footer: { text: `DropQR · heartbeat ${reason}` },
    timestamp: new Date().toISOString()
  };

  const result = await postDiscordJsonMessage({ embeds: [embed] });
  lastHeartbeatResult = { at: new Date().toISOString(), sent: Boolean(result.sent), reason };
  if (result.sent) console.log(`Heartbeat Discord envoyé (${reason}).`);
  else console.warn(`Heartbeat Discord non envoyé (${reason}):`, result.error || `HTTP ${result.status}`);
  return result;
}

function startDiscordHeartbeat() {
  if (!DISCORD_HEARTBEAT_ENABLED) return;
  sendDiscordHeartbeat('démarrage').catch((error) => console.error('Heartbeat Discord échoué:', error));
  setInterval(() => {
    sendDiscordHeartbeat().catch((error) => console.error('Heartbeat Discord échoué:', error));
  }, DISCORD_HEARTBEAT_HOURS * 60 * 60 * 1000);
  console.log(`Heartbeat Discord activé: statut au démarrage puis toutes les ${DISCORD_HEARTBEAT_HOURS} h.`);
}

async function registerStoredFile(req, { originalName, storedName, mimeType, size, ttlMinutes, deleteAfterDownload }) {
  const id = makeId();
  const deleteKey = makeId(24);
  const meta = {
    id,
    code: makeTransferCode(),
    originalName: cleanOriginalName(originalName),
    storedName,
    mimeType: normalizeMimeType(mimeType),
    size: Number(size || 0),
    createdAt: now(),
    expiresAt: now() + ttlMinutes * 60 * 1000,
    ttlMinutes,
    deleteAfterDownload,
    downloads: 0,
    deleteKeyHash: hashSecret(deleteKey)
  };

  // Si l'expéditeur est connecté via Discord, on l'associe au transfert:
  // le staff saura exactement quel compte a envoyé ce fichier.
  const sessionUser = DISCORD_AUTH_ENABLED ? getDiscordSessionUser(req) : null;
  if (sessionUser) {
    meta.discordUser = sessionUser.user;
    const record = discordUserStore()[sessionUser.userId];
    if (record) {
      record.uploads = Number(record.uploads || 0) + 1;
      record.lastSeenAt = now();
    }
  }

  // Le QR est généré AVANT l'enregistrement: si cette étape échoue, rien n'est
  // persisté et le fichier restera orphelin (nettoyé par la tâche de nettoyage)
  // plutôt que d'avoir des métadonnées sans réponse valide.
  const payload = await buildTransferResponse(req, meta, deleteKey);
  transferStore()[id] = meta;
  await saveDb();
  const discordResult = await notifyDiscordTransfer(req, meta, payload).catch((error) => {
    console.error('Notification Discord échouée:', error);
    return { sent: false, error: error.message };
  });

  if (discordResult.sent && discordResult.messageId) {
    meta.discordMessage = {
      id: discordResult.messageId,
      deleteAt: discordResult.deleteAt || meta.expiresAt,
      createdAt: now()
    };
    await saveDb().catch((error) => console.error('Erreur sauvegarde message Discord:', error));
    scheduleDiscordMessageDeletion(meta);
  }

  payload.discord = discordResult;
  return payload;
}

async function cleanupStaleChunks() {
  const maxAgeMs = 2 * 60 * 60 * 1000;
  const entries = await fsp.readdir(CHUNKS_DIR, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const entryPath = path.join(CHUNKS_DIR, entry.name);
    const stat = await fsp.stat(entryPath).catch(() => null);
    if (!stat || now() - stat.mtimeMs <= maxAgeMs) continue;
    // Les fichiers déposés par Multer avant une erreur doivent aussi être nettoyés.
    await fsp.rm(entryPath, { recursive: entry.isDirectory(), force: true }).catch(() => {});
  }
}

async function ensureStorage() {
  await fsp.mkdir(FILES_DIR, { recursive: true });
  await fsp.mkdir(CHUNKS_DIR, { recursive: true });
  try {
    const raw = await fsp.readFile(DB_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Migration de l'ancienne version: db.files -> db.transfers.
    if (parsed && parsed.files && !parsed.transfers) {
      db = { transfers: parsed.files };
      for (const item of Object.values(db.transfers)) {
        if (!item.deleteKeyHash) item.deleteKeyHash = null;
        if (!item.code) item.code = makeTransferCode();
      }
      await saveDb();
    } else {
      db = parsed && typeof parsed === 'object' ? parsed : { transfers: {} };
      if (!db.transfers) db.transfers = {};
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.error('Impossible de lire db.json:', error);
    db = { transfers: {} };
    await saveDb();
  }
}

function saveDb() {
  // Une seule écriture à la fois: plusieurs uploads peuvent terminer en parallèle.
  dbWriteQueue = dbWriteQueue.catch(() => {}).then(async () => {
    await fsp.mkdir(STORAGE_DIR, { recursive: true });
    const tmp = `${DB_PATH}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
    await fsp.rename(tmp, DB_PATH);
  });
  return dbWriteQueue;
}

async function deleteTransfer(id, reason = 'cleanup') {
  const transfers = transferStore();
  const meta = transfers[id];
  if (!meta) return false;
  delete transfers[id];
  await saveDb().catch((error) => console.error('Erreur sauvegarde DB:', error));

  const filePath = storedFilePath(meta.storedName);
  if (filePath) await fsp.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') console.error(`Erreur suppression fichier ${id}:`, error);
  });

  await deleteDiscordMessage(meta, reason).catch((error) => console.error('Erreur suppression message Discord:', error));
  console.log(`Transfert supprimé (${reason}): ${meta.originalName} [${id}]`);
  return true;
}

let cleanupPromise = null;

async function cleanupExpiredTransfers() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = performCleanupExpiredTransfers().finally(() => {
    cleanupPromise = null;
  });
  return cleanupPromise;
}

async function performCleanupExpiredTransfers() {
  const timestamp = now();
  const transfers = transferStore();
  const ids = Object.keys(transfers);
  for (const id of ids) {
    const meta = transfers[id];
    if (!meta || Number(meta.expiresAt) <= timestamp) {
      await deleteTransfer(id, 'expiration');
    }
  }

  // Sessions Discord expirées.
  const sessions = discordSessionStore();
  let sessionsChanged = false;
  for (const sid of Object.keys(sessions)) {
    if (Number(sessions[sid] && sessions[sid].expiresAt) <= timestamp) {
      delete sessions[sid];
      sessionsChanged = true;
    }
  }
  if (sessionsChanged) await saveDb().catch(() => {});

  // Nettoie les fichiers orphelins éventuels.
  const knownNames = new Set(Object.values(transfers).map((item) => item.storedName));
  const entries = await fsp.readdir(FILES_DIR).catch(() => []);
  for (const entry of entries) {
    if (!knownNames.has(entry)) {
      await fsp.unlink(path.join(FILES_DIR, entry)).catch(() => {});
    }
  }

  await cleanupStaleChunks();
}

const multerConfig = {
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fsp.mkdir(FILES_DIR, { recursive: true });
        cb(null, FILES_DIR);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const id = makeId();
      const ext = path.extname(file.originalname || '').slice(0, 24).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `${id}${ext || '.bin'}`);
    }
  }),
  limits: { files: 1, fields: 16, fieldSize: 64 * 1024 }
};

if (MAX_FILE_SIZE_BYTES) {
  multerConfig.limits.fileSize = MAX_FILE_SIZE_BYTES;
}

const upload = multer(multerConfig);

const chunkUpload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await fsp.mkdir(CHUNKS_DIR, { recursive: true });
        cb(null, CHUNKS_DIR);
      } catch (error) {
        cb(error);
      }
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').slice(0, 24).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `${makeId(16)}${ext || '.part'}`);
    }
  }),
  limits: { files: 1, fields: 16, fieldSize: 64 * 1024, fileSize: Math.min(MAX_FILE_SIZE_BYTES || MAX_CHUNK_SIZE_BYTES, MAX_CHUNK_SIZE_BYTES) }
});

function createRateLimiter({ windowMs, max, message, skip }) {
  const buckets = new Map();
  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const timestamp = now();
    let bucket = buckets.get(key);
    if (!bucket || timestamp - bucket.startedAt >= windowMs) {
      bucket = { startedAt: timestamp, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((windowMs - (timestamp - bucket.startedAt)) / 1000)));
      return res.status(429).json({ error: message });
    }
    // Évite de garder indéfiniment les IP inactives en mémoire.
    if (buckets.size > 5000) {
      for (const [entryKey, entry] of buckets) {
        if (timestamp - entry.startedAt >= windowMs) buckets.delete(entryKey);
      }
    }
    return next();
  };
}

// Les routes d'upload par morceaux ont leur propre limiteur, calibré pour les
// gros fichiers: un transfert de 10 Go en morceaux de 4 Mo représente déjà
// 2560 requêtes, ce qui dépasserait la limite générale de 120/minute
// (et le client réessaie quand même en cas de 429, cf. Retry-After).
const CHUNK_ROUTE_API_PATTERN = /^\/transfers\/(chunk(\/init)?|complete)$/;
const CHUNK_ROUTE_TRANSFER_PATTERN = /^\/(chunk(\/init)?|complete)$/;

const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 120,
  message: 'Trop de requêtes. Réessaie dans une minute.',
  skip: (req) => req.method === 'POST' && CHUNK_ROUTE_API_PATTERN.test(req.path)
});
const uploadRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 2000,
  message: 'Trop de tentatives d’upload depuis cette adresse. Réessaie plus tard.',
  skip: (req) => req.method === 'POST' && CHUNK_ROUTE_TRANSFER_PATTERN.test(req.path)
});
const chunkRateLimiter = createRateLimiter({
  windowMs: 10 * 60 * 1000,
  max: Math.max(100, Math.floor(parsePositiveEnvNumber('CHUNK_RATE_LIMIT', 6000))),
  message: 'Trop de morceaux envoyés. Patiente quelques minutes avant de reprendre.'
});

// Pas de cache pendant le développement: ça évite le problème "rien n'a changé" après refresh.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // L'interface n'utilise que des scripts/feuilles same-origin et des QR en data: URL.
  // Les attributs style="..." du HTML imposent 'unsafe-inline' pour les styles.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://cdn.discordapp.com",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; '));
  // Pas de X-Frame-Options/frame-ancestors ici: la preview Arena/e2b affiche le
  // site dans une iframe, un blocage casserait cette preview.
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/api', apiRateLimiter);
app.use('/api/transfers', uploadRateLimiter);
app.use('/assets', (req, res, next) => {
  // Les assets sont versionnés dans le HTML: ils peuvent être gardés en cache
  // sans ralentir les changements de page entre deux écrans.
  res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=604800');
  next();
}, express.static(path.join(PUBLIC_DIR, 'assets'), {
  etag: true,
  lastModified: true,
  maxAge: '1d'
}));

function sendPage(res, fileName) {
  // Les pages sont statiques et leurs assets sont versionnés: le navigateur peut
  // les réutiliser immédiatement lors du passage d'un écran à l'autre.
  res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
  return res.sendFile(path.join(PUBLIC_DIR, fileName));
}

app.get('/', (_req, res) => sendPage(res, 'home.html'));
app.get('/upload', (_req, res) => sendPage(res, 'upload.html'));
app.get('/dashboard', (_req, res) => sendPage(res, 'dashboard.html'));
app.get('/receive', (_req, res) => sendPage(res, 'receive.html'));
app.get('/help', (_req, res) => sendPage(res, 'help.html'));
app.get('/mentions', (_req, res) => sendPage(res, 'mentions.html'));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    app: 'DropQR',
    version: APP_VERSION,
    storage: 'local-disk',
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeHuman: MAX_FILE_SIZE_BYTES ? formatBytes(MAX_FILE_SIZE_BYTES) : 'Aucune limite imposée par l’application',
    defaultTtlMinutes: DEFAULT_TTL_MINUTES,
    maxTtlMinutes: MAX_TTL_MINUTES,
    chunkedUpload: true,
    chunkInit: true,
    minChunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    maxChunkSizeBytes: MAX_CHUNK_SIZE_BYTES,
    maxChunksPerTransfer: MAX_CHUNKS_PER_TRANSFER,
    recommendedChunkSizeBytes: RECOMMENDED_CHUNK_SIZE_BYTES,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY),
    discordAuthConfigured: DISCORD_AUTH_ENABLED,
    keepAlive: {
      enabled: KEEP_ALIVE_ENABLED,
      intervalMinutes: KEEP_ALIVE_INTERVAL_MINUTES,
      retrySeconds: KEEP_ALIVE_RETRY_SECONDS,
      target: KEEP_ALIVE_ENABLED ? `${KEEP_ALIVE_URL}/api/health` : null,
      consecutiveFailures: keepAliveFailureStreak,
      stats: { total: keepAliveStats.total, ok: keepAliveStats.ok },
      last: keepAliveLastResult
    },
    discordHeartbeat: {
      enabled: DISCORD_HEARTBEAT_ENABLED,
      intervalHours: DISCORD_HEARTBEAT_HOURS,
      last: lastHeartbeatResult
    }
  });
});

app.get('/api/config', (req, res) => {
  res.json({
    app: 'DropQR',
    version: APP_VERSION,
    publicUrl: getBaseUrl(req),
    storage: 'local-disk',
    maxFileSizeBytes: MAX_FILE_SIZE_BYTES,
    maxFileSizeHuman: MAX_FILE_SIZE_BYTES ? formatBytes(MAX_FILE_SIZE_BYTES) : 'Aucune limite imposée par l’application',
    defaultTtlMinutes: DEFAULT_TTL_MINUTES,
    maxTtlMinutes: MAX_TTL_MINUTES,
    chunkedUpload: true,
    chunkInit: true,
    minChunkSizeBytes: MIN_CHUNK_SIZE_BYTES,
    maxChunkSizeBytes: MAX_CHUNK_SIZE_BYTES,
    maxChunksPerTransfer: MAX_CHUNKS_PER_TRANSFER,
    recommendedChunkSizeBytes: RECOMMENDED_CHUNK_SIZE_BYTES,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY),
    discordContactUrl: currentDiscordContactUrl || null,
    discordInviteRotationConfigured: Boolean(DISCORD_BOT_TOKEN && DISCORD_INVITE_CHANNEL_ID),
    discordAuthConfigured: DISCORD_AUTH_ENABLED,
    sandboxWarning: sandboxWarningText(req)
  });
});

app.get('/api/stats', async (_req, res) => {
  await cleanupExpiredTransfers();
  const transfers = Object.values(transferStore());
  const activeBytes = transfers.reduce((sum, item) => sum + Number(item.size || 0), 0);
  res.json({
    activeTransfers: transfers.length,
    activeBytes,
    activeBytesHuman: formatBytes(activeBytes)
  });
});

async function createTransfer(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun fichier reçu.' });
    }

    const ttlMinutes = parseTtlMinutes(req.body.ttlMinutes);
    const deleteAfterDownload = parseDeleteAfterDownload(req.body.deleteAfterDownload);

    const payload = await registerStoredFile(req, {
      originalName: req.file.originalname,
      storedName: req.file.filename,
      mimeType: req.file.mimetype,
      size: req.file.size,
      ttlMinutes,
      deleteAfterDownload
    });

    return res.status(201).json(payload);
  } catch (error) {
    if (req.file && req.file.path) {
      await fsp.unlink(req.file.path).catch(() => {});
    }
    return next(error);
  }
}


async function countStoredChunks(chunkDir, totalChunks) {
  let received = 0;
  for (let index = 0; index < totalChunks; index += 1) {
    const exists = await fsp.access(path.join(chunkDir, `${index}.part`)).then(() => true).catch(() => false);
    if (exists) received += 1;
  }
  return received;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function chunkSessionDir(uploadId) {
  return path.join(CHUNKS_DIR, uploadId);
}

async function readChunkSession(uploadId) {
  try {
    const meta = JSON.parse(await fsp.readFile(path.join(chunkSessionDir(uploadId), 'meta.json'), 'utf8'));
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null;
  } catch (_error) {
    return null;
  }
}

function verifyChunkSecret(meta, providedSecret) {
  if (!meta || !providedSecret) return false;
  return safeCompareHash(String(meta.secretHash || ''), hashSecret(String(providedSecret)));
}

function expectedChunkSize(meta, chunkIndex) {
  const chunkSize = Number(meta.chunkSize);
  const totalSize = Number(meta.totalSize);
  const start = chunkSize * chunkIndex;
  return Math.max(1, Math.min(chunkSize, totalSize - start));
}

function isValidChunkSessionMeta(meta) {
  if (!meta) return false;
  const totalSize = Number(meta.totalSize);
  const chunkSize = Number(meta.chunkSize);
  const totalChunks = Number(meta.totalChunks);
  return Number.isSafeInteger(totalSize) && totalSize >= 1
    && (!MAX_FILE_SIZE_BYTES || totalSize <= MAX_FILE_SIZE_BYTES)
    && Number.isSafeInteger(chunkSize) && chunkSize >= MIN_CHUNK_SIZE_BYTES && chunkSize <= MAX_CHUNK_SIZE_BYTES
    && Number.isSafeInteger(totalChunks) && totalChunks >= 1 && totalChunks <= MAX_CHUNKS_PER_TRANSFER
    && totalChunks === Math.ceil(totalSize / chunkSize);
}

async function assembleChunkUpload(req, uploadId, uploadSecret) {
  const chunkDir = chunkSessionDir(uploadId);
  const metaPath = path.join(chunkDir, 'meta.json');
  const lockPath = path.join(chunkDir, '.assembling');
  let lockHandle = null;

  try {
    lockHandle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw httpError(409, 'Assemblage déjà en cours. Réessaie dans quelques secondes.');
    if (error.code === 'ENOENT') throw httpError(404, 'Session d’upload inconnue ou déjà finalisée. Recommence l’envoi.');
    throw error;
  }

  try {
    let meta;
    try {
      meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    } catch (_error) {
      throw httpError(404, 'Session d’upload inconnue ou déjà finalisée. Recommence l’envoi.');
    }

    if (!verifyChunkSecret(meta, uploadSecret)) {
      throw httpError(403, 'Clé d’upload invalide pour cette session.');
    }
    if (!isValidChunkSessionMeta(meta)) {
      // La session côté disque est incohérente: impossible de lui faire confiance, on la supprime.
      await fsp.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
      throw httpError(400, 'Métadonnées d’upload invalides. Recommence l’envoi.');
    }

    const totalChunks = Number(meta.totalChunks);
    const totalSize = Number(meta.totalSize);

    const received = await countStoredChunks(chunkDir, totalChunks);
    if (received !== totalChunks) {
      throw httpError(400, `Upload incomplet: ${received}/${totalChunks} morceaux reçus.`);
    }

    // Chaque morceau doit avoir exactement la taille attendue: la somme vaut
    // alors forcément totalSize et aucun dépassement de limite n'est possible.
    for (let index = 0; index < totalChunks; index += 1) {
      const partPath = path.join(chunkDir, `${index}.part`);
      const partStat = await fsp.stat(partPath).catch(() => null);
      const expected = expectedChunkSize(meta, index);
      if (!partStat || partStat.size !== expected) {
        throw httpError(400, `Morceau ${index} incomplet ou corrompu (${partStat ? formatBytes(partStat.size) : 'absent'} au lieu de ${formatBytes(expected)}). Renvoie ce morceau.`);
      }
    }

    const originalName = cleanOriginalName(meta.originalName);
    const mimeType = normalizeMimeType(meta.mimeType);
    const ttlMinutes = parseTtlMinutes(meta.ttlMinutes);
    const deleteAfterDownload = parseDeleteAfterDownload(meta.deleteAfterDownload);
    const ext = path.extname(originalName || '').slice(0, 24).replace(/[^a-zA-Z0-9.]/g, '');
    const storedName = `${makeId()}${ext || '.bin'}`;
    const finalPath = path.join(FILES_DIR, storedName);
    await fsp.rm(finalPath, { force: true }).catch(() => {});

    for (let index = 0; index < totalChunks; index += 1) {
      const partPath = path.join(chunkDir, `${index}.part`);
      await pipeline(
        fs.createReadStream(partPath),
        fs.createWriteStream(finalPath, { flags: index === 0 ? 'w' : 'a' })
      );
    }

    const stat = await fsp.stat(finalPath);
    if (stat.size !== totalSize) {
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      throw httpError(400, `Upload incomplet: ${formatBytes(stat.size)} reçus sur ${formatBytes(totalSize)}.`);
    }

    let payload;
    try {
      payload = await registerStoredFile(req, {
        originalName,
        storedName,
        mimeType,
        size: stat.size,
        ttlMinutes,
        deleteAfterDownload
      });
    } catch (error) {
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      throw error;
    }

    await fsp.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    return { complete: true, ...payload };
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function initChunkUpload(req, res, next) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const totalSize = Number(body.totalSize);
    const chunkSize = Number(body.chunkSize);
    const originalName = cleanOriginalName(body.fileName);
    const mimeType = normalizeMimeType(body.mimeType);
    const ttlMinutes = parseTtlMinutes(body.ttlMinutes);
    const deleteAfterDownload = parseDeleteAfterDownload(body.deleteAfterDownload);

    if (!Number.isSafeInteger(totalSize) || totalSize < 1) {
      return res.status(400).json({ error: 'Taille totale invalide (un fichier vide ne peut pas être envoyé par morceaux).' });
    }
    if (MAX_FILE_SIZE_BYTES && totalSize > MAX_FILE_SIZE_BYTES) {
      return res.status(413).json({ error: `Fichier trop volumineux. Limite actuelle: ${formatBytes(MAX_FILE_SIZE_BYTES)}.` });
    }
    if (!Number.isSafeInteger(chunkSize) || chunkSize < MIN_CHUNK_SIZE_BYTES || chunkSize > MAX_CHUNK_SIZE_BYTES) {
      return res.status(400).json({ error: `Taille de morceau invalide: attendu entre ${formatBytes(MIN_CHUNK_SIZE_BYTES)} et ${formatBytes(MAX_CHUNK_SIZE_BYTES)}.` });
    }
    const totalChunks = Math.ceil(totalSize / chunkSize);
    if (totalChunks > MAX_CHUNKS_PER_TRANSFER) {
      return res.status(400).json({ error: `Trop de morceaux (${totalChunks} > ${MAX_CHUNKS_PER_TRANSFER}). Augmente la taille des morceaux.` });
    }

    const uploadId = makeId();
    const uploadSecret = makeId(24);
    const chunkDir = chunkSessionDir(uploadId);
    await fsp.mkdir(chunkDir, { recursive: true });
    const meta = {
      uploadId,
      secretHash: hashSecret(uploadSecret),
      originalName,
      mimeType,
      totalSize,
      chunkSize,
      totalChunks,
      ttlMinutes,
      deleteAfterDownload,
      createdAt: now()
    };
    await fsp.writeFile(path.join(chunkDir, 'meta.json'), JSON.stringify(meta, null, 2), { flag: 'wx' });

    return res.status(201).json({
      uploadId,
      uploadSecret,
      chunkSize,
      totalChunks,
      maxChunksPerTransfer: MAX_CHUNKS_PER_TRANSFER
    });
  } catch (error) {
    return next(error);
  }
}

async function uploadChunk(req, res, next) {
  const discardTempFile = async () => {
    if (req.file && req.file.path) await fsp.unlink(req.file.path).catch(() => {});
  };
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun morceau reçu.' });
    }

    const uploadId = safeUploadId(req.body.uploadId);
    const chunkIndex = Number(req.body.chunkIndex);

    if (!uploadId) {
      await discardTempFile();
      return res.status(400).json({ error: 'Identifiant d’upload invalide.' });
    }

    // Seule la session créée par /chunk/init fait foi: un client ne peut plus
    // déclarer lui-même totalSize/totalChunks pour contourner les limites.
    const meta = await readChunkSession(uploadId);
    if (!meta || !isValidChunkSessionMeta(meta)) {
      await discardTempFile();
      return res.status(404).json({ error: 'Session d’upload inconnue ou expirée. Recommence l’envoi.' });
    }
    if (!verifyChunkSecret(meta, req.body.uploadSecret)) {
      await discardTempFile();
      return res.status(403).json({ error: 'Clé d’upload invalide pour cette session.' });
    }

    const totalChunks = Number(meta.totalChunks);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      await discardTempFile();
      return res.status(400).json({ error: 'Index de morceau invalide.' });
    }

    const expectedSize = expectedChunkSize(meta, chunkIndex);
    if (req.file.size !== expectedSize) {
      await discardTempFile();
      return res.status(400).json({ error: `Taille du morceau ${chunkIndex} invalide: ${formatBytes(req.file.size)} reçus au lieu de ${formatBytes(expectedSize)}.` });
    }

    // rename() remplace la cible atomiquement: pas de fenêtre de course, et un
    // même morceau renvoyé deux fois reste idempotent.
    const targetPath = path.join(chunkSessionDir(uploadId), `${chunkIndex}.part`);
    await fsp.rename(req.file.path, targetPath);

    return res.status(202).json({
      complete: false,
      uploadId,
      chunkIndex,
      totalChunks
    });
  } catch (error) {
    await discardTempFile();
    return next(error);
  }
}

async function completeChunkUpload(req, res, next) {
  try {
    const uploadId = safeUploadId(req.body && req.body.uploadId);
    if (!uploadId) return res.status(400).json({ error: 'Identifiant d’upload invalide.' });
    const payload = await assembleChunkUpload(req, uploadId, req.body && req.body.uploadSecret);
    return res.status(201).json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
}

app.post('/api/transfers/chunk/init', chunkRateLimiter, initChunkUpload);
app.post('/api/transfers/chunk', chunkRateLimiter, chunkUpload.single('chunk'), uploadChunk);
app.post('/api/transfers/complete', chunkRateLimiter, completeChunkUpload);
app.post('/api/transfers', upload.single('file'), createTransfer);
app.post('/api/upload', upload.single('file'), createTransfer); // compatibilité ancienne UI

app.get('/api/codes/:code', async (req, res) => {
  const meta = findTransferByCode(req.params.code);
  if (!meta) return res.status(404).json({ error: 'Code introuvable.' });
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(meta.id, 'expiration-code-api');
    return res.status(410).json({ error: 'Transfert expiré.' });
  }
  return res.json(publicTransferPayload(req, meta));
});

app.get('/api/transfers/:id', async (req, res) => {
  const meta = getTransferById(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Transfert introuvable.' });
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(req.params.id, 'expiration-api');
    return res.status(410).json({ error: 'Transfert expiré.' });
  }

  return res.json(publicTransferPayload(req, meta));
});

app.delete('/api/transfers/:id', async (req, res) => {
  const meta = getTransferById(req.params.id);
  if (!meta) return res.status(404).json({ error: 'Transfert introuvable.' });

  const providedKey = req.get('x-delete-key') || req.query.deleteKey || req.body.deleteKey;
  const providedHash = providedKey ? hashSecret(providedKey) : '';
  if (!safeCompareHash(meta.deleteKeyHash, providedHash)) {
    return res.status(403).json({ error: 'Clé de suppression invalide.' });
  }

  await deleteTransfer(req.params.id, 'suppression-manuelle');
  return res.json({ ok: true });
});

// ── Connexion Discord des visiteurs (OAuth2, scope identify) ────────────────

app.get('/api/auth/me', (req, res) => {
  const session = DISCORD_AUTH_ENABLED ? getDiscordSessionUser(req) : null;
  return res.json({
    configured: DISCORD_AUTH_ENABLED,
    user: session ? session.user : null
  });
});

app.get('/api/auth/discord/login', (req, res) => {
  if (!DISCORD_AUTH_ENABLED) {
    return res.status(501).send(renderMessagePage('Connexion Discord indisponible', 'Le propriétaire du site n’a pas encore configuré la connexion Discord.'));
  }
  const nextRaw = typeof req.query.next === 'string' ? req.query.next : '/';
  const nextPath = nextRaw.startsWith('/') && !nextRaw.startsWith('//') ? nextRaw.slice(0, 200) : '/';
  // Le state protège contre la CSRF; il transporte aussi la page de retour.
  const token = crypto.randomBytes(16).toString('hex');
  const payload = `${token}.${Buffer.from(nextPath, 'utf8').toString('base64url')}`;
  setCookie(res, req, DISCORD_OAUTH_STATE_COOKIE, payload, { maxAgeSec: 600 });

  const params = new URLSearchParams({
    client_id: DISCORD_CLIENT_ID,
    redirect_uri: discordRedirectUri(req),
    response_type: 'code',
    scope: 'identify',
    state: token,
    prompt: 'none'
  });
  return res.redirect(`${DISCORD_AUTHORIZE_URL}?${params.toString()}`);
});

app.get('/api/auth/discord/callback', async (req, res, nextRoute) => {
  const fail = (status, title, message) => res.status(status).send(renderMessagePage(title, message));
  try {
    if (!DISCORD_AUTH_ENABLED) {
      return fail(501, 'Connexion Discord indisponible', 'Le propriétaire du site n’a pas encore configuré la connexion Discord.');
    }

    const cookies = parseCookies(req);
    const storedPayload = String(cookies[DISCORD_OAUTH_STATE_COOKIE] || '');
    const dotIndex = storedPayload.indexOf('.');
    const storedToken = dotIndex === -1 ? storedPayload : storedPayload.slice(0, dotIndex);
    let nextPath = '/';
    if (dotIndex !== -1) {
      try {
        const decoded = Buffer.from(storedPayload.slice(dotIndex + 1), 'base64url').toString('utf8');
        if (decoded.startsWith('/') && !decoded.startsWith('//')) nextPath = decoded;
      } catch (_error) { nextPath = '/'; }
    }
    // Le cookie d'état est à usage unique, valide ou non.
    setCookie(res, req, DISCORD_OAUTH_STATE_COOKIE, '', { maxAgeSec: 0 });

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state || !storedToken || storedToken !== state) {
      return fail(400, 'Session de connexion expirée', 'La fenêtre de connexion a expiré ou le lien est invalide. Retourne sur le site et clique de nouveau sur Discord.');
    }

    // Échange du code contre un jeton d'accès (identification uniquement).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let discordUser;
    try {
      const tokenResponse = await fetch(`${DISCORD_API_BASE_URL}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: DISCORD_CLIENT_ID,
          client_secret: DISCORD_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: discordRedirectUri(req)
        }),
        signal: controller.signal
      });
      if (!tokenResponse.ok) {
        const detail = await tokenResponse.text().catch(() => '');
        console.error(`OAuth Discord: échange du code refusé (${tokenResponse.status}):`, detail.slice(0, 300));
        return fail(502, 'Discord a refusé la connexion', 'L’échange du code a échoué. Vérifie l’identifiant/secret Discord et l’URL de redirection, puis réessaie.');
      }
      const tokenPayload = await tokenResponse.json().catch(() => ({}));
      if (!tokenPayload.access_token) {
        return fail(502, 'Réponse Discord incomplète', 'Discord n’a pas renvoyé de jeton d’accès. Réessaie.');
      }

      const userResponse = await fetch(`${DISCORD_API_BASE_URL}/v10/users/@me`, {
        headers: { Authorization: `Bearer ${tokenPayload.access_token}` },
        signal: controller.signal
      });
      if (!userResponse.ok) {
        console.error(`OAuth Discord: /users/@me refusé (${userResponse.status})`);
        return fail(502, 'Impossible de lire ton profil Discord', 'Discord n’a pas renvoyé ton profil. Réessaie dans un instant.');
      }
      discordUser = await userResponse.json().catch(() => null);
    } catch (error) {
      console.error('OAuth Discord: erreur réseau:', error.message);
      return fail(502, 'Discord injoignable', 'Impossible de joindre les serveurs Discord pour terminer la connexion. Réessaie dans un instant.');
    } finally {
      clearTimeout(timeout);
    }

    if (!discordUser || !discordUser.id || discordUser.bot) {
      return fail(400, 'Compte Discord invalide', 'Ce compte Discord ne peut pas être utilisé ici.');
    }

    const user = {
      id: String(discordUser.id),
      username: String(discordUser.username || 'utilisateur').slice(0, 64),
      globalName: String(discordUser.global_name || discordUser.username || 'utilisateur').slice(0, 64),
      avatar: discordAvatarUrl(discordUser)
    };

    // Répertoire des utilisateurs: première apparition => notification au staff.
    const users = discordUserStore();
    const existing = users[user.id];
    const isNewUser = !existing;
    users[user.id] = {
      user,
      firstSeenAt: existing ? existing.firstSeenAt : now(),
      lastSeenAt: now(),
      uploads: existing ? Number(existing.uploads || 0) : 0
    };

    const sid = crypto.randomBytes(24).toString('hex');
    discordSessionStore()[sid] = {
      userId: user.id,
      createdAt: now(),
      expiresAt: now() + DISCORD_SESSION_DAYS * 24 * 60 * 60 * 1000
    };
    setCookie(res, req, DISCORD_SESSION_COOKIE, sid, { maxAgeSec: DISCORD_SESSION_DAYS * 24 * 60 * 60 });
    await saveDb().catch((error) => console.error('Erreur sauvegarde session Discord:', error));

    console.log(`Connexion Discord: ${user.globalName} (@${user.username} · ${user.id})${isNewUser ? ' [nouveau]' : ''}`);
    if (isNewUser) {
      notifyDiscordNewUser(user).catch((error) => console.error('Notification nouveau membre échouée:', error));
    }

    return res.redirect(nextPath);
  } catch (error) {
    return nextRoute(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  const sid = parseCookies(req)[DISCORD_SESSION_COOKIE];
  if (sid && discordSessionStore()[sid]) {
    delete discordSessionStore()[sid];
    saveDb().catch((error) => console.error('Erreur sauvegarde déconnexion:', error));
  }
  setCookie(res, req, DISCORD_SESSION_COOKIE, '', { maxAgeSec: 0 });
  return res.json({ ok: true });
});

// Notification staff quand un nouveau compte se connecte pour la première fois.
async function notifyDiscordNewUser(user) {
  if (!DISCORD_NOTIFY || !DISCORD_WEBHOOK_URL) return { sent: false, configured: false };
  const embed = {
    title: 'Nouvelle connexion Discord',
    description: `**${user.globalName}** (@${user.username})\nID : ${user.id}`,
    color: 0x5865f2,
    thumbnail: { url: user.avatar },
    footer: { text: 'DropQR · utilisateur répertorié' },
    timestamp: new Date().toISOString()
  };
  return postDiscordJsonMessage({ embeds: [embed] });
}

app.get('/c/:code', showSharePageByCode);
app.get('/code/:code', showSharePageByCode);
app.get('/t/:id', showSharePage);
app.get('/share/:id', showSharePage); // compatibilité ancien QR

async function showSharePageByCode(req, res) {
  const meta = findTransferByCode(req.params.code);
  if (!meta) {
    return res.status(404).send(renderMessagePage('Code introuvable', 'Le code est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(meta.id, 'expiration-code-visite');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }
  return res.send(renderSharePage(req, meta));
}

async function showSharePage(req, res) {
  const id = req.params.id;
  const meta = getTransferById(id);
  if (!meta) {
    return res.status(404).send(renderMessagePage('Transfert introuvable', 'Le lien est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(id, 'expiration-visite');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }
  return res.send(renderSharePage(req, meta));
}

app.get('/view/:id', async (req, res) => {
  const id = req.params.id;
  const meta = getTransferById(id);
  if (!meta) {
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le lien est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(id, 'expiration-preview');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }
  const mimeType = normalizeMimeType(meta.mimeType);
  if (!isVideoMime(mimeType)) {
    return res.status(415).send(renderMessagePage('Aperçu indisponible', 'Seules les vidéos peuvent être lues directement dans le navigateur. Utilise le bouton de téléchargement.'));
  }

  const filePath = storedFilePath(meta.storedName);
  if (!filePath || !fs.existsSync(filePath)) {
    await deleteTransfer(id, 'fichier-manquant-preview');
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le fichier stocké est manquant. Le lien a été nettoyé.'));
  }

  const stat = await fsp.stat(filePath);
  const total = stat.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', contentDispositionInline(meta.originalName));

  const range = req.headers.range;
  if (range) {
    const match = String(range).match(/bytes=(\d*)-(\d*)/);
    if (!match) return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    let start;
    let end;
    if (!match[1] && match[2]) {
      const suffixLength = Number(match[2]);
      if (!Number.isFinite(suffixLength) || suffixLength <= 0) return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
      start = Math.max(total - suffixLength, 0);
      end = total - 1;
    } else {
      start = match[1] ? Number(match[1]) : 0;
      end = match[2] ? Number(match[2]) : total - 1;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    }
    end = Math.min(end, total - 1);
    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', chunkSize);
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }

  res.setHeader('Content-Length', total);
  return fs.createReadStream(filePath).pipe(res);
});

app.get('/download/:id', async (req, res) => {
  const id = req.params.id;
  const meta = getTransferById(id);
  if (!meta) {
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le lien est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(id, 'expiration-telechargement');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }

  const filePath = storedFilePath(meta.storedName);
  if (!filePath || !fs.existsSync(filePath)) {
    await deleteTransfer(id, 'fichier-manquant');
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le fichier stocké est manquant. Le lien a été nettoyé.'));
  }

  if (meta.deleteAfterDownload && activeDownloads.has(id)) {
    return res.status(409).send(renderMessagePage('Téléchargement déjà en cours', 'Ce transfert est déjà en train d’être récupéré. Réessaie dans quelques instants.'));
  }

  if (meta.deleteAfterDownload) activeDownloads.add(id);
  meta.downloads = Number(meta.downloads || 0) + 1;
  meta.lastDownloadAt = now();
  await saveDb().catch((error) => console.error('Erreur compteur téléchargement:', error));

  res.setHeader('Cache-Control', 'no-store');
  res.download(filePath, meta.originalName, async (error) => {
    if (meta.deleteAfterDownload) activeDownloads.delete(id);
    if (error) {
      if (!res.headersSent) console.error('Erreur téléchargement:', error);
      return;
    }
    if (meta.deleteAfterDownload) {
      await deleteTransfer(id, 'apres-premier-telechargement');
    }
  });
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Route API introuvable.' });
  return res.status(404).send(renderMessagePage('Page introuvable', 'Cette page n’existe pas ou a été déplacée.'));
});

app.use((error, _req, res, _next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'JSON invalide.' });
  }
  console.error(error);
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      const limit = MAX_FILE_SIZE_BYTES ? formatBytes(MAX_FILE_SIZE_BYTES) : 'limite inconnue';
      return res.status(413).json({ error: `Fichier trop volumineux. Limite actuelle: ${limit}.` });
    }
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: 'Erreur serveur.' });
});

function publicTransferPayload(req, meta) {
  const baseUrl = getBaseUrl(req);
  const mimeType = normalizeMimeType(meta.mimeType);
  return {
    id: meta.id,
    code: meta.code,
    fileName: meta.originalName,
    mimeType,
    size: meta.size,
    sizeHuman: formatBytes(meta.size),
    createdAt: new Date(meta.createdAt).toISOString(),
    expiresAt: new Date(meta.expiresAt).toISOString(),
    secondsRemaining: Math.max(0, Math.floor((meta.expiresAt - now()) / 1000)),
    deleteAfterDownload: meta.deleteAfterDownload,
    downloads: meta.downloads || 0,
    shareUrl: `${baseUrl}${getReceivePath(meta)}`,
    downloadUrl: `${baseUrl}/download/${encodeURIComponent(meta.id)}`,
    previewUrl: `${baseUrl}/view/${encodeURIComponent(meta.id)}`,
    canPreview: isVideoMime(mimeType)
  };
}

// En-tête et pied de page partagés avec les pages statiques (design landing).
function renderSiteHeader() {
  return `  <header class="nv" id="nv">
    <a class="nv-brand" href="/"><span class="mark" aria-hidden="true"></span><span>DropQR</span></a>
    <nav class="nv-links" id="nv-links" aria-label="Primary">
      <a href="/#product">Product</a>
      <a href="/#how">How it works</a>
      <a href="/#faq">FAQ</a>
      <a class="nv-app" href="/help"><span class="ico" aria-hidden="true">?</span>Help</a>
      <a class="nv-app" href="/receive"><span class="ico" aria-hidden="true">↓</span>Receive</a>
    </nav>
    <div class="nv-right">
      <div class="nav-auth" data-discord-auth></div>
      <a class="nv-cta" href="/upload">Start sharing <span class="arrow" aria-hidden="true">→</span></a>
      <button class="nv-burger" type="button" aria-label="Menu" aria-expanded="false" aria-controls="nv-links"><span></span></button>
    </div>
  </header>`;
}

function renderSiteFooter() {
  return `    <footer class="site-footer">
      <span class="foot-brand">DropQR</span>
      <nav aria-label="App">
        <a href="/upload">Upload</a>
        <a href="/receive">Receive</a>
        <a href="/dashboard">Transfers</a>
        <a href="/help">Help</a>
        <a href="/mentions">Legal</a>
        <a class="discord-contact-link" data-discord-contact href="#" hidden>Discord</a>
      </nav>
      <span class="colophon">Free unlimited file sharing — drop, share, done.</span>
    </footer>`;
}

function renderSharePage(req, meta) {
  const payload = publicTransferPayload(req, meta);
  const expiresAt = new Date(meta.expiresAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#08090b">
  <meta name="color-scheme" content="dark">
  <title>Télécharger ${escapeHtml(meta.originalName)} — DropQR</title>
  <link rel="stylesheet" href="/assets/pages.css?v=3">
</head>
<body>
${renderSiteHeader()}
  <div class="shell share-shell">
    <main class="share-page card">
      <div class="page-code">PUBLIC / DOWNLOAD</div>
      <h1>Le fichier est prêt.</h1>
      <p class="lead">Ce passage est temporaire. Récupère le fichier avant son expiration.</p>
      <section class="share-file">
        <div class="name">${escapeHtml(meta.originalName)}</div>
        <div class="share-meta">
          <span>Code : ${escapeHtml(meta.code || meta.id)}</span>
          <span>Taille : ${escapeHtml(formatBytes(meta.size))}</span>
          <span>Expire : ${escapeHtml(expiresAt)}</span>
          <span>${meta.deleteAfterDownload ? 'Suppression après le premier téléchargement.' : 'Suppression automatique à expiration.'}</span>
        </div>
      </section>
      ${payload.canPreview ? `<video class="video-preview" controls playsinline preload="metadata" src="${escapeHtml(payload.previewUrl)}"></video>` : ''}
      <a class="btn primary share-download" href="${escapeHtml(payload.downloadUrl)}">Télécharger le fichier</a>
      
      <p class="share-note">Ne partage ce lien qu’avec les personnes autorisées. Une fois expiré ou téléchargé, le fichier disparaît du serveur.</p>
      <p class="share-legal"><a href="/mentions">Mentions et confidentialité</a></p>
    </main>
${renderSiteFooter()}
  </div>
  <script src="/assets/site.js?v=15" defer></script>
</body>
</html>`;
}

function renderMessagePage(title, message) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#08090b">
  <meta name="color-scheme" content="dark">
  <title>${escapeHtml(title)} — DropQR</title>
  <link rel="stylesheet" href="/assets/pages.css?v=3">
</head>
<body>
${renderSiteHeader()}
  <div class="shell share-shell">
    <main class="share-page card">
      <div class="page-code">SYSTEM / NOTICE</div>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">${escapeHtml(message)}</p>
      <div class="actions"><a class="btn primary" href="/upload">Créer un transfert</a><a class="btn" href="/">Retour à l’accueil</a></div>
      <p class="share-legal"><a href="/mentions">Mentions et confidentialité</a></p>
    </main>
${renderSiteFooter()}
  </div>
  <script src="/assets/site.js?v=15" defer></script>
</body>
</html>`;
}

ensureStorage()
  .then(async () => {
    await cleanupExpiredTransfers();
    scheduleAllDiscordMessageDeletions();
    setInterval(() => cleanupExpiredTransfers().catch((error) => console.error('Erreur nettoyage:', error)), 60 * 1000);
    app.listen(PORT, HOST, () => {
      console.log(`DropQR démarré sur http://${HOST}:${PORT}`);
      console.log(`Stockage: local-disk | Limite fichier app: ${MAX_FILE_SIZE_BYTES ? formatBytes(MAX_FILE_SIZE_BYTES) : 'aucune'} | TTL défaut: ${DEFAULT_TTL_MINUTES} min | TTL max: ${MAX_TTL_MINUTES} min`);
      if (PUBLIC_URL) console.log(`URL publique configurée: ${PUBLIC_URL}`);
      if (KEEP_ALIVE_ENABLED) {
        runKeepAliveLoop('démarrage');
        console.log(`Keep-alive activé: ping de ${KEEP_ALIVE_URL}/api/health toutes les ${KEEP_ALIVE_INTERVAL_MINUTES} min (nouvelle tentative après ${KEEP_ALIVE_RETRY_SECONDS} s en cas d’échec).`);
      }
      startDiscordHeartbeat();
      if (DISCORD_BOT_TOKEN && DISCORD_INVITE_CHANNEL_ID) {
        refreshDiscordContactInvite('démarrage');
        setInterval(() => refreshDiscordContactInvite('rotation quotidienne'), DISCORD_INVITE_REFRESH_HOURS * 60 * 60 * 1000);
        console.log(`Rotation du lien Discord activée: toutes les ${DISCORD_INVITE_REFRESH_HOURS} heures.`);
      }
    });
  })
  .catch((error) => {
    console.error('Impossible de démarrer:', error);
    process.exit(1);
  });
