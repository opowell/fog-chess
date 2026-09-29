// Finished games, kept in this browser's IndexedDB. Each is the game's last
// view from the server (the true board at every ply, what you saw of it, and
// every move's key), so an old game can be stepped through with no server at
// all, and replayed on one for analysis (see GameStore.review in games.js).
//
// Every call resolves quietly to nothing when IndexedDB is unavailable (a
// private window, blocked site data): the archive is a convenience, never
// something a game depends on.

const DB = 'fog-chess';
const STORE = 'games';

let opening = null;
function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(error => { opening = null; throw error; });
  return opening;
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

const quietly = async (fallback, fn) => { try { return await fn(); } catch { return fallback; } };

// Keep a finished game. Saving the same game again (a reload that finds it
// still over on the server) keeps the first save's time.
export const saveGame = view => quietly(null, async () => {
  const known = await run('readonly', s => s.get(view.id));
  const { id, humanColor, aiColor, strength, result, moves, keys, history } = view;
  const record = { id, endedAt: known?.endedAt ?? Date.now(), humanColor, aiColor, strength, result, moves, keys, history };
  await run('readwrite', s => s.put(record));
  return record;
});

// Newest first, without the boards: enough for a list.
export const listGames = () => quietly([], async () => {
  const all = await run('readonly', s => s.getAll());
  return all
    .map(({ id, endedAt, humanColor, strength, result, moves }) => ({ id, endedAt, humanColor, strength, result, plies: moves.length }))
    .sort((a, b) => b.endedAt - a.endedAt);
});

export const loadGame = id => quietly(null, () => run('readonly', s => s.get(id)));

export const deleteGame = id => quietly(null, () => run('readwrite', s => s.delete(id)));
