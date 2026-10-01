// The fog chess client. It never sees the true board: the server sends the
// human's fog-filtered view (see games.js), and this file only draws it and
// turns clicks into the move keys the server listed as legal. Finished games
// are kept in the browser (archive.js) and can be opened again for review.

import { saveGame, listGames, loadGame, deleteGame } from './archive.js';

const API = 'api/games';
const REVIEWS = 'api/reviews';
const FILES = 'abcdefgh';
const PIECE_FILE = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P' };
const TYPE_OF_LETTER = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const MARKER_CYCLE = [null, 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const PROMOTIONS = ['queen', 'knight', 'rook', 'bishop'];
const TAKEN_ORDER = ['pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const VALUE = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 0 };

const $ = id => document.getElementById(id);
const boardEl = $('board');
const statusEl = $('status');
const promotionEl = $('promotion');
const beliefToggle = $('show-belief');
const beliefNote = $('belief-note');
const FOGS = ['off', 'white', 'black', 'active'];

let view = null;
let selected = null;
let markers = {};
let circles = new Set(); // squares ringed in yellow
let arrows = new Set(); // yellow arrows, as from and to squares: 'e2e4'
let sketch = null; // an arrow being drawn with the right button: { from, to, pointerId }
let belief = null;
let flashes = [];
let busy = false; // a move is on its way to the server
let epoch = 0; // bumped on every new game, so a late reply for an old one is dropped
let drag = null; // a piece being dragged: { from, pointerId, x, y, ghost, over }
let suppressClick = false; // the click that ends a drag is not a second tap
let plyShown = null; // stepping back through the game: the index into view.history on the board, or null for now
let archived = []; // the past games list: [{ id, endedAt, humanColor, strength, result, plies }]
let reviewTimer = null;
let line = null; // a line of your own, played on from a review: { from, keys, plies, moves, result } (see playLine)
let replays = new Map(); // a review's positions as the server replays them (see replay)

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

let reviewFog = store.get('fog-chess:review-fog-side'); // whose fog a review shows: one of FOGS
if (!FOGS.includes(reviewFog)) reviewFog = 'off';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? res.statusText), { status: res.status });
  return data;
}

const pieceSrc = (color, type) => `pieces/${color[0]}${PIECE_FILE[type]}.svg`;
const orientation = () => ((view ?? setupView()).humanColor === 'black' ? 'black' : 'white');

// Before a game, the board previews the start as the chosen side will see it:
// its own pieces, and fog over the half the enemy starts in. Random could be
// either side, so it shows the whole board.
const START_RANK = { R: 'rook', N: 'knight', B: 'bishop', Q: 'queen', K: 'king' };
function setupView() {
  const color = document.querySelector('#new-game input[name="color"]:checked')?.value ?? 'white';
  const sides = color === 'random' ? ['white', 'black'] : [color];
  const board = {};
  for (const side of sides) {
    const [back, front] = side === 'white' ? [1, 2] : [8, 7];
    [...'RNBQKBNR'].forEach((letter, i) => {
      board[FILES[i] + back] = { color: side, type: START_RANK[letter] };
      board[FILES[i] + front] = { color: side, type: 'pawn' };
    });
  }
  const ranks = color === 'black' ? [5, 6, 7, 8] : [1, 2, 3, 4];
  return {
    humanColor: color === 'black' ? 'black' : 'white',
    board,
    visible: ranks.flatMap(rank => [...FILES].map(file => file + rank)),
    revealed: color === 'random',
    legal: [],
  };
}

function squaresInOrder() {
  const ranks = orientation() === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = orientation() === 'white' ? [...FILES] : [...FILES].reverse();
  return ranks.flatMap(rank => files.map(file => file + rank));
}

// --- rendering --------------------------------------------------------------

function render() {
  renderBoard();
  renderStatus();
  renderMoves();
  renderPanels();
  renderTaken();
  renderAnalysis();
}

const strengthText = ({ mode, power, timeMs } = {}) =>
  mode === 'time' ? `AI time ${timeMs} ms a move` : mode === 'power' ? `AI power ${power}` : null;

// Setting up a game, playing one and reviewing an old one are separate modes:
// the setup cards (title, new-game form, rules, past games) on the left go
// while a game is on, and the game's cards on the right are the in-game ones
// or a review's. A game that ends becomes a review of itself (see finish).
function renderPanels() {
  const live = playing();
  const review = reviewing();
  $('setup').hidden = live;
  $('archive').hidden = live || !archived.length;
  $('in-game').hidden = !live;
  $('review').hidden = !review;
  $('moves-card').hidden = !live && !review;
  $('fog-card').hidden = !live && !(review && fogColor());
  $('marker-note').hidden = review;
  if (live) {
    const ai = strengthText(view.strength);
    $('game-info').textContent = `You play ${view.humanColor}.` + (ai ? ` ${ai}.` : '');
  }
  if (review) {
    const ai = strengthText(view.strength);
    $('review-info').textContent = `${fmtDate(view.endedAt)}. You played ${view.humanColor}.` + (ai ? ` ${ai}.` : '')
      + (view.sightError ? ` The AI's view could not be loaded: ${view.sightError}` : '');
    for (const button of $('review-fog').children) button.classList.toggle('on', button.dataset.fog === reviewFog);
    $('review-line').hidden = !line;
  }
}

const fmtDate = ms => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const reviewing = () => !!view?.review;

// The moves on the board: the game's own, or once you play on from a review,
// the game up to ply line.from and then your line.
const lineHistory = () => (line ? [...view.history.slice(0, line.from + 1), ...line.plies] : view?.history);
const lineMoves = () => (line ? [...view.moves.slice(0, line.from), ...line.moves] : view?.moves);
const lineKeys = () => (line ? [...view.keys.slice(0, line.from), ...line.keys] : view?.keys);
const plyOnBoard = () => plyShown ?? (lineHistory()?.length ?? 1) - 1;

// Whose fog a review shows on the ply on the board, or null for the whole
// board. 'active' follows the side to move, and white moves first.
function fogColor() {
  if (!reviewing() || reviewFog === 'off') return null;
  if (reviewFog !== 'active') return reviewFog;
  return plyOnBoard() % 2 === 0 ? 'white' : 'black';
}

// The position on the board when stepping back through the game (see
// stepHistory), or null while it shows the game as it stands. A review is
// always a position from the history: the whole board, or what one side saw
// of it. Until an old game's AI view arrives (see fillAiSight), the AI's side
// shows the whole board.
function pastPly() {
  if (reviewing()) {
    const ply = lineHistory()[plyOnBoard()];
    const color = fogColor();
    if (!color) return ply;
    return (color === view.humanColor ? ply.seen : ply.aiSeen) ?? ply;
  }
  return plyShown === null ? null : view?.history?.[plyShown] ?? null;
}

// Whether the board shows the position the analysis and the belief overlay
// are about (see target), rather than an earlier one looked back at.
const boardOnTarget = () => reviewing() || plyShown === null;

