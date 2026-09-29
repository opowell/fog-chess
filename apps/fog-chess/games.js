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
//     beginHumanTurn / onActionCommitted below are for. Neither turn start sees
//     what a move reveals before the reply (fxe5 showing a bishop on d6), so
//     after applying either side's move we hand that view on too
//     (onActionObserved).
// ---------------------------------------------------------------------------

import { FogChess, ChessObscuroAgent, analyzeObscuroProgressive, param, settings } from '../../vendor/obscuro-chess/src/index.js';
import { DIAL, param as searchParam, ramp } from '../../vendor/obscuro-chess/vendor/obscuro/src/index.js';

export const COLORS = ['white', 'black'];
const other = color => (color === 'white' ? 'black' : 'white');

// How hard the AI thinks, one of two ways:
//   • power — a fixed amount of reasoning per move, from 0 (random) up, with
//     no ceiling. The level fixes the belief worlds searched, the search
//     rounds, the tree size and the Stockfish depth at the leaves; nothing is
//     cut short by the clock, so the same level reasons the same amount on any
//     machine and a move takes as long as that takes.
//   • time — a wall-clock limit per move, in ms. The engine searches until it
//     runs out, so how much it reasons depends on how fast the machine is.
export const MODES = ['power', 'time'];
export const DEFAULT_STRENGTH = { mode: 'power', power: 25, timeMs: 2000 };
const MAX_TIME_MS = 600000; // obscuro-chess's own ceiling for a time limit
const MAX_GAMES = 50;
const MAX_REVIEW_PLIES = 2000;

const LETTER = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };

// The search settings for a power level. Up to 100 that is obscuro-chess's own
// difficulty dial. The dial stops at 100 (its top is roughly the paper's
// per-move budget), so above that the same curves are carried on past their
// end: power 200 is to 100 what 100 is to 0 along every knob. Those values go
// in as overrides, per game for the search (gameSpecific.obscuro) and on the
// agent for the leaf depth, which the per-game overrides don't reach.
function powerSettings(level) {
  // The dial also carries a wall-clock budget of its own (30 ms at 0 up to 2 s
  // at 100) that ends the search early on a slow machine. timeBudgetMs 0 means
  // no clock, which leaves the counts below as the only limits.
  const search = { timeBudgetMs: 0 };
  const agent = {};
  if (level > 100) {
    const t = level / 100;
    const D = searchParam('DIAL.power', DIAL.power);
    Object.assign(search, {
      particles: ramp(D.worlds, t),
      maxRounds: ramp(D.maxRounds, t),
      maxInfosets: ramp(D.maxInfosets, t),
      expandPerRound: ramp(D.expandPerRound, t),
      cfrPerRound: ramp(D.cfrPerRound, t),
      finalCfr: ramp(D.finalCfr, t),
    });
    agent.sfDepth = ramp(param('chess.CHESS_DIAL', settings.CHESS_DIAL).leafEval.sfDepth, t);
  }
  return { state: { difficulty: Math.min(level, 100), obscuro: search }, agent };
}

// Coordinate notation for a move the human made: enough to read back a game,
// without pretending to SAN (which needs disambiguation against pieces the
// mover may not even be able to see).
function describeMove(action, piece) {
  if (action.type === 'castle') return action.side === 'kingside' ? 'O-O' : 'O-O-O';
  const promo = action.payload?.promote ? '=' + LETTER[action.payload.promote] : '';
  return LETTER[piece?.type] + action.from + (action.isCapture ? '×' : '–') + action.to + promo;
}

