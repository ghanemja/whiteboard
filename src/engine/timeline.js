import { DECISION, INK, MILESTONE, MUTED, PHASES, PROOF, YOU } from "./palette.js";

// The Timeline tab: how the thinking moved over a run. Your moves on top, test runs
// under them, one lane per decision (proposed → approved → changed, tied to what caused
// it → proven or failed → rejected), and the phases underneath. It reads the same timed
// event stream the server streams and records ({ t, type, … }); the demo synthesizes
// one. Pure functions, so `node --test` can run them on the saved recordings:
//
//   buildTimeline(events, model) → what happened when, and where on the axis it sits
//   timeToX(tl, t), xToTime(tl, x) → the time axis, long idle gaps compressed
//   drawTimeline(tl, { now })     → Excalidraw element skeletons, ids "tl:<part>:<…>"

export const TL = {
  X0: 220, // time starts here; the lane labels sit to the left of it
  WIDTH: 940, // the axis aims for about this width…
  PPS: [4, 14], // …at 4 to 14 px per second
  GAP: 15000, // idle longer than this (reading the plan, a pending permission)…
  BREAK: 46, // …is drawn this wide, with a break marker
  Y_YOU: 92, // your moves (their words sit above them, clear of the arrows below)
  Y_TESTS: 150,
  Y_LANES: 218,
  LANE: 64,
};

const NOW = "#f08c00";
const GRID = "#e9ecef";

export const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// The gist of what the user asked, for "changed because you said…" (the server's rule).
export const gist = (s) => {
  const t = String(s ?? "").replace(/^About [DQA]\d+ \(.*?\):\s*/s, "").replace(/\*\*/g, "").trim();
  return t.length > 140 ? `${t.slice(0, 139)}…` : t;
};
export function describeEdit(d) {
  switch (d.kind) {
    case "rename": return `Rename ${d.from} → ${d.to}`;
    case "remove": return `Remove ${d.name}`;
    case "add": return `Add ${d.name}`;
    case "link": return `Connect ${d.fromName} → ${d.toName}`;
    case "unlink": return `Disconnect ${d.fromName} → ${d.toName}`;
    case "note": return `Note “${d.text}”`;
    case "reject": return `Reject ${d.label} (${d.title})`;
    default: return d.kind ?? "";
  }
}

// A command that runs tests (the server's family of runners). Matched on the command,
// not on "test" alone, so `cat test/*.js` isn't a test run.
const TEST_CMD = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\bpytest\b|\bpython3?\s+-m\s+(pytest|unittest)\b|\b(jest|vitest|mocha)\b|\bgo\s+test\b|\bcargo\s+(test|nextest)\b|\bmake\s+(test|check)\b|\b(rspec|phpunit|tox|ctest)\b|\bdeno\s+test\b|\b(mvn|gradlew?)\s+test\b/;
// A result line only a test runner prints (TAP, node's spec reporter, Jest, pytest, go).
const TEST_LINE = /^(not )?ok \d+\b|^#\s*(pass|fail|tests|duration_ms)\b|^ℹ\s*(pass|fail|tests|duration_ms)\b|^[✔✓✖✕×]\s|\b\d+ (passed|failed)\b|^Tests:\s|^--- (PASS|FAIL)/;
// Recordings from before the server counted per-test results kept only a command's last
// line, so `npm test | grep …` "passed" with a test failing. The agent says so right after.
const SAYS_FAILED = /\b(tests?|assertions?|checks?|specs?|cases?)\b[^.!?\n]{0,80}?\b(fail(?:ed|s|ing)?|broke|broken|errored)\b|\b(fail(?:ed|s|ing)?|broke)\b[^.!?\n]{0,20}\btests?\b/i;
const NEGATED = /\b(no|none|nothing|zero|0|never|without|didn't|did not|doesn't|don't|won't)\b/i;
export const saysFailed = (text) => String(text ?? "").split(/(?<=[.!?])\s+|\n/).some((s) => SAYS_FAILED.test(s) && !NEGATED.test(s));

// Lifecycle noise: an idle or server stop after the run ended isn't part of the story.
const quiet = (e) => ["meta", "meta-update", "decision", "closed"].includes(e.type) || (e.type === "stopped" && e.reason !== "user");

