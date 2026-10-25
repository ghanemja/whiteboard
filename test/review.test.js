// The end-of-run review: what needs a look, linked to where to look.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReview } from "../src/engine/review.js";

const d = (id, n, o = {}) => [id, { id, n, title: id, state: "accepted", proof: null, ...o }];
const keys = (rows) => rows.map((r) => r.key);

test("a run with work left to check", () => {
  const rows = buildReview({
    model: {
      decisions: Object.fromEntries([d("d1", 1, { proof: "pass" }), d("d2", 2, { proof: "fail" }), d("d3", 3), d("d4", 4, { state: "rejected" })]),
      questions: { q1: { id: "q1", kind: "question", n: 1, text: "Largest PDF?", state: "open" }, a1: { id: "a1", kind: "assumption", n: 1, text: "Text layer", state: "confirmed" } },
      unowned: [{ path: "docker-compose.yml", add: 11, del: 0 }],
    },
    claims: [
      { id: "s1", text: "I documented the setup in README.md.", verdict: "bad", claims: [{ verdict: "bad", why: "README.md wasn't changed in this run" }] },
      { id: "s2", text: "All 42 pass.", verdict: "ok", claims: [] },
    ],
    passing: [{ id: "s3", text: "Should I also add OCR?", kind: "asks" }],
    changes: [{ path: "api/app.py", add: 18, del: 4 }, { path: "docker-compose.yml", add: 11, del: 0 }],
    commits: 0,
    lastTest: { ok: true, pass: 47, fail: 3 },
    denied: ["rm -rf build"],
  });
  assert.deepEqual(keys(rows), ["failed", "unchecked", "claim-s1", "questions", "asked", "code", "unowned", "tests", "denied"]);
  assert.deepEqual(rows[0].links, [{ label: "D2", lid: "decision:d2" }]);
  assert.deepEqual(rows[1].links.map((l) => l.label), ["D3"]); // the rejected D4 isn't owed a check
  assert.match(rows[2].text, /README\.md wasn't changed/);
  assert.equal(rows[2].links[0].lid, "sentence:s1");
  assert.equal(rows.find((r) => r.key === "code").text, "2 files changed (+29 −4), not committed");
});

test("a clean run says so", () => {
  const rows = buildReview({
    model: { decisions: Object.fromEntries([d("d1", 1, { proof: "pass" })]), questions: {}, unowned: [] },
    claims: [{ id: "s1", text: "All 12 tests pass.", verdict: "ok", claims: [] }],
    changes: [{ path: "src/a.js", add: 3, del: 1 }],
    commits: 1,
    lastTest: { ok: true, pass: 12, fail: 0 },
  });
  assert.equal(rows[0].key, "clear");
  assert.match(rows.find((r) => r.key === "code").text, /in 1 commit$/);
});

test("an old recording without a diff says nothing about code", () => {
  const rows = buildReview({ model: { decisions: {}, questions: {} }, changes: null });
  assert.deepEqual(keys(rows), ["clear"]);
});
