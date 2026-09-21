'use strict';

/**
 * Tâche planifiée : supprime les transferts expirés, les envois abandonnés et
 * les messages Discord arrivés à échéance, même si personne ne visite le site.
 */

import { createApp } from '../../lib/app.mjs';

const app = createApp();

export default async function handler() {
  const result = await app.purgeNow();
  console.log('[dropqr] purge planifiée', JSON.stringify(result));
  return new Response(JSON.stringify({ ok: true, ...result }), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

export const config = {
  schedule: '*/15 * * * *'
};
