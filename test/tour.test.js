// The guided tour's step logic (src/engine/tour.js): which step you're on, when it moves on,
// where it points, and when the demo waits for you.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOARD, TOUR, advance, back, holds, isFresh, next, startTour, stepOf, targets, waiting } from "../src/engine/tour.js";

// The run before anything happens; each step below changes what the person or the demo did.
const base = {
  started: false, stage: null, phase: null, gate: false, selected: [], explainUse: false, edits: 0, answered: 0,
  permission: false, permissions: 0, hovers: 0, view: "board", tab: "activity", testCaused: false, finished: false, reviewOpens: 0,
  firstDecision: null, firstQuestion: null, building: null,
};
const at = (tour) => stepOf(tour).id;

test("every step says what to do, and the ids are unique", () => {
  const ids = TOUR.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of TOUR) {
    assert.ok(s.title && s.text, s.id);
    assert.ok(s.next || s.done, `${s.id} can finish`);
  }
  assert.equal(TOUR[0].id, "welcome");
  assert.ok(TOUR.at(-1).finish);
});

test("a whole tour: each step waits for its action, then moves on by itself", () => {
  let c = { ...base };
  let t = startTour(c);
  assert.equal(at(t), "welcome");
  assert.equal(advance(t, c), t, "Next-only steps wait for Next");
  t = next(t, c);
  assert.equal(at(t), "plans");
  assert.equal(stepOf(t).enter, "demo");

  c = { ...c, started: true, stage: "planning", phase: "planning", firstDecision: "d1", firstQuestion: "q1" };
  assert.equal(advance(t, c), t, "still planning");
  assert.match(waiting(stepOf(t), c), /2×/);
  c = { ...c, gate: true };
  t = advance(t, c);
  assert.equal(at(t), "decision");
  assert.deepEqual(targets(t, c).board, [{ lid: "decision:d1" }], "circled: the card alone says what to do");

  c = { ...c, selected: ["node:api"] };
  assert.equal(at(advance(t, c)), "decision", "a part isn't a decision");
  c = { ...c, selected: ["decision:d1"], explainUse: true };
  t = advance(t, c);
  assert.equal(at(t), "steer");
  assert.deepEqual(targets(t, c).dom.map((d) => d.sel), ['[data-tour="use-this"]', '[data-tour="glass"]', '[data-tour="stickers"]'], "Use this, or the glass (up) or Stickers (down)");
  assert.deepEqual(targets(t, c).board, [], "the card is open: point at Use this, not the board");

  c = { ...c, edits: 1 };
  t = advance(t, c);
  assert.equal(at(t), "answer");
  assert.deepEqual(targets(t, c).board, [{ lid: "question:q1" }]);
  // Answering makes it reply, so the plan isn't waiting for a moment.
  c = { ...c, answered: 1, gate: false };
  t = advance(t, c);
  assert.equal(at(t), "approve");
  assert.ok(waiting(stepOf(t), c));
  assert.deepEqual(targets(t, c).dom, []);
  c = { ...c, gate: true };
  assert.equal(waiting(stepOf(t), c), null);
  c = { ...c, gate: false, stage: "building", phase: "implementation", edits: 0, building: "api" };
  t = advance(t, c);
  assert.equal(at(t), "build");
  assert.deepEqual(targets(t, c).board, [{ lid: "node:api" }]);

  c = { ...c, hovers: 3 };
  t = advance(t, c);
  assert.equal(at(t), "permission");
  c = { ...c, permission: true };
  assert.equal(advance(t, c), t);
  c = { ...c, permission: false, permissions: 1 };
  t = advance(t, c);
  assert.equal(at(t), "why");

  c = { ...c, phase: "verification", view: "why" };
  assert.equal(advance(t, c), t, "the Why tab only counts once a check has changed a decision");
  c = { ...c, testCaused: true };
  t = advance(t, c);
  assert.equal(at(t), "untrue");
  c = { ...c, phase: "complete" };
  assert.equal(advance(t, c), t, "not before the review shows");
  assert.deepEqual(targets(t, c).dom, []);
  c = { ...c, finished: true, tab: "plan" };
  assert.deepEqual(targets(t, c).dom.map((d) => d.sel), ['[data-tour="log-tab"]'], "the review is in Chat & log");
  c = { ...c, tab: "activity" };
  assert.deepEqual(targets(t, c).dom.map((d) => d.sel), ['[data-tour="untrue"]']);
  assert.equal(advance(t, c), t, "waits for you to open a row or a pen mark");
  c = { ...c, reviewOpens: 1 };
  t = advance(t, c);
  assert.equal(at(t), "timeline");
  c = { ...c, view: "timeline" };
  t = advance(t, c);
  assert.equal(at(t), "views");
  assert.deepEqual(targets(t, c).dom.map((d) => d.sel), ['[data-tour="arch-tab"]'], "back to Architecture first");
  c = { ...c, view: "board" };
  assert.deepEqual(targets(t, c).dom.map((d) => d.sel), ['[data-tour="lens"]']);
  assert.equal(advance(t, c), t, "waits for Next, so you can look at a few");
  t = next(t, c);
  assert.equal(at(t), "finish");
  assert.equal(next(t, c), t, "nowhere past the end");
});

