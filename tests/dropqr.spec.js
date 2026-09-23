const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;
const jsQR = require('jsqr');

const smallFile = (name = 'bonjour.txt') => ({ name, mimeType: 'text/plain', buffer: Buffer.from('Bonjour depuis DropQR.\n') });
const errors = new WeakMap();
test.beforeEach(async ({ page }) => {
  errors.set(page, []);
  page.on('pageerror', (error) => errors.get(page).push(error.message));
});
test.afterEach(async ({ page }) => { expect(errors.get(page), 'Aucune erreur JavaScript').toEqual([]); });

async function noOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(await page.evaluate(() => innerWidth));
}
async function upload(page, file = smallFile()) {
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles(file);
  await expect(page.locator('#result')).toBeVisible();
  return JSON.parse(await page.evaluate(() => localStorage.getItem('dropqr.transfers')))[0];
}
async function remove(request, transfer) {
  if (transfer) await request.delete(`/api/transfers/${transfer.id}`, { headers: { 'X-Delete-Key': transfer.deleteKey } });
}

for (const [width, height] of [[320, 640], [375, 812], [390, 844], [430, 932], [844, 390]]) {
  test(`Téléphone ${width}×${height} : action immédiate, aucune ressource 3D`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const resources = [];
    page.on('request', (request) => resources.push(request.url()));
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await expect(page.locator('html')).toHaveClass(/is-mobile/);
    expect(await page.evaluate(() => window.DropQRExperience.enable3D)).toBe(false);
    expect(resources.filter((url) => /three\.module|landing3d|qrcode\.min/.test(url))).toEqual([]);
    await expect(page.locator('.nv-send')).toBeVisible();
    await expect(page.locator('.nv-receive')).toBeVisible();
    expect((await page.locator('.nv-send').boundingBox()).height).toBeGreaterThanOrEqual(44);
    await expect(page.locator('#fileInput')).toBeAttached();
    const drop = await page.locator('#dropzone').boundingBox();
    // En paysage le contrôle débute dans le premier écran, sans imposer de taille fixe.
    expect(drop.y).toBeLessThan(height);
    if (height > 500) expect(drop.y + drop.height).toBeLessThan(height);
    await noOverflow(page);
    await page.locator('.nv-menu summary').click();
    await expect(page.locator('.nv-menu-panel a[href="/mentions"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.nv-menu')).not.toHaveAttribute('open');
  });
}

test('Transfert réel : SVG scannable, copie, partage, téléchargement et suppression', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: async (data) => { window.shared = data; } }));
  const file = smallFile('résumé-été.txt');
  const transfer = await upload(page, file);
  try {
    const link = await page.locator('#shareLink').inputValue();
    expect(new URL(link).pathname).toBe(`/d/${transfer.id}`);
    await expect(page.locator('#qrImage')).toHaveAttribute('src', /^data:image\/svg\+xml/);
    await expect.poll(() => page.locator('#qrImage').evaluate((img) => img.complete && img.naturalWidth > 0)).toBe(true);
    const pixels = await page.locator('#qrImage').evaluate((img) => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 240;
      const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0, 240, 240);
      return Array.from(ctx.getImageData(0, 0, 240, 240).data);
    });
    expect(jsQR(new Uint8ClampedArray(pixels), 240, 240)?.data).toBe(link);
    await page.locator('#copyButton').click();
    await expect(page.locator('#status')).toContainText('Lien copié');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);
    await page.locator('#shareButton').click();
    expect(await page.evaluate(() => window.shared.url)).toBe(link);
    const qrDownload = page.waitForEvent('download');
    await page.locator('#downloadQR').click();
    expect((await qrDownload).suggestedFilename()).toBe(`dropqr-${transfer.code}.svg`);
    await noOverflow(page);
    // Ouvrir un lien n'est jamais un téléchargement ni une suppression implicite.
    const response = await request.get(new URL(link).pathname);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toContain('Un fichier a été partagé avec vous.');
    const metadata = await (await request.get(`/api/transfers/${transfer.id}`)).json();
    expect(metadata.downloads).toBe(0);
    expect((await request.get(`/t/${transfer.id}`)).ok()).toBe(true);
    const download = await request.get(`/download/${transfer.id}`);
    expect(await download.body()).toEqual(file.buffer);
    expect([404, 410]).toContain((await request.get(`/api/transfers/${transfer.id}`)).status());
  } finally { await remove(request, transfer); }
});

test('Caméra et partage indisponible : vrais replis, pas de faux succès', async ({ page, request }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
  await page.goto('/');
  await expect(page.locator('#cameraInput')).toHaveAttribute('capture', 'environment');
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#cameraButton').click();
  await (await chooser).setFiles({ name: 'photo.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/AAAAABJRU5ErkJggg==', 'base64') });
  await expect(page.locator('#result')).toBeVisible();
  const transfer = JSON.parse(await page.evaluate(() => localStorage.getItem('dropqr.transfers')))[0];
  try {
    await page.locator('#shareButton').click();
    await expect(page.locator('#status')).toContainText('Partage natif indisponible');
    await page.locator('#newTransfer').click();
    await expect(page.locator('#filePicker')).toBeVisible();
    await expect(page.locator('#result')).toBeHidden();
  } finally { await remove(request, transfer); }
});

