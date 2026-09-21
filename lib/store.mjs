'use strict';

/**
 * Couche de stockage, en deux parties indépendantes :
 *
 *  - les **métadonnées** (identifiant, code, expiration, compteur) : petites et
 *    nombreuses. Elles vivent dans Netlify Blobs en production, ou dans des
 *    fichiers JSON sur disque (serveur Node, développement) ;
 *  - les **objets** (les fichiers envoyés) : ils vivent sur le disque local, ou
 *    dans un stockage objet distant — auquel cas ils ne passent jamais par ici,
 *    ils sont gérés directement par URL pré-signées (voir lib/s3.mjs).
 *
 * Les deux choix sont indépendants : on peut très bien garder les fichiers sur
 * le disque tout en rangeant les métadonnées dans Netlify Blobs.
 *
 * Le disque local utilise des écritures atomiques (fichier temporaire unique
 * puis `rename`) et une file d'attente interne : deux transferts simultanés ne
 * peuvent plus se détruire mutuellement.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createQueue, makeId, now, sleep } from './util.mjs';

const STORE_NAME = 'dropqr';

/* ------------------- objets distants (S3, R2 : hors périmètre) ------------- */

/**
 * Quand les fichiers sont dans un stockage objet distant, ils ne sont jamais
 * lus ni écrits par le serveur : ce backend distant se contente donc de
 * répondre « rien ici », sans jamais faire échouer un appel.
 */
function createRemoteObjects() {
  return {
    objectKind: 'remote',
    async init() {},
    objectPath() {
      return null;
    },
    async deleteObject() {
      return false;
    },
    async statObject() {
      return { exists: false };
    }
  };
}

/* -------------------------------- disque local ---------------------------- */

