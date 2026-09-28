// The JAS server process for fog chess: a small JSON API over games.js. JAS
// calls the default export once at startup with a Router scoped to this app.
//
//   POST /fog-chess/api/games                 { color, difficulty } → view
//   GET  /fog-chess/api/games/:id             → view
//   GET  /fog-chess/api/games/:id?wait=1      → view, once the AI has moved
//   POST /fog-chess/api/games/:id/move        { key } → view (AI reply starts)
//   GET  /fog-chess/api/games/:id/belief      → where the enemy might be

import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { setCacheDir } from '../../vendor/obscuro-chess/src/index.js';
import { GameStore } from './games.js';

// The Stockfish evaluation cache is derived data that grows to tens of MB. Keep
// it at the repo root, out of the app folder JAS serves statically and out of
// the obscuro-chess submodule's checkout.
const cacheDir = fileURLToPath(new URL('../../.cache/', import.meta.url));
mkdirSync(cacheDir, { recursive: true });
setCacheDir(cacheDir);

const store = new GameStore();

const handle = fn => async (req, res) => {
  try {
    res.json(await fn(req));
  } catch (error) {
    res.status(error.status ?? 400).json({ error: error.message });
  }
};

export default (router, app) => {
  const base = '/' + app.id + '/api/games';

  router.post(base, handle(req => {
    const { color = 'white', difficulty } = req.body ?? {};
    return store.create({ humanColor: color, difficulty }).view();
  }));

  router.get(base + '/:id', handle(req => {
    const game = store.get(req.params.id);
    return req.query.wait ? game.waitForAi() : game.view();
  }));

  router.post(base + '/:id/move', handle(req => store.get(req.params.id).playHuman(String(req.body?.key ?? ''))));

  router.get(base + '/:id/belief', handle(req => store.get(req.params.id).belief()));
};