test("steps the run has moved past don't wait: approving early skips the plan steps", () => {
  let c = { ...base, started: true, stage: "planning", phase: "planning", gate: true, firstDecision: "d1" };
  let t = advance(next(startTour(base), base), c);
  assert.equal(at(t), "decision");
  c = { ...c, gate: false, stage: "building", phase: "implementation" };
  t = advance(t, c);
  assert.equal(at(t), "build", "decision, steer, answer and approve all count as done");
  c = { ...c, phase: "complete", finished: true };
  t = advance(t, c);
  assert.equal(at(t), "untrue", "past the build, the command prompt and the failed check; the review still waits for a click");
});

test("Back shows the previous step and waits for Next; Next catches up again", () => {
  let c = { ...base, started: true, stage: "planning", phase: "planning", gate: true, firstDecision: "d1" };
  let t = advance(next(startTour(base), base), c);
  c = { ...c, selected: ["decision:d1"] };
  t = advance(t, c);
  assert.equal(at(t), "steer");
  const b = back(t, c);
  assert.equal(at(b), "decision");
  assert.equal(advance(b, c), b, "it would be done, but you came back to read it");
  assert.equal(back(startTour(base), base).i, 0);
  const n = advance(next(b, c), c);
  assert.equal(at(n), "steer");
  assert.equal(n.max, t.max);
});

test("a step's action runs once, the first time it's reached", () => {
  const t0 = startTour(base);
  assert.ok(isFresh(null, t0));
  const t1 = next(t0, base);
  assert.ok(isFresh(t0, t1));
  const b = back(t1, base);
  assert.ok(!isFresh(t1, b));
  assert.ok(!isFresh(b, next(b, base)), "back then forward doesn't start the demo again");
  assert.ok(!isFresh(t1, t1));
});

test("the demo holds at a checkpoint only while its step waits for you", () => {
  const c = { ...base, started: true, stage: "building", phase: "implementation", building: "api" };
  let t = startTour(base);
  while (at(t) !== "build") t = next(t, c);
  assert.ok(holds(t, "build", c));
  assert.ok(!holds(t, "verify", c), "another step's checkpoint plays through");
  assert.ok(!holds(t, "build", { ...c, hovers: 1 }), "done already: no wait");
  assert.ok(!holds(null, "build", c), "no tour, no wait");
  while (at(t) !== "why") t = next(t, c);
  const v = { ...c, phase: "verification", testCaused: true };
  assert.ok(holds(t, "verify", v));
  assert.ok(!holds(t, "verify", { ...v, view: "why" }));
});

test("what stays lit, and where the card goes", () => {
  const go = (id, c) => {
    let t = startTour(base);
    while (at(t) !== id) t = next(t, c);
    return targets(t, c);
  };
  assert.equal(go("welcome", base).place, "center", "the three areas are the whole screen");
  assert.equal(go("welcome", base).dom.length, 3);
  assert.equal(go("finish", base).place, "center", "nothing to point at");
  assert.deepEqual(go("finish", base).spot, []);

  const plan = { ...base, started: true, stage: "planning", phase: "planning", gate: true, firstDecision: "d1", firstQuestion: "q1" };
  assert.deepEqual(go("plans", { ...plan, gate: false }).spot, [BOARD], "watch the parts appear");
  const d = go("decision", plan);
  assert.deepEqual(d.spot, [BOARD], "a note on the board: the board stays lit");
  assert.equal(d.place, "beside");
  assert.deepEqual(go("steer", { ...plan, explainUse: true }).spot, [".explain"], "the options card, not the board");
  assert.deepEqual(go("steer", plan).spot, [BOARD]);
  assert.deepEqual(go("answer", { ...plan, tab: "plan" }).spot, [".transcript", BOARD]);
  assert.deepEqual(go("approve", plan).spot, [".gate"]);
  assert.deepEqual(go("approve", { ...plan, gate: false }).spot, [BOARD], "waiting with nothing to click: the board is where it's happening");

  const built = { ...plan, gate: false, stage: "building", phase: "implementation", building: "api" };
  assert.deepEqual(go("build", built).spot, [".transcript", BOARD]);
  assert.deepEqual(go("build", { ...built, tab: "plan" }).spot, [BOARD]);
  assert.deepEqual(go("why", { ...built, testCaused: true }).spot, [], "just the Why tab");
  assert.deepEqual(go("untrue", { ...built, phase: "complete", finished: true }).spot, [BOARD], "the red pen marks");
  assert.deepEqual(go("untrue", { ...built, phase: "complete", finished: true, view: "why" }).spot, [], "no pen marks on the Why tab");
});