function renderBoard() {
  const past = pastPly();
  const shown = past ?? view ?? setupView();
  const visible = new Set(shown.visible);
  const legal = legalHere();
  const targets = new Set(selected ? legal.filter(m => m.from === selected).map(m => m.to) : []);
  const movable = new Set(legal.map(m => m.from));
  const order = squaresInOrder();
  const ghosts = new Map(boardOnTarget() && fogMatchesTarget() ? (currentWorld()?.hidden ?? []).map(h => [h.sq, TYPE_OF_LETTER[h.type]]) : []);
  const hiddenColor = target()?.color === 'white' ? 'black' : 'white';
  const fragment = document.createDocumentFragment();

  order.forEach((sq, i) => {
    const file = sq[0];
    const rank = Number(sq[1]);
    const isDark = (FILES.indexOf(file) + rank) % 2 === 0;
    const fogged = !shown.revealed && !visible.has(sq);
    const piece = shown.board[sq];

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'sq';
    cell.dataset.sq = sq;
    if (isDark) cell.classList.add('dark');
    if (fogged) cell.classList.add('fog');
    if (movable.has(sq)) cell.classList.add('movable');
    if (targets.has(sq)) cell.classList.add('target');
    if (targets.has(sq) && piece) cell.classList.add('occupied');
    if (sq === selected) cell.classList.add('selected');
    if (drag?.ghost && sq === drag.from) cell.classList.add('drag-from');
    if (drag?.ghost && sq === drag.over) cell.classList.add('drag-over');
    if (shown.lastMove && (sq === shown.lastMove.from || sq === shown.lastMove.to)) cell.classList.add('last');
    if (!past && flashes.includes(sq)) cell.classList.add('flash');

    let label = sq;
    if (piece) {
      cell.append(img(pieceSrc(piece.color, piece.type), 'piece'));
      label += `, ${piece.color} ${piece.type}`;
    } else if (fogged && ghosts.has(sq)) {
      cell.append(img(pieceSrc(hiddenColor, ghosts.get(sq)), 'piece ghost'));
      label += `, hidden, on the analysis board: ${ghosts.get(sq)}`;
    } else if (fogged && view && !past && markers[sq]) {
      cell.append(img(pieceSrc(view.aiColor, markers[sq]), 'piece marker'));
      label += `, hidden, your marker: ${markers[sq]}`;
    } else if (fogged) {
      label += ', hidden';
    }

    if (circles.has(sq)) {
      const ring = document.createElement('span');
      ring.className = 'circle';
      cell.append(ring);
      label += ', circled';
    }

    const cellBelief = fogged && boardOnTarget() && belief?.squares?.[sq];
    if (cellBelief && cellBelief.p >= 0.02) {
      cell.classList.add('belief');
      cell.style.setProperty('--p', (0.08 + cellBelief.p * 0.42).toFixed(3));
      const tag = document.createElement('span');
      tag.className = 'belief-label';
      tag.textContent = `${Math.round(cellBelief.p * 100)}% ${cellBelief.type.toUpperCase()}`;
      cell.append(tag);
      label += `, ${Math.round(cellBelief.p * 100)}% chance of an enemy ${TYPE_OF_LETTER[cellBelief.type]}`;
    }

    if (i % 8 === 0) cell.append(coord('rank', rank));
    if (i >= 56) cell.append(coord('file', file));
    cell.setAttribute('aria-label', label);
    fragment.append(cell);
  });

  boardEl.replaceChildren(fragment);
  renderArrows();
}

function img(src, className) {
  const el = document.createElement('img');
  el.src = src;
  el.className = className;
  el.alt = '';
  el.draggable = false;
  return el;
}

function coord(kind, text) {
  const el = document.createElement('span');
  el.className = 'coord ' + kind;
  el.textContent = text;
  return el;
}

const NAME = { pawn: 'pawn', knight: 'knight', bishop: 'bishop', rook: 'rook', queen: 'queen', king: 'king' };

function eventText(event) {
  if (event.kind === 'captured') return `Your ${NAME[event.type]} on ${event.square} was captured.`;
  if (event.kind === 'took') return `You took a ${NAME[event.type]} on ${event.square}.`;
  return '';
}

function resultText(result) {
  if (result.outcome === 'draw') return 'Draw: fifty moves without a capture or pawn move.';
  if (result.reason === 'resigned') return 'You resigned.';
  return result.winnerId === view.humanColor
    ? 'You won: you captured the king.'
    : 'You lost: your king was captured.';
}

function renderStatus() {
  statusEl.classList.remove('thinking');
  if (!view) { statusEl.textContent = ''; return; }
  if (reviewing()) { statusEl.textContent = reviewText(); return; }
  if (pastPly()) { statusEl.textContent = historyText(); return; }
  const news = view.events.map(eventText).filter(Boolean).join(' ');
  if (view.error) {
    statusEl.textContent = 'The AI hit an error: ' + view.error;
  } else if (view.thinking) {
    statusEl.textContent = (news ? news + ' ' : '') + 'Opponent is thinking';
    statusEl.classList.add('thinking');
  } else {
    statusEl.textContent = (news ? news + ' ' : '') + 'Your move.';
  }
}

// Where the board is when stepping back, in the move list's own words.
function plyText(ply) {
  const move = lineMoves()[ply - 1];
  return move
    ? `after ${Math.ceil(ply / 2)}.${move.color === 'white' ? '' : '..'} ${move.text ?? 'the opponent’s hidden move'}`
    : 'the start';
}

const historyText = () => `Looking back: ${plyText(plyShown)}. ← → step a move at a time, back to the game at the end.`;

function reviewText() {
  const where = plyText(plyOnBoard());
  const result = line ? line.result : view.result;
  const end = plyShown === null && result ? ' ' + resultText(result) : '';
  const own = line && plyOnBoard() > line.from ? ' Your own line, not the game.' : '';
  const fog = fogColor() ? ` Through ${fogColor()}'s fog.` : '';
  return `${where[0].toUpperCase() + where.slice(1)}.${own}${end}${fog} ← → step through, or move either side to try a line.`;
}

function renderMoves() {
  const list = $('moves');
  const rows = [];
  const moves = lineMoves() ?? [];
  // White always moves first, so plies pair up from the start.
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i / 2 + 1 + '.';
    li.append(num, moveCell(moves[i], i + 1), moveCell(moves[i + 1], i + 2));
    rows.push(li);
  }
  list.replaceChildren(...rows);
  const current = list.querySelector('.current');
  if (current) current.scrollIntoView({ block: 'nearest' });
  else list.scrollTop = list.scrollHeight;
}

// ply is the position the move leads to, its index in view.history.
function moveCell(move, ply) {
  const el = document.createElement('span');
  if (!move) return el;
  if (move.text) el.textContent = move.text;
  else { el.textContent = 'hidden'; el.classList.add('hidden'); }
  el.dataset.ply = ply;
  el.title = 'Show the board after this move';
  if (line && ply > line.from) { el.classList.add('own'); el.title += ', in your own line'; }
  if (ply === plyShown) el.classList.add('current');
  return el;
}

