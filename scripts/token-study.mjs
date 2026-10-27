#!/usr/bin/env node
// Token-cost study: the whiteboard vs. a chat assistant vs. the same agent without the board.
// Every number in docs/TOKEN_STUDY.md comes from this script.
//
//   node scripts/token-study.mjs               prints every table
//   node scripts/token-study.mjs --dump <dir>  also writes every text it counts to <dir>
//
// Counting, best first:
//   1. ANTHROPIC_API_KEY set: Anthropic's token-counting endpoint (client.messages.countTokens),
//      exact for Claude. Sent to api.anthropic.com (or TOKEN_STUDY_BASE_URL, a proxy in front of
//      it), never to ANTHROPIC_BASE_URL: the counts are for Claude.
//   2. js-tiktoken installed (npm i --no-save js-tiktoken, or TOKENIZER_DIR=<a folder whose
//      node_modules has it>): o200k_base. Exact for OpenAI's GPT-5 family (Codex), an
//      approximation for Claude.
//   3. Neither: characters / 4, a rough estimate.
//
// Nothing here calls a model. The texts are exact (the real instructions, tool schemas, plan-gate
// messages, and the board state that read_board returns, and the scripted DocQA demo standing in
// for the agent's output); only the counting and the request model (one request per user turn, plus
// one per tool call) are estimates.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { BOARD_INSTRUCTIONS, CODEX_BOARD_INSTRUCTIONS, CODEX_PLAN_INSTRUCTIONS, PLAN_INSTRUCTIONS } from "../server/instructions.js";
import { boardReply, Op, READ_BOARD, UPDATE_BOARD } from "../server/board-tool.js";
import { ClaudeRun, settings } from "../server/runs.js";
import { createStreamParser } from "../src/engine/parser.js";
import { BUILD_SCRIPT, PLAN_SCRIPT } from "../src/agent/script.js";
import { buildChatReply, buildEditsReply } from "../src/agent/replies.js";
import { areaOf } from "../src/engine/timeline.js";
import { parseLinks, sentenceCase } from "../src/engine/views.js";
import { DECISION, PHASES, PROOF } from "../src/engine/palette.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// ---- prices: Claude Opus 5.5 (claude-opus-5-5), USD per million tokens ----
// From the claude-api skill's model table (cached 2026-10-06) and its Opus 5.5 migration notes:
// input $4, output $20, 5-minute cache write $5 (1.25x), cache read $0.20 (0.05x). Check
// https://www.anthropic.com/pricing before budgeting on them.
const PRICE = { model: "claude-opus-5-5", input: 4, output: 20, write: 5, read: 0.2 };
const usd = (t, rate) => (t * rate) / 1e6;

// ---- counting ----
async function makeCounter() {
  const model = settings().model;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await apiCounter(model);
    } catch (err) {
      console.warn(`Token counting API failed (${err.message}); counting offline instead.\n`);
    }
  }
  const enc = loadTiktoken();
  if (enc) {
    const n = (t) => (t ? enc.encode(t).length : 0);
    return {
      name: "js-tiktoken o200k_base (exact for OpenAI's GPT-5 family / Codex; an approximation for Claude)",
      short: "o200k_base",
      exact: false,
      text: async (t) => n(t),
      tool: async (def) => n(JSON.stringify(def)),
      system: async (t) => n(`\n\n${t}`),
    };
  }
  const n = (t) => Math.ceil((t ?? "").length / 4);
  return {
    name: "characters / 4 (rough estimate: no API key and no js-tiktoken)",
    short: "chars/4",
    exact: false,
    text: async (t) => n(t),
    tool: async (def) => n(JSON.stringify(def)),
    system: async (t) => n(`\n\n${t}`),
  };
}

// Exact Claude counts. Sent to Anthropic's API (TOKEN_STUDY_BASE_URL only for a proxy in front of
// it), not ANTHROPIC_BASE_URL: another Anthropic-format endpoint wouldn't count Claude's tokens.
async function apiCounter(model) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, baseURL: process.env.TOKEN_STUDY_BASE_URL || "https://api.anthropic.com", maxRetries: 5 });
  const memo = new Map();
  const raw = async (params) => {
    const key = JSON.stringify(params);
    if (!memo.has(key)) memo.set(key, (await client.messages.countTokens({ model, ...params })).input_tokens);
    return memo.get(key);
  };
  const msg = (text) => [{ role: "user", content: text }];
  // Each count is a whole request's, so take away the framing a one-token message carries.
  const base = (await raw({ messages: msg("x") })) - 1;
  const dummy = { name: "noop", description: "Does nothing.", input_schema: { type: "object", properties: {} } };
  const withTool = await raw({ messages: msg("x"), tools: [dummy] });
  const stand = "You are a coding agent.";
  const withSystem = await raw({ messages: msg("x"), system: stand });
  return {
    name: `Anthropic count_tokens (${model}), exact for Claude`,
    short: "count_tokens",
    exact: true,
    text: async (t) => (t ? (await raw({ messages: msg(t) })) - base : 0),
    // A tool next to another, so the API's tool-use preamble (Claude Code has it anyway) isn't counted.
    tool: async (def) => (await raw({ messages: msg("x"), tools: [dummy, def] })) - withTool,
    // Appended to an existing system prompt, as runs.js does.
    system: async (t) => (await raw({ messages: msg("x"), system: `${stand}\n\n${t}` })) - withSystem,
  };
}

function loadTiktoken() {
  for (const dir of [ROOT, process.cwd(), process.env.TOKENIZER_DIR].filter(Boolean)) {
    try {
      const { getEncoding } = createRequire(path.join(path.resolve(dir), "noop.js"))("js-tiktoken");
      return getEncoding("o200k_base");
    } catch {
      /* not installed there */
    }
  }
  return null;
}

// ---- what the agent sees: the tool as the API gets it ----
// zod → JSON Schema the way the MCP SDK does it (draft-7, input side). "$schema" is left out.
function toolDef(def = UPDATE_BOARD, name = `mcp__board__${def.name}`) {
  const { $schema, ...schema } = z.toJSONSchema(z.object(def.input), { target: "draft-7", io: "input" });
  return { name, description: def.description, input_schema: schema };
}

