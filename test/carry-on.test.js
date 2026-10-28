// Carrying on from a saved board: a new run starts from the saved runs' board (the server's
// mirror of it), hands the agent the last run's decision log, and records where it came from.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";

// The recordings folder is resolved when recordings.js loads: keep this test's out of the repo.
const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-carry-on-"));
process.chdir(tmp);
const { Run } = await import("../server/runs.js");
const { readChain } = await import("../server/recordings.js");

const op = (o, t = 0) => ({ t, type: "op", op: o });
const first = [
  { type: "meta", id: "aaa", brief: "Count clicks" },
  op({ op: "project", name: "linkshort", goal: "Clicks per link" }),
  op({ op: "phase", name: "planning" }),
  op({ op: "node", id: "api", name: "API server", kind: "service", paths: ["src/server.js"] }),
  op({ op: "decision", id: "d1", title: "Where clicks live", chose: "A Map", over: ["SQLite"], affects: ["api"] }),
  { t: 5, type: "user", kind: "approve", edits: [] },
  op({ op: "phase", name: "complete" }),
  op({ op: "status", id: "api", v: "live" }),
];
const second = [
  { type: "meta", id: "bbb", from: "aaa", brief: "Add expiry" },
  op({ op: "phase", name: "planning" }),
  op({ op: "decision", id: "d2", title: "Expiry unit", chose: "Days", affects: ["api"] }),
];

test("the chain of saved runs, oldest first", () => {
  mkdirSync("recordings", { recursive: true });
  const jsonl = (events) => events.map((e) => JSON.stringify(e)).join("\n");
  writeFileSync("recordings/aaa.jsonl", jsonl(first));
  writeFileSync("recordings/bbb.jsonl", jsonl(second));
  writeFileSync("recordings/loop.jsonl", jsonl([{ type: "meta", id: "loop", from: "loop" }]));
  assert.deepEqual(readChain("bbb").map((events) => events[0].id), ["aaa", "bbb"]);
  assert.deepEqual(readChain("aaa").map((events) => events[0].id), ["aaa"]);
  assert.equal(readChain("loop").length, 1, "a run that names itself doesn't loop");
  assert.deepEqual(readChain("nope"), []);
});

test("a run carrying on starts from the saved board, quietly", async () => {
  const from = { id: "bbb", chain: [first, second], log: "# Decisions: linkshort\n\n- D1 Where clicks live: A Map" };
  const state = { nodes: [{ id: "api", name: "API server" }] };
  const edits = [{ kind: "rename", node: "api", from: "API server", to: "Web API" }];
  const run = new Run({ repo: tmp, brief: "Rename API server → Web API", from, boardState: state, edits });
  try {
    // The mirror: the saved board, with its approval; nothing sent or recorded twice.
    assert.equal(run.nodes.get("api").status, "live");
    assert.equal(run.decisions.get("d1").state, "accepted");
    assert.equal(run.decisions.get("d2").state, "proposed");
    assert.equal(run.project, "linkshort");
    assert.equal(run.events.length, 0);
    assert.equal(run.phase, null, "the new session plans first");
    // New decisions carry on the numbering, and are proposed until approved.
    run.emitOps([{ op: "decision", id: "d3", title: "Expired links", chose: "410 Gone", affects: ["api"] }]);
    assert.equal(run.decisions.get("d3").n, 3);
    assert.equal(run.decisions.get("d3").state, "proposed");
    assert.equal(run.events.length, 1);
    // The handover: the edits it started with, the last run's decision log, the board now.
    run.shorthand = false;
    const turn = run.firstTurn;
    assert.match(turn, /^I changed the board:\n<board_edits>\[\{"kind":"rename"/);
    assert.match(turn, /<handover from="bbb">\n# Decisions: linkshort/);
    // The board as lines in shorthand mode (the default), as JSON without it.
    run.shorthand = true;
    assert.match(run.firstTurn, /<board_state>\n(node|project|phase) /);
    run.shorthand = false;
    assert.match(run.firstTurn, /<board_state>\{"nodes":/);
    // The recording says where it came from.
    clearTimeout(run.idleTimer);
    run.recorder.close();
    await once(run.recorder.stream, "close");
    const meta = JSON.parse(readFileSync(`recordings/${run.id}.jsonl`, "utf8").split("\n")[0]);
    assert.equal(meta.from, "bbb");
    const log = readFileSync(`recordings/${run.id}.decisions.md`, "utf8");
    assert.match(log, /Carries on from:\*\* `recordings\/bbb\.decisions\.md`/);
    assert.match(log, /You: Carried on from run bbb/);
    assert.match(log, /D1 · Where clicks live \(accepted\)/, "the plan includes the saved board's decisions, approved");
  } finally {
    clearTimeout(run.idleTimer);
    run.recorder.close();
  }
});

test("a fresh run's first message is just the task", () => {
  const run = new Run({ repo: tmp, brief: "Count clicks" });
  assert.equal(run.firstTurn, "Count clicks");
  run.recorder.close();
});
