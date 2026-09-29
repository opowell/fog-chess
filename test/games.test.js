// Power 0 makes the Obscuro agent play uniformly at random, which keeps a
// full game to well under a second: these tests are about what the human is
// shown, not about how well the AI plays.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { Game, GameStore } from '../apps/fog-chess/games.js';
import { FogChess, quit } from '../vendor/obscuro-chess/src/index.js';

after(() => quit());

const pick = list => list[Math.floor(Math.random() * list.length)];

// Every enemy piece the human is shown must stand on a square they can see.
function assertNoLeak(view) {
  if (view.revealed) return;
  const visible = new Set(view.visible);
  for (const [sq, piece] of Object.entries(view.board)) {
    if (piece.color !== view.humanColor) assert.ok(visible.has(sq), `enemy ${piece.type} leaked on ${sq}`);
  }
}

async function playOut(game, maxPlies = 400) {
  let view = await game.waitForAi();
  for (let ply = 0; ply < maxPlies && !view.result; ply++) {
    assertNoLeak(view);
    assert.equal(view.toMove, view.humanColor);
    assert.ok(view.legal.length > 0);
    view = game.playHuman(pick(view.legal).key);
    assertNoLeak(view);
    view = await game.waitForAi();
  }
  return view;
}

test('a whole game never shows the human an enemy piece they cannot see, then reveals the board', async () => {
  const store = new GameStore();
  for (const color of ['white', 'black']) {
    const game = store.create({ humanColor: color, power: 0 });
    const view = await playOut(game);
    if (!view.result) continue; // hit the ply cap without a result; the fog checks still ran
    assert.equal(view.revealed, true);
    assert.equal(view.legal.length, 0);
    const kings = Object.values(view.board).filter(p => p.type === 'king');
    if (view.result.reason === 'king-captured') assert.equal(kings.length, 1);
  }
});

test('the AI opens when the human plays black, and its move stays hidden', async () => {
  const game = new GameStore().create({ humanColor: 'black', power: 0 });
  const view = await game.waitForAi();
  assert.equal(view.toMove, 'black');
  assert.deepEqual(view.moves, [{ color: 'white', text: null }]);
  assertNoLeak(view);
});

test('moves out of turn and illegal moves are refused', async () => {
  const game = new GameStore().create({ humanColor: 'white', power: 0 });
  assert.throws(() => game.playHuman('e2e5'), /illegal move/);
  game.playHuman('e2e4');
  assert.throws(() => game.playHuman('d2d4'), /not your turn/);
  const view = await game.waitForAi();
  assert.equal(view.moves[0].text, 'e2–e4');
});

test('at the start the belief is certain: every enemy piece is on its home square', () => {
  const game = new GameStore().create({ humanColor: 'white', power: 0 });
  const belief = game.belief();
  assert.equal(belief.exact, true);
  assert.equal(belief.positions, 1);
  const squares = Object.keys(belief.squares).sort();
  assert.deepEqual(squares, [...'abcdefgh'].flatMap(f => [f + '7', f + '8']).sort());
  assert.ok(Object.values(belief.squares).every(c => Math.abs(c.p - 1) < 1e-9));
  assert.equal(belief.squares.e8.type, 'k');
});

test('belief stays a distribution as the game goes on, and games do not share one', async () => {
  const store = new GameStore();
  const game = store.create({ humanColor: 'white', power: 0 });
  let view = game.view();
  for (let i = 0; i < 4 && !view.result; i++) {
    view = game.playHuman(pick(view.legal).key);
    view = await game.waitForAi();
  }
  if (!view.result) {
    const belief = game.belief();
    if (belief.exact) {
      const visible = new Set(view.visible);
      for (const [sq, cell] of Object.entries(belief.squares)) {
        assert.ok(!visible.has(sq), `belief placed a hidden piece on visible ${sq}`);
        assert.ok(cell.p > 0 && cell.p <= 1);
      }
      // Sixteen enemy pieces at most, spread over the squares.
      const mass = Object.values(belief.squares).reduce((s, c) => s + c.p, 0);
      assert.ok(mass <= 16 + 1e-6, `expected at most 16 pieces of mass, got ${mass}`);
    }
  }
  // A game created afterwards starts from its own, certain belief.
  const fresh = store.create({ humanColor: 'white', power: 0 });
  assert.equal(fresh.belief().positions, 1);
});