// ---- the demo's agent output, as a live agent sends it ----
// Demo tags carry lists as "a, b" (steps, columns and links as "a; b"); the update_board tool
// takes arrays. Tags the tool doesn't have (tour, ask, run, diff) are the demo's stage directions,
// and keys it doesn't have (the demo's cause) are the server's job.
const OPS = new Set(Op.shape.op.options);
const KEYS = new Set(Object.keys(Op.shape));
const COMMA = new Set(["over", "affects", "evidence", "builds_on", "paths", "libs", "options"]);
const SEMI = new Set(["steps", "columns", "links"]);
function toToolOp(a) {
  const op = {};
  for (const [k, v] of Object.entries(a)) {
    if (!KEYS.has(k) || v === "") continue;
    if (k === "col" || k === "row") op[k] = Number(v);
    else if (COMMA.has(k) || (k === "api" && a.op === "node")) op[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
    else if (SEMI.has(k)) op[k] = v.split(";").map((s) => s.trim()).filter(Boolean);
    else op[k] = v;
  }
  return op;
}

// Agent text with inline <board/> tags → { text, ops, stage } (stage: the demo-only tags).
function parseAgent(str) {
  let text = "";
  const ops = [];
  const stage = [];
  const p = createStreamParser({ onText: (t) => (text += t), onOp: (a) => (OPS.has(a.op) ? ops.push(toToolOp(a)) : stage.push(a)) });
  p.push(str);
  p.end();
  return { text: text.replace(/[ \t]+/g, " ").replace(/ ([.,:;])/g, "$1").trim(), ops, stage };
}
const callJson = (ops) => JSON.stringify({ ops });
const resultText = (ops) => boardReply(ops).content[0].text;

// ---- the browser board's model, for read_board ----
// Board.snapshot() (src/engine/board.js) is what the browser answers a read_board request with, but
// board.js imports Excalidraw, so its model and snapshot are mirrored here.
const KINDS = ["client", "service", "data", "external", "queue", "test", "user"];
const STATUS = new Set(["planned", "building", "built", "verified", "failed", "live"]);
const TASK = new Set(["todo", "building", "done", "failed"]);
const QSTATES = ["open", "answered", "confirmed", "corrected"];
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => String(s).trim()).filter(Boolean);

class BoardModel {
  constructor() {
    this.m = { project: "", goal: "", phase: null, nodes: {}, edges: {}, decisions: {}, tasks: {}, questions: {}, notes: [], kept: [], slots: {} };
  }
  apply(a) {
    const m = this.m;
    switch (a.op) {
      case "project":
        if (a.goal) m.goal = a.goal;
        if (a.name) m.project = a.name;
        return;
      case "phase":
        if (a.name === "complete" || PHASES.some((p) => p.key === a.name)) m.phase = a.name;
        return;
      case "task": {
        const t = m.tasks[a.id];
        if (!t) {
          if (!a.id || !a.text) return;
          const valid = (k) => PHASES.some((p) => p.key === k);
          const ph = valid(a.phase) ? a.phase : valid(m.phase) ? m.phase : m.phase === "complete" ? "deployment" : "planning";
          m.slots[ph] = (m.slots[ph] ?? 0) + 1;
          m.tasks[a.id] = { id: a.id, phase: ph, text: a.text, status: TASK.has(a.status) ? a.status : "todo" };
        } else {
          if (a.text) t.text = a.text;
          if (TASK.has(a.status)) t.status = a.status;
        }
        return;
      }
      case "node":
      case "adopt": {
        if (!a.id) return;
        const n = m.nodes[a.id];
        if (n) {
          if (a.libs != null) n.libs = list(a.libs);
          if (a.api != null) n.api = list(a.api);
          return;
        }
        if (!a.name) return;
        m.nodes[a.id] = {
          id: a.id, name: sentenceCase(a.name), kind: KINDS.includes(a.kind) ? a.kind : "service",
          status: STATUS.has(a.v) ? a.v : STATUS.has(a.status) ? a.status : "planned",
          cell: this.freeCell(a.col ?? 0, a.row ?? 0), libs: list(a.libs), api: list(a.api),
        };
        return;
      }
      case "edge":
      case "adopt-edge": {
        const key = `${a.from}>${a.to}`;
        const e = m.edges[key];
        if (e) {
          if (a.via) e.via = a.via;
          if (a.api) e.api = a.api;
        } else if (m.nodes[a.from] && m.nodes[a.to]) m.edges[key] = { from: a.from, to: a.to, via: a.via ?? null, api: a.api ?? null };
        return;
      }
      case "status":
        if (m.nodes[a.id] && STATUS.has(a.v)) m.nodes[a.id].status = a.v;
        return;
      case "rename":
        if (m.nodes[a.id] && a.name) m.nodes[a.id].name = sentenceCase(a.name);
        return;
      case "remove":
        if (!m.nodes[a.id]) return;
        for (const [k, e] of Object.entries(m.edges)) if (e.from === a.id || e.to === a.id) delete m.edges[k];
        delete m.nodes[a.id];
        return;
      case "unlink":
        delete m.edges[`${a.from}>${a.to}`];
        return;
      case "note":
      case "adopt-note":
        m.notes.push(a.text ?? "");
        return;
      case "decision": {
        if (!a.id) return;
        const prev = m.decisions[a.id];
        if (!prev && !a.title && !a.chose) return;
        const inPlanning = !m.phase || m.phase === "planning";
        const changed = prev && a.chose && a.chose !== prev.chose;
        const result = PROOF[a.proof] ? a.proof : null;
        m.decisions[a.id] = {
          id: a.id,
          title: a.title ?? prev?.title ?? a.id,
          chose: a.chose ?? prev?.chose ?? "",
          over: a.over != null ? list(a.over) : prev?.over ?? [],
          why: a.why ?? prev?.why ?? "",
          affects: a.affects != null ? list(a.affects) : prev?.affects ?? [],
          state: DECISION[a.state] ? a.state : changed ? "changed" : prev?.state ?? (inPlanning ? "proposed" : "accepted"),
          verify: a.verify ?? prev?.verify ?? "",
          proof: result ?? (changed ? null : prev?.proof ?? null),
        };
        return;
      }
      case "question":
      case "assumption": {
        if (!a.id) return;
        const prev = m.questions[a.id];
        if (!prev && !a.text) return;
        const kind = prev?.kind ?? (a.op === "assumption" ? "assumption" : "question");
        m.questions[a.id] = {
          id: a.id, kind,
          n: prev?.n ?? Object.values(m.questions).filter((x) => x.kind === kind).length + 1,
          text: a.text ?? prev.text,
          options: a.options != null ? list(a.options) : prev?.options ?? [],
          state: QSTATES.includes(a.state) ? a.state : prev?.state ?? "open",
          answer: a.answer ?? prev?.answer ?? null,
        };
        return;
      }
      default: // part, flow, table, answer: drawn, but not in the snapshot
    }
  }
  freeCell(col, row) {
    const taken = new Set(Object.values(this.m.nodes).map((n) => n.cell.join()));
    const clamp = (v) => Math.max(0, Math.min(2, Number.isFinite(+v) ? Math.round(+v) : 0));
    const want = [clamp(col), clamp(row)];
    if (!taken.has(want.join())) return want;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!taken.has(`${c},${r}`)) return [c, r];
    const n = taken.size - 9;
    return [n % 3, 3 + Math.floor(n / 3)];
  }
  acceptDecisions() {
    for (const d of Object.values(this.m.decisions)) if (d.state === "proposed") d.state = "accepted";
  }
  // Same fields, same order, as Board.snapshot().
  snapshot() {
    const m = this.m;
    const nodes = Object.values(m.nodes).map(({ id, name, kind, status, cell, libs, api }) => ({
      id, name, kind, status, ...(cell ? { col: cell[0], row: cell[1] } : {}), ...(libs?.length ? { libs } : {}), ...(api?.length ? { api } : {}),
    }));
    const taken = new Set(nodes.filter((n) => "col" in n).map((n) => `${n.col},${n.row}`));
    const free_cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!taken.has(`${c},${r}`)) free_cells.push({ col: c, row: r });
    return {
      project: m.project || null,
      goal: m.goal || null,
      phase: m.phase,
      nodes,
      edges: Object.values(m.edges).map(({ from, to, via, api }) => ({ from, to, ...(via ? { via } : {}), ...(api ? { api } : {}) })),
      decisions: Object.values(m.decisions).map(({ id, title, chose, over, why, affects, state, verify, proof }) => ({
        id, title, chose, over, why, affects, state, ...(verify ? { verify } : {}), ...(proof ? { proof } : {}),
      })),
      tasks: Object.values(m.tasks).map(({ id, phase, text, status }) => ({ id, phase, text, status })),
      ...(Object.keys(m.questions).length
        ? { questions: Object.values(m.questions).map(({ id, kind, text, state, answer }) => ({ id, kind, text, state, ...(answer ? { answer } : {}) })) }
        : {}),
      free_cells,
      notes: m.notes.length,
      ...(m.kept.length ? { kept: m.kept } : {}),
    };
  }
}