test('Annuler pendant un envoi par morceaux ne finalise pas le transfert', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let chunks = 0;
  let completed = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/transfers/complete')) completed++; });
  await page.route('**/api/transfers/chunk', async (route) => { chunks++; await held; await route.abort().catch(() => {}); });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1400 * 1024, 1) });
  await expect.poll(() => chunks).toBeGreaterThan(0);
  await page.locator('#cancelUpload').click();
  release();
  await expect(page.locator('#status')).toContainText('Envoi arrêté');
  await expect(page.locator('#result')).toBeHidden();
  expect(completed).toBe(0);
  await page.locator('#clearFile').click();
  await expect(page.locator('#filePicker')).toBeVisible();
});

test('Erreur serveur : fichier conservé et nouvelle tentative fonctionnelle', async ({ page, request }) => {
  let failed = false;
  await page.route('**/api/transfers/complete', (route) => {
    if (!failed) { failed = true; return route.fulfill({ status: 500, json: { error: 'Serveur temporairement indisponible.' } }); }
    return route.continue();
  });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles(smallFile());
  await expect(page.locator('#status')).toContainText('Serveur temporairement indisponible');
  await expect(page.locator('#fileChipName')).toHaveText('bonjour.txt');
  await expect(page.locator('#result')).toBeHidden();
  await page.locator('#sendButton').click();
  await expect(page.locator('#result')).toBeVisible();
  const transfer = JSON.parse(await page.evaluate(() => localStorage.getItem('dropqr.transfers')))[0];
  await remove(request, transfer);
});

test('Limite serveur respectée avant de créer une session', async ({ page }) => {
  const writes = [];
  page.on('request', (request) => { if (request.method() === 'POST') writes.push(request.url()); });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles({ name: 'trop-grand.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(3 * 1024 * 1024) });
  await expect(page.locator('#status')).toContainText('dépasse la limite');
  expect(writes).toEqual([]);
  await expect(page.locator('#result')).toBeHidden();
});

test('Pages internes : navigation répétée, historique, code et suppression', async ({ page, request }) => {
  await page.goto('/upload');
  await page.evaluate(() => { window.navigationSentinel = 'same-document'; });
  for (const route of ['/receive', '/upload', '/receive', '/upload']) {
    await page.locator(`.nv-actions a[href="${route}"]`).click();
    await expect(page).toHaveURL(new RegExp(`${route}$`));
    await expect(page.locator('html')).not.toHaveClass(/pjax-loading/);
    expect(await page.evaluate(() => window.navigationSentinel)).toBe('same-document');
  }
  await page.locator('#fileInput').setInputFiles(smallFile('navigation.txt'));
  await expect(page.locator('#sendButton')).toBeVisible();
  await page.locator('#sendButton').click();
  await expect(page.locator('#result')).toBeVisible();
  const transfer = JSON.parse(await page.evaluate(() => localStorage.getItem('dropqr.transfers')))[0];
  try {
    await page.locator('.nv-receive').click();
    await expect(page.locator('#receiveForm')).toBeVisible();
    await page.locator('#transferCode').fill(transfer.code);
    await page.locator('#receiveForm button').click();
    await expect(page.locator('#receiveResult')).toBeVisible();
    await expect(page.locator('#receiveFileName')).toHaveText('navigation.txt');
    expect((await page.locator('#downloadButton').boundingBox()).y).toBeLessThan(844);
    await page.locator('#otherCode').click();
    await page.locator('#transferCode').fill('INVALIDE');
    await page.locator('#receiveForm button').click();
    await expect(page.locator('#receiveStatus')).toContainText('Code introuvable');
    await page.locator('.nv-menu summary').click();
    await page.locator('.nv-menu-panel a[href="/mentions"]').click();
    await expect(page.locator('h1')).toContainText('Vos fichiers');
    await expect(page.locator('link[href*="landing.css"]')).toHaveCount(1);
    await page.goBack();
    await expect(page.locator('#receiveForm')).toBeVisible();
    await page.locator('.nv-menu summary').click();
    await page.locator('.nv-menu-panel a[href="/dashboard"]').click();
    await expect(page.locator('.transfer-name')).toHaveText('navigation.txt');
    page.once('dialog', (dialog) => dialog.accept());
    await page.locator('.transfer-actions .danger').click();
    await expect(page.locator('#dashboardEmpty')).toBeVisible();
  } finally { await remove(request, transfer); }
});

test('Le destinataire peut télécharger sans JavaScript', async ({ browser, request }) => {
  const created = await request.post('/api/transfers', { multipart: { file: { name: 'sans-js.txt', mimeType: 'text/plain', buffer: Buffer.from('Sans JavaScript') } } });
  const data = await created.json();
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(data.shareUrl);
    await expect(page.locator('.share-download')).toBeVisible();
    const download = page.waitForEvent('download');
    await page.locator('.share-download').click();
    expect((await download).suggestedFilename()).toBe('sans-js.txt');
  } finally { await context.close(); await remove(request, data); }
});

test('AA et débordements : toutes les pages, largeur 320 px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  for (const path of ['/', '/upload', '/receive', '/dashboard', '/help', '/mentions', '/api-not-available.html', '/d/introuvable123']) {
    await page.goto(path);
    await noOverflow(page);
    const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(report.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) })), path).toEqual([]);
  }
});

