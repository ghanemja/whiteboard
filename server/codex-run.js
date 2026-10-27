// Codex as the agent (AGENT_ENGINE=codex). One `codex app-server` per run, spoken to over stdio:
// JSON-RPC without the "jsonrpc" field, one message per line. The board reaches Codex as an MCP
// server over HTTP (board-mcp.js), at this run's URL with its token.
//
// Claude's plan mode and its ExitPlanMode call have no Codex counterpart, so the plan gate is a turn
// boundary: Codex plans in a read-only sandbox with approvals off, and the end of that turn is the
// plan. Approve starts a building turn in a workspace-write sandbox, where Codex asks before
// commands that need more (the permission prompts). Its commands and file changes become activity
// rows, component status and test results through the same Run methods Claude's tool calls use.
import { spawn } from "node:child_process";
import path from "node:path";
import { CODEX_BOARD_INSTRUCTIONS, CODEX_PLAN_INSTRUCTIONS } from "./instructions.js";
import { Run, settings } from "./runs.js";

const rel = (repo, p) => (p ? path.relative(repo, path.resolve(repo, p)) || "." : "");
const text = (t) => [{ type: "text", text: t, text_elements: [] }];
// Why Codex's MCP client gave up on the board, without the Rust type names it wraps that in.
const boardError = (e = "") =>
  /not logged in/.test(e) ? "it turned away the run's token" : e.replace(/ ?Transport \[[^\]]*\]/g, "").split(", when ")[0].split("error: ").pop();
// TOML for a `-c key=value` override.
const toml = (v) => JSON.stringify(v);

const PLANNING = { approvalPolicy: "never", sandboxPolicy: { type: "readOnly", networkAccess: false } };
const BUILDING = { approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } };

export class CodexRun extends Run {
  // bin, args and env: how to start Codex (CODEX_BIN, or `codex` on the PATH); tests point them
  // at a scripted model.
  constructor({ bin = process.env.CODEX_BIN || "codex", args = [], env = process.env, ...opts }) {
    super(opts);
    this.codex = { bin, args, env };
    this.calls = new Map(); // our request id -> { resolve, reject }
    this.nextId = 1;
    this.stage = "planning"; // "planning" until the plan is approved, then "building"
    this.turnId = null; // the turn in progress
    this.waiting = []; // what the user said while a turn couldn't take it, for the next turn
    this.streamed = new Set(); // agent messages whose text came as deltas
    this.turns = 0;
    // Codex connects to MCP servers in the background and fixes a turn's tools when it starts: the
    // first turn waits for the board. True once it's connected, false if it can't be.
    this.boardUp = new Promise((resolve) => (this.boardStarted = resolve));
  }