// ---- the server's side: its mirror of the plan, and what it sends the agent ----
// A ClaudeRun without an agent (as test/handoff.test.js does): ops in, planMarkdown() out, and
// control() builds the exact message the agent gets at the plan gate.
function serverMirror() {
  const run = Object.create(ClaudeRun.prototype);
  Object.assign(run, {
    id: "study", started: Date.now(), turnText: "", steer: null, git: null, goal: null, phase: null,
    nodes: new Map(), edges: new Map(), tasks: new Map(), decisions: new Map(), questions: new Map(), flows: new Map(), tables: new Map(),
    tests: new Map(), events: [], pending: new Map(), listeners: new Set(),
    recorder: { update() {}, decide() {}, setPlan() {}, write() {} },
    emit() {},
    touch() {},
  });
  run.parts = new Map(); // the server doesn't keep parts; the prose plan needs them
  return run;
}

// The message the agent gets when the user sends this (runs.js control()): at the plan gate, the
// answer to its ExitPlanMode call; otherwise a user turn. null when nothing is sent (a plain approve).
// It carries only what changed; the board itself is read with read_board when the agent asks.
function gateMessage(run, body, { gated = true } = {}) {
  let out = null;
  const keep = { events: run.events, pending: run.pending, inbox: run.inbox };
  run.events = gated ? [{ type: "gate", requestId: "gate" }] : [];
  run.pending = new Map([["gate", (r) => (out = r.message ?? null)]]);
  run.inbox = { push: (m) => (out = m.message.content) };
  run.control(body);
  Object.assign(run, keep);
  return out;
}

// Board edits as the browser sends them (session.js wire()): no dedupe key, plus their area.
const wire = (edits) => edits.map(({ key, ...d }) => ({ ...d, area: areaOf(d) }));

// Ops land on both models (the server's mirror and the browser's board), as in a live run.
function draw(run, board, ops) {
  for (const op of ops) {
    if (op.op === "part") run.parts.set(op.id, { ...run.parts.get(op.id), ...op });
    board.apply(op);
  }
  run.emitOps(structuredClone(ops));
}

// ---- the same plan as prose: the baseline ----
// Run.planMarkdown() (the decision log's plan) without its Mermaid diagrams, which redraw what
// its tables already say, plus what it leaves to the diagrams or the board: the parts inside each
// component, the flows, the data model and the steps. Same information as the ops.
function prosePlan(run) {
  const name = (id) => run.nodes.get(id)?.name ?? id;
  // The lines the server derives for the decision log (what a decision was before, and why it
  // changed) aren't something an assistant writes, so they're left out too.
  const log = run.planMarkdown().split("\n").filter((l) => !/^- \*\*(Before|Changed because):\*\*/.test(l)).join("\n");
  const sections = Object.fromEntries(log.split(/\n(?=### )/).map((s) => [s.match(/^### (.+)/)?.[1] ?? "", s.trim()]));
  const extra = {};
  const parts = [...run.parts.values()].filter((p) => run.nodes.has(p.of));
  if (parts.length) {
    const lines = ["### Inside the components", ""];
    for (const [id, n] of run.nodes) {
      const own = parts.filter((p) => p.of === id);
      if (own.length) lines.push(`- **${n.name}:** ${own.map((p) => `${p.name} (${p.kind}${p.layer ? `, ${p.layer}` : ""})${parseLinks(p.links).map((l) => ` → ${l.to}${l.what ? `: ${l.what}` : ""}`).join(";")}`).join("; ")}`);
    }
    extra.inside = lines.join("\n");
  }
  if (run.flows.size)
    extra.flows = ["### Flows", "", ...[...run.flows.values()].map((f) => `- **${f.name}:** ${f.steps.map((s, i) => `${i + 1}. ${name(s.from)} → ${name(s.to)}: ${s.what}`).join(" ")}`)].join("\n");
  if (run.tables.size) {
    const col = (c) => `${c.name} ${c.type}${c.pk ? " pk" : ""}${c.unique ? " unique" : ""}${c.fk ? ` → ${c.fk.table}.${c.fk.col}` : ""}`;
    extra.data = ["### Data model", "", ...[...run.tables.values()].map((t) => `- **${t.name}** (${name(t.of)}): ${t.columns.map(col).join(", ")}`)].join("\n");
  }
  if (run.tasks.size) extra.steps = ["### Steps", "", ...[...run.tasks.values()].map((t) => `- ${t.text} (${t.status})`)].join("\n");
  return [sections.Goal, sections.Architecture, extra.inside, sections.Connections, extra.flows, extra.data, sections["Questions and assumptions"], sections.Decisions, extra.steps]
    .filter(Boolean)
    .join("\n\n");
}

// What changed between two versions of the plan, line by line (an LCS diff): what an agent's
// Edit of its plan file replaces (old) and writes (new).
function lineDiff(a, b) {
  const A = a.split("\n"), B = b.split("\n");
  const dp = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--)
    for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const removed = [], added = [];
  let i = 0, j = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) i++, j++;
    else if (dp[i + 1][j] >= dp[i][j + 1]) removed.push(A[i++]);
    else added.push(B[j++]);
  }
  while (i < A.length) removed.push(A[i++]);
  while (j < B.length) added.push(B[j++]);
  return { removed: removed.join("\n"), added: added.join("\n") };
}