test('resigning ends the game as a loss, even while the AI is thinking, and reveals the board', async () => {
  const game = new GameStore().create({ humanColor: 'black', power: 0 });
  const view = game.resign();
  assert.deepEqual(view.result, { outcome: 'win', winnerId: 'white', reason: 'resigned' });
  assert.equal(view.revealed, true);
  assert.equal(view.thinking, false);
  assert.equal(view.legal.length, 0);
  assert.equal(Object.keys(view.board).length, 32);
  const after = await game.waitForAi();
  assert.deepEqual(after.moves, [], 'the AI move in flight is dropped');
  assert.throws(() => game.resign(), /game is over/);
  assert.throws(() => game.playHuman('e7e5'), /game is over/);
});

test('power fixes the amount of search and turns the clock off; time sets a clock', () => {
  const store = new GameStore();
  const power = store.create({ humanColor: 'white', mode: 'power', power: 60 });
  assert.deepEqual(power.view().strength, { mode: 'power', power: 60 });
  assert.equal(power.state.gameSpecific.difficulty, 60);
  assert.equal(power.state.gameSpecific.aiTimeMs, null);
  assert.equal(power.state.gameSpecific.obscuro.timeBudgetMs, 0);

  const time = store.create({ humanColor: 'white', mode: 'time', timeMs: 1500 });
  assert.deepEqual(time.view().strength, { mode: 'time', timeMs: 1500 });
  assert.equal(time.state.gameSpecific.aiTimeMs, 1500);
  assert.equal(time.state.gameSpecific.difficulty, null);
  assert.equal(time.state.gameSpecific.obscuro, undefined);

  assert.deepEqual(store.create({ humanColor: 'white' }).view().strength, { mode: 'power', power: 25 });
  assert.throws(() => store.create({ mode: 'power', power: -1 }), /power must be/);
  assert.throws(() => store.create({ mode: 'time', timeMs: -1 }), /timeMs must be/);
  assert.throws(() => store.create({ mode: 'depth' }), /mode must be/);
});

test('power has no top: past 100 every search knob keeps growing', () => {
  const store = new GameStore();
  const at100 = store.create({ humanColor: 'white', power: 100 });
  assert.deepEqual(at100.state.gameSpecific.obscuro, { timeBudgetMs: 0 }, 'up to 100 the engine dial decides');
  const at200 = store.create({ humanColor: 'white', power: 200 });
  const at300 = store.create({ humanColor: 'white', power: 300 });
  assert.equal(at200.state.gameSpecific.difficulty, 100);
  const knobs = ['particles', 'maxRounds', 'maxInfosets', 'expandPerRound', 'cfrPerRound', 'finalCfr'];
  for (const knob of knobs) {
    assert.ok(at300.state.gameSpecific.obscuro[knob] > at200.state.gameSpecific.obscuro[knob], knob);
  }
  assert.ok(at300.agent.opts.sfDepth > at200.agent.opts.sfDepth);
  assert.equal(at200.state.gameSpecific.obscuro.timeBudgetMs, 0);
});

test('analysis ranks the human\'s own legal moves, and a move stops it', async () => {
  const game = new GameStore().create({ humanColor: 'white', power: 0 });
  const legal = new Set(game.view().legal.map(m => m.key));
  let firstRanking;
  const ranked = new Promise(resolve => { firstRanking = resolve; });
  const run = game.analyze({ onProgress: frame => { if (frame.candidates) firstRanking(frame); } });
  const frame = await ranked;
  assert.ok(frame.candidates.length > 0);
  for (const c of frame.candidates) assert.ok(legal.has(c.key), `${c.key} is not a legal move`);
  assert.equal(frame.total, 1); // at the start only one board fits what white sees
  for (const world of frame.worlds.list) {
    for (const { sq } of world.hidden) assert.ok(!game.view().visible.includes(sq), `${sq} is not hidden`);
  }

  game.playHuman(frame.candidates[0].key);
  await assert.rejects(game.analyze(), /not your turn/);
  await run; // the walk notices the move and ends
  await game.waitForAi();
});

