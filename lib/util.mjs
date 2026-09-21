'use strict';

/** Petits utilitaires partagés (aucune dépendance). */

import crypto from 'node:crypto';

export function now() {
  return Date.now();
}

export function makeId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Alphabet sans caractères ambigus (pas de I, L, O, 0, 1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Génère un code de transfert. Chaque caractère vient d'un tirage
 * cryptographiquement sûr indépendant (pas de modulo biaisé, pas de doublon
 * d'index comme dans la version précédente).
 */
export function makeTransferCode(length = 7) {
  let code = '';
  for (let index = 0; index < length; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

export function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 24);
}

const UNITS = ['o', 'Ko', 'Mo', 'Go', 'To'];

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 o';
  if (value < 1024) return `${value} o`;
  let size = value / 1024;
  let unit = UNITS[1];
  for (let index = 1; index < UNITS.length; index += 1) {
    unit = UNITS[index];
    if (size < 1024 || index === UNITS.length - 1) break;
    size /= 1024;
  }
  return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const DANGEROUS_EXTENSIONS = new Set([
  '.html', '.htm', '.xhtml', '.svg', '.js', '.mjs', '.cjs', '.xml', '.swf', '.hta', '.vbs'
]);

export function extensionOf(name) {
  const match = String(name || '').match(/\.[a-zA-Z0-9]{1,12}$/);
  return match ? match[0].toLowerCase() : '';
}

export function isDangerousExtension(name) {
  return DANGEROUS_EXTENSIONS.has(extensionOf(name));
}

/** Nom de fichier nettoyé, sûr à réafficher et à mettre dans un en-tête. */
export function cleanOriginalName(name) {
  const raw = String(name || 'fichier').split(/[\\/]/).pop() || 'fichier';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180);
  return cleaned || 'fichier';
}

/** Nom lisible (sans extension technique) comme libellé de titre. */
export function humanLabel(name) {
  const base = cleanOriginalName(name).replace(/\.[a-zA-Z0-9]{1,12}$/, '');
  return base.replace(/[_-]+/g, ' ').trim() || cleanOriginalName(name);
}

export function safeStoredExtension(name) {
  const ext = extensionOf(name).replace(/[^a-z0-9.]/g, '');
  return ext && ext.length <= 12 ? ext : '';
}

export function parseTtlMinutes(value, { defaultMinutes, maxMinutes }) {
  const raw = Number(value);
  const ttl = Number.isFinite(raw) && raw > 0 ? raw : defaultMinutes;
  return Math.min(Math.max(1, Math.round(ttl)), maxMinutes);
}

export function secondsBetween(from, to) {
  return Math.max(0, Math.floor((to - from) / 1000));
}

/** Empêche l'écriture de plusieurs fois la même opération en parallèle. */
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
