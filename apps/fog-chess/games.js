// ---------------------------------------------------------------------------
// The games this server is hosting: one human against the Obscuro AI, each.
//
// Everything that knows about fog chess comes from obscuro-chess (vendored at
// vendor/obscuro-chess): the rules and observation model (FogChess) and the
// agent. This module only keeps the TRUE state of every game and decides what
// the human may be told about it. That is the whole security model of the app:
// the browser is handed the human's observation (FogChess.getVisibleState) and
// nothing else until the game is over, so there is nothing to peek at in the
// network tab.
//
// Two things here are easy to get wrong:
//   • Belief trackers are keyed by the identity of `state.players` (see
//     getExactBelief in obscuro-chess), so every game must get its OWN players
//     array — sharing one would pour two games into one belief.
//   • The human's belief (what the "possible enemies" overlay reads) is only
//     exact if it is fed on every one of the human's turns from the first, and
//     told about every human move. The AI does that for its own seat inside
//     chooseAction; for the human seat nobody does unless we do, which is what
//     beginHumanTurn / onActionCommitted below are for.
// ---------------------------------------------------------------------------

import { FogChess, ChessObscuroAgent } from '../../vendor/obscuro-chess/src/index.js';

export const COLORS = ['white', 'black'];
const other = color => (color === 'white' ? 'black' : 'white');

export const DEFAULT_DIFFICULTY = 25;
const MAX_GAMES = 50;

const LETTER = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };

// Coordinate notation for a move the human made: enough to read back a game,
// without pretending to SAN (which needs disambiguation against pieces the
// mover may not even be able to see).
function describeMove(action, piece, failed) {
  if (action.type === 'castle') return action.side === 'kingside' ? 'O-O' : 'O-O-O';
  const promo = action.payload?.promote ? '=' + LETTER[action.payload.promote] : '';
  const text = LETTER[piece?.type] + action.from + (action.isCapture ? '×' : '–') + action.to + promo;
  return failed ? text + ' (blocked)' : text;
}

function boardFor(board) {
  const out = {};
  for (const [sq, piece] of Object.entries(board)) {
    if (piece) out[sq] = { type: piece.type, color: piece.ownerId };
  }
  return out;
}

function piecesOf(board, color) {
  const out = new Map();
  for (const piece of Object.values(board)) {
    if (piece && piece.ownerId === color) out.set(piece.id, piece);
  }
  return out;
}

// One AI search at a time, across every game. The Stockfish backend is a single
// engine per process, and a local server with more than one game in flight is
// the exception; queueing is simpler than proving the engine re-entrant.
let aiQueue = Promise.resolve();
const serialize = fn => {
  const run = aiQueue.then(fn, fn);
  aiQueue = run.catch(() => {});
  return run;
};

export class Game {
  constructor({ id, humanColor = 'white', difficulty = DEFAULT_DIFFICULTY, agent } = {}) {
    if (!COLORS.includes(humanColor)) throw new Error('humanColor must be white or black');
    const level = Math.round(Number(difficulty));
    if (!(level >= 0 && level <= 100)) throw new Error('difficulty must be 0–100');
    this.id = id;
    this.humanColor = humanColor;
    this.aiColor = other(humanColor);
    this.difficulty = level;
    this.agent = agent ?? new ChessObscuroAgent();
    this.touchedAt = Date.now();
    // A fresh players array per game: belief trackers key on its identity.
    const players = [{ id: 'white', name: 'White' }, { id: 'black', name: 'Black' }];
    this.state = FogChess.createInitialState(players, { fogOfWar: true, difficulty: level });
    this.moves = [];           // [{ color, text }] — AI moves are recorded as hidden (text null)
    this.events = [];          // what the human learned since their last move
    this.lastHumanMove = null; // { from, to, failed } for highlighting
    this.pending = null;       // the AI's move in flight, if any
    this.error = null;
    this._humanTurnSeen = null;
    this.beginHumanTurn();
  }

  get toMove() { return this.state.activePlayers[0]; }
  get result() { return FogChess.getResult(this.state); }

  // What the human is entitled to see right now.
  observation() {
    return FogChess.getVisibleState(this.state, this.humanColor);
  }

  legalActions() {
    if (this.result || this.toMove !== this.humanColor) return [];
    return FogChess.getLegalActions(this.observation(), this.humanColor);
  }

  // Keep the human's exact belief current. Idempotent per turn, so it is safe
  // to call from anywhere a human turn may have started.
  beginHumanTurn() {
    if (this.result || this.toMove !== this.humanColor) return;
    if (this._humanTurnSeen === this.state.turnNumber) return;
    this._humanTurnSeen = this.state.turnNumber;
    FogChess.beliefPopulation(this.observation(), this.humanColor);
  }

  // Apply the human's move, named by FogChess.actionKey. Returns the view, and
  // starts the AI's reply without waiting for it — see waitForAi.
  playHuman(key) {
    this.touchedAt = Date.now();
    if (this.result) throw Object.assign(new Error('the game is over'), { status: 409 });
    if (this.toMove !== this.humanColor) throw Object.assign(new Error('it is not your turn'), { status: 409 });
    const observation = this.observation();
    const action = FogChess.getLegalActions(observation, this.humanColor)
      .find(a => FogChess.actionKey(a) === key);
    if (!action) throw Object.assign(new Error('illegal move: ' + key), { status: 400 });

    this.beginHumanTurn();
    FogChess.onActionCommitted(observation, this.humanColor, action);
    const piece = this.state.board[action.from];
    const enemiesBefore = piecesOf(this.state.board, this.aiColor);
    this.state = FogChess.applyActions(this.state, [{ playerId: this.humanColor, action }]);
    // A pawn push into a hidden piece fails: the pawn stays, and the turn is spent.
    const failed = action.type !== 'castle' && this.state.board[action.from]?.id === piece.id;
    this.moves.push({ color: this.humanColor, text: describeMove(action, piece, failed) });
    this.lastHumanMove = { from: action.from, to: failed ? action.from : action.to, failed };
    this.events = [];
    if (failed) this.events.push({ kind: 'blocked', square: action.to });
    const enemiesAfter = piecesOf(this.state.board, this.aiColor);
    for (const [id, enemy] of enemiesBefore) {
      if (!enemiesAfter.has(id)) this.events.push({ kind: 'took', square: enemy.position, type: enemy.type });
    }
    this.startAi();
    return this.view();
  }

