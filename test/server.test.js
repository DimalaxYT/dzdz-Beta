'use strict';

// Tests d'intégration: chaque test démarre un serveur DropQR isolé
// (port libre + dossier de stockage temporaire) puis l'arrête.
//   npm test

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return response.json();
    } catch (_error) {
      // le serveur n'écoute pas encore
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Le serveur n'a pas démarré sur ${base}`);
}

// Tous les serveurs démarrés: ils doivent être arrêtés, sinon le processus de
// test reste vivant indéfiniment à cause des processus enfants.
const liveServers = new Set();

async function stopAllServers() {
  await Promise.all([...liveServers].map((ctx) => ctx.stop().catch(() => {})));
  liveServers.clear();
}

async function startServer(env = {}) {
  const port = await freePort();
  const storageDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dropqr-test-'));
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      STORAGE_DIR: storageDir,
      DISCORD_NOTIFY: 'false',
      PUBLIC_URL: '',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });

  const base = `http://127.0.0.1:${port}`;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
  };

  const ctx = { base, stop, storageDir, filesDir: path.join(storageDir, 'files'), log: () => log };
  liveServers.add(ctx);

  try {
    await waitForHealth(base);
  } catch (error) {
    liveServers.delete(ctx);
    await stop();
    throw new Error(`${error.message}\n${log}`);
  }

  return ctx;
}

async function json(response) {
  return { status: response.status, headers: response.headers, payload: await response.json() };
}

async function uploadClassic(base, { name, content, mimeType = 'text/plain', deleteAfterDownload = 'false' }) {
  const form = new FormData();
  form.set('deleteAfterDownload', deleteAfterDownload);
  form.set('file', new Blob([content], { type: mimeType }), name);
  return json(await fetch(`${base}/api/transfers`, { method: 'POST', body: form }));
}

async function uploadChunked(base, {
  name,
  content,
  mimeType = 'text/plain',
  deleteAfterDownload = 'false',
  totalSize
}) {
  const uploadId = crypto.randomUUID().replaceAll('-', '');
  const form = new FormData();
  form.set('uploadId', uploadId);
  form.set('chunkIndex', '0');
  form.set('totalChunks', '1');
  form.set('totalSize', String(totalSize === undefined ? Buffer.byteLength(content) : totalSize));
  form.set('fileName', name);
  form.set('mimeType', mimeType);
  form.set('deleteAfterDownload', deleteAfterDownload);
  form.set('autoFinalize', 'false');
  form.set('chunk', new Blob([content]), 'part');

  const part = await json(await fetch(`${base}/api/transfers/chunk`, { method: 'POST', body: form }));
  // Le serveur peut refuser dès le premier morceau (limite de taille dépassée).
  if (part.status >= 400) return part;
  assert.equal(part.status, 202, 'le morceau doit être accepté');

  return json(await fetch(`${base}/api/transfers/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId })
  }));
}

describe('robustesse des routes API', () => {
  after(stopAllServers);

  test('un identifiant dangereux ne fait plus planter le serveur', async (t) => {
    const ctx = await startServer();

    for (const id of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      const response = await json(await fetch(`${ctx.base}/api/transfers/${encodeURIComponent(id)}`));
      assert.equal(response.status, 404, `${id} doit renvoyer 404`);
    }

    // Le serveur doit toujours répondre après ces requêtes.
    const health = await fetch(`${ctx.base}/api/health`);
    assert.equal(health.status, 200);

    const del = await fetch(`${ctx.base}/api/transfers/__proto__`, { method: 'DELETE' });
    assert.equal(del.status, 404);

    const healthAfter = await fetch(`${ctx.base}/api/health`);
    assert.equal(healthAfter.status, 200);
  });

  test('les pages HTML sont servies avec une CSP et sans sniffing MIME', async () => {
    const ctx = await startServer();

    for (const route of ['/', '/upload', '/receive', '/dashboard', '/help']) {
      const response = await fetch(`${ctx.base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', route);
      const csp = response.headers.get('content-security-policy') || '';
      assert.match(csp, /default-src 'self'/, route);
      assert.match(csp, /script-src 'self'/, route);
      assert.ok(!csp.includes('frame-ancestors'), 'frame-ancestors casserait la preview en iframe');
    }
    assert.equal((await fetch(`${ctx.base}/`)).headers.get('x-frame-options'), null);
  });
});

