// Any ACP agent as the agent (server/acp-run.js), end to end: a scripted agent that speaks ACP over
// stdio (fixtures/fake-acp-agent.mjs), drawing on the run's board through the real board server and
// router, over HTTP or through the stdio bridge. Plan → gate → approve → edits and a command → done.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The recordings folder is resolved when recordings.js loads: keep this test's out of the repo.
process.chdir(mkdtempSync(path.join(os.tmpdir(), "wb-acp-recordings-")));
const { AcpRun } = await import("../server/acp-run.js");
const { acpAgent, words } = await import("../server/acp-agents.js");
const { agentName, engine, provider, runsMiddleware, settings } = await import("../server/runs.js");

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const git = (repo, ...args) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);

// A repo, the router serving the run's board, and a run of the scripted agent playing `script`.
async function setup(script, { env = {}, settingsEnv: own = {} } = {}) {
  const settingsEnv = { AGENT_ENGINE: "acp", ...own };
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-acp-"));
  const repo = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  writeFileSync(path.join(tmp, "script.json"), JSON.stringify(script));
  const logFile = path.join(tmp, "log.jsonl");
  writeFileSync(logFile, "");

  const runs = (globalThis.__agentRuns ??= new Map());
  const mw = runsMiddleware({ defaultRepo: repo });
  const web = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));

  const saved = Object.fromEntries(Object.keys(settingsEnv).map((k) => [k, process.env[k]]));
  Object.assign(process.env, settingsEnv); // settings() reads the dev server's environment
  const run = new AcpRun({
    repo,
    brief: "Write the app file.",
    origin: `http://127.0.0.1:${web.address().port}`,
    agent: { name: "Fake agent", command: [process.execPath, FAKE], install: null },
    env: { ...process.env, FAKE_ACP_SCRIPT: path.join(tmp, "script.json"), FAKE_ACP_LOG: logFile, ...env },
  });
  runs.set(run.id, run);
  const events = [];
  run.listeners.add((e) => events.push(e));
  const waitFor = (pred, what) =>
    new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}: ${JSON.stringify(events.slice(-6))}`)), 20000);
      run.listeners.add((e) => pred(e) && (clearTimeout(t), resolve(e)));
    });
  const log = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const cleanup = async () => {
    run.stop();
    runs.delete(run.id);
    web.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    await new Promise((r) => setTimeout(r, 700));
    rmSync(tmp, { recursive: true, force: true });
  };
  return { run, repo, events, waitFor, log, cleanup };
}

const PLAN = [
  { op: "project", name: "Demo", goal: "Write the app file." },
  { op: "phase", name: "planning" },
  { op: "node", id: "app", name: "App", kind: "service", paths: ["src/"] },
  { op: "decision", id: "d1", title: "Where the file goes", chose: "src/app.txt", affects: ["app"], verify: "test 'writes the app file' passes" },
];
const BUILD = [
  { lines: "phase implementation\nstatus app v=building" },
  { edit: "src/app.txt", text: "hi\n" },
  { run: "echo 'ok 1 - writes the app file'" },
  { board: [{ op: "status", id: "app", v: "built" }] },
  { usage: 0.42 },
  { say: "Built it. 1/1 tests pass." },
];

test("an ACP agent plans in its plan mode, waits at the gate, edits once approved, asks before a command", { timeout: 30000 }, async () => {
  const { run, repo, events, waitFor, log, cleanup } = await setup(
    [
      [{ board: PLAN }, { edit: "src/sneaky.txt", text: "no\n" }, { say: "Plan ready: one part, one decision." }],
      BUILD,
    ],
    { settingsEnv: { AGENT_MODEL: "smart", AGENT_SHORTHAND: "on" } },
  );
  try {
    run.start();
    await waitFor((e) => e.type === "gate", "the plan gate");
    assert.deepEqual(events.filter((e) => e.type === "op").map((e) => e.op.op), ["project", "phase", "node", "decision"], "the plan reached the board through its MCP server");
    assert.ok(events.some((e) => e.type === "text" && /Plan ready/.test(e.text)), "its words stream into the panel");
    assert.ok(!existsSync(path.join(repo, "src/sneaky.txt")), "an edit while planning is refused");
    assert.equal(events.find((e) => e.type === "stage").model, "Smart", "AGENT_MODEL picked the agent's model");

    const sent = log();
    assert.equal(sent.find((l) => l.sessionNew).sessionNew.mcpServers[0].type, "http", "the board over HTTP, for an agent that takes it");
    assert.deepEqual(sent.find((l) => l.sessionNew).sessionNew.mcpServers[0].headers, ["Authorization"]);
    assert.deepEqual(sent.find((l) => l.boardTools).boardTools.sort(), ["read_board", "update_board"]);
    assert.deepEqual(sent.find((l) => l.setConfig).setConfig, ["model", "acme/smart"], 'AGENT_MODEL "smart" finds "acme/smart"');
    const first = sent.find((l) => l.prompt);
    assert.equal(first.mode, "plan", "planning runs in the agent's plan mode");
    assert.match(first.prompt, /# The whiteboard/, "the board's instructions open the first message");
    assert.match(first.prompt, /Write the app file\.$/, "and the task ends it");
    assert.ok(sent.some((l) => l.permission === "edit" && l.outcome === "reject_once"));

    assert.equal(run.control({ type: "approve" }), true);
    const ask = await waitFor((e) => e.type === "permission", "the command prompt");
    assert.equal(ask.tool, "Bash");
    assert.equal(ask.detail, "echo 'ok 1 - writes the app file'");
    assert.equal(ask.description, "Run it");
    assert.equal(run.control({ type: "permission", requestId: ask.requestId, decision: "allow" }), true);

    const done = await waitFor((e) => e.type === "done", "the end of the build turn");
    assert.equal(done.ok, true);
    assert.equal(done.cost, 0.42, "the cost the agent reported");
    assert.equal(events.filter((e) => e.type === "stage").at(-1).stage, "building");
    const after = log();
    assert.ok(after.some((l) => l.setMode === "acceptEdits"), "approval switches to the mode that takes edits");
    assert.match(after.filter((l) => l.prompt).at(-1).prompt, /^The plan is approved\. Build it now/);
    assert.ok(after.some((l) => l.permission === "edit" && l.outcome === "allow_once"), "an edit in the repo goes ahead without asking");
    assert.equal(readFileSync(path.join(repo, "src/app.txt"), "utf8"), "hi\n");
    assert.ok(events.some((e) => e.type === "activity" && e.kind === "write" && e.label === "src/app.txt" && e.node === "app"), "the new file lands on its component");
    assert.ok(events.some((e) => e.type === "activity" && e.kind === "command" && e.label === "echo 'ok 1 - writes the app file'"), "the command's row shows the command, not its first title");
    const result = events.find((e) => e.type === "activity-result");
    assert.deepEqual(result.tests, { pass: 1, fail: 0 }, "its test output was read");
    assert.equal(result.summary, "ok 1 - writes the app file", "without the code fence around it");
    assert.equal(run.decisions.get("d1").proof, "pass", "and proved the decision it names");
    assert.equal(run.nodes.get("app").status, "built", "shorthand lines and JSON ops both draw");
    assert.ok(!events.some((e) => e.type === "activity" && /board/.test(e.label)), "the board's own tool calls aren't activity rows");
    assert.ok(run.git.files.some((f) => f.path === "src/app.txt"), "git sees the change, for the review");
    assert.equal(run.pending.size, 0, "nothing left waiting on the user");
  } finally {
    await cleanup();
  }
});

test("an agent's request to leave plan mode is the gate: changes stop the turn and re-plan, approval builds in the same turn", { timeout: 30000 }, async () => {
  const { run, repo, events, waitFor, log, cleanup } = await setup(
    [
      [{ board: PLAN }, { exitPlan: true }, { say: "should not be said" }],
      [{ board: [{ op: "decision", id: "d1", chose: "src/main.txt" }] }, { exitPlan: true }, { edit: "src/main.txt", text: "hi\n" }, { say: "Done." }],
    ],
    { env: { FAKE_ACP_HTTP: "0" } },
  );
  try {
    run.start();
    await waitFor((e) => e.type === "gate", "the first gate");
    assert.equal(log().find((l) => l.sessionNew).sessionNew.mcpServers[0].command, process.execPath, "the board as a command, for an agent without HTTP");
    assert.deepEqual(log().find((l) => l.sessionNew).sessionNew.mcpServers[0].env, ["WHITEBOARD_BOARD_TOKEN"]);
    assert.equal(events.filter((e) => e.type === "op").length, 4, "drawn through the stdio bridge");

    assert.equal(run.control({ type: "chat", text: "Put it in src/main.txt" }), true);
    await waitFor((e) => e.type === "gate" && e.requestId !== events.find((g) => g.type === "gate").requestId, "the second gate");
    const sent = log();
    assert.ok(sent.some((l) => l.cancel), "the turn was stopped");
    assert.ok(sent.some((l) => l.permission === "switch_mode" && l.outcome === "cancelled"));
    assert.match(sent.filter((l) => l.prompt).at(-1).prompt, /^Not approved yet\. The user says: Put it in src\/main\.txt/);
    assert.ok(!events.some((e) => e.type === "text" && /should not/.test(e.text)), "the stopped turn said nothing more");
    assert.equal(run.decisions.get("d1").chose, "src/main.txt");
    assert.equal(run.decisions.get("d1").cause, "you", "changed because the user asked");

    assert.equal(run.control({ type: "approve" }), true);
    const done = await waitFor((e) => e.type === "done", "the build");
    assert.equal(done.ok, true);
    const after = log();
    assert.ok(after.some((l) => l.permission === "switch_mode" && l.outcome === "allow_always"), "approval picks leaving plan mode with edits accepted");
    assert.equal(after.filter((l) => l.prompt).length, 2, "and the agent built in the same turn");
    assert.equal(readFileSync(path.join(repo, "src/main.txt"), "utf8"), "hi\n");
  } finally {
    await cleanup();
  }
});

test("an agent whose modes are a setting (OpenCode) plans in its plan mode and builds in the one it started in", { timeout: 30000 }, async () => {
  const { run, repo, waitFor, log, cleanup } = await setup([[{ board: PLAN }, { edit: "src/sneaky.txt", text: "no\n" }, { say: "Plan ready." }], [{ edit: "src/app.txt", text: "hi\n" }, { edit: "../outside.txt", text: "no\n" }, { say: "Done." }]], { env: { FAKE_ACP_MODE_SETTING: "1" } });
  try {
    run.start();
    await waitFor((e) => e.type === "gate", "the gate");
    assert.equal(log().find((l) => l.prompt).mode, "plan", "switched to plan through the mode setting");
    assert.ok(!existsSync(path.join(repo, "src/sneaky.txt")));
    run.control({ type: "approve" });
    const ask = await waitFor((e) => e.type === "permission", "the edit outside the repo");
    assert.equal(ask.detail, "Write ../outside.txt", "an edit outside the repo asks, even once building");
    run.control({ type: "permission", requestId: ask.requestId, decision: "deny" });
    await waitFor((e) => e.type === "done", "the build");
    assert.ok(!existsSync(path.join(repo, "../outside.txt")));
    assert.equal(log().filter((l) => l.prompt).at(-1).mode, "build");
    assert.equal(readFileSync(path.join(repo, "src/app.txt"), "utf8"), "hi\n");
  } finally {
    await cleanup();
  }
});

test("an agent that wants signing in: AGENT_AUTH picks its way in, and without it the run says how", { timeout: 30000 }, async () => {
  const a = await setup([[{ say: "hello" }]], { env: { FAKE_ACP_AUTH: "1" } });
  try {
    a.run.start();
    const err = await a.waitFor((e) => e.type === "error", "the sign-in error");
    assert.match(err.message, /Fake agent wants you to sign in: .*AGENT_AUTH .*api-key \(Use an API key\)/);
  } finally {
    await a.cleanup();
  }
  const b = await setup([[{ say: "hello" }]], { env: { FAKE_ACP_AUTH: "1", AGENT_AUTH: "api-key" } });
  try {
    b.run.start();
    await b.waitFor((e) => e.type === "gate", "the gate");
    assert.ok(b.log().some((l) => l.authenticate === "api-key"));
  } finally {
    await b.cleanup();
  }
});

test("an agent that isn't installed: the run says how to install it", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-acp-"));
  const run = new AcpRun({ repo: tmp, brief: "Anything.", agent: { name: "Gemini CLI", command: [path.join(tmp, "no-gemini"), "--acp"], install: "npm i -g @google/gemini-cli" } });
  const errors = [];
  run.listeners.add((e) => e.type === "error" && errors.push(e));
  const closed = new Promise((r) => run.listeners.add((e) => e.type === "closed" && r()));
  run.start();
  await closed;
  run.stop();
  assert.equal(errors.length, 1, "once");
  assert.match(errors[0].message, /^Gemini CLI isn't installed .*: npm i -g @google\/gemini-cli\. Or set AGENT_COMMAND/);
  rmSync(tmp, { recursive: true, force: true });
});

test("AGENT_ENGINE names an ACP agent, or AGENT_COMMAND starts any", () => {
  assert.equal(engine({ AGENT_ENGINE: "gemini" }), "acp");
  assert.equal(engine({ AGENT_ENGINE: " OpenCode " }), "acp");
  assert.equal(engine({ AGENT_COMMAND: "my-agent --acp" }), "acp");
  assert.equal(engine({ AGENT_ENGINE: "claude", AGENT_COMMAND: "my-agent --acp" }), "claude", "naming Claude wins");
  assert.equal(engine({ AGENT_ENGINE: "codex" }), "codex");
  assert.deepEqual(acpAgent({ AGENT_ENGINE: "gemini" }), { name: "Gemini CLI", command: ["gemini", "--acp"], install: "npm i -g @google/gemini-cli" });
  assert.deepEqual(acpAgent({ AGENT_ENGINE: "opencode", AGENT_COMMAND: "npx -y opencode-ai acp" }).command, ["npx", "-y", "opencode-ai", "acp"]);
  assert.equal(acpAgent({ AGENT_ENGINE: "opencode", AGENT_COMMAND: "npx -y opencode-ai acp" }).name, "OpenCode");
  assert.equal(acpAgent({ AGENT_COMMAND: "/opt/bin/my-agent --acp" }).name, "my-agent");
  assert.equal(acpAgent({ AGENT_ENGINE: "Mine", AGENT_COMMAND: "my-agent" }).name, "Mine");
  assert.equal(acpAgent({ AGENT_ENGINE: "acp" }), null);
  assert.deepEqual(words(`agent --flag "two words" 'x y'`), ["agent", "--flag", "two words", "x y"]);
  assert.equal(provider({ AGENT_ENGINE: "gemini" }), "Gemini CLI", "live without an Anthropic key: the agent signs in by itself");
  assert.equal(agentName({ AGENT_ENGINE: "gemini" }), "Gemini CLI (ACP)");
  assert.equal(agentName({}), "Claude Agent SDK");
  assert.deepEqual(settings({ AGENT_ENGINE: "gemini" }), { model: null, effort: null }, "its own model unless AGENT_MODEL names one");
});
