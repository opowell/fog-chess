// The fog chess client. It never sees the true board: the server sends the
// human's fog-filtered view (see games.js), and this file only draws it and
// turns clicks into the move keys the server listed as legal.

const API = 'api/games';
const FILES = 'abcdefgh';
const PIECE_FILE = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: 'P' };
const TYPE_OF_LETTER = { k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };
const MARKER_CYCLE = [null, 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'];
const PROMOTIONS = ['queen', 'knight', 'rook', 'bishop'];

const $ = id => document.getElementById(id);
const boardEl = $('board');
const statusEl = $('status');
const promotionEl = $('promotion');
const beliefToggle = $('show-belief');
const beliefNote = $('belief-note');

let view = null;
let selected = null;
let markers = {};
let belief = null;
let flashes = [];
let busy = false; // a move is on its way to the server
let epoch = 0; // bumped on every new game, so a late reply for an old one is dropped

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* private mode */ } },
};

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
const orientation = () => (view?.humanColor === 'black' ? 'black' : 'white');

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
}

function renderBoard() {
  const visible = new Set(view?.visible ?? []);
  const legal = view?.legal ?? [];
  const targets = new Set(selected ? legal.filter(m => m.from === selected).map(m => m.to) : []);
  const movable = new Set(legal.map(m => m.from));
  const order = squaresInOrder();
  const fragment = document.createDocumentFragment();

  order.forEach((sq, i) => {
    const file = sq[0];
    const rank = Number(sq[1]);
    const isDark = (FILES.indexOf(file) + rank) % 2 === 0;
    const fogged = !!view && !view.revealed && !visible.has(sq);
    const piece = view?.board[sq];

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
    if (view?.lastMove && (sq === view.lastMove.from || sq === view.lastMove.to)) cell.classList.add('last');
    if (flashes.includes(sq)) cell.classList.add('flash');

    let label = sq;
    if (piece) {
      cell.append(img(pieceSrc(piece.color, piece.type), 'piece'));
      label += `, ${piece.color} ${piece.type}`;
    } else if (fogged && markers[sq]) {
      cell.append(img(pieceSrc(view.aiColor, markers[sq]), 'piece marker'));
      label += `, hidden, your marker: ${markers[sq]}`;
    } else if (fogged) {
      label += ', hidden';
    }

    const cellBelief = fogged && belief?.squares?.[sq];
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
  if (event.kind === 'blocked') return `A hidden piece blocked your pawn on ${event.square}.`;
  return '';
}

function resultText(result) {
  if (result.outcome === 'draw') return 'Draw: fifty moves without a capture or pawn move.';
  return result.winnerId === view.humanColor
    ? 'You won: you captured the king.'
    : 'You lost: your king was captured.';
}

function renderStatus() {
  statusEl.classList.remove('thinking');
  if (!view) { statusEl.textContent = 'Start a new game.'; return; }
  const news = view.events.map(eventText).filter(Boolean).join(' ');
  if (view.result) {
    statusEl.textContent = resultText(view.result) + ' The whole board is shown.';
  } else if (view.error) {
    statusEl.textContent = 'The AI hit an error: ' + view.error;
  } else if (view.thinking) {
    statusEl.textContent = (news ? news + ' ' : '') + 'Opponent is thinking';
    statusEl.classList.add('thinking');
  } else {
    statusEl.textContent = (news ? news + ' ' : '') + 'Your move.';
  }
}

function renderMoves() {
  const list = $('moves');
  const rows = [];
  const moves = view?.moves ?? [];
  // White always moves first, so plies pair up from the start.
  for (let i = 0; i < moves.length; i += 2) {
    const li = document.createElement('li');
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = i / 2 + 1 + '.';
    li.append(num, moveCell(moves[i]), moveCell(moves[i + 1]));
    rows.push(li);
  }
  list.replaceChildren(...rows);
  list.scrollTop = list.scrollHeight;
}

function moveCell(move) {
  const el = document.createElement('span');
  if (!move) return el;
  if (move.text) el.textContent = move.text;
  else { el.textContent = 'hidden'; el.className = 'hidden'; }
  return el;
}

// --- belief overlay ---------------------------------------------------------

async function refreshBelief() {
  belief = null;
  beliefNote.textContent = '';
  if (!beliefToggle.checked || !view || view.result || view.thinking) { renderBoard(); return; }
  const mine = epoch;
  try {
    const data = await api(`${API}/${view.id}/belief`);
    if (mine !== epoch) return;
    belief = data;
    beliefNote.textContent = data.exact
      ? `Weighing ${data.positions.toLocaleString()} possible position${data.positions === 1 ? '' : 's'}; shading is the chance an enemy piece is on each dark square.`
      : 'There are too many possible positions to track exactly any more.';
  } catch (error) {
    beliefNote.textContent = 'Could not load the belief: ' + error.message;
  }
  renderBoard();
}

// --- markers ----------------------------------------------------------------

const markerKey = () => `fog-chess:markers:${view.id}`;

function loadMarkers() {
  try { markers = JSON.parse(store.get(markerKey()) ?? '{}') ?? {}; } catch { markers = {}; }
}

function cycleMarker(sq) {
  if (!view || view.revealed || view.visible.includes(sq)) return;
  const next = MARKER_CYCLE[(MARKER_CYCLE.indexOf(markers[sq] ?? null) + 1) % MARKER_CYCLE.length];
  if (next) markers[sq] = next; else delete markers[sq];
  store.set(markerKey(), JSON.stringify(markers));
  renderBoard();
}

// --- moving -----------------------------------------------------------------

function onSquare(sq) {
  if (!view || view.result || view.thinking || busy) return;
  const legal = view.legal;
  if (selected) {
    const options = legal.filter(m => m.from === selected && m.to === sq);
    if (options.length === 1) return play(options[0].key);
    if (options.length > 1) return askPromotion(options);
  }
  selected = legal.some(m => m.from === sq) && selected !== sq ? sq : null;
  renderBoard();
}

function askPromotion(options) {
  promotionEl.replaceChildren(...PROMOTIONS.map(type => {
    const option = options.find(m => m.promote === type);
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', 'Promote to ' + type);
    button.append(img(pieceSrc(view.humanColor, type), ''));
    button.addEventListener('click', () => { promotionEl.hidden = true; play(option.key); });
    return button;
  }));
  promotionEl.hidden = false;
  promotionEl.querySelector('button').focus();
}

async function play(key) {
  selected = null;
  busy = true;
  renderBoard();
  const mine = epoch;
  try {
    const next = await api(`${API}/${view.id}/move`, { method: 'POST', body: { key } });
    if (mine !== epoch) return;
    window.playChessMoveSound?.();
    show(next);
  } catch (error) {
    statusEl.textContent = error.message;
  } finally {
    if (mine === epoch) busy = false;
  }
}

// Take a view from the server and, while the AI is thinking, long-poll until
// it has moved.
async function show(next) {
  view = next;
  belief = null;
  flashes = next.events.filter(e => e.kind === 'captured' || e.kind === 'blocked').map(e => e.square);
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
  refreshBelief();
}

async function newGame(color, difficulty) {
  epoch++;
  busy = false;
  selected = null;
  promotionEl.hidden = true;
  const game = await api(API, { method: 'POST', body: { color, difficulty } });
  store.set('fog-chess:game', game.id);
  view = game;
  loadMarkers();
  show(game);
}

// --- wiring -----------------------------------------------------------------

boardEl.addEventListener('click', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (sq) onSquare(sq);
});

boardEl.addEventListener('contextmenu', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq) return;
  e.preventDefault();
  cycleMarker(sq);
});

