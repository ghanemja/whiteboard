import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { commitsSince, diff, head, isRepo, snapshot } from "./changes.js";
import { serveBoardMcp } from "./board-mcp.js";
import { boardTools } from "./board-tool.js";
import { boardInstructions, PLAN_INSTRUCTIONS } from "./instructions.js";
import { stateLines } from "./shorthand.js";
import { listRecordings, readChain, readDecisions, readRecording, Recorder } from "./recordings.js";
import { cloneRepo, folderError, listFolders, startFolder } from "./repos.js";
import { layerOf, LAYERS, parseColumns, parseSteps, sentenceCase, toDfdMermaid, toErMermaid, toMermaid, toSequence } from "../src/engine/views.js";

// A run = one Claude Agent SDK session working in a real repo. Its board drawing
// (update_board tool calls) and its real activity (reads, edits, commands) are
// turned into events the browser replays onto the whiteboard. The browser
// answers the agent through control messages: plan approval, permissions, chat.
//
//   POST /api/runs                 <- { repo, brief, from?, board_state?, edits? } -> { id }
//                                     (from: a saved run's id, to carry on from its board)
//   GET  /api/runs/:id/events      -> NDJSON event stream (replays from the start)
//   POST /api/runs/:id/control     <- { type: approve | revise | chat | edits | permission | stop, ... }
//   GET  /api/runs/recordings      -> saved runs, newest first
//   GET  /api/runs/recordings/:id  -> a run's recorded events (JSONL); /decisions -> its decision log (markdown)
//   GET  /api/runs/folders, POST /api/runs/clone -> picking the repo (repos.js)
//
// Every POST must be `content-type: application/json` (415 otherwise; see runsMiddleware).

// On globalThis so a dev-server reload (which re-imports this module) can't orphan running agents.
const runs = (globalThis.__agentRuns ??= new Map());
// An agent with nothing happening gets stopped after this long; a person reviewing a plan
// or a command gets longer before their agent goes away.
const IDLE_MS = 15 * 60 * 1000;
const WAITING_ON_USER_MS = 60 * 60 * 1000;
const BOARD_READ_MS = 5000; // how long read_board waits for the browser to answer

export function stopAllRuns() {
  for (const run of runs.values()) run.stop({ reason: "server" });
  runs.clear();
}

// Which agent runs the task: Claude (the Claude Agent SDK, the default) or Codex (its app-server,
// codex-run.js), from AGENT_ENGINE.
export const engine = (env = process.env) => (String(env.AGENT_ENGINE ?? "").trim().toLowerCase() === "codex" ? "codex" : "claude");

// Codex picks its own model and effort unless AGENT_MODEL / AGENT_EFFORT say otherwise.
export const settings = (env = process.env) =>
  engine(env) === "codex"
    ? { model: env.AGENT_MODEL || null, effort: env.AGENT_EFFORT || null }
    : { model: env.AGENT_MODEL || env.ANTHROPIC_MODEL || "claude-opus-5-5", effort: env.AGENT_EFFORT || "low" };

// Shorthand mode (AGENT_SHORTHAND, README "Settings"): the agent draws with one op per line instead
// of JSON, reads the board in the same lines, chats tersely, and (Claude) gets only the built-in
// tools it uses, which cuts Claude Code's own prompt by about two thirds. Off with 0, false, off or no.
export const SHORTHAND_DEFAULT = false;
export const shorthand = (env = process.env) => {
  const v = String(env.AGENT_SHORTHAND ?? "").trim().toLowerCase();
  return v ? !["0", "false", "off", "no"].includes(v) : SHORTHAND_DEFAULT;
};
// The built-in tools a shorthand Claude run gets: the ones agents used across six live runs, plus
// ExitPlanMode, which a tools list drops unless it's named (and the plan gate needs it). The board's
// own tools come from its MCP server, which this list doesn't touch.
export const SHORTHAND_TOOLS = ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "ExitPlanMode"];

// The agent's environment, from the three settings people set (README: "Models"):
//   AGENT_URL    where the model is: any Anthropic-format endpoint (Ollama, LiteLLM, OpenRouter…);
//                left out for Anthropic's own API
//   AGENT_KEY    its key; left out for a local server
//   AGENT_MODEL  the model's name there
// written into the variables the Claude Agent SDK reads. Without them, Claude Code's own variables
// (ANTHROPIC_*, CLAUDE_CODE_USE_BEDROCK…) work as they do for Claude Code.
export function agentEnv(env = process.env) {
  const out = { ...env };
  const [url, key, model] = ["AGENT_URL", "AGENT_KEY", "AGENT_MODEL"].map((k) => env[k]?.trim() || "");
  if (url && !/(^|\.)anthropic\.com$/.test(hostOf(url))) {
    out.ANTHROPIC_BASE_URL = url;
    out.ANTHROPIC_AUTH_TOKEN = key || "none"; // a local server ignores it, but the SDK wants one
    out.ANTHROPIC_API_KEY = ""; // set, but empty: otherwise the SDK may sign in to Anthropic instead
    // Background work goes to the same model: an endpoint like this knows no Claude model names.
    if (model) for (const tier of ["FABLE", "OPUS", "SONNET", "HAIKU"]) out[`ANTHROPIC_DEFAULT_${tier}_MODEL`] ||= model;
  } else if (key) out.ANTHROPIC_API_KEY = key;
  if (model) out.ANTHROPIC_MODEL = model;
  return out;
}

// Where the agent's model runs, for the top bar. null: nothing is configured, so the browser
// plays the scripted demo.
export function provider(raw = process.env) {
  // Codex signs in by itself (`codex login`, or OPENAI_API_KEY): if it isn't, the run says so.
  if (engine(raw) === "codex") return "Codex";
  const env = agentEnv(raw);
  const on = (v) => ["1", "true"].includes(String(env[v] ?? "").toLowerCase());
  if (on("CLAUDE_CODE_USE_BEDROCK") || on("CLAUDE_CODE_USE_MANTLE")) return "Amazon Bedrock";
  if (on("CLAUDE_CODE_USE_VERTEX")) return "Google Vertex AI";
  if (on("CLAUDE_CODE_USE_FOUNDRY")) return "Microsoft Foundry";
  if (env.ANTHROPIC_BASE_URL && !/(^|\.)anthropic\.com$/.test(hostOf(env.ANTHROPIC_BASE_URL)) && (env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY))
    return hostOf(env.ANTHROPIC_BASE_URL).endsWith(":11434") ? `Ollama (${hostOf(env.ANTHROPIC_BASE_URL)})` : hostOf(env.ANTHROPIC_BASE_URL);
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return "Anthropic API";
  return null;
}
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

