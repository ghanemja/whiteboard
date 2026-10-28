// Export → Clean (src/engine/present.js): the same diagram with straight lines and a plain font.
import { test } from "node:test";
import assert from "node:assert/strict";
import { presentable } from "../src/engine/present.js";

const el = (o) => ({ type: "rectangle", roughness: 1, strokeWidth: 2, fillStyle: "solid", isDeleted: false, ...o });

test("straight lines, solid fills, a plain font; dashes keep their meaning", () => {
  const out = presentable(
    [
      el({ id: "node-api", fillStyle: "hachure" }),
      el({ id: "dec-d1", type: "diamond", strokeStyle: "dashed" }),
      el({ id: "node-api:label", type: "text", fontFamily: 5, strokeWidth: 1, text: "API server" }),
      el({ id: "edge-web-api", type: "arrow", strokeWidth: 1 }),
    ],
    { fontFamily: 6 },
  );
  assert.ok(out.every((e) => e.roughness === 0));
  assert.equal(out[0].fillStyle, "solid");
  assert.equal(out[0].strokeWidth, 1.5);
  assert.equal(out[1].strokeStyle, "dashed", "a proposed decision is still dashed");
  assert.equal(out[2].fontFamily, 6);
  assert.equal(out[2].text, "API server");
  assert.equal(out[3].strokeWidth, 1);
});

test("what only belongs on the live board is left out: stickers, their answers, tape and pins", () => {
  const out = presentable(
    [
      el({ id: "node-api" }),
      el({ id: "st1", customData: { sticker: "why" } }),
      el({ id: "st1:t", type: "text", containerId: "st1" }),
      el({ id: "ans-st1", customData: { answers: "st1" } }),
      el({ id: "tape-n1" }),
      el({ id: "note-q1:pin-n" }),
      el({ id: "note-q1:pin", type: "ellipse" }),
      el({ id: "gone", isDeleted: true }),
      el({ id: "n1", type: "text", text: "Your note" }),
    ],
    { fontFamily: 6 },
  );
  assert.deepEqual(out.map((e) => e.id), ["node-api", "n1"]);
});