// ---- requests and what they cost ----
// A conversation is a list of requests { label, input, output, cold? }: input is what's new in
// this request (a user turn, a tool result), output what the model writes. Each request also
// resends the fixed prefix and everything before it.
//   cached (the agent, B and the whiteboard): the first request writes the prefix and its input
//   to the cache; every later one reads what the previous one sent and writes what's new (the
//   previous output and this input). A cold request (the user took more than 5 minutes) writes
//   everything again.
//   uncached (the chat assistant): every request pays full price for all of it.
function simulate(reqs, { fixed = 0, cached = true } = {}) {
  let history = 0, prevOut = 0;
  const rows = [];
  const t = { requests: reqs.length, input: 0, output: 0, base: 0, write: 0, read: 0 };
  reqs.forEach((r, i) => {
    const input = fixed + history + r.input;
    let write = 0, read = 0, base = 0;
    if (!cached) base = input;
    else if (i === 0 || r.cold) write = input;
    else {
      write = prevOut + r.input;
      read = input - write;
    }
    rows.push({ label: r.label, input, output: r.output, write, read, base });
    Object.assign(t, { input: t.input + input, output: t.output + r.output, base: t.base + base, write: t.write + write, read: t.read + read });
    history += r.input + r.output;
    prevOut = r.output;
  });
  t.cost = usd(t.base, PRICE.input) + usd(t.write, PRICE.write) + usd(t.read, PRICE.read) + usd(t.output, PRICE.output);
  t.context = fixed + history; // what a next request would resend
  return { rows, t };
}

// ---- output ----
const fmt = (n) => Math.round(n).toLocaleString("en-US");
const money = (n) => `$${n.toFixed(4)}`;
const pct = (n) => `${n >= 0 ? "+" : ""}${Math.round(n * 100)}%`;
// Numbers right-aligned, words left.
function table(headers, rows) {
  const numeric = (i) => i > 0 && rows.every((r) => /^[*\s]*([-+$\d]|n\/a)/.test(String(r[i])));
  const out = [`| ${headers.join(" | ")} |`, `|${headers.map((h, i) => (numeric(i) ? "---:" : "---")).join("|")}|`];
  for (const r of rows) out.push(`| ${r.join(" | ")} |`);
  console.log(`${out.join("\n")}\n`);
}
const h = (s) => console.log(`\n## ${s}\n`);

// --dump <dir>: write every text the study counts, to read or count another way.
const dumpDir = process.argv.includes("--dump") ? path.resolve(process.argv[process.argv.indexOf("--dump") + 1] ?? "token-study-texts") : null;
function dump(file, text) {
  if (!dumpDir) return;
  mkdirSync(dumpDir, { recursive: true });
  writeFileSync(path.join(dumpDir, file), text);
}

// ---- the study ----
const tok = await makeCounter();
const count = (s) => tok.text(s);

console.log("# Token study: Agent Whiteboard\n");
console.log(`Counted with: ${tok.name}.`);
const claude = settings({});
const codex = settings({ AGENT_ENGINE: "codex" });
console.log(`Agents (server/runs.js settings()): Claude Agent SDK, model ${claude.model}, effort ${claude.effort}; Codex (AGENT_ENGINE=codex), model ${codex.model ?? "Codex's default"}, effort ${codex.effort ?? "Codex's default"}.`);
const rate = (n) => `$${n.toFixed(2)}`;
console.log(`Priced at ${PRICE.model}: input ${rate(PRICE.input)}, output ${rate(PRICE.output)}, cache write (5 min) ${rate(PRICE.write)}, cache read ${rate(PRICE.read)} per million tokens.`);
console.log("B and the whiteboard exclude what they share: Claude Code's own system prompt and tools, the repo reads, and the build work itself.");

