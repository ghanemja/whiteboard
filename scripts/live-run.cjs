// Drives one live agent run through the app's own UI in headless Chromium: start a task, wait for
// the plan gate, send one correction in chat, approve, wait for the run's "done". Command prompts
// are answered by a narrow allowlist: a test command (npm test, npm run test, node --test), alone or
// piped into grep/head/tail, is allowed; anything else is denied. Writes a result file.
//
//   npm run dev     # with a model configured (live mode), in another terminal
//   PORT=5199 SERVER_DIR=. BRIEF="Support custom aliases like /launch" \
//   CORRECTION="Aliases are 3 to 20 letters, digits or dashes, and a taken alias is refused." \
//   OUT=result.json NODE_PATH=$(npm root -g) node scripts/live-run.cjs
//
// SERVER_DIR is the checkout the server runs in (its recordings/ holds the run). Give the sandbox
// the same allowlist up front in sandbox/linkshort/.claude/settings.json, so allowed commands don't
// even prompt: {"permissions":{"allow":["Bash(npm test:*)","Bash(npm run test:*)","Bash(node --test:*)"]}}.
// scripts/live-usage.mjs then reads the run's token usage from the agent's own transcript.
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const port = Number(process.env.PORT || 5199);
const recDir = path.join(path.resolve(process.env.SERVER_DIR || "."), "recordings");
const { BRIEF: brief, CORRECTION: correction } = process.env;
const out = path.resolve(process.env.OUT || "live-run.json");
const label = process.env.LABEL || "run";
if (!brief || !correction) throw new Error("set BRIEF and CORRECTION");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const events = (file) =>
  (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n") : []).flatMap((l) => {
    try {
      return l ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });
// A test command alone, or piped into a read-only filter.
const TEST = /^(npm (test|run test)|node --test)\b/;
const FILTER = /^(grep|head|tail)\b/;
const allowed = (cmd) => {
  const parts = String(cmd).replace(/2>&1/g, "").split("|").map((s) => s.trim());
  return TEST.test(parts[0]) && parts.slice(1).every((p) => FILTER.test(p)) && !/&&|;|`|\$\(/.test(cmd);
};

(async () => {
  const started = Date.now();
  const at = () => `+${((Date.now() - started) / 60000).toFixed(1)} min`;
  const before = new Set(fs.existsSync(recDir) ? fs.readdirSync(recDir) : []);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.log("[page error]", e.message));
  await page.goto(`http://localhost:${port}/`, { waitUntil: "load" });
  await page.waitForTimeout(3000);
  const own = page.getByText("Start my own task");
  if (await own.count()) await own.first().click();
  await page.locator("#ask").fill(brief);
  await page.getByRole("button", { name: "Start", exact: true }).click();

  let file = null;
  for (let i = 0; i < 60 && !file; i++) {
    await sleep(1000);
    const fresh = (fs.existsSync(recDir) ? fs.readdirSync(recDir) : []).filter((f) => f.endsWith(".jsonl") && !before.has(f));
    if (fresh.length) file = path.join(recDir, fresh[0]);
  }
  if (!file) throw new Error("no recording appeared");
  const runId = path.basename(file, ".jsonl");
  console.log(`[${label}] run ${runId}`);

  // Each prompt is answered once. (The server records an answer without its requestId, so the
  // recording alone can't tell which prompts are answered.)
  const answered = new Set();
  const decisions = [];
  const waitFor = async (pred, what, maxMin) => {
    for (let t = 0; t < maxMin * 60; t++) {
      const ev = events(file);
      for (const p of ev.filter((e) => e.type === "permission" && e.requestId && !answered.has(e.requestId))) {
        answered.add(p.requestId);
        const decision = allowed(p.detail) ? "allow" : "deny";
        decisions.push({ command: String(p.detail).split("\n")[0].slice(0, 80), decision });
        console.log(`[${label}] ${decision}: ${String(p.detail).split("\n")[0].slice(0, 80)}`);
        await fetch(`http://localhost:${port}/api/runs/${runId}/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "permission", requestId: p.requestId, decision }) });
      }
      if (pred(ev)) return ev;
      if (t % 60 === 0) console.log(`[${label}] waiting for ${what} (${at()})`);
      await sleep(1000);
    }
    throw new Error(`timed out waiting for ${what}`);
  };
  const gates = (ev) => ev.filter((e) => e.type === "gate").length;

  await waitFor((ev) => gates(ev) >= 1, "the plan gate", 20);
  await page.getByPlaceholder("Ask for changes to the plan…").fill(correction);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  console.log(`[${label}] correction sent (${at()})`);
  await waitFor((ev) => gates(ev) >= 2, "the revised plan", 20);
  await page.getByRole("button", { name: /Approve (plan & build|with changes)/ }).first().click();
  console.log(`[${label}] approved (${at()})`);
  const ev = await waitFor((ev) => ev.some((e) => e.type === "done"), "done", 45);
  const done = ev.find((e) => e.type === "done");
  console.log(`[${label}] done (${at()}): ok ${done.ok}, $${done.cost}, ${done.turns} turns`);
  fs.writeFileSync(out, JSON.stringify({ label, port, runId, file, brief, correction, minutes: (Date.now() - started) / 60000, prompts: decisions, done }, null, 2));
  await browser.close();
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