// --- taken pieces -----------------------------------------------------------
//
// Everything captured up to the ply on the board. Both sides' captures are
// things you know: you see what you take, and you see your own pieces vanish.

// What the move to ply i captured. Games kept before plies carried their
// captures are over, so their true boards show it: whatever the side not
// moving has fewer of (white moves first, so odd plies are white's).
function capturedAt(i) {
  const history = lineHistory();
  const ply = history[i];
  if (ply.captured) return ply.captured;
  if (!ply.revealed) return [];
  const color = i % 2 ? 'black' : 'white';
  const count = board => {
    const n = {};
    for (const p of Object.values(board)) if (p.color === color) n[p.type] = (n[p.type] ?? 0) + 1;
    return n;
  };
  const before = count(history[i - 1].board), after = count(ply.board);
  return Object.entries(before).flatMap(([type, n]) => Array(Math.max(0, n - (after[type] ?? 0))).fill({ type, color }));
}

function renderTaken() {
  const card = $('taken');
  card.hidden = !playing() && !reviewing();
  if (card.hidden) return;
  const taken = { [view.humanColor]: [], [view.aiColor]: [] };
  for (let i = 1; i <= plyOnBoard(); i++) {
    for (const p of capturedAt(i)) taken[p.color].push(p.type);
  }
  const worth = types => types.reduce((sum, type) => sum + VALUE[type], 0);
  const edge = worth(taken[view.aiColor]) - worth(taken[view.humanColor]);
  const row = (color, el) => {
    const types = taken[color].sort((a, b) => TAKEN_ORDER.indexOf(a) - TAKEN_ORDER.indexOf(b));
    el.replaceChildren(...types.map((type, i) => {
      const piece = img(pieceSrc(color, type), types[i - 1] && types[i - 1] !== type ? 'new-kind' : '');
      piece.alt = `${color} ${type}`;
      return piece;
    }));
  };
  row(view.aiColor, $('taken-by-you'));
  row(view.humanColor, $('taken-from-you'));
  $('edge-you').textContent = edge > 0 ? `+${edge}` : '';
  $('edge-ai').textContent = edge < 0 ? `+${-edge}` : '';
}

// --- stepping through the game ---------------------------------------------
//
// The arrow keys walk the board back and forth a ply at a time, through what
// you saw at each point (a finished game is a review: see reviewing). Stepping
// forward off the last ply is back to the game; nothing can be played until
// then.

function showPly(ply) {
  const last = (lineHistory()?.length ?? 0) - 1;
  if (last < (reviewing() ? 0 : 1)) return;
  ply = Math.max(0, Math.min(last, ply));
  plyShown = ply === last ? null : ply;
  selected = null;
  endDrag();
  if (reviewing()) {
    // Scrubbing through a review asks the server for nothing until it stops.
    belief = null;
    syncAnalysis();
    clearTimeout(reviewTimer);
    reviewTimer = setTimeout(() => { startAnalysis(); refreshBelief(); loadMoves(); }, 250);
  }
  render();
}

const stepHistory = delta => showPly(plyOnBoard() + delta);

// --- reviewing old games ----------------------------------------------------
//
// A finished game is kept in the browser, and opening one steps through it
// like a game just played, a ply at a time. On every position with a move to
// play, the analysis and the belief overlay work as they did in play, for the
// side to move: the server replays the game that far from that side
// (GameStore.review), so both are built from what it knew then. On the AI's
// moves that is the AI's side of the fog, not its own search.

// The position the analysis and the belief overlay are about, whose it is, and
// how to find the server's game for it: the live game on your move, or in a
// review the ply on the board for the side to move there. Null when there is
// none. `played` is the move made from there, in a review.
function target() {
  if (playing()) {
    return view.thinking ? null : { position: `${view.id}:${view.turn}`, color: view.humanColor, gameId: async () => view.id };
  }
  if (!reviewing()) return null;
  const ply = plyOnBoard();
  const over = line ? !!line.result : view.result.reason !== 'resigned';
  if (ply === lineHistory().length - 1 && over) return null;
  const color = ply % 2 === 0 ? 'white' : 'black'; // white moves first
  const keys = lineKeys().slice(0, ply);
  return {
    position: `review:${view.id}:${keys.join(' ')}`,
    color,
    played: !line || ply <= line.from ? view.keys[ply] ?? null : null,
    // Asked afresh: the server keeps only so many reviews, and finds this one again if it still has it.
    gameId: async () => (await replay(keys, true)).id,
  };
}

// A position of the review as the server replays it (GameStore.review), from
// the side to move there, by the moves that lead to it: the game the analysis
// and belief read, and the moves that side has (see legalHere). Each is kept
// once it arrives.
function replay(keys, fresh = false) {
  const k = keys.join(' ');
  const known = replays.get(k);
  if (known && !fresh) return known.request;
  const request = api(REVIEWS, { method: 'POST', body: { humanColor: keys.length % 2 === 0 ? 'white' : 'black', keys } });
  const entry = { request, data: known?.data ?? null };
  request.then(data => { entry.data = data; }, () => { if (!entry.data && replays.get(k) === entry) replays.delete(k); });
  replays.set(k, entry);
  return request;
}

// Asks for the moves from the review's position on the board, so either side's
// pieces can be picked up there.
async function loadMoves() {
  if (!reviewing() || !target()) return;
  const mine = epoch;
  try {
    await replay(lineKeys().slice(0, plyOnBoard()));
  } catch (error) {
    if (mine === epoch) statusEl.textContent = 'Could not load the moves here: ' + error.message;
    return;
  }
  if (mine === epoch) renderBoard();
}

// --- playing on from a review ------------------------------------------------
//
// Reviewing, either side can be moved from any position, to try a line of your
// own. The server replays it like the game (see replay), so the fog, what was
// taken, the analysis and the belief all follow it as each side would have seen
// it. Playing from earlier in a line starts a new one there; playing the game's
// own move goes back onto the game.

async function playLine(key) {
  const at = plyOnBoard();
  const keys = [...lineKeys().slice(0, at), key];
  endDrag();
  selected = null;
  if (keys.every((k, i) => k === view.keys[i])) {
    line = null;
    window.playChessMoveSound?.();
    showPly(keys.length);
    return;
  }
  busy = true;
  stopAnalysis();
  renderBoard();
  const mine = epoch;
  let data;
  try {
    data = await replay(keys);
  } catch (error) {
    if (mine !== epoch) return;
    busy = false;
    statusEl.textContent = error.message;
    startAnalysis();
    renderBoard();
    return;
  }
  if (mine !== epoch) return;
  busy = false;
  let from = 0;
  while (keys[from] === view.keys[from]) from++;
  // The server replayed it from the side to move next: its sight is `seen`.
  const next = keys.length % 2 === 0 ? 'white' : 'black';
  const reached = next === view.humanColor ? data.ply : { ...data.ply, seen: data.ply.aiSeen, aiSeen: data.ply.seen };
  line = {
    from,
    keys: keys.slice(from),
    plies: [...lineHistory().slice(from + 1, at + 1), reached],
    moves: [...lineMoves().slice(from, at), data.move],
    result: data.result,
  };
  plyShown = null;
  belief = null;
  window.playChessMoveSound?.();
  syncAnalysis();
  render();
  startAnalysis();
  refreshBelief();
}

