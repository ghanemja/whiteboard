// A live run's token usage, from the agent's own transcript: one entry per API request, with its
// usage. Priced at Opus 5.5 with each cache write at its own lifetime's rate, it matches the
// Agent SDK's total_cost_usd for the run (printed side by side as a check).
//
//   node scripts/live-usage.mjs recordings/<run>.jsonl [label]
//
// The transcript is ~/.claude/projects/<repo path, / and . as ->/<session id>.jsonl. Runs can share
// one session id (and so one file), so only the entries inside the run's own time window count.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const [recFile, label = path.basename(recFile, ".jsonl")] = process.argv.slice(2);
const rec = fs.readFileSync(recFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const meta = rec.find((e) => e.type === "meta");
const sessionId = rec.find((e) => e.type === "meta-update" && e.sessionId)?.sessionId;
const done = rec.find((e) => e.type === "done");
const start = Date.parse(meta.startedAt);
const end = done ? start + done.t : Date.now();
const file = path.join(os.homedir(), ".claude", "projects", meta.repo.replace(/[/.]/g, "-"), `${sessionId}.jsonl`);
const inRun = (e) => {
  const t = Date.parse(e.timestamp);
  return t >= start - 2000 && t <= end + 5000 && !e.isSidechain;
};
const entries = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter(inRun);

// One request per API message id; streamed blocks repeat its usage, so the last one counts.
const reqs = new Map();
for (const e of entries) if (e.type === "assistant") reqs.set(e.message.id, { usage: e.message.usage, blocks: [...(reqs.get(e.message.id)?.blocks ?? []), ...e.message.content] });
const list = [...reqs.values()];
const sum = (f) => list.reduce((s, r) => s + (f(r.usage) ?? 0), 0);
const write1h = sum((u) => u.cache_creation?.ephemeral_1h_input_tokens);
const write = sum((u) => u.cache_creation_input_tokens);
const t = { requests: list.length, uncached: sum((u) => u.input_tokens), cacheWrite: write, cacheWrite1h: write1h, cacheRead: sum((u) => u.cache_read_input_tokens), output: sum((u) => u.output_tokens) };
const P = { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 }; // Opus 5.5, $ per million
t.cost = (t.uncached * P.input + (write - write1h) * P.write5m + write1h * P.write1h + t.cacheRead * P.read + t.output * P.output) / 1e6;
t.firstRequest = list[0] ? list[0].usage.input_tokens + list[0].usage.cache_creation_input_tokens + list[0].usage.cache_read_input_tokens : 0;

const calls = {};
for (const r of list) for (const b of r.blocks) if (b.type === "tool_use") calls[b.name] = (calls[b.name] ?? 0) + 1;
console.log(JSON.stringify({ label, sdkCost: done?.cost, sdkTurns: done?.turns, ...t, cost: +t.cost.toFixed(6), calls }, null, 2));
