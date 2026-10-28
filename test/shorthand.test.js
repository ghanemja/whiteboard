// Shorthand mode (AGENT_SHORTHAND): board ops as one line each (server/shorthand.js), the tools that
// take and give them (server/board-tool.js, server/board-mcp.js), the setting, and the instructions.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { parseLine, parseLines, stateLines, toLine } from "../server/shorthand.js";
import { boardTools, drawShorthand, Op } from "../server/board-tool.js";
import { serveBoardMcp } from "../server/board-mcp.js";
import { shorthand, SHORTHAND_TOOLS } from "../server/runs.js";
import { BOARD_INSTRUCTIONS, boardInstructions, CODEX_BOARD_INSTRUCTIONS, SHORTHAND_BOARD_INSTRUCTIONS } from "../server/instructions.js";
import { createStreamParser } from "../src/engine/parser.js";
import { BUILD_SCRIPT, PLAN_SCRIPT } from "../src/agent/script.js";

test("a line: the op, its id, key=value pairs; quotes for spaces, | between list items", () => {
  assert.deepEqual(parseLine('node api name="API server" kind=service col=1 row=0 paths=src/server.js|src/routes libs="node:http (Node 22)" api="POST /links|GET /:code" v=built'), {
    op: "node", id: "api", name: "API server", kind: "service", col: 1, row: 0,
    paths: ["src/server.js", "src/routes"], libs: ["node:http (Node 22)"], api: ["POST /links", "GET /:code"], v: "built",
  });
  assert.deepEqual(parseLine('decision d1 title="Where vectors live" chose=pgvector over="Pinecone|FAISS on disk" affects=api|vdb why="It\'s \\"one\\" database"'), {
    op: "decision", id: "d1", title: "Where vectors live", chose: "pgvector", over: ["Pinecone", "FAISS on disk"], affects: ["api", "vdb"], why: 'It\'s "one" database',
  });
  // An edge's api is one call (a | in it stays); a node's is a list. \| keeps a | in an item.
  assert.deepEqual(parseLine('edge web>api via=HTTP api="GET /a|b"'), { op: "edge", from: "web", to: "api", via: "HTTP", api: "GET /a|b" });
  assert.deepEqual(parseLine('question q1 text="Max PDF size?" options="10 MB|50 MB"|"a\\|b"'), { op: "question", id: "q1", text: "Max PDF size?", options: ["10 MB", "50 MB", "a|b"] });
  assert.deepEqual(parseLine(toLine({ op: "node", id: "x", api: ["GET /a|b", "c d"] })).api, ["GET /a|b", "c d"]);
  // Where the second word goes, by op.
  assert.deepEqual(parseLine("phase planning"), { op: "phase", name: "planning" });
  assert.deepEqual(parseLine('answer el-9 text="Because the tests say so."'), { op: "answer", el: "el-9", text: "Because the tests say so." });
  assert.deepEqual(parseLine("unlink web>vdb"), { op: "unlink", from: "web", to: "vdb" });
  assert.deepEqual(parseLine("edge from=web to=api"), { op: "edge", from: "web", to: "api" }, "named ends work too");
  // steps, links and columns: a list from two items; one item stays a string the board splits on ";".
  assert.deepEqual(parseLine('flow f1 steps="web>api: POST /ask|api>vdb: top 8"').steps, ["web>api: POST /ask", "api>vdb: top 8"]);
  assert.equal(parseLine('part api.ask links="api.retrieve: the question; vdb: 8 chunks"').links, "api.retrieve: the question; vdb: 8 chunks");
  assert.equal(parseLine("task p1 text=a=b").text, "a=b", "only the first = splits");
});

