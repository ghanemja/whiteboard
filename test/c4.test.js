// The C4 drawing style's labels and the Mermaid export (run with `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { c4Tag, toMermaid } from "../src/engine/c4.js";

const model = {
  project: 'Link "shortener"',
  nodes: {
    user: { id: "user", name: "Reader", kind: "user", cell: [0, 0] },
    web: { id: "web", name: "Web client", kind: "client", libs: ["React 18", "Vite 6"], cell: [1, 0] },
    api: { id: "api", name: "API server", kind: "service", libs: ["Fastify 4.28"], api: ["POST /links", "GET /:code"], cell: [1, 1] },
    db: { id: "db", name: "Store", kind: "data", libs: ["SQLite 3"], cell: [2, 1] },
    "q-1": { id: "q-1", name: "Jobs", kind: "queue", cell: [0, 2] },
    llm: { id: "llm", name: "Claude API", kind: "external", libs: ["anthropic SDK"], cell: [2, 0] },
  },
  edges: {
    "web>api": { from: "web", to: "api", via: "HTTP", api: "POST /links {url} → {code}" },
    "api>q-1": { from: "api", to: "q-1", via: "queue", async: true },
    "api>db": { from: "api", to: "db", via: "SQL", api: "SELECT url WHERE code <> ''" },
    "api>gone": { from: "api", to: "gone" },
  },
};

test("a box's C4 line: its type, and its main technology unless it's outside the system", () => {
  assert.equal(c4Tag(model.nodes.api), "[Container: Fastify 4.28]");
  assert.equal(c4Tag(model.nodes.db), "[Database: SQLite 3]");
  assert.equal(c4Tag(model.nodes["q-1"]), "[Queue]");
  assert.equal(c4Tag(model.nodes.llm), "[External system]");
  assert.equal(c4Tag(model.nodes.user), "[Person]");
  assert.ok(c4Tag({ kind: "service", libs: ["a-very-long-framework-name 12.3.4"] }).length <= 28);
});

test("Mermaid: the system's boundary holds its containers; people and external systems sit outside", () => {
  const m = toMermaid(model);
  const lines = m.trim().split("\n");
  assert.equal(lines[0], "flowchart LR");
  const open = lines.findIndex((l) => l.startsWith("  subgraph system"));
  const close = lines.indexOf("  end");
  const inside = lines.slice(open + 1, close).join("\n");
  assert.match(inside, /n_web\["Web client<br\/>\[Container: React 18, Vite 6\]"\]/);
  assert.match(inside, /n_db\["Store<br\/>\[Database: SQLite 3\]"\]/);
  assert.ok(!inside.includes("n_llm") && !inside.includes("n_user"));
  assert.ok(lines.indexOf('  n_user["Reader<br/>[Person]"]') < open);
  assert.ok(lines.indexOf('  n_llm["Claude API<br/>[External system]"]') > close);
  // The boxes follow the board's grid: rows, then columns.
  assert.ok(inside.indexOf("n_web") < inside.indexOf("n_api") && inside.indexOf("n_api") < inside.indexOf("n_db"));
});

test("Mermaid: links carry protocol and API, async ones dashed, and nothing breaks the syntax", () => {
  const m = toMermaid(model);
  assert.match(m, /n_web -->\|"HTTP: POST \/links \{url\} → \{code\}"\| n_api/);
  assert.match(m, /n_api -\.->\|"queue"\| n_q_1/);
  assert.match(m, /SELECT url WHERE code #lt;#gt; ''/); // < and > as entities; quotes swapped
  assert.match(m, /subgraph system\["Link 'shortener'"\]/);
  assert.ok(!m.includes("gone")); // a link to a component that's gone is left out
  assert.match(m, /class n_llm external/);
});
