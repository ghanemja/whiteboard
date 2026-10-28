// Any coding agent that speaks the Agent Client Protocol (ACP, agentclientprotocol.com) as the agent:
// Gemini CLI, OpenCode, goose, Cursor, GitHub Copilot, Cline, Qwen Code, Claude and Codex through
// their adapters, and the rest of the ACP registry (acp-agents.js names them). One agent process
// per run, spoken to over stdio: JSON-RPC 2.0, one message per line. The board reaches it as an MCP
// server over HTTP (board-mcp.js), or through board-stdio.js for an agent that takes commands only.
//
// ACP has no plan gate of its own, so it's the end of the planning turn, as with Codex; an agent with
// a plan mode plans in it, and its own request to leave plan mode is the gate too. While planning,
// edits are refused; once the plan is approved, edits inside the repo are allowed and commands ask,
// as they do for Claude. Its tool calls become activity rows, component status and test results
// through the same Run methods Claude's tool calls use.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acpAgent } from "./acp-agents.js";
import { boardInstructions, CODEX_PLAN_INSTRUCTIONS } from "./instructions.js";
import { gateAnswer, Run, settings, userMessage } from "./runs.js";

const BRIDGE = fileURLToPath(new URL("./board-stdio.js", import.meta.url));
const AUTH_REQUIRED = -32000; // ACP's error code for "sign in first"
const EDITS = new Set(["edit", "delete", "move"]);

