'use strict';

/**
 * Contrôle de mise en page, dans un vrai navigateur (sans interface).
 *
 * Vérifie ce qu'aucun test de code ne peut voir : ni débordement horizontal,
 * ni texte rogné, ni contenu resté invisible parce qu'une animation ne s'est
 * pas déclenchée, ni erreur JavaScript.
 *
 * Outils nécessaires (non installés par défaut) :
 *   npm install --no-save puppeteer-core @sparticuz/chromium
 *
 * Usage :
 *   npm run test:layout                 → contrôle, sortie non nulle en cas d'échec
 *   npm run test:layout -- --captures   → écrit aussi les captures dans /tmp
 */

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const CAPTURES = process.argv.includes('--captures');
const PORT = Number(process.env.LAYOUT_PORT || 4611);
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTES = ['/', '/upload', '/receive', '/dashboard', '/help'];
const WIDTHS = [
  { nom: 'mobile', width: 390, height: 844, mobile: true },
  { nom: 'tablette', width: 768, height: 1024, mobile: true },
  { nom: 'ordinateur', width: 1440, height: 1000, mobile: false }
];

let failures = 0;
let checks = 0;
const check = (label, condition, detail = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`  [${condition ? 'ok  ' : 'ÉCHEC'}] ${label}${detail ? ` — ${detail}` : ''}`);
};

const { default: chromium } = await import('@sparticuz/chromium').catch(() => ({ default: null }));
const { default: puppeteer } = await import('puppeteer-core').catch(() => ({ default: null }));

if (!puppeteer) {
  console.log('\nContrôle de mise en page ignoré : outil absent.');
  console.log('  npm install --no-save puppeteer-core @sparticuz/chromium\n');
  process.exit(0);
}

/* ---------------------------- le navigateur ------------------------------- */

/** Navigateurs déjà installés sur la machine, par ordre de préférence. */
const NAVIGATEURS_SYSTEME = [
  process.env.DROPQR_CHROMIUM,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'
].filter(Boolean);

const existe = (chemin) => fsp.access(chemin).then(() => true).catch(() => false);

/**
 * Sur un serveur minimal, le navigateur livré par `@sparticuz/chromium` ne
 * démarre pas : il lui manque des bibliothèques système (NSS, NSPR). Le paquet
 * les fournit justement — on les déballe et on les déclare.
 */
async function extraireBibliotheques() {
  const dossier = process.env.DROPQR_CHROMIUM_LIBS || path.join(os.tmpdir(), 'dropqr-chromium-libs');
  const dossierLib = path.join(dossier, 'lib');
  if (await existe(path.join(dossierLib, 'libnss3.so'))) return dossierLib;

  const archive = path.join(process.cwd(), 'node_modules/@sparticuz/chromium/bin/al2023.tar.br');
  if (!(await existe(archive))) return null;

  const zlib = await import('node:zlib');
  const { promisify } = await import('node:util');
  try {
    const decompresse = await promisify(zlib.brotliDecompress)(await fsp.readFile(archive));
    const fichierTar = path.join(dossier, 'al2023.tar');
    await fsp.mkdir(dossier, { recursive: true });
    await fsp.writeFile(fichierTar, decompresse);
    await new Promise((resolve) => {
      const tar = spawn('tar', ['-xf', fichierTar, '-C', dossier], { stdio: 'ignore' });
      tar.on('close', resolve);
      tar.on('error', resolve);
    });
    return (await existe(path.join(dossierLib, 'libnss3.so'))) ? dossierLib : null;
  } catch {
    return null;
  }
}

async function ouvrirNavigateur() {
  const options = { args: ['--no-sandbox', '--disable-dev-shm-usage'], headless: 'shell' };

  for (const chemin of NAVIGATEURS_SYSTEME) {
    if (!(await existe(chemin))) continue;
    try {
      return await puppeteer.launch({ ...options, executablePath: chemin });
    } catch {
      /* on essaie le suivant */
    }
  }

  if (chromium) {
    const executablePath = await chromium.executablePath();
    const args = [...chromium.args, '--no-sandbox', '--disable-dev-shm-usage'];
    try {
      return await puppeteer.launch({ ...options, args, executablePath });
    } catch (error) {
      const bibliotheques = await extraireBibliotheques();
      if (!bibliotheques) throw error;
      console.log('  (bibliothèques système du navigateur extraites automatiquement)');
      return await puppeteer.launch({
        ...options,
        args,
        executablePath,
        env: { ...process.env, LD_LIBRARY_PATH: bibliotheques }
      });
    }
  }

  return null;
}

