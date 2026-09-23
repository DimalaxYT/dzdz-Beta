'use strict';

// Historique local des transferts créés par CE navigateur.
// Les clés de suppression n'existent que dans ce stockage localStorage: elles ne
// quittent jamais le navigateur, mais elles sont nécessaires pour supprimer un
// transfert manuellement depuis le tableau de bord.
window.DropQRStore = (() => {
  const STORAGE_KEY = 'dropqr.transfers';
  const MAX_ENTRIES = 50;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((entry) => entry && entry.id) : [];
    } catch (_error) {
      return [];
    }
  }

  function persist(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
    } catch (_error) {}
  }

  function remember(payload) {
    if (!payload || !payload.id || !payload.deleteKey) return;
    const entries = load().filter((entry) => entry.id !== payload.id);
    entries.unshift({
      id: payload.id,
      code: payload.code || null,
      deleteKey: payload.deleteKey,
      fileName: payload.fileName || 'fichier',
      sizeHuman: payload.sizeHuman || '',
      shareUrl: payload.shareUrl || '',
      deleteAfterDownload: payload.deleteAfterDownload !== false,
      createdAt: payload.createdAt || new Date().toISOString(),
      expiresAt: payload.expiresAt || null
    });
    persist(entries);
  }

  function remove(id) {
    persist(load().filter((entry) => entry.id !== id));
  }

  function saveAll(entries) {
    persist(Array.isArray(entries) ? entries.filter((entry) => entry && entry.id) : []);
  }

  function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_error) {}
  }

  return { load, remember, remove, saveAll, clear };
})();
