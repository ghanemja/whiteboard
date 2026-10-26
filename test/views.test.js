// The board's views (src/engine/views.js): C4 labels, layers and what's inside them, flows, names, and the Mermaid exports (run with `npm test`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { c4Tag, dfdIds, dfdRole, insideOf, layerOf, openableLayers, parseColumns, parseLinks, parseSteps, partsOf, sentenceCase, tagCase, toDfdMermaid, toErMermaid, toInsideMermaid, toMermaid, toSequence } from "../src/engine/views.js";
import { drawEr, drawInside, drawSequence } from "../src/engine/diagrams.js";

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
  assert.match(m, /n_api -\.->\|"Queue"\| n_q_1/); // a protocol tag in sentence case too
  assert.match(m, /SELECT url WHERE code #lt;#gt; ''/); // < and > as entities; quotes swapped
  assert.match(m, /subgraph system\["Link 'shortener'"\]/);
  assert.ok(!m.includes("gone")); // a link to a component that's gone is left out
  assert.match(m, /class n_llm external/);
});

test("names in sentence case, except file names, code and one-word names", () => {
  assert.equal(sentenceCase("server tests"), "Server tests");
  assert.equal(sentenceCase("web client"), "Web client");
  assert.equal(sentenceCase("API server"), "API server");
  for (const keep of ["store.js", "src/api routes", "createStore", "pgvector index", "linkshort", "npm scripts"]) assert.equal(sentenceCase(keep), keep);
  assert.equal(tagCase("queue"), "Queue");
  assert.equal(tagCase("HTTP"), "HTTP");
  assert.equal(tagCase("gRPC"), "gRPC");
});

test("layers: the agent's, else the kind's; people belong to every view", () => {
  assert.equal(layerOf(model.nodes.web), "frontend");
  assert.equal(layerOf(model.nodes.api), "backend");
  assert.equal(layerOf(model.nodes.db), "data");
  assert.equal(layerOf(model.nodes["q-1"]), "data");
  assert.equal(layerOf(model.nodes.llm), "external");
  assert.equal(layerOf({ ...model.nodes.llm, layer: "ml" }), "ml");
  assert.equal(layerOf({ kind: "service", layer: "nonsense" }), "backend");
  assert.equal(layerOf(model.nodes.user), null);
  // A layer's Mermaid export holds only its components and the links between them.
  const m = toMermaid(model, { only: new Set(["api", "db"]) });
  assert.match(m, /n_api -->/);
  assert.ok(!m.includes("n_web") && !m.includes("n_llm"));
});

test("flow steps from the agent (strings or objects) and from demo tags", () => {
  const want = [
    { from: "web", to: "api", what: "POST /links" },
    { from: "api", to: "q-1", what: "" },
  ];
  assert.deepEqual(parseSteps(["web>api: POST /links", "api->q-1"]), want);
  assert.deepEqual(parseSteps("web>api: POST /links; api → q-1"), want);
  assert.deepEqual(parseSteps([{ from: "web", to: "api", label: "POST /links" }, { from: "api", to: "q-1" }]), want);
  assert.deepEqual(parseSteps("nonsense; api>api: itself"), []);
});

test("a flow as a numbered sequence diagram: replies dashed, async open-headed", () => {
  const flow = { name: "Shorten a link", steps: parseSteps("user>web: paste a URL; web>api: POST /links; api>q-1: enqueue; api>web: {code}") };
  const m = toSequence(model, flow);
  const lines = m.trim().split("\n");
  assert.deepEqual(lines.slice(0, 3), ["sequenceDiagram", "  title Shorten a link", "  autonumber"]);
  assert.ok(lines.includes("  actor n_user as Reader"));
  assert.ok(lines.includes("  participant n_api as API server"));
  assert.ok(lines.includes("  n_web->>n_api: POST /links"));
  assert.ok(lines.includes("  n_api-)n_q_1: enqueue"));
  assert.ok(lines.includes("  n_api-->>n_web: {code}"));
});

test("columns from the agent: types, primary keys, unique, and foreign keys written three ways", () => {
  const cols = parseColumns("id uuid pk; document_id uuid fk>documents.id; owner uuid references users(id); parent int -> nodes.id; email text unique; embedding vector(1024)");
  assert.deepEqual(cols.map((c) => [c.name, c.type, c.pk, c.unique, c.fk && `${c.fk.table}.${c.fk.col}`]), [
    ["id", "uuid", true, false, null],
    ["document_id", "uuid", false, false, "documents.id"],
    ["owner", "uuid", false, false, "users.id"],
    ["parent", "int", false, false, "nodes.id"],
    ["email", "text", false, true, null],
    ["embedding", "vector(1024)", false, false, null],
  ]);
  assert.deepEqual(parseColumns([{ name: "id", type: "uuid", pk: true }]), [{ name: "id", type: "uuid", pk: true, unique: false, fk: null }]);
});

