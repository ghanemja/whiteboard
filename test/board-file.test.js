// The board saved in its repo (server/board-file.js): whiteboard.zip, written at each turn's end,
// read back on another machine, and a repo without one mapped first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

// The recordings folder is resolved when recordings.js loads: keep this test's out of the repo.
const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-board-file-"));
process.chdir(tmp);
const { BOARD_FILE, boardFile, readBoardFile, unzip, writeBoardFile, zip } = await import("../server/board-file.js");
const { Run, runsMiddleware } = await import("../server/runs.js");
const { mapTurn } = await import("../server/instructions.js");

test("a zip round-trips, and other zip tools read it", () => {
  const files = { "whiteboard.json": '{"a":1}\n', "runs/x.jsonl": "é ✓ ◇\n".repeat(200), "bin": Buffer.from([0, 255, 7]) };
  const bytes = zip(files);
  const back = unzip(bytes);
  assert.deepEqual(Object.keys(back), Object.keys(files));
  assert.equal(back["runs/x.jsonl"].toString("utf8"), files["runs/x.jsonl"]);
  assert.deepEqual([...back.bin], [0, 255, 7]);
  assert.ok(bytes.length < files["runs/x.jsonl"].length, "deflated");
  assert.deepEqual(zip(files), bytes, "the same board gives the same bytes");
  const f = path.join(tmp, "check.zip");
  writeFileSync(f, bytes);
  const listed = execFileSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read('runs/x.jsonl').decode()[:5])", f]).toString();
  assert.equal(listed.trim(), "é ✓ ◇");
  assert.throws(() => unzip(Buffer.from("not a zip")), /not a zip/);
});

test("AGENT_BOARD_FILE names the file, or turns it off", () => {
  assert.equal(boardFile({}), BOARD_FILE);
  assert.equal(boardFile({ AGENT_BOARD_FILE: "team-board.zip" }), "team-board.zip");
  assert.equal(boardFile({ AGENT_BOARD_FILE: "../../etc/x.zip" }), "x.zip", "always in the repo's root");
  for (const v of ["off", "0", "false", "NO"]) assert.equal(boardFile({ AGENT_BOARD_FILE: v }), null);
});

test("written and read back: the runs, oldest first, and what the board is", () => {
  const repo = mkdtempSync(path.join(tmp, "repo-"));
  writeBoardFile(repo, { runs: [{ id: "aaa", jsonl: '{"type":"meta","id":"aaa"}\n', decisions: "# A" }, { id: "bbb", jsonl: '{"type":"meta","id":"bbb","from":"aaa"}\n', decisions: "# B" }], project: "linkshort", goal: "Short links" });
  assert.ok(existsSync(path.join(repo, "whiteboard.zip")));
  assert.ok(!existsSync(path.join(repo, "whiteboard.zip.tmp")));
  const saved = readBoardFile(repo);
  assert.equal(saved.meta.latest, "bbb");
  assert.deepEqual(saved.meta.runs, ["aaa", "bbb"]);
  assert.equal(saved.meta.project, "linkshort");
  assert.equal(saved.decisions, "# B", "the latest log, readable without the app");
  assert.deepEqual(saved.runs.map((r) => r.id), ["aaa", "bbb"]);
  assert.equal(readBoardFile(mkdtempSync(path.join(tmp, "empty-"))), null);
});

test("a run saves the board in its repo when a turn ends, and a repo without one is mapped first", async () => {
  const repo = mkdtempSync(path.join(tmp, "repo-"));
  const run = new Run({ repo, brief: "Add a /health endpoint", mapFirst: true });
  assert.match(run.firstTurn, /^This repo has no board yet\. First map the codebase/);
  assert.match(run.firstTurn, /Then plan this task on that map, as usual:\nAdd a \/health endpoint$/);
  assert.equal(run.mapOnly, false);
  const mapOnly = new Run({ repo, brief: "", mapFirst: true });
  assert.equal(mapOnly.mapOnly, true);
  assert.match(mapOnly.firstTurn, /Don't ask to leave plan mode; the task comes in the next message\.$/);
  assert.equal(new Run({ repo, brief: "x" }).firstTurn, "x", "a repo with a board: just the task");
  for (const r of [mapOnly]) r.stop();

  run.emitOps([{ op: "project", name: "linkshort", goal: "Short links" }, { op: "node", id: "api", name: "API server", kind: "service" }]);
  await run.finishTurn({ ok: true });
  const saved = readBoardFile(repo);
  assert.deepEqual(saved.meta.runs, [run.id]);
  assert.equal(saved.meta.project, "linkshort");
  const events = saved.runs[0].jsonl.trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events[0].type, "meta");
  assert.ok(events.some((e) => e.type === "op" && e.op.id === "api"), "the board's ops are in it");
  run.stop();
});

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

test("the start screen asks a repo for its board, opens it, and a map-only run needs a repo without one", async () => {
  const repo = mkdtempSync(path.join(tmp, "repo-"));
  const bare = mkdtempSync(path.join(tmp, "bare-"));
  writeBoardFile(repo, { runs: [{ id: "zz9", jsonl: '{"type":"meta","id":"zz9","brief":"Map"}\n{"t":1,"type":"op","op":{"op":"phase","name":"planning"}}\n', decisions: "# Z" }], project: "linkshort" });
  const mw = runsMiddleware({ defaultRepo: repo });
  const { server, base } = await listen((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  const post = (p, body) => fetch(`${base}/api/runs${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const got = await (await fetch(`${base}/api/runs/repo-board?repo=${encodeURIComponent(repo)}`)).json();
    assert.equal(got.file, "whiteboard.zip");
    assert.deepEqual({ ...got.saved, savedAt: null }, { project: "linkshort", goal: null, savedAt: null, latest: "zz9", runs: 1 });
    assert.equal((await (await fetch(`${base}/api/runs/repo-board?repo=${encodeURIComponent(bare)}`)).json()).saved, null);

    assert.deepEqual(await (await post("/repo-board", { repo })).json(), { id: "zz9" });
    assert.ok(readFileSync(path.join(tmp, "recordings", "zz9.jsonl"), "utf8").includes('"phase"'), "its runs are saved runs now");
    assert.equal(readFileSync(path.join(tmp, "recordings", "zz9.decisions.md"), "utf8"), "# Z");
    assert.equal((await post("/repo-board", { repo: bare })).status, 404);

    const r = await post("", { repo, brief: "", map: true });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /already has a board \(whiteboard\.zip\)/);
    assert.equal((await post("", { repo: bare, brief: "" })).status, 400, "no task and no map: nothing to do");
  } finally {
    server.close();
  }
});

test("mapping instructions: the whole system, read-only; a task after it, or a stop", () => {
  assert.match(mapTurn(""), /every component that matters \(3 to 10, not just the ones a task would touch\)/);
  assert.match(mapTurn(""), /Don't change any files\./);
  assert.doesNotMatch(mapTurn("Add X"), /next message/);
});

test("the map-only turn's end says so (mapped), so the browser waits for a task instead of reviewing", async () => {
  const repo = mkdtempSync(path.join(tmp, "repo-"));
  const run = new Run({ repo, brief: "", mapFirst: true });
  const done = [];
  run.listeners.add((e) => e.type === "done" && done.push(e));
  run.mapTurnEnding = run.mapOnly; // what ClaudeRun.handle does with the turn's result
  run.mapOnly = false;
  await run.finishTurn({ ok: true });
  await run.finishTurn({ ok: true });
  assert.deepEqual(done.map((e) => !!e.mapped), [true, false]);
  run.stop();
});