// Off your line, back to the game where it left it.
function leaveLine() {
  if (!line) return;
  const { from } = line;
  line = null;
  showPly(from);
}

// Whether the review's fog is the side the analysis is for, so its possible
// boards and belief belong on the fogged squares shown. Play is always yours.
const fogMatchesTarget = () => !reviewing() || fogColor() === target()?.color;

async function openReview(id) {
  const record = await loadGame(id);
  if (!record) { renderArchive(); return; }
  leaveGame();
  view = { ...record, review: true };
  loadMarkers();
  syncAnalysis();
  render();
  startAnalysis();
  refreshBelief();
  loadMoves();
  if (!record.history.every(ply => ply.aiSeen)) fillAiSight(record);
}

// Games kept before the history carried the AI's view get it from a replay on
// the server, once: it goes back into the archive.
async function fillAiSight(record) {
  const mine = epoch;
  try {
    const { aiSeen } = await api(`${REVIEWS}/sight`, { method: 'POST', body: { humanColor: record.humanColor, keys: record.keys } });
    const history = record.history.map((ply, i) => ({ ...ply, aiSeen: aiSeen[i] }));
    saveGame({ ...record, history });
    if (mine !== epoch) return;
    view.history = history;
  } catch (error) {
    if (mine !== epoch) return;
    view.sightError = error.message;
  }
  render();
}

function closeReview() {
  leaveGame();
  view = null;
  syncAnalysis();
  render();
}

// Whatever was on the board goes, and nothing still on its way for it lands.
function leaveGame() {
  epoch++;
  stopAnalysis();
  clearTimeout(reviewTimer);
  busy = false;
  selected = null;
  plyShown = null;
  line = null;
  replays = new Map();
  belief = null;
  markers = {};
  circles = new Set();
  arrows = new Set();
  sketch = null;
  flashes = [];
  promotionEl.hidden = true;
}

const OUTCOME = { won: 'Won', lost: 'Lost', drew: 'Drew', resigned: 'Resigned' };
function outcome({ result, humanColor }) {
  if (result.outcome === 'draw') return 'drew';
  if (result.reason === 'resigned') return 'resigned';
  return result.winnerId === humanColor ? 'won' : 'lost';
}

async function renderArchive() {
  archived = await listGames();
  $('archive-list').replaceChildren(...archived.map(g => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'archive-open';
    open.dataset.open = g.id;
    open.title = 'Review this game';
    const title = document.createElement('span');
    const how = outcome(g);
    title.className = 'archive-title ' + how;
    title.textContent = `${OUTCOME[how]} as ${g.humanColor}`;
    const meta = document.createElement('span');
    meta.className = 'archive-meta';
    const moves = Math.ceil(g.plies / 2);
    meta.textContent = [fmtDate(g.endedAt), `${moves} move${moves === 1 ? '' : 's'}`, strengthText(g.strength)].filter(Boolean).join(' · ');
    open.append(title, meta);
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'archive-delete';
    del.dataset.delete = g.id;
    del.title = 'Delete this game';
    del.setAttribute('aria-label', 'Delete this game');
    del.textContent = '×';
    li.append(open, del);
    return li;
  }));
  renderPanels();
}

// --- belief overlay ---------------------------------------------------------

async function refreshBelief() {
  belief = null;
  beliefNote.textContent = '';
  const on = beliefToggle.checked && fogMatchesTarget();
  const t = on ? target() : null;
  if (!t) { renderBoard(); return; }
  const mine = epoch;
  try {
    const data = await api(`${API}/${await t.gameId()}/belief`);
    if (mine !== epoch || target()?.position !== t.position) return;
    belief = data;
    beliefNote.textContent = data.exact
      ? `Weighing ${data.positions.toLocaleString()} possible position${data.positions === 1 ? '' : 's'}; shading is the chance an enemy piece is on each dark square.`
      : 'There are too many possible positions to track exactly any more.';
  } catch (error) {
    if (mine !== epoch || target()?.position !== t.position) return;
    beliefNote.textContent = 'Could not load the belief: ' + error.message;
  }
  renderBoard();
}

// --- analysis ---------------------------------------------------------------
//
// The AI's own view of your move, the way the Battle Simulator's analysis
// panel shows it: every legal move ranked over every position consistent with
// what you have seen, refining live (wider over those positions, deeper in
// Stockfish) over a server-sent event stream until it settles. Like the belief
// overlay it only ever uses your information. It runs on your move only, and
// stops the moment you play.

const analysis = {
  on: store.get('fog-chess:analysis') !== '0',
  paused: false,
  source: null,      // the EventSource in flight
  running: false,
  run: 0,            // bumped on every stop, so a start still finding its game gives up
  position: null,    // `${game}:${turn}`: what the results below are about
  candidates: [],    // ranked: [{ key, text, from, to, cp, prob }]
  worlds: null,      // { total, exact, approx, sampled, depth, moves, list: [{ id, prob, cp, hidden }] }
  progress: null,
  single: false,     // only one board fits what you've seen: moves are ranked by eval alone
  error: '',
  hovered: null,     // key of the row under the pointer
};
// The possible-board stepper: '' orders boards by likelihood, a move key by
// how good that move looks in each.
const stepper = { order: '', n: 1, optionsFor: null };
const SHOWN_ROWS = 5;
const ARROWS = 3;

const fmtNum = n => (n ?? 0).toLocaleString();

// Pawns, from your side (+1.35). The engine's mate scores are huge.
function fmtCp(cp) {
  if (cp == null) return '';
  if (Math.abs(cp) >= 90000) return cp > 0 ? '#' : '-#';
  return (cp >= 0 ? '+' : '') + (cp / 100).toFixed(2);
}

// A posterior over thousands of boards runs small; scale precision to the value.
function fmtPct(p) {
  const v = p * 100;
  if (v >= 10) return v.toFixed(0) + '%';
  if (v >= 1) return v.toFixed(1) + '%';
  if (v >= 0.01) return v.toFixed(2) + '%';
  return v > 0 ? '<0.01%' : '0%';
}

// "Depth 8/20 · 480 / 1,200 boards", or just the depth once nothing is hidden.
function progressLabel(f) {
  if (f.kind !== 'batch' && !f.exhaustive) return null;
  const depth = f.depth ? `Depth ${f.depth}/${f.maxDepth}` : null;
  const boards = f.exhaustive ? `all ${fmtNum(f.total)} boards`
    : f.total ? `${fmtNum(f.evaluated)} / ${fmtNum(f.total)} boards`
    : `${fmtNum(f.evaluated)} boards`;
  if (f.total === 1) return depth ?? boards;
  return depth ? `${depth} · ${boards}` : boards;
}

const playing = () => !!view && !view.result;
const analysisWanted = () => analysis.on && !analysis.paused && !!target() && !busy;

function stopAnalysis() {
  analysis.run++;
  analysis.source?.close();
  analysis.source = null;
  analysis.running = false;
}

