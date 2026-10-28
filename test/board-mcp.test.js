// The board as an MCP server over HTTP (server/board-mcp.js), driven by the MCP SDK's own client the
// way Codex or any other agent would: list the tool, draw, get turned away without the run's token.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { serveBoardMcp } from "../server/board-mcp.js";
import { ClaudeRun, localOrigin, Run, runsMiddleware } from "../server/runs.js";

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

const connect = async (url, token) => {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}));
  return client;
};

test("an MCP client lists update_board, draws with it, and gets the board's notes back", async () => {
  const drawn = [];
  const { server, base } = await listen((req, res) =>
    serveBoardMcp(req, res, { token: "s3cret", draw: (ops) => (drawn.push(...ops), ops.some((o) => o.op === "decision") ? ["D1 has no check yet."] : []) }),
  );
  try {
    const client = await connect(`${base}/mcp`, "s3cret");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["update_board", "read_board"]);
    assert.ok(tools[0].inputSchema.properties.ops, "its ops schema is published");
    assert.match(tools[0].description, /\bpart\b/);

    const ops = [{ op: "node", id: "api", name: "API server", kind: "service" }, { op: "part", id: "api.ask", of: "api", name: "POST /ask", kind: "route" }];
    const r = await client.callTool({ name: "update_board", arguments: { ops } });
    assert.equal(r.content[0].text, "Board updated (2 changes).");
    assert.deepEqual(drawn, ops);

    const d = await client.callTool({ name: "update_board", arguments: { ops: [{ op: "decision", id: "d1", title: "Where links live" }] } });
    assert.equal(d.content[0].text, "Board updated (1 change).\nD1 has no check yet.", "the board's corrections reach the agent");

    const bad = await client.callTool({ name: "update_board", arguments: { ops: [{ op: "explode" }] } }).catch((e) => ({ isError: true, e }));
    assert.ok(bad.isError, "an unknown op is refused");
    assert.equal(drawn.length, 3, "and draws nothing");
    await client.close();
  } finally {
    server.close();
  }
});

test("no token, or the wrong one: 401, and nothing drawn", async () => {
  let drawn = 0;
  const { server, base } = await listen((req, res) => serveBoardMcp(req, res, { token: "s3cret", draw: () => (drawn++, []) }));
  try {
    for (const headers of [{}, { authorization: "Bearer nope" }]) {
      const r = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(r.status, 401);
      assert.match(r.headers.get("www-authenticate") ?? "", /^Bearer/);
    }
    await assert.rejects(connect(`${base}/mcp`, "nope"));
    assert.equal(drawn, 0);
  } finally {
    server.close();
  }
});

