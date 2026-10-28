// The UML view (src/engine/uml.js): class, component, sequence and activity diagrams from the
// board's model, the ones ticked stacked together, and each as Mermaid; the class op behind the
// class diagram, through the tool, the shorthand and the decision log.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classesOf, drawActivity, drawClasses, drawComponents, drawUml, mergeClass, toActivityMermaid, toClassMermaid, toComponentMermaid, toUmlMermaid, UML_KINDS } from "../src/engine/uml.js";
import { parseSteps } from "../src/engine/views.js";
import { parseLine } from "../server/shorthand.js";
import { Op } from "../server/board-tool.js";

const model = {
  nodes: {
    web: { id: "web", name: "Web client", kind: "client", cell: [0, 0], libs: ["React 18"], api: ["Chat view"] },
    api: { id: "api", name: "API server", kind: "service", cell: [1, 0], libs: ["FastAPI"], api: ["POST /ask", "POST /documents", "GET /health", "GET /docs"] },
    vdb: { id: "vdb", name: "Vector index", kind: "data", cell: [2, 0], api: [] },
  },
  edges: { "web>api": { from: "web", to: "api", via: "HTTP" }, "api>vdb": { from: "api", to: "vdb", via: "SQL" } },
  flows: { ask: { id: "ask", name: "Ask a question", steps: parseSteps(["web>api: POST /ask", "api>vdb: top 8 chunks", "api>web: answer"]) } },
  tables: {
    documents: { id: "documents", name: "documents", of: "vdb", columns: [{ name: "id", type: "uuid", pk: true }] },
    chunks: { id: "chunks", name: "chunks", of: "vdb", columns: [{ name: "id", type: "uuid", pk: true }, { name: "document_id", type: "uuid", fk: { table: "documents", col: "id" } }] },
  },
  classes: {},
};
const withClasses = () => {
  const classes = {};
  for (const op of [
    { id: "svc", of: "api", name: "AnswerService", methods: ["answer(q: str): Answer"], uses: ["ret", "ans"] },
    { id: "ret", of: "api", name: "Retriever", attrs: "k: int; db: Session", methods: "search(q: str): list[Chunk]" },
    { id: "ans", of: "api", name: "Answer", attrs: ["text: str"] },
    { id: "emb", of: "api", name: "Embedder", kind: "interface", methods: ["embed(texts): list[Vector]"] },
    { id: "voy", of: "api", name: "VoyageEmbedder", implements: "emb", extends: "base" },
    { id: "base", of: "api", name: "BaseEmbedder", kind: "abstract" },
  ])
    classes[op.id] = mergeClass(classes[op.id], op);
  return { ...model, classes };
};
const ids = (sk) => sk.map((e) => e.id);

test("a class op merges onto what the board had, lists from arrays or from the demo's strings", () => {
  const a = mergeClass(undefined, { id: "ret", of: "api", name: "Retriever", attrs: "k: int; db: Session", uses: "chunk, embedder" });
  assert.deepEqual(a.attrs, ["k: int", "db: Session"]);
  assert.deepEqual(a.uses, ["chunk", "embedder"]);
  assert.equal(a.kind, "class");
  const b = mergeClass(a, { id: "ret", methods: ["search(q: str): list[Chunk]"] });
  assert.deepEqual(b.attrs, a.attrs, "what it didn't send stays");
  assert.deepEqual(b.methods, ["search(q: str): list[Chunk]"]);
  assert.equal(b.name, "Retriever");
});

test("class diagram: the agent's classes with their members and relations; without any, the tables as entities", () => {
  const sk = drawClasses(withClasses());
  for (const id of ["svc", "ret", "ans", "emb", "voy", "base"]) assert.ok(ids(sk).includes(`uc:c:${id}`), id);
  assert.ok(sk.some((e) => e.id === "uc:c:emb:s" && e.text === "«interface»"));
  assert.ok(sk.some((e) => e.id === "uc:c:ret:a0" && e.text === "k: int"));
  const rel = (id) => sk.find((e) => e.id === id);
  assert.equal(rel("uc:r:voy:i0").endArrowhead, "triangle_outline", "realization");
  assert.equal(rel("uc:r:voy:i0").strokeStyle, "dashed");
  assert.equal(rel("uc:r:voy:x").endArrowhead, "triangle_outline", "inheritance");
  assert.notEqual(rel("uc:r:voy:x").strokeStyle, "dashed");
  assert.equal(rel("uc:r:svc:u0").strokeStyle, "dashed", "a dependency");
  // AnswerService → Answer skips over Retriever on the same row: routed over the top, not through it.
  assert.equal(rel("uc:r:svc:u1").points.length, 4);
  assert.ok(rel("uc:r:svc:u1").points[1][1] < 0);

  const fromTables = classesOf(model);
  assert.equal(fromTables.from, "tables");
  assert.deepEqual(fromTables.classes.map((c) => c.name), ["documents", "chunks"]);
  const t = drawClasses(model);
  assert.ok(t.some((e) => e.id === "uc:note"), "it says where they came from");
  assert.ok(t.some((e) => e.id === "uc:r:table:chunks:u0" && e.strokeStyle === "solid"), "a foreign key is an association");
  assert.deepEqual(drawClasses({ nodes: {}, tables: {}, classes: {} }), []);
});