test("each bad line gets its number and the reason; good lines still parse", () => {
  const { ops, errors } = parseLines(
    [
      "# the plan",
      "phase planning",
      "",
      "nod api name=x",
      'node api name="API server',
      "node vdb colour=red",
      "node vdb col=7",
      "node web name=Web web",
      "task p1 text=a text=b",
      "edge web-api",
      'node web name="Web app" kind=client col=0 row=0',
    ].join("\n"),
    Op,
  );
  assert.deepEqual(ops, [{ op: "phase", name: "planning" }, { op: "node", id: "web", name: "Web app", kind: "client", col: 0, row: 0 }]);
  assert.equal(errors.length, 7);
  assert.match(errors[0], /^line 4 \(nod api name=x\): op: Invalid option/);
  assert.match(errors[1], /^line 5 .*: a quote isn't closed$/);
  assert.match(errors[2], /^line 6 .*: no such key colour$/);
  assert.match(errors[3], /^line 7 .*: col: Too big/);
  assert.match(errors[4], /^line 8 .*: "web" needs a key=/);
  assert.match(errors[5], /^line 9 .*: text is given twice$/);
  assert.match(errors[6], /^line 10 .*: write edge's ends as from>to/);
});

// The demo's ops, as the agent sends them (the token study's conversion of its tags).
function demoOps() {
  const keys = new Set(Object.keys(Op.shape)), kinds = new Set(Op.shape.op.options), ops = [];
  const LIST = new Set(["over", "affects", "evidence", "builds_on", "paths", "libs", "options"]), SEMI = new Set(["steps", "columns", "links"]);
  const p = createStreamParser({
    onText() {},
    onOp(a) {
      if (!kinds.has(a.op)) return;
      const op = {};
      for (const [k, v] of Object.entries(a)) {
        if (!keys.has(k) || v === "") continue;
        if (k === "col" || k === "row") op[k] = Number(v);
        else if (LIST.has(k) || (k === "api" && a.op === "node")) op[k] = v.split(",").map((s) => s.trim()).filter(Boolean);
        else if (SEMI.has(k)) op[k] = v.split(";").map((s) => s.trim()).filter(Boolean);
        else op[k] = v;
      }
      ops.push(op);
    },
  });
  p.push(PLAN_SCRIPT + BUILD_SCRIPT);
  p.end();
  return ops;
}

test("every op of the demo survives op → line → op, and the lines are shorter than its JSON", () => {
  const ops = demoOps();
  assert.ok(ops.length > 60);
  const lines = ops.map(toLine);
  const back = parseLines(lines.join("\n"), Op);
  assert.deepEqual(back.errors, []);
  // A one-item steps/links/columns comes back as its one string, which the board reads the same way.
  const one = (op) => Object.fromEntries(Object.entries(op).map(([k, v]) => [k, ["steps", "links", "columns"].includes(k) && Array.isArray(v) && v.length === 1 ? v[0] : v]));
  assert.deepEqual(back.ops, ops.map((o) => one(Op.parse(o))));
  assert.ok(lines.join("\n").length < JSON.stringify({ ops }).length * 0.85, "at least 15% fewer characters");
});

test("read_board's state as lines: the ops that draw it, plus # lines for the rest", () => {
  const state = {
    project: "DocQA", goal: "Answers cite their page", phase: "planning",
    nodes: [{ id: "api", name: "API server", kind: "service", status: "built", col: 1, row: 0, libs: ["fastapi@0.115"], api: ["POST /ask"] }],
    edges: [{ from: "web", to: "api", via: "HTTP", api: "POST /ask" }],
    decisions: [{ id: "d1", title: "Where vectors live", chose: "pgvector", over: ["Pinecone"], why: "One database", affects: ["api"], state: "proposed", verify: "test 'cites' passes" }],
    tasks: [{ id: "p1", phase: "planning", text: "Read the API", status: "done" }],
    questions: [{ id: "q1", kind: "question", text: "Max size?", state: "answered", answer: "50 MB" }, { id: "a1", kind: "assumption", text: "PDFs have text", state: "open" }],
    free_cells: [{ col: 0, row: 2 }, { col: 2, row: 2 }],
    notes: 2,
    kept: [{ node: "api" }, { decision: "d1" }],
  };
  const text = stateLines(state);
  assert.match(text, /^# free cells \(col,row\): 0,2 2,2$/m);
  assert.match(text, /^# notes: 2$/m);
  assert.match(text, /^# kept \(leave as they are\): api d1$/m);
  const { ops, errors } = parseLines(text, Op);
  assert.deepEqual(errors, []);
  assert.deepEqual(ops.map((o) => o.op), ["project", "phase", "node", "edge", "decision", "task", "question", "assumption"]);
  assert.equal(ops.find((o) => o.op === "node").v, "built", "status reads as v, as the agent writes it");
  assert.deepEqual(ops.find((o) => o.op === "question"), { op: "question", id: "q1", text: "Max size?", state: "answered", answer: "50 MB" });
  assert.ok(text.length < JSON.stringify(state).length * 0.8);
  assert.equal(stateLines({}), "", "an empty board is no lines");
});

test("update_board in shorthand draws the good lines and lists the bad ones; nothing good is an error", () => {
  const drawn = [];
  const draw = (ops) => (drawn.push(...ops), ops.some((o) => o.op === "decision") ? ["D1 has no check yet."] : []);
  const r = drawShorthand({ lines: "phase planning\nnode api name=API col=9\ndecision d1 title=Store" }, draw);
  assert.deepEqual(drawn, [{ op: "phase", name: "planning" }, { op: "decision", id: "d1", title: "Store" }]);
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /^Board updated \(2 changes\)\.\nD1 has no check yet\.\n1 not drawn; fix and resend only these:\nline 2 \(node api name=API col=9\): col: /);

  // JSON ops are taken too, checked against the same schema.
  drawn.length = 0;
  const j = drawShorthand({ ops: [{ op: "phase", name: "verification" }, { op: "explode" }] }, draw);
  assert.deepEqual(drawn, [{ op: "phase", name: "verification" }]);
  assert.match(j.content[0].text, /ops\[1\]: op: Invalid option/);

  drawn.length = 0;
  const bad = drawShorthand({ lines: "nod x" }, draw);
  assert.equal(bad.isError, true);
  assert.equal(drawn.length, 0);
  assert.match(bad.content[0].text, /^Nothing drawn\.\n1 not drawn/);
  assert.equal(drawShorthand({}, draw).isError, true);
});

const listen = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });

test("the HTTP board in shorthand (Codex): lines in, lines out, a schema of one string", async () => {
  const drawn = [];
  const board = { project: "Links", phase: "planning", nodes: [{ id: "api", name: "API server", kind: "service", status: "planned" }] };
  const { server, base } = await listen((req, res) => serveBoardMcp(req, res, { token: "t", draw: (ops) => (drawn.push(...ops), []), read: async () => board, shorthand: true }));
  try {
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: "Bearer t" } } }));
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), ["update_board", "read_board"]);
    assert.deepEqual(Object.keys(tools[0].inputSchema.properties).sort(), ["lines", "ops"]);
    assert.ok(!JSON.stringify(tools[0].inputSchema).includes("proof_by"), "no per-field schema: the instructions carry it");
    const r = await client.callTool({ name: "update_board", arguments: { lines: 'phase planning\nnode api name="API server" kind=service' } });
    assert.equal(r.content[0].text, "Board updated (2 changes).");
    assert.deepEqual(drawn, [{ op: "phase", name: "planning" }, { op: "node", id: "api", name: "API server", kind: "service" }]);
    const read = await client.callTool({ name: "read_board", arguments: {} });
    assert.equal(read.content[0].text, 'project name=Links\nphase planning\nnode api name="API server" kind=service v=planned');
    await client.close();
  } finally {
    server.close();
  }
});

