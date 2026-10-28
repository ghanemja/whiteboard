// A scripted coding agent that speaks ACP over stdio, for test/acp-run.test.js. It plays the turns in
// FAKE_ACP_SCRIPT (JSON: one array of steps per prompt) and logs what the whiteboard sends it, and
// how it answered, to FAKE_ACP_LOG (JSONL). It reaches the board through the MCP server the
// whiteboard gives it, over HTTP or as a command, with the MCP SDK's own client.
//
// Steps: { say }, { board: [ops] }, { lines: shorthand }, { edit: path, text }, { run: command }, { exitPlan: true },
// { usage: dollars }, { waitForCancel: true }. FAKE_ACP_HTTP=0: it takes MCP servers as commands only.
// FAKE_ACP_AUTH=1: it wants signing in (method "api-key") before a session. FAKE_ACP_MODE_SETTING=1:
// its modes (build, plan) are a "mode" setting, as OpenCode's are, not ACP's session modes.
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const script = JSON.parse(readFileSync(process.env.FAKE_ACP_SCRIPT, "utf8"));
const log = (entry) => appendFileSync(process.env.FAKE_ACP_LOG, `${JSON.stringify(entry)}\n`);
const http = process.env.FAKE_ACP_HTTP !== "0";
let signedIn = process.env.FAKE_ACP_AUTH !== "1";
const modeSetting = process.env.FAKE_ACP_MODE_SETTING === "1";

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
const calls = new Map();
let nextId = 1;
const call = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    calls.set(id, resolve);
    send({ id, method, params });
  });
const update = (u) => send({ method: "session/update", params: { sessionId: "s1", update: u } });

let cwd = null, board = null, turn = 0, cancelled = null, toolId = 0, mode = modeSetting ? "build" : "default";

async function connect(server) {
  const client = new Client({ name: "fake-acp-agent", version: "1.0.0" });
  const transport = server.type === "http"
    ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: Object.fromEntries(server.headers.map((h) => [h.name, h.value])) } })
    : new StdioClientTransport({ command: server.command, args: server.args, env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) } });
  await client.connect(transport);
  return client;
}

async function permission(toolCall, options) {
  const res = await call("session/request_permission", { sessionId: "s1", toolCall, options });
  const outcome = res.outcome.outcome === "selected" ? options.find((o) => o.optionId === res.outcome.optionId)?.kind : "cancelled";
  log({ permission: toolCall.kind, title: toolCall.title, outcome });
  return outcome;
}
const OPTIONS = [
  { optionId: "yes", name: "Allow", kind: "allow_once" },
  { optionId: "always", name: "Always allow", kind: "allow_always" },
  { optionId: "no", name: "Reject", kind: "reject_once" },
];

async function play(step) {
  if (step.say) return update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.say } });
  if (step.usage != null) return update({ sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: step.usage, currency: "USD" } });
  const id = `t${++toolId}`;
  if (step.board || step.lines) {
    const args = step.lines ? { lines: step.lines } : { ops: step.board };
    update({ sessionUpdate: "tool_call", toolCallId: id, title: "update_board (board MCP server)", kind: "other", status: "pending", rawInput: args });
    const res = await board.callTool({ name: "update_board", arguments: args });
    log({ board: res.content?.[0]?.text ?? "" });
    return update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
  }
  if (step.edit) {
    const file = path.join(cwd, step.edit);
    const tc = { toolCallId: id, title: `Write ${step.edit}`, kind: "edit", status: "pending", locations: [{ path: file }], content: [{ type: "diff", path: file, oldText: null, newText: step.text }] };
    update({ sessionUpdate: "tool_call", ...tc });
    if (!(await permission(tc, OPTIONS)).startsWith("allow")) return update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed" });
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, step.text);
    return update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "completed" });
  }
  if (step.run) {
    // As Claude's adapter does: a bare "Terminal" first, the command in an update.
    update({ sessionUpdate: "tool_call", toolCallId: id, title: "Terminal", kind: "execute", status: "pending", rawInput: {} });
    const tc = { toolCallId: id, title: `\`${step.run}\``, kind: "execute", status: "pending", rawInput: { command: step.run, description: "Run it" } };
    update({ sessionUpdate: "tool_call_update", ...tc });
    if (!(await permission(tc, OPTIONS)).startsWith("allow")) return update({ sessionUpdate: "tool_call_update", toolCallId: id, status: "failed", content: [{ type: "content", content: { type: "text", text: "The user rejected this." } }] });
    let out, ok = true;
    try {
      out = execSync(step.run, { cwd, encoding: "utf8" });
    } catch (err) {
      out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
      ok = false;
    }
    return update({ sessionUpdate: "tool_call_update", toolCallId: id, status: ok ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: `\`\`\`console\n${out}\`\`\`` } }] });
  }
  if (step.exitPlan) {
    const tc = { toolCallId: id, title: "Ready to code?", kind: "switch_mode", status: "pending" };
    update({ sessionUpdate: "tool_call", ...tc });
    const outcome = await permission(tc, [
      { optionId: "acceptEdits", name: "Yes, and auto-accept edits", kind: "allow_always" },
      { optionId: "default", name: "Yes, and manually approve edits", kind: "allow_once" },
      { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
    ]);
    if (outcome.startsWith("allow")) {
      mode = outcome === "allow_always" ? "acceptEdits" : "default";
      update({ sessionUpdate: "current_mode_update", currentModeId: mode });
    }
    return;
  }
  if (step.waitForCancel) return new Promise((resolve) => (cancelled = resolve));
}

