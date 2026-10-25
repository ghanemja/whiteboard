// buildTimeline over the saved runs in fixtures/recordings (run with `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildTimeline, drawTimeline, fmt, saysFailed, timeToX, xToTime, TL } from "../src/engine/timeline.js";

const DIR = new URL("../fixtures/recordings/", import.meta.url);
const load = (id) =>
  readFileSync(new URL(`${id}.jsonl`, DIR), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const lane = (tl, n) => tl.lanes.find((l) => l.n === n);
const kinds = (l) => l.marks.map((m) => (m.kind === "proof" ? `proof:${m.proof}` : m.kind));
const you = (tl, kind) => tl.you.filter((y) => y.kind === kind);

const fixtures = readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, ""));

for (const id of fixtures) {
  test(`${id}: a well-formed timeline`, () => {
    const tl = buildTimeline(load(id));
    assert.ok(tl.duration > 0);
    assert.equal(tl.you[0].kind, "start");
    // Every lane starts with its first op and is numbered in order.
    tl.lanes.forEach((l, i) => {
      assert.equal(l.n, i + 1);
      assert.ok(["proposed", "accepted"].includes(l.marks[0].kind));
      for (let k = 1; k < l.marks.length; k++) assert.ok(l.marks[k].t >= l.marks[k - 1].t);
    });
    // The axis is continuous and only moves right; every moment maps inside it, and back.
    tl.segments.forEach((s, i) => {
      assert.ok(s.x1 >= s.x0);
      if (i) assert.ok(Math.abs(s.x0 - tl.segments[i - 1].x1) < 1e-6);
      if (i) assert.equal(s.from, tl.segments[i - 1].to);
    });
    let last = -Infinity;
    for (let t = 0; t <= tl.end; t += 250) {
      const x = timeToX(tl, t);
      assert.ok(x >= last && x >= TL.X0);
      last = x;
    }
    for (const t of [0, tl.end / 3, tl.end]) assert.ok(Math.abs(xToTime(tl, timeToX(tl, t)) - t) < 1);
    // Idle gaps are compressed to a fixed width.
    for (const s of tl.segments.filter((s) => s.gap)) {
      assert.ok(s.to - s.from > TL.GAP);
      assert.ok(Math.abs(s.x1 - s.x0 - TL.BREAK) < 1e-6);
    }
    // Phases are ordered and cover the run from the start.
    assert.equal(tl.phases[0].key, "planning");
    assert.equal(tl.phases[0].from, 0);
    tl.phases.forEach((p) => assert.ok(p.to >= p.from));
    // Drawing gives unique ids, all under "tl:".
    const ids = drawTimeline(tl).map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((i) => i.startsWith("tl:")));
  });
}

test("6e0ae61d: you challenged D4, it changed, and the tests proved all four", () => {
  const tl = buildTimeline(load("6e0ae61d"));
  assert.deepEqual(
    tl.you.map((y) => `${fmt(y.t)} ${y.kind}`),
    ["0:00 start", "0:34 chat", "0:49 approve", "1:12 permission", "1:28 permission", "1:45 permission"],
  );
  const challenge = tl.you[1];
  assert.equal(challenge.target, "d4");
  assert.equal(challenge.label, "challenged D4");
  for (const n of [1, 2, 3]) assert.deepEqual(kinds(lane(tl, n)), ["proposed", "accepted", "proof:pass"]);
  const d4 = lane(tl, 4);
  assert.deepEqual(kinds(d4), ["proposed", "changed", "proof:pass"]);
  const changed = d4.marks[1];
  assert.equal(changed.cause.who, "you");
  assert.equal(changed.cause.you, tl.you.indexOf(challenge));
  assert.match(changed.cause.text, /^cap it at 365 days/);
  // The first test run had a failing test (an old alias test), the re-run passed.
  assert.deepEqual(tl.tests.map((k) => [fmt(k.t), k.ok]), [["1:29", false], ["1:46", true]]);
  // The 01:29 proofs came from that run, and link to it.
  for (const l of tl.lanes) {
    const proof = l.marks.find((m) => m.kind === "proof");
    assert.equal(fmt(proof.t), "1:29");
    assert.equal(proof.fromTests, true);
    assert.equal(proof.test, 0);
  }
  assert.deepEqual(tl.phases.map((p) => p.key), ["planning", "implementation", "verification", "deployment"]);
  assert.equal(fmt(tl.complete), "1:54");
  assert.equal(tl.breaks.length, 0); // nobody waited long
});

