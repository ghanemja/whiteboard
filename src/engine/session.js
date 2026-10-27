import { describeOp } from "./caption";
import { createStreamParser } from "./parser";
import { Player } from "./player";
import { Transcript } from "./transcript";
import { buildChatReply, buildEditsReply } from "../agent/replies";
import { controlRun, followRun, loadRecording, startRun } from "../agent/live";
import { BUILD_SCRIPT, DEMO_CHANGES, PLAN_SCRIPT } from "../agent/script";
import { areaOf, describeEdit, gist } from "./timeline";
import { receipt } from "./claims";

// Replays keep the run's rhythm but don't sit through long waits (thinking, or someone deciding).
const REPLAY_MAX_GAP = 1500;
const TIMELINE_EVERY = 200; // ms between Timeline redraws while events stream in
// Board edits as sent to the agent: without their dedupe key, with what they change.
const wire = (decisions) => decisions.map(({ key, ...d }) => ({ ...d, area: areaOf(d) }));

// Wires an agent to both surfaces: its words go to the transcript, its board ops
// go to the board, and each op is tied to the sentence it belongs to so the two
// stay linked (live highlight while it works, hover/click afterwards).
//
// mode "agent":  a real Claude Agent SDK run in a local repo (server/runs.js).
// mode "replay": a saved run played back from its recording (or opened at its end).
// mode "demo":   the scripted run, typed out by the Player, with scripted replies.
//
// stage "planning" -> the agent plans and then waits for approval; edits and chat revise the plan.
// stage "building" -> after approval: implement, verify, ship.
//
// Every mode also keeps the run as timed events ({ t, type, … }, the shape the server
// streams and records) for the Timeline: a live run's stream, a replay's recording, or,
// for the demo, events it synthesizes on a clock that runs at the playback speed.
export class Session {
  constructor({ board, onChange }) {
    this.board = board;
    this.onChange = onChange;
    // Every op the board has applied, in order, and who's watching: views pinned beside the
    // board redraw from these (null means the board was cleared).
    this.opLog = [];
    this.opWatchers = new Set();
    this.mode = "demo";
    this.stage = null; // null | "planning" | "building"
    this.gen = 0;
    this.live = new Map(); // highlight key -> Set of logical ids
    this.hover = [];
    this.raf = 0;
    this.caption = "";
    this.hideTimer = null;
    this.tlTimer = null;
    // The guided tour (tour.js) runs the demo as a lesson: App sets `tour` and `onHold`, which says
    // whether to pause at a checkpoint in the script (`held`) until you've done the step.
    this.tour = false;
    this.onHold = null;
    this.held = null;
    this.resetTimeline();
    this.resetAgent();

    this.transcript = new Transcript({
      onOpen: (s) => this.live.set(s.id, s.ids),
      onClose: (s) => this.linger(s.id),
      onChange: () => this.notify(),
      clock: () => this.now(),
    });

    // Demo: inline <board/> tags in typed-out text.
    this.parser = createStreamParser({
      onText: (t) => this.transcript.text(t),
      onOp: (attrs) => this.applyOp(attrs),
    });

    this.player = new Player({
      onStart: () => {
        this.parser.reset();
        this.transcript.startMessage("agent");
      },
      onChunk: (c) => this.parser.push(c),
      onEnd: () => {
        this.parser.end();
        this.transcript.endMessage();
      },
      onState: () => this.stateChanged(),
    });
  }

  resetAgent() {
    this.runId = null;
    this.follow?.abort();
    this.follow = null;
    this.agentBusy = false;
    this.workingSince = 0; // turn start, until the agent first says or does something
    this.gate = null; // pending plan approval request id
    this.permission = null; // pending permission request
    this.result = null; // last turn's { ok, cost, turns }
    this.recording = null; // the saved run being replayed: { id, brief, repo, project, … }
    this.brief = this.brief ?? "";
    this.repo = this.repo ?? "";
  }