async function onRequest({ id, method, params }) {
  switch (method) {
    case "initialize":
      log({ initialize: params });
      return send({ id, result: { protocolVersion: 1, agentCapabilities: { mcpCapabilities: { http, sse: false } }, authMethods: [{ id: "api-key", name: "Use an API key" }], agentInfo: { name: "fake", version: "1.0.0" } } });
    case "authenticate":
      log({ authenticate: params.methodId });
      signedIn = true;
      return send({ id, result: {} });
    case "session/new":
      if (!signedIn) return send({ id, error: { code: -32000, message: "Authentication required" } });
      cwd = params.cwd;
      log({ sessionNew: { cwd, mcpServers: params.mcpServers.map((s) => ({ ...s, headers: s.headers?.map((h) => h.name), env: s.env?.map((e) => e.name) })) } });
      board = await connect(params.mcpServers.find((s) => s.name === "board"));
      log({ boardTools: (await board.listTools()).tools.map((t) => t.name) });
      return send({
        id,
        result: {
          sessionId: "s1",
          modes: modeSetting ? null : { currentModeId: mode, availableModes: [{ id: "default", name: "Default" }, { id: "acceptEdits", name: "Accept Edits" }, { id: "plan", name: "Plan Mode" }] },
          configOptions: [
            { id: "model", name: "Model", category: "model", type: "select", currentValue: "fast", options: [{ value: "fast", name: "Fast" }, { value: "acme/smart", name: "Smart" }] },
            ...(modeSetting ? [{ id: "mode", name: "Session Mode", category: "mode", type: "select", currentValue: mode, options: [{ value: "build", name: "build" }, { value: "plan", name: "plan" }] }] : []),
          ],
        },
      });
    case "session/set_mode":
      mode = params.modeId;
      log({ setMode: mode });
      return send({ id, result: {} });
    case "session/set_config_option":
      if (params.configId === "mode") {
        mode = params.value;
        log({ setMode: mode });
      } else log({ setConfig: [params.configId, params.value] });
      return send({ id, result: {} });
    case "session/prompt": {
      const text = params.prompt.map((b) => b.text).join("");
      log({ prompt: text, mode });
      const steps = script[turn++] ?? [{ say: "Nothing left to do." }];
      for (const step of steps) {
        if (cancelled === true) break;
        await play(step);
        if (cancelled === true) break;
      }
      const stopReason = cancelled === true ? "cancelled" : "end_turn";
      cancelled = null;
      return send({ id, result: { stopReason } });
    }
    default:
      return send({ id, error: { code: -32601, message: `no ${method}` } });
  }
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  if (msg.id != null && !msg.method) {
    calls.get(msg.id)?.(msg.result);
    calls.delete(msg.id);
  } else if (msg.method === "session/cancel") {
    log({ cancel: true });
    if (typeof cancelled === "function") cancelled();
    cancelled = true;
  } else if (msg.id != null) onRequest(msg).catch((err) => send({ id: msg.id, error: { code: -32603, message: err.message } }));
});