// Per-test results in a test runner's output: TAP (node --test), node's spec reporter,
// Jest/Vitest, pytest -v and go test -v. name -> passed?
function testResults(text) {
  const out = new Map();
  for (const line of text.split("\n")) {
    let m;
    if ((m = line.match(/^\s*(not )?ok \d+ - (.+?)(?:\s+#.*)?$/))) out.set(m[2], !m[1]);
    else if ((m = line.match(/^\s*([✔✓√✖✕×])\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/))) out.set(m[2], "✔✓√".includes(m[1]));
    else if ((m = line.match(/^(\S+::\S+)\s+(PASSED|FAILED|ERROR)\b/))) out.set(m[1].split("::").pop(), m[2] === "PASSED");
    else if ((m = line.match(/^\s*--- (PASS|FAIL): (\S+)/))) out.set(m[2], m[1] === "PASS");
  }
  return out;
}

// The test a proof (or a check) names: one name contains the other; the most specific match wins.
const norm = (s) => String(s ?? "").toLowerCase().replace(/[`"'“”‘’]/g, "").trim();
function findTest(results, text, minLength = 4) {
  const t = norm(text);
  let best = null;
  if (t.length < 4) return null;
  for (const [name, ok] of results) {
    const n = norm(name);
    if (n.length >= minLength && (t.includes(n) || n.includes(t)) && n.length > (best?.n.length ?? 0)) best = { name, ok, n };
  }
  return best;
}

// The gist of what the user asked, for "changed because you said…".
const gist = (s) => {
  const t = String(s ?? "").replace(/^About [DQA]\d+ \(.*?\):\s*/s, "").replace(/\*\*/g, "").trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
};

// A small async queue: the SDK reads user turns from it for as long as the run lives.
function inbox() {
  const items = [];
  let wake = null;
  let closed = false;
  return {
    push(msg) {
      items.push(msg);
      wake?.();
    },
    close() {
      closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (items.length) yield items.shift();
        if (closed) return;
        await new Promise((r) => (wake = r));
        wake = null;
      }
    },
  };
}

const userTurn = (text) => ({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });

const rel = (repo, p) => (p ? path.relative(repo, path.resolve(repo, p)) || "." : "");

// A board edit from the browser, as one line of the decision log.
function describeEdit(d) {
  switch (d.kind) {
    case "rename": return `Renamed **${d.from}** → **${d.to}**`;
    case "remove": return `Removed **${d.name}**`;
    case "add": return `Added **${d.name}**`;
    case "link": return `Connected **${d.fromName}** → **${d.toName}**`;
    case "unlink": return `Disconnected **${d.fromName}** → **${d.toName}**`;
    case "note": return `Note: “${d.text}”`;
    case "reject": return `Rejected **${d.label}** (${d.title}${d.chose ? `: ${d.chose}` : ""})`;
    case "choose": return `Chose **${d.to}** for **${d.label}** (${d.title}; was ${d.from})`;
    case "sticker": {
      const on = d.decision ? `**${d.label}** (${d.title})` : `**${d.name}**`;
      return { why: `Asked why: ${on}`, drop: `Not needed: ${on}`, keep: `Keep this: ${on}` }[d.sticker] ?? `Sticker ${d.sticker} on ${on}`;
    }
    default: return JSON.stringify(d);
  }
}
// The decision log groups your edits by what they change (the browser classifies them).
const AREA_ICON = { architecture: "▢", decision: "◇", scope: "✐" };
const logEdit = (d) => `${AREA_ICON[d.area] ? `${AREA_ICON[d.area]} ` : ""}${describeEdit(d)}`;

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");

const COMPONENT_STATUS = new Set(["planned", "building", "built", "verified", "failed", "live"]);
const DECISION_STATES = new Set(["proposed", "accepted", "changed", "rejected"]);

export class Run {
  constructor({ repo, brief, origin = "http://127.0.0.1:5199", from = null, boardState = null, edits = [] }) {
    this.id = randomUUID().slice(0, 8);
    // The board over MCP's HTTP transport, for agents that can't take Claude's in-process tool
    // (board-mcp.js). The token stays out of events and recordings.
    this.boardMcp = { url: `${origin}/api/runs/${this.id}/mcp`, token: randomBytes(24).toString("base64url") };
    this.repo = repo;
    this.started = Date.now();
    this.events = [];
    this.listeners = new Set();
    this.pending = new Map(); // requestId -> resolve(PermissionResult)
    this.boardReads = new Map(); // read id -> resolve(board state), until the browser answers or the wait runs out
    this.allowCommands = false; // "Allow all" for this run
    // A mirror of the board, from ops: what the decision log describes, and how edits find their component.
    this.nodes = new Map(); // component id -> { name, kind, paths, libs, api, status }
    this.edges = new Map(); // "from>to" -> { via, api }
    this.tasks = new Map(); // task id -> { phase, text, status }
    this.decisions = new Map(); // decision id -> { n, title, chose, over, why, affects, evidence, builds_on, state, verify, proof, proof_by, cause, cause_text }
    this.questions = new Map(); // question/assumption id -> { kind, n, text, options, about, state, answer }
    this.flows = new Map(); // flow id -> { id, name, steps: [{ from, to, what }] }
    this.tables = new Map(); // table id -> { id, name, of, columns: [{ name, type, pk, unique, fk }] }
    this.goal = null;
    this.tests = new Map(); // test name -> passed?, from the latest test output that printed it
    this.steer = null; // what the user asked this turn, so decisions it changes can say so
    this.turnText = ""; // what the agent has said since the last user turn
    this.git = null; // { base, head, tree, sent, files }: the repo as the run found it, and what it's changed since (changes.js)
    const { model, effort } = settings();
    this.shorthand = shorthand();
    this.recorder = new Recorder({ id: this.id, brief, repo, model, effort, ...(this.shorthand ? { shorthand: true } : {}), startedAt: new Date(this.started).toISOString(), project: null, ...(from ? { from: from.id } : {}) });
    this.brief = brief;
    // A run that carries on from a saved board (a living document): that board is its starting
    // point, and that run's decision log is the handover the agent reads first.
    this.from = from;
    this.boardState = boardState;
    this.startEdits = edits;
    if (from) {
      this.seed(from.chain.flat());
      if (this.project || this.goal) this.recorder.update({ ...(this.project ? { project: this.project } : {}), ...(this.goal ? { goal: this.goal } : {}) });
      this.recorder.setPlan(this.planMarkdown());
    }
    this.recorder.decide({ t: 0, who: "you", title: from ? `Carried on from run ${from.id}` : "Started a task", quote: brief });
  }

  // The saved runs' ops (and approvals), oldest first, replayed into the mirror without being
  // sent or recorded again: the browser's board already shows them.
  seed(events) {
    const recorder = this.recorder;
    this.emit = () => {};
    this.recorder = { decide() {}, update() {}, setPlan() {}, write() {} };
    try {
      for (const e of events) {
        if (e.type === "op" && e.op) this.emitOps([e.op]);
        else if (e.type === "user" && e.kind === "approve") for (const d of this.decisions.values()) if (d.state === "proposed") d.state = "accepted";
      }
    } finally {
      delete this.emit;
      this.recorder = recorder;
    }
    this.phase = null; // the new session plans first: its new decisions start as proposed
  }

  // What starts the session: the task; carrying on, the handover too (the last run's decision log
  // and the board as it is now), and the board edits it started with, if that's how it started.
  get firstTurn() {
    if (!this.from) return this.brief;
    const edits = this.startEdits.length ? `I changed the board:\n<board_edits>${JSON.stringify(this.startEdits)}</board_edits>\n\nRespond to these changes and update the code and the board to match.` : this.brief;
    const state = !this.boardState ? "" : this.shorthand ? `\n\n<board_state>\n${stateLines(this.boardState)}\n</board_state>` : `\n\n<board_state>${JSON.stringify(this.boardState)}</board_state>`;
    return `${edits}\n\n<handover from="${this.from.id}">\n${this.from.log ?? ""}\n</handover>${state}`;
  }

  get now() {
    return Date.now() - this.started;
  }

  emit(event) {
    const e = { ...event, t: this.now };
    this.events.push(e);
    for (const fn of this.listeners) fn(e);
    this.recorder.write(e);
    this.touch();
  }

  // The board as the browser has it now. The browser is asked over the event stream, so its answer
  // comes after every op already sent to it. Null when nobody answers (no browser is following).
  // Live only: the request isn't kept in events or the recording.
  readBoard() {
    const id = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      const finish = (state) => {
        clearTimeout(timer);
        this.boardReads.delete(id);
        resolve(state);
      };
      const timer = setTimeout(() => finish(null), BOARD_READ_MS);
      this.boardReads.set(id, finish);
      for (const fn of this.listeners) fn({ type: "board-read", id });
    });
  }

  // The browser's answer to a readBoard request. False when no request is waiting for it.
  answerBoardRead(id, state) {
    const finish = this.boardReads.get(id);
    finish?.(state);
    return Boolean(finish);
  }

  // What the agent said this turn, for the decision log (the end of it, if it ran long).
  takeTurnText() {
    const text = this.turnText.trim();
    this.turnText = "";
    return text.length > 900 ? `…${text.slice(-900)}` : text;
  }

  // The plan at a glance, for a timeline entry: what's being built and the decisions behind it.
  planSummary() {
    const out = [];
    const comps = [...this.nodes.values()].map((n) => `${n.name} (${n.kind}${n.libs?.length ? `, ${n.libs[0]}` : ""})`);
    if (comps.length) out.push(`Components: ${comps.join(", ")}`);
    for (const d of this.decisions.values()) out.push(`D${d.n} ${d.title}: **${d.chose}**${d.over.length ? ` over ${d.over.join(", ")}` : ""}`);
    const steps = [...this.tasks.values()].filter((t) => t.phase === "planning" || !t.phase).map((t) => t.text).filter(Boolean);
    if (steps.length) out.push(`Steps: ${steps.join("; ")}`);
    return out;
  }

  // The whole current plan, for the top of the decision log: goal, architecture,
  // connections and the reasoning chain (ADR-style decision records).
  // The mirror in the board's model shape, for the shared views (src/engine/views.js).
  viewModel() {
    const nodes = Object.fromEntries([...this.nodes].map(([id, n]) => [id, { id, ...n }]));
    const edges = Object.fromEntries([...this.edges].map(([k, e]) => { const [from, to] = k.split(">"); return [k, { from, to, ...e }]; }));
    return { project: this.project ?? "", nodes, edges, tables: Object.fromEntries(this.tables) };
  }

  planMarkdown() {
    const name = (id) => this.nodes.get(id)?.name ?? id;
    const out = [];
    if (this.goal) out.push("### Goal", "", this.goal, "");
    if (this.nodes.size) {
      out.push("### Architecture", "", "| Component | Kind | Layer | Libraries | Interface | Files | Status |", "|---|---|---|---|---|---|---|");
      for (const [id, n] of this.nodes) {
        const layer = LAYERS.find((l) => l.key === layerOf({ id, ...n }))?.label ?? "";
        out.push(`| ${cell(n.name)} | ${cap(n.kind)} | ${layer} | ${cell(n.libs?.join(", "))} | ${cell(n.api?.map((a) => `\`${a}\``).join(", "))} | ${cell(n.paths?.map((p) => `\`${p}\``).join(", "))} | ${cap(n.status)} |`);
      }
      out.push("");
      // The diagrams, for whoever picks this up next (GitHub renders Mermaid).
      const model = this.viewModel();
      out.push("### Diagrams", "", "Container view (C4):", "", "```mermaid", toMermaid(model).trimEnd(), "```", "");
      out.push("Data flow:", "", "```mermaid", toDfdMermaid(model).trimEnd(), "```", "");
      if (this.tables.size) out.push("Data model (ER):", "", "```mermaid", toErMermaid(model).trimEnd(), "```", "");
      for (const f of this.flows.values()) out.push(`Flow: ${f.name}`, "", "```mermaid", toSequence(model, f).trimEnd(), "```", "");
    }
    if (this.edges.size) {
      out.push("### Connections", "");
      for (const [k, e] of this.edges) {
        const [a, b] = k.split(">");
        out.push(`- ${name(a)} → ${name(b)}${e.via ? ` · ${e.via}` : ""}${e.api ? ` · \`${e.api}\`` : ""}`);
      }
      out.push("");
    }
    const qs = [...this.questions.values()];
    if (qs.length) {
      out.push("### Questions and assumptions", "");
      for (const q of qs) {
        const label = `${q.kind === "question" ? "Q" : "A"}${q.n}`;
        out.push(`- **${label}** (${q.state}): ${q.text}${q.answer ? ` → **${q.answer}**` : ""}${q.about ? ` · about ${this.decisions.has(q.about) ? `D${this.decisions.get(q.about).n}` : q.about}` : ""}`);
      }
      out.push("");
    }
    if (this.git?.files.length) {
      out.push("### Changes", "", "| File | + | − | Component |", "|---|---|---|---|");
      for (const f of this.git.files) out.push(`| \`${cell(f.path)}\` | ${f.add} | ${f.del} | ${cell(name(this.ownerOf(f.path) ?? "")) || "not on the board"} |`);
      out.push("");
    }
    if (this.decisions.size) {
      out.push("### Decisions", "");
      const label = (id) => (this.decisions.has(id) ? `D${this.decisions.get(id).n}` : id);
      for (const d of this.decisions.values()) {
        out.push(`#### D${d.n} · ${d.title} (${d.state})`, "");
        out.push(`- **Chose:** ${d.chose}`);
        if (d.was?.length) out.push(`- **Before:** ${d.was.map((w) => `~~${w}~~`).join(" → ")}`);
        if (d.over.length) out.push(`- **Over:** ${d.over.join("; ")}`);
        if (d.why) out.push(`- **Why:** ${d.why}`);
        if (d.cause) out.push(`- **Changed because:** ${d.cause === "you" ? "you asked" : "a check failed"}: ${d.cause_text}`);
        if (d.verify) out.push(`- **Check:** ${d.verify}`);
        if (d.proof) out.push(`- **Proof:** ${d.proof === "pass" ? "✓ passed" : "✗ failed"}${d.proof_by ? `: ${d.proof_by}` : ""}`);
        if (d.evidence.length) out.push(`- **Evidence:** ${d.evidence.join("; ")}`);
        if (d.affects.length) out.push(`- **Affects:** ${d.affects.map(name).join(", ")}`);
        if (d.builds_on.length) out.push(`- **Builds on:** ${d.builds_on.map(label).join(", ")}`);
        out.push("");
      }
    }
    return out.join("\n").trim();
  }

  // Finished runs stay open for follow-up messages; stop the agent process once nobody's using it.
  touch() {
    clearTimeout(this.idleTimer);
    if (this.stopped) return;
    const waitingOnUser = this.pending.size > 0;
    const ms = waitingOnUser ? WAITING_ON_USER_MS : IDLE_MS;
    this.idleTimer = setTimeout(() => this.stop({ reason: "idle", minutes: ms / 60000, waitingOnUser }), ms);
  }

  // Ops the agent draws, plus the server's own (auto status from file edits, proofs from
  // test output). Returns notes for the agent about anything the server corrected.
  emitOps(ops) {
    const notes = [];
    for (const op of ops) {
      const status = COMPONENT_STATUS.has(op.v) ? op.v : COMPONENT_STATUS.has(op.status) ? op.status : "planned";
      const arr = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
      switch (op.op) {
        case "project":
          if (op.name) this.project = op.name;
          if (op.goal) this.goal = op.goal;
          if (op.name || op.goal) this.recorder.update({ ...(op.name ? { project: op.name } : {}), ...(op.goal ? { goal: op.goal } : {}) });
          break;
        case "node":
        case "adopt": {
          if (!op.id) break;
          const prev = this.nodes.get(op.id);
          this.nodes.set(op.id, {
            name: sentenceCase(op.name ?? prev?.name ?? op.id),
            kind: op.kind ?? prev?.kind ?? "service",
            layer: op.layer ?? prev?.layer ?? null,
            paths: op.paths ?? prev?.paths ?? [],
            libs: arr(op.libs) ?? prev?.libs ?? [],
            api: arr(op.api) ?? prev?.api ?? [],
            status: prev ? prev.status : status,
          });
          break;
        }
        case "decision": {
          if (!op.id) break;
          const prev = this.decisions.get(op.id);
          if (!prev && !op.title && !op.chose) break;
          const inPlanning = !this.phase || this.phase === "planning";
          const n = prev?.n ?? this.decisions.size + 1;
          const title = op.title ?? prev?.title ?? op.id;
          const changed = prev && op.chose && op.chose !== prev.chose;
          const was = changed ? [...prev.was, prev.chose] : prev?.was ?? [];
          // What made it change: something the user said this turn, or a check that failed.
          if (changed && !op.cause) {
            if (this.steer) Object.assign(op, { cause: "you", cause_text: this.steer });
            else if (prev.proof === "fail") Object.assign(op, { cause: "test", cause_text: prev.proof_by ?? "" });
          }
          if (changed)
            this.recorder.decide({ t: this.now, who: "agent", title: `Changed D${n}: ${title}`, lines: [`Was: ${prev.chose}`, `Now: **${op.chose}**`, ...(op.cause ? [`Because ${op.cause === "you" ? "you asked" : "a check failed"}: ${op.cause_text}`] : [])], quote: op.why ?? "" });
          // A proof is checked against the test output we've seen: the runner's word beats the agent's.
          if (op.proof && op.proof_by) {
            const t = findTest(this.tests, op.proof_by);
            if (t && t.ok !== (op.proof === "pass")) {
              op.proof = t.ok ? "pass" : "fail";
              notes.push(`D${n}: "${t.name}" ${t.ok ? "passed" : "failed"} in the last test run, so D${n} is marked ${t.ok ? "proven" : "failed"}.`);
            }
            if (t) op.proof_by = t.name; // the test's own name, not however the agent quoted it ("ok 11 - …")
          }
          // A new choice hasn't been checked yet.
          const proof = op.proof ?? (changed ? null : prev?.proof ?? null);
          const proof_by = op.proof_by ?? (changed && !op.proof ? null : prev?.proof_by ?? null);
          if (proof && proof !== prev?.proof)
            this.recorder.decide({
              t: this.now,
              who: op.fromTests ? "tests" : "agent",
              title: proof === "pass" ? `Proved D${n}: ${title}` : `D${n} failed its check: ${title}`,
              lines: proof_by ? [`By: ${proof_by}`] : [],
            });
          this.decisions.set(op.id, {
            was,
            n,
            title,
            chose: op.chose ?? prev?.chose ?? "",
            over: arr(op.over) ?? prev?.over ?? [],
            why: op.why ?? prev?.why ?? "",
            affects: arr(op.affects) ?? prev?.affects ?? [],
            evidence: arr(op.evidence) ?? prev?.evidence ?? [],
            builds_on: arr(op.builds_on) ?? prev?.builds_on ?? [],
            // Repeating a decision to report its proof or refine its why doesn't change it; a new choice does.
            state: DECISION_STATES.has(op.state) ? op.state : changed ? "changed" : prev?.state ?? (inPlanning ? "proposed" : "accepted"),
            verify: op.verify ?? prev?.verify ?? "",
            proof,
            proof_by,
            cause: op.cause ?? prev?.cause ?? null,
            cause_text: op.cause ? op.cause_text ?? "" : prev?.cause_text ?? "",
          });
          break;
        }
        case "question":
        case "assumption": {
          if (!op.id) break;
          const prev = this.questions.get(op.id);
          if (!prev && !op.text) break;
          const n = prev?.n ?? [...this.questions.values()].filter((q) => q.kind === op.op).length + 1;
          const q = {
            kind: op.op, n,
            text: op.text ?? prev.text,
            options: arr(op.options) ?? prev?.options ?? [],
            about: op.about ?? prev?.about ?? null,
            state: ["open", "answered", "confirmed", "corrected"].includes(op.state) ? op.state : prev?.state ?? "open",
            answer: op.answer ?? prev?.answer ?? null,
          };
          this.questions.set(op.id, q);
          const label = `${op.op === "question" ? "Q" : "A"}${n}`;
          if (!prev) this.recorder.decide({ t: this.now, who: "agent", title: op.op === "question" ? `Asked you ${label}: ${q.text}` : `Assumed ${label}: ${q.text}`, lines: q.options.length ? [`Options: ${q.options.join(" · ")}`] : [] });
          else if (q.state !== prev.state) this.recorder.decide({ t: this.now, who: "agent", title: `${label} ${q.state}: ${q.text}`, lines: q.answer ? [`Answer: ${q.answer}`] : [] });
          break;
        }
        case "phase":
          this.phase = op.name;
          break;
        case "status":
          if (this.nodes.has(op.id) && COMPONENT_STATUS.has(op.v)) this.nodes.get(op.id).status = op.v;
          break;
        case "rename":
          if (this.nodes.has(op.id) && op.name) this.nodes.get(op.id).name = sentenceCase(op.name);
          break;
        case "remove":
          this.nodes.delete(op.id);
          for (const k of [...this.edges.keys()]) if (k.split(">").includes(op.id)) this.edges.delete(k);
          break;
        case "table": {
          const key = op.id || op.name;
          if (!key) break;
          const prev = this.tables.get(key);
          this.tables.set(key, { id: key, name: op.name ?? prev?.name ?? key, of: op.of ?? prev?.of ?? null, columns: op.columns != null ? parseColumns(op.columns) : prev?.columns ?? [] });
          break;
        }
        case "flow": {
          if (!op.id) break;
          const prev = this.flows.get(op.id);
          const steps = op.steps != null ? parseSteps(op.steps) : prev?.steps ?? [];
          if (steps.length) this.flows.set(op.id, { id: op.id, name: sentenceCase(op.name ?? prev?.name ?? op.id), steps });
          break;
        }
        case "edge":
        case "adopt-edge": {
          const k = `${op.from}>${op.to}`;
          const prev = this.edges.get(k);
          const via = op.via ?? prev?.via ?? null;
          const async = op.style ? op.style === "async" : prev?.async ?? /queue|event|pub.?sub|stream|webhook|job/i.test(via ?? "");
          this.edges.set(k, { via, api: (Array.isArray(op.api) ? op.api.join(", ") : op.api) ?? prev?.api ?? null, async });
          break;
        }
        case "unlink":
          this.edges.delete(`${op.from}>${op.to}`);
          break;
        case "task": {
          if (!op.id) break;
          const t = this.tasks.get(op.id) ?? {};
          this.tasks.set(op.id, { phase: op.phase ?? t.phase, text: op.text ?? t.text, status: op.status ?? t.status });
          break;
        }
      }
      this.emit({ type: "op", op });
    }
    this.recorder.setPlan(this.planMarkdown());
    return notes;
  }

  // ---- what the run actually changed (git) ----
  // A `changes` event carries every file that differs from the start; a file's patch only when
  // it's new or different since the last event (the browser keeps the rest).
  scheduleChanges() {
    if (!this.git) return;
    clearTimeout(this.changesTimer);
    this.changesTimer = setTimeout(() => this.refreshChanges(), 600);
  }

  refreshChanges() {
    if (!this.git) return Promise.resolve();
    clearTimeout(this.changesTimer);
    this.changesRun = (this.changesRun ?? Promise.resolve()).then(async () => {
      try {
        const tree = await snapshot(this.repo);
        if (tree === this.git.tree) return;
        this.git.tree = tree;
        const files = await diff(this.repo, this.git.base, tree);
        const commits = await commitsSince(this.repo, this.git.head);
        const sent = this.git.sent;
        this.git.sent = new Map(files.map((f) => [f.path, f.patch ?? ""]));
        this.git.files = files;
        this.emit({
          type: "changes",
          commits,
          files: files.map(({ patch, ...f }) => (sent.get(f.path) === (patch ?? "") ? f : { ...f, patch: patch ?? "" })),
        });
        this.recorder.setPlan(this.planMarkdown());
      } catch (err) {
        console.warn("[runs] couldn't read the repo's changes:", err.message);
      }
    });
    return this.changesRun;
  }

  // Which component owns a repo file, by its declared paths (longest prefix wins).
  ownerOf(file) {
    let best = null, len = -1;
    for (const [id, n] of this.nodes)
      for (const p of n.paths) {
        const prefix = p.replace(/\/+$/, "");
        if ((file === prefix || file.startsWith(`${prefix}/`)) && prefix.length > len) {
          best = id;
          len = prefix.length;
        }
      }
    return best;
  }

  ask(event) {
    const requestId = randomUUID().slice(0, 8);
    return new Promise((resolve) => {
      this.pending.set(requestId, resolve);
      this.emit({ ...event, requestId });
    });
  }

  answer(requestId, result) {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    resolve(result);
    this.emit({ type: "answered", requestId });
    return true;
  }

  // The one pending plan gate, if any.
  get gateId() {
    return [...this.events].reverse().find((e) => e.type === "gate" && this.pending.has(e.requestId))?.requestId;
  }

  // The repo as the run found it, so its changes can be told from what was there before.
  async trackRepo() {
    try {
      if (await isRepo(this.repo)) {
        const base = await snapshot(this.repo);
        this.git = { base, tree: base, head: await head(this.repo), sent: new Map(), files: [] };
      }
    } catch (err) {
      console.warn("[runs] not tracking the repo's changes:", err.message);
    }
  }

  // The plan, as the agent hands it over for the gate: a timeline entry.
  recordPlan(title) {
    this.steer = null; // the user's request has been folded into this plan
    this.recorder.decide({ t: this.now, who: "agent", title, lines: this.planSummary(), quote: this.takeTurnText() });
  }

  // The agent edited a repo file: an activity row, and its component turns orange.
  fileEdited(id, file, { write = false } = {}) {
    // Claude Code keeps its plan in a file outside the repo; the board already shows the plan.
    if (!file || file.startsWith("..")) return;
    const activity = { kind: write ? "write" : "edit", label: file };
    const owner = this.ownerOf(file);
    if (owner) {
      activity.node = owner;
      // An edit means the component is being worked on, whatever it was before.
      const n = this.nodes.get(owner);
      if (n && n.status !== "building") this.emitOps([{ op: "status", id: owner, v: "building" }]);
    }
    this.emit({ type: "activity", toolUseId: id, ...activity });
  }

  // A command finished: its result row, and any test results it printed checked against the
  // decisions' proofs.
  commandOutput(id, raw, isError = false) {
    const text = String(raw ?? "").replace(/\u001b\[[0-9;]*[A-Za-z]/g, "").trim(); // terminal colors
    // Last real output line; skip Claude Code's own bracketed notes.
    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l && !/^\[.*\]$/.test(l));
    const last = lines.at(-1) ?? "";
    // Per-test results it printed: the Timeline's Tests lane counts them.
    const results = testResults(text);
    const fails = [...results.values()].filter((ok) => !ok).length;
    // `cmd | tail` exits 0 even when cmd fails, so read the output too.
    const failed =
      /\b[1-9]\d* (failed|errors?)\b|no such file or directory|command not found|Traceback \(most recent call last\)/i.test(text) ||
      /^FAILED\b/m.test(text) || // pytest's per-test failure lines
      /^\s*(#|ℹ)\s*fail [1-9]/m.test(text) || // TAP and node's spec reporter totals
      fails > 0;
    this.emit({
      type: "activity-result", toolUseId: id, ok: !isError && !failed, summary: last.slice(0, 120),
      ...(results.size ? { tests: { pass: results.size - fails, fail: fails } } : {}),
    });

    // Tests the output names keep each decision's proof current: a check that starts
    // failing crosses its diamond, a fixed one ticks it, without waiting for the agent.
    if (!results.size) return;
    for (const [name, ok] of results) this.tests.set(name, ok);
    const ops = [];
    for (const [did, d] of this.decisions) {
      if (d.state === "rejected") continue;
      // A check written as a test name counts too, if the name is specific enough.
      const t = d.proof_by ? findTest(results, d.proof_by) : findTest(results, d.verify, 12);
      const proof = t && (t.ok ? "pass" : "fail");
      if (proof && proof !== d.proof) ops.push({ op: "decision", id: did, proof, proof_by: d.proof_by ?? t.name, fromTests: true });
    }
    if (ops.length) this.emitOps(ops);
  }

  // The agent's turn ended: the timeline entry and the "done" event, after the repo's last word
  // (so the summary can be checked against it).
  finishTurn({ ok, why = null, cost = null, turns = null }) {
    const quote = this.takeTurnText();
    this.idle = true; // between turns: a shutdown now interrupts nothing
    this.steer = null;
    this.turnEnd = this.refreshChanges().then(() => {
      const statuses = [...this.nodes.values()].map((n) => `${n.name}: ${n.status}`);
      const files = this.git?.files ?? [];
      this.recorder.decide({
        t: this.now,
        who: "agent",
        title: ok ? "Finished" : `Stopped early (${why})`,
        lines: [
          ...(statuses.length ? [`Board: ${statuses.join(", ")}`] : []),
          ...(files.length ? [`Changed: ${files.map((f) => `\`${f.path}\` (+${f.add} −${f.del})`).join(", ")}`] : []),
          ...(turns != null ? [`${turns} turns${cost != null ? `, $${cost.toFixed(2)}` : ""}`] : []),
        ],
        quote,
      });
      this.emit({ type: "done", ok, cost, turns, message: ok ? null : why });
    });
    return this.turnEnd;
  }

  // ---- control from the browser ----
  control(body) {
    this.touch();
    // Only what changed since the agent's last message: the user's edits, and the assumptions they
    // confirmed in between. The rest of the board is there for the agent to read (read_board).
    const confirmed = body.confirmed?.length ? `\n\n<board_confirmed>${JSON.stringify(body.confirmed)}</board_confirmed>` : "";
    const edits = body.edits?.length ? `<board_edits>${JSON.stringify(body.edits)}</board_edits>` : "";
    const gate = this.gateId;
    this.record(body);
    if (["chat", "revise", "edits", "approve"].includes(body.type) && (body.text || body.edits?.length))
      this.steer = gist(body.text || body.edits.map(describeEdit).join("; "));

    if (body.type === "stop") {
      this.stop();
      return true;
    }
    return this.deliver(body, { confirmed, edits, gate });
  }

  // The user's side of the run: an event so a replay can show it, and a line in the decision log.
  record(body) {
    const t = this.now;
    const edits = body.edits ?? [];
    const lines = edits.map(logEdit);
    switch (body.type) {
      case "approve":
        for (const d of this.decisions.values()) if (d.state === "proposed") d.state = "accepted";
        this.recorder.setPlan(this.planMarkdown());
        this.recorder.decide({ t, who: "you", title: edits.length ? "Approved the plan with changes" : "Approved the plan", lines });
        break;
      case "revise":
        this.recorder.decide({ t, who: "you", title: "Asked for changes to the plan", lines });
        break;
      case "edits":
        this.recorder.decide({ t, who: "you", title: "Changed the board", lines });
        break;
      case "chat":
        this.recorder.decide({ t, who: "you", title: this.gateId ? "Asked for changes to the plan" : "Said", quote: body.text });
        break;
      case "permission": {
        const asked = this.events.find((e) => e.type === "permission" && e.requestId === body.requestId);
        const title = { allow: "Allowed a command", "allow-all": "Allowed every command from here on", deny: "Denied a command" }[body.decision] ?? "Answered a request";
        this.recorder.decide({ t, who: "you", title, ...(asked?.description ? { lines: [asked.description] } : {}), code: asked?.detail ?? "" });
        this.emit({ type: "user", kind: "permission", decision: body.decision, detail: asked?.detail ?? "" });
        return;
      }
      default:
        return;
    }
    if (body.type !== "permission") this.turnText = "";
    this.emit({ type: "user", kind: body.type, edits, text: body.text ?? "" });
  }

  stop(why = { reason: "user" }) {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.changesTimer);
    const title = {
      idle: `Stopped after ${why.minutes} idle minutes`,
      server: "Stopped when the dev server shut down",
      board: "Stopped: the agent couldn't reach the board",
      user: "Stopped the agent",
    }[why.reason];
    // A finished run closing on its own isn't part of the story; stopping work mid-turn is.
    if (!this.idle || why.reason === "user") this.recorder.decide({ t: this.now, who: why.reason === "user" ? "you" : "agent", title });
    this.emit({ type: "stopped", ...why });
    for (const id of [...this.pending.keys()]) this.answer(id, this.stoppedAnswer);
    this.halt();
    runs.delete(this.id);
  }

  // What a question still waiting for the user resolves to when the run stops, and how the
  // engine stops its agent.
  get stoppedAnswer() {
    return { stopped: true };
  }
  halt() {}
}

// ---- Claude: the Claude Agent SDK's query(), in plan mode until the plan is approved ----
export class ClaudeRun extends Run {
  constructor(opts) {
    super(opts);
    this.inbox = inbox(); // user turns, read by the SDK for as long as the run lives
    this.abort = new AbortController();
    this.autoApprovePlan = false; // set by "approve with changes"
    this.toolNames = new Map(); // tool_use id -> { name, input }
    this.inbox.push(userTurn(this.firstTurn));
  }

  canUseTool = async (toolName, input, { mcpServer }) => {
    // Our own board tool, served in-process (source "sdk"; absent on older CLIs).
    if (["mcp__board__update_board", "mcp__board__read_board"].includes(toolName) && (!mcpServer || mcpServer.source === "sdk")) return { behavior: "allow", updatedInput: input };

    if (toolName === "ExitPlanMode") {
      if (this.autoApprovePlan) {
        this.recordPlan("Updated the plan with your changes");
        return this.approvePlan(input);
      }
      this.recordPlan("Proposed a plan");
      const result = await this.ask({ type: "gate" });
      return result.behavior === "allow" ? this.approvePlan(input) : result;
    }

    if (toolName === "Bash" && this.allowCommands) return { behavior: "allow", updatedInput: input };
    const result = await this.ask({
      type: "permission",
      tool: toolName,
      detail: toolName === "Bash" ? input.command : JSON.stringify(input).slice(0, 200),
      description: input.description ?? "",
    });
    return result.behavior === "allow" ? { behavior: "allow", updatedInput: input } : result;
  };

  async approvePlan(input) {
    this.autoApprovePlan = false;
    await this.q.setPermissionMode("acceptEdits");
    this.emit({ type: "stage", stage: "building" });
    return { behavior: "allow", updatedInput: input };
  }

  // The Agent SDK options for this run (scripts/prompt-size.mjs measures the prompt they make).
  queryOptions({ model, effort }) {
    const board = createSdkMcpServer({
      name: "board",
      version: "1.0.0",
      alwaysLoad: true, // the agent needs it from the first turn; don't hide it behind tool search
      tools: boardTools(this.shorthand).map((t) => tool(t.name, t.description, t.input, (args) => t.run(args, { draw: (ops) => this.emitOps(ops), read: () => this.readBoard() }))),
    });
    return {
      cwd: this.repo,
      model,
      effort,
      permissionMode: "plan",
      planModeInstructions: PLAN_INSTRUCTIONS,
      systemPrompt: { type: "preset", preset: "claude_code", append: boardInstructions({ shorthand: this.shorthand }) },
      ...(this.shorthand ? { tools: SHORTHAND_TOOLS } : {}),
      // Repo settings and CLAUDE.md only; keep the user's global hooks and settings out of this agent.
      settingSources: ["project"],
      env: agentEnv(process.env),
      mcpServers: { board },
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      abortController: this.abort,
    };
  }

  async start() {
    const { model, effort } = settings();
    await this.trackRepo();
    this.q = query({ prompt: this.inbox, options: this.queryOptions({ model, effort }) });
    this.emit({ type: "stage", stage: "planning", model, repo: this.repo });

    try {
      for await (const msg of this.q) this.handle(msg);
    } catch (err) {
      if (!this.abort.signal.aborted) this.emit({ type: "error", message: err?.message || String(err) });
    } finally {
      await this.turnEnd; // a "done" still on its way goes first
      this.emit({ type: "closed" });
      this.recorder.close();
    }
  }

  handle(msg) {
    // Subagent traffic stays off the board.
    if (msg.parent_tool_use_id) return;

    // The agent's own session id: what a later run would resume from.
    if (msg.type === "system" && msg.subtype === "init" && msg.session_id) {
      this.recorder.update({ sessionId: msg.session_id });
      return;
    }

    if (msg.type === "stream_event") {
      const ev = msg.event;
      if (ev.type === "content_block_start" && ev.content_block?.type === "text") {
        this.turnText += "\n\n";
        this.emit({ type: "break" });
      }
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.turnText += ev.delta.text;
        this.emit({ type: "text", text: ev.delta.text });
      }
      return;
    }

    if (msg.type === "assistant") {
      for (const block of msg.message.content) if (block.type === "tool_use") this.onToolUse(block);
      return;
    }

    if (msg.type === "user" && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) if (block.type === "tool_result") this.onToolResult(block);
      return;
    }

    if (msg.type === "result") this.finishTurn({ ok: !msg.is_error, why: msg.subtype, cost: msg.total_cost_usd, turns: msg.num_turns });
  }

  // Real work, as compact activity rows (in the panel) and, for edits, on the board.
  onToolUse(block) {
    const { id, name, input = {} } = block;
    this.toolNames.set(id, { name, input });
    if (name.startsWith("mcp__board__") || name === "ExitPlanMode") return;

    const file = rel(this.repo, input.file_path ?? input.notebook_path ?? input.path);
    let activity;
    switch (name) {
      case "Read":
        activity = { kind: "read", label: file };
        break;
      case "Glob":
      case "Grep":
        activity = { kind: "search", label: input.pattern ?? "" };
        break;
      case "Edit":
      case "MultiEdit":
      case "Write":
      case "NotebookEdit":
        return this.fileEdited(id, file, { write: name === "Write" });
      case "Bash":
        activity = { kind: "command", label: input.command ?? "" };
        break;
      case "TodoWrite":
      case "ToolSearch":
        return;
      default:
        activity = { kind: "tool", label: name };
    }
    this.emit({ type: "activity", toolUseId: id, ...activity });
  }

  onToolResult(block) {
    const used = this.toolNames.get(block.tool_use_id);
    // Edits and commands can change the repo: look again once they settle.
    if (["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"].includes(used?.name)) this.scheduleChanges();
    if (!used || used.name !== "Bash") return;
    const raw = Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").join("\n") : String(block.content ?? "");
    this.commandOutput(block.tool_use_id, raw, block.is_error);
  }

  // How the user's side reaches Claude: the plan gate is its ExitPlanMode call (allowed, or
  // denied with what to change); anything else is a user turn on its inbox.
  deliver(body, { confirmed, edits, gate }) {
    switch (body.type) {
      case "approve":
        if (!gate) return false;
        if (!edits) return this.answer(gate, { behavior: "allow" });
        this.autoApprovePlan = true;
        return this.answer(gate, {
          behavior: "deny",
          message: `The user approved the plan with these changes to the board:\n${edits}${confirmed}\n\nApply them to the plan and the board with update_board, then call ExitPlanMode again; it will be approved.`,
        });
      case "revise":
      case "chat": {
        const said = body.type === "chat" ? `The user says: ${body.text}` : `The user changed the board:\n${edits}`;
        if (gate)
          return this.answer(gate, {
            behavior: "deny",
            message: `Not approved yet. ${said}${confirmed}\n\nRevise the plan and the board with update_board to match, then call ExitPlanMode again.`,
          });
        this.inbox.push(userTurn(`${said}${confirmed}`));
        this.idle = false;
        this.emit({ type: "turn" });
        return true;
      }
      case "edits":
        this.inbox.push(userTurn(`I changed the board:\n${edits}${confirmed}\n\nRespond to these changes and update the code and the board to match.`));
        this.idle = false;
        this.emit({ type: "turn" });
        return true;
      case "permission": {
        if (body.decision === "allow-all") this.allowCommands = true;
        const allow = body.decision === "allow" || body.decision === "allow-all";
        return this.answer(body.requestId, allow ? { behavior: "allow" } : { behavior: "deny", message: "The user declined. Find another way or ask them in your reply." });
      }
      default:
        return false;
    }
  }

  get stoppedAnswer() {
    return { behavior: "deny", message: "Run stopped.", interrupt: true };
  }
  halt() {
    this.inbox.close();
    this.abort.abort();
  }
}

// ---- HTTP ----
function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// Where an agent on this machine reaches this server (and so the run's board): the address this
// request came in on. Not always 127.0.0.1: on macOS, Vite's "localhost" listens on ::1 alone.
export function localOrigin({ localAddress, localPort }) {
  const host = localAddress?.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "") || "127.0.0.1";
  return `http://${host.includes(":") ? `[${host}]` : host}:${localPort}`;
}

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
};

export function runsMiddleware({ defaultRepo, sandbox = path.resolve("sandbox") }) {
  return async function handleRuns(req, res, next) {
    // Every POST here starts, steers or draws on a run, and all of them send JSON. A page on
    // another site can't send JSON without a CORS preflight, but its "simple" requests (text/plain,
    // a form) skip the preflight and reach this handler: Vite's CORS settings only shape the response.
    if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "Send JSON." });

    const url = new URL(req.url, "http://local");
    const parts = url.pathname.split("/").filter(Boolean); // [] | [id, "events"] | [id, "control"] | [id, "board"] | [id, "mcp"]

    if (req.method === "GET" && parts[0] === "status") {
      return json(res, 200, {
        live: Boolean(provider()),
        provider: provider(),
        ...settings(),
        shorthand: shorthand(),
        defaultRepo,
      });
    }

    if (req.method === "POST" && parts.length === 0) {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "Request body must be JSON." });
      }
      const repo = path.resolve(String(body.repo || defaultRepo || ""));
      if (!repo || !existsSync(repo)) return json(res, 400, { error: `There's no folder at ${repo}. Pick one with Browse, or run npm run sandbox to make the sample repo.` });
      if (!statSync(repo).isDirectory()) return json(res, 400, { error: `Not a folder: ${repo}` });
      if (!body.brief?.trim()) return json(res, 400, { error: "Describe the task first." });
      // Carrying on from a saved run: its board (and the runs it carried on from) and its decision log.
      let from = null;
      if (body.from) {
        const chain = readChain(String(body.from));
        if (!chain.length) return json(res, 404, { error: `No saved run ${body.from} to carry on from.` });
        from = { id: String(body.from), chain, log: readDecisions(String(body.from)) };
      }
      const Engine = engine() === "codex" ? (await import("./codex-run.js")).CodexRun : ClaudeRun;
      const edits = Array.isArray(body.edits) ? body.edits : [];
      const run = new Engine({ repo, brief: body.brief.trim(), origin: localOrigin(req.socket), from, boardState: body.board_state ?? null, edits });
      runs.set(run.id, run);
      run.start();
      return json(res, 200, { id: run.id });
    }

    if (req.method === "GET" && parts[0] === "recordings") {
      if (!parts[1]) return json(res, 200, listRecordings());
      const body = parts[2] === "decisions" ? readDecisions(parts[1]) : readRecording(parts[1]);
      if (body == null) return json(res, 404, { error: "No such recording." });
      // Plain text so a browser shows the decision log instead of downloading it.
      res.setHeader("content-type", parts[2] === "decisions" ? "text/plain; charset=utf-8" : "application/x-ndjson; charset=utf-8");
      return res.end(body);
    }

    // Picking the repo: a folder's subfolders for the picker, or a git URL cloned into sandbox/.
    if (req.method === "GET" && parts[0] === "folders") {
      const dir = url.searchParams.get("path") || startFolder(url.searchParams.get("near"), { defaultRepo });
      try {
        return json(res, 200, listFolders(dir));
      } catch (err) {
        const { status, error } = folderError(err, dir);
        return json(res, status, { error });
      }
    }
    if (req.method === "POST" && parts[0] === "clone") {
      // JSON only: another site's page can't send that without the browser asking first (CORS).
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return json(res, 415, { error: "Send JSON." });
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "Request body must be JSON." });
      }
      try {
        return json(res, 200, await cloneRepo(body.url, { into: sandbox }));
      } catch (err) {
        return json(res, err.status ?? 500, { error: err.message });
      }
    }

    const run = runs.get(parts[0]);
    if (!run) return parts.length ? json(res, 404, { error: "No such run." }) : next();

    // The run's board as an MCP server (POST, plus GET and DELETE per the transport).
    if (parts[1] === "mcp" && parts.length === 2) return serveBoardMcp(req, res, { token: run.boardMcp.token, draw: (ops) => run.emitOps(ops), read: () => run.readBoard(), shorthand: run.shorthand });

    // The browser's answer to a read_board request on the event stream (Run.readBoard).
    if (req.method === "POST" && parts[1] === "board") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "Request body must be JSON." });
      }
      return json(res, 200, { ok: run.answerBoardRead(body.id, body.board_state ?? null) });
    }

    if (req.method === "GET" && parts[1] === "events") {
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" });
      const send = (e) => res.write(`${JSON.stringify(e)}\n`);
      run.events.forEach(send);
      run.listeners.add(send);
      res.on("close", () => run.listeners.delete(send));
      return;
    }

    if (req.method === "POST" && parts[1] === "control") {
      let body;
      try {
        body = await readJson(req);
      } catch {
        return json(res, 400, { error: "Request body must be JSON." });
      }
      return json(res, 200, { ok: run.control(body) });
    }

    next();
  };
}