// 1. Fixed overhead: what the board adds to every request.
const tool = toolDef();
const readTool = toolDef(READ_BOARD);
const fixedParts = {
  instructions: await tok.system(BOARD_INSTRUCTIONS),
  tool: await tok.tool(tool),
  readTool: await tok.tool(readTool),
};
const FIXED = fixedParts.instructions + fixedParts.tool + fixedParts.readTool;
dump("tool.json", JSON.stringify(tool, null, 1));
dump("read-board-tool.json", JSON.stringify(readTool, null, 1));
const planInstr = await count(PLAN_INSTRUCTIONS);
const codexParts = {
  instructions: await count(CODEX_BOARD_INSTRUCTIONS),
  plan: await count(CODEX_PLAN_INSTRUCTIONS),
  tool: await tok.tool(toolDef(UPDATE_BOARD, UPDATE_BOARD.name)),
  readTool: await tok.tool(toolDef(READ_BOARD, READ_BOARD.name)),
};
h("1. Fixed overhead per request (what the board adds to every model request)");
table(
  ["Piece", "Where", "Tokens"],
  [
    ["BOARD_INSTRUCTIONS", "appended to the system prompt", fmt(fixedParts.instructions)],
    ["update_board tool definition", "tools (name, description, JSON schema)", fmt(fixedParts.tool)],
    ["read_board tool definition", "tools (name, description, JSON schema)", fmt(fixedParts.readTool)],
    ["**Total, every request**", "cached prefix", `**${fmt(FIXED)}**`],
    ["PLAN_INSTRUCTIONS", "once, in plan mode (replaces Claude Code's default plan text; counted in full)", fmt(planInstr)],
    ["Codex: CODEX_BOARD_INSTRUCTIONS", "developer instructions, every request", fmt(codexParts.instructions)],
    ["Codex: update_board over MCP", "tools, every request", fmt(codexParts.tool)],
    ["Codex: read_board over MCP", "tools, every request", fmt(codexParts.readTool)],
    ["Codex: CODEX_PLAN_INSTRUCTIONS", "once, in the first turn", fmt(codexParts.plan)],
  ],
);
console.log(`Per request, cached: ${money(usd(FIXED, PRICE.read))} (read). First request: ${money(usd(FIXED, PRICE.write))} (write). Uncached: ${money(usd(FIXED, PRICE.input))}.`);
console.log(`Tool schema: ${JSON.stringify(tool.input_schema).length.toLocaleString("en-US")} characters of JSON.`);

// 2. The plan: the demo's ops vs. the same plan as prose.
const BRIEF = "Build DocQA: people upload PDFs and ask questions about them, and every answer cites the page it came from.";
const run = serverMirror();
const board = new BoardModel();
const plan = parseAgent(PLAN_SCRIPT);
draw(run, board, plan.ops);
const md = [prosePlan(run)];
const logMd = run.planMarkdown();
const planOut = { narration: await count(plan.text), call: await count(callJson(plan.ops)) };
const planMd = await count(md[0]);
dump("plan-0-prose.md", md[0]);
dump("plan-0-decision-log.md", logMd);
dump("plan-0-update_board.json", callJson(plan.ops));
dump("plan-0-narration.txt", plan.text);
h("2. Writing the first plan (output tokens)");
table(
  ["Form", "What", "Tokens"],
  [
    ["Prose plan (A, B)", "planMarkdown() without its diagrams, plus parts, flows, tables and steps", fmt(planMd)],
    ["Whiteboard: update_board call", `${plan.ops.length} ops as JSON, one call`, fmt(planOut.call)],
    ["Whiteboard: chat text", "the demo's narration around the ops", fmt(planOut.narration)],
    ["**Whiteboard total**", "", `**${fmt(planOut.call + planOut.narration)}** (${pct((planOut.call + planOut.narration) / planMd - 1)} vs prose)`],
    ["For reference: the decision log's plan", "planMarkdown() as written, with its Mermaid diagrams", fmt(await count(logMd))],
  ],
);

// 3. Three corrections, the ones the demo's tour makes: another option for D1, the answer to Q1,
// and a Not needed sticker on a part (the ingest worker, which inline processing makes redundant).
const corrections = [];
async function correct({ label, typed, body, reply, local }) {
  local?.();
  const message = gateMessage(run, body);
  const r = parseAgent(reply());
  const before = md.at(-1);
  draw(run, board, r.ops);
  const after = prosePlan(run);
  md.push(after);
  const diff = lineDiff(before, after);
  const said = body.type === "chat" ? body.text : `<board_edits>${JSON.stringify(body.edits)}</board_edits>`;
  const n = corrections.length + 1;
  // What read_board returns once the reply's ops are drawn: the whole board, if the agent asks.
  const readResult = JSON.stringify(board.snapshot());
  dump(`correction-${n}-typed.txt`, typed);
  dump(`correction-${n}-board-message.txt`, message);
  dump(`correction-${n}-board-reply.txt`, `${r.text}\n\n${callJson(r.ops)}`);
  dump(`correction-${n}-read-board-result.json`, readResult);
  dump(`correction-${n}-edit-old.md`, diff.removed);
  dump(`correction-${n}-edit-new.md`, diff.added);
  dump(`plan-${n}-prose.md`, after);
  corrections.push({
    label,
    typed: await count(typed),
    said: await count(said),
    message: await count(message),
    readCall: await count(JSON.stringify({ name: READ_BOARD.name, input: {} })),
    readResult: await count(readResult),
    wbOut: (await count(r.text)) + (await count(callJson(r.ops))),
    wbResult: await count(resultText(r.ops)),
    ops: r.ops.length,
    aFull: await count(`${r.text}\n\n${after}`),
    aDelta: await count(`${r.text}\n\n${diff.added}`),
    bEdit: await count(`${r.text}\n\n${diff.removed}\n\n${diff.added}`),
  });
}
// The edits as Board.choice() and stickerEdit() make them.
const d1 = board.m.decisions.d1;
const choose = { key: `choose:d1:${d1.over[0]}`, kind: "choose", decision: "d1", label: "D1", title: d1.title, from: d1.chose, to: d1.over[0] };
await correct({
  label: "Another option for D1",
  typed: "For D1, process uploads during the upload request instead of in a background worker.",
  body: { type: "revise", edits: wire([choose]) },
  reply: () => buildEditsReply([choose], board.m),
});
const q1 = board.m.questions.q1;
const answerText = `About Q${q1.n} (${q1.text}): 50 MB`;
await correct({
  label: "Answer Q1 (50 MB)",
  typed: "The largest PDF people will upload is 50 MB.",
  local: () => board.apply({ op: "question", id: "q1", state: "answered", answer: "50 MB" }), // Session.answerQuestion
  body: { type: "chat", text: answerText },
  reply: () => buildChatReply(answerText),
});
const sticker = { key: "sticker:Xq3vB8nT1kLm9RwZp2YcA:node:worker", kind: "sticker", sticker: "drop", elId: "Xq3vB8nT1kLm9RwZp2YcA", node: "worker", name: board.m.nodes.worker.name };
await correct({
  label: "Not needed on the ingest worker",
  typed: "Drop the ingest worker; we don't need it.",
  body: { type: "revise", edits: wire([sticker]) },
  reply: () => buildEditsReply([sticker], board.m),
});

