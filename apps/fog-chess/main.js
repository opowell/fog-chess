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
let drag = null; // a piece being dragged: { from, pointerId, x, y, ghost, over }
let suppressClick = false; // the click that ends a drag is not a second tap

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
  renderPanels();
  renderAnalysis();
}

// Setting up a game and playing one are separate modes: while a game is on,
// the setup card (title, new-game form, rules) gives way to the in-game card.
function renderPanels() {
  const playing = !!view && !view.result;
  $('setup').hidden = playing;
  $('in-game').hidden = !playing;
  if (playing) {
    const { mode, power, timeMs } = view.strength ?? {};
    const ai = mode === 'time' ? `AI time ${timeMs} ms a move` : mode === 'power' ? `AI power ${power}` : null;
    $('game-info').textContent = `You play ${view.humanColor}.` + (ai ? ` ${ai}.` : '');
  }
}

function renderBoard() {
  const visible = new Set(view?.visible ?? []);
  const legal = view?.legal ?? [];
  const targets = new Set(selected ? legal.filter(m => m.from === selected).map(m => m.to) : []);
  const movable = new Set(legal.map(m => m.from));
  const order = squaresInOrder();
  const ghosts = new Map((currentWorld()?.hidden ?? []).map(h => [h.sq, TYPE_OF_LETTER[h.type]]));
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
    if (drag?.ghost && sq === drag.from) cell.classList.add('drag-from');
    if (drag?.ghost && sq === drag.over) cell.classList.add('drag-over');
    if (view?.lastMove && (sq === view.lastMove.from || sq === view.lastMove.to)) cell.classList.add('last');
    if (flashes.includes(sq)) cell.classList.add('flash');

    let label = sq;
    if (piece) {
      cell.append(img(pieceSrc(piece.color, piece.type), 'piece'));
      label += `, ${piece.color} ${piece.type}`;
    } else if (fogged && ghosts.has(sq)) {
      cell.append(img(pieceSrc(view.aiColor, ghosts.get(sq)), 'piece ghost'));
      label += `, hidden, on the analysis board: ${ghosts.get(sq)}`;
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
  position: null,    // `${game}:${turn}`: what the results below are about
  candidates: [],    // ranked: [{ key, text, from, to, cp, prob }]
  worlds: null,      // { total, approx, depth, moves, list: [{ id, prob, cp, hidden }] }
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
const analysisWanted = () => analysis.on && !analysis.paused && playing() && !view.thinking && !busy;

function stopAnalysis() {
  analysis.source?.close();
  analysis.source = null;
  analysis.running = false;
}

// A new position makes whatever is on screen wrong, so it goes at once.
function syncAnalysis() {
  const position = view ? `${view.id}:${view.turn}` : null;
  if (position === analysis.position) return;
  stopAnalysis();
  Object.assign(analysis, { position, candidates: [], worlds: null, progress: null, single: false, error: '', hovered: null });
  Object.assign(stepper, { order: '', n: 1, optionsFor: null });
}

// Resuming on the same turn picks the walk up where it stopped (the server
// keeps its place), so what is on screen stays until something newer arrives.
function startAnalysis() {
  stopAnalysis();
  syncAnalysis();
  if (!analysisWanted()) { renderAnalysis(); return; }
  const source = new EventSource(`${API}/${view.id}/analysis`);
  analysis.source = source;
  analysis.running = true;
  analysis.error = '';
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

const worldsShown = () => analysis.on && !analysis.paused && playing() && !view.thinking && !!analysis.worlds?.list?.length;

function currentWorld() {
  if (!worldsShown()) return null;
  const rows = worldRows();
  return rows[Math.min(stepper.n, rows.length) - 1]?.w ?? null;
}

function renderAnalysis() {
  const section = $('analysis');
  section.hidden = !playing();
  if (section.hidden) return;
  $('an-on').classList.toggle('on', analysis.on);
  $('an-off').classList.toggle('on', !analysis.on);
  $('an-body').hidden = !analysis.on;
  $('an-spinner').hidden = !analysis.on || !analysis.running;
  if (!analysis.on) return;

  const pause = $('an-pause');
  pause.textContent = analysis.paused ? '► Resume' : '❙❙ Pause';
  pause.classList.toggle('on', analysis.paused);
  pause.disabled = view.thinking;
  $('an-progress').textContent = analysis.paused ? '' : (analysis.progress ?? '');

  const rows = view.thinking ? [] : analysis.candidates.slice(0, SHOWN_ROWS);
  let msg = '';
  if (view.thinking) msg = 'Analysis starts on your move.';
  else if (analysis.error) msg = analysis.error;
  else if (analysis.paused && !rows.length) msg = 'Paused.';
  else if (!rows.length) msg = analysis.running ? 'Analyzing…' : 'No suggestions.';
  $('an-msg').textContent = msg;
  $('an-msg').hidden = !msg;

  $('an-rows').replaceChildren(...rows.map((c, i) => {
    const li = document.createElement('li');
    li.dataset.key = c.key;
    if (c.key === analysis.hovered) li.classList.add('hovered');
    const cell = (cls, text) => { const el = document.createElement('span'); el.className = cls; el.textContent = text; return el; };
    const cp = cell('an-cp', fmtCp(c.cp));
    if (c.cp > 20) cp.classList.add('pos'); else if (c.cp < -20) cp.classList.add('neg');
    li.append(cell('an-rank', i + 1), cell('an-move', c.text), cp, cell('an-prob', c.prob == null || analysis.single ? '' : Math.round(c.prob * 100) + '%'));
    li.title = 'Click to pick up this piece';
    return li;
  }));
  $('an-rows').classList.toggle('stale', analysis.paused);

  renderStepper();
}

function renderStepper() {
  const box = $('bw');
  box.hidden = !worldsShown();
  if (box.hidden) return;
  const w = analysis.worlds;

  // The move options are built once per position, in the order the moves were
  // first ranked, so an open dropdown isn't rebuilt under the pointer.
  const select = $('bw-order');
  if (stepper.optionsFor !== analysis.position && analysis.candidates.length) {
    stepper.optionsFor = analysis.position;
    const option = (value, text) => { const o = document.createElement('option'); o.value = value; o.textContent = text; return o; };
    select.replaceChildren(option('', 'Most likely boards'),
      ...analysis.candidates.filter(c => w.moves?.includes(c.key)).map(c => option(c.key, `Best for ${c.text}`)));
  } else if (!select.options.length) {
    select.replaceChildren(new Option('Most likely boards', ''));
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
  $('bw-warn').hidden = !w.approx;
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
// drawn over them and the rest fade.
function renderArrows() {
  const svg = $('arrows');
  const show = analysis.on && !analysis.paused && playing() && !view.thinking;
  const top = show ? analysis.candidates.slice(0, ARROWS) : [];
  const hovered = show && analysis.hovered ? analysis.candidates.find(c => c.key === analysis.hovered) : null;
  const list = top.map((c, i) => ({ c, opacity: hovered ? 0.18 : [0.8, 0.5, 0.32][i] }));
  if (hovered) list.push({ c: hovered, opacity: 0.9, hovered: true });
  const order = squaresInOrder();
  const centre = sq => { const i = order.indexOf(sq); return [i % 8 + 0.5, Math.floor(i / 8) + 0.5]; };
  svg.replaceChildren(...list.filter(({ c }) => c.from && c.to && c.from !== c.to).map(({ c, opacity, hovered }) => {
    const [x1, y1] = centre(c.from);
    const [x2, y2] = centre(c.to);
    const len = Math.hypot(x2 - x1, y2 - y1);
    const ux = (x2 - x1) / len, uy = (y2 - y1) / len, px = -uy, py = ux;
    const w = hovered ? 0.1 : 0.08, head = Math.min(0.38, len * 0.6), hw = w * 2.6;
    const bx = x2 - ux * head, by = y2 - uy * head;
    const pts = [
      [x1 + px * w, y1 + py * w], [bx + px * w, by + py * w], [bx + px * hw, by + py * hw], [x2, y2],
      [bx - px * hw, by - py * hw], [bx - px * w, by - py * w], [x1 - px * w, y1 - py * w],
    ];
    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', pts.map(p => p.map(v => v.toFixed(3)).join(',')).join(' '));
    poly.setAttribute('class', 'arrow');
    poly.style.opacity = opacity;
    return poly;
  }));
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

const canMove = () => !!view && !view.result && !view.thinking && !busy;

// Plays the selected piece to sq if that is a legal move; true if it did.
function moveSelectedTo(sq) {
  const options = view.legal.filter(m => m.from === selected && m.to === sq);
  if (options.length === 1) { play(options[0].key); return true; }
  if (options.length > 1) { askPromotion(options); return true; }
  return false;
}

function onSquare(sq) {
  if (!canMove()) return;
  if (selected && moveSelectedTo(sq)) return;
  selected = view.legal.some(m => m.from === sq) && selected !== sq ? sq : null;
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
  if (e.button !== 0 || !e.isPrimary || !canMove()) return;
  const sq = e.target.closest('.sq')?.dataset.sq;
  if (!sq || !view.legal.some(m => m.from === sq)) return;
  endDrag();
  drag = { from: sq, pointerId: e.pointerId, x: e.clientX, y: e.clientY, ghost: null, over: null };
});

window.addEventListener('pointermove', e => {
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
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dragged = !!drag.ghost;
  endDrag();
  if (!dragged) return; // a plain click: the click handler takes it
  suppressClick = true;
  const to = squareAt(e.clientX, e.clientY);
  // Dropped back where it started, it stays picked up, as after a click.
  if (to && to !== selected && canMove() && moveSelectedTo(to)) return;
  if (to !== selected) selected = null;
  renderBoard();
});

window.addEventListener('pointercancel', e => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dragged = !!drag.ghost;
  endDrag();
  if (dragged) { selected = null; renderBoard(); }
});

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

async function newGame(color, strength) {
  epoch++;
  stopAnalysis();
  busy = false;
  selected = null;
  promotionEl.hidden = true;
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

boardEl.addEventListener('click', e => {
  if (suppressClick) { suppressClick = false; return; }
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

$('resign').addEventListener('click', resign);

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
  if (!c || !view || view.thinking || busy) return;
  selected = c.from;
  renderBoard();
});

$('bw-order').addEventListener('change', e => { stepper.order = e.target.value; stepper.n = 1; renderBoard(); renderStepper(); });
$('bw-prev').addEventListener('click', () => stepTo(stepper.n - 1));
$('bw-next').addEventListener('click', () => stepTo(stepper.n + 1));
$('bw-n').addEventListener('change', e => stepTo(parseInt(e.target.value, 10) || 1));

// Pick the last game back up after a reload. If there is none (or the server
// was restarted and forgot it — games live in memory), show the setup card.
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