function legalMove(action) {
  return {
    key: FogChess.actionKey(action),
    from: action.from,
    to: action.to,
    promote: action.payload?.promote ?? null,
    castle: action.type === 'castle' ? action.side : null,
  };
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
  constructor({ id, humanColor = 'white', mode = DEFAULT_STRENGTH.mode, power = DEFAULT_STRENGTH.power,
    timeMs = DEFAULT_STRENGTH.timeMs, agent, agentFactory = opts => new ChessObscuroAgent(opts), review = false } = {}) {
    if (!COLORS.includes(humanColor)) throw new Error('humanColor must be white or black');
    if (!MODES.includes(mode)) throw new Error('mode must be power or time');
    this.id = id;
    this.humanColor = humanColor;
    this.aiColor = other(humanColor);
    let config, agentOpts = {};
    if (mode === 'power') {
      const level = Math.round(Number(power));
      if (!(level >= 0 && Number.isFinite(level))) throw new Error('power must be 0 or more');
      this.strength = { mode, power: level };
      ({ state: config, agent: agentOpts } = powerSettings(level));
    } else {
      const ms = Math.round(Number(timeMs));
      if (!(ms >= 0 && ms <= MAX_TIME_MS)) throw new Error(`timeMs must be 0–${MAX_TIME_MS}`);
      this.strength = { mode, timeMs: ms };
      config = { aiTimeMs: ms };
    }
    this.review = review;      // a finished game replayed for analysis: nobody moves in it
    this.agent = review ? null : agent ?? agentFactory(agentOpts);
    this.touchedAt = Date.now();
    // A fresh players array per game: belief trackers key on its identity.
    const players = [{ id: 'white', name: 'White' }, { id: 'black', name: 'Black' }];
    this.state = FogChess.createInitialState(players, { fogOfWar: true, ...config });
    this.moves = [];           // [{ color, text }] — the AI's texts go out only once the game is over
    this.keys = [];            // every move's FogChess.actionKey, both sides': how a review replays the game
    this.plies = [];           // one snapshot per position, the start first: see snapshot()
    this.events = [];          // what the human learned since their last move
    this.lastHumanMove = null; // { from, to } for highlighting
    this.pending = null;       // the AI's move in flight, if any
    this.error = null;
    this.resigned = false;
    this._humanTurnSeen = null;
    this._analysisRun = 0;     // bumped to stop the analysis in flight, if any
    this._analysisWalk = null; // { turn, walkState }: where a stopped analysis got to
    this.snapshot(null, null);
    this.beginHumanTurn();
  }

  // Record the position just reached, for stepping back through the game: what
  // each side could see of it, and the true board with the move that led to it.
  // Only the human's sight goes out while the game is on (see history()). What
  // the move captured goes out either way: the human sees what they take, and
  // sees their own pieces vanish.
  snapshot(move, color, captured = []) {
    const observation = this.observation();
    const aiObservation = FogChess.getVisibleState(this.state, this.aiColor);
    this.plies.push({
      seen: boardFor(observation.board),
      visible: observation.visibleSquares,
      aiSeen: boardFor(aiObservation.board),
      aiVisible: aiObservation.visibleSquares,
      board: boardFor(this.state.board),
      move: move && { from: move.from, to: move.to },
      color,
      captured: captured.map(piece => ({ type: piece.type, color: piece.ownerId })),
    });
  }

  get toMove() { return this.state.activePlayers[0]; }
  get result() {
    if (this.resigned) return { outcome: 'win', winnerId: this.aiColor, reason: 'resigned' };
    return FogChess.getResult(this.state);
  }

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
    if (this.review) throw Object.assign(new Error('this game is being reviewed, not played'), { status: 409 });
    if (this.result) throw Object.assign(new Error('the game is over'), { status: 409 });
    if (this.toMove !== this.humanColor) throw Object.assign(new Error('it is not your turn'), { status: 409 });
    const action = this._legalByKey(this.humanColor, key);
    if (!action) throw Object.assign(new Error('illegal move: ' + key), { status: 400 });
    this._applyHuman(action);
    this.startAi();
    return this.view();
  }

  _legalByKey(color, key) {
    const observation = FogChess.getVisibleState(this.state, color);
    return FogChess.getLegalActions(observation, color).find(a => FogChess.actionKey(a) === key);
  }

  // Everything a human move does to the game, shared by play and replay so a
  // replayed position carries the very belief the human had at the time.
  _applyHuman(action) {
    const observation = this.observation();
    this.beginHumanTurn();
    this._analysisRun++;
    FogChess.onActionCommitted(observation, this.humanColor, action);
    const piece = this.state.board[action.from];
    const enemiesBefore = piecesOf(this.state.board, this.aiColor);
    this.state = FogChess.applyActions(this.state, [{ playerId: this.humanColor, action }]);
    FogChess.onActionObserved(this.observation(), this.humanColor);
    this.moves.push({ color: this.humanColor, text: describeMove(action, piece) });
    this.keys.push(FogChess.actionKey(action));
    this.lastHumanMove = { from: action.from, to: action.to };
    const enemiesAfter = piecesOf(this.state.board, this.aiColor);
    const taken = [...enemiesBefore].filter(([id]) => !enemiesAfter.has(id)).map(([, enemy]) => enemy);
    this.snapshot(action, this.humanColor, taken);
    this.events = taken.map(enemy => ({ kind: 'took', square: enemy.position, type: enemy.type }));
  }

  // The human gives up. Allowed while the AI is thinking: its move, when it
  // arrives, is dropped (see _aiMove).
  resign() {
    this.touchedAt = Date.now();
    if (this.result) throw Object.assign(new Error('the game is over'), { status: 409 });
    this._analysisRun++;
    this.resigned = true;
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
    if (this.resigned) return;
    if (!action) throw new Error('the AI found no move');
    this._applyAi(action);
    FogChess.onActionObserved(FogChess.getVisibleState(this.state, this.aiColor), this.aiColor);
  }

  _applyAi(action) {
    const piece = this.state.board[action.from];
    const before = piecesOf(this.state.board, this.humanColor);
    this.state = FogChess.applyActions(this.state, [{ playerId: this.aiColor, action }]);
    const after = piecesOf(this.state.board, this.humanColor);

    // The only thing the AI's move tells the human directly: which of their
    // pieces vanished. Where the enemy went is exactly what fog hides.
    const lost = [...before].filter(([id]) => !after.has(id)).map(([, mine]) => mine);
    this.events.push(...lost.map(mine => ({ kind: 'captured', square: mine.position, type: mine.type })));
    this.moves.push({ color: this.aiColor, text: describeMove(action, piece) });
    this.keys.push(FogChess.actionKey(action));
    this.snapshot(action, this.aiColor, lost);
    this.beginHumanTurn();
  }

  // A finished game played back from its keys (the view's `keys` once it is
  // over) up to `ply`, for analysing the position the human faced there. The
  // human's belief is fed exactly as it was in play; the AI's is never needed.
  static replay({ id, humanColor, keys }) {
    const game = new Game({ id, humanColor, review: true });
    for (const key of keys) {
      if (game.result) throw Object.assign(new Error('the game was over before ' + key), { status: 400 });
      const color = game.toMove;
      const action = game._legalByKey(color, String(key));
      if (!action) throw Object.assign(new Error(`illegal move for ${color}: ${key}`), { status: 400 });
      if (color === game.humanColor) game._applyHuman(action); else game._applyAi(action);
    }
    return game;
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
      strength: this.strength,
      turn: this.state.turnNumber,
      toMove: result ? null : this.toMove,
      thinking: !result && this.toMove === this.aiColor && !this.error,
      result,
      revealed: !!result,
      board: boardFor(result ? this.state.board : observation.board),
      visible: observation.visibleSquares,
      legal: this.legalActions().map(legalMove),
      lastMove: this.lastHumanMove,
      events: this.events,
      // Where the AI went is what the fog hides, until the game is over.
      moves: result ? this.moves : this.moves.map(m => (m.color === this.aiColor ? { ...m, text: null } : m)),
      keys: result ? this.keys : undefined,
      history: this.history(result),
      error: this.error,
    };
  }

  // Every position of the game so far, one per ply, the start first. While the
  // game is on, each is what the human saw of it then, and the AI's moves stay
  // unmarked. Once it is over the fog has nothing left to hide, so each is the
  // true board with the move that made it, and what each side saw goes along
  // as `seen` (the human) and `aiSeen`, for looking back at the game through
  // either side's fog.
  history(result = this.result) {
    return this.plies.map(ply => (result ? this._revealed(ply) : this._sight(ply, this.humanColor)));
  }

  _revealed(ply) {
    return {
      board: ply.board, visible: [], revealed: true, lastMove: ply.move, captured: ply.captured,
      seen: this._sight(ply, this.humanColor), aiSeen: this._sight(ply, this.aiColor),
    };
  }

  // A review's position for playing on from, with moves of your own for either
  // side: the moves the side to move has there (a review is replayed from that
  // side), and the last ply as a finished game's history shows it, with the
  // move that made it. The game is over, so nothing here is still hidden.
  line() {
    return {
      toMove: this.result ? null : this.toMove,
      result: this.result,
      legal: this.legalActions().map(legalMove),
      ply: this._revealed(this.plies.at(-1)),
      move: this.moves.at(-1) ?? null,
    };
  }

  // One side's view of a ply: only its own moves are marked.
  _sight(ply, color) {
    const [board, visible] = color === this.humanColor ? [ply.seen, ply.visible] : [ply.aiSeen, ply.aiVisible];
    return { board, visible, revealed: false, lastMove: ply.color === color ? ply.move : null, captured: ply.captured };
  }

  // Obscuro's read-only analysis of the human's move: the same belief walk the
  // Battle Simulator's analysis panel runs (obscuro-chess's
  // analyzeObscuroProgressive). It ranks every legal move over every position
  // consistent with what the human has seen, getting wider (more of those
  // positions) and deeper (Stockfish depth at the leaves) until it has covered
  // them all at full depth, is stopped, or the human moves. Reports each step
  // through onProgress, and resolves with the last.
  //
  // It reads the human's observation and belief only, so it tells them nothing
  // the fog doesn't already allow them to work out, and it never records a move
  // in the belief, so it cannot change how the game goes on.
  //
  // One analysis per game at a time: a new one stops the last. A stopped walk
  // leaves its place behind, so asking again on the same turn (Pause, then
  // Resume, or a reload) carries on from there instead of starting over.
  async analyze({ onProgress, isCancelled = () => false } = {}) {
    if (this.result) throw Object.assign(new Error('the game is over'), { status: 409 });
    if (this.toMove !== this.humanColor) throw Object.assign(new Error('it is not your turn'), { status: 409 });
    const run = ++this._analysisRun;
    const stopped = () => run !== this._analysisRun || isCancelled();
    const turn = this.state.turnNumber;
    this.beginHumanTurn();
    const observation = this.observation();
    const legal = FogChess.getLegalActions(observation, this.humanColor);
    const frame = info => analysisFrame(info, observation, legal);
    const result = await analyzeObscuroProgressive(observation, legal, {
      color: this.humanColor,
      isCancelled: stopped,
      resumeState: this._analysisWalk?.turn === turn ? this._analysisWalk.walkState : undefined,
      saveWalkState: walkState => { if (!stopped()) this._analysisWalk = { turn, walkState }; },
      onProgress: info => { if (!stopped()) onProgress?.(frame(info)); },
    });
    return frame(result);
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

// One analysis step as the page gets it: moves named the way the move list
// names them, and each possible board as the enemy pieces the fog hides in it.
function analysisFrame(info, observation, legal) {
  const byKey = new Map(legal.map(a => [FogChess.actionKey(a), a]));
  const out = {
    kind: info.kind ?? null,
    depth: info.depth ?? null,
    maxDepth: info.maxDepth ?? null,
    evaluated: info.evaluated ?? null,
    total: info.total ?? null,
    exhaustive: !!info.exhaustive,
  };
  if (info.candidates) {
    out.candidates = info.candidates.map(c => {
      const action = byKey.get(c.key ?? FogChess.actionKey(c.move)) ?? c.move;
      return {
        key: FogChess.actionKey(action),
        text: describeMove(action, observation.board[action.from]),
        from: action.from,
        to: action.to,
        cp: c.cp ?? null,
        prob: c.prob ?? null,
      };
    });
  }
  const b = info.beliefWorlds;
  if (b) {
    out.worlds = {
      total: b.total ?? null,
      approx: !!b.approx,
      depth: b.depth ?? null,
      moves: b.moves,
      list: b.worlds.map(w => ({
        id: w.id,
        prob: w.prob ?? null,
        cp: w.cp ?? null,
        hidden: w.hidden.map(({ sq, type }) => ({ sq, type })),
      })),
    };
  }
  return out;
}

export class GameStore {
  constructor({ agentFactory } = {}) {
    this.games = new Map();
    this.agentFactory = agentFactory ?? (opts => new ChessObscuroAgent(opts));
    this.nextId = 1;
  }

  create({ humanColor = 'white', ...strength } = {}) {
    if (humanColor === 'random') humanColor = Math.random() < 0.5 ? 'white' : 'black';
    const game = new Game({ id: this._newId(), humanColor, ...strength, agentFactory: this.agentFactory });
    this._add(game);
    game.startAi(); // the AI opens when the human plays black
    return game;
  }

  // A finished game replayed to where the human was about to play `keys`'s
  // next move, as a game the analysis and belief endpoints can read. The same
  // position asked for again gets the same game, and so the same walk to resume.
  review({ humanColor, keys }) {
    if (!COLORS.includes(humanColor)) throw new Error('humanColor must be white or black');
    if (!Array.isArray(keys) || keys.length > MAX_REVIEW_PLIES) throw new Error('keys must be a list of moves');
    const position = humanColor + ':' + keys.join(' ');
    const known = [...this.games.values()].find(g => g.review && g.position === position);
    if (known) return this.get(known.id);
    const game = Game.replay({ id: this._newId(), humanColor, keys });
    game.position = position;
    this._add(game);
    return game;
  }

  // What the AI saw at every ply of a finished game, for games kept before the
  // history carried it. Replayed on a throwaway game, never stored.
  sight({ humanColor, keys }) {
    if (!COLORS.includes(humanColor)) throw new Error('humanColor must be white or black');
    if (!Array.isArray(keys) || keys.length > MAX_REVIEW_PLIES) throw new Error('keys must be a list of moves');
    const game = Game.replay({ id: 'sight', humanColor, keys });
    return { aiSeen: game.plies.map(ply => game._sight(ply, game.aiColor)) };
  }

  _newId() { return Date.now().toString(36) + '-' + (this.nextId++).toString(36); }

  _add(game) {
    this.games.set(game.id, game);
    this._evict();
  }

  get(id) {
    const game = this.games.get(id);
    if (!game) throw Object.assign(new Error('no such game'), { status: 404 });
    game.touchedAt = Date.now();
    return game;
  }

  // Games live in memory only; keep the most recently touched few. Reviews go
  // first: they are cheap to replay, and stepping through one makes many.
  _evict() {
    if (this.games.size <= MAX_GAMES) return;
    const oldest = [...this.games.values()].sort((a, b) => (b.review - a.review) || (a.touchedAt - b.touchedAt));
    for (const game of oldest.slice(0, this.games.size - MAX_GAMES)) {
      if (!game.pending) this.games.delete(game.id);
    }
  }
}
