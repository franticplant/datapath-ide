// Workspace persistence: debounced IndexedDB snapshots plus a synchronous localStorage mirror for small workspaces.
const DB_NAME = 'datapath-studio';
const STORE = 'workspace';
const RECORD_KEY = 'current';

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return; }
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open IndexedDB'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked'));
  });
}

function transact(db, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

export function createWorkspaceStorage({ mirrorKey = 'datapath.workspace.v1', debounceMs = 250, mirrorLimit = 1024 * 1024, onError = null } = {}) {
  let dbPromise = null;
  let timer = null;
  let pending = null;       // latest snapshot waiting for IndexedDB
  let writing = Promise.resolve();
  const db = () => (dbPromise ||= openDb());

  // Synchronous restore from the localStorage mirror (null when absent or invalid).
  function loadMirror() {
    const text = localStorage.getItem(mirrorKey);
    if (!text) return null;
    const snapshot = JSON.parse(text);
    return snapshot && typeof snapshot === 'object' ? snapshot : null;
  }

  async function loadDurable() {
    try {
      const record = await transact(await db(), 'readonly', store => store.get(RECORD_KEY));
      return record && typeof record === 'object' && record.snapshot ? record.snapshot : null;
    } catch (error) {
      onError?.(error);
      return null;
    }
  }

  // Writes the mirror now (when small enough) and queues the durable copy. Returns { mirrored, size }.
  function save(snapshot) {
    const stamped = { ...snapshot, savedAt: Date.now() };
    const text = JSON.stringify(stamped);
    let mirrored = false;
    if (text.length < mirrorLimit) {
      try { localStorage.setItem(mirrorKey, text); mirrored = true; } catch { /* Quota: fall back to IndexedDB only. */ }
    }
    if (!mirrored) {
      // A stale small mirror must not shadow the newer durable snapshot on the next load.
      try { localStorage.removeItem(mirrorKey); } catch { /* Ignore storage failures. */ }
    }
    pending = stamped;
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    return { mirrored, size: text.length };
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    if (!pending) return writing;
    const snapshot = pending;
    pending = null;
    writing = writing
      .then(async () => transact(await db(), 'readwrite', store => store.put({ savedAt: snapshot.savedAt, snapshot }, RECORD_KEY)))
      .catch(error => { onError?.(error); });
    return writing;
  }

  const flushOnHide = () => { if (document.visibilityState === 'hidden') flush(); };
  addEventListener('beforeunload', flush);
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', flushOnHide);

  return { loadMirror, loadDurable, save, flush, hasPending: () => pending !== null };
}
