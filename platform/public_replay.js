'use strict';

function publicClawHistory(history) {
  return (Array.isArray(history) ? history : []).map((h) => ({
    turn: h.turn,
    side: h.side,
    from: h.from ? h.from.slice() : null,
    to: h.to ? h.to.slice() : null,
    captured: Array.isArray(h.captured) ? h.captured.map((p) => p.slice()) : [],
    pass: !!h.pass,
  }));
}

function publicDarkBoard(board) {
  return board.map((col) => col.map((cell) => {
    if (!cell) return null;
    if (cell.hidden) return { hidden: true };
    return { hidden: false, side: cell.side, kind: cell.kind, power: cell.power };
  }));
}

function publicDarkHistory(history) {
  return (Array.isArray(history) ? history : []).map((h) => ({
    turn: h.turn,
    seat: h.seat,
    action: h.action && h.action.action === 'flip'
      ? { action: 'flip', at: h.action.at.slice() }
      : h.action && h.action.action === 'move'
        ? { action: 'move', from: h.action.from.slice(), to: h.action.to.slice() }
        : null,
    captured: Array.isArray(h.captured) ? h.captured.map((c) => ({ ...c })) : [],
    revealed: h.revealed ? { ...h.revealed } : null,
    pass: !!h.pass,
  }));
}

module.exports = { publicClawHistory, publicDarkBoard, publicDarkHistory };
