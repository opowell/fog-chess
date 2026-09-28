// Difficulty 0 makes the Obscuro agent play uniformly at random, which keeps a
// full game to well under a second: these tests are about what the human is
// shown, not about how well the AI plays.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { GameStore } from '../apps/fog-chess/games.js';
import { quit } from '../vendor/obscuro-chess/src/index.js';

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
    const game = store.create({ humanColor: color, difficulty: 0 });
    const view = await playOut(game);
    if (!view.result) continue; // hit the ply cap without a result; the fog checks still ran
    assert.equal(view.revealed, true);
    assert.equal(view.legal.length, 0);
    const kings = Object.values(view.board).filter(p => p.type === 'king');
    if (view.result.reason === 'king-captured') assert.equal(kings.length, 1);
  }
});

test('the AI opens when the human plays black, and its move stays hidden', async () => {
  const game = new GameStore().create({ humanColor: 'black', difficulty: 0 });
  const view = await game.waitForAi();
  assert.equal(view.toMove, 'black');
  assert.deepEqual(view.moves, [{ color: 'white', text: null }]);
  assertNoLeak(view);
});

test('moves out of turn and illegal moves are refused', async () => {
  const game = new GameStore().create({ humanColor: 'white', difficulty: 0 });
  assert.throws(() => game.playHuman('e2e5'), /illegal move/);
  game.playHuman('e2e4');
  assert.throws(() => game.playHuman('d2d4'), /not your turn/);
  const view = await game.waitForAi();
  assert.equal(view.moves[0].text, 'e2–e4');
});

test('at the start the belief is certain: every enemy piece is on its home square', () => {
  const game = new GameStore().create({ humanColor: 'white', difficulty: 0 });
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
  const game = store.create({ humanColor: 'white', difficulty: 0 });
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
  const fresh = store.create({ humanColor: 'white', difficulty: 0 });
  assert.equal(fresh.belief().positions, 1);
});
