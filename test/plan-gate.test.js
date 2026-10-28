// The plan gate for a Claude run when the agent ends a planning turn without asking to exit plan
// mode (it answered a sticker or a question and stopped): the server asks for approval itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ClaudeRun, Run } from "../server/runs.js";

// Only what planGateAfterTurn touches: the run's events, waiting requests, inbox and mode switch.
function fakeRun() {
  const run = Object.create(ClaudeRun.prototype);
  Object.assign(run, {
    events: [], pending: new Map(), listeners: new Set(), pushed: [], modes: [], stopped: false, planApproved: false,
    inbox: { push: (m) => run.pushed.push(m.message.content) },
    q: { setPermissionMode: async (m) => run.modes.push(m) },
    recorder: { decide() {}, write() {} },
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