  // Kick off the AI's move if it is the AI's turn and none is running.
  startAi() {
    if (this.pending || this.result || this.toMove !== this.aiColor) return this.pending;
    this.error = null;
    this.pending = serialize(() => this._aiMove())
      .catch(error => { this.error = String(error?.message ?? error); })
      .finally(() => { this.pending = null; });
    return this.pending;
  }

  async _aiMove() {
    const observation = FogChess.getVisibleState(this.state, this.aiColor);
    const legal = FogChess.getLegalActions(observation, this.aiColor);
    const action = await this.agent.chooseAction(observation, legal);
    if (!action) throw new Error('the AI found no move');

    const before = piecesOf(this.state.board, this.humanColor);
    this.state = FogChess.applyActions(this.state, [{ playerId: this.aiColor, action }]);
    const after = piecesOf(this.state.board, this.humanColor);

    // The only thing the AI's move tells the human directly: which of their
    // pieces vanished. Where the enemy went is exactly what fog hides.
    for (const [id, piece] of before) {
      if (!after.has(id)) this.events.push({ kind: 'captured', square: piece.position, type: piece.type });
    }
    this.moves.push({ color: this.aiColor, text: null });
    this.beginHumanTurn();
  }

  async waitForAi() {
    this.startAi();
    if (this.pending) await this.pending;
    return this.view();
  }

  // The human's view of the game. After the game ends, the true board.
  view() {
    const result = this.result;
    const observation = this.observation();
    return {
      id: this.id,
      humanColor: this.humanColor,
      aiColor: this.aiColor,
      difficulty: this.difficulty,
      turn: this.state.turnNumber,
      toMove: result ? null : this.toMove,
      thinking: !result && this.toMove === this.aiColor && !this.error,
      result,
      revealed: !!result,
      board: boardFor(result ? this.state.board : observation.board),
      visible: observation.visibleSquares,
      legal: this.legalActions().map(a => ({
        key: FogChess.actionKey(a),
        from: a.from,
        to: a.to,
        promote: a.payload?.promote ?? null,
        castle: a.type === 'castle' ? a.side : null,
      })),
      lastMove: this.lastHumanMove,
      events: this.events,
      moves: this.moves,
      error: this.error,
    };
  }

  // Where the enemy might be: for every square the human cannot see, the
  // probability that an enemy piece stands on it, and the likeliest type — the
  // marginals of the human's exact belief P. `exact: false` once P is lost (the
  // tracker gives up past a size/time cap rather than guess).
  belief() {
    if (this.result || this.toMove !== this.humanColor) return { exact: false, positions: null, squares: {} };
    const observation = this.observation();
    const population = FogChess.beliefPopulation(observation, this.humanColor);
    if (!population.exact || !population.total) return { exact: false, positions: null, squares: {} };
    const ranked = FogChess.rankBeliefWorlds(observation, this.humanColor, 1);
    const indices = Array.from({ length: population.total }, (_, i) => i);
    const worlds = FogChess.enumerateWorlds(observation, this.humanColor, indices);
    const squares = {};
    worlds.forEach((world, i) => {
      const weight = ranked?.probs?.[i] ?? world.beliefWeight ?? 1 / worlds.length;
      for (const { sq, type } of FogChess.hiddenPiecesOf(world, observation, this.humanColor)) {
        const cell = (squares[sq] ??= { p: 0, types: {} });
        cell.p += weight;
        cell.types[type] = (cell.types[type] ?? 0) + weight;
      }
    });
    for (const cell of Object.values(squares)) {
      cell.type = Object.entries(cell.types).sort((a, b) => b[1] - a[1])[0][0];
      cell.p = Math.min(1, cell.p);
      delete cell.types;
    }
    return { exact: true, positions: population.total, squares };
  }
}

export class GameStore {
  constructor({ agentFactory } = {}) {
    this.games = new Map();
    this.agentFactory = agentFactory ?? (() => new ChessObscuroAgent());
    this.nextId = 1;
  }

  create({ humanColor = 'white', difficulty = DEFAULT_DIFFICULTY } = {}) {
    if (humanColor === 'random') humanColor = Math.random() < 0.5 ? 'white' : 'black';
    const id = Date.now().toString(36) + '-' + (this.nextId++).toString(36);
    const game = new Game({ id, humanColor, difficulty, agent: this.agentFactory() });
    this.games.set(id, game);
    this._evict();
    game.startAi(); // the AI opens when the human plays black
    return game;
  }

  get(id) {
    const game = this.games.get(id);
    if (!game) throw Object.assign(new Error('no such game'), { status: 404 });
    game.touchedAt = Date.now();
    return game;
  }

  // Games live in memory only; keep the most recently touched few.
  _evict() {
    if (this.games.size <= MAX_GAMES) return;
    const oldest = [...this.games.values()].sort((a, b) => a.touchedAt - b.touchedAt);
    for (const game of oldest.slice(0, this.games.size - MAX_GAMES)) {
      if (!game.pending) this.games.delete(game.id);
    }
  }
}