/* ------------------------------- le serveur ------------------------------- */

const storageDir = path.join(os.tmpdir(), `dropqr-layout-${process.pid}`);
const serveur = spawn(process.execPath, ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    DROPQR_STORAGE: 'local',
    DROPQR_META: 'local',
    DROPQR_STORAGE_DIR: storageDir,
    PUBLIC_URL: BASE
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

async function attendreServeur() {
  for (let essai = 0; essai < 60; essai += 1) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function arreter() {
  serveur.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 300));
  await fsp.rm(storageDir, { recursive: true, force: true }).catch(() => {});
}

// Le serveur de test ne doit jamais survivre au script, même si celui-ci est
// interrompu (délai dépassé, Ctrl+C) : sinon il garde le port occupé.
process.on('exit', () => {
  try {
    serveur.kill('SIGKILL');
  } catch {
    /* déjà arrêté */
  }
});
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    serveur.kill('SIGKILL');
    process.exit(1);
  });
}

/* --------------------------- mesures dans la page -------------------------- */

/**
 * Un élément dépassant à droite ne gêne pas s'il est purement décoratif
 * (masqué aux technologies d'assistance et rogné par un parent). En revanche,
 * dès qu'il porte du texte visible, celui-ci est tronqué : c'est un défaut.
 */