  resetTimeline() {
    this.events = []; // the run so far, as timed events (agent, demo)
    this.replayT = 0; // a replay's position in its recording (ms)
    this.clock = null; // the demo's clock: { t, at }
    this.demoBusy = false;
    this.sentMsgs = []; // your messages waiting for the server to echo them as `user` events
    this.steerText = null; // what you asked this turn, for changes in recordings that don't say why
    this.failedSinceSteer = new Set(); // decisions whose check failed after that
    this.lastT = 0; // the latest live event's t
    this.changes = null; // the repo's actual changes this run, from git: path -> { path, add, del, patch }
    this.commits = 0; // commits made during the run
    this.demoRuns = 0;
    this.stickerTurn = false; // a turn answering sent stickers has started (stateChanged)
    this.held = null;
    this.denied = new Set(); // demo commands you denied: their runs don't happen
    this.allowAll = false;
  }

  // The repo's changes: a live run's `changes` events (a patch is only resent when it changed).
  setChanges(files, commits = this.commits) {
    const prev = this.changes ?? new Map();
    this.changes = new Map(files.map((f) => [f.path, { ...f, patch: f.patch ?? prev.get(f.path)?.patch ?? "" }]));
    this.commits = commits;
    this.board.setChanges([...this.changes.values()]);
  }

  // Where the run is now (ms since it started), whatever the mode.
  now() {
    if (this.replay) return this.replayT;
    return this.mode === "demo" ? this.demoNow() : this.lastT;
  }

  // What the run's record says about each sentence's claims (claims.js): sentence id -> receipt.
  // Test claims are checked against the runs before the sentence; file claims against git.
  receipts() {
    const acts = this.transcript.messages.flatMap((m) => m.items).filter((it) => it.type === "act");
    const base = {
      changes: this.changes ? [...this.changes.values()] : null,
      edited: acts.filter((a) => a.kind === "edit" || a.kind === "write").flatMap((a) => a.labels),
      commands: acts.filter((a) => a.kind === "command").flatMap((a) => a.labels),
    };
    const runs = (this.board.tl?.tests ?? []).filter((k) => k.ok != null);
    const out = new Map();
    for (const m of this.transcript.messages)
      for (const it of m.items) if (it.type === "s" && it.claims?.length) out.set(it.id, receipt(it.claims, { ...base, tests: runs.filter((k) => k.t <= it.t) }));
    return out;
  }

  // ---- the Timeline ----
  get timelineEvents() {
    const r = this.replay;
    return r ? (r.timeline ??= [{ t: 0, type: "start", text: this.brief }, ...r.events]) : this.events;
  }

  // Redraw soon: events can arrive a character at a time.
  timelineChanged() {
    if (!this.tlTimer) this.tlTimer = setTimeout(() => this.drawTimeline(), TIMELINE_EVERY);
  }

  drawTimeline() {
    clearTimeout(this.tlTimer);
    this.tlTimer = null;
    // A replay shows the whole recording, with the now line where the board is.
    this.board.redrawTimeline(this.timelineEvents, this.replay ? { now: this.replayT } : {});
    this.notify();
  }

  // The demo's own clock runs at the playback speed, so 4× draws like 1×.
  demoNow() {
    if (!this.clock) return 0;
    const now = performance.now();
    this.clock.t += (now - this.clock.at) * this.player.speed;
    this.clock.at = now;
    return Math.round(this.clock.t);
  }

  // The demo's own events.
  demoEvent(e) {
    if (this.mode !== "demo" || !this.clock) return;
    this.events.push({ ...e, t: this.demoNow() });
    this.timelineChanged();
  }