function createLocalParts({ rootDir }) {
  const metaDir = path.join(rootDir, 'meta');
  const codesPath = path.join(rootDir, 'codes.json');
  const lockDir = path.join(rootDir, 'locks');
  const objectsDir = path.join(rootDir, 'objects');
  const enqueue = createQueue();
  let codes = null;
  let counter = 0;

  async function ensure() {
    await Promise.all([
      fsp.mkdir(metaDir, { recursive: true }),
      fsp.mkdir(lockDir, { recursive: true }),
      fsp.mkdir(objectsDir, { recursive: true })
    ]);
  }

  async function readCodes() {
    if (codes) return codes;
    try {
      codes = JSON.parse(await fsp.readFile(codesPath, 'utf8'));
    } catch {
      codes = {};
    }
    return codes;
  }

  async function writeAtomic(filePath, data) {
    counter += 1;
    const tmp = `${filePath}.${process.pid}.${counter}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, filePath);
  }

  function objectPath(key) {
    const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(objectsDir, safe);
  }

  const meta = {
    metadataKind: 'local',
    async init() {
      await ensure();
      await readCodes();
    },
    async readMeta(id) {
      try {
        return JSON.parse(await fsp.readFile(path.join(metaDir, `${id}.json`), 'utf8'));
      } catch {
        return null;
      }
    },
    async writeMeta(entry) {
      await ensure();
      await writeAtomic(path.join(metaDir, `${entry.id}.json`), JSON.stringify(entry));
      return entry;
    },
    async deleteMeta(id) {
      await fsp.rm(path.join(metaDir, `${id}.json`), { force: true }).catch(() => {});
    },
    async listMetaIds() {
      await ensure();
      const entries = await fsp.readdir(metaDir).catch(() => []);
      return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5));
    },
    async reserveCode(code, id) {
      return enqueue(async () => {
        const index = await readCodes();
        if (index[code]) return false;
        index[code] = id;
        await ensure();
        await writeAtomic(codesPath, JSON.stringify(index));
        return true;
      });
    },
    async releaseCode(code) {
      await enqueue(async () => {
        const index = await readCodes();
        if (code in index) {
          delete index[code];
          await writeAtomic(codesPath, JSON.stringify(index));
        }
      });
    },
    async readCode(code) {
      const index = await readCodes();
      return index[code] || null;
    },
    async tryLock(name, ttlMs) {
      const file = path.join(lockDir, `${name}.lock`);
      const token = makeId(6);
      const deadline = now() + ttlMs;
      await ensure();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const handle = await fsp.open(file, 'wx');
          await handle.writeFile(JSON.stringify({ token, deadline }));
          await handle.close();
          return { token, file };
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const current = await fsp.readFile(file, 'utf8').then(JSON.parse).catch(() => null);
          if (current && Number(current.deadline) > now()) return null;
          await fsp.rm(file, { force: true }).catch(() => {});
        }
      }
      return null;
    },
    async releaseLock(lock) {
      if (!lock) return;
      await fsp.rm(lock.file, { force: true }).catch(() => {});
    }
  };

  const objects = {
    objectKind: 'local',
    rootDir,
    objectsDir,
    async init() {
      await ensure();
    },
    objectPath,
    async deleteObject(key) {
      await fsp.rm(objectPath(key), { force: true }).catch(() => {});
    },
    async statObject(key) {
      const stat = await fsp.stat(objectPath(key)).catch(() => null);
      return stat ? { exists: true, size: stat.size } : { exists: false };
    }
  };

  return { meta, objects };
}

/* -------------------- objets rangés dans Netlify Blobs -------------------- */

/**
 * Solution de repli quand aucun stockage objet n'est configuré : les fichiers
 * sont rangés dans Netlify Blobs. Aucune configuration n'est nécessaire, mais
 * comme ils passent par la fonction, ils sont limités à quelques mégaoctets.
 */
function createBlobsObjects(store) {
  const objectKey = (key) => `obj/${key}`;

  return {
    objectKind: 'blobs',
    async init() {},
    objectPath() {
      return null;
    },
    async putObject(key, bytes) {
      const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
      await store.set(objectKey(key), buffer, { metadata: { size: String(buffer.length) } });
      return { size: buffer.length };
    },
    async readObject(key) {
      const value = await store.get(objectKey(key), { type: 'arrayBuffer' }).catch(() => null);
      return value ? Buffer.from(value) : null;
    },
    async deleteObject(key) {
      await store.delete(objectKey(key)).catch(() => {});
    },
    async statObject(key) {
      const info = await store.getMetadata(objectKey(key)).catch(() => null);
      if (!info) return { exists: false };
      return { exists: true, size: Number(info.metadata?.size) || 0 };
    }
  };
}

/* ------------------------------- Netlify Blobs ---------------------------- */

const META_PREFIX = 'meta/';

function createBlobsMeta(store) {
  const metaKey = (id) => `${META_PREFIX}${id}`;
  const codeKey = (code) => `code/${code}`;
  const lockKey = (name) => `lock/${name}`;

  async function readJson(key) {
    try {
      const value = await store.get(key, { type: 'json' });
      return value || null;
    } catch {
      return null;
    }
  }

  return {
    metadataKind: 'blobs',
    async init() {
      return true;
    },
    async readMeta(id) {
      return readJson(metaKey(id));
    },
    async writeMeta(entry) {
      await store.setJSON(metaKey(entry.id), entry);
      return entry;
    },
    async deleteMeta(id) {
      await store.delete(metaKey(id)).catch(() => {});
    },
    async listMetaIds() {
      // Attention : avec `paginate`, chaque itération renvoie une page
      // ({ blobs, directories }), et non une entrée.
      const ids = [];
      try {
        for await (const page of store.list({ prefix: META_PREFIX, paginate: true })) {
          for (const blob of page.blobs || []) {
            const key = String(blob.key || '');
            if (key.startsWith(META_PREFIX)) ids.push(key.slice(META_PREFIX.length));
          }
        }
      } catch {
        /* liste indisponible : le nettoyage sera simplement sauté */
      }
      return ids;
    },
    async reserveCode(code, id) {
      try {
        await store.setJSON(codeKey(code), { id }, { onlyIfNew: true });
        return true;
      } catch {
        const existing = await readJson(codeKey(code));
        if (existing) return false;
        await store.setJSON(codeKey(code), { id }).catch(() => {});
        return true;
      }
    },
    async releaseCode(code) {
      await store.delete(codeKey(code)).catch(() => {});
    },
    async readCode(code) {
      const value = await readJson(codeKey(code));
      return value ? value.id : null;
    },
    async tryLock(name, ttlMs) {
      const key = lockKey(name);
      const token = makeId(6);
      const deadline = now() + ttlMs;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await store.setJSON(key, { token, deadline }, { onlyIfNew: true });
          return { token, key };
        } catch {
          const current = await readJson(key);
          if (!current) {
            await store.setJSON(key, { token, deadline }).catch(() => {});
            return { token, key };
          }
          if (Number(current.deadline) < now()) {
            await store.delete(key).catch(() => {});
            await sleep(30 + attempt * 40);
            continue;
          }
          return null;
        }
      }
      return null;
    },
    async releaseLock(lock) {
      if (!lock) return;
      await store.delete(lock.key).catch(() => {});
    }
  };
}

/* -------------------------------- fabrique ------------------------------- */

/**
 * Assemble le stockage effectif.
 *
 * @param {object} options
 * @param {'blobs'|'local'} options.metaMode   où vivent les métadonnées
 * @param {'local'|'remote'|'blobs'} options.objectMode où vivent les fichiers
 * @param {string} options.rootDir             dossier de travail du mode local
 */
export async function createStore({ metaMode = 'local', objectMode = 'local', rootDir }) {
  const parts = createLocalParts({ rootDir });

  async function blobsStore() {
    try {
      const { getStore } = await import('@netlify/blobs');
      return getStore({ name: STORE_NAME, consistency: 'strong' });
    } catch (error) {
      throw new Error(`Netlify Blobs indisponible: ${error.message}`);
    }
  }

  let meta = parts.meta;
  if (metaMode === 'blobs') {
    meta = createBlobsMeta(await blobsStore());
  }

  const objects =
    objectMode === 'blobs'
      ? createBlobsObjects(await blobsStore())
      : objectMode === 'local'
        ? parts.objects
        : createRemoteObjects();
  const backend = {
    ...meta,
    ...objects,
    kind: `${meta.metadataKind}+${objects.objectKind}`,
    metadataKind: meta.metadataKind,
    objectKind: objects.objectKind
  };

  await meta.init();
  await objects.init();
  return backend;
}
