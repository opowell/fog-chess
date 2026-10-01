// The move list's exports: a finished game's PGN must read back, through
// obscuro-chess's own PGN reader, as the very moves that were played, and its
// UCI as the same squares.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { GameStore } from '../apps/fog-chess/games.js';
import { toPgn, toUci, toText, san } from '../apps/fog-chess/notation.js';
import { FogChess, pgnToSessions, quit } from '../vendor/obscuro-chess/src/index.js';

after(() => quit());

const pick = list => list[Math.floor(Math.random() * list.length)];

async function finished(humanColor) {
  const game = new GameStore().create({ humanColor, power: 0 });
  let view = await game.waitForAi();
  for (let ply = 0; ply < 400 && !view.result; ply++) {
    view = game.playHuman(pick(view.legal).key);
    view = await game.waitForAi();
  }
  return view;
}

const exportOf = view => ({
  plies: view.history, moves: view.moves, humanColor: view.humanColor, endedAt: Date.now(), result: view.result,
});

test('a finished game\'s PGN replays as the moves played, and its UCI names the same squares', async () => {
  for (const color of ['white', 'black']) {
    const view = await finished(color);
    const game = exportOf(view);
    const rejects = [];
    const [session] = [...pgnToSessions(toPgn(game), {}, rejects)];
    assert.deepEqual(rejects, []);
    assert.equal(session.skipped, 0);
    const keys = session.sess.log.map(entry => FogChess.actionKey(entry.playerActions[0].action));
    assert.deepEqual(keys, view.keys);

    const uci = toUci(game).trim().split(' ');
    assert.equal(uci.length, view.keys.length);
    uci.forEach((move, i) => assert.equal(move.slice(0, 4), view.keys[i].slice(0, 4)));

    assert.equal(toText(game).trim().split('\n').length, Math.ceil(view.moves.length / 2));
  }
});

test('SAN names the piece only as far as another of its kind could also go there', () => {
  const N = color => ({ type: 'knight', color });
  const R = color => ({ type: 'rook', color });
  assert.equal(san({ b1: N('white'), f3: N('white') }, {}, 'b1', 'd2'), 'Nbd2');
  assert.equal(san({ a1: R('white'), a5: R('white') }, {}, 'a1', 'a3'), 'R1a3');
  assert.equal(san({ a1: R('white'), a3: { type: 'pawn', color: 'white' }, a5: R('white') }, {}, 'a1', 'a2'), 'Ra2');
  assert.equal(san({ e5: { type: 'pawn', color: 'white' }, d5: { type: 'pawn', color: 'black' } }, {}, 'e5', 'd6'), 'exd6');
  assert.equal(san({ e7: { type: 'pawn', color: 'white' } }, { e8: N('white') }, 'e7', 'e8'), 'e8=N');
  assert.equal(san({ e1: { type: 'king', color: 'white' } }, {}, 'e1', 'c1'), 'O-O-O');
});
