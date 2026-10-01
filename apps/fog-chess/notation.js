// A finished game's moves written out for other programs: PGN (standard
// algebraic, with fog chess's own tags), the move list as the page shows it,
// and UCI coordinates. Only a review has every move and every true board, so
// only a review is written out. Pure functions of the history, so the tests
// can run them without a page.
//
// A game here is { plies, moves, humanColor, strength, endedAt, result, from }:
// plies[i].board is the true board after ply i (plies[0] the start), with
// lastMove { from, to } the move that made it; moves[i - 1] is that move as
// the move list names it; from is where your own line leaves the game, if it
// does.

const LETTER = { king: 'K', queen: 'Q', rook: 'R', bishop: 'B', knight: 'N', pawn: '' };
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const ORTHO = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const SLIDES = { rook: ORTHO, bishop: DIAG, queen: [...ORTHO, ...DIAG] };

const fileOf = sq => sq.charCodeAt(0) - 97;
const rankOf = sq => Number(sq[1]) - 1;
const square = (f, r) => (f >= 0 && f < 8 && r >= 0 && r < 8 ? String.fromCharCode(97 + f) + (r + 1) : null);

// Whether the piece on sq could move to `to` on this board. There is no check
// in fog chess, so this is the whole of what SAN has to tell apart.
function reaches(board, sq, to) {
  const { type } = board[sq];
  const df = fileOf(to) - fileOf(sq);
  const dr = rankOf(to) - rankOf(sq);
  if (type === 'knight') return KNIGHT.some(([f, r]) => f === df && r === dr);
  if (type === 'king') return Math.max(Math.abs(df), Math.abs(dr)) === 1;
  const dirs = SLIDES[type];
  if (!dirs) return false;
  for (const [f, r] of dirs) {
    for (let at = square(fileOf(sq) + f, rankOf(sq) + r); at; at = square(fileOf(at) + f, rankOf(at) + r)) {
      if (at === to) return true;
      if (board[at]) break;
    }
  }
  return false;
}

// Standard algebraic notation for the move from → to, given the boards either
// side of it. No + or #: there is no check to mark.
export function san(before, after, from, to) {
  const piece = before[from];
  if (piece.type === 'king' && Math.abs(fileOf(to) - fileOf(from)) === 2) {
    return fileOf(to) > fileOf(from) ? 'O-O' : 'O-O-O';
  }
  const capture = !!before[to] || (piece.type === 'pawn' && from[0] !== to[0]);
  if (piece.type === 'pawn') {
    const promoted = after[to] && after[to].type !== 'pawn' ? '=' + LETTER[after[to].type] : '';
    return (capture ? from[0] + 'x' : '') + to + promoted;
  }
  const rivals = Object.keys(before).filter(sq => sq !== from && before[sq].type === piece.type
    && before[sq].color === piece.color && reaches(before, sq, to));
  let which = '';
  if (rivals.length) {
    if (!rivals.some(sq => sq[0] === from[0])) which = from[0];
    else if (!rivals.some(sq => sq[1] === from[1])) which = from[1];
    else which = from;
  }
  return LETTER[piece.type] + which + (capture ? 'x' : '') + to;
}

// The move that made ply i: from its record, or for older games read back out
// of the move list's own text.
function moveAt(game, i) {
  const last = game.plies[i].lastMove;
  if (last?.from && last?.to) return last;
  const text = game.moves[i - 1]?.text ?? '';
  const squares = text.match(/[a-h][1-8]/g);
  if (squares?.length === 2) return { from: squares[0], to: squares[1] };
  const rank = i % 2 ? '1' : '8';
  if (text.startsWith('O-O-O')) return { from: 'e' + rank, to: 'c' + rank };
  if (text.startsWith('O-O')) return { from: 'e' + rank, to: 'g' + rank };
  throw new Error(`Cannot read move ${i}: ${text || 'hidden'}`);
}

const plyCount = game => game.plies.length - 1;

// Numbered pairs, white first: "1. e4 e5 2. Nf3".
function numbered(names) {
  const out = [];
  names.forEach((name, i) => out.push(i % 2 ? name : `${i / 2 + 1}. ${name}`));
  return out;
}

export function toSan(game) {
  const out = [];
  for (let i = 1; i <= plyCount(game); i++) {
    const { from, to } = moveAt(game, i);
    out.push(san(game.plies[i - 1].board, game.plies[i].board, from, to));
  }
  return out;
}

export function toUci(game) {
  const out = [];
  for (let i = 1; i <= plyCount(game); i++) {
    const { from, to } = moveAt(game, i);
    const before = game.plies[i - 1].board[from];
    const after = game.plies[i].board[to];
    const promoted = before?.type === 'pawn' && after && after.type !== 'pawn' ? LETTER[after.type].toLowerCase() : '';
    out.push(from + to + promoted);
  }
  return out.join(' ') + '\n';
}

// The move list as the page shows it, one move pair a line.
export function toText(game) {
  const lines = [];
  game.moves.forEach((move, i) => {
    const text = move.text ?? '?';
    if (i % 2) lines[lines.length - 1] += ' ' + text;
    else lines.push(`${i / 2 + 1}. ${text}`);
  });
  return lines.join('\n') + '\n';
}

function resultTag(result) {
  if (!result) return '*';
  if (result.outcome === 'draw') return '1/2-1/2';
  return result.winnerId === 'white' ? '1-0' : '0-1';
}

function termination(result) {
  if (!result) return 'Unterminated';
  if (result.outcome === 'draw') return 'Fifty-move rule';
  if (result.reason === 'resigned') return 'Resignation';
  return 'King captured';
}

function pgnDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

// Movetext wrapped at 80 columns, as the PGN standard asks.
function wrap(tokens) {
  const lines = [''];
  for (const token of tokens) {
    const last = lines.length - 1;
    if (lines[last] && lines[last].length + 1 + token.length > 80) lines.push(token);
    else lines[last] += (lines[last] ? ' ' : '') + token;
  }
  return lines.join('\n');
}

export function toPgn(game, aiName = 'Obscuro') {
  const result = resultTag(game.result);
  const own = game.from != null && game.from < plyCount(game);
  const tags = {
    Event: own ? `Fog chess, own line from ply ${game.from}` : 'Fog chess',
    Site: 'Fog Chess',
    Date: pgnDate(game.endedAt ?? Date.now()),
    Round: '-',
    White: game.humanColor === 'white' ? 'You' : aiName,
    Black: game.humanColor === 'black' ? 'You' : aiName,
    Result: result,
    Variant: 'Fog of War',
    Termination: termination(game.result),
  };
  const head = Object.entries(tags).map(([k, v]) => `[${k} "${String(v).replace(/["\\]/g, '\\$&')}"]`).join('\n');
  return `${head}\n\n${wrap([...numbered(toSan(game)), result])}\n`;
}