// A new position makes whatever is on screen wrong, so it goes at once.
function syncAnalysis() {
  const position = target()?.position ?? null;
  if (position === analysis.position) return;
  stopAnalysis();
  Object.assign(analysis, { position, candidates: [], worlds: null, progress: null, single: false, error: '', hovered: null });
  Object.assign(stepper, { order: '', n: 1, optionsFor: null });
}

// Resuming on the same turn picks the walk up where it stopped (the server
// keeps its place), so what is on screen stays until something newer arrives.
async function startAnalysis() {
  stopAnalysis();
  syncAnalysis();
  if (!analysisWanted()) { renderAnalysis(); return; }
  const run = analysis.run;
  analysis.running = true;
  analysis.error = '';
  renderAnalysis();
  let id;
  try {
    id = await target().gameId();
  } catch (error) {
    if (run !== analysis.run) return;
    analysis.running = false;
    analysis.error = error.message;
    renderAnalysis();
    return;
  }
  if (run !== analysis.run) return;
  const source = new EventSource(`${API}/${id}/analysis`);
  analysis.source = source;
  source.onmessage = e => {
    if (source !== analysis.source) return;
    const f = JSON.parse(e.data);
    let boardChanged = false;
    if (f.error) {
      analysis.error = f.error;
    } else {
      if (f.candidates?.length) analysis.candidates = f.candidates;
      if (f.total != null) analysis.single = f.total === 1;
      if (f.worlds) {
        const before = currentWorld()?.id;
        analysis.worlds = f.worlds;
        boardChanged = currentWorld()?.id !== before;
      }
      const label = progressLabel(f);
      if (f.done) analysis.progress = f.exhaustive ? label : null;
      else if (label) analysis.progress = label;
    }
    if (f.done || f.error) stopAnalysis();
    if (boardChanged) renderBoard(); else renderArrows();
    renderAnalysis();
  };
  // EventSource reconnects by itself; a finished or failed walk must not restart.
  source.onerror = () => {
    if (source !== analysis.source) return;
    stopAnalysis();
    analysis.error = 'Lost contact with the analysis.';
    renderAnalysis();
  };
  renderAnalysis();
}

function setAnalysisOn(on) {
  analysis.on = on;
  store.set('fog-chess:analysis', on ? '1' : '0');
  if (on) startAnalysis(); else { stopAnalysis(); renderAnalysis(); }
  renderBoard();
}

function setPaused(paused) {
  analysis.paused = paused;
  if (paused) { stopAnalysis(); renderAnalysis(); } else startAnalysis();
  renderBoard();
}

// Worlds in stepper order: by likelihood, or by where the chosen move ranks
// among all moves on that board (#1 = outright best there), eval breaking ties.
function worldRows() {
  const list = analysis.worlds?.list ?? [];
  const col = stepper.order ? (analysis.worlds?.moves?.indexOf(stepper.order) ?? -1) : -1;
  if (col < 0) return list.map(w => ({ w })).sort((a, b) => (b.w.prob ?? -1) - (a.w.prob ?? -1));
  return list
    .filter(w => Array.isArray(w.cp) && w.cp.length > col)
    .map(w => ({ w, cp: w.cp[col], rank: 1 + w.cp.filter(v => v > w.cp[col]).length }))
    .sort((a, b) => (a.rank - b.rank) || (b.cp - a.cp));
}

const worldsShown = () => analysis.on && !analysis.paused && !!target() && !!analysis.worlds?.list?.length;

function currentWorld() {
  if (!worldsShown()) return null;
  const rows = worldRows();
  return rows[Math.min(stepper.n, rows.length) - 1]?.w ?? null;
}

function renderAnalysis() {
  const section = $('analysis');
  section.hidden = !playing() && !reviewing();
  if (section.hidden) return;
  const t = target();
  const here = !!t;
  $('an-on').classList.toggle('on', analysis.on);
  $('an-off').classList.toggle('on', !analysis.on);
  $('an-body').hidden = !analysis.on;
  $('an-spinner').hidden = !analysis.on || !analysis.running;
  if (!analysis.on) return;

  const pause = $('an-pause');
  pause.textContent = analysis.paused ? '► Resume' : '❙❙ Pause';
  pause.classList.toggle('on', analysis.paused);
  pause.disabled = !here;
  $('an-progress').textContent = analysis.paused ? '' : (analysis.progress ?? '');

  // In a review, whose move this is, and the one made: its row stays in view
  // with its real rank even when it is not among the top few.
  const side = t && reviewing() ? (t.color === view.humanColor ? 'you' : 'the AI') : null;
  $('an-for').textContent = side ? `${t.color[0].toUpperCase() + t.color.slice(1)} to move (${side}), from what ${side === 'you' ? 'you' : 'it'} could see. Evals are from ${t.color}'s side.` : '';
  $('an-for').hidden = !side;
  const ranked = here ? analysis.candidates.map((c, i) => ({ ...c, rank: i + 1 })) : [];
  const rows = ranked.slice(0, SHOWN_ROWS);
  const played = ranked.find(c => c.key === t?.played);
  if (played && played.rank > SHOWN_ROWS) rows.push(played);
  let msg = '';
  if (!here) msg = reviewing() ? 'The game ended here. Step back to analyse a move.' : 'Analysis starts on your move.';
  else if (analysis.error) msg = analysis.error;
  else if (analysis.paused && !rows.length) msg = 'Paused.';
  else if (!rows.length) msg = analysis.running ? 'Analyzing…' : 'No suggestions.';
  $('an-msg').textContent = msg;
  $('an-msg').hidden = !msg;

  const canPick = legalHere().length > 0;
  $('an-rows').replaceChildren(...rows.map(c => {
    const li = document.createElement('li');
    li.dataset.key = c.key;
    if (c.key === analysis.hovered) li.classList.add('hovered');
    if (c === played) { li.classList.add('played'); li.title = 'The move played in the game'; }
    const cell = (cls, text) => { const el = document.createElement('span'); el.className = cls; el.textContent = text; return el; };
    const cp = cell('an-cp', fmtCp(c.cp));
    if (c.cp > 20) cp.classList.add('pos'); else if (c.cp < -20) cp.classList.add('neg');
    li.append(cell('an-rank', c.rank), cell('an-move', c.text), cp, cell('an-prob', c.prob == null || analysis.single ? '' : Math.round(c.prob * 100) + '%'));
    if (canPick) li.title = (li.title ? li.title + '. ' : '') + 'Click to pick up this piece';
    return li;
  }));
  $('an-rows').classList.toggle('stale', analysis.paused);

  renderStepper();
}

// What the boards are, when they are not every position that fits what was seen.
const BW_WARN = {
  lost: 'Rough guess: the set of possible positions was lost, so these boards come from a rule of thumb, in no particular order, and some could never have happened.',
  approx: 'Approximate: the set of possible positions was rebuilt without its history, so it may include impossible boards and their chances are a flat guess.',
  sampled: 'Estimated: there were too many possible positions to keep them all, so these come from a sample of them and the chances are estimates.',
};

