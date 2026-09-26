'use strict';

// DropQR — création d'archives .zip directement dans le navigateur.
// Utilisé quand plusieurs fichiers (ou un dossier) sont sélectionnés : ils sont
// regroupés en une seule archive .zip avant l'envoi, quel que soit leur type
// (.zip, .rblx, .obj, images, vidéos… tout).
//
// Choix techniques :
//   - méthode STORE (aucune compression) : les octets sont copiés tels quels,
//     le .zip reste léger à créer et ne réaugmente pas des formats déjà
//     compressés (png, mp4, zip…) ;
//   - les fichiers ne sont pas lus en mémoire : seuls les CRC32 sont calculés
//     par lecture séquentielle, puis les Blob d'origine sont référencés dans
//     l'archive finale (concaténation de morceaux) ;
//   - support ZIP64 (fichiers/archives de plus de 4 Gio, plus de 65535
//     entrées) pour rester compatible avec Windows, macOS et Linux.
//
// API (window.DropQRZip) :
//   collectEntries(dataTransfer) -> Promise<Array<{name, data: File}>> (dossiers inclus)
//   entriesFromFiles(files)      -> Array<{name, data: File}>
//   buildZip(entries, opts)      -> Promise<Blob>   opts: { onProgress(processed, total) }
//   makeZipFile(entries, name, opts) -> Promise<File>
//   nameOf(file)                 -> nom relatif mémorisé (chemin de dossier inclus)
//   extensionOf(name)            -> extension sans le point, en minuscules
//   crc32(blob)                  -> Promise<number>

