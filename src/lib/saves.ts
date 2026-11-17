// Saved games, kept in the browser's IndexedDB (they hold typed arrays and run to hundreds of
// kilobytes, too much for localStorage). Every call is guarded: with no IndexedDB, or a failing one,
// saving is silently off and loading finds nothing.

const DB_NAME = 'atlas-globe';
const STORE = 'games';

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null);
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(
  mode: IDBTransactionMode,
  act: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) return resolve(null);
        try {
          const request = act(db.transaction(STORE, mode).objectStore(STORE));
          request.onsuccess = () => {
            resolve(request.result);
            db.close();
          };
          request.onerror = () => {
            resolve(null);
            db.close();
          };
        } catch {
          resolve(null);
          db.close();
        }
      }),
  );
}

/** Store a saved game under a key (a place id). Resolves to whether it was stored. */
export async function putSave(key: string, data: unknown): Promise<boolean> {
  const result = await run('readwrite', (store) => store.put(data, key));
  return result !== null;
}

/** The saved game under a key, or null if there is none (or no storage). */
export async function getSave(key: string): Promise<unknown> {
  const result = await run<unknown>('readonly', (store) => store.get(key));
  return result ?? null;
}

export async function deleteSave(key: string): Promise<void> {
  await run('readwrite', (store) => store.delete(key));
}