function renderStepper() {
  const box = $('bw');
  box.hidden = !worldsShown();
  if (box.hidden) return;
  const w = analysis.worlds;

  // The move options are built once per position, in the order the moves were
  // first ranked, so an open dropdown isn't rebuilt under the pointer.
  // Without a position set there are no chances to order by: the boards are
  // random draws, and the list says so rather than calling them likely.
  const select = $('bw-order');
  const byChance = w.exact ? 'Most likely boards' : 'Sampled boards';
  if (stepper.optionsFor !== analysis.position && analysis.candidates.length) {
    stepper.optionsFor = analysis.position;
    const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
    select.replaceChildren(option('', byChance),
      ...analysis.candidates.filter(c => w.moves?.includes(c.key)).map(c => option(c.key, `Best for ${c.text}`)));
  } else if (!select.options.length) {
    select.replaceChildren(new Option(byChance, ''));
  }
  select.value = stepper.order;

  const rows = worldRows();
  stepper.n = Math.max(1, Math.min(stepper.n, rows.length));
  const input = $('bw-n');
  input.max = Math.max(1, rows.length);
  if (document.activeElement !== input) input.value = stepper.n;
  $('bw-of').textContent = `/ ${rows.length}`;
  $('bw-prev').disabled = stepper.n <= 1;
  $('bw-next').disabled = stepper.n >= rows.length;

  const r = rows[stepper.n - 1];
  const hidden = r?.w.hidden?.length ?? 0;
  $('bw-label').textContent = !r ? 'No boards yet.'
    : stepper.order ? `The move ranks #${r.rank} of ${r.w.cp.length} here · ${fmtCp(r.cp)}`
    : `${r.w.prob != null ? fmtPct(r.w.prob) + ' likely' : 'A sampled board'} · ${hidden} hidden piece${hidden === 1 ? '' : 's'}`;
  $('bw-scope').textContent = stepper.order
    ? `${rows.length} scored${w.depth ? ` at depth ${w.depth}` : ''}`
    : (w.total && w.total > rows.length ? `top ${rows.length} of ${fmtNum(w.total)}` : '');
  const warn = !w.exact ? BW_WARN.lost : w.approx ? BW_WARN.approx : w.sampled ? BW_WARN.sampled : null;
  $('bw-warn').hidden = !warn;
  $('bw-warn').textContent = warn ?? '';
}

function stepTo(n) {
  const len = worldRows().length;
  const next = Math.max(1, Math.min(len || 1, n));
  if (next === stepper.n) return;
  stepper.n = next;
  renderBoard();
  renderStepper();
}

// Arrows for the top few moves, strongest first; the row under the pointer is
// drawn over them and the rest fade. Your own yellow arrows go on top, with
// the one being drawn fainter.
function renderArrows() {
  const svg = $('arrows');
  const show = analysis.on && !analysis.paused && !!target() && boardOnTarget();
  const top = show ? analysis.candidates.slice(0, ARROWS) : [];
  const hovered = show && analysis.hovered ? analysis.candidates.find(c => c.key === analysis.hovered) : null;
  const list = top.map((c, i) => ({ ...c, opacity: hovered ? 0.18 : [0.8, 0.5, 0.32][i], w: 0.08 }));
  if (hovered) list.push({ ...hovered, opacity: 0.9, w: 0.1 });
  for (const key of arrows) list.push({ from: key.slice(0, 2), to: key.slice(2), opacity: 0.85, w: 0.09, mine: true });
  if (sketch?.to) list.push({ from: sketch.from, to: sketch.to, opacity: 0.5, w: 0.09, mine: true });
  const order = squaresInOrder();
  const centre = sq => { const i = order.indexOf(sq); return [i % 8 + 0.5, Math.floor(i / 8) + 0.5]; };
  svg.replaceChildren(...list.filter(a => a.from && a.to && a.from !== a.to).map(({ from, to, opacity, w, mine }) => {
    const [x1, y1] = centre(from);
    const [x2, y2] = centre(to);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len, px = -uy, py = ux;
    const head = Math.min(0.38, len * 0.6), hw = w * 2.6;
    const bx = x2 - ux * head, by = y2 - uy * head;
    const pts = [
      [x1 + px * w, y1 + py * w], [bx + px * w, by + py * w], [bx + px * hw, by + py * hw], [x2, y2],
      [bx - px * hw, by - py * hw], [bx - px * w, by - py * w], [x1 - px * w, y1 - py * w],
    ];
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', pts.map(p => p.map(v => v.toFixed(3)).join(',')).join(' '));
    poly.setAttribute('class', mine ? 'arrow mine' : 'arrow');
    poly.style.opacity = opacity;
    return poly;
  }));
}

// --- markers, circles and arrows --------------------------------------------
//
// Your own notes on the board, kept per game in this browser: a guessed piece
// on a dark square, and yellow rings and arrows anywhere, the way the Battle
// Simulator draws them. Rings and arrows are about squares, not the position,
// so they stay put as you step back through the game or review it.

const markerKey = () => `fog-chess:markers:${view.id}`;
const circleKey = () => `fog-chess:circles:${view.id}`;
const arrowKey = () => `fog-chess:arrows:${view.id}`;

function loadMarkers() {
  try { markers = JSON.parse(store.get(markerKey()) ?? '{}') ?? {}; } catch { markers = {}; }
  try { circles = new Set(JSON.parse(store.get(circleKey()) ?? '[]')); } catch { circles = new Set(); }
  try { arrows = new Set(JSON.parse(store.get(arrowKey()) ?? '[]')); } catch { arrows = new Set(); }
}

// True if sq took a marker: a dark square in the game as it stands.
function cycleMarker(sq) {
  if (!playing() || plyShown !== null || view.visible.includes(sq)) return false;
  const next = MARKER_CYCLE[(MARKER_CYCLE.indexOf(markers[sq] ?? null) + 1) % MARKER_CYCLE.length];
  if (next) markers[sq] = next; else delete markers[sq];
  store.set(markerKey(), JSON.stringify(markers));
  renderBoard();
  return true;
}

function toggleCircle(sq) {
  if (!view) return;
  if (!circles.delete(sq)) circles.add(sq);
  store.set(circleKey(), JSON.stringify([...circles]));
  renderBoard();
}

function toggleArrow(from, to) {
  if (!view) return;
  if (!arrows.delete(from + to)) arrows.add(from + to);
  store.set(arrowKey(), JSON.stringify([...arrows]));
  renderArrows();
}

// --- moving -----------------------------------------------------------------

const canMove = () => !!view && !view.result && !view.thinking && !busy && plyShown === null;

// The moves that can be made on the board: yours on your turn in a game, or
// in a review, the side to move's from the position shown (see playLine).
function legalHere() {
  if (reviewing()) return busy ? [] : replays.get(lineKeys().slice(0, plyOnBoard()).join(' '))?.data?.legal ?? [];
  return canMove() ? view.legal : [];
}

const sideToMove = () => (plyOnBoard() % 2 === 0 ? 'white' : 'black');
const makeMove = key => (reviewing() ? playLine(key) : play(key));