test("the data model as a Mermaid ER diagram: keys marked, one-to-many for a foreign key, one-to-one when it's unique", () => {
  const m = toErMermaid({
    tables: {
      users: { name: "users", columns: parseColumns("id uuid pk; email text unique") },
      links: { name: "links", columns: parseColumns("code text pk; owner uuid fk>users.id") },
      profiles: { name: "profiles", columns: parseColumns("user_id uuid pk fk>users.id; bio text") },
    },
  });
  assert.match(m, /^erDiagram\n {2}users \{\n {4}uuid id PK\n {4}text email UK\n {2}\}/);
  assert.match(m, / {4}uuid owner FK/);
  assert.match(m, / {4}uuid user_id PK, FK/);
  assert.match(m, /users \|\|--o\{ links : "owner"/);
  assert.match(m, /users \|\|--o\| profiles : "user_id"/);
});

test("data flow: processes numbered, stores DS1…, entities outside the boundary, links labeled with their data", () => {
  assert.deepEqual(dfdIds(model), { web: "1", api: "2", db: "DS1", "q-1": "DS2" }); // grid order: rows, then columns
  assert.deepEqual(["web", "db", "q-1", "llm", "user"].map((id) => dfdRole(model.nodes[id])), ["process", "store", "store", "entity", "entity"]);
  const m = toDfdMermaid(model);
  assert.match(m, /n_api\("2 · API server"\)/);
  assert.match(m, /n_db\[\("DS1 · Store"\)\]/);
  assert.match(m, /n_web -->\|"POST \/links \{url\} → \{code\}"\| n_api/);
  assert.match(m, /n_api -\.->\|"Queue"\| n_q_1/); // no contract: its protocol
  const lines = m.split("\n");
  assert.ok(lines.indexOf('  n_llm["Claude API"]') > lines.indexOf("  end"));
});

test("drawn diagrams: crow's feet on a foreign key, and a reply dashed in a sequence", () => {
  const m = {
    nodes: { pg: { id: "pg", name: "Postgres", kind: "data" }, web: { id: "web", name: "Web", kind: "client" }, api: { id: "api", name: "API", kind: "service" } },
    edges: { "web>api": { from: "web", to: "api", api: "POST /ask" } },
    tables: {
      documents: { id: "documents", name: "documents", of: "pg", columns: parseColumns("id uuid pk") },
      chunks: { id: "chunks", name: "chunks", of: "pg", columns: parseColumns("id uuid pk; document_id uuid fk>documents.id") },
    },
  };
  const er = drawEr(m);
  const rel = er.filter((e) => e.type === "arrow");
  assert.equal(rel.length, 1);
  assert.equal(rel[0].startArrowhead, "crowfoot_many"); // at chunks.document_id
  assert.equal(rel[0].endArrowhead, "crowfoot_one"); // at documents.id
  assert.ok(er.some((e) => e.id === "er:g:pg:t" && e.text.startsWith("Postgres [Database")));
  const seq = drawSequence(m, { name: "Ask", steps: parseSteps("web>api: POST /ask; api>web: answer") }).filter((e) => e.type === "arrow");
  assert.deepEqual(seq.map((a) => [a.strokeStyle, a.endArrowhead]), [["solid", "triangle"], ["dashed", "arrow"]]);
  assert.deepEqual(drawEr({ tables: {} }), []);
  assert.deepEqual(drawSequence(m, null), []);
});

// A small RAG app: the worker's chunk and embed steps are ML, though the worker is backend.
const rag = {
  nodes: {
    web: { id: "web", name: "Web client", kind: "client", cell: [0, 0], api: ["Chat view"] },
    api: { id: "api", name: "API server", kind: "service", cell: [1, 0], api: ["POST /ask", "GET /health"] },
    worker: { id: "worker", name: "Ingest worker", kind: "service", cell: [1, 1] },
    vdb: { id: "vdb", name: "Vector index", kind: "data", cell: [2, 1] },
    llm: { id: "llm", name: "Claude API", kind: "external", layer: "ml", cell: [2, 0] },
  },
  edges: {
    "web>api": { from: "web", to: "api", via: "HTTP", api: "POST /ask {question}" },
    "api>llm": { from: "api", to: "llm", via: "HTTPS" },
    "worker>vdb": { from: "worker", to: "vdb", via: "SQL" },
  },
  tables: { chunks: { id: "chunks", name: "chunks", of: "vdb", columns: parseColumns("id uuid pk; embedding vector(1024)") } },
  parts: {
    "worker.chunk": { id: "worker.chunk", n: 1, of: "worker", name: "Chunk", kind: "step", layer: "ml", links: parseLinks("worker.embed: chunks") },
    "worker.embed": { id: "worker.embed", n: 2, of: "worker", name: "Embed", kind: "model", layer: "ml", links: parseLinks("chunks: INSERT") },
    "worker.ingest": { id: "worker.ingest", n: 3, of: "worker", name: "ingest(id)", kind: "job", links: parseLinks("worker.chunk") },
  },
};

test("part links from the agent: \"target: what\" pairs, a bare target, or objects", () => {
  assert.deepEqual(parseLinks("api.ask: POST /ask; vdb ;web.viewer: open the page"), [
    { to: "api.ask", what: "POST /ask" },
    { to: "vdb", what: "" },
    { to: "web.viewer", what: "open the page" },
  ]);
  assert.deepEqual(parseLinks([{ to: "x", label: "y" }, { what: "no target" }]), [{ to: "x", what: "y" }]);
});

test("what a component holds: its tables, its parts, or else what it exposes", () => {
  assert.deepEqual(partsOf(rag, "vdb").map((p) => [p.id, p.kind]), [["chunks", "table"]]);
  assert.deepEqual(partsOf(rag, "worker").map((p) => p.id), ["worker.chunk", "worker.embed", "worker.ingest"]);
  assert.deepEqual(partsOf(rag, "api").map((p) => [p.name, p.kind, p.derived]), [["POST /ask", "route", true], ["GET /health", "route", true]]);
  assert.deepEqual(partsOf(rag, "web").map((p) => p.kind), ["view"]);
  assert.deepEqual(partsOf(rag, "nope"), []);
});

test("inside a layer: its components opened, other layers' parts that belong to it, and neighbours closed", () => {
  assert.deepEqual(openableLayers(rag).map((l) => l.key), ["frontend", "backend", "data", "ml"]);
  const ml = insideOf(rag, "ml");
  assert.deepEqual(ml.groups.map((g) => [g.node.id, g.partial, g.parts.map((p) => p.id)]), [
    ["llm", false, []],
    ["worker", true, ["worker.chunk", "worker.embed"]],
  ]);
  // Chunk → Embed inside the worker, Embed → the vector index (closed: it's data), and the API's
  // call to Claude (Claude is opened whole). The ingest job isn't ML, so its link stays out.
  assert.deepEqual(ml.links.map((l) => `${l.from.node}/${l.from.part}>${l.to.node}/${l.to.part}`), ["worker/worker.chunk>worker/worker.embed", "worker/worker.embed>vdb/null", "api/null>llm/null"]);
  assert.deepEqual(ml.stubs.map((n) => n.id), ["api", "vdb"]);

  const backend = insideOf(rag, "backend");
  assert.deepEqual(backend.groups.map((g) => [g.node.id, g.partial]), [["api", false], ["worker", false]]);
  const toAsk = backend.links.find((l) => l.from.node === "web");
  assert.deepEqual(toAsk.to, { node: "api", part: "api#0" }, "the link's contract lands on the route it names");
  const data = insideOf(rag, "data");
  assert.deepEqual(data.links.map((l) => `${l.from.node}>${l.to.node}/${l.to.part}`), ["worker>vdb/chunks"], "the embed step writes into the chunks table");
});

test("inside a layer, drawn and exported: frames, parts, closed neighbours, and a Mermaid flowchart", () => {
  const sk = drawInside(rag, "ml");
  assert.ok(sk.some((e) => e.id === "in:g:worker" && e.strokeStyle === "dashed"));
  assert.ok(sk.some((e) => e.id === "in:p:worker:worker.embed"));
  assert.ok(sk.some((e) => e.id === "in:s:vdb"), "the vector index is a closed box");
  assert.ok(sk.filter((e) => e.type === "arrow").length >= 3);
  assert.equal(drawInside(rag, "external").length, 0, "nothing in that layer");
  const mm = toInsideMermaid(rag, "ml");
  assert.match(mm, /^flowchart LR\n/);
  assert.match(mm, /subgraph n_worker\["Ingest worker \(ML parts\)"\]/);
  assert.match(mm, /p_worker_chunk -->\|"chunks"\| p_worker_embed/);
  assert.match(mm, /class n_api,n_vdb stub/);
});