test('a pawn push onto a dark square is not offered, to play or to analyze', async () => {
  // 1. Nf3 d5 2. d4 Nf6: the square ahead of the d4 pawn is dark because the
  // d5 pawn stands on it, so d4–d5 could only fail.
  const replies = ['d7d5', 'g8f6'];
  const agent = {
    async chooseAction(_, legal) {
      const key = replies.shift();
      return legal.find(a => FogChess.actionKey(a) === key);
    },
  };
  const game = new Game({ id: 't', humanColor: 'white', agent });
  game.playHuman('g1f3');
  await game.waitForAi();
  game.playHuman('d2d4');
  const view = await game.waitForAi();
  assert.ok(!view.visible.includes('d5'));
  assert.ok(!view.legal.some(m => m.key === 'd4d5'));
  assert.ok(view.legal.some(m => m.key === 'c2c4'));
  assert.throws(() => game.playHuman('d4d5'), /illegal move/);

  let frames = 0;
  const result = await game.analyze({ onProgress: f => { if (f.candidates) frames++; }, isCancelled: () => frames >= 1 });
  assert.ok(result.candidates.length > 0);
  assert.ok(!result.candidates.some(c => c.key === 'd4d5'));
});

test('what the human\'s move reveals stays known after the AI\'s reply hides it', async () => {
  // 1.f4 e5 2.b3 Nc6 3.Bb2 Bd6 4.fxe5 Nxe5: fxe5 shows the bishop on d6, then
  // the knight takes the pawn that saw it. Only a knight moved, so it is still there.
  const replies = ['e7e5', 'b8c6', 'f8d6', 'c6e5'];
  const agentFactory = () => ({
    chooseAction: async (observation, legal) => {
      const key = replies.shift();
      return legal.find(a => FogChess.actionKey(a) === key);
    },
  });
  const game = new GameStore({ agentFactory }).create({ humanColor: 'white', power: 0 });
  let view;
  for (const key of ['f2f4', 'b2b3', 'c1b2', 'f4e5']) {
    game.playHuman(key);
    view = await game.waitForAi();
  }
  assert.equal(view.board.e5?.type, 'knight');
  assert.ok(!view.visible.includes('d6'), 'd6 is dark again');
  const { exact, squares } = game.belief();
  assert.ok(exact);
  assert.equal(squares.d6?.type, 'b');
  assert.ok(squares.d6.p > 0.999, `bishop on d6 with p ${squares.d6.p}`);
});

test('the history holds a position per ply, as the human saw it until the game ends', async () => {
  const game = new GameStore().create({ humanColor: 'white', power: 0 });
  let view = game.playHuman('e2e4');
  assert.equal(view.history.length, 2);
  assert.deepEqual(view.history[1].lastMove, { from: 'e2', to: 'e4' });
  assert.equal(view.history[1].board.e4.type, 'pawn');
  assert.equal(view.history[1].board.e2, undefined);

  view = await game.waitForAi();
  view = game.playHuman(pick(view.legal).key);
  view = await game.waitForAi();
  assert.equal(view.history.length, view.moves.length + 1);
  // The AI's moves are not marked, and no ply shows an enemy piece out of sight.
  assert.equal(view.history[2].lastMove, null);
  for (const ply of view.history) assertNoLeak({ ...ply, humanColor: view.humanColor });
  assert.deepEqual(view.history.at(-1).board, view.board);

  view = game.resign();
  assert.ok(view.history.every(ply => ply.revealed));
  assert.equal(Object.values(view.history[2].board).filter(p => p.color === 'black').length, 16);
  assert.ok(view.history[2].lastMove);
});