// Plays the selected piece to sq if that is a legal move; true if it did.
function moveSelectedTo(sq) {
  const options = legalHere().filter(m => m.from === selected && m.to === sq);
  if (options.length === 1) { makeMove(options[0].key); return true; }
  if (options.length > 1) { askPromotion(options); return true; }
  return false;
}

function onSquare(sq) {
  const legal = legalHere();
  if (!legal.length) return;
  if (selected && moveSelectedTo(sq)) return;
  selected = legal.some(m => m.from === sq) && selected !== sq ? sq : null;
  renderBoard();
}

// --- dragging ---------------------------------------------------------------
//
// A press on a movable piece becomes a drag once the pointer travels a few
// pixels; short of that it stays a click. The piece follows the pointer as a
// floating copy, so the board can re-render underneath without losing it.

const DRAG_THRESHOLD = 5;

const squareAt = (x, y) => document.elementFromPoint(x, y)?.closest('#board .sq')?.dataset.sq ?? null;

function startDrag(e) {
  const cell = boardEl.querySelector(`.sq[data-sq="${drag.from}"]`);
  const piece = cell?.querySelector('.piece');
  if (!piece) { drag = null; return; }
  const size = cell.getBoundingClientRect().width;
  drag.ghost = img(piece.src, 'drag-ghost');
  drag.ghost.style.width = drag.ghost.style.height = size * 0.88 + 'px';
  document.body.append(drag.ghost);
  document.body.classList.add('dragging');
  selected = drag.from;
  moveDrag(e);
  renderBoard();
}

function moveDrag(e) {
  drag.ghost.style.transform = `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`;
  const over = squareAt(e.clientX, e.clientY);
  if (over === drag.over) return;
  boardEl.querySelector('.sq.drag-over')?.classList.remove('drag-over');
  drag.over = over;
  if (over) boardEl.querySelector(`.sq[data-sq="${over}"]`)?.classList.add('drag-over');
}

function endDrag() {
  drag?.ghost?.remove();
  document.body.classList.remove('dragging');
  drag = null;
}

boardEl.addEventListener('pointerdown', e => {
  suppressClick = false;
  pressHandled = false;
  if (e.button === 2) { startSketch(e); return; }
  if (e.button !== 0 || !e.isPrimary) return;
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq || !legalHere().some(m => m.from === sq)) return;
  endDrag();
  drag = { from: sq, pointerId: e.pointerId, x: e.clientX, y: e.clientY, ghost: null, over: null };
});

window.addEventListener('pointermove', e => {
  if (sketch && e.pointerId === sketch.pointerId) { moveSketch(e); return; }
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.ghost) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < DRAG_THRESHOLD) return;
    startDrag(e);
    if (!drag) return;
  }
  e.preventDefault();
  moveDrag(e);
});

window.addEventListener('pointerup', e => {
  if (sketch && e.pointerId === sketch.pointerId && e.button === 2) { endSketch(e); return; }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dragged = !!drag.ghost;
  endDrag();
  if (!dragged) return; // a plain click: the click handler takes it
  suppressClick = true;
  const to = squareAt(e.clientX, e.clientY);
  // Dropped back where it started, it stays picked up, as after a click.
  if (to && to !== selected && moveSelectedTo(to)) return;
  if (to !== selected) selected = null;
  renderBoard();
});

window.addEventListener('pointercancel', e => {
  if (sketch && e.pointerId === sketch.pointerId) { sketch = null; renderArrows(); return; }
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dragged = !!drag.ghost;
  endDrag();
  if (dragged) { selected = null; renderBoard(); }
});

// --- drawing arrows ----------------------------------------------------------
//
// Right-button press, drag to another square and let go: an arrow between
// them, or off again if it was there. Let go on the same square and it rings
// it instead. The contextmenu this press also fires (on press or on release,
// by platform) is the same press, so pressHandled keeps it from ringing again.

function startSketch(e) {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq || !view) return;
  pressHandled = true;
  sketch = { from: sq, to: sq, pointerId: e.pointerId };
}

function moveSketch(e) {
  const to = squareAt(e.clientX, e.clientY);
  if (to === sketch.to) return;
  sketch.to = to;
  renderArrows();
}

function endSketch(e) {
  const { from } = sketch;
  const to = squareAt(e.clientX, e.clientY);
  sketch = null;
  if (to === from) toggleCircle(from);
  else if (to) toggleArrow(from, to);
  else renderArrows();
}

function askPromotion(options) {
  promotionEl.replaceChildren(...PROMOTIONS.map(type => {
    const option = options.find(m => m.promote === type);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Promote to ' + type);
    button.append(img(pieceSrc(sideToMove(), type), ''));
    button.addEventListener('click', () => { promotionEl.hidden = true; makeMove(option.key); });
    return button;
  }));
  promotionEl.hidden = false;
  promotionEl.querySelector('button').focus();
}

async function play(key) {
  endDrag();
  selected = null;
  busy = true;
  stopAnalysis();
  renderBoard();
  const mine = epoch;
  try {
    const next = await api(`${API}/${view.id}/move`, { method: 'POST', body: { key } });
    if (mine !== epoch) return;
    window.playChessMoveSound?.();
    show(next);
  } catch (error) {
    statusEl.textContent = error.message;
    if (mine === epoch) { busy = false; startAnalysis(); }
  } finally {
    if (mine === epoch) busy = false;
  }
}

// Take a view from the server and, while the AI is thinking, long-poll until
// it has moved.
async function show(next) {
  if (next.result) { finish(next); return; }
  view = next;
  belief = null;
  syncAnalysis();
  flashes = next.events.filter(e => e.kind === 'captured').map(e => e.square);
  render();
  if (next.thinking) {
    const mine = epoch;
    try {
      const after = await api(`${API}/${next.id}?wait=1`);
      if (mine !== epoch) return;
      if (after.moves.length > next.moves.length) window.playChessMoveSound?.();
      return show(after);
    } catch (error) {
      if (mine === epoch) statusEl.textContent = 'Lost contact with the server: ' + error.message;
      return;
    }
  }
  startAnalysis();
  refreshBelief();
}

// A game that ends is kept, and stays on the board as a review of itself, from
// its last position: the moves, what was taken and the analysis stay, and the
// setup cards come back beside it for the next one.
function finish(next) {
  const mine = epoch;
  clearTimeout(reviewTimer);
  endDrag();
  selected = null;
  plyShown = null;
  line = null;
  belief = null;
  promotionEl.hidden = true;
  view = { ...next, endedAt: Date.now(), review: true };
  flashes = next.events.filter(e => e.kind === 'captured').map(e => e.square);
  syncAnalysis();
  render();
  startAnalysis();
  refreshBelief();
  loadMoves();
  saveGame(next).then(record => {
    // A reload that finds the game over keeps the first save's time.
    if (record && mine === epoch) view.endedAt = record.endedAt;
    renderArchive();
  });
}

async function newGame(color, strength) {
  leaveGame();
  const game = await api(API, { method: 'POST', body: { color, ...strength } });
  store.set('fog-chess:game', game.id);
  view = game;
  loadMarkers();
  show(game);
}