test("each run's board is served at /api/runs/<id>/mcp, behind that run's token", async () => {
  const runs = (globalThis.__agentRuns ??= new Map());
  const drawn = [];
  runs.set("r1", { boardMcp: { url: "", token: "tok-r1" }, emitOps: (ops) => (drawn.push(...ops), []) });
  const mw = runsMiddleware({ defaultRepo: "." });
  // Mounted at /api/runs, as Vite does: the router sees the path below it.
  const { server, base } = await listen((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  try {
    const client = await connect(`${base}/api/runs/r1/mcp`, "tok-r1");
    await client.callTool({ name: "update_board", arguments: { ops: [{ op: "phase", name: "planning" }] } });
    assert.deepEqual(drawn, [{ op: "phase", name: "planning" }]);
    await client.close();
    await assert.rejects(connect(`${base}/api/runs/r1/mcp`, "tok-other"), "another run's token doesn't open this board");
    assert.equal((await fetch(`${base}/api/runs/nope/mcp`, { method: "POST", headers: { "content-type": "application/json" } })).status, 404);
  } finally {
    runs.delete("r1");
    server.close();
  }
});

test("read_board hands the agent the board the browser reports, or says there isn't one", async () => {
  const board = { project: "Links", nodes: [{ id: "api", name: "API server" }], decisions: [] };
  let answer = board;
  const { server, base } = await listen((req, res) => serveBoardMcp(req, res, { token: "s3cret", draw: () => [], read: async () => answer }));
  try {
    const client = await connect(`${base}/mcp`, "s3cret");
    const r = await client.callTool({ name: "read_board", arguments: {} });
    assert.deepEqual(JSON.parse(r.content[0].text), board);
    answer = null;
    const none = await client.callTool({ name: "read_board", arguments: {} });
    assert.match(none.content[0].text, /isn't open in a browser/);
    await client.close();
  } finally {
    server.close();
  }
});

test("read_board asks the browser over the event stream, takes its answer once, and gives up after 5 seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Only what readBoard touches: a run's listeners and its waiting reads. A real Run would also
  // open a recording file, and the answer must not be kept in the run's events.
  const run = { boardReads: new Map(), listeners: new Set() };
  const asked = [];
  run.listeners.add((e) => asked.push(e));

  const board = Run.prototype.readBoard.call(run);
  assert.deepEqual(asked.map((e) => e.type), ["board-read"]);
  const { id } = asked[0];
  assert.equal(Run.prototype.answerBoardRead.call(run, id, { nodes: [] }), true);
  assert.deepEqual(await board, { nodes: [] });
  assert.equal(Run.prototype.answerBoardRead.call(run, id, { nodes: [] }), false, "a second answer to the same read is refused");

  const silent = Run.prototype.readBoard.call(run);
  t.mock.timers.tick(5000);
  assert.equal(await silent, null, "nobody answered: null, not an old board");
  assert.equal(run.boardReads.size, 0);
});

test("the browser's answer to a read reaches the run, behind the run's route", async () => {
  const runs = (globalThis.__agentRuns ??= new Map());
  const answers = [];
  runs.set("r2", { boardMcp: { url: "", token: "tok-r2" }, answerBoardRead: (id, state) => (answers.push([id, state]), true) });
  const mw = runsMiddleware({ defaultRepo: "." });
  const { server, base } = await listen((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "") || "/";
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  try {
    const r = await fetch(`${base}/api/runs/r2/board`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "a1b2", board_state: { nodes: [] } }) });
    assert.equal(r.status, 200);
    assert.deepEqual(answers, [["a1b2", { nodes: [] }]]);
  } finally {
    runs.delete("r2");
    server.close();
  }
});

test("a message carries what the user changed and the assumptions they confirmed, never the whole board", () => {
  const pushed = [];
  // Only what control() and deliver() touch: the inbox the agent reads, and the run's bookkeeping.
  const run = { inbox: { push: (m) => pushed.push(m.message.content) }, touch() {}, record() {}, gateId: null, steer: null, emit() {} };
  run.deliver = ClaudeRun.prototype.deliver;
  const board_state = { nodes: [{ id: "vdb", name: "Vector index" }], decisions: [{ id: "d1" }] };

  Run.prototype.control.call(run, {
    type: "edits",
    edits: [{ kind: "rename", node: "api", from: "API server", to: "Backend" }],
    confirmed: [{ id: "a1", text: "PDFs have a text layer" }],
    board_state,
  });

  const [message] = pushed;
  assert.match(message, /<board_edits>\[\{"kind":"rename".*?<\/board_edits>/);
  assert.match(message, /<board_confirmed>\[\{"id":"a1","text":"PDFs have a text layer"\}\]<\/board_confirmed>/);
  assert.doesNotMatch(message, /board_state|Vector index|"d1"/, "the board itself isn't sent with the message");
});

test("an agent is sent to the address the browser's request came in on, IPv6 included", () => {
  assert.equal(localOrigin({ localAddress: "127.0.0.1", localPort: 5199 }), "http://127.0.0.1:5199");
  // Vite's "localhost" on macOS: ::1 only, where 127.0.0.1 is refused.
  assert.equal(localOrigin({ localAddress: "::1", localPort: 5199 }), "http://[::1]:5199");
  assert.equal(localOrigin({ localAddress: "::ffff:127.0.0.1", localPort: 5199 }), "http://127.0.0.1:5199");
});