(function (root) {
  const NAME_MAP = new WeakMap();
  const encoder = new TextEncoder();

  /* ---------- CRC32 (table, lecture séquentielle) ---------- */

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32Update(crc, bytes) {
    let c = crc >>> 0;
    for (let i = 0; i < bytes.length; i += 1) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return c >>> 0;
  }

  async function crc32OfBlob(blob) {
    const CHUNK = 4 * 1024 * 1024;
    const size = Number(blob.size || 0);
    let c = 0xFFFFFFFF;
    for (let offset = 0; offset < size; offset += CHUNK) {
      const end = Math.min(offset + CHUNK, size);
      const buffer = await blob.slice(offset, end).arrayBuffer();
      c = crc32Update(c, new Uint8Array(buffer));
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------- Petits utilitaires d'écriture binaire ---------- */

  function u16(value) {
    const bytes = new Uint8Array(2);
    new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
    return bytes;
  }

  function u32(value) {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, Number(value) >>> 0, true);
    return bytes;
  }

  function u64(value) {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
    return bytes;
  }

  function concatBytes(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /* ---------- Noms d'entrées ---------- */

  // Nettoie un chemin relatif : pas de « .. », pas de racine, séparateurs « / ».
  function sanitizeName(rawName) {
    let name = String(rawName == null ? '' : rawName).replace(/\\/g, '/');
    name = name.replace(/^[a-zA-Z]:\//, '');
    name = name.split('/').filter((seg) => seg && seg !== '.' && seg !== '..').join('/');
    if (!name) name = 'fichier';
    // Le champ « longueur du nom » fait 2 octets (en octets UTF-8).
    while (encoder.encode(name).length > 0xffff) name = name.slice(0, -1);
    return name;
  }

  function extensionOf(name) {
    const base = sanitizeName(name).split('/').pop() || '';
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1 ? base.slice(dot + 1).toLowerCase() : '';
  }

  function uniqueName(name, used) {
    let candidate = name;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
    const slash = name.lastIndexOf('/');
    const dir = slash >= 0 ? name.slice(0, slash + 1) : '';
    const file = slash >= 0 ? name.slice(slash + 1) : name;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    for (let n = 2; ; n += 1) {
      candidate = `${dir}${stem}-${n}${ext}`;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
  }

  /* ---------- Date DOS (format des en-têtes ZIP) ---------- */

  function dosTimeDate(date) {
    const d = (date instanceof Date && !Number.isNaN(date.getTime())) ? date : new Date();
    const year = Math.max(1980, d.getFullYear());
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { dosTime, dosDate };
  }

  /* ---------- En-têtes ZIP ---------- */

  const SIG_LOCAL = 0x04034b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_ZIP64_EOCD = 0x06064b50;
  const SIG_ZIP64_LOCATOR = 0x07064b50;
  const SIG_EOCD = 0x06054b50;
  const FLAG_UTF8 = 0x0800;
  const METHOD_STORE = 0;
  const ZIP64_THRESHOLD = 0xffffffff;

  function makeLocalHeader(entry, nameBytes) {
    const sizeOverflow = entry.size >= ZIP64_THRESHOLD;
    const extra = sizeOverflow
      ? concatBytes([u16(0x0001), u16(16), u64(entry.size), u64(entry.size)], 20)
      : new Uint8Array(0);
    const header = concatBytes([
      u32(SIG_LOCAL),
      u16(sizeOverflow ? 45 : 20),      // version needed
      u16(FLAG_UTF8),                   // flags (noms UTF-8)
      u16(METHOD_STORE),                // méthode
      u16(entry.dosTime),
      u16(entry.dosDate),
      u32(entry.crc),
      u32(sizeOverflow ? ZIP64_THRESHOLD : entry.size),
      u32(sizeOverflow ? ZIP64_THRESHOLD : entry.size),
      u16(nameBytes.length),
      u16(extra.length),
      nameBytes,
      extra
    ], 30 + nameBytes.length + extra.length);
    return header;
  }

  function makeCentralHeader(entry, nameBytes) {
    const sizeOverflow = entry.size >= ZIP64_THRESHOLD;
    const offsetOverflow = entry.offset >= ZIP64_THRESHOLD;
    const extraChunks = [];
    if (sizeOverflow) {
      extraChunks.push(u16(0x0001), u16(8 + 8 + (offsetOverflow ? 8 : 0)), u64(entry.size), u64(entry.size));
    }
    if (offsetOverflow) {
      if (!sizeOverflow) extraChunks.push(u16(0x0001), u16(8));
      extraChunks.push(u64(entry.offset));
    }
    const extra = extraChunks.length ? concatBytes(extraChunks, extraChunks.reduce((s, c) => s + c.length, 0)) : new Uint8Array(0);
    return concatBytes([
      u32(SIG_CENTRAL),
      u16((3 << 8) | (sizeOverflow || offsetOverflow ? 45 : 20)), // version made by (Unix)
      u16(sizeOverflow || offsetOverflow ? 45 : 20),              // version needed
      u16(FLAG_UTF8),
      u16(METHOD_STORE),
      u16(entry.dosTime),
      u16(entry.dosDate),
      u32(entry.crc),
      u32(sizeOverflow ? ZIP64_THRESHOLD : entry.size),
      u32(sizeOverflow ? ZIP64_THRESHOLD : entry.size),
      u16(nameBytes.length),
      u16(extra.length),
      u16(0),                       // commentaire
      u16(0),                       // disque
      u16(0),                       // attributs internes
      u32((0o100644 << 16) >>> 0),  // attributs externes (fichier régulier Unix)
      u32(offsetOverflow ? ZIP64_THRESHOLD : entry.offset),
      nameBytes,
      extra
    ], 46 + nameBytes.length + extra.length);
  }

  function makeZip64Eocd(count, cdSize, cdOffset, zip64EocdOffset) {
    return concatBytes([
      u32(SIG_ZIP64_EOCD),
      u64(44),                      // taille du reste de l'enregistrement
      u16((3 << 8) | 45),           // version made by
      u16(45),                      // version needed
      u32(0),                       // numéro de disque
      u32(0),                       // disque du répertoire central
      u64(count),                   // entrées sur ce disque
      u64(count),                   // entrées au total
      u64(cdSize),
      u64(cdOffset)
    ], 56);
  }

  function makeZip64Locator(zip64EocdOffset) {
    return concatBytes([
      u32(SIG_ZIP64_LOCATOR),
      u32(0),                       // disque du ZIP64 EOCD
      u64(zip64EocdOffset),
      u32(1)                        // nombre de disques
    ], 20);
  }

  function makeEocd(count, cdSize, cdOffset, zip64) {
    return concatBytes([
      u32(SIG_EOCD),
      u16(0),
      u16(0),
      u16(Math.min(count, zip64 ? 0xffff : count)),
      u16(Math.min(count, zip64 ? 0xffff : count)),
      u32(cdSize >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : cdSize),
      u32(cdOffset >= ZIP64_THRESHOLD ? ZIP64_THRESHOLD : cdOffset),
      u16(0)                        // commentaire
    ], 22);
  }

  /* ---------- Assemblage ---------- */

  // entries: [{ name, data: Blob, crc, size, dosTime, dosDate }] -> Blob final.
  // Exposée en interne (api._assembleZip) pour permettre des tests unitaires
  // sur les grands volumes sans manipuler de vrais fichiers de 4 Gio.
  function assembleZip(entries) {
    const parts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = encoder.encode(entry.name);
      const localHeader = makeLocalHeader(entry, nameBytes);
      parts.push(localHeader);
      offset += localHeader.length;
      const entryOffset = offset - localHeader.length;
      if (entry.size > 0) {
        parts.push(entry.data);
        offset += entry.size;
      }
      central.push({ ...entry, nameBytes, offset: entryOffset });
    }

    const cdOffset = offset;
    for (const item of central) {
      const header = makeCentralHeader(item, item.nameBytes);
      parts.push(header);
      offset += header.length;
    }
    const cdSize = offset - cdOffset;

    const zip64 = central.some((item) => item.size >= ZIP64_THRESHOLD || item.offset >= ZIP64_THRESHOLD)
      || cdOffset >= ZIP64_THRESHOLD || cdSize >= ZIP64_THRESHOLD || central.length >= 0xffff;

    if (zip64) {
      const zip64EocdOffset = offset;
      const zip64Eocd = makeZip64Eocd(central.length, cdSize, cdOffset, zip64EocdOffset);
      parts.push(zip64Eocd);
      offset += zip64Eocd.length;
      const locator = makeZip64Locator(zip64EocdOffset);
      parts.push(locator);
      offset += locator.length;
    }

    parts.push(makeEocd(central.length, cdSize, cdOffset, zip64));
    return new Blob(parts, { type: 'application/zip' });
  }

  /* ---------- API publique ---------- */

  function nameOf(file) {
    if (!file) return '';
    return NAME_MAP.get(file) || file.webkitRelativePath || sanitizeName(file.name);
  }

  function entriesFromFiles(files) {
    return Array.from(files || []).filter(Boolean).map((file) => ({
      name: sanitizeName(nameOf(file)),
      data: file
    }));
  }

  async function collectEntries(dataTransfer) {
    const out = [];
    const items = dataTransfer && dataTransfer.items ? Array.from(dataTransfer.items) : [];
    const entryOf = (item) => (item && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
    const hasEntries = items.some((item) => entryOf(item));

    if (hasEntries) {
      for (const item of items) {
        const entry = entryOf(item);
        if (entry) {
          await walkEntry(entry, '', out);
        } else {
          const file = item.getAsFile && item.getAsFile();
          if (file) out.push({ name: sanitizeName(file.name), data: file });
        }
      }
    } else {
      for (const file of Array.from((dataTransfer && dataTransfer.files) || [])) {
        out.push({ name: sanitizeName(file.webkitRelativePath || file.name), data: file });
      }
    }

    for (const entry of out) NAME_MAP.set(entry.data, entry.name);
    return out;
  }

  async function walkEntry(entry, prefix, out) {
    if (!entry) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ name: sanitizeName(prefix + file.name), data: file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const subPrefix = prefix + entry.name + '/';
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const child of batch) await walkEntry(child, subPrefix, out);
      }
    }
  }

  async function buildZip(list, options) {
    const opts = options || {};
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    const rawEntries = Array.isArray(list) ? list : [];
    const usedNames = new Set();
    const entries = rawEntries
      .map((item) => {
        if (!item) return null;
        // Accepte { name, data } ainsi que les File/Blob bruts.
        const data = item.data || ((typeof item.slice === 'function' && typeof item.size === 'number') ? item : null);
        if (!data) return null;
        return {
          name: uniqueName(sanitizeName(item.data ? (item.name || nameOf(data)) : nameOf(data)), usedNames),
          data
        };
      })
      .filter(Boolean);

    if (!entries.length) throw new Error('Aucun fichier à regrouper.');

    const totalBytes = entries.reduce((sum, entry) => sum + Number(entry.data.size || 0), 0);
    let processed = 0;
    const prepared = [];
    for (const entry of entries) {
      const crc = await crc32OfBlob(entry.data);
      if (onProgress) {
        processed += Number(entry.data.size || 0);
        onProgress(processed, totalBytes);
      }
      const stamp = dosTimeDate(entry.data.lastModified ? new Date(entry.data.lastModified) : new Date());
      prepared.push({
        name: entry.name,
        data: entry.data,
        crc,
        size: Number(entry.data.size || 0),
        dosTime: stamp.dosTime,
        dosDate: stamp.dosDate
      });
    }

    return assembleZip(prepared);
  }

  async function makeZipFile(list, fileName, options) {
    const blob = await buildZip(list, options);
    const name = sanitizeName(fileName || 'archive.zip').replace(/\.zip$/i, '') + '.zip';
    try {
      return new File([blob], name, { type: 'application/zip', lastModified: Date.now() });
    } catch (_error) {
      // Très vieux navigateurs sans constructeur File.
      blob.name = name;
      return blob;
    }
  }

  root.DropQRZip = {
    collectEntries,
    entriesFromFiles,
    buildZip,
    makeZipFile,
    nameOf,
    extensionOf,
    crc32: crc32OfBlob,
    _assembleZip: assembleZip
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = root.DropQRZip;
})(typeof globalThis !== 'undefined' ? globalThis : this);