// A select setting's values, grouped or not.
const choices = (opt) => (opt.options ?? []).flatMap((o) => o.options ?? [o]);
const rel = (repo, p) => (p ? path.relative(repo, path.resolve(repo, p)) || "." : "");
// The board's own tools, however an agent names them (update_board, mcp__board__read_board, …).
const isBoard = (t) => /(?:^|[^a-z])(?:update|read)_board(?![a-z_])/i.test(`${t.title ?? ""} ${t.name ?? ""}`);
// What a call does, specifically: the command, the file, the pattern.
const specific = (t) => (t.kind === "execute" ? t.input?.command ?? t.input?.cmd : t.kind === "read" ? t.paths?.[0] : t.kind === "search" ? t.input?.pattern ?? t.input?.query : true);
const commandOf = (t) => {
  const c = t.input?.command ?? t.input?.cmd;
  return (Array.isArray(c) ? c.join(" ") : c) || String(t.title ?? "").replace(/^`|`$/g, "");
};
// A tool call's output: its text content (without the code fences some agents wrap it in), else its
// raw output.
function outputOf(t) {
  const text = (t.content ?? []).map((c) => (c.type === "content" && c.content?.type === "text" ? c.content.text : "")).filter(Boolean).join("\n");
  if (text) return text.replace(/^\s*```[\w-]*\s*$/gm, "");
  const raw = t.output;
  if (typeof raw === "string") return raw;
  return [raw?.stdout, raw?.stderr, raw?.output, raw?.formatted_output].filter((s) => typeof s === "string").join("\n");
}

export class AcpRun extends Run {
  // agent: which agent and how to start it (acp-agents.js); env: its environment. Tests point them
  // at a scripted agent.
  constructor({ agent = acpAgent(), env = process.env, ...opts }) {
    super(opts);
    this.agent = agent;
    this.env = env;
    this.calls = new Map(); // our request id -> { resolve, reject }
    this.nextId = 1;
    this.stage = "planning"; // "planning" until the plan is approved, then "building"
    this.prompting = false; // a turn is in progress
    this.waiting = []; // what the user said during a turn, for the next one
    this.next = null; // the message that starts the next turn, after one stopped for it
    this.tools = new Map(); // tool call id -> { kind, title, input, content, output, files, shown, board }
    this.textOpen = false; // the agent's text since its last tool call
    this.turns = 0;
    this.cost = null; // the session's cost so far, if the agent reports one in dollars
  }

  get name() {
    return this.agent?.name ?? "The agent";
  }

  async start() {
    const { model, effort } = settings();
    await this.trackRepo();
    if (!this.agent) return this.fail("Set AGENT_COMMAND to the command that starts your agent in ACP mode, or AGENT_ENGINE to an agent the whiteboard knows (README, Other agents).");
    const [bin, ...args] = this.agent.command;
    const proc = spawn(bin, args, { cwd: this.repo, env: this.env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdin.on("error", () => {}); // a write after the agent exited: the exit handler reports it
    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; ) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // a log line on stdout
        }
        this.onMessage(msg);
      }
    });
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const exited = new Promise((resolve) => {
      proc.on("error", (err) =>
        resolve(err.code === "ENOENT" ? `${this.name} isn't installed (no \`${bin}\` on the PATH)${this.agent.install ? `: ${this.agent.install}` : ""}. Or set AGENT_COMMAND to how you start it.` : err.message),
      );
      proc.on("exit", (code, signal) => {
        const said = stderr.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
        resolve(code || (signal && !this.stopped) ? `${this.name} exited (${code ?? signal})${said ? `: ${said}` : ""}` : null);
      });
    });
    exited.then(async (why) => {
      this.exited = why ?? "exited";
      for (const { reject } of this.calls.values()) reject(new Error(why ?? `${this.name} exited`));
      this.calls.clear();
      if (why && !this.stopped) this.emit({ type: "error", message: why });
      await this.turnEnd;
      this.emit({ type: "closed" });
      this.recorder.close();
    });

    try {
      const init = await this.call("initialize", {
        protocolVersion: 1,
        // The agent reads, writes and runs commands itself; the whiteboard only watches and answers.
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "whiteboard", title: "Agent Whiteboard", version: "0.1.0" },
      });
      this.caps = init?.agentCapabilities ?? {};
      const session = await this.newSession(init?.authMethods ?? []);
      this.sessionId = session.sessionId;
      // The agent's own session id: what a later run would resume from.
      this.recorder.update({ sessionId: session.sessionId });
      this.modes = session.modes?.availableModes?.length ? session.modes : null;
      this.options = session.configOptions ?? [];
      this.mode = this.modes?.currentModeId ?? this.modeOption()?.currentValue ?? null;
      this.startMode = this.mode;
      const using = await this.configure("model", model);
      await this.configure("thought_level", effort);
      await this.setMode(this.planMode()).catch((err) => console.warn(`[acp] couldn't put ${this.name} in plan mode: ${err.message}`));
      this.emit({ type: "stage", stage: "planning", model: using ?? `${this.name}'s default`, repo: this.repo });
      // ACP has no system prompt: the board's instructions open the first message.
      await this.prompt(`${boardInstructions({ planTurn: true, shorthand: this.shorthand })}\n\n${CODEX_PLAN_INSTRUCTIONS}\n\n${this.firstTurn}`);
    } catch (err) {
      if (!this.stopped && !this.exited) this.emit({ type: "error", message: err.message }); // an exit says so itself
      this.halt();
    }
  }

  fail(message) {
    this.emit({ type: "error", message });
    this.emit({ type: "closed" });
    this.recorder.close();
  }

  // A session in the repo, with this run's board as its MCP server. An agent that wants signing in
  // first gets AGENT_AUTH's method, if that names one.
  async newSession(methods) {
    const params = { cwd: this.repo, mcpServers: [this.boardServer()] };
    try {
      return await this.call("session/new", params);
    } catch (err) {
      if (err.code !== AUTH_REQUIRED || !methods.length) throw err;
      const method = this.env.AGENT_AUTH?.trim();
      if (!method || !methods.some((m) => m.id === method))
        throw new Error(`${this.name} wants you to sign in: run \`${this.agent.command[0]}\` in a terminal once and sign in there, or set AGENT_AUTH to one of its ways in: ${methods.map((m) => `${m.id} (${m.name})`).join(", ")}.`);
      await this.call("authenticate", { methodId: method });
      return this.call("session/new", params);
    }
  }

  // The board, over HTTP with the run's token when the agent takes HTTP MCP servers, else as a command.
  boardServer() {
    const { url, token } = this.boardMcp;
    if (this.caps.mcpCapabilities?.http) return { type: "http", name: "board", url, headers: [{ name: "Authorization", value: `Bearer ${token}` }] };
    return { name: "board", command: process.execPath, args: [BRIDGE, url], env: [{ name: "WHITEBOARD_BOARD_TOKEN", value: token }] };
  }

  // A session setting the agent offers (its model, its thinking level), set to what AGENT_MODEL or
  // AGENT_EFFORT names, by id or name ("claude-opus-5-5" finds "anthropic/claude-opus-5-5" too).
  // Returns the setting's name as it now stands, or null.
  async configure(category, wanted) {
    const opt = this.options.find((o) => o.category === category && o.type === "select");
    if (!opt) return null;
    const values = choices(opt);
    const w = String(wanted ?? "").toLowerCase();
    const pick = w && values.find((v) => [v.value, v.name].some((s) => String(s).toLowerCase() === w || String(s).toLowerCase().endsWith(`/${w}`)));
    if (w && !pick) console.warn(`[acp] ${this.name} has no ${category} "${wanted}"; it offers ${values.slice(0, 12).map((v) => v.value).join(", ")}${values.length > 12 ? ` and ${values.length - 12} more` : ""}`);
    if (pick && pick.value !== opt.currentValue) {
      const res = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: opt.id, value: pick.value });
      if (res?.configOptions) this.options = res.configOptions;
    }
    return (pick ?? values.find((v) => v.value === opt.currentValue))?.name ?? opt.currentValue ?? null;
  }

  // The agent's modes: ACP's session modes (Claude's adapter), or a setting in the "mode" category
  // (OpenCode's build and plan agents).
  modeOption() {
    return this.options.find((o) => o.category === "mode" && o.type === "select") ?? null;
  }
  get modeList() {
    if (this.modes) return this.modes.availableModes;
    const opt = this.modeOption();
    return opt ? choices(opt).map((v) => ({ id: v.value, name: v.name })) : [];
  }
  // Its plan mode, if it has one: planning in it stops an agent that doesn't ask before editing from
  // editing anyway.
  planMode() {
    return this.modeList.find((m) => /plan/i.test(`${m.id} ${m.name}`))?.id ?? null;
  }
  // Building: a mode that takes edits without asking, as Claude's run does, else the one it started in.
  buildMode() {
    const modes = this.modeList;
    const plan = this.planMode();
    return (
      modes.find((m) => /accept.?edits|auto.?edit/i.test(`${m.id} ${m.name}`))?.id ??
      (this.startMode !== plan ? this.startMode : modes.find((m) => m.id !== plan && !/yolo|bypass|dont.?ask|full/i.test(`${m.id} ${m.name}`))?.id) ??
      null
    );
  }
  async setMode(id) {
    if (!id || id === this.mode || !this.sessionId) return;
    if (this.modes) await this.call("session/set_mode", { sessionId: this.sessionId, modeId: id });
    else {
      const res = await this.call("session/set_config_option", { sessionId: this.sessionId, configId: this.modeOption().id, value: id });
      if (res?.configOptions) this.options = res.configOptions;
    }
    this.mode = id;
  }
  // switchMode: false when the agent leaves its plan mode itself.
  async startBuilding({ switchMode = true } = {}) {
    this.stage = "building";
    this.planProposed = false;
    this.emit({ type: "stage", stage: "building" });
    if (switchMode) await this.setMode(this.buildMode()).catch((err) => console.warn(`[acp] couldn't switch ${this.name} out of plan mode: ${err.message}`));
  }

  // ---- JSON-RPC ----
  send(msg) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  notify(method, params) {
    this.send({ method, params });
  }

  onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(Object.assign(new Error(msg.error.message ?? `${this.name} refused`), { code: msg.error.code }));
      else call?.resolve(msg.result);
      return;
    }
    if (msg.id != null) return this.onRequest(msg).catch((err) => this.send({ id: msg.id, error: { code: -32603, message: err.message } }));
    if (msg.method === "session/update" && msg.params?.update) this.onUpdate(msg.params.update);
  }

  // ---- turns ----
  async prompt(text) {
    this.idle = false;
    this.turns++;
    this.prompting = true;
    this.textOpen = false;
    let res = null, err = null;
    try {
      res = await this.call("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    } catch (e) {
      err = e;
    }
    this.prompting = false;
    return this.turnEnded(res?.stopReason ?? null, err);
  }

  async turnEnded(stop, err) {
    if (this.stopped || this.exited) return;
    // A turn stopped so the user's answer could go in now (leavePlanMode).
    if (this.next) {
      const message = this.next;
      this.next = null;
      return this.prompt(message);
    }
    const ok = !err && stop === "end_turn";
    // The planning turn's end is the plan: the gate, as Claude's ExitPlanMode is.
    const planned = this.turnPlanned();
    if (this.mapOnly) this.mapOnly = !(this.mapTurnEnding = true); // the map is drawn; the task is the next message
    else if (this.stage === "planning" && ok && planned) {
      this.recordPlan("Proposed a plan");
      const answer = await this.ask({ type: "gate" });
      if (answer.stopped) return;
      if (answer.approve) await this.startBuilding();
      return this.prompt(answer.message);
    }
    await this.finishTurn({ ok, why: err?.message ?? stop, cost: this.cost, turns: this.turns, answered: this.stage === "planning" });
    if (this.waiting.length && !this.stopped) return this.prompt(this.waiting.splice(0).join("\n\n"));
  }

  // Something the user said: the next turn, now or after the one in progress.
  say(message) {
    if (this.prompting) this.waiting.push(message);
    else this.prompt(message).catch((err) => this.emit({ type: "error", message: err.message }));
  }

  // ---- what the agent does ----
  onUpdate(u) {
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type !== "text" || !u.content.text) return;
        if (!this.textOpen) {
          this.textOpen = true;
          this.turnText += "\n\n";
          this.emit({ type: "break" });
        }
        this.turnText += u.content.text;
        return this.emit({ type: "text", text: u.content.text });
      case "tool_call":
      case "tool_call_update":
        return this.onToolCall(u);
      case "current_mode_update":
        this.mode = u.currentModeId;
        return;
      case "config_option_update":
        if (u.configOptions) this.options = u.configOptions;
        if (!this.modes && this.modeOption()) this.mode = this.modeOption().currentValue;
        return;
      case "usage_update":
        if (u.cost?.currency === "USD") this.cost = u.cost.amount;
        return;
      default:
    }
  }

  // A tool call, new or updated: a row in the activity panel once it says what it's doing, the
  // components that own the files it edits, and, once a command finishes, its output.
  onToolCall(u) {
    const id = u.toolCallId;
    const t = this.tools.get(id) ?? { kind: "other", title: "", input: {}, files: new Set(), shown: false, board: false };
    this.tools.set(id, t);
    if (u.sessionUpdate === "tool_call") this.textOpen = false;
    if (u.kind) t.kind = u.kind;
    if (u.title) t.title = u.title;
    if (u.rawInput && typeof u.rawInput === "object") t.input = u.rawInput;
    if (u.content) t.content = u.content;
    if (u.rawOutput !== undefined) t.output = u.rawOutput;
    if (isBoard(u)) t.board = true;
    if (t.board) return;

    const paths = [...(u.locations ?? []).map((l) => l.path), ...(u.content ?? []).filter((c) => c.type === "diff").map((c) => c.path)].filter(Boolean).map((p) => rel(this.repo, p));
    if (paths.length) t.paths = [...new Set([...(t.paths ?? []), ...paths])];
    if (EDITS.has(t.kind)) {
      // Once it's under way: an edit proposed while planning, or one the user turns down, isn't one.
      if (u.status !== "in_progress" && u.status !== "completed") return;
      for (const p of t.paths ?? [])
        if (!t.files.has(p)) {
          t.files.add(p);
          // A diff from nothing is a new file.
          this.fileEdited(id, p, { write: (t.content ?? []).some((c) => c.type === "diff" && c.oldText == null && rel(this.repo, c.path) === p) });
        }
    } else if (!t.shown && (u.status === "in_progress" || u.status === "completed" || u.status === "failed" || specific(t))) {
      // Once it says what it's doing: a call can open with just a title ("Terminal") and its input after.
      t.shown = true;
      const activity =
        t.kind === "read" ? { kind: "read", label: t.paths?.[0] ?? t.title }
        : t.kind === "search" ? { kind: "search", label: t.input.pattern ?? t.input.query ?? t.title }
        : t.kind === "execute" ? { kind: "command", label: commandOf(t) }
        : t.kind === "think" || t.kind === "switch_mode" ? null
        : { kind: "tool", label: t.title };
      if (activity) this.emit({ type: "activity", toolUseId: id, ...activity });
    }

    if (u.status !== "completed" && u.status !== "failed") return;
    if (EDITS.has(t.kind)) return this.scheduleChanges();
    if (t.kind !== "execute") return;
    this.scheduleChanges();
    this.commandOutput(id, outputOf(t), u.status === "failed");
  }

  // ---- what the agent asks the user ----
  async onRequest({ id, method, params }) {
    if (method !== "session/request_permission") return this.send({ id, error: { code: -32601, message: `The whiteboard doesn't handle ${method}.` } });
    this.send({ id, result: { outcome: await this.permission(params) } });
  }

  async permission({ toolCall = {}, options = [] }) {
    const t = this.tools.get(toolCall.toolCallId) ?? {};
    const kind = toolCall.kind ?? t.kind ?? "other";
    const title = toolCall.title ?? t.title ?? "";
    const input = (toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : t.input) ?? {};
    const choose = (allow) => {
      const o = options.find((o) => o.kind === (allow ? "allow_once" : "reject_once")) ?? options.find((o) => o.kind?.startsWith(allow ? "allow" : "reject"));
      return o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" };
    };
    if (t.board || isBoard(toolCall)) return choose(true);
    // The agent asking to leave its plan mode: the plan is ready.
    if (kind === "switch_mode" && this.stage === "planning") return this.leavePlanMode(options);
    if (EDITS.has(kind)) {
      // Planning is read-only, as Claude's plan mode is. Building, edits inside the repo go ahead,
      // as Claude's do; one outside it asks.
      if (this.stage === "planning") return choose(false);
      const paths = [...(toolCall.locations ?? []).map((l) => rel(this.repo, l.path)), ...(t.paths ?? [])];
      if (!paths.some((p) => p.startsWith(".."))) return choose(true);
    }
    if (kind === "execute" && this.allowCommands) return choose(true);
    const command = commandOf({ title, input });
    const a = await this.ask({ type: "permission", tool: kind === "execute" ? "Bash" : title || kind, detail: kind === "execute" ? command : title || JSON.stringify(input).slice(0, 200), description: input.description ?? "" });
    return a.stopped ? { outcome: "cancelled" } : choose(a.allow);
  }

  // The plan gate when the agent asks to leave its plan mode. A plain approval lets it go on to build
  // in the same turn; anything else stops the turn, and the next one starts with the user's answer.
  async leavePlanMode(options) {
    this.recordPlan("Proposed a plan");
    const answer = await this.ask({ type: "gate" });
    if (answer.stopped) return { outcome: "cancelled" };
    if (answer.plain) {
      await this.startBuilding({ switchMode: false });
      const o = options.find((o) => o.kind === "allow_always") ?? options.find((o) => o.kind === "allow_once"); // allow_always: accept edits
      return o ? { outcome: "selected", optionId: o.optionId } : { outcome: "cancelled" };
    }
    if (answer.approve) await this.startBuilding();
    this.next = answer.message;
    this.notify("session/cancel", { sessionId: this.sessionId });
    return { outcome: "cancelled" };
  }

  // ---- the user's side ----
  deliver(body, ctx) {
    switch (body.type) {
      case "approve":
        return ctx.gate ? this.answer(ctx.gate, { ...gateAnswer(body, ctx), plain: !ctx.edits }) : false;
      case "revise":
      case "chat":
        if (ctx.gate) return this.answer(ctx.gate, gateAnswer(body, ctx));
      // falls through: said outside the gate
      case "edits":
        this.say(userMessage(body, ctx));
        this.emit({ type: "turn" });
        return true;
      case "permission":
        if (body.decision === "allow-all") this.allowCommands = true;
        return this.answer(body.requestId, { allow: body.decision === "allow" || body.decision === "allow-all" });
      default:
        return false;
    }
  }

  halt() {
    const proc = this.proc;
    if (!proc || proc.exitCode != null) return;
    if (this.sessionId) this.notify("session/cancel", { sessionId: this.sessionId });
    // A moment to stop the turn cleanly, then the process goes.
    setTimeout(() => proc.kill(), 500).unref();
  }
}
