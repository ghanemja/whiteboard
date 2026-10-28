// The plan gate for a Claude run when the agent ends a planning turn without asking to exit plan
// mode (it answered a sticker or a question and stopped): the server asks for approval itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// A real ClaudeRun writes a recording: keep it out of the repo.
const tmp = mkdtempSync(path.join(os.tmpdir(), "wb-plan-gate-"));
process.chdir(tmp);
const { ClaudeRun, Run } = await import("../server/runs.js");

// Only what planGateAfterTurn touches: the run's events, waiting requests, inbox and mode switch.
function fakeRun() {
  const run = Object.create(ClaudeRun.prototype);
  Object.assign(run, {
    events: [], pending: new Map(), listeners: new Set(), pushed: [], modes: [], stopped: false, planApproved: false,
    request: null, planProposed: false, planMarks: 0, planMarkAtTurn: 0, autoApprovePlan: false,
    inbox: { push: (m) => run.pushed.push(m.message.content) },
    q: { setPermissionMode: async (m) => run.modes.push(m) },
    recorder: { decide() {}, write() {}, update() {}, setPlan() {} },
    nodes: new Map(), decisions: new Map(), tasks: new Map(), started: Date.now(),
    touch() {},
  });
  run.emit = (e) => run.events.push(e);
  return run;
}
const gateOf = (run) => run.events.filter((e) => e.type === "gate").at(-1)?.requestId;
const tick = () => new Promise((r) => setTimeout(r, 0));

test("a planning turn that ends without ExitPlanMode gets a gate; Approve builds", async () => {
  const run = fakeRun();
  const done = run.planGateAfterTurn();
  assert.ok(gateOf(run), "the gate is up");
  assert.equal(run.gateId, gateOf(run), "and it's the run's gate: Approve, Revise and chat answer it");
  Run.prototype.answer.call(run, run.gateId, { behavior: "allow" });
  await done;
  assert.deepEqual(run.modes, ["acceptEdits"]);
  assert.equal(run.planApproved, true);
  assert.match(run.pushed[0], /approved the plan\. Build it now/);
  assert.equal(run.events.at(-1).type, "turn");
  // Once building, a turn that ends asks nothing.
  await run.planGateAfterTurn();
  assert.equal(run.events.filter((e) => e.type === "gate").length, 1);
});

test("asking for changes at that gate goes to the agent as its next message, still planning", async () => {
  const run = fakeRun();
  const done = run.planGateAfterTurn();
  Run.prototype.answer.call(run, run.gateId, { behavior: "deny", message: "Not approved yet. The user says: cap it at 20." });
  await done;
  assert.deepEqual(run.modes, []);
  assert.equal(run.planApproved, false);
  assert.deepEqual(run.pushed, ["Not approved yet. The user says: cap it at 20."]);
});

test("no second gate while one is up, a command is waiting, or the run has stopped", async () => {
  const run = fakeRun();
  run.planGateAfterTurn();
  await run.planGateAfterTurn();
  assert.equal(run.events.filter((e) => e.type === "gate").length, 1);
  const busy = fakeRun();
  busy.pending.set("p1", () => {});
  await busy.planGateAfterTurn();
  const stopped = fakeRun();
  stopped.stopped = true;
  await stopped.planGateAfterTurn();
  assert.equal(busy.events.length + stopped.events.length, 0);
  await tick();
});

test("the agent classifies each request first: a change leaves a plan to approve, a question doesn't", () => {
  const run = fakeRun();
  run.emitOps = Run.prototype.emitOps; // only its request and plan counting are used here
  Object.assign(run, { nodes: new Map(), edges: new Map(), tasks: new Map(), questions: new Map(), flows: new Map(), tables: new Map(), phase: "planning", record() {} });
  const notes = run.emitOps([{ op: "request", kind: "info" }, { op: "node", id: "api", name: "API", kind: "service", v: "built" }]);
  assert.match(notes.join(" "), /A question: answer it/);
  assert.equal(run.turnPlanned(), false, "a question: nothing to approve");
  run.emitOps([{ op: "request", kind: "action" }]);
  assert.equal(run.turnPlanned(), true, "a change: a plan to approve");
  run.emitOps([{ op: "task", id: "p1", phase: "planning", text: "Read", status: "done" }]);
  assert.equal(run.turnPlanned(), true, "an agent that didn't classify, but drew a plan");
  run.emitOps([{ op: "decision", id: "d9", title: "Existing store", chose: "A Map", state: "accepted" }]);
  assert.equal(run.turnPlanned(), false, "accepted decisions (a map) aren't a plan");
  run.planProposed = true;
  run.emitOps([{ op: "request", kind: "info" }]);
  assert.equal(run.turnPlanned(), true, "a question asked at the gate: the plan is still waiting");
});

test("a question can't leave plan mode, and a new request after a build goes back to read-only", async () => {
  const real = new ClaudeRun({ repo: tmp, brief: "How do links resolve?" });
  real.request = "info";
  const r = await real.canUseTool("ExitPlanMode", {}, {});
  assert.equal(r.behavior, "deny");
  assert.match(r.message, /question/);
  real.stop();
  const run = fakeRun();
  run.planApproved = true;
  const note = run.onRequest("action");
  assert.match(note, /plan mode again/);
  assert.deepEqual(run.modes, ["plan"]);
  assert.equal(run.planApproved, false);
  assert.equal(run.events.at(-1).stage, "planning");
});