  // The demo has no repo and runs no commands, so its script carries what a live run's record would:
  //   <board op="diff" id="api"/>                   the files that step changed (DEMO_CHANGES)
  //   <board op="run" cmd="pytest -q" pass="42" fail="0" ok="true"/>   a test run and its result
  // and two that only do something in the tour (plain demo plays straight through them):
  //   <board op="tour" at="build"/>                 a checkpoint: pause here while the tour waits for you
  //   <board op="ask" cmd="pytest -q" why="…"/>     a command prompt, like a live run's (Allow / Deny)
  demoOp(a) {
    if (a.op === "tour") {
      if (this.tour && this.onHold?.(a.at)) {
        this.held = a.at;
        this.player.pause();
      }
      return true;
    }
    if (a.op === "ask") {
      if (!this.tour || this.allowAll) return true;
      this.permission = { requestId: `demo-ask-${this.demoRuns + 1}`, tool: "Bash", detail: a.cmd, description: a.why };
      this.demoEvent({ type: "permission", requestId: this.permission.requestId, tool: "Bash", detail: a.cmd });
      this.caption = "";
      this.player.pause();
      this.sync();
      return true;
    }
    if (a.op === "diff") {
      const files = new Map(this.changes ?? []);
      for (const f of DEMO_CHANGES[a.id] ?? []) files.set(f.path, f);
      this.setChanges([...files.values()]);
      this.sync();
      return true;
    }
    if (a.op === "run") {
      if (this.denied.has(a.cmd)) return true; // you said no: it doesn't run
      const toolUseId = `demo-run-${++this.demoRuns}`;
      const pass = +a.pass, fail = +a.fail;
      const ok = a.ok != null ? a.ok === "true" : fail === 0;
      const result = { toolUseId, ok, summary: `${pass} passed${fail ? `, ${fail} failed` : ""}`, tests: { pass, fail } };
      this.demoEvent({ type: "activity", kind: "command", label: a.cmd, toolUseId });
      this.transcript.activity({ kind: "command", label: a.cmd, toolUseId });
      this.demoEvent({ type: "activity-result", ...result });
      this.transcript.activityResult(result);
      this.caption = `Running ${a.cmd}`;
      this.sync();
      return true;
    }
    return false;
  }

  // An op the board applied (null: it was cleared), for the views pinned beside it.
  logOp(op, { apply = false } = {}) {
    if (apply) this.board.apply(op);
    if (op) this.opLog.push(op);
    else this.opLog = [];
    for (const watch of this.opWatchers) watch(op);
  }

  // ---- shared: applying ops and highlighting ----
  applyOp(attrs, { fromAgent = false } = {}) {
    if (!fromAgent && this.demoOp(attrs)) return;
    if (!fromAgent) this.demoEvent({ type: "op", op: attrs });
    this.caption = describeOp(attrs, this.board.model); // before apply: removals lose the name
    if (attrs.op === "phase") {
      this.transcript.phase(attrs.name);
      if (attrs.name !== "planning") this.stage = "building";
    }
    let ids = [];
    try {
      ids = this.board.apply(attrs);
      this.logOp(attrs);
    } catch (err) {
      console.warn("board op failed", attrs, err);
    }
    this.transcript.op(ids, { attachToLast: fromAgent });
    if (!this.instant) {
      this.board.pointAt(ids, 260 / this.player.speed);
      if (fromAgent) this.flash(ids);
    }
    this.sync();
  }

  // Keep a highlight up briefly (agent ops land between sentences, so nothing is "being written").
  flash(ids) {
    if (!ids.length) return;
    const key = `flash-${Math.random()}`;
    this.live.set(key, new Set(ids));
    this.linger(key);
  }

  linger(key) {
    const g = this.gen;
    setTimeout(() => {
      if (g !== this.gen) return;
      this.live.delete(key);
      this.sync();
    }, 1200);
  }

  stateChanged() {
    // The demo's turns: its plan waits for approval (a gate), its build ends (done).
    if (this.mode === "demo" && this.clock) {
      const busy = this.player.busy;
      if (this.demoBusy && !busy) this.demoEvent({ type: this.awaitingApproval ? "gate" : "done" });
      this.demoBusy = busy;
    }
    // Park the agent's cursor shortly after it stops working.
    clearTimeout(this.hideTimer);
    if (!this.state.busy) {
      this.caption = "";
      this.hideTimer = setTimeout(() => this.board.hideCursor(), 1800);
    }
    // In a replay the ⏸ still shows where the agent waited, though there's nothing to answer.
    this.board.setReviewTag(this.mode === "replay" ? !!this.gate : this.awaitingApproval);
    // Stickers are answered in the turn they start: once it's over, each has its answer beside it.
    if (this.board.stickers.size) {
      if (this.state.busy) this.stickerTurn = true;
      else if (this.stickerTurn) {
        this.stickerTurn = false;
        this.board.settleStickers(this.lastReply());
      }
    }
    this.notify();
  }