h("3. Steering: one correction, typed vs. on the board");
table(
  ["Correction", "Typed sentence (A, B)", "Board: the edit or answer itself", "Board: whole message to the agent", "Board: read_board result (only if the agent reads)"],
  corrections.map((c) => [c.label, fmt(c.typed), fmt(c.said), fmt(c.message), fmt(c.readResult)]),
);
const avg = (k) => corrections.reduce((s, c) => s + c[k], 0) / corrections.length;
console.log(`The whole message is what runs.js sends at the plan gate: the edit or answer, and its own wrapper sentence, ${fmt(avg("message"))} tokens on average. The board itself isn't in it. The agent reads it with read_board when it needs it, for ${fmt(avg("readResult"))} tokens on average, plus ${fmt(avg("readCall"))} for the call.\n`);
table(
  ["Correction", "A reply: rewrites the plan", "A reply: changes only", "B: Edit of its plan file (old + new)", "Whiteboard: text + update_board call"],
  corrections.map((c) => [c.label, fmt(c.aFull), fmt(c.aDelta), fmt(c.bEdit), `${fmt(c.wbOut)} (${c.ops} op${c.ops === 1 ? "" : "s"})`]),
);

// 4. Scenarios as request sequences.
const brief = await count(BRIEF);
const planWb = planOut.call + planOut.narration;
const planResult = await count(resultText(plan.ops));
const reqs = {
  aFull: [{ label: "Plan", input: brief, output: planMd }, ...corrections.map((c) => ({ label: c.label, input: c.typed, output: c.aFull, user: true }))],
  aDelta: [{ label: "Plan", input: brief, output: planMd }, ...corrections.map((c) => ({ label: c.label, input: c.typed, output: c.aDelta, user: true }))],
  b: [{ label: "Plan", input: brief, output: planMd }, ...corrections.map((c) => ({ label: c.label, input: c.typed, output: c.bEdit, user: true }))],
  wb: [
    { label: "Plan", input: brief + planInstr, output: planWb },
    { label: "Plan: tool result", input: planResult, output: 0 },
    ...afterPlan(false),
  ],
};
// The whiteboard's requests after the plan. With reads, the agent also calls read_board after each
// correction (the call, then the whole board): the most a message-only design can cost in reads.
function afterPlan(reads) {
  return corrections.flatMap((c) => [
    { label: c.label, input: c.message, output: c.wbOut, user: true },
    { label: `${c.label}: tool result`, input: c.wbResult, output: 0 },
    ...(reads
      ? [
          { label: `${c.label}: read_board`, input: 0, output: c.readCall },
          { label: `${c.label}: read result`, input: c.readResult, output: 0 },
        ]
      : []),
  ]);
}
reqs.wbRead = [...reqs.wb.slice(0, 2), ...afterPlan(true)];
const s1 = {
  a: simulate(reqs.aFull.slice(0, 1), { cached: false }),
  b: simulate(reqs.b.slice(0, 1)),
  wb: simulate(reqs.wb.slice(0, 2), { fixed: FIXED }),
};
const s2 = {
  aFull: simulate(reqs.aFull, { cached: false }),
  aDelta: simulate(reqs.aDelta, { cached: false }),
  b: simulate(reqs.b),
  wb: simulate(reqs.wb, { fixed: FIXED }),
  wbRead: simulate(reqs.wbRead, { fixed: FIXED }),
};

// The build. Both agents make one request per file change and per command the demo shows (the
// fewest a real agent needs), plus one for the closing summary; their content is the same in both,
// so it isn't counted. The whiteboard adds one update_board call per paragraph of the demo that
// draws something: one more request each, whose result the next request carries.
// The demo's build still reports on parts the corrections dropped; those ops are left out.
const removed = new Set(plan.ops.filter((o) => o.op === "node" && !run.nodes.has(o.id)).map((o) => o.id));
const build = BUILD_SCRIPT.split(/\n\n+/).map((p) => {
  const r = parseAgent(p);
  const diffs = r.stage.filter((s) => s.op === "diff").length, runs = r.stage.filter((s) => s.op === "run").length;
  return { ops: r.ops.filter((o) => !(o.op === "status" && removed.has(o.id))), work: diffs + runs, diffs, runs };
});
const buildB = [], buildWb = [];
let buildOut = 0, buildResults = 0, buildCalls = 0, buildOps = 0, pending = 0;
const work = () => ({ label: "Build (shared)", input: 0, output: 0 });
for (const p of build) {
  if (p.ops.length) {
    const out = await count(callJson(p.ops));
    buildWb.push({ label: "Build: update_board", input: pending, output: out });
    pending = await count(resultText(p.ops));
    buildOut += out;
    buildResults += pending;
    buildCalls++;
    buildOps += p.ops.length;
  }
  for (let k = 0; k < p.work; k++) {
    buildB.push(work());
    buildWb.push({ ...work(), input: pending });
    pending = 0;
  }
}
buildB.push({ ...work(), label: "Build: summary" });
buildWb.push({ ...work(), label: "Build: summary", input: pending });
// The first request after the plan gate follows the user's approval.
buildB[0].user = buildWb[0].user = true;
dump("build-ops.json", JSON.stringify(build.map((p) => p.ops), null, 1));
const s3 = {
  b: simulate([...reqs.b, ...buildB]),
  wb: simulate([...reqs.wb, ...buildWb], { fixed: FIXED }),
  wbRead: simulate([...reqs.wbRead, ...buildWb], { fixed: FIXED }),
};

// Cold cache: every user turn (the corrections, and the approval before the build) comes after
// more than 5 minutes, so that request writes the whole context again.
const cold = (rs) => rs.map((r) => (r.user ? { ...r, cold: true } : r));
const s2cold = { b: simulate(cold(reqs.b)), wb: simulate(cold(reqs.wb), { fixed: FIXED }) };
const s3cold = { b: simulate(cold([...reqs.b, ...buildB])), wb: simulate(cold([...reqs.wb, ...buildWb]), { fixed: FIXED }) };

