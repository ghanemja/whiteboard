// Where the tour's card goes: beside what the step points at, fully on screen, and off what's
// lit. Pure geometry (rects are { x, y, w, h } in window pixels), so it's tested without a browser.

export const GAP = 18; // from the target's edge to the card's: the card's arrow sits in it
export const EDGE = 12; // the card keeps this far from the window's edges

const SIDES = ["right", "below", "left", "above"];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

// The area two rects share (0 when apart).
export function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

// anchor: what the card points at (null: nothing). card: its { w, h }. view: the window's { w, h }.
// avoid: [{ x, y, w, h, weight }], what it shouldn't cover (the other targets, the lit areas).
// Tries right, below, left and above, in that order: the first side with room that covers
// nothing wins, else the side that covers least. Returns { side, x, y, caret }, where caret is
// how far along the card's facing edge its arrow sits; side "center" when there's no anchor or
// no side has room.
export function placeCard(anchor, card, view, avoid = []) {
  const center = { side: "center", x: Math.round(Math.max(EDGE, (view.w - card.w) / 2)), y: Math.round(Math.max(EDGE, (view.h - card.h) / 2)), caret: 0 };
  if (!anchor) return center;
  const cx = anchor.x + anchor.w / 2, cy = anchor.y + anchor.h / 2;
  const across = { x: clamp(cx - card.w / 2, EDGE, view.w - EDGE - card.w), y: clamp(cy - card.h / 2, EDGE, view.h - EDGE - card.h) };
  const at = {
    right: [anchor.x + anchor.w + GAP, across.y],
    below: [across.x, anchor.y + anchor.h + GAP],
    left: [anchor.x - GAP - card.w, across.y],
    above: [across.x, anchor.y - GAP - card.h],
  };
  let best = null;
  for (const side of SIDES) {
    const [x, y] = at[side];
    if (x < EDGE || y < EDGE || x + card.w > view.w - EDGE || y + card.h > view.h - EDGE) continue;
    const box = { x, y, w: card.w, h: card.h };
    const cost = avoid.reduce((sum, a) => sum + overlap(box, a) * (a.weight ?? 1), 0);
    if (!best || cost < best.cost) best = { side, x, y, cost };
    if (!cost) break;
  }
  if (!best) return center;
  const caret = best.side === "right" || best.side === "left" ? clamp(cy - best.y, 18, card.h - 18) : clamp(cx - best.x, 18, card.w - 18);
  return { side: best.side, x: Math.round(best.x), y: Math.round(best.y), caret: Math.round(caret) };
}
