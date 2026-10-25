// Receipts for the agent's prose: what counts as a claim, and what the record says about it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { asksYou, assumes, checkClaim, findClaims, receipt } from "../src/engine/claims.js";

const kinds = (s) => findClaims(s).map((c) => c.kind);
const one = (s) => findClaims(s)[0];

test("test results claimed in the saved runs", () => {
  assert.deepEqual(one("Links can now expire after a set number of days, and all 12 tests pass."), { kind: "tests", text: "all 12 tests pass", pass: 12, total: 12 });
  assert.equal(one("All 10 tests pass, including two new ones.").pass, 10);
  assert.equal(one("All 8 tests pass (`npm test`), including the 4 new ones.").pass, 8);
  assert.equal(one("The unit tests cover chunking, page mapping and both routes, and all 42 pass, including the one that times a 300-page upload.").pass, 42);
  assert.deepEqual(one("12/12 tests pass."), { kind: "tests", text: "12/12 tests pass", pass: 12, total: 12 });
  assert.equal(one("The tests pass now.").pass, null);
  assert.deepEqual(kinds("The staging smoke test passed: upload a PDF, ask a question, get a cited answer."), []);
});

test("measured results", () => {
  assert.deepEqual(one("Retrieval finds the right page 41 times out of 50."), { kind: "count", text: "41 times out of 50", pass: 41, total: 50 });
  assert.deepEqual(one("Re-running the eval: 47 of 50, or 94%."), { kind: "count", text: "47 of 50", pass: 47, total: 50 });
  assert.deepEqual(kinds("Most misses are tables: 7 of the 9 misses were split across chunks."), []);
});

test("files it says it changed", () => {
  assert.deepEqual(one("I made these changes on top of your existing uncommitted edits in the same four files (`src/server.js`, `src/store.js`, `test/server.test.js`, `README.md`).").files, [
    "src/server.js", "src/store.js", "test/server.test.js", "README.md",
  ]);
  assert.deepEqual(one("The changes are in `src/server.js` and `src/store.js`, and the README now documents aliases.").files, ["src/server.js", "src/store.js", "README"]);
  assert.deepEqual(one("- Uncommitted work: the changes are in `src/store.js`, `src/server.js`, `test/server.test.js` and the README.").files, [
    "src/store.js", "src/server.js", "test/server.test.js", "README",
  ]);
  assert.equal(one("I didn't touch `src/codes.js`.").kind, "untouched");
});

test("not claims: plans, instructions, questions, libraries and hosts", () => {
  assert.deepEqual(kinds("I'll run them to make sure the tests pass."), []);
  assert.deepEqual(kinds("Next I'll update `README.md`."), []);
  assert.deepEqual(kinds("To try it, run `npm start`, then `curl localhost:3000/stats/<code>`."), []);
  assert.deepEqual(kinds("Should I also update the README?"), []);
  assert.deepEqual(kinds("Last, the web client: drag-and-drop upload with pdf.js, and a chat view."), []);
  assert.deepEqual(kinds("I added a link to example.com in the response."), []);
});

test("commands it says it ran", () => {
  assert.deepEqual(one("I ran `npm test` twice."), { kind: "ran", text: "npm test", command: "npm test" });
});

test("questions and assumptions said in passing", () => {
  assert.equal(asksYou("Should I also add OCR for scanned PDFs?"), true);
  assert.equal(asksYou("Why? Because tables split."), false);
  assert.equal(asksYou("Done."), false);
  assert.equal(assumes("I assumed every PDF has a text layer, so there's no OCR."), true);
  assert.equal(assumes("Defaulting to 50 MB as the largest upload."), true);
  assert.equal(assumes("All 12 tests pass."), false);
});

test("the runner's word decides test claims", () => {
  const run = (o) => ({ tests: [{ t: 1, ...o }] });
  assert.equal(checkClaim(one("all 12 tests pass"), run({ ok: true, pass: 12, fail: 0 })).verdict, "ok");
  assert.match(checkClaim(one("all 12 tests pass"), run({ ok: false, pass: 11, fail: 1 })).why, /failed \(11\/12\)/);
  assert.equal(checkClaim(one("all 12 tests pass"), run({ ok: true, pass: 10, fail: 0 })).verdict, "bad");
  assert.equal(checkClaim(one("all 12 tests pass"), run({ ok: true })).verdict, "ok"); // an old run: passed, count unknown
  assert.equal(checkClaim(one("all 12 tests pass"), {}).verdict, "unknown");
  assert.equal(checkClaim(one("3 of the 4 tests pass"), run({ ok: false, pass: 3, fail: 1 })).verdict, "ok");
  assert.equal(checkClaim(one("Retrieval finds the right page 41 times out of 50."), run({ ok: false, pass: 41, fail: 9 })).verdict, "ok");
  assert.equal(checkClaim(one("Re-running the eval: 47 of 50."), run({ ok: false, pass: 41, fail: 9 })).verdict, "bad");
  // A failure the timeline read from the agent's own words can't back or refute it.
  assert.equal(checkClaim(one("all 12 tests pass"), run({ ok: false, inferred: true })).verdict, "unknown");
});

test("git decides file claims; without it, silence proves nothing", () => {
  const claim = one("The changes are in `src/server.js` and `src/store.js`, and the README now documents aliases.");
  const diff = (...paths) => ({ changes: paths.map((path) => ({ path, add: 1, del: 0 })) });
  assert.equal(checkClaim(claim, diff("src/server.js", "src/store.js", "README.md")).verdict, "ok");
  assert.deepEqual(checkClaim(claim, diff("src/server.js", "src/store.js")), { verdict: "bad", why: "README wasn't changed in this run", short: "README" });
  assert.equal(checkClaim(claim, { edited: ["src/server.js", "src/store.js", "README.md"] }).verdict, "ok");
  assert.equal(checkClaim(claim, { edited: ["src/server.js"] }).verdict, "unknown");
  assert.equal(checkClaim(one("I didn't touch `src/codes.js`."), diff("src/codes.js")).verdict, "bad");
  // A folder counts when anything in it changed.
  const folders = one("The new code is in `api/` and `worker/`, and I documented the setup in `README.md`.");
  assert.deepEqual(folders.files, ["api/", "worker/", "README.md"]);
  assert.deepEqual(checkClaim(folders, diff("api/app.py", "worker/ingest.py")), { verdict: "bad", why: "README.md wasn't changed in this run", short: "README.md" });
});

test("a sentence's receipt: contradicted beats unverified beats backed", () => {
  const ev = { tests: [{ t: 1, ok: true, pass: 8, fail: 0 }], changes: [{ path: "src/server.js", add: 3, del: 1 }] };
  assert.equal(receipt(findClaims("All 8 tests pass and the changes are in `src/server.js`."), ev).verdict, "ok");
  assert.equal(receipt(findClaims("All 8 tests pass and I updated `README.md`."), ev).verdict, "bad");
  assert.equal(receipt(findClaims("Nothing to see here."), ev), null);
});