describe('sécurité de l’aperçu /view', () => {
  after(stopAllServers);

  test('un HTML uploadé n’est jamais rendu en ligne', async () => {
    const ctx = await startServer();

    const markup = '<!doctype html><script>window.droprqTest = true;</script>';
    const created = await uploadClassic(ctx.base, { name: 'page.html', content: markup, mimeType: 'text/html' });
    assert.equal(created.status, 201);

    const view = await fetch(`${ctx.base}/view/${created.payload.id}`);
    assert.equal(view.status, 415, 'le HTML ne doit pas être servi en ligne');
    assert.equal(view.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.ok(!(await view.text()).includes('<script>window.droprqTest'));
  });

  test('un SVG uploadé n’est pas rendu en ligne, un média si', async () => {
    const ctx = await startServer();

    const svg = await uploadClassic(ctx.base, {
      name: 'image.svg',
      content: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      mimeType: 'image/svg+xml'
    });
    assert.equal(svg.status, 201);
    assert.equal((await fetch(`${ctx.base}/view/${svg.payload.id}`)).status, 415);

    const video = await uploadClassic(ctx.base, {
      name: 'clip.mp4',
      content: 'fake-video-bytes',
      mimeType: 'video/mp4'
    });
    assert.equal(video.status, 201);
    const preview = await fetch(`${ctx.base}/view/${video.payload.id}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get('content-type'), /^video\/mp4/);
    assert.equal(preview.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(preview.headers.get('accept-ranges'), 'bytes');
  });

  test('le téléchargement reste en pièce jointe', async () => {
    const ctx = await startServer();

    const created = await uploadClassic(ctx.base, {
      name: 'page.html',
      content: '<!doctype html><script>alert(1)</script>',
      mimeType: 'text/html'
    });
    const download = await fetch(`${ctx.base}/download/${created.payload.id}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /attachment/);
  });
});

describe('option de suppression après téléchargement', () => {
  after(stopAllServers);

  test('elle est respectée sur l’upload par morceaux', async () => {
    const ctx = await startServer();

    const kept = await uploadChunked(ctx.base, { name: 'garde.txt', content: 'contenu', deleteAfterDownload: 'false' });
    assert.equal(kept.status, 201);
    assert.equal(kept.payload.deleteAfterDownload, false, 'la case décochée doit être respectée');

    // Le fichier doit toujours être téléchargeable après un premier téléchargement.
    const first = await fetch(`${ctx.base}/download/${kept.payload.id}`);
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${ctx.base}/download/${kept.payload.id}`);
    assert.equal(second.status, 200);
    await second.text();
  });

  test('elle supprime bien le fichier quand elle est activée', async () => {
    const ctx = await startServer();

    const ephemeral = await uploadChunked(ctx.base, { name: 'jetable.txt', content: 'contenu', deleteAfterDownload: 'true' });
    assert.equal(ephemeral.status, 201);
    assert.equal(ephemeral.payload.deleteAfterDownload, true);

    const first = await fetch(`${ctx.base}/download/${ephemeral.payload.id}`);
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${ctx.base}/download/${ephemeral.payload.id}`);
    assert.equal(second.status, 404);
  });

  test('l’upload classique reste cohérent', async () => {
    const ctx = await startServer();

    const kept = await uploadClassic(ctx.base, { name: 'garde.txt', content: 'contenu', deleteAfterDownload: 'false' });
    assert.equal(kept.payload.deleteAfterDownload, false);
    const removed = await uploadClassic(ctx.base, { name: 'jetable.txt', content: 'contenu', deleteAfterDownload: 'true' });
    assert.equal(removed.payload.deleteAfterDownload, true);
  });
});

describe('limite de taille', () => {
  after(stopAllServers);

  test('une taille annoncée fausse ne permet pas de dépasser la limite', async () => {
    const ctx = await startServer({ MAX_FILE_SIZE: '1kb' });

    const health = await json(await fetch(`${ctx.base}/api/health`));
    assert.equal(health.payload.maxFileSizeBytes, 1024);

    // Le client ment sur totalSize: seuls les octets réels doivent compter.
    const bypass = await uploadChunked(ctx.base, {
      name: 'gros.txt',
      content: 'X'.repeat(2048),
      totalSize: 0
    });
    assert.equal(bypass.status, 413, 'la limite doit s’appliquer aux octets réellement reçus');

    const understated = await uploadChunked(ctx.base, {
      name: 'gros2.txt',
      content: 'X'.repeat(2048),
      totalSize: 10
    });
    assert.equal(understated.status, 413);
  });

  test('un fichier sous la limite passe toujours', async () => {
    const ctx = await startServer({ MAX_FILE_SIZE: '1kb' });

    const ok = await uploadChunked(ctx.base, { name: 'petit.txt', content: 'ok' });
    assert.equal(ok.status, 201);

    const tooBig = await uploadClassic(ctx.base, { name: 'trop-gros.txt', content: 'X'.repeat(4096) });
    assert.equal(tooBig.status, 413);
  });
});

