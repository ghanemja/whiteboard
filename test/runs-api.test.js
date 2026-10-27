// The runs API (server/runs.js) against a page on another site: its "simple" cross-origin POSTs
// (text/plain, a form) skip the CORS preflight and reach the handler, so the handler turns them away.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { runsMiddleware } from "../server/runs.js";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

test("a text/plain or form POST from another site gets 415: no run starts, none is steered", async () => {
  const runs = (globalThis.__agentRuns ??= new Map());
  const repo = mkdtempSync(path.join(os.tmpdir(), "wb-runs-"));
  // Should the check ever go, what starts is a Codex run whose binary isn't there: no agent, no API spend.
  const saved = { AGENT_ENGINE: process.env.AGENT_ENGINE, CODEX_BIN: process.env.CODEX_BIN };
  Object.assign(process.env, { AGENT_ENGINE: "codex", CODEX_BIN: path.join(repo, "no-codex") });
  const controls = [];
  runs.set("r1", { boardMcp: { url: "", token: "tok-r1" }, emitOps: () => [], control: (body) => (controls.push(body), true) });
  const before = new Set(runs.keys());
  const mw = runsMiddleware({ defaultRepo: repo });
  const { server, base } = await listen((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  const post = (to, type, body) =>
    fetch(`${base}/api/runs${to}`, { method: "POST", headers: { "content-type": type, origin: "https://evil.example" }, body: JSON.stringify(body) });
  try {
    for (const type of ["text/plain;charset=UTF-8", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      const r = await post("", type, { repo, brief: "Read the repo." });
      assert.equal(r.status, 415, `start, ${type}`);
      assert.deepEqual(await r.json(), { error: "Send JSON." });
      assert.equal((await post("/r1/control", type, { type: "permission", requestId: "p1", decision: "allow-all" })).status, 415, `control, ${type}`);
    }
    assert.deepEqual([...runs.keys()], [...before], "no run started");
    assert.deepEqual(controls, [], "and the run wasn't steered");

    // JSON, as the browser sends it, is read and acted on.
    const r = await post("", "application/json", { repo, brief: "" });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { error: "Describe the task first." });
    assert.equal((await post("/r1/control", "application/json", { type: "stop" })).status, 200);
    assert.deepEqual(controls, [{ type: "stop" }]);
  } finally {
    for (const [id, run] of runs) if (!before.has(id)) run.stop();
    runs.delete("r1");
    server.close();
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(repo, { recursive: true, force: true });
  }
});
