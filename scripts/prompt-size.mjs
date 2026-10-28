#!/usr/bin/env node
// The whole first request a Claude run sends, standard vs shorthand (AGENT_SHORTHAND): Claude
// Code's own prompt and tools, the board's instructions and tools, measured with a real one-turn
// call made with the run's own options (ClaudeRun.queryOptions), in plan mode, as a run starts.
// The model only says one word, so each call costs about a cent with Haiku.
//
//   node scripts/prompt-size.mjs [repo]      # default repo: sandbox/linkshort
//   PROMPT_MODEL=claude-opus-5-5 node scripts/prompt-size.mjs
//
// Needs a model configured the way a live run does (README, Models). Claude Code's own prompt
// depends on its version and on where it runs (a cloud container ships extra tools), so the
// standard number varies between machines; the shorthand one names its tools, so it varies less.
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRun } from "../server/runs.js";

const repo = path.resolve(process.argv[2] || "sandbox/linkshort");
const model = process.env.PROMPT_MODEL || "claude-haiku-5-5";

async function measure(shorthand) {
  const run = Object.assign(Object.create(ClaudeRun.prototype), { repo, shorthand, abort: new AbortController(), emitOps: () => [], readBoard: async () => null });
  const options = { ...run.queryOptions({ model, effort: undefined }), maxTurns: 1, includePartialMessages: false, canUseTool: async () => ({ behavior: "deny", message: "Measuring only." }) };
  delete options.effort;
  let tools = [], usage = null, cost = 0;
  for await (const m of query({ prompt: "Reply with the one word: ready.", options })) {
    if (m.type === "system" && m.subtype === "init") tools = m.tools;
    if (m.type === "assistant" && !usage) usage = m.message.usage;
    if (m.type === "result") cost = m.total_cost_usd;
  }
  const prompt = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  return { shorthand, prompt, cacheWrite: usage.cache_creation_input_tokens, cacheRead: usage.cache_read_input_tokens, tools: tools.length, builtIn: tools.filter((t) => !t.startsWith("mcp__")), cost };
}

const standard = await measure(false);
const short = await measure(true);
for (const r of [standard, short]) console.log(`${r.shorthand ? "shorthand" : "standard "}: ${r.prompt.toLocaleString("en-US")} tokens in the first request (cache write ${r.cacheWrite}, read ${r.cacheRead}); ${r.tools} tools: ${r.builtIn.join(", ")} + board; $${r.cost.toFixed(4)}`);
console.log(`Shorthand's first request is ${(standard.prompt - short.prompt).toLocaleString("en-US")} tokens smaller (${Math.round((short.prompt / standard.prompt - 1) * 100)}%), measured with ${model}.`);