describe('concurrence et nettoyage', () => {
  after(stopAllServers);

  test('huit uploads simultanés sont tous enregistrés', async () => {
    const ctx = await startServer();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        uploadClassic(ctx.base, { name: `parallele-${index}.txt`, content: `contenu ${index}` })
      )
    );

    for (const [index, result] of results.entries()) {
      assert.equal(result.status, 201, `l'upload ${index} a échoué: ${JSON.stringify(result.payload)}`);
    }

    const stats = await json(await fetch(`${ctx.base}/api/stats`));
    assert.equal(stats.payload.activeTransfers, 8, 'aucun transfert ne doit être perdu');
  });

  test('le nettoyage ne supprime pas un upload en cours', async () => {
    const ctx = await startServer();

    const boundary = 'dropqr-test-boundary';
    const initial = new Set(await fsp.readdir(ctx.filesDir));

    let watcher;
    let timer;
    const createdFile = new Promise((resolve, reject) => {
      timer = setTimeout(() => { watcher.close(); reject(new Error('aucun fichier d’upload observé')); }, 10000);
      watcher = fs.watch(ctx.filesDir, (_event, filename) => {
        if (filename && !initial.has(filename) && fs.existsSync(path.join(ctx.filesDir, filename))) {
          clearTimeout(timer);
          watcher.close();
          resolve(filename);
        }
      });
    });

    let request;
    const finished = new Promise((resolve, reject) => {
      request = http.request(`${ctx.base}/api/transfers`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` }
      }, (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode, payload: JSON.parse(Buffer.concat(chunks)) }));
      });
      request.on('error', reject);
    });

    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="deleteAfterDownload"\r\n\r\nfalse\r\n`);
    request.write(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="en-cours.txt"\r\nContent-Type: text/plain\r\n\r\n`);
    request.write('A'.repeat(1024));

    try {
      const filename = await createdFile;
      // Déclenche le nettoyage pendant que l'upload est toujours en cours.
      const stats = await fetch(`${ctx.base}/api/stats`);
      assert.equal(stats.status, 200);
      const stillThere = fs.existsSync(path.join(ctx.filesDir, filename));
      assert.equal(stillThere, true, 'le fichier en cours d’écriture ne doit pas être supprimé');

      request.end(`\r\n--${boundary}--\r\n`);
      const created = await finished;
      assert.equal(created.status, 201);

      const download = await fetch(`${ctx.base}/download/${created.payload.id}`);
      assert.equal(download.status, 200, 'le fichier doit rester téléchargeable');
      assert.equal(await download.text(), 'A'.repeat(1024));
    } finally {
      clearTimeout(timer);
      if (watcher) watcher.close();
      request.destroy();
    }
  });

  test('un fichier orphelin ancien est nettoyé, un fichier récent est conservé', async () => {
    const ctx = await startServer();

    await fsp.mkdir(ctx.filesDir, { recursive: true });
    const old = path.join(ctx.filesDir, 'vieux-orphelin.bin');
    const recent = path.join(ctx.filesDir, 'orphelin-recent.bin');
    await fsp.writeFile(old, 'vieux');
    await fsp.writeFile(recent, 'recent');
    const past = new Date(Date.now() - 45 * 60 * 1000);
    await fsp.utimes(old, past, past);

    await fetch(`${ctx.base}/api/stats`);

    assert.equal(fs.existsSync(old), false, 'un orphelin de plus de 30 min doit être supprimé');
    assert.equal(fs.existsSync(recent), true, 'un fichier récent ne doit jamais être supprimé');
  });
});

describe('cycle de vie d’un transfert', () => {
  after(stopAllServers);

  test('upload, statut, suppression par clé', async () => {
    const ctx = await startServer();

    const created = await uploadChunked(ctx.base, { name: 'document.pdf', content: 'pdf-factice', mimeType: 'application/pdf' });
    assert.equal(created.status, 201);
    assert.match(created.payload.code, /^[A-Z0-9]{7}$/);
    assert.ok(created.payload.deleteKey, 'la clé de suppression doit être retournée');

    const byCode = await json(await fetch(`${ctx.base}/api/codes/${created.payload.code}`));
    assert.equal(byCode.status, 200);
    assert.equal(byCode.payload.fileName, 'document.pdf');

    const status = await json(await fetch(`${ctx.base}/api/transfers/${created.payload.id}`));
    assert.equal(status.status, 200);
    assert.equal(status.payload.downloads, 0);

    const wrongKey = await fetch(`${ctx.base}/api/transfers/${created.payload.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Delete-Key': 'mauvaise-cle' },
      body: JSON.stringify({ deleteKey: 'mauvaise-cle' })
    });
    assert.equal(wrongKey.status, 403);

    const deleted = await fetch(`${ctx.base}/api/transfers/${created.payload.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Delete-Key': created.payload.deleteKey },
      body: JSON.stringify({ deleteKey: created.payload.deleteKey })
    });
    assert.equal(deleted.status, 200);

    const afterDelete = await fetch(`${ctx.base}/api/transfers/${created.payload.id}`);
    assert.equal(afterDelete.status, 404);
  });

  test('la page publique affiche le fichier', async () => {
    const ctx = await startServer();

    const created = await uploadClassic(ctx.base, { name: 'notes.txt', content: 'hello' });
    const page = await fetch(`${ctx.base}/t/${created.payload.id}`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('notes.txt'));
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  });
});
