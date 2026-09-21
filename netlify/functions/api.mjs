'use strict';

/**
 * Fonction Netlify : toute la partie dynamique du site (API + pages rendues).
 *
 * Les fichiers envoyés par les visiteurs ne passent PAS par cette fonction :
 * le navigateur les envoie directement dans le stockage objet avec des URL
 * pré-signées. C'est indispensable, car Netlify limite chaque requête de
 * fonction à 6 Mo.
 *
 * `preferStatic: true` laisse les fichiers réels de /assets et /img être servis
 * par le CDN, et non par la fonction.
 */

import { createApp } from '../../lib/app.mjs';

const app = createApp();

export default async function handler(request, context) {
  return app.handleRequest(request, context);
}

export const config = {
  path: [
    '/',
    '/index.html',
    '/api/*',
    '/asset/*',
    '/download/*',
    '/view/*',
    '/r/*',
    '/t/*',
    '/share/*',
    '/c/*',
    '/code/*',
    '/upload',
    '/receive',
    '/dashboard',
    '/help',
    '/offline',
    '/api-not-available.html'
  ],
  preferStatic: true
};