  // The start of the agent's last message: what a sticker it didn't answer on the board shows beside it.
  lastReply() {
    const m = this.transcript.messages.findLast((x) => x.role === "agent");
    const said = m?.items.filter((it) => it.type === "s").map((it) => it.text.trim()) ?? [];
    return said.slice(0, 2).join(" ").slice(0, 180);
  }

  // ---- starting over ----
  async reset() {
    const g = ++this.gen;
    if (this.runId) controlRun(this.runId, { type: "stop" }).catch(() => {});
    clearTimeout(this.replay?.timer);
    this.replay = null;
    this.resetAgent();
    this.player.stop();
    this.live.clear();
    this.hover = [];
    this.stage = null;
    this.resetTimeline();
    this.transcript.clear();
    this.board.reset();
    this.logOp(null);
    await this.board.init();
    if (g !== this.gen) return false;
    this.drawTimeline();
    this.board.fit(true);
    return true;
  }

  // The scripted demo, from a clean board. Pass fresh=true when the board is already clean.
  async startDemo({ fresh = false } = {}) {
    if (!fresh && !(await this.reset())) return;
    this.mode = "demo";
    this.stage = "planning";
    this.events = [];
    this.clock = { t: 0, at: performance.now() };
    this.demoEvent({ type: "start" });
    this.player.enqueue({ script: PLAN_SCRIPT });
  }

  // ---- a real agent run ----
  async startAgent({ repo, brief }) {
    if ((this.board.model.project || this.transcript.messages.length) && !(await this.reset())) return;
    const g = this.gen;
    this.mode = "agent";
    this.stage = "planning";
    this.brief = brief;
    this.repo = repo;
    const m = this.transcript.addUserMessage({ kind: "chat", text: brief });
    this.events = [{ t: 0, type: "start", text: brief, msg: m.id }];
    this.drawTimeline();
    this.beginTurn();
    try {
      const { id } = await startRun({ repo, brief });
      if (g !== this.gen) return controlRun(id, { type: "stop" }).catch(() => {});
      this.runId = id;
      this.follow = new AbortController();
      followRun(id, { onEvent: (e) => g === this.gen && this.onAgentEvent(e), signal: this.follow.signal }).catch((err) => {
        if (err.name !== "AbortError" && g === this.gen) this.agentError(err.message);
      });
    } catch (err) {
      this.agentError(err.message);
    }
  }

  // ---- a saved run ----
  // Plays a recording through the same event handler a live run uses. instant: jump
  // straight to the final board (reopen it) instead of watching it unfold.
  async startReplay(id, { instant = false } = {}) {
    if (!(await this.reset())) return;
    const g = this.gen;
    let events;
    try {
      events = await loadRecording(id);
    } catch (err) {
      return this.agentError(err.message);
    }
    if (g !== this.gen) return;
    const meta = {};
    for (const e of events) if (e.type === "meta" || e.type === "meta-update") Object.assign(meta, e);
    this.mode = "replay";
    this.stage = "planning";
    this.brief = meta.brief ?? "";
    this.repo = meta.repo ?? "";
    this.recording = { id, ...meta };
    this.transcript.addUserMessage({ kind: "chat", text: this.brief });
    this.replay = { events: events.filter((e) => !["meta", "meta-update", "decision"].includes(e.type)), i: 0, paused: false, done: false, timer: null };
    if (instant) {
      this.instant = true;
      while (this.replay.i < this.replay.events.length) this.onAgentEvent(this.replay.events[this.replay.i++]);
      this.instant = false;
      this.finishReplay();
      this.drawTimeline();
      this.board.fit(true);
    } else {
      this.beginTurn();
      this.replayStep();
    }
  }

  replayStep() {
    const r = this.replay;
    if (!r || r.paused || r.done) return;
    const e = r.events[r.i++];
    if (!e) return this.finishReplay();
    this.onAgentEvent(e);
    const next = r.events[r.i];
    if (!next) return this.finishReplay();
    const gap = Math.min(REPLAY_MAX_GAP, Math.max(0, (next.t ?? 0) - (e.t ?? 0)));
    r.timer = setTimeout(() => this.replayStep(), gap / this.player.speed);
  }

