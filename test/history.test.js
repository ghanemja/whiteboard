// ↑ / ↓ in the message box (src/engine/history.js): like a shell's history.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHistory, HISTORY_MAX } from "../src/engine/history.js";

test("↑ goes back through what you sent, ↓ forward, and past the newest your draft comes back", () => {
  const h = createHistory();
  h.push("Support custom aliases like /launch");
  h.push("Aliases are 3 to 20 characters");
  h.push("npm test");
  assert.equal(h.up("half-typ"), "npm test");
  assert.equal(h.up(), "Aliases are 3 to 20 characters");
  assert.equal(h.up(), "Support custom aliases like /launch");
  assert.equal(h.up(), null, "nothing older: leave the box as it is");
  assert.equal(h.down(), "Aliases are 3 to 20 characters");
  assert.equal(h.down(), "npm test");
  assert.equal(h.down(), "half-typ", "back to what you were typing");
  assert.equal(h.down(), null, "not browsing: ↓ does nothing");
});

test("a repeat isn't stored twice, blanks aren't stored, and typing starts over from the newest", () => {
  const h = createHistory();
  h.push("a");
  h.push("a");
  h.push("   ");
  h.push("b");
  assert.deepEqual(h.items, ["a", "b"]);
  h.up("");
  h.up("");
  h.reset();
  assert.equal(h.up("x"), "b");
});

test("it's kept: loaded at start, saved on each send, capped, and a broken store doesn't break it", () => {
  let saved = null;
  const h = createHistory({ load: () => ["old one", 42, ""], save: (items) => (saved = items) });
  assert.deepEqual(h.items, ["old one"]);
  h.push("new one");
  assert.deepEqual(saved, ["old one", "new one"]);
  const big = createHistory();
  for (let i = 0; i < HISTORY_MAX + 5; i++) big.push(`m${i}`);
  assert.equal(big.items.length, HISTORY_MAX);
  assert.equal(big.items[0], "m5");
  const broken = createHistory({ load: () => { throw new Error("blocked"); }, save: () => { throw new Error("full"); } });
  broken.push("still works");
  assert.equal(broken.up(""), "still works");
});
