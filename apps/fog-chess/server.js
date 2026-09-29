// The JAS server process for fog chess: a small JSON API over games.js. JAS
// calls the default export once at startup with a Router scoped to this app.
//
//   POST /fog-chess/api/games                 { color, mode, power | timeMs } → view
//   GET  /fog-chess/api/games/:id             → view
//   GET  /fog-chess/api/games/:id?wait=1      → view, once the AI has moved
//   POST /fog-chess/api/games/:id/move        { key } → view (AI reply starts)
//   POST /fog-chess/api/games/:id/resign      → view, game over
//   GET  /fog-chess/api/games/:id/belief      → where the enemy might be
//   GET  /fog-chess/api/games/:id/analysis    → event stream: the AI's ranking
//                                              of your moves, as it refines
//   POST /fog-chess/api/reviews               { humanColor, keys } → { id }: a
//                                              finished game replayed that far,
//                                              for the belief and analysis above

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
    const { color = 'white', mode, power, timeMs } = req.body ?? {};
    return store.create({ humanColor: color, mode, power, timeMs }).view();
  }));

  router.get(base + '/:id', handle(req => {
    const game = store.get(req.params.id);
    return req.query.wait ? game.waitForAi() : game.view();
  }));

  router.post(base + '/:id/move', handle(req => store.get(req.params.id).playHuman(String(req.body?.key ?? ''))));

  router.post(base + '/:id/resign', handle(req => store.get(req.params.id).resign()));

  router.post('/' + app.id + '/api/reviews', handle(req => {
    const { humanColor, keys } = req.body ?? {};
    return { id: store.review({ humanColor, keys }).id };
  }));

  router.get(base + '/:id/belief', handle(req => store.get(req.params.id).belief()));

  // Server-sent events, one `data:` frame per step of the walk and a last one
  // with `done: true`. The walk runs until it has settled, the page hangs up
  // (Pause, a move, leaving) or the human moves.
  router.get(base + '/:id/analysis', async (req, res) => {
    let game;
    try { game = store.get(req.params.id); } catch (error) {
      return res.status(error.status ?? 400).json({ error: error.message });
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    let closed = false;
    res.on('close', () => { closed = true; });
    const send = data => { if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`); };
    try {
      const result = await game.analyze({ onProgress: frame => send({ ...frame, done: false }), isCancelled: () => closed });
      send({ ...result, done: true });
    } catch (error) {
      send({ error: error.message, done: true });
    }
    if (!closed) res.end();
  });
};