const cell = (s) => `${money(s.t.cost)} (${fmt(s.t.input)} in, ${fmt(s.t.output)} out)`;
const plus = (a, b) => `+${money(a.t.cost - b.t.cost)} (+${fmt(a.t.input - b.t.input)} in, +${fmt(a.t.output - b.t.output)} out)`;
h("4. Summary: cost and tokens per scenario");
table(
  ["Condition", "1. First plan", "2. Plan + 3 corrections", "3. Full run (counted part)"],
  [
    ["A: chat, rewrites the plan", cell(s1.a), cell(s2.aFull), "n/a"],
    ["A: chat, changes only", cell(s1.a), cell(s2.aDelta), "n/a"],
    ["B: agent, no board", cell(s1.b), cell(s2.b), cell(s3.b)],
    ["Whiteboard", cell(s1.wb), cell(s2.wb), cell(s3.wb)],
    ["Whiteboard, reads the board after each correction", cell(s1.wb), cell(s2.wbRead), cell(s3.wbRead)],
    ["**Whiteboard − B**", `**${plus(s1.wb, s1.b)}**`, `**${plus(s2.wb, s2.b)}**`, `**${plus(s3.wb, s3.b)}**`],
  ],
);
console.log("In: input tokens summed over every request (resent history included). A is uncached; B and the whiteboard are priced with prompt caching.\n");

h("5. Requests, turns and the cache split");
const split = (name, s, userTurns) => [name, userTurns, s.t.requests, fmt(s.t.base), fmt(s.t.write), fmt(s.t.read), fmt(s.t.output), money(s.t.cost)];
table(
  ["Condition", "User turns", "Requests", "Uncached in", "Cache write", "Cache read", "Output", "Cost"],
  [
    split("1 · A chat", s1.a, 1),
    split("1 · B agent, no board", s1.b, 1),
    split("1 · Whiteboard", s1.wb, 1),
    split("2 · A chat, rewrites", s2.aFull, 4),
    split("2 · A chat, changes only", s2.aDelta, 4),
    split("2 · B agent, no board", s2.b, 4),
    split("2 · Whiteboard", s2.wb, 4),
    split("2 · Whiteboard, reads after each correction", s2.wbRead, 4),
    split("3 · B agent, no board", s3.b, 5),
    split("3 · Whiteboard", s3.wb, 5),
    split("3 · Whiteboard, reads after each correction", s3.wbRead, 5),
  ],
);
const sum = (k) => build.reduce((s, p) => s + p[k], 0);
console.log(`Scenario 3's build: ${buildB.length} requests both agents make (one per file change and command in the demo: ${sum("diffs")} file changes, ${sum("runs")} commands; plus the closing summary), and ${buildCalls} update_board calls (${buildOps} ops) on the whiteboard.\n`);

h("6. Context growth: input tokens of the request that answers each user turn");
const at = (s, label) => s.rows.find((r) => r.label === label)?.input ?? 0;
table(
  ["User turn", "A chat (rewrites)", "A chat (changes only)", "B agent, no board", "Whiteboard", "Whiteboard − B"],
  ["Plan", ...corrections.map((c) => c.label)].map((l) => [l, fmt(at(s2.aFull, l)), fmt(at(s2.aDelta, l)), fmt(at(s2.b, l)), fmt(at(s2.wb, l)), `+${fmt(at(s2.wb, l) - at(s2.b, l))}`]),
);
console.log(`Context a next request resends after scenario 2: A ${fmt(s2.aFull.t.context)} (rewrites) / ${fmt(s2.aDelta.t.context)} (changes only), B ${fmt(s2.b.t.context)}, whiteboard ${fmt(s2.wb.t.context)} (of which ${fmt(FIXED)} fixed).`);
console.log(`After the full run (scenario 3): B ${fmt(s3.b.t.context)}, whiteboard ${fmt(s3.wb.t.context)}.`);
console.log(`Each further request in the build re-reads the difference: +${fmt(s3.wb.t.context - s3.b.t.context)} tokens, ${money(usd(s3.wb.t.context - s3.b.t.context, PRICE.read))} cached.\n`);

h("7. Where the board's extra cost goes (whiteboard − B)");
// Fixed overhead: the whiteboard priced with and without it. Extra output: priced at the output
// rate. The rest: snapshots, wrappers and tool results, and re-reading the bigger history.
const parts = (wb, wbNoFixed, b) => {
  const fixed = wb.t.cost - wbNoFixed.t.cost;
  const out = usd(wb.t.output - b.t.output, PRICE.output);
  return [money(fixed), money(out), money(wb.t.cost - b.t.cost - fixed - out), `**${money(wb.t.cost - b.t.cost)}**`];
};
table(
  ["Scenario", "Fixed overhead", "Extra output", "Messages, results, bigger history", "Total"],
  [
    ["1. First plan", ...parts(s1.wb, simulate(reqs.wb.slice(0, 2)), s1.b)],
    ["2. Plan + 3 corrections", ...parts(s2.wb, simulate(reqs.wb), s2.b)],
    ["2, cache cold at each correction", ...parts(s2cold.wb, simulate(cold(reqs.wb)), s2cold.b)],
    ["3. Full run", ...parts(s3.wb, simulate([...reqs.wb, ...buildWb]), s3.b)],
    ["3, cache cold at each user turn", ...parts(s3cold.wb, simulate(cold([...reqs.wb, ...buildWb])), s3cold.b)],
  ],
);
console.log(`The build alone: ${buildCalls} update_board calls, ${buildOps} ops, ${fmt(buildOut)} output tokens (${money(usd(buildOut, PRICE.output))}), ${fmt(buildResults)} tokens of tool results.`);
console.log(`Cold rows: the user takes more than 5 minutes before a turn, so that request writes the whole context again at ${rate(PRICE.write)} instead of reading it at ${rate(PRICE.read)}.`);
const extra = s3.wb.t.requests - s3.b.t.requests;
console.log(`The whiteboard makes ${extra} more requests than B (one per update_board call). Each also re-reads Claude Code's own prompt, tools and the repo reads (not counted here): ${rate(PRICE.read)} per million tokens of that context per request, so ${money(usd(10000, PRICE.read) * extra)} per 10k tokens of it for the run. None if the agent sends update_board alongside its other tool calls.\n`);

