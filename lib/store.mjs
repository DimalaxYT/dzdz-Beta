'use strict';

/**
 * Couche de stockage des métadonnées (petites : identifiant, code, expiration).
 *
 * Deux implémentations derrière la même interface :
 *  - `blobs` : Netlify Blobs (production Netlify, cohérence forte) ;
 *  - `local` : fichiers JSON sur disque (serveur Node classique / développement).
 *
 * Le disque local utilise des écritures atomiques (fichier temporaire unique
 * puis `rename`) et une file d'attente interne : deux transferts simultanés ne
 * peuvent plus se détruire mutuellement.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { createQueue, makeId, now, sleep } from './util.mjs';

const STORE_NAME = 'dropqr';

/* --------------------------------- local --------------------------------- */

function createLocalBackend({ rootDir }) {
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

  return {
    kind: 'local',
    rootDir,
    objectsDir,
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
    async writeMeta(meta) {
      await ensure();
      await writeAtomic(path.join(metaDir, `${meta.id}.json`), JSON.stringify(meta));
      return meta;
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
    },
    objectPath(key) {
      const safe = String(key).replace(/[^a-zA-Z0-9._-]/g, '_');
      return path.join(objectsDir, safe);
    },
    async deleteObject(key) {
      await fsp.rm(this.objectPath(key), { force: true }).catch(() => {});
    },
    async statObject(key) {
      const stat = await fsp.stat(this.objectPath(key)).catch(() => null);
      return stat ? { exists: true, size: stat.size } : { exists: false };
    }
  };
}

/* --------------------------------- blobs --------------------------------- */

function createBlobsBackend(store) {
  const metaKey = (id) => `meta/${id}`;
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
    kind: 'blobs',
    async init() {
      return true;
    },
    async readMeta(id) {
      return readJson(metaKey(id));
    },
    async writeMeta(meta) {
      await store.setJSON(metaKey(meta.id), meta);
      return meta;
    },
    async deleteMeta(id) {
      await store.delete(metaKey(id)).catch(() => {});
    },
    async listMetaIds() {
      const ids = [];
      try {
        for await (const entry of store.list({ prefix: 'meta/', paginate: true })) {
          ids.push(String(entry.key).slice('meta/'.length));
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
    },
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

/* -------------------------------- fabrique ------------------------------- */

export async function createStore({ mode, rootDir }) {
  if (mode === 'blobs') {
    let store;
    try {
      const { getStore } = await import('@netlify/blobs');
      store = getStore({ name: STORE_NAME, consistency: 'strong' });
    } catch (error) {
      throw new Error(`Netlify Blobs indisponible: ${error.message}`);
    }
    const backend = createBlobsBackend(store);
    await backend.init();
    return backend;
  }

  const backend = createLocalBackend({ rootDir });
  await backend.init();
  return backend;
}
