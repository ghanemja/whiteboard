// Codex as the agent (server/codex-run.js), end to end: a real `codex app-server` against a
// scripted model (fixtures/fake-responses.js), drawing on the run's board through the real board
// server and router. Plan → gate → approve → a command it asks to run → done.
//
// Needs Codex: CODEX_BIN=/path/to/codex npm test (skipped otherwise).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { CodexRun } from "../server/codex-run.js";
import { runsMiddleware } from "../server/runs.js";
import { draw, fakeProvider, fakeResponses, shell } from "./fixtures/fake-responses.js";

const CODEX = process.env.CODEX_BIN;

test("Codex plans read-only, waits at the gate, asks before a command, and the board follows it", { skip: !CODEX && "set CODEX_BIN to run it", timeout: 90000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-codex-"));
  const repo = path.join(tmp, "repo");
  execFileSync("git", ["init", "-q", repo]);
  writeFileSync(path.join(repo, "README.md"), "# demo\n");
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

  const model = await fakeResponses([
    // Planning: draw the plan, then say it's ready (the turn ends: the gate).
    [draw("c1", [
      { op: "project", name: "Demo", goal: "Write the app file." },
      { op: "phase", name: "planning" },
      { op: "node", id: "app", name: "App", kind: "service", paths: ["src/"] },
      { op: "decision", id: "d1", title: "Where the file goes", chose: "src/app.txt", affects: ["app"], verify: "test 'writes the app file' passes" },
    ])],
    [{ text: "Plan ready: one part, one decision." }],
    // Building: a command that needs approval, then the board, then the summary.
    [shell("c2", "mkdir -p src && echo hi > src/app.txt && echo 'ok 1 - writes the app file'", "Write the app file")],
    [draw("c3", [{ op: "phase", name: "implementation" }, { op: "status", id: "app", v: "built" }])],
    [{ text: "Built it. All 1 tests pass." }],
  ]);

  const runs = (globalThis.__agentRuns ??= new Map());
  const mw = runsMiddleware({ defaultRepo: repo });
  const web = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${web.address().port}/api/runs`.replace(/\/api\/runs$/, "");

  const home = path.join(tmp, "codex-home"); // no user config, no sign-in
  mkdirSync(home);
  const run = new CodexRun({ repo, brief: "Write the app file.", origin, bin: CODEX, args: fakeProvider(model.url), env: { ...process.env, CODEX_HOME: home } });
  runs.set(run.id, run);
  const events = [];
  const waitFor = (pred, what) =>
    new Promise((resolve, reject) => {
      const hit = events.find(pred);
      if (hit) return resolve(hit);
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}: ${JSON.stringify(events.slice(-6))}`)), 45000);
      run.listeners.add((e) => pred(e) && (clearTimeout(t), resolve(e)));
    });
  run.listeners.add((e) => events.push(e));
  try {
    run.start();
    const gate = await waitFor((e) => e.type === "gate", "the plan gate");
    const ops = events.filter((e) => e.type === "op").map((e) => e.op.op);
    assert.deepEqual(ops, ["project", "phase", "node", "decision"], "the plan reached the board through its MCP server");
    assert.ok(events.some((e) => e.type === "text" && /Plan ready/.test(e.text)), "its words stream into the panel");
    assert.equal(model.requests[0].tools.some((t) => t.name === "mcp__board"), true, "Codex offered the model the board");
    assert.ok(!existsSync(path.join(repo, "src")), "nothing written while planning");
    assert.equal(events.find((e) => e.type === "stage")?.stage, "planning");

    assert.equal(run.control({ type: "approve" }), true);
    const ask = await waitFor((e) => e.type === "permission", "the command prompt");
    assert.match(ask.detail, /mkdir -p src/);
    assert.equal(ask.description, "Write the app file");
    assert.equal(run.control({ type: "permission", requestId: ask.requestId, decision: "allow" }), true);

    const done = await waitFor((e) => e.type === "done", "the end of the build turn");
    assert.equal(done.ok, true);
    assert.equal(events.filter((e) => e.type === "stage").at(-1).stage, "building");
    assert.equal(readFileSync(path.join(repo, "src/app.txt"), "utf8"), "hi\n", "the approved command ran");
    const result = events.find((e) => e.type === "activity-result");
    assert.deepEqual(result.tests, { pass: 1, fail: 0 }, "its test output was read");
    assert.equal(run.decisions.get("d1").proof, "pass", "and proved the decision it names");
    assert.equal(run.nodes.get("app").status, "built");
    assert.ok(run.git.files.some((f) => f.path === "src/app.txt"), "git sees the change, for the review");
    assert.equal(gate.requestId && run.pending.size, 0, "nothing left waiting on the user");
  } finally {
    run.stop();
    runs.delete(run.id);
    web.close();
    model.server.close();
    await new Promise((r) => setTimeout(r, 700));
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("asking for changes at the gate plans again, read-only; stop ends Codex", { skip: !CODEX && "set CODEX_BIN to run it", timeout: 90000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-codex-"));
  const home = path.join(tmp, "codex-home");
  mkdirSync(home);
  const model = await fakeResponses([
    [draw("c1", [{ op: "node", id: "db", name: "Store", kind: "data" }])],
    [{ text: "Plan: a store." }],
    [draw("c2", [{ op: "rename", id: "db", name: "SQLite store" }])],
    [{ text: "Plan, revised: SQLite." }],
  ]);
  const runs = (globalThis.__agentRuns ??= new Map());
  const mw = runsMiddleware({ defaultRepo: tmp });
  const web = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  await new Promise((r) => web.listen(0, "127.0.0.1", r));
  const run = new CodexRun({ repo: tmp, brief: "Store links.", origin: `http://127.0.0.1:${web.address().port}`, bin: CODEX, args: fakeProvider(model.url), env: { ...process.env, CODEX_HOME: home } });
  runs.set(run.id, run);
  const events = [];
  run.listeners.add((e) => events.push(e));
  const until = async (pred, what) => {
    for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(pred(), `timed out waiting for ${what}: ${JSON.stringify(events.slice(-5))}`);
  };
  try {
    run.start();
    await until(() => events.some((e) => e.type === "gate"), "the first gate");
    assert.equal(run.control({ type: "revise", edits: [{ kind: "note", area: "scope", text: "Use SQLite" }] }), true);
    await until(() => events.filter((e) => e.type === "gate").length === 2, "the gate again");
    const asked = JSON.stringify(model.requests[2].input);
    assert.match(asked, /Not approved yet/);
    assert.match(asked, /Use SQLite/);
    assert.ok(!events.some((e) => e.type === "stage" && e.stage === "building"), "still planning");
    assert.equal(run.nodes.get("db").name, "SQLite store");
    run.stop();
    await until(() => events.some((e) => e.type === "closed"), "Codex to close");
    assert.ok(events.some((e) => e.type === "stopped"));
  } finally {
    run.stop();
    runs.delete(run.id);
    web.close();
    model.server.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("without Codex installed, the run says how to get it", async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-codex-"));
  const run = new CodexRun({ repo: tmp, brief: "Anything.", bin: path.join(tmp, "no-codex-here") });
  const events = [];
  run.listeners.add((e) => events.push(e));
  try {
    await run.start();
    for (let i = 0; i < 50 && !events.some((e) => e.type === "closed"); i++) await new Promise((r) => setTimeout(r, 20));
    const errors = events.filter((e) => e.type === "error");
    assert.equal(errors.length, 1, "once");
    assert.match(errors[0].message, /npm i -g @openai\/codex/);
  } finally {
    run.stop();
    rmSync(tmp, { recursive: true, force: true });
  }
});
