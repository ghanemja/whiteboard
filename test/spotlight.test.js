// Where the tour's card goes (src/engine/spotlight.js): beside its target, on screen, off what's lit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EDGE, GAP, overlap, placeCard } from "../src/engine/spotlight.js";

const view = { w: 1280, h: 800 };
const card = { w: 340, h: 260 };
const inside = (p) => p.x >= EDGE && p.y >= EDGE && p.x + card.w <= view.w - EDGE && p.y + card.h <= view.h - EDGE;

test("overlap is the shared area", () => {
  assert.equal(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), 25);
  assert.equal(overlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 }), 0);
});

test("right of the target first, at its height, with the arrow pointing at it", () => {
  const tab = { x: 200, y: 300, w: 100, h: 30 };
  const p = placeCard(tab, card, view);
  assert.equal(p.side, "right");
  assert.equal(p.x, 300 + GAP);
  assert.equal(p.y + p.caret, 315, "the arrow is level with the target's middle");
  assert.ok(inside(p));
});

test("then below, left and above, when there's no room", () => {
  assert.equal(placeCard({ x: 1100, y: 100, w: 120, h: 30 }, card, view).side, "below", "too near the right edge");
  assert.equal(placeCard({ x: 1100, y: 600, w: 120, h: 40 }, card, view).side, "left", "and near the bottom");
  assert.equal(placeCard({ x: 20, y: 600, w: 1240, h: 40 }, card, view).side, "above", "a wide strip near the bottom");
});

test("never off screen: a target at the bottom keeps the card in, the arrow still on its edge", () => {
  const key = { x: 410, y: 770, w: 870, h: 30 };
  const p = placeCard(key, card, view);
  assert.equal(p.side, "left");
  assert.ok(inside(p));
  assert.ok(p.caret <= card.h - 18 && p.caret >= 18);
});

test("off what's lit: a card beside the Chat & log tab goes below it, not over the lit board", () => {
  const tab = { x: 20, y: 280, w: 110, h: 34 };
  const board = { x: 410, y: 220, w: 870, h: 580, weight: 10 };
  const p = placeCard(tab, card, view, [board]);
  assert.equal(p.side, "below");
  assert.equal(overlap({ ...p, ...card }, board), 0);
});

test("the board itself: the card sits beside it, over the panel", () => {
  const board = { x: 410, y: 220, w: 870, h: 580 };
  const p = placeCard(board, card, view, [{ ...board, weight: 10 }]);
  assert.equal(p.side, "left");
  assert.equal(p.x, 410 - GAP - card.w);
});

test("nothing to point at, or no room anywhere: in the middle", () => {
  assert.deepEqual(placeCard(null, card, view), { side: "center", x: 470, y: 270, caret: 0 });
  assert.equal(placeCard({ x: 0, y: 0, w: 1280, h: 800 }, card, view).side, "center");
});