h("8. Break-even: cost after k corrections");
function withK(k) {
  const pick = (i) => corrections[i % corrections.length];
  const cs = Array.from({ length: k }, (_, i) => pick(i));
  return {
    aFull: simulate([reqs.aFull[0], ...cs.map((c) => ({ label: c.label, input: c.typed, output: c.aFull }))], { cached: false }).t,
    aDelta: simulate([reqs.aDelta[0], ...cs.map((c) => ({ label: c.label, input: c.typed, output: c.aDelta }))], { cached: false }).t,
    b: simulate([reqs.b[0], ...cs.map((c) => ({ label: c.label, input: c.typed, output: c.bEdit }))]).t,
    wb: simulate([...reqs.wb.slice(0, 2), ...cs.flatMap((c) => [{ label: c.label, input: c.message, output: c.wbOut }, { label: "result", input: c.wbResult, output: 0 }])], { fixed: FIXED }).t,
  };
}
table(
  ["Corrections", "A chat (rewrites)", "A chat (changes only)", "B agent, no board", "Whiteboard"],
  [0, 1, 3, 5, 10, 20].map((k) => {
    const r = withK(k);
    return [k, money(r.aFull.cost), money(r.aDelta.cost), money(r.b.cost), money(r.wb.cost)];
  }),
);
const firstBelow = (key) => {
  for (let k = 0; k <= 100; k++) {
    const r = withK(k);
    if (r.wb.cost <= r[key].cost) return k;
  }
  return null;
};
const k0 = withK(0), k3 = withK(3);
const each = (key) => money((k3[key].cost - k0[key].cost) / 3);
console.log(`Each correction adds, on average over the three: A rewriting ${each("aFull")}, A with changes only ${each("aDelta")}, B ${each("b")}, whiteboard ${each("wb")}.`);
const be = { aFull: firstBelow("aFull"), aDelta: firstBelow("aDelta"), b: firstBelow("b") };
const say = (k) => (k == null ? "never (up to 100)" : `from ${k} correction${k === 1 ? "" : "s"}`);
console.log(`The whiteboard costs less than: A rewriting the plan ${say(be.aFull)}; A answering with changes only ${say(be.aDelta)}; B ${say(be.b)}.`);
console.log("Corrections past the third repeat the three measured ones in turn.\n");

// 9. Real runs: three recorded runs of the whiteboard with Claude (fixtures/recordings). Their
// cost and turns are the Agent SDK's own figures; the board's part is counted from the ops the
// agent actually sent.
h("9. Cross-check: three real recorded runs (fixtures/recordings)");
const rows = [];
const dir = path.join(ROOT, "fixtures/recordings");
for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const ev = readFileSync(path.join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const meta = ev.find((e) => e.type === "meta");
  const done = ev.find((e) => e.type === "done");
  if (!done?.cost) continue;
  const b = new BoardModel();
  const mirror = serverMirror();
  const calls = [];
  let cur = null, userAdded = 0, gated = false;
  for (const [i, e] of ev.entries()) {
    if (e.type === "op") {
      b.apply(e.op);
      const next = ev[i + 1];
      // The server's own ops: proofs from test output, and "building" when a file is edited.
      const server = e.op.fromTests || (e.op.op === "status" && e.op.v === "building" && next?.type === "activity" && next.node === e.op.id);
      if (server) continue;
      const op = Object.fromEntries(Object.entries(e.op).filter(([k]) => KEYS.has(k)));
      if (!cur) calls.push((cur = []));
      cur.push(op);
      mirror.emitOps([structuredClone(op)]);
      continue;
    }
    if (e.type === "decision" || e.type === "meta-update") continue; // the recorder's lines between one call's ops
    cur = null;
    if (e.type === "gate") gated = true;
    if (e.type !== "user" || e.kind === "permission") continue;
    // What the agent got, less the user's own words (B gets those too).
    const message = gateMessage(mirror, { type: e.kind, text: e.text, edits: e.edits }, { gated });
    if (message) userAdded += (await count(message)) - (await count(e.text ?? ""));
    if (e.kind === "approve") b.acceptDecisions();
    gated = false;
  }
  dump(`real-${f.replace(".jsonl", "")}-calls.json`, JSON.stringify(calls, null, 1));
  let out = 0, results = 0;
  for (const ops of calls) {
    out += await count(callJson(ops));
    results += await count(resultText(ops));
  }
  const turns = done.turns;
  const history = out + results + userAdded + planInstr; // the board's share of the conversation
  const low = usd(out, PRICE.output) + usd(FIXED + history, PRICE.write) + usd(FIXED * (turns - 1), PRICE.read);
  const high = low + usd(history * (turns - 1), PRICE.read);
  rows.push({ f, meta, done, calls: calls.length, ops: calls.flat().length, out, results, userAdded, low, high });
}
table(
  ["Run", "Task", "Model, effort", "Turns", "Measured cost", "Board calls (ops)", "Board output", "Board input added", "Board cost (est.)", "Share"],
  rows.map((r) => [
    r.f.replace(".jsonl", ""), r.meta.brief, `${r.meta.model}, ${r.meta.effort}`, r.done.turns, money(r.done.cost), `${r.calls} (${r.ops})`, fmt(r.out),
    `${fmt(FIXED)}/turn + ${fmt(r.results + r.userAdded + planInstr)}`,
    `${money(r.low)}–${money(r.high)}`, `${Math.round((100 * r.low) / r.done.cost)}–${Math.round((100 * r.high) / r.done.cost)}%`,
  ]),
);
console.log("Measured cost and turns: the Agent SDK's result (total_cost_usd, num_turns). These runs were recorded before read_board, so their measured cost includes the board snapshot in every message. Board input added here is counted as the new messages would be: fixed overhead per turn, plus tool results, the edits and wrappers sent at the gate, and the plan-mode instructions. No reads.");
console.log("Low: every board token written to the cache once, the fixed overhead read on every turn. High: also every board token re-read on every later turn. Neither counts the re-reads of Claude Code's own context on the extra requests the calls cause.\n");

h("10. Sizes, for reference");
table(
  ["Text", "Tokens"],
  [
    ["Task brief", fmt(brief)],
    ["Message at the plan gate (first correction, edit only)", fmt(corrections[0].message)],
    ["read_board result after the third correction (the whole board)", fmt(corrections.at(-1).readResult)],
    ["Tool result (\"Board updated (N changes).\")", fmt(planResult)],
    ["Prose plan after the three corrections", fmt(await count(md.at(-1)))],
  ],
);
if (tok.short === "chars/4") console.log("These are rough chars/4 estimates. For o200k_base counts: npm i --no-save js-tiktoken. For exact Claude counts: set ANTHROPIC_API_KEY.");
else if (!tok.exact) console.log(`These are ${tok.short} counts. Set ANTHROPIC_API_KEY for exact Claude counts.`);