test("dafce9c8: one challenge changed D1–D3 at the same moment, no proofs", () => {
  const tl = buildTimeline(load("dafce9c8"));
  const challenge = you(tl, "chat")[0];
  assert.equal(challenge.target, "d2");
  const changes = tl.lanes.map((l) => l.marks.find((m) => m.kind === "changed"));
  assert.equal(changes.length, 3);
  assert.ok(changes.every((m) => m && m.cause.who === "you" && m.cause.you === tl.you.indexOf(challenge)));
  assert.ok(Math.max(...changes.map((m) => m.t)) - Math.min(...changes.map((m) => m.t)) < 50);
  assert.equal(tl.changes, 3);
  assert.ok(tl.lanes.every((l) => !l.marks.some((m) => m.kind === "proof")));
  // The ripple: one arrow from you to D2, dashed arcs from D2 to D1 and D3.
  const sk = drawTimeline(tl);
  const arrows = sk.filter((e) => e.type === "arrow" && e.id.startsWith("tl:c:"));
  assert.equal(arrows.length, 3);
  assert.equal(arrows.filter((a) => a.strokeStyle === "dashed").length, 2);
  // Reading the plan (45 s) and approving it (25 s) were waits; the 15-minute idle stop isn't part of the run.
  assert.equal(tl.breaks.length, 2);
  assert.ok(tl.end < 135000);
});

test("f0b64cdb: D1 changed after you asked for dots; D2 and D3 were approved", () => {
  const tl = buildTimeline(load("f0b64cdb"));
  assert.deepEqual(kinds(lane(tl, 1)), ["proposed", "changed"]);
  assert.equal(lane(tl, 1).marks[1].cause.who, "you");
  assert.deepEqual(kinds(lane(tl, 2)), ["proposed", "accepted"]);
  assert.deepEqual(kinds(lane(tl, 3)), ["proposed", "accepted"]);
  // The two-minute wait on a permission is shortened.
  assert.ok(tl.breaks.some((b) => b.to - b.from > 120000));
});

test("a failed check that changes a decision is its cause (the demo's D2)", () => {
  const op = (t, o) => ({ t, type: "op", op: { op: "decision", ...o } });
  const tl = buildTimeline([
    { t: 0, type: "start" },
    { t: 100, type: "op", op: { op: "phase", name: "planning" } },
    op(200, { id: "d2", title: "How PDFs are split", chose: "500-token chunks" }),
    { t: 900, type: "gate" },
    { t: 1500, type: "user", kind: "approve", edits: [] },
    { t: 1600, type: "op", op: { op: "phase", name: "implementation" } },
    op(5000, { id: "d2", proof: "fail", proof_by: "Eval: 41 of 50" }),
    op(7000, { id: "d2", chose: "Layout-aware chunks" }),
    op(9000, { id: "d2", proof: "pass", proof_by: "Eval: 47 of 50" }),
  ]);
  const d2 = tl.lanes[0];
  assert.deepEqual(kinds(d2), ["proposed", "accepted", "proof:fail", "changed", "proof:pass"]);
  assert.equal(d2.marks[3].cause.who, "test");
  assert.equal(d2.marks[3].cause.mark, 2);
});

test("a deleted diamond rejects its decision and ends the lane", () => {
  const tl = buildTimeline([
    { t: 0, type: "op", op: { op: "decision", id: "d1", title: "Queue", chose: "Redis" } },
    { t: 1000, type: "user", kind: "revise", edits: [{ kind: "reject", decision: "d1", label: "D1", title: "Queue" }] },
    { t: 3000, type: "op", op: { op: "decision", id: "d1", state: "rejected" } },
    { t: 9000, type: "op", op: { op: "decision", id: "d1", proof: "pass" } },
  ]);
  assert.deepEqual(kinds(tl.lanes[0]), ["proposed", "rejected"]);
  assert.equal(tl.lanes[0].marks[1].cause.who, "you");
});

test("reading the agent's words about a test run", () => {
  assert.equal(saysFailed("Test 5 failed because it deepEquals `{ code: alias }`."), true);
  assert.equal(saysFailed("One old alias test broke; fixing it."), true);
  assert.equal(saysFailed("All 12 tests pass."), false);
  assert.equal(saysFailed("No tests failed."), false);
});

test("no events, no timeline", () => {
  const tl = buildTimeline([]);
  assert.equal(tl.lanes.length, 0);
  assert.deepEqual(drawTimeline(tl), []);
});