// Long-press places a marker on touch screens, where there is no right-click.
let pressTimer = null;
boardEl.addEventListener('touchstart', e => {
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq) return;
  pressTimer = setTimeout(() => { pressTimer = null; cycleMarker(sq); }, 500);
}, { passive: true });
for (const type of ['touchend', 'touchmove', 'touchcancel']) {
  boardEl.addEventListener(type, () => { clearTimeout(pressTimer); pressTimer = null; });
}

promotionEl.addEventListener('click', e => {
  if (e.target === promotionEl) { promotionEl.hidden = true; selected = null; renderBoard(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { promotionEl.hidden = true; selected = null; renderBoard(); }
});

const difficulty = $('difficulty');
const difficultyOut = $('difficulty-out');
difficulty.value = store.get('fog-chess:difficulty') ?? difficulty.value;
difficultyOut.value = difficulty.value;
difficulty.addEventListener('input', () => {
  difficultyOut.value = difficulty.value;
  store.set('fog-chess:difficulty', difficulty.value);
});

beliefToggle.checked = store.get('fog-chess:belief') === '1';
beliefToggle.addEventListener('change', () => {
  store.set('fog-chess:belief', beliefToggle.checked ? '1' : '0');
  refreshBelief();
});

$('new-game').addEventListener('submit', e => {
  e.preventDefault();
  const color = new FormData(e.target).get('color');
  newGame(color, Number(difficulty.value)).catch(error => { statusEl.textContent = error.message; });
});

// Pick the last game back up after a reload; start one if there is none (or the
// server was restarted and forgot it — games live in memory).
(async () => {
  const id = store.get('fog-chess:game');
  if (id) {
    try {
      view = await api(`${API}/${id}`);
      loadMarkers();
      return show(view);
    } catch { /* fall through to a new game */ }
  }
  renderBoard();
  newGame('white', Number(difficulty.value)).catch(error => { statusEl.textContent = error.message; });
})();