  async start() {
    const { model, effort } = settings();
    this.effort = effort;
    await this.trackRepo();
    const proc = spawn(
      this.codex.bin,
      [
        "app-server",
        ...this.codex.args,
        // This run's board, with only its update_board tool approved in advance.
        ...["-c", `mcp_servers.board.url=${toml(this.boardMcp.url)}`],
        ...["-c", `mcp_servers.board.bearer_token_env_var=${toml("WHITEBOARD_BOARD_TOKEN")}`],
        ...["-c", `mcp_servers.board.tools.update_board.approval_mode=${toml("approve")}`],
      ],
      { cwd: this.repo, env: { ...this.codex.env, WHITEBOARD_BOARD_TOKEN: this.boardMcp.token }, stdio: ["pipe", "pipe", "pipe"] },
    );
    this.proc = proc;
    proc.stdin.on("error", () => {}); // a write after Codex exited: the exit handler reports it
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
          continue;
        }
        this.onMessage(msg);
      }
    });
    let stderr = "";
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    const exited = new Promise((resolve) => {
      proc.on("error", (err) => resolve(err.code === "ENOENT" ? `Codex isn't installed: run \`npm i -g @openai/codex\` and \`codex login\`, or set CODEX_BIN.` : err.message));
      proc.on("exit", (code) => {
        // Its own error line, not the stack trace under it.
        const lines = stderr.replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
        const said = lines.findLast((l) => /^Error\b/.test(l)) ?? lines.findLast((l) => !/^\d+:|^Stack backtrace/.test(l)) ?? "";
        resolve(code ? `Codex exited (${code}): ${said}` : null);
      });
    });
    exited.then(async (why) => {
      this.exited = why ?? "exited";
      for (const { reject } of this.calls.values()) reject(new Error(why ?? "Codex exited"));
      this.calls.clear();
      if (why && !this.stopped) this.emit({ type: "error", message: why });
      await this.turnEnd;
      this.emit({ type: "closed" });
      this.recorder.close();
    });

    try {
      await this.call("initialize", { clientInfo: { name: "whiteboard", title: "Agent Whiteboard", version: "0.1.0" }, capabilities: null });
      this.notify("initialized");
      const { thread } = await this.call("thread/start", { cwd: this.repo, ...(model ? { model } : {}), approvalPolicy: "never", sandbox: "read-only", developerInstructions: CODEX_BOARD_INSTRUCTIONS });
      this.threadId = thread.id;
      // The agent's own session id: what a later run would resume from.
      this.recorder.update({ sessionId: thread.id });
      this.emit({ type: "stage", stage: "planning", model: model ?? "Codex's default", repo: this.repo });
      // (A Codex that doesn't report its MCP servers' startup gets 15 seconds.)
      if (!(await Promise.race([this.boardUp, new Promise((r) => setTimeout(r, 15000, true).unref())])) || this.stopped || this.exited) return;
      await this.turn(`${CODEX_PLAN_INSTRUCTIONS}\n\n${this.brief}`);
    } catch (err) {
      if (!this.stopped && !this.exited) this.emit({ type: "error", message: err.message }); // an exit says so itself
      this.halt();
    }
  }

  // ---- JSON-RPC ----
  send(msg) {
    if (this.proc?.stdin.writable) this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }
  call(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.calls.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }
  notify(method, params) {
    this.send(params === undefined ? { method } : { method, params });
  }

  onMessage(msg) {
    if (msg.id != null && !msg.method) {
      const call = this.calls.get(msg.id);
      this.calls.delete(msg.id);
      if (msg.error) call?.reject(new Error(msg.error.message ?? "Codex refused"));
      else call?.resolve(msg.result);
      return;
    }
    if (msg.id != null) return this.onRequest(msg).catch((err) => this.send({ id: msg.id, error: { code: -32000, message: err.message } }));
    this.onNotification(msg.method, msg.params ?? {});
  }

  // ---- turns ----
  async turn(message, { building = this.stage === "building" } = {}) {
    this.idle = false;
    this.turns++;
    const { turn } = await this.call("turn/start", { threadId: this.threadId, input: text(message), ...(building ? BUILDING : PLANNING), ...(this.effort ? { effort: this.effort } : {}) });
    this.turnId = turn.id;
  }

  // Something the user said: into the turn in progress, or a turn of its own.
  async say(message) {
    if (this.turnId) {
      try {
        await this.call("turn/steer", { threadId: this.threadId, input: text(message), expectedTurnId: this.turnId });
        return;
      } catch {
        // The turn ended meanwhile: it starts the next one.
      }
    }
    if (this.turnId) this.waiting.push(message);
    else await this.turn(message);
  }

  onNotification(method, p) {
    switch (method) {
      case "item/started":
        return this.itemStarted(p.item);
      case "item/agentMessage/delta":
        this.streamed.add(p.itemId);
        this.turnText += p.delta;
        return this.emit({ type: "text", text: p.delta });
      case "item/completed":
        return this.itemCompleted(p.item);
      case "turn/completed":
        return this.turnCompleted(p.turn);
      case "mcpServer/startupStatus/updated":
        if (p.name !== "board" || p.status === "starting") return;
        this.boardStarted(p.status === "ready");
        // Without the board Codex would only say update_board isn't there, and plan and build blind.
        if (p.status !== "ready" && !this.stopped) {
          this.emit({ type: "error", message: `Codex couldn't reach the board, so the run stopped (${boardError(p.error ?? p.status)}).` });
          this.stop({ reason: "board" });
        }
        return;
      case "error":
        if (!p.willRetry) this.emit({ type: "error", message: p.error?.message ?? "Codex reported an error" });
        return;
      default:
    }
  }

  itemStarted(item) {
    switch (item.type) {
      case "agentMessage":
        this.turnText += "\n\n";
        return this.emit({ type: "break" });
      case "commandExecution": {
        // Codex reads and searches through the shell; it says which commands are which.
        const a = item.commandActions?.length === 1 ? item.commandActions[0] : null;
        const activity =
          a?.type === "read" ? { kind: "read", label: rel(this.repo, a.path) }
          : a?.type === "search" || a?.type === "listFiles" ? { kind: "search", label: a.query ?? a.path ?? a.command }
          : { kind: "command", label: item.command };
        return this.emit({ type: "activity", toolUseId: item.id, ...activity });
      }
      case "fileChange":
        for (const c of item.changes ?? []) this.fileEdited(item.id, rel(this.repo, c.path), { write: c.kind?.type === "add" });
        return;
      default:
    }
  }

  itemCompleted(item) {
    switch (item.type) {
      case "agentMessage":
        // Without deltas (a model that doesn't stream), the whole message arrives here.
        if (!this.streamed.delete(item.id) && item.text) {
          this.turnText += item.text;
          this.emit({ type: "text", text: item.text });
        }
        return;
      case "commandExecution":
        this.scheduleChanges();
        if (item.status === "declined") return this.emit({ type: "activity-result", toolUseId: item.id, ok: false, summary: "Not run: declined" });
        return this.commandOutput(item.id, item.aggregatedOutput ?? "", item.status === "failed" || (item.exitCode ?? 0) !== 0);
      case "fileChange":
        return this.scheduleChanges();
      default:
    }
  }

  async turnCompleted(turn) {
    this.turnId = null;
    const ok = turn.status === "completed";
    // The planning turn's end is the plan: the gate, as Claude's ExitPlanMode is.
    if (this.stage === "planning" && ok && !this.stopped) {
      this.recordPlan("Proposed a plan");
      const answer = await this.ask({ type: "gate" });
      if (answer.stopped) return;
      if (answer.approve) {
        this.stage = "building";
        this.emit({ type: "stage", stage: "building" });
      }
      return this.turn(answer.message).catch((err) => this.emit({ type: "error", message: err.message }));
    }
    await this.finishTurn({ ok, why: turn.error?.message ?? turn.status, turns: this.turns });
    if (this.waiting.length && !this.stopped) this.turn(this.waiting.splice(0).join("\n\n")).catch((err) => this.emit({ type: "error", message: err.message }));
  }

  // ---- what Codex asks the user ----
  async onRequest({ id, method, params: p }) {
    const reply = (result) => this.send({ id, result });
    switch (method) {
      case "item/commandExecution/requestApproval": {
        if (this.allowCommands) return reply({ decision: "accept" });
        const a = await this.ask({ type: "permission", tool: "Bash", detail: p.command ?? "", description: p.reason ?? "" });
        return reply({ decision: a.stopped ? "cancel" : a.decision });
      }
      case "item/fileChange/requestApproval": {
        const a = await this.ask({ type: "permission", tool: "Edit", detail: p.grantRoot ? `Write under ${p.grantRoot}` : "Edit files", description: p.reason ?? "" });
        return reply({ decision: a.stopped ? "cancel" : a.decision });
      }
      case "mcpServer/elicitation/request":
        return reply({ action: "decline", content: null, _meta: null });
      case "item/tool/requestUserInput":
        return reply({ answers: {} });
      default:
        return this.send({ id, error: { code: -32601, message: `The whiteboard doesn't handle ${method}.` } });
    }
  }

  // ---- the user's side ----
  deliver(body, { state, edits, gate }) {
    switch (body.type) {
      case "approve":
        if (!gate) return false;
        return this.answer(gate, {
          approve: true,
          message: edits
            ? `The user approved the plan with these changes to the board:\n${edits}${state}\n\nApply them to the plan and the board with update_board, then build it.`
            : "The plan is approved. Build it now: phase implementation, then verification, as your instructions say.",
        });
      case "revise":
      case "chat": {
        const said = body.type === "chat" ? `The user says: ${body.text}` : `The user changed the board:\n${edits}`;
        if (gate) return this.answer(gate, { approve: false, message: `Not approved yet. ${said}${state}\n\nRevise the plan and the board with update_board to match, then end your turn.` });
        this.say(`${said}${state}`).catch((err) => this.emit({ type: "error", message: err.message }));
        this.emit({ type: "turn" });
        return true;
      }
      case "edits":
        this.say(`I changed the board:\n${edits}${state}\n\nRespond to these changes and update the code and the board to match.`).catch((err) => this.emit({ type: "error", message: err.message }));
        this.emit({ type: "turn" });
        return true;
      case "permission": {
        if (body.decision === "allow-all") this.allowCommands = true;
        const decision = body.decision === "allow" ? "accept" : body.decision === "allow-all" ? "acceptForSession" : "decline";
        return this.answer(body.requestId, { decision });
      }
      default:
        return false;
    }
  }

  halt() {
    const proc = this.proc;
    if (!proc || proc.exitCode != null) return;
    if (this.turnId) this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
    // A moment to stop the turn cleanly, then the process goes.
    setTimeout(() => proc.kill(), 500).unref();
  }
}