test.describe('Ordinateur', () => {
  test.use({ viewport: { width: 1440, height: 960 }, isMobile: false, hasTouch: false, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36' });
  test('3D activée automatiquement et navigation visuelle', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toHaveClass(/webgl-ready/);
    expect(await page.evaluate(() => window.DropQRExperience.enable3D)).toBe(true);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('three.module')))).toBe(true);
    await noOverflow(page);
    await page.locator('.nv-receive').click();
    await expect(page.locator('body')).toHaveClass(/page-sub/);
    await expect(page.locator('h1')).toContainText('Votre fichier');
  });
  test('Mouvement réduit et désactivation explicite : aucun moteur chargé', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/?3d=1');
    expect(await page.evaluate(() => window.DropQRExperience.enable3D)).toBe(false);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/?3d=0');
    expect(await page.evaluate(() => window.DropQRExperience.enable3D)).toBe(false);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('three.module')))).toBe(false);
    await expect(page.locator('.chapter-copy').first()).toBeVisible();
  });
  test('WebGL indisponible : le transfert ne dépend pas de la scène', async ({ page, request }) => {
    await page.addInitScript(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) { return /^webgl/.test(type) ? null : original.call(this, type, ...args); };
    });
    const transfer = await upload(page);
    try { await expect(page.locator('body')).toHaveClass(/no-webgl/); await expect(page.locator('#qrImage')).toBeVisible(); }
    finally { await remove(request, transfer); }
  });
});

test('Plusieurs morceaux : nouvelle tentative sans corruption du fichier', async ({ page, request }) => {
  let first = true;
  let attempts = 0;
  await page.route('**/api/transfers/chunk', (route) => {
    attempts++;
    if (first) { first = false; return route.fulfill({ status: 503, json: { error: 'Réessayez ce morceau.' } }); }
    return route.continue();
  });
  const file = { name: 'deux-morceaux.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1400 * 1024, 23) };
  const transfer = await upload(page, file);
  try {
    expect(attempts).toBeGreaterThanOrEqual(3);
    const response = await request.get(`/download/${transfer.id}`);
    expect(await response.body()).toEqual(file.buffer);
  } finally { await remove(request, transfer); }
});

test('L’annulation reste immédiate si la configuration tarde à répondre', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/api/config', async (route) => { await held; await route.continue().catch(() => {}); });
  await page.goto('/');
  await page.locator('#fileInput').setInputFiles(smallFile());
  await expect(page.locator('#cancelUpload')).toBeVisible();
  await page.locator('#cancelUpload').click();
  await expect(page.locator('#status')).toContainText('Envoi arrêté', { timeout: 2000 });
  release();
});

test('Quitter un envoi actif ne laisse ni requêtes ni écouteurs sur la page suivante', async ({ page }) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let chunks = 0;
  await page.route('**/api/transfers/chunk', async (route) => { chunks++; await held; await route.abort().catch(() => {}); });
  await page.goto('/upload');
  await page.locator('#fileInput').setInputFiles(smallFile());
  await page.locator('#sendButton').click();
  await expect.poll(() => chunks).toBeGreaterThan(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('.nv-receive').click();
  release();
  await expect(page.locator('#receiveForm')).toBeVisible();
  expect(await page.evaluate(() => window.DropQRTransferBusy)).toBe(false);
  await page.locator('.nv-send').click();
  await expect(page.locator('#filePicker')).toBeVisible();
});

test('Un fichier vide emprunte aussi un vrai parcours complet', async ({ page, request }) => {
  const transfer = await upload(page, { name: 'vide.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  try {
    const response = await request.get(`/download/${transfer.id}`);
    expect((await response.body()).length).toBe(0);
  } finally { await remove(request, transfer); }
});

test('Résultat et réception : contraste AA et noms longs à 320 px', async ({ page, request }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const transfer = await upload(page, smallFile('Un-nom-de-fichier-volontairement-très-long-et-sans-espaces-pour-tester-le-petit-écran-du-téléphone.txt'));
  try {
    for (const path of [null, new URL(transfer.shareUrl).pathname, `/receive?code=${transfer.code}`]) {
      if (path) await page.goto(path);
      if (path?.startsWith('/receive')) await expect(page.locator('#receiveResult')).toBeVisible();
      await noOverflow(page);
      const report = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      expect(report.violations.map((v) => ({ id: v.id, targets: v.nodes.map((node) => node.target) }))).toEqual([]);
    }
  } finally { await remove(request, transfer); }
});