async function resign() {
  if (!view || view.result || !confirm('Resign this game?')) return;
  const mine = epoch;
  try {
    const next = await api(`${API}/${view.id}/resign`, { method: 'POST' });
    if (mine !== epoch) return;
    epoch++; // drop the long-poll for the AI move being abandoned
    stopAnalysis();
    busy = false;
    selected = null;
    promotionEl.hidden = true;
    show(next);
  } catch (error) {
    statusEl.textContent = error.message;
  }
}

// --- wiring -----------------------------------------------------------------

// With nothing picked up, a dark square takes a marker; otherwise a click plays
// or picks up, and anywhere else puts the piece down.
boardEl.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq || (!selected && cycleMarker(sq))) return;
  onSquare(sq);
});

// Right-click rings a square (see drawing arrows), and long-press does on touch
// screens. Some of those fire contextmenu on a long press as well, so one press
// rings once.
let pressTimer = null;
let pressHandled = false;
function pressCircle(sq) {
  clearTimeout(pressTimer);
  pressTimer = null;
  if (pressHandled) return;
  pressHandled = true;
  toggleCircle(sq);
}

boardEl.addEventListener('contextmenu', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq) return;
  e.preventDefault();
  pressCircle(sq);
});

boardEl.addEventListener('touchstart', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq) return;
  // The finger lifting may still count as a tap, which must not also mark or move.
  pressTimer = setTimeout(() => { suppressClick = true; pressCircle(sq); }, 500);
}, { passive: true });
for (const type of ['touchend', 'touchmove', 'touchcancel']) {
  boardEl.addEventListener(type, () => { clearTimeout(pressTimer); pressTimer = null; });
}

promotionEl.addEventListener('click', e => {
  if (e.target === promotionEl) { promotionEl.hidden = true; selected = null; renderBoard(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { promotionEl.hidden = true; selected = null; renderBoard(); }
  const step = { ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity }[e.key];
  if (!step || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || !promotionEl.hidden) return;
  if (e.target.closest?.('input, select, textarea')) return; // the arrows move the caret or the number there
  e.preventDefault();
  stepHistory(step);
});

$('moves').addEventListener('click', e => {
  const ply = e.target.closest('[data-ply]')?.dataset.ply;
  if (ply) showPly(Number(ply));
});

// AI strength: a mode (a fixed amount of reasoning, or a time limit) and a
// number for each. Both numbers are remembered, so switching modes back and
// forth keeps what was typed.
const modeEl = $('strength-mode');
const powerEl = $('power');
const timeEl = $('time-ms');
modeEl.value = store.get('fog-chess:mode') ?? modeEl.value;
powerEl.value = store.get('fog-chess:power') ?? store.get('fog-chess:difficulty') ?? powerEl.value;
timeEl.value = store.get('fog-chess:time-ms') ?? timeEl.value;

function showMode() {
  const time = modeEl.value === 'time';
  $('power-field').hidden = $('power-hint').hidden = time;
  $('time-field').hidden = $('time-hint').hidden = !time;
  // A disabled input is skipped by form validation, so only the visible one is checked.
  powerEl.disabled = time;
  timeEl.disabled = !time;
}
showMode();
modeEl.addEventListener('change', () => { store.set('fog-chess:mode', modeEl.value); showMode(); });
powerEl.addEventListener('change', () => store.set('fog-chess:power', powerEl.value));
timeEl.addEventListener('change', () => store.set('fog-chess:time-ms', timeEl.value));

const strength = () => modeEl.value === 'time'
  ? { mode: 'time', timeMs: Number(timeEl.value) }
  : { mode: 'power', power: Number(powerEl.value) };

beliefToggle.checked = store.get('fog-chess:belief') === '1';
beliefToggle.addEventListener('change', () => {
  store.set('fog-chess:belief', beliefToggle.checked ? '1' : '0');
  refreshBelief();
});

$('new-game').addEventListener('submit', e => {
  e.preventDefault();
  const color = new FormData(e.target).get('color');
  newGame(color, strength()).catch(error => { statusEl.textContent = error.message; });
});

// Picking a side previews it, unless a game is on the board: a finished one
// stays until it is closed or the next one starts.
$('new-game').addEventListener('change', e => {
  if (e.target.name !== 'color' || view) return;
  render();
});

$('resign').addEventListener('click', resign);

$('archive-list').addEventListener('click', async e => {
  const open = e.target.closest('[data-open]')?.dataset.open;
  if (open) { openReview(open); return; }
  const id = e.target.closest('[data-delete]')?.dataset.delete;
  if (!id || !confirm('Delete this game?')) return;
  await deleteGame(id);
  // A reload would otherwise pick it back up from the server and keep it again.
  if (store.get('fog-chess:game') === id) store.set('fog-chess:game', '');
  renderArchive();
});

$('review-close').addEventListener('click', closeReview);
$('review-line').addEventListener('click', leaveLine);

$('review-fog').addEventListener('click', e => {
  const fog = e.target.closest('[data-fog]')?.dataset.fog;
  if (!fog || fog === reviewFog) return;
  reviewFog = fog;
  store.set('fog-chess:review-fog-side', fog);
  render();
  refreshBelief();
});

$('an-on').addEventListener('click', () => setAnalysisOn(true));
$('an-off').addEventListener('click', () => setAnalysisOn(false));
$('an-pause').addEventListener('click', () => setPaused(!analysis.paused));

const rowsEl = $('an-rows');
function hoverRow(key) {
  if (key === analysis.hovered) return;
  analysis.hovered = key;
  for (const li of rowsEl.children) li.classList.toggle('hovered', li.dataset.key === key);
  renderArrows();
}
rowsEl.addEventListener('mouseover', e => hoverRow(e.target.closest('li')?.dataset.key ?? null));
rowsEl.addEventListener('mouseleave', () => hoverRow(null));
// Picks the piece up rather than playing the move: a stray click on a
// suggestion should not spend your turn.
rowsEl.addEventListener('click', e => {
  const c = analysis.candidates.find(m => m.key === e.target.closest('li')?.dataset.key);
  if (!c || !legalHere().some(m => m.key === c.key)) return;
  selected = c.from;
  renderBoard();
});

$('bw-order').addEventListener('change', e => { stepper.order = e.target.value; stepper.n = 1; renderBoard(); renderStepper(); });
$('bw-prev').addEventListener('click', () => stepTo(stepper.n - 1));
$('bw-next').addEventListener('click', () => stepTo(stepper.n + 1));
$('bw-n').addEventListener('change', e => stepTo(parseInt(e.target.value, 10) || 1));

// Pick the last game back up after a reload. If there is none (or the server
// was restarted and forgot it — games live in memory), show the setup card.
renderArchive();
(async () => {
  const id = store.get('fog-chess:game');
  if (id) {
    try {
      view = await api(`${API}/${id}`);
      loadMarkers();
      return show(view);
    } catch { /* fall through to the setup card */ }
  }
  render();
})();