export function buildTimeline(events = [], model = null) {
  const evs = events.filter((e) => e && Number.isFinite(e.t) && !quiet(e));
  const tl = { duration: 0, end: 0, pps: TL.PPS[1], segments: [], breaks: [], ticks: [], you: [], tests: [], lanes: [], phases: [], complete: null, approvals: [], changes: 0 };
  if (!evs.length) return tl;

  const byId = new Map();
  const cmds = new Map(); // toolUseId → { t, label } for every command
  const testOf = new Map(); // toolUseId → index in tl.tests
  let phase = null; // the board's phase, which decides proposed vs accepted
  let approved = false;
  let steer = null; // the You mark steering this turn: chat/revise/edits since the last gate or done
  let lastResult = null; // { t, i } of the latest test run's result
  let reading = null; // { i, text }: what the agent says after a test run (old recordings)

  const startEv = events.find((e) => e?.type === "start");
  const brief = startEv?.text ?? events.find((e) => e?.type === "meta")?.brief ?? "";
  tl.you.push({ t: 0, kind: "start", label: "start", text: brief, msg: startEv?.msg ?? null });

  const doneReading = () => {
    if (reading && saysFailed(reading.text)) Object.assign(tl.tests[reading.i], { ok: false, inferred: true });
    reading = null;
  };
  const point = (lane, t, mark) => {
    lane.path.push({ t, state: lane.state, approved, mark });
  };
  const mark = (lane, m) => {
    lane.marks.push(m);
    point(lane, m.t, lane.marks.length - 1);
    return lane.marks.length - 1;
  };
  const addTest = (id) => {
    const c = cmds.get(id);
    tl.tests.push({ t: c.t, ok: null, label: c.label, toolUseId: id });
    testOf.set(id, tl.tests.length - 1);
    return tl.tests.length - 1;
  };
  const closePhase = (t) => {
    const cur = tl.phases.at(-1);
    if (cur && cur.to == null) cur.to = t;
  };

  // What made a choice change: the server says (cause), or, for older recordings,
  // something you said this turn, else a check of it that had failed.
  const causeOf = (op, lane) => {
    const lastYou = () => [...tl.you].reverse().find((y) => ["chat", "revise", "edits"].includes(y.kind));
    if (op.cause === "you" || (!op.cause && steer)) {
      const y = steer ?? lastYou();
      return { who: "you", text: op.cause_text ?? gist(y?.text), you: y ? tl.you.indexOf(y) : null };
    }
    if (op.cause === "test" || (!op.cause && lane.proof === "fail")) {
      const k = lane.marks.findLastIndex((m) => m.kind === "proof" && m.proof === "fail");
      return { who: "test", text: op.cause_text ?? lane.marks[k]?.by ?? "", mark: k === -1 ? null : k, test: lane.marks[k]?.test ?? null };
    }
    return null;
  };

  const decision = (op, t) => {
    if (!op.id) return;
    let lane = byId.get(op.id);
    if (!lane) {
      if (!op.title && !op.chose) return; // an update to a decision that was never made
      const inPlanning = !phase || phase === "planning";
      const state = DECISION[op.state] ? op.state : inPlanning ? "proposed" : "accepted";
      lane = { id: op.id, n: tl.lanes.length + 1, title: op.title ?? op.id, chose: op.chose ?? "", state, proof: null, marks: [], path: [] };
      tl.lanes.push(lane);
      byId.set(op.id, lane);
      mark(lane, { t, kind: state, state, chose: lane.chose });
    } else {
      const changed = op.chose && op.chose !== lane.chose;
      if (changed) {
        const cause = causeOf(op, lane);
        const was = lane.chose;
        lane.chose = op.chose;
        lane.state = DECISION[op.state] ? op.state : "changed";
        lane.proof = null; // a new choice hasn't been checked yet
        mark(lane, { t, kind: "changed", state: lane.state, was, chose: op.chose, cause });
        tl.changes++;
      } else if (DECISION[op.state] && op.state !== lane.state) {
        lane.state = op.state;
        mark(lane, { t, kind: op.state, state: op.state });
      }
    }
    if (op.title) lane.title = op.title;
    // A rejected decision has nothing left to prove (the server doesn't tick those either).
    if (PROOF[op.proof] && op.proof !== lane.proof && lane.state !== "rejected") {
      // Ticked by the server from test output (older recordings didn't say so: a bare proof
      // landing right after a test run's result is one).
      const fromTests = !!op.fromTests || (!op.chose && !op.title && !!lastResult && t - lastResult.t <= 250);
      lane.proof = op.proof;
      mark(lane, { t, kind: "proof", state: lane.state, proof: op.proof, by: op.proof_by ?? "", fromTests, test: fromTests ? lastResult?.i ?? null : null });
    }
  };

  const user = (e) => {
    const i = tl.you.length;
    const edits = e.edits ?? [];
    const y = { t: e.t, kind: e.kind, label: "", text: e.text ?? "", edits: edits.length, msg: e.msg ?? null };
    switch (e.kind) {
      case "approve":
        y.label = edits.length ? `approved +${edits.length}` : "approved";
        break;
      case "chat": {
        const n = /^About D(\d+)\b/.exec(y.text)?.[1];
        const target = n && tl.lanes.find((l) => l.n === +n);
        if (target) y.target = target.id;
        const qa = /^About ([QA])(\d+)\b/.exec(y.text);
        y.label = target ? `challenged D${n}` : qa ? `${qa[1] === "Q" ? "answered" : "corrected"} ${qa[1]}${qa[2]}` : "said";
        break;
      }
      case "revise":
      case "edits":
        y.label = `${edits.length} edit${edits.length === 1 ? "" : "s"}`;
        y.text = edits.map(describeEdit).join("; ");
        break;
      case "permission":
        y.decision = e.decision;
        y.label = { allow: "allowed", "allow-all": "allowed all", deny: "denied" }[e.decision] ?? "answered";
        y.text = e.detail ?? "";
        break;
      default:
        y.label = e.kind ?? "";
    }
    tl.you.push(y);
    if (["chat", "revise", "edits"].includes(e.kind) || (e.kind === "approve" && edits.length)) steer = y;
    // Deleting a diamond on the board rejects it.
    for (const d of edits) {
      const lane = d.kind === "reject" && byId.get(d.decision);
      if (!lane || lane.state === "rejected") continue;
      lane.state = "rejected";
      mark(lane, { t: e.t, kind: "rejected", state: "rejected", cause: { who: "you", text: y.text, you: i } });
    }
    if (e.kind === "approve") {
      approved = true;
      tl.approvals.push({ t: e.t, you: i });
      for (const lane of tl.lanes) {
        if (lane.state === "rejected") continue;
        if (lane.state === "proposed") {
          lane.state = "accepted";
          mark(lane, { t: e.t, kind: "accepted", state: "accepted", you: i });
        } else point(lane, e.t, null); // a changed lane turns solid too
      }
    }
  };

  for (const e of evs) {
    switch (e.type) {
      case "op":
        if (e.op?.op === "decision") decision(e.op, e.t);
        else if (e.op?.op === "phase") {
          const key = e.op.name;
          if (key === "complete") {
            closePhase(e.t);
            tl.complete = e.t;
          } else if (PHASES.some((p) => p.key === key) && !(tl.phases.at(-1)?.to == null && tl.phases.at(-1)?.key === key)) {
            closePhase(e.t);
            tl.complete = null;
            // The run starts in plan mode, so planning begins with it.
            tl.phases.push({ key, from: !tl.phases.length && key === "planning" ? 0 : e.t, to: null });
          }
          phase = key;
        }
        break;
      case "user":
        doneReading();
        user(e);
        break;
      case "activity":
        doneReading();
        if (e.kind === "command") {
          cmds.set(e.toolUseId, { t: e.t, label: e.label ?? "" });
          if (TEST_CMD.test(e.label ?? "")) addTest(e.toolUseId);
        }
        break;
      case "activity-result": {
        let i = testOf.get(e.toolUseId);
        if (i == null && cmds.has(e.toolUseId) && (e.tests || TEST_LINE.test(e.summary ?? ""))) i = addTest(e.toolUseId);
        if (i == null) break;
        const k = tl.tests[i];
        k.t = e.t; // the tick sits where the result came back
        k.ok = e.ok !== false; // the server counts a failing test as a failed run
        if (e.tests) Object.assign(k, { pass: e.tests.pass, fail: e.tests.fail });
        else if (k.ok) reading = { i, text: "" };
        lastResult = { t: e.t, i };
        break;
      }
      case "text":
        if (reading && reading.text.length < 600) reading.text += e.text ?? "";
        break;
      case "gate":
      case "done":
        doneReading();
        steer = null;
        break;
      case "permission":
        doneReading();
        break;
      case "stopped":
        tl.you.push({ t: e.t, kind: "stop", label: "stopped", text: "" });
        break;
    }
  }
  doneReading();

  // ---- the time axis: linear, except idle gaps longer than TL.GAP ----
  const times = [...new Set([0, ...evs.map((e) => e.t)])].sort((a, b) => a - b);
  const end = times.at(-1);
  const gaps = [];
  let active = 0;
  for (let i = 1; i < times.length; i++) {
    const d = times[i] - times[i - 1];
    if (d > TL.GAP) gaps.push([times[i - 1], times[i]]);
    else active += d;
  }
  const pps = clamp((TL.WIDTH - gaps.length * TL.BREAK) / Math.max(1, active / 1000), ...TL.PPS);
  let x = TL.X0, from = 0;
  const seg = (a, b, w, gap) => {
    tl.segments.push({ from: a, to: b, x0: x, x1: x + w, gap });
    x += w;
  };
  for (const [a, b] of gaps) {
    seg(from, a, ((a - from) / 1000) * pps, false);
    seg(a, b, TL.BREAK, true);
    tl.breaks.push({ from: a, to: b });
    from = b;
  }
  seg(from, end, ((end - from) / 1000) * pps, false);
  Object.assign(tl, { duration: end, end, pps });

  // mm:ss ticks, at a step that leaves room for the labels, never inside a break.
  const step = ([5, 10, 15, 30, 60, 120, 300, 600, 900, 1800].find((s) => s * pps >= 70) ?? 3600) * 1000;
  const breakXs = tl.segments.filter((s) => s.gap).map((s) => (s.x0 + s.x1) / 2);
  for (const s of tl.segments) {
    if (s.gap) continue;
    for (let t = Math.ceil(s.from / step) * step; t <= s.to; t += step) {
      const tx = timeToX(tl, t);
      if (tl.ticks.length && tx - tl.ticks.at(-1).x < 56) continue;
      if (breakXs.some((bx) => Math.abs(bx - tx) < 50)) continue;
      tl.ticks.push({ t, x: tx, label: fmt(t) });
    }
  }

  closePhase(tl.complete ?? end);
  for (const lane of tl.lanes) lane.title = model?.decisions?.[lane.id]?.title ?? lane.title;
  return tl;
}

