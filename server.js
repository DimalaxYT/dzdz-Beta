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
app.set('trust proxy', true);

const APP_VERSION = '1.7.0';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || '').trim();
const DISCORD_USERNAME = process.env.DISCORD_USERNAME || 'DropQR';
const DISCORD_MENTION = (process.env.DISCORD_MENTION || '').trim();
const DISCORD_NOTIFY = process.env.DISCORD_NOTIFY !== 'false';
const DEFAULT_TTL_MINUTES = Number(process.env.DEFAULT_TTL_MINUTES || 15);
const MAX_TTL_MINUTES = Number(process.env.MAX_TTL_MINUTES || 1440); // 24h par défaut
const MAX_FILE_SIZE_BYTES = parseMaxFileSize(); // null = pas de limite imposée par l'app
const RECOMMENDED_CHUNK_SIZE_BYTES = Math.max(1024 * 1024, Number(process.env.CHUNK_SIZE_MB || 16) * 1024 * 1024);
const UPLOAD_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.UPLOAD_CONCURRENCY || 5)));

const PUBLIC_DIR = path.join(__dirname, 'public');
const STORAGE_DIR = path.join(__dirname, 'storage');
const FILES_DIR = path.join(STORAGE_DIR, 'files');
const CHUNKS_DIR = path.join(STORAGE_DIR, 'chunks');
const DB_PATH = path.join(STORAGE_DIR, 'db.json');
const discordDeleteTimers = new Map();
const MAX_TIMEOUT_MS = 2_147_000_000;

let db = { transfers: {} };

function parseMaxFileSize() {
  // Par défaut, DropQR accepte jusqu'à 10 Go par transfert.
  // Les limites réelles peuvent encore venir du disque ou de l'hébergeur.
  if (!process.env.MAX_FILE_SIZE_MB && !process.env.MAX_FILE_SIZE) return 10 * 1024 ** 3;

  const unlimitedValues = new Set(['0', 'none', 'no', 'false', 'unlimited', 'illimite', 'illimité']);
  if (process.env.MAX_FILE_SIZE && unlimitedValues.has(String(process.env.MAX_FILE_SIZE).trim().toLowerCase())) return null;

  if (process.env.MAX_FILE_SIZE_MB) {
    const mb = Number(process.env.MAX_FILE_SIZE_MB);
    return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : null;
  }

  const raw = String(process.env.MAX_FILE_SIZE || '').trim().toLowerCase();
  const match = raw.match(/^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/);
  if (!match) return 10 * 1024 ** 3;
  const value = Number(match[1]);
  const unit = match[2] || 'b';
  const factor = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit];
  return Math.floor(value * factor);
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

function transferStore() {
  if (!db.transfers) db.transfers = {};
  return db.transfers;
}

function parseTtlMinutes(value) {
  const ttlRaw = Number(value || DEFAULT_TTL_MINUTES);
  return Math.min(
    Math.max(1, Number.isFinite(ttlRaw) ? ttlRaw : DEFAULT_TTL_MINUTES),
    MAX_TTL_MINUTES
  );
}

function parseDeleteAfterDownload(value) {
  return value !== 'false';
}

function safeUploadId(value) {
  const id = String(value || '').trim();
  return /^[a-zA-Z0-9_-]{8,160}$/.test(id) ? id : '';
}

async function buildTransferResponse(req, meta, deleteKey) {
  const baseUrl = getBaseUrl(req);
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
    mimeType: meta.mimeType,
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
    canPreview: isVideoMime(meta.mimeType),
    qrDataUrl,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY),
    sandboxPreview: isSandboxPreview(req),
    sandboxWarning: isSandboxPreview(req)
      ? 'La preview Arena/e2b nécessite un token côté navigateur. Ce QR code ne marchera pas directement depuis un téléphone externe. Pour tester sur téléphone, déploie le site ou lance-le en local avec PUBLIC_URL=http://IP_DE_TON_PC:3000.'
      : null
  };
}

