// The decision log is the handoff document: whoever picks the work up next (a person, another
// session, another agent) reads the plan there, diagrams included. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Run } from "../server/runs.js";

// A Run's mirror of the board without an agent behind it: ops in, decision log out.
function mirror() {
  const run = Object.create(Run.prototype);
  const plans = [];
  Object.assign(run, {
    started: Date.now(),
    nodes: new Map(), edges: new Map(), tasks: new Map(), decisions: new Map(), questions: new Map(), flows: new Map(),
    goal: null, steer: null, git: null, tests: new Map(), events: [],
    recorder: { update() {}, decide() {}, setPlan: (p) => plans.push(p), write() {} },
    emit() {},
    touch() {},
  });
  return { run, plans };
}

test("the decision log carries the container view and each flow as Mermaid", () => {
  const { run, plans } = mirror();
  run.emitOps([
    { op: "project", name: "Linkshort", goal: "Short links that expire." },
    { op: "node", id: "web", name: "web client", kind: "client", libs: ["React 18"] },
    { op: "node", id: "api", name: "API server", kind: "service", libs: ["node:http (Node 22)"], api: ["POST /links"] },
    { op: "node", id: "rank", name: "link ranker", kind: "service", layer: "ml", libs: ["scikit-learn 1.5"] },
    { op: "node", id: "store", name: "store.js", kind: "data" },
    { op: "edge", from: "web", to: "api", via: "HTTP", api: "POST /links {url}" },
    { op: "edge", from: "api", to: "store", via: "call" },
    { op: "edge", from: "api", to: "rank", via: "queue" },
    { op: "flow", id: "shorten", name: "shorten a link", steps: ["web>api: POST /links {url}", "api>store: save(code, url)", "api>web: {code}"] },
  ]);
  const plan = plans.at(-1);
  // Names in sentence case (a file name stays as it is), and each component's layer.
  assert.match(plan, /\| Web client \| Client \| Frontend \|/);
  assert.match(plan, /\| Link ranker \| Service \| ML \|/);
  assert.match(plan, /\| store\.js \| Data \| Data \|/);
  // The container view, then the flow, as Mermaid blocks GitHub renders.
  const blocks = [...plan.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0], /^flowchart LR/);
  assert.match(blocks[0], /n_api -\.->\|"Queue"\| n_rank/);
  assert.match(blocks[0], /subgraph system\["Linkshort"\]/);
  assert.match(blocks[1], /^sequenceDiagram\n {2}title Shorten a link\n {2}autonumber/);
  assert.match(blocks[1], /n_api-->>n_web: \{code\}/);
});

test("renaming keeps sentence case, and a flow with no usable steps is left out", () => {
  const { run, plans } = mirror();
  run.emitOps([
    { op: "node", id: "w", name: "worker", kind: "service" },
    { op: "rename", id: "w", name: "ingest worker" },
    { op: "flow", id: "f", name: "nothing", steps: "nonsense" },
  ]);
  const plan = plans.at(-1);
  assert.match(plan, /\| Ingest worker \|/);
  assert.equal([...plan.matchAll(/```mermaid/g)].length, 1);
});
