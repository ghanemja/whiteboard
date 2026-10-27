import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// Every agent run is saved so its whiteboard can be replayed or reopened later,
// with a readable log of the development decisions made along the way.
//
//   recordings/<id>.jsonl          first line {type:"meta",…}, then every event with t = ms since start
//   recordings/<id>.decisions.md   who decided what, when: plans, approvals, board edits, permissions, results

export const REC_DIR = path.resolve("recordings");
const ID = /^[\w-]+$/;

const clock = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

export class Recorder {
  constructor(meta) {
    mkdirSync(REC_DIR, { recursive: true });
    this.meta = meta;
    this.decisions = [];
    this.stream = createWriteStream(path.join(REC_DIR, `${meta.id}.jsonl`), { flags: "a" });
    this.write({ type: "meta", ...meta });
    this.writeDecisions();
  }

  write(event) {
    if (!this.stream.writableEnded) this.stream.write(`${JSON.stringify(event)}\n`);
  }

  // One decision: { t, who: "you" | "agent" | "tests", title, lines?: string[], code?: string, quote?: string }
  decide(entry) {
    this.decisions.push(entry);
    this.write({ type: "decision", ...entry });
    this.writeDecisions();
  }

  writeDecisions() {
    writeFileSync(path.join(REC_DIR, `${this.meta.id}.decisions.md`), renderDecisions(this.meta, this.decisions, this.plan));
  }

  // The current plan (architecture, connections, decision records) as markdown. It's
  // derived from the events, so it goes in the decision log but not the recording.
  setPlan(markdown) {
    if (markdown === this.plan) return;
    this.plan = markdown;
    this.writeDecisions();
  }

  update(fields) {
    Object.assign(this.meta, fields);
    this.write({ type: "meta-update", ...fields });
    this.writeDecisions();
  }

  close() {
    if (!this.stream.writableEnded) this.stream.end();
  }
}

// The decision log as markdown, from a run's meta and its decision events.
export function renderDecisions(m, decisions, plan) {
  const out = [
    `# Decisions: ${m.project || m.brief}`,
    "",
    `- **Task:** ${m.brief}`,
    `- **Repo:** \`${m.repo}\``,
    `- **Started:** ${m.startedAt} · ${m.model} (effort ${m.effort})`,
    ...(m.from ? [`- **Carries on from:** \`recordings/${m.from}.decisions.md\` (its board is where this run started)`] : []),
    ...(m.sessionId ? [`- **Agent session:** \`${m.sessionId}\``] : []),
    `- **Recording:** \`recordings/${m.id}.jsonl\` (replay or reopen it in Agent Whiteboard)`,
    "",
  ];
  if (plan) out.push("## Current plan", "", plan, "");
  if (decisions.length) out.push("## Timeline", "");
  for (const d of decisions) {
    out.push(`### ${clock(d.t)} · ${{ you: "You", tests: "Tests" }[d.who] ?? "Agent"}: ${d.title}`, "");
    for (const line of d.lines ?? []) out.push(`- ${line}`);
    if (d.lines?.length) out.push("");
    if (d.code) out.push("```sh", d.code.trim(), "```", "");
    if (d.quote) out.push(...d.quote.trim().split("\n").map((l) => `> ${l}`), "");
  }
  return `${out.join("\n").trim()}\n`;
}

function parse(text) {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // a line cut off by a crash
      }
    })
    .filter(Boolean);
}

export function readRecording(id) {
  if (!ID.test(id)) return null;
  const file = path.join(REC_DIR, `${id}.jsonl`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

// A run that carries on from another starts from that run's board, which may carry on from
// another: each run's events, oldest first, back to the one that started from nothing.
export function readChain(id, depth = 50) {
  const chain = [];
  const seen = new Set();
  for (let at = id; at && !seen.has(at) && chain.length < depth; ) {
    seen.add(at);
    const text = readRecording(at);
    if (text == null) break;
    const events = parse(text);
    chain.unshift(events);
    at = events.find((e) => e.type === "meta")?.from;
  }
  return chain;
}

export function readDecisions(id) {
  if (!ID.test(id)) return null;
  const file = path.join(REC_DIR, `${id}.decisions.md`);
  return existsSync(file) ? readFileSync(file, "utf8") : null;
}

// Newest first: what the run was, how it ended, how long it took.
export function listRecordings(limit = 20) {
  if (!existsSync(REC_DIR)) return [];
  return readdirSync(REC_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const events = parse(readFileSync(path.join(REC_DIR, f), "utf8"));
      const meta = { ...events.find((e) => e.type === "meta") };
      for (const e of events) if (e.type === "meta-update") Object.assign(meta, e);
      if (!meta.id) return null;
      const done = events.filter((e) => e.type === "done").at(-1);
      const phase = events.filter((e) => e.type === "op" && e.op.op === "phase").at(-1)?.op.name ?? null;
      return {
        id: meta.id,
        brief: meta.brief,
        repo: meta.repo,
        project: meta.project ?? null,
        from: meta.from ?? null,
        startedAt: meta.startedAt,
        duration: events.at(-1)?.t ?? 0,
        phase,
        cost: done?.cost ?? null,
        decisions: events.filter((e) => e.type === "decision").length,
      };
    })
    .filter(Boolean)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, limit);
}