// Time (ms since the run started) → x on the canvas, and back.
export function timeToX(tl, t) {
  const segs = tl.segments;
  if (!segs.length) return TL.X0;
  if (t <= segs[0].from) return segs[0].x0;
  for (const s of segs) if (t <= s.to) return s.to === s.from ? s.x1 : s.x0 + ((t - s.from) / (s.to - s.from)) * (s.x1 - s.x0);
  return segs.at(-1).x1;
}

export function xToTime(tl, x) {
  const segs = tl.segments;
  if (!segs.length) return 0;
  if (x <= segs[0].x0) return segs[0].from;
  for (const s of segs) if (x <= s.x1) return s.x1 === s.x0 ? s.to : s.from + ((x - s.x0) / (s.x1 - s.x0)) * (s.to - s.from);
  return segs.at(-1).to;
}

// Where things sit vertically.
export const laneY = (i) => TL.Y_LANES + i * TL.LANE;
export const bandY = (tl) => (tl.lanes.length ? laneY(tl.lanes.length - 1) : TL.Y_LANES) + 46;

// ---- drawing: Excalidraw element skeletons ----
// Text that should be centered on a point carries `_c: [x, y]`; Board places it once
// the text is measured. `now` (ms) draws the now line; in a replay, what comes after
// it is faded, since the board hasn't got there yet.
export function drawTimeline(tl, { now = tl.end } = {}) {
  if (!tl.segments.length) return [];
  const sk = [];
  const lock = { locked: true };
  const after = (t) => now != null && t > now + 5;
  const fade = (t) => (after(t) ? { opacity: 28 } : {});
  const xEnd = Math.max(tl.segments.at(-1).x1, TL.X0 + 120);
  const nowX = now == null ? null : timeToX(tl, now);
  const band = bandY(tl);
  const bottom = band + 24;
  const text = (id, x, y, t, size, color, extra = {}) => ({ type: "text", id, x, y, text: t, fontSize: size, strokeColor: color, ...lock, ...extra });
  const line = (id, pts, st) => {
    const [x0, y0] = pts[0];
    return { type: "line", id, x: x0, y: y0, points: pts.map(([px, py]) => [px - x0, py - y0]), roughness: 1, strokeWidth: 1.5, ...lock, ...st };
  };
  const arrow = (id, pts, st) => ({ ...line(id, pts, st), type: "arrow", endArrowhead: "arrow", ...(pts.length > 2 ? { roundness: { type: 2 } } : {}) });
  const box = (id, x, y, w, h, st) => ({ type: "rectangle", id, x, y, width: w, height: h, roughness: 1, strokeWidth: 1.5, ...lock, ...st });
  const dia = (id, cx, cy, s, st, extra) => ({
    type: "diamond", id, x: cx - s / 2, y: cy - s / 2, width: s, height: s, strokeColor: st.stroke, backgroundColor: st.fill,
    fillStyle: "solid", strokeStyle: st.dash, strokeWidth: 2, roughness: 1, ...lock, ...extra,
  });
  const dot = (id, cx, cy, s, stroke, fill, glyph, glyphColor, extra = {}, size = 0.6) => [
    { type: "ellipse", id, x: cx - s / 2, y: cy - s / 2, width: s, height: s, strokeColor: stroke, backgroundColor: fill, fillStyle: "solid", strokeWidth: 1.5, roughness: 0, ...lock, ...extra },
    ...(glyph ? [text(`${id}:g`, cx, cy, glyph, Math.round(s * size), glyphColor, { ...extra, _c: [cx, cy] })] : []),
  ];
  // Marks that would overlap on one lane are nudged apart, never back in time.
  const spread = (ts, gap) => {
    let last = -Infinity;
    return ts.map((t) => (last = Math.max(timeToX(tl, t), last + gap)));
  };

  // Invisible: the whole drawing (so "fit" frames it while it grows), and a row per lane (what clicks land on).
  sk.push(box("tl:frame", -10, -6, Math.max(xEnd + 70, TL.X0 + TL.WIDTH + 40), bottom + 92, { strokeColor: "transparent", backgroundColor: "transparent", roughness: 0 }));
  tl.lanes.forEach((_, i) =>
    sk.push(box(`tl:r:${i}`, -6, laneY(i) - TL.LANE / 2 + 2, xEnd + 30, TL.LANE - 4, { strokeColor: "transparent", backgroundColor: "transparent", roughness: 0 })),
  );

  // ---- the axis: mm:ss ticks with faint gridlines, and compressed gaps ----
  sk.push(line("tl:x:axis", [[TL.X0, 32], [xEnd, 32]], { strokeColor: MUTED, strokeWidth: 1, roughness: 0, opacity: 60 }));
  for (const k of tl.ticks) {
    sk.push(line(`tl:x:${k.t}`, [[k.x, 27], [k.x, 37]], { strokeColor: MUTED, strokeWidth: 1, roughness: 0 }));
    sk.push(line(`tl:x:${k.t}:g`, [[k.x, 44], [k.x, bottom]], { strokeColor: GRID, strokeWidth: 1, roughness: 0 }));
    sk.push(text(`tl:x:${k.t}:t`, k.x, 6, k.label, 14, MUTED, { _c: [k.x, 15] }));
  }
  tl.segments.forEach((s, i) => {
    if (!s.gap) return;
    const cx = (s.x0 + s.x1) / 2;
    sk.push(line(`tl:b:${i}`, [[s.x0 + 6, 32], [cx - 6, 25], [cx + 6, 39], [s.x1 - 6, 32]], { strokeColor: MUTED, strokeWidth: 1.5 }));
    sk.push(line(`tl:b:${i}:g`, [[cx, 46], [cx, bottom]], { strokeColor: "#ced4da", strokeStyle: "dotted", strokeWidth: 1, roughness: 0 }));
    sk.push(text(`tl:b:${i}:t`, cx, 6, `⋯ ${fmt(s.to - s.from)}`, 12, MUTED, { _c: [cx, 15] }));
  });

  // ---- lane labels ----
  sk.push(
    { type: "ellipse", id: "tl:h:you:0", x: 19, y: TL.Y_YOU - 15, width: 12, height: 12, strokeColor: YOU.stroke, backgroundColor: YOU.fill, fillStyle: "solid", strokeWidth: 1.5, roughness: 1, ...lock },
    box("tl:h:you:1", 15, TL.Y_YOU - 1, 20, 14, { strokeColor: YOU.stroke, backgroundColor: YOU.fill, fillStyle: "solid", roundness: { type: 3 } }),
    text("tl:h:you:t", 46, TL.Y_YOU - 11, "You", 17, YOU.stroke),
    box("tl:h:tests:0", 16, TL.Y_TESTS - 12, 18, 23, { strokeColor: MUTED, backgroundColor: "#ffffff", fillStyle: "solid", roundness: { type: 3 } }),
    line("tl:h:tests:1", [[20, TL.Y_TESTS], [24, TL.Y_TESTS + 4], [30, TL.Y_TESTS - 5]], { strokeColor: PROOF.pass.color, strokeWidth: 2 }),
    text("tl:h:tests:t", 46, TL.Y_TESTS - 11, "Tests", 17, INK),
    text("tl:h:phases", 46, band + 1, "Phases", 15, MUTED),
  );
  for (const [id, y] of [["you", TL.Y_YOU], ["tests", TL.Y_TESTS]])
    sk.push(line(`tl:h:${id}:l`, [[TL.X0, y], [xEnd, y]], { strokeColor: "#dee2e6", strokeStyle: "dotted", strokeWidth: 1, roughness: 0 }));
  if (!tl.lanes.length) sk.push(text("tl:h:none", TL.X0, TL.Y_LANES - 10, "no decisions yet", 15, MUTED));

  // ---- the phase band ----
  let labelRight = -Infinity;
  tl.phases.forEach((p, i) => {
    const x0 = timeToX(tl, p.from), x1 = Math.max(timeToX(tl, p.to), x0 + 4);
    const open = i === tl.phases.length - 1 && tl.complete == null;
    const st = MILESTONE[open ? "current" : "done"];
    const ph = PHASES.find((q) => q.key === p.key);
    sk.push(box(`tl:p:${i}`, x0, band, x1 - x0 - 2, 22, { strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", roundness: { type: 3 }, strokeWidth: 1.5, ...fade(p.from) }));
    // Inside its segment when it fits; otherwise just under the band, after the previous one.
    const w = ph.short.length * 8 + 4;
    const inside = x1 - x0 >= w + 14;
    const lx = inside ? x0 + 8 : Math.max(x0, labelRight + 8);
    sk.push(text(`tl:p:${i}:t`, lx, inside ? band + 2 : band + 26, ph.short, 14, st.head, fade(p.from)));
    labelRight = lx + w;
  });
  if (tl.complete != null) {
    const fx = timeToX(tl, tl.complete) + 2, c = MILESTONE.done.stroke;
    sk.push(line("tl:p:flag", [[fx, band + 22], [fx, band - 16]], { strokeColor: c, strokeWidth: 2, ...fade(tl.complete) }));
    sk.push(line("tl:p:flag:f", [[fx, band - 16], [fx + 16, band - 11], [fx, band - 6], [fx, band - 16]], { strokeColor: c, backgroundColor: "#8ce99a", fillStyle: "solid", strokeWidth: 1.5, ...fade(tl.complete) }));
  }

  // ---- where the marks sit ----
  const youX = spread(tl.you.map((y) => y.t), 27);
  const testX = spread(tl.tests.map((k) => k.t), 26);
  const markX = tl.lanes.map((lane) => spread(lane.marks.map((m) => m.t), 31));

  // ---- decision lanes: the line between marks shows the state ----
  // Dashed while unapproved, purple when accepted, blue once changed; it stops when rejected.
  // Through a compressed gap it's dotted; past the now line it's faded.
  const gapXs = tl.segments.filter((s) => s.gap).map((s) => [s.x0, s.x1]);
  tl.lanes.forEach((lane, li) => {
    const y = laneY(li);
    const pts = lane.path.map((p) => ({ ...p, x: p.mark != null ? markX[li][p.mark] : timeToX(tl, p.t) }));
    pts.forEach((p, i) => i && (p.x = Math.max(p.x, pts[i - 1].x)));
    pts.forEach((p, i) => {
      if (p.state === "rejected") return;
      const xb = i + 1 < pts.length ? pts[i + 1].x : Math.max(xEnd, p.x);
      if (xb - p.x < 1) return;
      const st = DECISION[p.state] ?? DECISION.proposed;
      const dashed = p.state === "proposed" || !p.approved;
      const cuts = [p.x, xb, ...gapXs.flat(), ...(nowX != null ? [nowX] : [])].filter((c) => c >= p.x && c <= xb).sort((a, b) => a - b);
      for (let k = 0; k + 1 < cuts.length; k++) {
        const [a, b] = [cuts[k], cuts[k + 1]];
        if (b - a < 1) continue;
        const mid = (a + b) / 2;
        const inGap = gapXs.some(([g0, g1]) => mid > g0 && mid < g1);
        sk.push(line(`tl:ln:${li}:${i}:${k}`, [[a, y], [b, y]], {
          strokeColor: st.stroke, strokeWidth: 2, roughness: 0.6,
          strokeStyle: inGap ? "dotted" : dashed ? "dashed" : "solid",
          opacity: nowX != null && mid > nowX ? 28 : inGap ? 45 : 85,
        }));
      }
    });
  });

  // Approving the plan: a faint guide from your ✓ down to the lanes it made solid.
  for (const a of tl.approvals) {
    const lanes = tl.lanes.map((l, li) => [l, li]).filter(([l]) => l.marks.some((m) => m.kind === "accepted" && m.you === a.you));
    if (!lanes.length) continue;
    const x = youX[a.you];
    sk.push(line(`tl:a:${a.you}`, [[x, TL.Y_YOU + 13], [x, laneY(lanes.at(-1)[1]) - 9]], { strokeColor: DECISION.accepted.stroke, strokeStyle: "dotted", strokeWidth: 1, roughness: 0, opacity: 45, ...fade(a.t) }));
  }

  // ---- what caused what ----
  const conn = (id, pts, color, t, extra = {}) => sk.push(arrow(id, pts, { strokeColor: color, strokeWidth: 1.5, opacity: after(t) ? 22 : 70, ...extra }));
  // A challenge that changed several decisions at once: the arrow goes to the one you
  // asked about (or the first), and ripples from it to the rest.
  const groups = new Map();
  tl.lanes.forEach((lane, li) =>
    lane.marks.forEach((m, k) => {
      if (m.kind !== "changed" && m.kind !== "rejected") return;
      const c = m.cause;
      const at = [markX[li][k], laneY(li)];
      if (c?.who === "you" && c.you != null && tl.you[c.you]) {
        if (m.kind === "rejected") {
          const [ax, ay] = [youX[c.you], TL.Y_YOU + 12];
          conn(`tl:c:${li}:${k}`, [[ax, ay], [ax + 6, (ay + at[1]) / 2], [at[0] + 2, at[1] - 15]], YOU.stroke, m.t);
          return;
        }
        if (!groups.has(c.you)) groups.set(c.you, []);
        groups.get(c.you).push({ lane, li, k, m, at });
      } else if (c?.who === "test") {
        const from = c.mark != null ? [markX[li][c.mark], laneY(li)] : c.test != null ? [testX[c.test], TL.Y_TESTS] : null;
        if (!from) return;
        const [ax, ay] = from, [bx, by] = at;
        conn(`tl:c:${li}:${k}`, [[ax + 4, ay - 12], [(ax + bx) / 2, ay - 28], [bx - 5, by - 15]], PROOF.fail.color, m.t);
      }
    }),
  );
  for (const [yi, list] of groups) {
    const you = tl.you[yi];
    const first = list.find((g) => g.lane.id === you.target) ?? list[0];
    const [ax, ay] = [youX[yi], TL.Y_YOU + 12];
    const [bx, by] = first.at;
    conn(`tl:c:${first.li}:${first.k}`, [[ax + 3, ay], [ax + (bx - ax) * 0.25 + 4, (ay + by) / 2], [bx - 6, by - 15]], YOU.stroke, first.m.t);
    for (const g of list) {
      if (g === first) continue;
      const [gx, gy] = g.at;
      const bow = Math.max(gx, bx) + 34 + Math.abs(gy - by) * 0.08;
      conn(`tl:c:${g.li}:${g.k}`, [[bx + 15, by], [bow, (by + gy) / 2], [gx + 15, gy]], DECISION.changed.stroke, g.m.t, { strokeStyle: "dashed", strokeWidth: 1.25 });
    }
  }
  // A proof the test run ticked: a dotted tie up to that run.
  tl.lanes.forEach((lane, li) =>
    lane.marks.forEach((m, k) => {
      if (m.kind !== "proof" || m.test == null || testX[m.test] == null) return;
      const [x, y] = [markX[li][k], laneY(li)];
      sk.push(line(`tl:pl:${li}:${k}`, [[testX[m.test], TL.Y_TESTS + 12], [x, y - 13]], { strokeColor: PROOF[m.proof].color, strokeStyle: "dotted", strokeWidth: 1, roughness: 0, opacity: after(m.t) ? 18 : 50 }));
    }),
  );

  // ---- the now line, under the marks ----
  if (nowX != null) {
    sk.push(line("tl:now", [[nowX, 28], [nowX, bottom + 6]], { strokeColor: NOW, strokeWidth: 2, roughness: 0, opacity: 80 }));
    sk.push({ type: "ellipse", id: "tl:now:h", x: nowX - 5, y: 20, width: 10, height: 10, strokeColor: NOW, backgroundColor: NOW, fillStyle: "solid", strokeWidth: 1, roughness: 0, ...lock });
  }

  // ---- marks ----
  // You: a pink dot per move, with a glyph and a word or two.
  let rows = [-Infinity, -Infinity];
  tl.you.forEach((y, i) => {
    const x = youX[i], id = `tl:y:${i}`, f = fade(y.t);
    const deny = y.kind === "permission" && y.decision === "deny";
    const stroke = deny ? PROOF.fail.color : YOU.stroke;
    if (y.kind === "start") {
      sk.push(...dot(id, x, TL.Y_YOU, 22, stroke, YOU.fill, null, null, f));
      sk.push(line(`${id}:g`, [[x - 3, TL.Y_YOU - 5], [x + 5, TL.Y_YOU], [x - 3, TL.Y_YOU + 5], [x - 3, TL.Y_YOU - 5]], { strokeColor: YOU.stroke, backgroundColor: YOU.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0, ...f }));
    } else if (y.kind === "stop") {
      sk.push(...dot(id, x, TL.Y_YOU, 22, stroke, YOU.fill, null, null, f));
      sk.push(box(`${id}:g`, x - 4, TL.Y_YOU - 4, 8, 8, { strokeColor: YOU.stroke, backgroundColor: YOU.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0, ...f }));
    } else {
      const glyph = { approve: "✓", chat: y.target ? "?" : "…", revise: String(y.edits), edits: String(y.edits) }[y.kind] ?? (deny ? "✗" : y.decision === "allow-all" ? "$$" : "$");
      sk.push(...dot(id, x, TL.Y_YOU, 22, stroke, y.kind === "approve" ? YOU.stroke : YOU.fill, glyph, y.kind === "approve" ? "#ffffff" : stroke, f, glyph.length > 1 ? 0.5 : 0.62));
    }
    // A word or two above it, on a second row if the first is taken there, else none.
    const w = y.label.length * 7 + 6;
    const row = rows.findIndex((r) => x - w / 2 > r + 4);
    if (row !== -1 && y.label) {
      sk.push(text(`${id}:t`, x, 0, y.label, 13, YOU.stroke, { ...f, _c: [x, TL.Y_YOU - 22 - row * 15] }));
      rows[row] = x + w / 2;
    }
  });

  // Tests: ✓ or ✗ per run (a dashed ? while it's still running), with its count above when known.
  tl.tests.forEach((k, i) => {
    const x = testX[i], id = `tl:k:${i}`, f = fade(k.t);
    const p = k.ok == null ? null : PROOF[k.ok ? "pass" : "fail"];
    sk.push(...dot(id, x, TL.Y_TESTS, 22, p?.color ?? MUTED, p ? p.color : "transparent", p?.glyph ?? "?", p ? "#ffffff" : MUTED, { ...f, ...(p ? {} : { strokeStyle: "dashed" }) }));
    if (k.pass != null) sk.push(text(`${id}:t`, x, 0, `${k.pass}/${k.pass + k.fail}`, 12, p?.color ?? MUTED, { ...f, _c: [x, TL.Y_TESTS - 21] }));
  });

  // Decisions: the label, then each moment on its lane.
  tl.lanes.forEach((lane, li) => {
    const y = laneY(li);
    const st = DECISION[lane.state] ?? DECISION.proposed;
    sk.push(dia(`tl:l:${li}`, 25, y, 32, { ...st, dash: "solid" }));
    sk.push(text(`tl:l:${li}:n`, 25, y, `D${lane.n}`, 12, st.stroke, { _c: [25, y] }));
    sk.push(text(`tl:l:${li}:t`, 48, y - 11, clip(lane.title, 19), 16, lane.state === "rejected" ? MUTED : INK));
    lane.marks.forEach((m, k) => {
      const x = markX[li][k], id = `tl:m:${li}:${k}`, f = fade(m.t);
      if (m.kind === "proof") sk.push(...dot(id, x, y, 24, PROOF[m.proof].color, PROOF[m.proof].color, PROOF[m.proof].glyph, "#ffffff", f));
      else if (m.kind === "accepted") sk.push(dia(id, x, y, 16, DECISION.accepted, f));
      else sk.push(dia(id, x, y, 28, DECISION[m.kind] ?? DECISION.proposed, f));
    });
  });

  // ---- legend ----
  let lx = TL.X0;
  const ly = bottom + 54;
  const item = (key, shape, label) => {
    sk.push(...shape(`tl:g:${key}`, lx + 8, ly));
    sk.push(text(`tl:g:${key}:t`, lx + 22, ly - 9, label, 13, MUTED));
    lx += 22 + label.length * 7 + 22;
  };
  item("p", (id, x, y) => [dia(id, x, y, 16, DECISION.proposed)], "proposed");
  item("a", (id, x, y) => [dia(id, x, y, 16, DECISION.accepted)], "approved");
  item("c", (id, x, y) => [dia(id, x, y, 16, DECISION.changed)], "changed");
  item("r", (id, x, y) => [dia(id, x, y, 16, DECISION.rejected)], "rejected");
  item("v", (id, x, y) => dot(id, x, y, 16, PROOF.pass.color, PROOF.pass.color, "✓", "#ffffff"), "proven");
  item("f", (id, x, y) => dot(id, x, y, 16, PROOF.fail.color, PROOF.fail.color, "✗", "#ffffff"), "failed");
  item("y", (id, x, y) => dot(id, x, y, 16, YOU.stroke, YOU.fill), "you");
  item("i", (id, x, y) => [line(id, [[x - 8, y], [x + 8, y]], { strokeColor: MUTED, strokeStyle: "dotted", strokeWidth: 2, roughness: 0 })], "idle, shortened");
  return sk;
}