test('each ply of the history says what it captured, on both sides', async () => {
  // 1.e4 d5 2.exd5 Qxd5: a pawn each.
  const replies = ['d7d5', 'd8d5'];
  const agentFactory = () => ({
    chooseAction: async (_, legal) => {
      const key = replies.shift();
      return legal.find(a => FogChess.actionKey(a) === key);
    },
  });
  const game = new GameStore({ agentFactory }).create({ humanColor: 'white', power: 0 });
  game.playHuman('e2e4');
  await game.waitForAi();
  game.playHuman('e4d5');
  let view = await game.waitForAi();
  assert.deepEqual(view.history.map(ply => ply.captured), [
    [], [], [], [{ type: 'pawn', color: 'black' }], [{ type: 'pawn', color: 'white' }],
  ]);
  view = game.resign();
  assert.deepEqual(view.history[3].captured, [{ type: 'pawn', color: 'black' }]);
  assert.deepEqual(view.history[3].seen.captured, [{ type: 'pawn', color: 'black' }]);
});

test('what the AI saw goes out only once the game is over, and a replay gives the same', async () => {
  const store = new GameStore();
  const game = store.create({ humanColor: 'white', power: 0 });
  game.playHuman('e2e4');
  let view = await game.waitForAi();
  view = game.playHuman(pick(view.legal).key);
  assert.ok(view.history.every(ply => ply.aiSeen === undefined && ply.aiVisible === undefined));
  assert.ok(!JSON.stringify(view).includes('aiSeen'));
  await game.waitForAi();
  view = game.resign();
  for (const ply of view.history) assertNoLeak({ ...ply.aiSeen, humanColor: view.aiColor });
  // Black's view of the start: its own pieces, and white's hidden behind the fog.
  const start = view.history[0].aiSeen;
  assert.equal(Object.values(start.board).filter(p => p.color === 'black').length, 16);
  assert.equal(Object.values(start.board).filter(p => p.color === 'white').length, 0);
  // Only black's own moves are marked in black's view.
  assert.equal(view.history[1].aiSeen.lastMove, null);
  assert.ok(view.history[2].aiSeen.lastMove);
  const { aiSeen } = store.sight({ humanColor: 'white', keys: view.keys });
  assert.deepEqual(aiSeen, view.history.map(ply => ply.aiSeen));
});

test('the AI\'s moves and every move key stay hidden until the game ends', async () => {
  const game = new GameStore().create({ humanColor: 'white', power: 0 });
  game.playHuman('e2e4');
  let view = await game.waitForAi();
  assert.equal(view.moves[1].text, null);
  assert.equal(view.keys, undefined);
  view = game.resign();
  assert.ok(view.moves[1].text);
  assert.equal(view.keys.length, 2);
  assert.equal(view.keys[0], 'e2e4');
  assert.ok(view.history.every(ply => ply.seen && !ply.seen.revealed));
  for (const ply of view.history) assertNoLeak({ ...ply.seen, humanColor: view.humanColor });
});

test('a review replays a finished game to the human\'s belief at the time', async () => {
  const store = new GameStore();
  const game = store.create({ humanColor: 'black', power: 0 });
  let view = await game.waitForAi();
  const beliefs = [];
  for (let i = 0; i < 6 && !view.result; i++) {
    beliefs.push({ ply: view.moves.length, belief: game.belief() });
    view = game.playHuman(pick(view.legal).key);
    view = await game.waitForAi();
  }
  if (!view.result) view = game.resign();

  for (const { ply, belief } of beliefs) {
    const review = store.review({ humanColor: 'black', keys: view.keys.slice(0, ply) });
    assert.deepEqual(review.belief(), belief, `belief at ply ${ply}`);
    assert.deepEqual(review.history().at(-1).board, view.history[ply].seen.board);
    assert.equal(store.review({ humanColor: 'black', keys: view.keys.slice(0, ply) }), review, 'the same position is the same game');
  }
  const review = store.review({ humanColor: 'black', keys: view.keys.slice(0, beliefs[0].ply) });
  assert.throws(() => review.playHuman(review.view().legal[0].key), /reviewed/);
  assert.equal(review.agent, null);
  assert.throws(() => store.review({ humanColor: 'black', keys: ['e2e5'] }), /illegal move for white/);
  assert.throws(() => store.review({ humanColor: 'green', keys: [] }), /humanColor/);
});