const MESURE = (largeurAttendue) => {
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (element.offsetParent === null && style.position !== 'fixed') return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  };

  // Éléments volontairement hors écran (lien d'évitement) ou déplacés par une
  // animation CSS (bandeau défilant) : leur position n'est pas un défaut.
  const anime = (element) => {
    let courant = element;
    for (let niveau = 0; niveau < 5 && courant; niveau += 1) {
      const style = getComputedStyle(courant);
      if (style.animationName !== 'none' && style.animationDuration !== '0s') return true;
      if (style.transform !== 'none' && courant.classList.contains('marquee-track')) return true;
      courant = courant.parentElement;
    }
    return false;
  };

  // Un bloc volontairement défilable (code, tableau) peut contenir du texte
  // plus large que l'écran : c'est voulu, l'utilisateur fait défiler.
  const dansBlocDefilant = (element) => {
    let courant = element.parentElement;
    for (let niveau = 0; niveau < 6 && courant; niveau += 1) {
      const style = getComputedStyle(courant);
      if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && courant.getBoundingClientRect().width <= largeurAttendue + 1) {
        return true;
      }
      courant = courant.parentElement;
    }
    return false;
  };

  const textePropre = [...document.querySelectorAll('*')].filter((element) => {
    const direct = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim().length > 1);
    if (!direct || !visible(element)) return false;
    const rect = element.getBoundingClientRect();
    if (rect.left < -1000) return false;
    return !anime(element) && !dansBlocDefilant(element);
  });

  const rognes = textePropre
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > largeurAttendue + 1 || rect.left < -1;
    })
    .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`);

  const invisibles = [...document.querySelectorAll('[data-reveal]')]
    .filter((element) => visible(element) && Number(getComputedStyle(element).opacity) < 0.05)
    .map((element) => `${element.tagName.toLowerCase()}.${String(element.className).split(' ')[0]}`);

  return {
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    fenetreInterne: window.innerWidth,
    largeurDocument: document.documentElement.clientWidth,
    rognes: [...new Set(rognes)].slice(0, 6),
    invisibles: [...new Set(invisibles)].slice(0, 6),
    imagesSansDimensions: [...document.images].filter((image) => !image.getAttribute('width') || !image.getAttribute('height')).length,
    imagesCassees: [...document.images].filter((image) => image.complete && image.naturalWidth === 0).length,
    pictogrammesGeants: [...document.querySelectorAll('svg.icon')]
      .filter((icone) => icone.getBoundingClientRect().width > 48)
      .map((icone) => `${String(icone.parentElement?.className || '').split(' ')[0]} ${icone.getBoundingClientRect().width.toFixed(0)} px`)
  };
};

/* --------------------------------- contrôle ------------------------------- */

const browser = await ouvrirNavigateur();

if (!browser) {
  console.log('\nContrôle de mise en page ignoré : aucun navigateur trouvé.');
  console.log('  installe Google Chrome, ou : npm install --no-save puppeteer-core @sparticuz/chromium\n');
  await arreter();
  process.exit(0);
}

try {
  if (!(await attendreServeur())) throw new Error('le serveur de test n’a pas démarré');

  for (const taille of WIDTHS) {
    console.log(`\n${taille.nom} — ${taille.width} × ${taille.height}`);
    const page = await browser.newPage();
    const erreurs = [];
    page.on('pageerror', (error) => erreurs.push(String(error.message).slice(0, 90)));
    page.on('console', (message) => {
      if (message.type() === 'error' && !/ERR_CONNECTION_CLOSED|favicon/.test(message.text())) {
        erreurs.push(message.text().slice(0, 90));
      }
    });
    await page.setViewport({ width: taille.width, height: taille.height, isMobile: taille.mobile, deviceScaleFactor: 1 });

    for (const route of ROUTES) {
      await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2', timeout: 30000 });
      // Parcourt la page : déclenche les animations au défilement, comme le
      // ferait un visiteur. Un bloc resté invisible après cela est un défaut.
      await page.evaluate(async () => {
        // `scroll-behavior: smooth` animerait les sauts de défilement et les
        // animations d'apparition ne se déclencheraient jamais.
        document.documentElement.style.scrollBehavior = 'auto';
        const pas = Math.max(200, Math.round(window.innerHeight * 0.75));
        for (let y = 0; y < document.body.scrollHeight; y += pas) {
          window.scrollTo(0, y);
          await new Promise((resolve) => setTimeout(resolve, 110));
        }
        window.scrollTo(0, 0);
        await new Promise((resolve) => setTimeout(resolve, 250));
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      const mesure = await page.evaluate(MESURE, taille.width);
      const nom = `${taille.nom} ${route}`;
      check(
        `${nom} : aucun débordement horizontal`,
        mesure.scrollWidth <= taille.width + 1,
        `document ${mesure.scrollWidth} px, corps ${mesure.bodyScrollWidth} px, fenêtre ${mesure.fenetreInterne} px (attendu ${taille.width})`
      );
      check(`${nom} : aucun texte rogné`, mesure.rognes.length === 0, mesure.rognes.join(', '));
      check(`${nom} : contenu des animations visible`, mesure.invisibles.length === 0, mesure.invisibles.join(', '));
      check(`${nom} : images chargées`, mesure.imagesCassees === 0, `${mesure.imagesCassees} cassée(s)`);
      check(`${nom} : pictogrammes à la bonne taille`, mesure.pictogrammesGeants.length === 0, mesure.pictogrammesGeants.join(', '));
      check(`${nom} : images dimensionnées`, mesure.imagesSansDimensions === 0, `${mesure.imagesSansDimensions} sans dimensions`);
      if (CAPTURES) await page.screenshot({ path: `/tmp/dropqr-${taille.nom}-${route.replace(/\//g, '') || 'accueil'}.png` });
    }

    // La bascule de thème doit réellement changer de thème, et se retenir.
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    const avant = await page.evaluate(() => document.documentElement.dataset.theme || 'auto');
    await page.click('#themeToggle');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const apres = await page.evaluate(() => document.documentElement.dataset.theme || 'auto');
    check(`${taille.nom} : bascule de thème fonctionnelle`, avant !== apres, `${avant} → ${apres}`);

    check(`${taille.nom} : aucune erreur JavaScript`, erreurs.length === 0, [...new Set(erreurs)].join(' | '));
    await page.close();
  }
} finally {
  await browser.close();
  await arreter();
}

console.log(`\n${checks - failures}/${checks} vérifications réussies.`);
if (failures) {
  console.error(`${failures} problème(s) de mise en page.`);
  process.exit(1);
}
console.log('Mise en page conforme.\n');