  // Jump a replay to t (ms into the recording) and pause there: back means re-applying from
  // the start (recordings are small), forward applies what's in between. Instantly, either way.
  async seekReplay(t) {
    const r = this.replay;
    if (!r) return;
    clearTimeout(r.timer);
    r.paused = true;
    if (t < this.replayT) {
      const g = ++this.gen;
      const view = this.board.view;
      this.live.clear();
      this.hover = [];
      this.transcript.clear();
      this.board.reset();
      this.logOp(null);
      this.board.view = view; // stay on the Timeline
      this.board.onPhase?.(null);
      await this.board.init();
      if (g !== this.gen || r !== this.replay) return;
      Object.assign(this, { stage: "planning", gate: null, permission: null, agentBusy: false, result: null, caption: "", steerText: null, replayT: 0, changes: null, commits: 0 });
      this.transcript.addUserMessage({ kind: "chat", text: this.brief });
      r.i = 0;
    }
    r.done = false;
    this.instant = true;
    while (r.i < r.events.length && (r.events[r.i].t ?? 0) <= t) this.onAgentEvent(r.events[r.i++]);
    this.instant = false;
    this.replayT = t;
    if (r.i >= r.events.length) this.finishReplay();
    else this.stateChanged();
    this.drawTimeline();
  }

  finishReplay() {
    if (!this.replay) return;
    this.replay.done = true;
    this.agentBusy = false;
    this.gate = null;
    this.permission = null;
    this.transcript.endMessage();
    this.stateChanged();
  }

  toggleReplay() {
    const r = this.replay;
    if (!r) return;
    if (r.done) return this.startReplay(this.recording.id);
    r.paused = !r.paused;
    clearTimeout(r.timer);
    if (!r.paused) this.replayStep();
    this.stateChanged();
  }

  beginTurn() {
    this.agentBusy = true;
    this.workingSince = Date.now();
    this.result = null;
    this.stateChanged();
  }

  // The agent's message bubble, opened on demand: a turn's words, ops and activity go into one.
  ensureMessage() {
    if (!this.transcript.cur) this.transcript.startMessage("agent");
    this.workingSince = 0;
  }