test("component diagram: a box per component with what it provides, dependencies dashed with how", () => {
  const sk = drawComponents(model);
  for (const n of ["web", "api", "vdb"]) assert.ok(ids(sk).includes(`uk:c:${n}`));
  assert.ok(sk.some((e) => e.id === "uk:c:api:s" && e.text === "«component»"));
  assert.equal(sk.filter((e) => e.id.startsWith("uk:c:api:p") && e.id.endsWith(":o")).length, 3, "the first three interfaces");
  assert.ok(sk.some((e) => e.id === "uk:c:api:more" && e.text === "+1 more"));
  const dep = sk.find((e) => e.id === "uk:d:web>api");
  assert.equal(dep.strokeStyle, "dashed");
  assert.ok(sk.some((e) => e.id === "uk:d:web>api:t" && e.text === "«HTTP»"));
});

test("activity diagram: a lane per part, an action per step in the lane that does it, start and end", () => {
  const sk = drawActivity(model, model.flows.ask);
  assert.deepEqual(sk.filter((e) => /^ua:l:[^:]+$/.test(e.id)).map((e) => e.id), ["ua:l:web", "ua:l:api", "ua:l:vdb"]);
  const actions = sk.filter((e) => /^ua:a:\d+$/.test(e.id));
  assert.equal(actions.length, 3);
  const lane = (id) => sk.find((e) => e.id === `ua:l:${id}`);
  const inLane = (a, id) => a.x >= lane(id).x && a.x + a.width <= lane(id).x + lane(id).width;
  assert.ok(inLane(actions[0], "api") && inLane(actions[1], "vdb") && inLane(actions[2], "web"));
  assert.ok(ids(sk).includes("ua:start") && ids(sk).includes("ua:end"));
  assert.deepEqual(drawActivity(model, null), []);
});

test("the UML view: the ticked diagrams in order, one under another, with a line for one that has nothing to show", () => {
  const all = drawUml(withClasses(), { flow: model.flows.ask });
  const heads = all.filter((e) => e.id.startsWith("um:h:"));
  assert.deepEqual(heads.map((e) => e.text), UML_KINDS.map((k) => `${k.label} diagram`));
  for (let i = 1; i < heads.length; i++) assert.ok(heads[i].y > heads[i - 1].y + 100, "stacked, not overlapping");
  assert.equal(new Set(ids(all)).size, all.length, "ids are unique");
  const two = drawUml(withClasses(), { kinds: ["activity", "class"], flow: model.flows.ask });
  assert.deepEqual(two.filter((e) => e.id.startsWith("um:h:")).map((e) => e.text), ["Class diagram", "Activity diagram"]);
  const empty = drawUml({ nodes: {}, edges: {}, flows: {}, tables: {}, classes: {} }, { kinds: ["class", "sequence"] });
  assert.deepEqual(empty.filter((e) => e.id.startsWith("um:e:")).map((e) => e.id), ["um:e:class", "um:e:sequence"]);
  assert.deepEqual(drawUml(model, { kinds: [] }), []);
});

test("each as Mermaid: classDiagram, a flowchart of components, sequenceDiagram, an activity flowchart", () => {
  const cls = toClassMermaid(withClasses());
  assert.match(cls, /^classDiagram\n/);
  assert.match(cls, /class Embedder \{\n {4}<<interface>>/);
  assert.match(cls, /Embedder <\|\.\. VoyageEmbedder/);
  assert.match(cls, /BaseEmbedder <\|-- VoyageEmbedder/);
  assert.match(cls, /AnswerService \.\.> Retriever/);
  assert.match(cls, /answer\(q: str\) Answer/, "a method's return type as Mermaid writes it");
  assert.match(toClassMermaid(model), /chunks --> documents/, "tables: an association per foreign key");
  const cmp = toComponentMermaid(model);
  assert.match(cmp, /n_web -\.->\|HTTP\| n_api/);
  assert.match(cmp, /provides: POST \/ask, POST \/documents, GET \/health, …/);
  const act = toActivityMermaid(model, model.flows.ask);
  assert.match(act, /subgraph n_vdb_lane\["Vector index"\]\n {4}a1\("top 8 chunks"\)/);
  assert.match(act, /a2 --> stop/);
  const blocks = toUmlMermaid(withClasses(), { kinds: ["sequence", "class"], flow: model.flows.ask });
  assert.deepEqual(blocks.map((b) => b.label), ["Class", "Sequence"]);
  assert.match(blocks[1].body, /^sequenceDiagram/);
  assert.deepEqual(toUmlMermaid({ nodes: {}, flows: {}, tables: {}, classes: {} }), [], "nothing to show, nothing exported");
});

test("the class op: in the tool's schema, as a shorthand line, and in the decision log", async () => {
  assert.ok(Op.safeParse({ op: "class", id: "ret", of: "api", name: "Retriever", attrs: ["k: int"], methods: ["search(q): list"], implements: ["emb"], uses: "chunk", extends: "base" }).success);
  assert.deepEqual(parseLine('class ret of=api name=Retriever attrs="k: int|db: Session" methods="search(q: str): list[Chunk]" uses=chunk|emb'), {
    op: "class", id: "ret", of: "api", name: "Retriever", attrs: ["k: int", "db: Session"], methods: ["search(q: str): list[Chunk]"], uses: ["chunk", "emb"],
  });
  process.chdir(mkdtempSync(path.join(os.tmpdir(), "wb-uml-"))); // the run's recording goes here
  const { Run } = await import("../server/runs.js");
  const run = new Run({ repo: process.cwd(), brief: "x" });
  run.emitOps([{ op: "node", id: "api", name: "API server", kind: "service" }, { op: "class", id: "ret", of: "api", name: "Retriever", methods: ["search(q)"] }]);
  assert.match(run.planMarkdown(), /Classes \(UML\):\n\n```mermaid\nclassDiagram\n {2}class Retriever \{\n {4}search\(q\)/);
  run.stop();
});
