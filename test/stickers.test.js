// Steering stickers: which part or decision a dropped sticker lands on, the edit it makes,
// its area and how it reads; and the review's red-pen marks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { STICKERS, stickerEdit, stickerTarget } from "../src/engine/stickers.js";
import { areaOf, describeEdit } from "../src/engine/timeline.js";
import { penMarks } from "../src/engine/review.js";
import { checkClaim, findClaims } from "../src/engine/claims.js";
import { buildEditsReply } from "../src/agent/replies.js";

// A board like the demo's: the API server's hit-box with D1 on its top-left corner, and a store below.
const model = {
  nodes: {
    api: { id: "api", name: "API server", elId: "node-api" },
    vdb: { id: "vdb", name: "Vector index", elId: "node-vdb" },
  },
  decisions: {
    d1: { id: "d1", n: 1, title: "Inline or background", chose: "A worker", state: "accepted" },
    d2: { id: "d2", n: 2, title: "Chunks", chose: "500 tokens", state: "rejected" },
  },
};
const scene = {
  "node-api": { x: 335, y: 80, width: 130, height: 154 },
  "node-vdb": { x: 625, y: 260, width: 130, height: 154 },
  "dec-d1": { x: 319, y: 64, width: 40, height: 40 },
  "dec-d2": { x: 640, y: 244, width: 40, height: 40 },
};
const live = (id) => scene[id] ?? null;
const sticker = (kind, x, y, o = {}) => ({ id: "s1", type: "rectangle", x, y, width: 110, height: 46, customData: { sticker: kind }, ...o });

test("a sticker lands on the diamond under its center, else the part it covers most", () => {
  assert.equal(stickerTarget(sticker("why", 284, 61), model, live).decision.id, "d1"); // centered on D1
  assert.equal(stickerTarget(sticker("why", 360, 150), model, live).node.id, "api");
  assert.equal(stickerTarget(sticker("why", 600, 300), model, live).node.id, "vdb");
  // A rejected decision isn't a target: the part under it is.
  assert.equal(stickerTarget(sticker("why", 605, 241), model, live).node.id, "vdb");
  assert.equal(stickerTarget(sticker("why", 1200, 900), model, live), null);
});

test("each sticker becomes one edit; its label and a sticker on nothing make none", () => {
  assert.deepEqual(stickerEdit(sticker("drop", 360, 150), model, live), {
    key: "sticker:s1:node:api", kind: "sticker", sticker: "drop", elId: "s1", node: "api", name: "API server",
  });
  assert.deepEqual(stickerEdit(sticker("keep", 284, 61), model, live), {
    key: "sticker:s1:decision:d1", kind: "sticker", sticker: "keep", elId: "s1", decision: "d1", label: "D1", title: "Inline or background", chose: "A worker",
  });
  assert.equal(stickerEdit(sticker("why", 360, 150, { type: "text", containerId: "s0" }), model, live), null);
  assert.equal(stickerEdit(sticker("why", 1200, 900), model, live), null);
  assert.equal(stickerEdit(sticker("gold-star", 360, 150), model, live), null);
  assert.deepEqual(Object.keys(STICKERS), ["why", "drop", "keep"]);
});

test("Keep this is scope; Why? and Not needed are about what they're on", () => {
  assert.equal(areaOf({ kind: "sticker", sticker: "keep", node: "api" }), "scope");
  assert.equal(areaOf({ kind: "sticker", sticker: "keep", decision: "d1" }), "scope");
  assert.equal(areaOf({ kind: "sticker", sticker: "why", decision: "d1" }), "decision");
  assert.equal(areaOf({ kind: "sticker", sticker: "drop", decision: "d1" }), "decision");
  assert.equal(areaOf({ kind: "sticker", sticker: "why", node: "api" }), "architecture");
  assert.equal(areaOf({ kind: "sticker", sticker: "drop", node: "api" }), "architecture");
  assert.equal(describeEdit({ kind: "sticker", sticker: "why", node: "api", name: "API server" }), "Why? on API server");
  assert.equal(describeEdit({ kind: "sticker", sticker: "drop", decision: "d1", label: "D1", title: "Queue" }), "Not needed on D1 (Queue)");
});

test("every sticker is answered on the board, in a bubble beside it (op answer)", () => {
  const m = { ...model, phase: "planning", decisions: { ...model.decisions, d1: { ...model.decisions.d1, why: "Big PDFs take minutes." } } };
  const reply = buildEditsReply(
    [
      { kind: "sticker", sticker: "why", elId: "st1", decision: "d1", label: "D1", title: "Inline or background" },
      { kind: "sticker", sticker: "drop", elId: "st2", node: "vdb", name: "Vector index" },
      { kind: "sticker", sticker: "keep", elId: "st3", node: "api", name: "API server" },
    ],
    m,
  );
  const answers = [...reply.matchAll(/<board op="answer" el="([^"]+)" text="([^"]+)"\/>/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(answers.map((a) => a[0]), ["st1", "st2", "st3"]);
  assert.equal(answers[0][1], "Big PDFs take minutes.", "Why? gets the decision's reason");
  assert.match(answers[1][1], /Vector index/);
});

test("the red pen rings the owner of a false file claim, notes an unowned one, crosses a failed check", () => {
  const claim = findClaims("The changes are in `api/app.py`, and I documented the setup in `README.md` and `worker/ingest.py`.")[0];
  const checked = { ...claim, ...checkClaim(claim, { changes: [{ path: "api/app.py", add: 3, del: 0 }] }) };
  assert.deepEqual(checked.wrong, ["README.md", "worker/ingest.py"]);
  const ownerOf = (f) => (f.startsWith("worker/") ? "worker" : null);
  const marks = penMarks({
    model: { decisions: { d1: { id: "d1", n: 1, proof: "pass" }, d2: { id: "d2", n: 2, proof: "fail" }, d3: { id: "d3", n: 3, proof: "fail", state: "rejected" } } },
    claims: [{ id: "s7", verdict: "bad", claims: [checked] }, { id: "s8", verdict: "ok", claims: [] }],
    ownerOf,
  });
  assert.deepEqual(marks, {
    circles: [{ node: "worker", file: "worker/ingest.py", lid: "sentence:s7" }],
    notes: [{ file: "README.md", lid: "sentence:s7" }],
    crosses: [{ decision: "d2", lid: "decision:d2" }],
  });
  // Proven again: the ✗ comes off.
  assert.deepEqual(penMarks({ model: { decisions: { d2: { id: "d2", n: 2, proof: "pass" } } } }).crosses, []);
});
