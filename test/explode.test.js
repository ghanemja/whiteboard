// A layer opened up in place (src/engine/explode.js): what each component bursts into, where the
// pieces go, and the skeletons they're drawn from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EX, explodeLayout, explodeOf, explodeSkeletons, iconOf } from "../src/engine/explode.js";
import { LAYER_COLOR } from "../src/engine/views.js";

// The demo's board, cut down: a web client, an API server with a route and an ML step, a store.
const model = {
  nodes: {
    web: { id: "web", name: "Web client", kind: "client", libs: ["React 18"], cell: [0, 0] },
    api: { id: "api", name: "API server", kind: "service", libs: ["FastAPI"], cell: [1, 0] },
    vdb: { id: "vdb", name: "Vector index", kind: "data", libs: [], cell: [1, 1] },
    you: { id: "you", name: "Reader", kind: "user", cell: [0, 1] },
  },
  parts: {
    "web.chat": { id: "web.chat", n: 1, of: "web", name: "Chat view", kind: "page", links: [] },
    "api.ask": { id: "api.ask", n: 2, of: "api", name: "POST /ask", kind: "route", links: [] },
    "api.retrieve": { id: "api.retrieve", n: 3, of: "api", name: "Retrieve top 8", kind: "step", layer: "ml", links: [] },
  },
  tables: { chunks: { id: "chunks", name: "chunks", of: "vdb", columns: [] } },
  edges: {},
};
// Hit-boxes as the board draws them (Pictures: 130 × 154 on a 290 × 180 grid).
const boxes = {
  web: { x: 45, y: 80, w: 130, h: 154 },
  api: { x: 335, y: 80, w: 130, h: 154 },
  vdb: { x: 335, y: 260, w: 130, h: 154 },
  you: { x: 45, y: 260, w: 130, h: 154 },
};
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("a part's picture comes from its kind", () => {
  assert.equal(iconOf("page"), "window");
  assert.equal(iconOf("view (pdf.js)"), "window");
  assert.equal(iconOf("route"), "plug");
  assert.equal(iconOf("job"), "clock");
  assert.equal(iconOf("model"), "spark");
  assert.equal(iconOf("index"), "lens");
  assert.equal(iconOf("table"), "table");
  assert.equal(iconOf("object"), "page");
  assert.equal(iconOf("library"), "box");
  assert.equal(iconOf("step"), "gear");
  assert.equal(iconOf("something else"), "dot");
  assert.equal(iconOf(), "dot");
});

test("opening a layer: its components with every part and library; others only their parts in it", () => {
  const back = explodeOf(model, "backend");
  assert.deepEqual(back.map((g) => g.host), ["api"]);
  assert.deepEqual(back[0].items.map((i) => [i.name, i.icon, i.layer]), [
    ["POST /ask", "plug", "backend"],
    ["Retrieve top 8", "gear", "ml"], // still the API server's, in its own layer's color
    ["FastAPI", "box", "backend"],
  ]);
  const ml = explodeOf(model, "ml");
  assert.deepEqual(ml.map((g) => [g.host, g.partial, g.items.map((i) => i.name)]), [["api", true, ["Retrieve top 8"]]], "a host from another layer shows only its ML parts, no libraries");
  const data = explodeOf(model, "data");
  assert.deepEqual(data[0].items.map((i) => [i.name, i.icon]), [["chunks", "table"]]);
  assert.deepEqual(explodeOf(model, null), []);
  assert.deepEqual(explodeOf(model, "external"), [], "nothing there, nothing opens");
});

test("the pieces fan out away from the middle and clear every component and each other", () => {
  const groups = [...explodeOf(model, "frontend"), ...explodeOf(model, "backend"), ...explodeOf(model, "data")];
  const items = explodeLayout(groups, boxes);
  assert.equal(items.length, 6); // Chat view and React 18; the route, the step and FastAPI; chunks
  for (const it of items) {
    for (const b of Object.values(boxes)) assert.ok(!overlap(it, b), `${it.name} clears every component`);
    for (const o of items) if (o !== it) assert.ok(!overlap(it, o), `${it.name} clears ${o.name}`);
  }
  // The web client is on the left of the board: its piece goes further left. The store is at the bottom: down.
  const chat = items.find((i) => i.name === "Chat view");
  assert.ok(chat.x + chat.w / 2 < boxes.web.x + boxes.web.w / 2);
  const chunks = items.find((i) => i.name === "chunks");
  assert.ok(chunks.y > boxes.vdb.y + boxes.vdb.h / 2);
  // A leader runs from the component's edge toward its piece.
  const ask = items.find((i) => i.name === "POST /ask");
  const [fx, fy] = ask.from;
  const a = boxes.api;
  assert.ok(Math.abs(fx - a.x) < 1 || Math.abs(fx - (a.x + a.w)) < 1 || Math.abs(fy - a.y) < 1 || Math.abs(fy - (a.y + a.h)) < 1, "starts on the box's edge");
  assert.deepEqual(explodeLayout(groups, {}), []);
});

test("many pieces go on further rings instead of wrapping round", () => {
  const many = { host: "api", items: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Part ${i}`, kind: "step", layer: "backend", icon: "gear" })) };
  const items = explodeLayout([many], boxes);
  assert.equal(items.length, 12);
  const dist = items.map((it) => Math.hypot(it.x + it.w / 2 - (boxes.api.x + 65), it.y + it.h / 2 - (boxes.api.y + 77)));
  assert.ok(Math.max(...dist) - Math.min(...dist) >= EX.RING - 1, "a second ring");
  for (const it of items) for (const o of items) if (o !== it) assert.ok(!overlap(it, o));
});

test("skeletons: a dashed leader, the picture and the name, in the piece's layer color, grouped", () => {
  const items = explodeLayout(explodeOf(model, "backend"), boxes);
  const sk = explodeSkeletons(items);
  const route = sk.filter((e) => e.id.startsWith("ex:api.ask:"));
  assert.deepEqual(route.map((e) => e.id.split(":").pop()), ["lead", "i0", "i1", "n", "k"]);
  assert.ok(route.every((e) => e.groupIds[0] === "g:ex:api.ask"));
  assert.equal(route[0].strokeStyle, "dashed");
  assert.equal(route[1].strokeColor, LAYER_COLOR.backend.stroke);
  assert.equal(route.find((e) => e.id.endsWith(":n")).text, "POST /ask");
  const step = sk.find((e) => e.id === "ex:api.retrieve:i0");
  assert.equal(step.backgroundColor, LAYER_COLOR.ml.fill, "the ML step keeps the ML color");
  assert.ok(new Set(sk.map((e) => e.id)).size === sk.length, "ids are unique");
});

test("a component in the middle of the board opens toward the most room, not through a neighbor", () => {
  // Three in a column: the middle one would face "up" into the one above.
  const col = {
    top: { x: 335, y: 80, w: 130, h: 154 },
    mid: { x: 335, y: 260, w: 130, h: 154 },
    low: { x: 335, y: 440, w: 130, h: 154 },
  };
  const g = { host: "mid", items: Array.from({ length: 4 }, (_, i) => ({ id: `m${i}`, name: `Part ${i}`, kind: "step", layer: "backend", icon: "gear" })) };
  const items = explodeLayout([g], col);
  for (const it of items) {
    for (const b of Object.values(col)) assert.ok(!overlap(it, b), `${it.name} clears every component`);
    // Its leader doesn't run through the box above or below: the pieces are beside it.
    assert.ok(it.x + it.w <= col.mid.x || it.x >= col.mid.x + col.mid.w, `${it.name} is off to a side`);
  }
});