  onAgentEvent(e) {
    if (this.mode === "agent") {
      this.lastT = e.t ?? this.lastT;
      // Your messages come back from the server as `user` events; tie each to its bubble.
      this.events.push(e.type === "user" ? { ...e, msg: this.sentMsgs.shift() ?? null } : e);
      this.timelineChanged();
    } else if (this.mode === "replay") {
      this.replayT = e.t ?? this.replayT;
      this.timelineChanged();
    }
    switch (e.type) {
      case "stage":
        this.stage = e.stage;
        break;
      case "break":
        if (this.transcript.cur) this.transcript.text("\n\n");
        break;
      case "text":
        this.ensureMessage();
        this.transcript.text(e.text);
        break;
      case "op": {
        this.ensureMessage();
        // Recordings from before the server named causes: a choice that changes after you
        // asked for something this turn changed because of it, unless its check failed since
        // (as the Timeline reads it).
        let op = e.op;
        if (op?.op === "decision" && op.proof === "fail") this.failedSinceSteer.add(op.id);
        const prev = op?.op === "decision" && !op.cause && this.steerText && !this.failedSinceSteer.has(op.id) && this.board.model.decisions[op.id];
        if (prev && op.chose && op.chose !== prev.chose) op = { ...op, cause: "you", cause_text: this.steerText };
        this.applyOp(op, { fromAgent: true });
        break;
      }
      case "activity":
        this.ensureMessage();
        this.caption = `${{ read: "Reading", search: "Searching", edit: "Editing", write: "Writing", command: "Running" }[e.kind] ?? "Using"} ${e.label}`;
        this.transcript.activity(e);
        if (e.node && !this.instant) {
          this.board.pointAt([`node:${e.node}`]);
          this.flash([`node:${e.node}`]);
        }
        break;
      case "user": {
        if (["chat", "revise", "edits"].includes(e.kind) || (e.kind === "approve" && e.edits?.length)) {
          this.steerText = gist(e.text || e.edits.map(describeEdit).join("; "));
          this.failedSinceSteer = new Set();
        }
        // The user's side of the run. Live, the panel already shows it; a replay rebuilds it.
        if (this.mode !== "replay") break;
        this.transcript.endMessage(); // what the agent says next goes below this, as it did live
        const decisions = (e.edits ?? []).map((d, i) => ({ ...d, key: `r${this.replay?.i}-${i}` }));
        if (e.kind === "approve") {
          this.stage = "building";
          this.board.acceptDecisions();
          this.transcript.addUserMessage({ kind: "approve", decisions });
        } else if (e.kind === "chat") this.transcript.addUserMessage({ kind: "chat", text: e.text });
        else if (e.kind === "permission") this.transcript.addUserMessage({ kind: "permission", decision: e.decision, detail: e.detail });
        else this.transcript.addUserMessage({ kind: "edits", decisions });
        this.beginTurn();
        break;
      }
      case "activity-result":
        this.transcript.activityResult(e);
        break;
      case "changes":
        this.setChanges(e.files ?? [], e.commits ?? 0);
        break;
      case "gate":
        this.gate = e.requestId;
        this.agentBusy = false;
        this.steerText = null;
        this.transcript.endMessage();
        break;
      case "permission":
        this.permission = e;
        this.agentBusy = false;
        break;
      case "answered":
        if (this.gate === e.requestId) this.gate = null;
        if (this.permission?.requestId === e.requestId) this.permission = null;
        break;
      case "turn":
        this.beginTurn();
        break;
      case "done":
        this.agentBusy = false;
        this.steerText = null;
        this.result = e;
        this.transcript.endMessage();
        if (!e.ok) this.transcript.addNotice(`The agent stopped early (${e.message ?? "error"}).`);
        break;
      case "error":
        this.agentError(e.message);
        break;
      case "stopped":
        if (e.reason === "idle") {
          this.transcript.endMessage();
          this.transcript.addNotice(
            `The agent ${e.waitingOnUser ? "waited" : "sat idle"} ${e.minutes} minutes${e.waitingOnUser ? " for your answer" : ""} and stopped. Start over (↺) to run the task again; the repo keeps anything it already changed.`,
          );
        }
        break;
      case "closed":
        this.agentBusy = false;
        this.gate = null;
        this.permission = null;
        break;
    }
    this.stateChanged();
  }

  agentError(message) {
    this.agentBusy = false;
    this.transcript.endMessage();
    this.transcript.addNotice(message);
    this.stateChanged();
  }

  send(body) {
    if (!this.runId) return;
    controlRun(this.runId, { ...body, board_state: this.board.snapshot() }).catch((err) => this.agentError(err.message));
  }

  answerPermission(decision) {
    if (!this.permission) return;
    const { requestId, detail } = this.permission;
    this.permission = null;
    // Keep the answer in the conversation, where it happened.
    this.transcript.endMessage();
    const m = this.transcript.addUserMessage({ kind: "permission", decision, detail });
    if (this.mode === "demo") {
      // The tour's scripted prompt: carry on (a denied command just doesn't run).
      this.demoEvent({ type: "user", kind: "permission", decision, detail, msg: m.id });
      if (decision === "deny") this.denied.add(detail);
      if (decision === "allow-all") this.allowAll = true;
      this.transcript.startMessage("agent");
      if (decision === "deny") this.transcript.text(`You said no, so I won't run ${detail}. `);
      this.player.resume();
      return this.stateChanged();
    }
    this.sentMsgs.push(m.id);
    this.beginTurn();
    this.send({ type: "permission", requestId, decision });
  }

  stop() {
    if (this.mode !== "agent" || !this.runId) return;
    this.send({ type: "stop" });
    this.agentBusy = false;
    this.transcript.endMessage();
    this.transcript.addNotice("Stopped. The repo keeps whatever the agent already changed.");
    this.stateChanged();
  }

  // ---- the plan gate ----
  // The plan is done and nothing is running: the user's move.
  get awaitingApproval() {
    if (this.mode === "replay") return false;
    if (this.mode === "agent") return !!this.gate && !this.permission;
    return this.stage === "planning" && !this.player.busy && this.board.model.phase === "planning";
  }