function discordWebhookBaseUrl() {
  return String(DISCORD_WEBHOOK_URL || '').split('?')[0].replace(/\/$/, '');
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
      color: 0x67e8f9,
      fields: [
        { name: 'Fichier', value: meta.originalName.slice(0, 1024), inline: false },
        { name: 'Taille', value: formatBytes(meta.size), inline: true },
        { name: 'Expiration', value: expiresAt, inline: true },
        { name: 'Nettoyage', value: meta.deleteAfterDownload ? 'Après le premier téléchargement' : 'À expiration', inline: true }
      ],
      image: { url: `attachment://dropqr-${payload.code}.png` },
      footer: { text: 'DropQR · fichier temporaire' },
      timestamp: new Date(meta.createdAt).toISOString()
    };

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

async function registerStoredFile(req, { originalName, storedName, mimeType, size, ttlMinutes, deleteAfterDownload }) {
  const id = makeId();
  const deleteKey = makeId(24);
  const meta = {
    id,
    code: makeTransferCode(),
    originalName: cleanOriginalName(originalName),
    storedName,
    mimeType: mimeType || 'application/octet-stream',
    size: Number(size || 0),
    createdAt: now(),
    expiresAt: now() + ttlMinutes * 60 * 1000,
    ttlMinutes,
    deleteAfterDownload,
    downloads: 0,
    deleteKeyHash: hashSecret(deleteKey)
  };

  transferStore()[id] = meta;
  await saveDb();
  const payload = await buildTransferResponse(req, meta, deleteKey);
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
    if (!entry.isDirectory()) continue;
    const dirPath = path.join(CHUNKS_DIR, entry.name);
    const stat = await fsp.stat(dirPath).catch(() => null);
    if (!stat || now() - stat.mtimeMs > maxAgeMs) {
      await fsp.rm(dirPath, { recursive: true, force: true }).catch(() => {});
    }
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

async function saveDb() {
  await fsp.mkdir(STORAGE_DIR, { recursive: true });
  const tmp = `${DB_PATH}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(db, null, 2));
  await fsp.rename(tmp, DB_PATH);
}

async function deleteTransfer(id, reason = 'cleanup') {
  const transfers = transferStore();
  const meta = transfers[id];
  if (!meta) return false;
  delete transfers[id];
  await saveDb().catch((error) => console.error('Erreur sauvegarde DB:', error));

  const filePath = path.join(FILES_DIR, meta.storedName || '');
  await fsp.unlink(filePath).catch((error) => {
    if (error.code !== 'ENOENT') console.error(`Erreur suppression fichier ${id}:`, error);
  });

  await deleteDiscordMessage(meta, reason).catch((error) => console.error('Erreur suppression message Discord:', error));
  console.log(`Transfert supprimé (${reason}): ${meta.originalName} [${id}]`);
  return true;
}

async function cleanupExpiredTransfers() {
  const timestamp = now();
  const transfers = transferStore();
  const ids = Object.keys(transfers);
  for (const id of ids) {
    const meta = transfers[id];
    if (!meta || Number(meta.expiresAt) <= timestamp) {
      await deleteTransfer(id, 'expiration');
    }
  }

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
  limits: { files: 1 }
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
  limits: { files: 1 }
});

// Pas de cache pendant le développement: ça évite le problème "rien n'a changé" après refresh.
app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets'), {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

function sendPage(res, fileName) {
  return res.sendFile(path.join(PUBLIC_DIR, fileName));
}

app.get('/', (_req, res) => sendPage(res, 'home.html'));
app.get('/upload', (_req, res) => sendPage(res, 'upload.html'));
app.get('/dashboard', (_req, res) => sendPage(res, 'dashboard.html'));
app.get('/receive', (_req, res) => sendPage(res, 'receive.html'));
app.get('/help', (_req, res) => sendPage(res, 'help.html'));

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
    recommendedChunkSizeBytes: RECOMMENDED_CHUNK_SIZE_BYTES,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY)
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
    recommendedChunkSizeBytes: RECOMMENDED_CHUNK_SIZE_BYTES,
    uploadConcurrency: UPLOAD_CONCURRENCY,
    discordConfigured: Boolean(DISCORD_WEBHOOK_URL && DISCORD_NOTIFY),
    sandboxPreview: isSandboxPreview(req),
    sandboxWarning: isSandboxPreview(req)
      ? 'La preview Arena/e2b ajoute une protection par token. Un QR scanné depuis un téléphone hors preview ne peut pas accéder à cette URL. Déploie le site ou lance-le sur ton réseau local avec PUBLIC_URL.'
      : null
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

async function assembleChunkUpload(req, uploadId) {
  const chunkDir = path.join(CHUNKS_DIR, uploadId);
  const metaPath = path.join(chunkDir, 'meta.json');
  const lockPath = path.join(chunkDir, '.assembling');
  let lockHandle = null;

  try {
    lockHandle = await fsp.open(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      const lockedError = new Error('Assemblage déjà en cours. Réessaie dans quelques secondes.');
      lockedError.status = 409;
      throw lockedError;
    }
    throw error;
  }

  try {
    const meta = JSON.parse(await fsp.readFile(metaPath, 'utf8'));
    const totalChunks = Number(meta.totalChunks);
    const totalSize = Number(meta.totalSize);
    if (!Number.isInteger(totalChunks) || totalChunks < 1) {
      const error = new Error('Métadonnées d’upload invalides.');
      error.status = 400;
      throw error;
    }

    const received = await countStoredChunks(chunkDir, totalChunks);
    if (received !== totalChunks) {
      const error = new Error(`Upload incomplet: ${received}/${totalChunks} morceaux reçus.`);
      error.status = 400;
      throw error;
    }

    const originalName = cleanOriginalName(meta.originalName);
    const mimeType = meta.mimeType || 'application/octet-stream';
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
    if (Number.isFinite(totalSize) && totalSize > 0 && stat.size !== totalSize) {
      await fsp.rm(finalPath, { force: true }).catch(() => {});
      const error = new Error(`Upload incomplet: ${formatBytes(stat.size)} reçus sur ${formatBytes(totalSize)}.`);
      error.status = 400;
      throw error;
    }

    const payload = await registerStoredFile(req, {
      originalName,
      storedName,
      mimeType,
      size: stat.size,
      ttlMinutes,
      deleteAfterDownload
    });

    await fsp.rm(chunkDir, { recursive: true, force: true }).catch(() => {});
    return { complete: true, ...payload };
  } finally {
    if (lockHandle) await lockHandle.close().catch(() => {});
    await fsp.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function uploadChunk(req, res, next) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Aucun morceau reçu.' });
    }

    const uploadId = safeUploadId(req.body.uploadId);
    const chunkIndex = Number(req.body.chunkIndex);
    const totalChunks = Number(req.body.totalChunks);
    const totalSize = Number(req.body.totalSize);
    const originalName = cleanOriginalName(req.body.fileName);
    const mimeType = req.body.mimeType || req.file.mimetype || 'application/octet-stream';
    const ttlMinutes = parseTtlMinutes(req.body.ttlMinutes);
    const deleteAfterDownload = parseDeleteAfterDownload(req.body.deleteAfterDownload);

    if (!uploadId) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Identifiant d’upload invalide.' });
    }
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(totalChunks) || chunkIndex < 0 || totalChunks < 1 || chunkIndex >= totalChunks || totalChunks > 20000) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Index de morceau invalide.' });
    }
    if (!Number.isFinite(totalSize) || totalSize < 0) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).json({ error: 'Taille totale invalide.' });
    }
    if (MAX_FILE_SIZE_BYTES && totalSize > MAX_FILE_SIZE_BYTES) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(413).json({ error: `Fichier trop volumineux. Limite actuelle: ${formatBytes(MAX_FILE_SIZE_BYTES)}.` });
    }

    const chunkDir = path.join(CHUNKS_DIR, uploadId);
    await fsp.mkdir(chunkDir, { recursive: true });
    await fsp.writeFile(path.join(chunkDir, 'meta.json'), JSON.stringify({
      uploadId,
      originalName,
      mimeType,
      totalSize,
      totalChunks,
      ttlMinutes,
      deleteAfterDownload,
      updatedAt: now()
    }, null, 2));

    const targetPath = path.join(chunkDir, `${chunkIndex}.part`);
    await fsp.rm(targetPath, { force: true }).catch(() => {});
    await fsp.rename(req.file.path, targetPath);

    const autoFinalize = req.body.autoFinalize !== 'false';
    if (!autoFinalize) {
      return res.status(202).json({
        complete: false,
        uploadId,
        received: null,
        totalChunks
      });
    }

    const received = await countStoredChunks(chunkDir, totalChunks);
    if (received !== totalChunks) {
      return res.status(202).json({
        complete: false,
        uploadId,
        received,
        totalChunks
      });
    }

    const payload = await assembleChunkUpload(req, uploadId);
    return res.status(201).json(payload);
  } catch (error) {
    if (req.file && req.file.path) {
      await fsp.unlink(req.file.path).catch(() => {});
    }
    return next(error);
  }
}

async function completeChunkUpload(req, res, next) {
  try {
    const uploadId = safeUploadId(req.body.uploadId);
    if (!uploadId) return res.status(400).json({ error: 'Identifiant d’upload invalide.' });
    const payload = await assembleChunkUpload(req, uploadId);
    return res.status(201).json(payload);
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
}

app.post('/api/transfers/chunk', chunkUpload.single('chunk'), uploadChunk);
app.post('/api/transfers/complete', completeChunkUpload);
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
  const meta = transferStore()[req.params.id];
  if (!meta) return res.status(404).json({ error: 'Transfert introuvable.' });
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(req.params.id, 'expiration-api');
    return res.status(410).json({ error: 'Transfert expiré.' });
  }

  return res.json(publicTransferPayload(req, meta));
});

app.delete('/api/transfers/:id', async (req, res) => {
  const meta = transferStore()[req.params.id];
  if (!meta) return res.status(404).json({ error: 'Transfert introuvable.' });

  const providedKey = req.get('x-delete-key') || req.query.deleteKey || req.body.deleteKey;
  const providedHash = providedKey ? hashSecret(providedKey) : '';
  if (!safeCompareHash(meta.deleteKeyHash, providedHash)) {
    return res.status(403).json({ error: 'Clé de suppression invalide.' });
  }

  await deleteTransfer(req.params.id, 'suppression-manuelle');
  return res.json({ ok: true });
});

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
  const meta = transferStore()[id];
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
  const meta = transferStore()[id];
  if (!meta) {
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le lien est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(id, 'expiration-preview');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }

  const filePath = path.join(FILES_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    await deleteTransfer(id, 'fichier-manquant-preview');
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le fichier stocké est manquant. Le lien a été nettoyé.'));
  }

  const stat = await fsp.stat(filePath);
  const total = stat.size;
  const mimeType = meta.mimeType || 'application/octet-stream';
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', contentDispositionInline(meta.originalName));

  const range = req.headers.range;
  if (range) {
    const match = String(range).match(/bytes=(\d*)-(\d*)/);
    if (!match) return res.status(416).setHeader('Content-Range', `bytes */${total}`).end();
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
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
  const meta = transferStore()[id];
  if (!meta) {
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le lien est incorrect, expiré ou le fichier a déjà été supprimé.'));
  }
  if (Number(meta.expiresAt) <= now()) {
    await deleteTransfer(id, 'expiration-telechargement');
    return res.status(410).send(renderMessagePage('Lien expiré', 'Ce fichier a été supprimé automatiquement car sa durée de vie est dépassée.'));
  }

  const filePath = path.join(FILES_DIR, meta.storedName);
  if (!fs.existsSync(filePath)) {
    await deleteTransfer(id, 'fichier-manquant');
    return res.status(404).send(renderMessagePage('Fichier introuvable', 'Le fichier stocké est manquant. Le lien a été nettoyé.'));
  }

  meta.downloads = Number(meta.downloads || 0) + 1;
  meta.lastDownloadAt = now();
  await saveDb().catch((error) => console.error('Erreur compteur téléchargement:', error));

  res.setHeader('Cache-Control', 'no-store');
  res.download(filePath, meta.originalName, async (error) => {
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
  return {
    id: meta.id,
    code: meta.code,
    fileName: meta.originalName,
    mimeType: meta.mimeType,
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
    canPreview: isVideoMime(meta.mimeType)
  };
}

function renderSharePage(req, meta) {
  const payload = publicTransferPayload(req, meta);
  const expiresAt = new Date(meta.expiresAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Télécharger ${escapeHtml(meta.originalName)} · DropQR</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at 12% 8%, rgba(103,232,249,.24), transparent 30%), radial-gradient(circle at 86% 0%, rgba(167,139,250,.25), transparent 28%), #050816; color: #f8fafc; padding: 22px; }
    main { width: min(680px, 100%); background: rgba(15, 23, 42, .86); border: 1px solid rgba(148, 163, 184, .22); border-radius: 34px; padding: clamp(22px, 5vw, 34px); box-shadow: 0 24px 80px rgba(0, 0, 0, .38); }
    .brand { display: inline-flex; align-items: center; gap: 10px; color: #cffafe; font-weight: 950; }
    .brand span:first-child { width: 38px; height: 38px; border-radius: 13px; display: grid; place-items: center; overflow: hidden; }
    .brand img { width: 38px; height: 38px; display: block; }
    h1 { margin: 20px 0 10px; font-size: clamp(34px, 8vw, 58px); line-height: .92; letter-spacing: -.07em; }
    .lead { margin: 0 0 22px; color: #cbd5e1; line-height: 1.58; }
    .file { margin: 20px 0; padding: 18px; background: rgba(255,255,255,.055); border: 1px solid rgba(255,255,255,.09); border-radius: 22px; word-break: break-word; }
    .name { font-size: 22px; font-weight: 950; letter-spacing: -.035em; }
    .meta { color: #cbd5e1; margin-top: 10px; display: grid; gap: 6px; }
    a.button { display: inline-flex; justify-content: center; align-items: center; width: 100%; box-sizing: border-box; text-decoration: none; color: #06111f; background: linear-gradient(135deg, #67e8f9, #93c5fd 52%, #a78bfa); font-weight: 950; border-radius: 18px; padding: 17px 18px; margin-top: 8px; }
    .small { color: #94a3b8; font-size: 14px; line-height: 1.55; margin-top: 18px; }
    .warning { margin-top: 16px; color: #fde68a; background: rgba(251,191,36,.08); border: 1px solid rgba(251,191,36,.2); border-radius: 18px; padding: 14px; line-height: 1.5; }
    .video { width: 100%; margin: 8px 0 14px; border-radius: 18px; background: #020617; border: 1px solid rgba(148,163,184,.22); display: block; max-height: 70vh; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><span><img src="/assets/logo.svg?v=5" alt=""></span><strong>DropQR</strong></div>
    <h1>Fichier prêt à télécharger</h1>
    <p class="lead">Ce lien est temporaire. Télécharge le fichier avant son expiration.</p>
    <section class="file">
      <div class="name">${escapeHtml(meta.originalName)}</div>
      <div class="meta">
        <span>Code: ${escapeHtml(meta.code || meta.id)}</span>
        <span>Taille: ${escapeHtml(formatBytes(meta.size))}</span>
        <span>Expire: ${escapeHtml(expiresAt)}</span>
        <span>${meta.deleteAfterDownload ? 'Suppression automatique après le premier téléchargement.' : 'Suppression automatique à expiration.'}</span>
      </div>
    </section>
    ${isVideoMime(meta.mimeType) ? `<video class="video" controls playsinline preload="metadata" src="${escapeHtml(payload.previewUrl)}"></video>` : ''}
    <a class="button" href="${escapeHtml(payload.downloadUrl)}">Télécharger le fichier</a>
    ${isSandboxPreview(req) ? '<div class="warning">Tu es sur une preview Arena/e2b. Si cette page a été ouverte depuis un téléphone via QR code, elle peut être bloquée par le token de sécurité de la plateforme. Sur un vrai déploiement ou en local avec PUBLIC_URL, le QR fonctionnera normalement.</div>' : ''}
    <p class="small">Ne partage ce lien qu’avec les appareils/personnes autorisés. Une fois expiré ou téléchargé, le fichier disparaît du serveur.</p>
  </main>
</body>
</html>`;
}

function renderMessagePage(title, message) {
  return `<!doctype html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} · DropQR</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #050816; color: #f8fafc; font-family: system-ui, -apple-system, Segoe UI, sans-serif; padding: 24px; }
    main { max-width: 590px; background: #0f172a; border: 1px solid rgba(148,163,184,.22); border-radius: 26px; padding: 30px; text-align: center; box-shadow: 0 24px 80px rgba(0,0,0,.32); }
    h1 { margin-top: 0; letter-spacing: -.04em; }
    p { color: #cbd5e1; line-height: 1.55; }
    a { color: #7dd3fc; font-weight: 800; }
  </style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><a href="/upload">Créer un nouveau transfert</a></p></main></body>
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
    });
  })
  .catch((error) => {
    console.error('Impossible de démarrer:', error);
    process.exit(1);
  });
