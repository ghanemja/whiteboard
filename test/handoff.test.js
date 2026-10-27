// The decision log is the handoff document: whoever picks the work up next (a person, another
// session, another agent) reads the plan there, diagrams included. Run with `npm test`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv, engine, provider, Run, settings } from "../server/runs.js";

// A Run's mirror of the board without an agent behind it: ops in, decision log out.
function mirror() {
  const run = Object.create(Run.prototype);
  const plans = [];
  Object.assign(run, {
    started: Date.now(),
    nodes: new Map(), edges: new Map(), tasks: new Map(), decisions: new Map(), questions: new Map(), flows: new Map(), tables: new Map(),
    goal: null, steer: null, git: null, tests: new Map(), events: [],
    recorder: { update() {}, decide() {}, setPlan: (p) => plans.push(p), write() {} },
    emit() {},
    touch() {},
  });
  return { run, plans };
}

test("the decision log carries the container view, the data flow, the data model and each flow as Mermaid", () => {
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
    { op: "table", id: "links", name: "links", of: "store", columns: ["code text pk", "url text", "owner uuid fk>users.id"] },
    { op: "table", id: "users", name: "users", of: "store", columns: "id uuid pk; email text unique" },
  ]);
  const plan = plans.at(-1);
  // Names in sentence case (a file name stays as it is), and each component's layer.
  assert.match(plan, /\| Web client \| Client \| Frontend \|/);
  assert.match(plan, /\| Link ranker \| Service \| ML \|/);
  assert.match(plan, /\| store\.js \| Data \| Data \|/);
  // The container view, the data flow, the data model, then the flow, as Mermaid blocks GitHub renders.
  const blocks = [...plan.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 4);
  assert.match(blocks[0], /^flowchart LR/);
  assert.match(blocks[0], /n_api -\.->\|"Queue"\| n_rank/);
  assert.match(blocks[0], /subgraph system\["Linkshort"\]/);
  assert.match(blocks[1], /^flowchart LR/);
  assert.match(blocks[1], /n_store\[\("DS1 · store\.js"\)\]/); // a data store, numbered
  assert.match(blocks[1], /n_web -->\|"POST \/links \{url\}"\| n_api/); // the data, not the protocol
  assert.match(blocks[2], /^erDiagram/);
  assert.match(blocks[2], /users \|\|--o\{ links : "owner"/);
  assert.match(blocks[3], /^sequenceDiagram\n {2}title Shorten a link\n {2}autonumber/);
  assert.match(blocks[3], /n_api-->>n_web: \{code\}/);
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
  assert.equal([...plan.matchAll(/```mermaid/g)].length, 2); // container view and data flow; no flow, no tables
});

test("AGENT_ENGINE=codex runs Codex, with its own model unless AGENT_MODEL names one", () => {
  assert.equal(engine({}), "claude");
  assert.equal(engine({ AGENT_ENGINE: " Codex " }), "codex");
  assert.equal(engine({ AGENT_ENGINE: "gpt" }), "claude", "anything else is Claude");
  assert.equal(provider({ AGENT_ENGINE: "codex" }), "Codex", "live without an Anthropic key: Codex signs in by itself");
  assert.deepEqual(settings({ AGENT_ENGINE: "codex" }), { model: null, effort: null });
  assert.deepEqual(settings({ AGENT_ENGINE: "codex", AGENT_MODEL: "gpt-5-codex", AGENT_EFFORT: "high" }), { model: "gpt-5-codex", effort: "high" });
  assert.deepEqual(settings({}), { model: "claude-opus-5-5", effort: "low" });
});

test("which provider the agent runs on, from the variables Claude Code reads", () => {
  assert.equal(provider({}), null); // nothing set: the scripted demo
  assert.equal(provider({ ANTHROPIC_API_KEY: "" }), null);
  assert.equal(provider({ ANTHROPIC_API_KEY: "sk-ant-x" }), "Anthropic API");
  assert.equal(provider({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-x" }), "Anthropic API");
  assert.equal(provider({ ANTHROPIC_BASE_URL: "http://localhost:11434", ANTHROPIC_AUTH_TOKEN: "ollama" }), "Ollama (localhost:11434)");
  assert.equal(provider({ ANTHROPIC_BASE_URL: "http://localhost:4000", ANTHROPIC_AUTH_TOKEN: "sk-litellm" }), "localhost:4000");
  assert.equal(provider({ ANTHROPIC_BASE_URL: "http://localhost:4000" }), null); // a gateway needs a credential
  assert.equal(provider({ CLAUDE_CODE_USE_BEDROCK: "1" }), "Amazon Bedrock");
  assert.equal(provider({ CLAUDE_CODE_USE_MANTLE: "true" }), "Amazon Bedrock");
  assert.equal(provider({ CLAUDE_CODE_USE_VERTEX: "1" }), "Google Vertex AI");
  assert.equal(provider({ CLAUDE_CODE_USE_FOUNDRY: "1" }), "Microsoft Foundry");
  assert.equal(provider({ CLAUDE_CODE_USE_BEDROCK: "0", ANTHROPIC_API_KEY: "sk-ant-x" }), "Anthropic API");
});

test("three settings: AGENT_URL (left out for Anthropic), AGENT_KEY (left out when local), AGENT_MODEL", () => {
  // Anthropic's API: just a key.
  assert.equal(provider({ AGENT_KEY: "sk-ant-x" }), "Anthropic API");
  assert.equal(agentEnv({ AGENT_KEY: "sk-ant-x" }).ANTHROPIC_API_KEY, "sk-ant-x");
  assert.equal(provider({ AGENT_URL: "https://api.anthropic.com", AGENT_KEY: "sk-ant-x" }), "Anthropic API");
  // A local server: a URL and a model, no key.
  const local = agentEnv({ AGENT_URL: "http://localhost:11434", AGENT_MODEL: "qwen3-coder", ANTHROPIC_API_KEY: "sk-ant-old" });
  assert.equal(local.ANTHROPIC_BASE_URL, "http://localhost:11434");
  assert.equal(local.ANTHROPIC_AUTH_TOKEN, "none");
  assert.equal(local.ANTHROPIC_API_KEY, ""); // empty, so the SDK doesn't sign in to Anthropic instead
  assert.equal(local.ANTHROPIC_MODEL, "qwen3-coder");
  assert.equal(local.ANTHROPIC_DEFAULT_HAIKU_MODEL, "qwen3-coder"); // background work on the same model
  assert.equal(provider({ AGENT_URL: "http://localhost:11434", AGENT_MODEL: "qwen3-coder" }), "Ollama (localhost:11434)");
  // A hosted endpoint: URL, key and model.
  const hosted = agentEnv({ AGENT_URL: "https://openrouter.ai/api", AGENT_KEY: "sk-or-x", AGENT_MODEL: "moonshotai/kimi-k2", ANTHROPIC_DEFAULT_HAIKU_MODEL: "kept" });
  assert.equal(hosted.ANTHROPIC_AUTH_TOKEN, "sk-or-x");
  assert.equal(hosted.ANTHROPIC_DEFAULT_HAIKU_MODEL, "kept"); // a tier you set yourself stays
  assert.equal(hosted.ANTHROPIC_DEFAULT_OPUS_MODEL, "moonshotai/kimi-k2");
  assert.equal(provider({ AGENT_URL: "https://openrouter.ai/api", AGENT_KEY: "sk-or-x" }), "openrouter.ai");
  // Nothing new set: the environment passes through as it was.
  assert.deepEqual(agentEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x" }), { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x" });
});