  // Approve the plan, optionally with board edits the agent should fold in first.
  approve(decisions = []) {
    if (!this.awaitingApproval) return;
    this.stage = "building";
    this.board.setReviewTag(false);
    this.board.acceptDecisions();
    this.board.markSent(decisions);
    const m = this.transcript.addUserMessage({ kind: "approve", decisions });
    this.demoEvent({ type: "user", kind: "approve", edits: wire(decisions), msg: m.id });
    if (this.mode === "agent") {
      this.sentMsgs.push(m.id);
      this.gate = null;
      this.beginTurn();
      this.send({ type: "approve", edits: wire(decisions) });
    } else {
      if (decisions.length) this.player.enqueue({ build: () => buildEditsReply(decisions, this.board.model) });
      this.player.enqueue({ script: BUILD_SCRIPT });
    }
  }

  sendEdits(decisions) {
    this.board.markSent(decisions);
    const m = this.transcript.addUserMessage({ kind: "edits", decisions });
    this.demoEvent({ type: "user", kind: this.awaitingApproval ? "revise" : "edits", edits: wire(decisions), msg: m.id });
    if (this.mode === "agent") {
      this.sentMsgs.push(m.id);
      const edits = wire(decisions);
      const gated = !!this.gate;
      this.gate = null;
      this.beginTurn();
      this.send({ type: gated ? "revise" : "edits", edits });
    } else {
      // Build when it starts playing, so the reply sees the phase the agent is in by then.
      this.player.enqueue({ build: () => buildEditsReply(decisions, this.board.model) });
    }
  }

  sendChat(text) {
    const m = this.transcript.addUserMessage({ kind: "chat", text });
    this.demoEvent({ type: "user", kind: "chat", text, msg: m.id });
    if (this.mode === "agent") {
      this.sentMsgs.push(m.id);
      this.gate = null;
      this.beginTurn();
      this.send({ type: "chat", text });
    } else {
      this.player.enqueue({ build: () => buildChatReply(text) });
    }
  }

  // ---- its questions and assumptions ----
  // An answer goes to the agent as a message ("About Q1 (…): …"); at the plan gate that revises the plan.
  answerQuestion(q, text) {
    this.logOp({ op: "question", id: q.id, state: "answered", answer: text }, { apply: true });
    this.sendChat(`About Q${q.n} (${q.text}): ${text}`);
  }

  // A confirmed assumption needs no turn of its own: the agent sees it in the board state it gets next.
  confirmAssumption(q) {
    this.logOp({ op: "assumption", id: q.id, state: "confirmed" }, { apply: true });
    this.sync();
  }

  // Let the demo carry on from a tour checkpoint.
  release() {
    if (!this.held) return;
    this.held = null;
    if (!this.permission) this.player.resume();
  }

  // ---- highlights ----
  setHover(ids) {
    this.hover = ids;
    this.sync();
  }

  sync() {
    const all = new Set(this.hover);
    for (const ids of this.live.values()) ids.forEach((i) => all.add(i));
    this.board.setHighlights(all);
    this.notify(); // the phase header marks them too, and it's React
  }

  notify() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.onChange();
    });
  }

  get state() {
    const p = this.player;
    const busy = p.busy || this.agentBusy;
    const thinking = this.agentBusy && this.workingSince > 0;
    const r = this.replay;
    const replaying = !!r && !r.done;
    return {
      busy,
      paused: p.paused || (replaying && r.paused),
      playing: (busy && !p.paused) || (replaying && !r.paused),
      thinking: thinking && !this.replay, // a replay doesn't wait, so no live timer
      thinkingFor: thinking ? Math.floor((Date.now() - this.workingSince) / 1000) : 0,
      replaying,
    };
  }

  dispose() {
    this.gen++;
    if (this.runId) controlRun(this.runId, { type: "stop" }).catch(() => {});
    this.follow?.abort();
    this.player.stop();
    clearTimeout(this.hideTimer);
    clearTimeout(this.tlTimer);
    cancelAnimationFrame(this.raf);
  }
}