test("AGENT_SHORTHAND: on and off by name; a shorthand Claude run keeps ExitPlanMode for the plan gate", () => {
  for (const v of ["1", "true", "on", "yes", "ON"]) assert.equal(shorthand({ AGENT_SHORTHAND: v }), true, v);
  for (const v of ["0", "false", "off", "no", "Off"]) assert.equal(shorthand({ AGENT_SHORTHAND: v }), false, v);
  assert.equal(typeof shorthand({}), "boolean");
  assert.ok(SHORTHAND_TOOLS.includes("ExitPlanMode"), "a tools list drops ExitPlanMode unless it's named");
  for (const t of ["Read", "Edit", "Write", "Bash"]) assert.ok(SHORTHAND_TOOLS.includes(t));
  assert.deepEqual(boardTools(false).map((t) => t.name), ["update_board", "read_board"]);
  assert.ok(boardTools(false)[0].input.ops, "standard mode keeps the JSON tool as it was");
});

test("the shorthand instructions keep every rule of the standard ones, and Codex gets its own", () => {
  // Every line of the standard instructions is still there, but for the two that change.
  const changed = (l) => l.startsWith("The user is watching") || l.startsWith("## Ops (");
  for (const l of BOARD_INSTRUCTIONS.split("\n").filter((l) => l && !changed(l))) assert.ok(SHORTHAND_BOARD_INSTRUCTIONS.includes(l), l.slice(0, 60));
  assert.match(SHORTHAND_BOARD_INSTRUCTIONS, /## Writing ops as lines/);
  assert.match(SHORTHAND_BOARD_INSTRUCTIONS, /## Chat: terse/);
  assert.match(SHORTHAND_BOARD_INSTRUCTIONS, /final summary/);
  assert.equal(boardInstructions(), BOARD_INSTRUCTIONS);
  assert.equal(boardInstructions({ planTurn: true }), CODEX_BOARD_INSTRUCTIONS);
  const codex = boardInstructions({ planTurn: true, shorthand: true });
  assert.match(codex, /## Writing ops as lines/);
  assert.doesNotMatch(codex, /ExitPlanMode/);
  // The examples in the syntax section all parse.
  const ex = SHORTHAND_BOARD_INSTRUCTIONS.split("## Writing ops as lines")[1].split("\n\n")[2];
  const { ops, errors } = parseLines(ex, Op);
  assert.deepEqual(errors, []);
  assert.equal(ops.length, 8);
});
