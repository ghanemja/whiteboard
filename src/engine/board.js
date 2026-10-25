import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
} from "@excalidraw/excalidraw";

// Owns the board's Excalidraw scenes and keeps them pictures, not documents:
//   - Architecture: hand-drawn pictograms colored by status, connections, and the
//     numbered decision diamonds pinned to what they shape. The user edits this one.
//   - Why: each decision as a chain, evidence → decision → what it shapes → proof.
//     Derived from the model; redrawn whenever a decision or component changes.
// The phase journey (milestones + task dots) is drawn above both by PhaseHeader,
// from this.model. Words live in the panel; on the boards there are only short names.
//
// It also applies board ops from the agent, paints highlighter marks behind
// whatever the current sentence touched, and diffs the user's edits.

export const PHASES = [
  { key: "planning", label: "Planning", short: "Plan" },
  { key: "implementation", label: "Implementation", short: "Build" },
  { key: "verification", label: "Verification", short: "Verify" },
  { key: "deployment", label: "Deployment", short: "Ship" },
];

// Component status is color + a corner badge; no words.
export const STATUS = {
  planned: { stroke: "#868e96", fill: "#f8f9fa", dash: "dashed", badge: null },
  building: { stroke: "#e8590c", fill: "#fff3bf", dash: "solid", badge: "…" },
  built: { stroke: "#1971c2", fill: "#d0ebff", dash: "solid", badge: null },
  verified: { stroke: "#2f9e44", fill: "#d3f9d8", dash: "solid", badge: "✓" },
  failed: { stroke: "#e03131", fill: "#ffe3e3", dash: "solid", badge: "✗" },
  live: { stroke: "#6741d9", fill: "#e5dbff", dash: "solid", badge: "★" },
};

export const KINDS = ["client", "service", "data", "external", "queue", "test", "user"];

// Task dots and phase milestones, drawn by PhaseHeader.
export const TASK = {
  todo: { stroke: "#adb5bd", fill: "transparent" },
  building: { stroke: "#e8590c", fill: "#ffd8a8" },
  done: { stroke: "#2f9e44", fill: "#8ce99a" },
  failed: { stroke: "#e03131", fill: "#ffa8a8" },
};

export const MILESTONE = {
  future: { stroke: "#ced4da", fill: "#f8f9fa", dash: "dashed", width: 2, icon: "#adb5bd", head: "#adb5bd" },
  current: { stroke: "#f08c00", fill: "#fff3bf", dash: "solid", width: 3, icon: "#e8590c", head: "#e8590c" },
  done: { stroke: "#2f9e44", fill: "#d3f9d8", dash: "solid", width: 2, icon: "#2f9e44", head: "#2f9e44" },
};

// Scene geometry. Kept near the aspect of a typical board pane so "fit" stays readable.
const IW = 110, IH = 80; // pictogram size
const COL = 290, ROW = 180, NX0 = 55, NY0 = 90; // node grid (icon origin)
const NOTE_X = 860, NOTE_Y = 90;
const MARK = "hl-";
const AGENT = "agent-cursor"; // hashes to Excalidraw's purple cursor hue
const INK = "#1e1e1e";
const MUTED = "#868e96";

const rand = () => Math.floor(Math.random() * 2 ** 31);
const seedOf = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
};
const bump = (el, updates) => ({
  ...el,
  ...updates,
  version: el.version + 1,
  versionNonce: rand(),
  updated: Date.now(),
});
const firstLine = (t) => (t ?? "").split("\n")[0].trim();
// Ops arrive as JSON arrays (agent tool) or comma-separated strings (demo tags).
const list = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((s) => String(s).trim()).filter(Boolean);

// A technical decision is a diamond (the flowchart shape for a decision), numbered,
// pinned to the components it affects. Its reasoning is in the Plan tab.
const DECISION = {
  proposed: { stroke: "#6741d9", fill: "#f3f0ff", dash: "dashed" },
  accepted: { stroke: "#6741d9", fill: "#e5dbff", dash: "solid" },
  changed: { stroke: "#1971c2", fill: "#d0ebff", dash: "solid" },
  rejected: { stroke: "#adb5bd", fill: "#f1f3f5", dash: "dotted" },
};
const DW = 40; // diamond size

// Proof marks: a decision's check passed or failed (pending is a dashed "?").
const PROOF = {
  pass: { color: "#2f9e44", glyph: "✓" },
  fail: { color: "#e03131", glyph: "✗" },
};
const YOU = { stroke: "#c2255c", fill: "#ffdeeb" }; // the user, in the Why view's evidence
const WHY = "why:"; // element id prefix of the Why view
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// A line/polyline skeleton from absolute points. Closing it (last point = first)
// makes Excalidraw fill it, which is how the cloud and rocket get their shapes.
function poly(id, pts, style) {
  const [x, y] = pts[0];
  const rel = pts.map(([px, py]) => [px - x, py - y]);
  const xs = rel.map((p) => p[0]), ys = rel.map((p) => p[1]);
  return {
    type: "line", id, x, y, points: rel,
    width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys),
    ...style,
  };
}

// Hand-drawn pictogram for a component kind, in an IW x IH box at (ox, oy).
function iconParts(kind, ox, oy, s, pid) {
  let n = 0;
  const id = () => `${pid}:${n++}`;
  const shape = { strokeColor: s.stroke, backgroundColor: s.fill, fillStyle: "solid", strokeStyle: s.dash, strokeWidth: 2, roughness: 1 };
  const ink = { strokeColor: s.stroke, backgroundColor: "transparent", strokeStyle: "solid", strokeWidth: 2, roughness: 1 };
  const dot = { strokeColor: s.stroke, backgroundColor: s.stroke, fillStyle: "solid", strokeStyle: "solid", strokeWidth: 1, roughness: 1 };
  const rect = (x, y, w, h, st = shape, round = true) => ({ type: "rectangle", id: id(), x: ox + x, y: oy + y, width: w, height: h, roundness: round ? { type: 3 } : null, ...st });
  const ell = (x, y, w, h, st = shape) => ({ type: "ellipse", id: id(), x: ox + x, y: oy + y, width: w, height: h, ...st });
  const ln = (pts, st = ink, extra = {}) => poly(id(), pts.map(([x, y]) => [ox + x, oy + y]), { ...st, ...extra });
  const curved = { roundness: { type: 2 } };

  switch (kind) {
    case "client": // browser window
      return [
        rect(0, 0, 110, 80),
        ln([[0, 20], [110, 20]]),
        ell(8, 7, 7, 7, dot), ell(20, 7, 7, 7, dot), ell(32, 7, 7, 7, dot),
        ln([[16, 40], [84, 40]]),
        ln([[16, 56], [64, 56]]),
      ];
    case "data": // database cylinder
      return [
        ell(0, 56, 110, 24),
        rect(0, 12, 110, 56, { ...shape, strokeColor: "transparent" }, false),
        ln([[0, 12], [0, 68]], { ...ink, strokeStyle: s.dash }),
        ln([[110, 12], [110, 68]], { ...ink, strokeStyle: s.dash }),
        ln([[0, 36], [55, 48], [110, 36]], ink, curved),
        ell(0, 0, 110, 24),
      ];
    case "external": // cloud
      return [
        ln([[18, 74], [4, 60], [8, 44], [24, 36], [30, 18], [50, 8], [70, 12], [82, 26], [98, 28], [108, 44], [104, 62], [90, 74], [18, 74]], shape, curved),
      ];
    case "queue": // messages waiting in a pipe
      return [
        rect(0, 22, 110, 38),
        ...[0, 1, 2, 3].map((i) => rect(8 + i * 25, 29, 19, 24, { ...shape, strokeWidth: 1, strokeStyle: "solid" })),
      ];
    case "test": // clipboard of checks
      return [
        rect(10, 6, 90, 74),
        rect(38, 0, 34, 12, dot),
        ...[0, 1, 2].flatMap((i) => [
          ln([[22, 30 + i * 17], [26, 35 + i * 17], [34, 25 + i * 17]]),
          ln([[44, 30 + i * 17], [88, 30 + i * 17]]),
        ]),
      ];
    case "user": // person
      return [ell(40, 0, 30, 30), rect(22, 34, 66, 46)];
    default: // service: server rack
      return [0, 1, 2].flatMap((i) => [
        rect(0, i * 28, 110, 24),
        ell(92, i * 28 + 8.5, 7, 7, dot),
        ln([[12, i * 28 + 12], [48, i * 28 + 12]]),
      ]);
  }
}

// A component pictogram shrunk by k, for the Why view.
function miniIcon(kind, ox, oy, s, pid, k = 0.4) {
  return iconParts(kind, 0, 0, s, pid).map((e) => ({
    ...e,
    x: ox + e.x * k, y: oy + e.y * k, width: e.width * k, height: e.height * k,
    ...(e.points ? { points: e.points.map(([px, py]) => [px * k, py * k]) } : {}),
    strokeWidth: Math.max(1, (e.strokeWidth ?? 2) * 0.75),
  }));
}

// Small evidence pictograms, 22x28 at (x, y): a file from the repo, a fact (a note), or a person (you).
function pageIcon(pid, x, y, color = MUTED) {
  const ink = { strokeColor: color, strokeWidth: 1.5, roughness: 1 };
  return [
    poly(`${pid}:0`, [[x, y], [x + 15, y], [x + 22, y + 7], [x + 22, y + 28], [x, y + 28], [x, y]], { ...ink, backgroundColor: "#ffffff", fillStyle: "solid" }),
    poly(`${pid}:1`, [[x + 15, y], [x + 15, y + 7], [x + 22, y + 7]], ink),
  ];
}
function noteIcon(pid, x, y, color = MUTED) {
  const ink = { strokeColor: color, strokeWidth: 1.5, roughness: 1 };
  return [
    { type: "rectangle", id: `${pid}:0`, x, y: y + 3, width: 22, height: 22, roundness: { type: 3 }, ...ink, backgroundColor: "#fff9db", fillStyle: "solid" },
    poly(`${pid}:1`, [[x + 5, y + 11], [x + 17, y + 11]], ink),
    poly(`${pid}:2`, [[x + 5, y + 17], [x + 13, y + 17]], ink),
  ];
}
function personIcon(pid, x, y) {
  const st = { strokeColor: YOU.stroke, backgroundColor: YOU.fill, fillStyle: "solid", strokeWidth: 1.5, roughness: 1 };
  return [
    { type: "ellipse", id: `${pid}:0`, x: x + 5, y, width: 12, height: 12, ...st },
    { type: "rectangle", id: `${pid}:1`, x: x + 1, y: y + 14, width: 20, height: 14, roundness: { type: 3 }, ...st },
  ];
}
// A filled ✓/✗ circle, or a dashed "?" when there's no result yet. Returns [skeletons, glyph id].
function proofMark(pid, x, y, size, proof) {
  const p = PROOF[proof];
  const c = p?.color ?? MUTED;
  return [
    [
      { type: "ellipse", id: pid, x, y, width: size, height: size, strokeColor: c, backgroundColor: p ? c : "transparent", fillStyle: "solid", strokeStyle: p ? "solid" : "dashed", strokeWidth: p ? 1 : 1.5, roughness: 0 },
      { type: "text", id: `${pid}:g`, x, y, text: p?.glyph ?? "?", fontSize: Math.round(size * 0.55), strokeColor: p ? "#ffffff" : MUTED },
    ],
    `${pid}:g`,
  ];
}

// Where a line from the element's center along (dx, dy) leaves its outline.
function edgePoint(el, dx, dy, gap) {
  const hw = el.width / 2, hh = el.height / 2;
  const t =
    el.type === "ellipse"
      ? 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2)
      : Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  const len = Math.hypot(dx, dy) || 1;
  return [el.x + hw + dx * t + (dx / len) * gap, el.y + hh + dy * t + (dy / len) * gap];
}

export class Board {
  // api: the Architecture canvas; whyApi: the Why canvas.
  constructor(api, { whyApi, onPhase } = {}) {
    this.api = api;
    this.whyApi = whyApi;
    this.onPhase = onPhase;
    this.reset();
  }

  reset() {
    this.model = { project: "", goal: null, phase: null, slots: {}, tasks: {}, nodes: {}, edges: {}, notes: [], decisions: {} };
    this.known = new Set();
    this.hl = new Set();
    this.hlSig = "";
    this.whyHlSig = "";
    this.noteSlot = 0;
    this.reviewing = false;
    this.view = "board"; // which canvas is showing: "board" (architecture) or "why"
    this.whyRows = 0; // decisions drawn on the Why canvas, to refit it when one is added
    this.hideCursor();
  }

  // ---- scene helpers ----
  scene() {
    return [...this.api.getSceneElementsIncludingDeleted()];
  }
  commit(elements) {
    this.api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  }
  convert(skeletons) {
    return convertToExcalidrawElements(skeletons, { regenerateIds: false });
  }
  remember(els) {
    els.forEach((e) => this.known.add(e.id));
    return els;
  }
  // Insert new elements, or replace same-id ones in place (keeping their stacking and wobble).
  upsert(els, fresh) {
    for (const f of fresh) {
      const i = els.findIndex((e) => e.id === f.id);
      if (i === -1) els.push(f);
      else els[i] = { ...f, seed: els[i].seed, index: els[i].index, version: els[i].version + 1 };
      this.known.add(f.id);
    }
    return els;
  }
  // Swap every element matching `mine` for `fresh`, at the same depth, keeping
  // each surviving id's wobble (seed) and arrow bindings. On the Why canvas with api = this.whyApi.
  replace(mine, fresh, api = this.api) {
    if (api !== this.api) {
      const old = new Map(api.getSceneElementsIncludingDeleted().map((e) => [e.id, e]));
      for (const f of fresh) if (old.has(f.id)) f.seed = old.get(f.id).seed;
      api.updateScene({ elements: fresh, captureUpdate: CaptureUpdateAction.NEVER });
      return;
    }
    const els = this.scene();
    const old = new Map(els.filter(mine).map((e) => [e.id, e]));
    for (const f of fresh) {
      const o = old.get(f.id);
      if (!o) continue;
      f.seed = o.seed;
      f.version = o.version + 1;
      const arrows = (o.boundElements || []).filter((b) => b.type === "arrow");
      if (arrows.length) f.boundElements = [...(f.boundElements || []).filter((b) => b.type !== "arrow"), ...arrows];
    }
    const at = els.findIndex(mine);
    const rest = els.filter((e) => !mine(e));
    rest.splice(at === -1 ? rest.length : at, 0, ...fresh);
    this.remember(fresh);
    this.commit(rest);
  }
  nodeByEl(elId) {
    if (!elId) return null;
    return Object.values(this.model.nodes).find((n) => elId === n.elId || elId.startsWith(`${n.elId}:`));
  }

  // ---- chrome ----
  // Text is measured when it's created, so wait for the hand-drawn font first;
  // otherwise it gets sized with a fallback font and renders clipped.
  async init() {
    try {
      await document.fonts.load("24px Excalifont", "Plan Build Verify Ship ✓✗★…");
    } catch {
      /* fall back to whatever font is available */
    }
    // Invisible frame over the whole grid, so "fit" frames the finished board even while it's still empty.
    const frame = {
      type: "rectangle", id: "frame", x: -30, y: 0, width: NOTE_X + 240 + 30, height: NY0 + 2 * ROW + IH + 60,
      strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0, locked: true,
    };
    this.commit(this.remember(this.convert([frame])));
    this.whyApi?.updateScene({ elements: [], captureUpdate: CaptureUpdateAction.NEVER });
  }

  // Frame both canvases on their content.
  fit(animate = false) {
    this.api.scrollToContent(this.api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.94, animate });
    this.fitWhy(animate);
  }

  fitWhy(animate = false) {
    const els = this.whyApi?.getSceneElements() ?? [];
    if (els.length) this.whyApi.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.9, animate });
  }

  // Which canvas is showing. The cursor, highlights and "scroll to" follow it.
  setView(view) {
    this.hideCursor();
    this.view = view === "why" ? "why" : "board";
    this.refreshMarkers();
  }

  // ---- agent cursor: an Excalidraw collaborator that glides to whatever the agent touches ----
  // On the canvas that's showing: decisions have a place on both, everything else only on Architecture.
  pointAt(lids, ms = 260) {
    const why = this.view === "why";
    const api = why ? this.whyApi : this.api;
    if (!api) return;
    const els = api.getSceneElements();
    let target = null;
    for (const lid of lids) {
      const id = why ? this.whyElementFor(lid) : this.elementFor(lid);
      target = id && els.find((e) => e.id === id);
      if (target) break;
    }
    if (!target) return;
    const [x1, y1, x2, y2] = getCommonBounds([target]);
    const to =
      target.type === "text"
        ? { x: x2 + 4, y: (y1 + y2) / 2 }
        : target.type === "arrow"
          ? { x: (x1 + x2) / 2, y: (y1 + y2) / 2 }
          : { x: x1 + (x2 - x1) * 0.66, y: y1 + (y2 - y1) * 0.72 };
    const from = this.cursor ?? { x: to.x - 60, y: to.y + 50 };
    cancelAnimationFrame(this.cursorRaf);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      this.cursor = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
      api.updateScene({
        collaborators: new Map([[AGENT, { id: AGENT, username: "Agent", pointer: { ...this.cursor, tool: "pointer" } }]]),
      });
      if (k < 1) this.cursorRaf = requestAnimationFrame(step);
    };
    this.cursorRaf = requestAnimationFrame(step);
  }

  hideCursor() {
    cancelAnimationFrame(this.cursorRaf);
    if (!this.cursor) return;
    this.cursor = null;
    this.api.updateScene({ collaborators: new Map() });
    this.whyApi?.updateScene({ collaborators: new Map() });
  }

  // ---- ops ----
  apply(a) {
    switch (a.op) {
      case "project": return this.setTitle(a.name, a.goal);
      case "decision": return this.setDecision(a);
      case "phase": return this.setPhase(a.name);
      case "task": return this.setTask(a);
      case "node": return this.addNode(a);
      case "edge": return this.addEdge(a);
      case "status": return this.setStatus(a.id, a.v);
      case "rename": return this.rename(a.id, a.name);
      case "note": return this.addNote(a.text);
      case "remove": return this.remove(a.id);
      case "unlink": return this.unlink(a.from, a.to);
      case "adopt": return this.adopt(a);
      case "adopt-edge": return this.adoptEdge(a);
      case "adopt-note": return this.adoptNote(a.el);
      default:
        console.warn("unknown board op", a);
        return [];
    }
  }

  // The project's name and goal, the phases and the tasks head the board (PhaseHeader draws
  // them from the model), so these only update the model.
  setTitle(name, goal) {
    if (goal) this.model.goal = goal;
    if (name) this.model.project = name;
    return name || goal ? ["title"] : [];
  }

  setPhase(key) {
    if (key !== "complete" && !PHASES.some((p) => p.key === key)) return [];
    this.model.phase = key;
    this.reviewing = false;
    this.onPhase?.(key);
    return [`phase:${key}`];
  }

  // ⏸ on the current milestone while the agent waits for the plan's approval.
  setReviewTag(on) {
    if (this.model.phase) this.reviewing = on;
  }

  setTask({ id, phase, text, status }) {
    const m = this.model;
    let t = m.tasks[id];
    if (!t) {
      if (!id || !text) return []; // an update to a task that was never created
      const valid = (k) => PHASES.some((p) => p.key === k);
      const ph = valid(phase) ? phase : valid(m.phase) ? m.phase : m.phase === "complete" ? "deployment" : "planning";
      m.slots[ph] = m.slots[ph] ?? 0;
      t = m.tasks[id] = { id, phase: ph, text, status: TASK[status] ? status : "todo", slot: m.slots[ph]++ };
    } else {
      if (text) t.text = text;
      if (TASK[status]) t.status = status;
    }
    return [`task:${id}`];
  }

  // ---- components ----
  // The requested grid cell if it's free, otherwise the first free one (models do collide).
  freeCell(col, row) {
    const taken = new Set(Object.values(this.model.nodes).filter((n) => n.cell).map((n) => n.cell.join()));
    const clamp = (v) => Math.max(0, Math.min(2, Number.isFinite(+v) ? Math.round(+v) : 0));
    const want = [clamp(col), clamp(row)];
    if (!taken.has(want.join())) return want;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!taken.has(`${c},${r}`)) return [c, r];
    const n = taken.size - 9; // grid full: spill below
    return [n % 3, 3 + Math.floor(n / 3)];
  }

  // Compact board description sent to the model with every turn.
  snapshot() {
    const m = this.model;
    const nodes = Object.values(m.nodes).map(({ id, name, kind, status, cell, libs, api }) => ({
      id, name, kind, status, ...(cell ? { col: cell[0], row: cell[1] } : {}), ...(libs?.length ? { libs } : {}), ...(api?.length ? { api } : {}),
    }));
    const taken = new Set(nodes.filter((n) => "col" in n).map((n) => `${n.col},${n.row}`));
    const free_cells = [];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) if (!taken.has(`${c},${r}`)) free_cells.push({ col: c, row: r });
    return {
      project: m.project || null,
      goal: m.goal || null,
      phase: m.phase,
      nodes,
      edges: Object.values(m.edges).map(({ from, to, via, api }) => ({ from, to, ...(via ? { via } : {}), ...(api ? { api } : {}) })),
      decisions: Object.values(m.decisions).map(({ id, title, chose, over, why, affects, state, verify, proof }) => ({
        id, title, chose, over, why, affects, state, ...(verify ? { verify } : {}), ...(proof ? { proof } : {}),
      })),
      tasks: Object.values(m.tasks).map(({ id, phase, text, status }) => ({ id, phase, text, status })),
      free_cells,
      notes: m.notes.length,
    };
  }

  // A component: an invisible hit-box (what arrows bind to and selection grabs),
  // the pictogram, its name underneath, and a status badge, all in one group.
  drawNode(node, ox, oy, labelText) {
    const s = STATUS[node.status] ?? STATUS.planned;
    const pid = node.elId;
    const sk = [
      { type: "rectangle", id: pid, x: ox - 10, y: oy - 10, width: IW + 20, height: IH + 62, strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0 },
      ...iconParts(node.kind, ox, oy, s, pid),
      { type: "text", id: `${pid}:label`, x: ox, y: oy + IH + 8, text: labelText ?? node.name, fontSize: 18, strokeColor: INK },
    ];
    // The main library, small and grey under the name; the full stack is in the Plan tab.
    const libs = node.libs ?? [];
    if (libs.length) {
      const first = libs[0].length > 18 ? `${libs[0].slice(0, 17)}…` : libs[0];
      sk.push({ type: "text", id: `${pid}:libs`, x: ox, y: oy + IH + 31, text: libs.length > 1 ? `${first} +${libs.length - 1}` : first, fontSize: 13, strokeColor: MUTED });
    }
    const bx = ox + IW - 14, by = oy - 14;
    if (s.badge) {
      sk.push({ type: "ellipse", id: `${pid}:badge`, x: bx, y: by, width: 28, height: 28, strokeColor: s.stroke, backgroundColor: s.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
      sk.push({ type: "text", id: `${pid}:badge-t`, x: bx, y: by, text: s.badge, fontSize: 17, strokeColor: "#ffffff" });
    }
    const out = this.convert(sk);
    const group = [`g:${pid}`];
    for (const e of out) {
      e.groupIds = group;
      if (e.id === `${pid}:label` || e.id === `${pid}:libs`) e.x = ox + IW / 2 - e.width / 2;
      if (e.id === `${pid}:badge-t`) {
        e.x = bx + 14 - e.width / 2;
        e.y = by + 14 - e.height / 2;
      }
    }
    return out;
  }

  addNode({ id, name, kind = "service", col = 0, row = 0, status, v, libs, api, paths }) {
    if (!id) return [];
    const existing = this.model.nodes[id];
    if (existing) {
      // Repeating a node op fills in its details (libraries, APIs, files) as the agent learns them.
      if (libs != null) existing.libs = list(libs);
      if (api != null) existing.api = list(api);
      if (paths != null) existing.paths = list(paths);
      if (libs != null) this.redrawNode(id);
      return [`node:${id}`];
    }
    if (!name) return [];
    const cell = this.freeCell(col, row);
    const st = STATUS[v] ? v : STATUS[status] ? status : "planned";
    const node = {
      id, name, kind: KINDS.includes(kind) ? kind : "service", status: st, elId: `node-${id}`, cell,
      libs: list(libs), api: list(api), paths: list(paths),
    };
    this.model.nodes[id] = node;
    const fresh = this.remember(this.drawNode(node, NX0 + cell[0] * COL, NY0 + cell[1] * ROW));
    this.commit([...this.scene(), ...fresh]);
    // Decisions about it, made before it was drawn, can pin to it now (and the Why view moves down if it must).
    if (Object.keys(this.model.decisions).length) this.redrawDecisions();
    return [`node:${id}`];
  }

  // Redraw a node for its current name/status where it currently sits. `at` places
  // it explicitly (used when adopting a shape the user drew).
  redrawNode(nodeId, at) {
    const node = this.model.nodes[nodeId];
    if (!node) return;
    const els = this.scene();
    const main = els.find((e) => e.id === node.elId);
    if (!main || main.isDeleted) return;
    const ox = at?.ox ?? main.x + 10, oy = at?.oy ?? main.y + 10;
    // Keep a rename the user typed but hasn't sent yet.
    const label = els.find((e) => e.id === `${node.elId}:label` && !e.isDeleted);
    const pending = label && firstLine(label.text) !== node.name ? label.text : undefined;
    const mine = (e) => e.id === node.elId || e.id.startsWith(`${node.elId}:`) || e.containerId === node.elId;
    this.replace(mine, this.drawNode(node, ox, oy, pending));
    // Decisions pinned to this component follow it if it moved.
    if (Object.values(this.model.decisions).some((d) => d.affects.includes(nodeId))) this.redrawDecisions();
  }

  // ---- decisions: the reasoning chain ----
  // { id, title, chose, over[], why, affects[], evidence[], builds_on[], state, verify, proof, proof_by, cause }
  // verify is the check that will show the choice was right; proof is its result (pass/fail),
  // proof_by what showed it; cause is what made the choice change ({ who: "you" | "test", text }).
  setDecision({ id, title, chose, over, why, affects, evidence, builds_on, state, verify, proof, proof_by, cause, cause_text }) {
    if (!id) return [];
    const m = this.model;
    const prev = m.decisions[id];
    if (!prev && !title && !chose) return [];
    const inPlanning = !m.phase || m.phase === "planning";
    const changed = prev && chose && chose !== prev.chose;
    // A changed choice keeps what it replaced, so the chain shows how the thinking moved.
    const was = changed ? [...(prev.was ?? []), prev.chose] : prev?.was ?? [];
    // The server names the cause; a recording from before it did, or the demo, may not.
    if (changed && !cause && prev.proof === "fail") [cause, cause_text] = ["test", prev.proof_by ?? ""];
    const result = PROOF[proof] ? proof : null;
    m.decisions[id] = {
      id,
      was,
      n: prev?.n ?? Object.keys(m.decisions).length + 1,
      title: title ?? prev?.title ?? id,
      chose: chose ?? prev?.chose ?? "",
      over: over != null ? list(over) : prev?.over ?? [],
      why: why ?? prev?.why ?? "",
      affects: affects != null ? list(affects) : prev?.affects ?? [],
      evidence: evidence != null ? list(evidence) : prev?.evidence ?? [],
      builds_on: builds_on != null ? list(builds_on) : prev?.builds_on ?? [],
      // Repeating a decision to report its proof or refine its why doesn't change it; a new choice does.
      state: DECISION[state] ? state : changed ? "changed" : prev?.state ?? (inPlanning ? "proposed" : "accepted"),
      verify: verify ?? prev?.verify ?? "",
      // A new choice hasn't been checked yet.
      proof: result ?? (changed ? null : prev?.proof ?? null),
      proof_by: proof_by ?? (changed && !result ? null : prev?.proof_by ?? null),
      cause: cause ? { who: cause, text: cause_text ?? "" } : prev?.cause ?? null,
    };
    this.redrawDecisions();
    return [`decision:${id}`];
  }

  // Approving the plan makes its proposed decisions accepted.
  acceptDecisions() {
    let changed = false;
    for (const d of Object.values(this.model.decisions))
      if (d.state === "proposed") {
        d.state = "accepted";
        changed = true;
      }
    if (changed) this.redrawDecisions();
  }

  drawDecisions() {
    const els = this.api.getSceneElements();
    const mainOf = (id) => els.find((e) => e.id === this.model.nodes[id]?.elId);
    // A diamond the user deleted is a rejection waiting to be sent; don't bring it back.
    const userDeleted = new Set(this.scene().filter((e) => e.isDeleted && e.type === "diamond" && e.id.startsWith("dec-")).map((e) => e.id));
    const perAnchor = {};
    let loose = 0;
    const sk = [];
    const centers = {};
    for (const d of Object.values(this.model.decisions).sort((a, b) => a.n - b.n)) {
      if (userDeleted.has(`dec-${d.id}`) && d.state !== "rejected") continue;
      const st = DECISION[d.state] ?? DECISION.proposed;
      const anchorId = d.affects.find((a) => mainOf(a));
      const anchor = anchorId && mainOf(anchorId);
      let x, y;
      if (anchor) {
        const k = (perAnchor[anchorId] = (perAnchor[anchorId] ?? -1) + 1);
        x = anchor.x - DW / 2 + 4 + k * (DW + 4);
        y = anchor.y - DW / 2 + 4;
      } else {
        // Not tied to a component: a row between the journey strip and the diagram.
        x = 30 + loose++ * (DW + 10);
        y = NY0 - 72;
      }
      const g = [`g:dec-${d.id}`];
      sk.push({ type: "diamond", id: `dec-${d.id}`, x, y, width: DW, height: DW, strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", strokeStyle: st.dash, strokeWidth: 2, roughness: 1, groupIds: g });
      sk.push({ type: "text", id: `dec-${d.id}-t`, x, y, text: `D${d.n}`, fontSize: 14, strokeColor: st.stroke, groupIds: g });
      centers[`dec-${d.id}-t`] = [x + DW / 2, y + DW / 2];
      // Its check's result: ✓ or ✗ on the diamond's shoulder.
      if (d.proof) {
        const [mark, glyph] = proofMark(`dec-${d.id}-pf`, x + DW - 12, y - 6, 20, d.proof);
        sk.push(...mark.map((e) => ({ ...e, groupIds: g })));
        centers[glyph] = [x + DW - 2, y + 4];
      }
      // A faint dotted tie to every other component it affects.
      d.affects.filter((a) => a !== anchorId).forEach((a, i) => {
        const t = mainOf(a);
        if (!t) return;
        const cx = x + DW / 2, cy = y + DW / 2;
        const [ex, ey] = edgePoint(t, cx - (t.x + t.width / 2), cy - (t.y + t.height / 2), 2);
        sk.push(poly(`dec-${d.id}-l${i}`, [[cx, cy], [ex, ey]], { strokeColor: st.stroke, strokeStyle: "dotted", strokeWidth: 1.5, opacity: 55, roughness: 1, locked: true }));
      });
    }
    const out = this.convert(sk);
    for (const e of out) {
      const c = centers[e.id];
      if (c) {
        e.x = c[0] - e.width / 2;
        e.y = c[1] - e.height / 2;
      }
    }
    return out;
  }

  redrawDecisions() {
    this.replace((e) => e.id.startsWith("dec-"), this.drawDecisions());
    this.redrawWhy();
  }

  // ---- the Why canvas: each decision as a chain ----
  //   Evidence (repo facts, you, a failed check) → Decision → the components it shapes → Proof
  drawWhy() {
    const m = this.model;
    const ds = Object.values(m.decisions).sort((a, b) => a.n - b.n);
    if (!ds.length) return [];
    const x0 = 0, y0 = 0;
    const C = { ev: x0, dec: x0 + 330, comp: x0 + 720, proof: x0 + 1000 };
    const LINE = 52; // one evidence item or component per line
    const lock = { locked: true };
    const sk = [], centers = {}, rows = [];

    for (const [k, label] of [["ev", "Evidence"], ["dec", "Decision"], ["comp", "Shapes"], ["proof", "Proof"]])
      sk.push({ type: "text", id: `${WHY}h:${k}`, x: C[k], y: y0, text: label, fontSize: 16, strokeColor: MUTED, ...lock });

    let top = y0 + 46;
    for (const d of ds) {
      const st = DECISION[d.state] ?? DECISION.proposed;
      const id = `${WHY}d:${d.id}`;
      // What it rests on: why it last changed first, then the repo facts. A file stands for its fact.
      const cause = d.cause && { kind: d.cause.who, label: d.cause.who === "you" ? `You: ${d.cause.text}` : d.cause.text };
      const facts = d.evidence
        .filter((t) => !(d.cause?.text && t.toLowerCase().includes(d.cause.text.toLowerCase()))) // already shown as the cause
        .map((t) => {
          const file = t.match(/[\w./-]+\.[a-z]{1,5}\b/i)?.[0];
          return file ? { kind: "file", label: file } : { kind: "fact", label: t };
        });
      let ev = [...(cause ? [cause] : []), ...facts];
      if (ev.length > 4) ev = [...ev.slice(0, 3), { kind: "more", label: `+${ev.length - 3} more` }];
      const comps = d.affects.filter((a) => m.nodes[a]).slice(0, 4);
      const h = Math.max(1, ev.length, comps.length) * LINE;
      const cy = top + h / 2;
      const at = (i, n) => cy + (i - (n - 1) / 2) * LINE;
      // The whole row, invisible: what a click on the Why canvas lands on.
      sk.push({ type: "rectangle", id: `${WHY}r:${d.id}`, x: x0 - 16, y: top - 14, width: C.proof + 400 - x0, height: h + 28, strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0, ...lock });

      ev.forEach((e, i) => {
        const y = at(i, ev.length), pid = `${WHY}e:${d.id}:${i}`;
        if (e.kind === "you") sk.push(...personIcon(`${pid}:i`, C.ev, y - 14));
        else if (e.kind === "test") {
          const [mark, glyph] = proofMark(`${pid}:i`, C.ev, y - 12, 24, "fail");
          sk.push(...mark);
          centers[glyph] = [C.ev + 12, y];
        } else if (e.kind === "file") sk.push(...pageIcon(`${pid}:i`, C.ev, y - 14));
        else if (e.kind === "fact") sk.push(...noteIcon(`${pid}:i`, C.ev, y - 14));
        sk.push({ type: "text", id: `${pid}:t`, x: C.ev + 34, y: y - 10, text: clip(e.label, 30), fontSize: 15, strokeColor: e.kind === "you" ? YOU.stroke : e.kind === "test" ? PROOF.fail.color : INK });
      });

      sk.push({ type: "diamond", id, x: C.dec, y: cy - 22, width: 44, height: 44, strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", strokeStyle: st.dash, strokeWidth: 2, roughness: 1 });
      sk.push({ type: "text", id: `${id}:n`, x: C.dec, y: cy, text: `D${d.n}`, fontSize: 14, strokeColor: st.stroke });
      centers[`${id}:n`] = [C.dec + 22, cy];
      sk.push({ type: "text", id: `${id}:t1`, x: C.dec + 56, y: cy - 24, text: clip(d.title, 32), fontSize: 18, strokeColor: INK });
      sk.push({ type: "text", id: `${id}:t2`, x: C.dec + 56, y: cy + 3, text: clip(d.chose, 42), fontSize: 14, strokeColor: MUTED });

      comps.forEach((nid, i) => {
        const y = at(i, comps.length), node = m.nodes[nid], pid = `${WHY}c:${d.id}:${nid}`;
        sk.push(...miniIcon(node.kind, C.comp, y - 16, STATUS[node.status] ?? STATUS.planned, `${pid}:i`));
        sk.push({ type: "text", id: `${pid}:t`, x: C.comp + 56, y: y - 11, text: node.name, fontSize: 16, strokeColor: INK });
      });

      const pid = `${WHY}p:${d.id}`;
      const [mark, glyph] = proofMark(pid, C.proof, cy - 17, 34, d.proof);
      sk.push(...mark);
      centers[glyph] = [C.proof + 17, cy];
      const said = d.proof ? d.proof_by || (d.proof === "pass" ? "passed" : "failed") : d.verify || "no check yet";
      sk.push({ type: "text", id: `${pid}:t`, x: C.proof + 46, y: cy - 10, text: clip(said, 44), fontSize: 15, strokeColor: PROOF[d.proof]?.color ?? MUTED });

      rows.push({ d, cy, ev: ev.map((_, i) => at(i, ev.length)), comps: comps.map((nid, i) => [nid, at(i, comps.length)]) });
      top += h + 36;
    }

    const out = this.convert(sk);
    for (const e of out) {
      const c = centers[e.id];
      if (c) {
        e.x = c[0] - e.width / 2;
        e.y = c[1] - e.height / 2;
      }
    }

    // The links, from where the text actually ends.
    const byId = new Map(out.map((e) => [e.id, e]));
    const right = (id) => (byId.has(id) ? byId.get(id).x + byId.get(id).width : 0);
    const link = (id, [ax, ay], [bx, by], color, dash = "solid") => ({
      type: "arrow", id, x: ax, y: ay, points: [[0, 0], [bx - ax, by - ay]],
      strokeColor: color, strokeWidth: 1.5, strokeStyle: dash, roughness: 1, opacity: 70, endArrowhead: "arrow", ...lock,
    });
    const arrows = [];
    const rowOf = new Map(rows.map((r, i) => [r.d.id, i]));
    rows.forEach(({ d, cy, ev, comps }, row) => {
      const a = `${WHY}a:${d.id}`;
      ev.forEach((y, i) => arrows.push(link(`${a}:e${i}`, [right(`${WHY}e:${d.id}:${i}:t`) + 10, y], [C.dec - 6, cy], MUTED)));
      const from = Math.max(right(`${WHY}d:${d.id}:t1`), right(`${WHY}d:${d.id}:t2`)) + 12;
      comps.forEach(([, y], i) => arrows.push(link(`${a}:c${i}`, [Math.min(from, C.comp - 30), cy], [C.comp - 8, y], MUTED)));
      // Shapes → proof: the check is what shows those components do what was decided.
      const shaped = comps.length ? Math.max(...comps.map(([nid]) => right(`${WHY}c:${d.id}:${nid}:t`))) + 12 : from;
      arrows.push(link(`${a}:p`, [Math.min(shaped, C.proof - 30), cy], [C.proof - 8, cy], PROOF[d.proof]?.color ?? MUTED, d.proof ? "solid" : "dashed"));
      // Builds on: a dashed purple hop down from the earlier decision's diamond,
      // bowing left around any diamonds in between.
      d.builds_on.forEach((b, i) => {
        const r = rows[rowOf.get(b)];
        if (!r || rowOf.get(b) >= row) return;
        const color = DECISION.accepted.stroke;
        if (row - rowOf.get(b) === 1) return arrows.push(link(`${a}:b${i}`, [C.dec + 22, r.cy + 25], [C.dec + 22, cy - 26], color, "dashed"));
        // Leave from the lower-left edge, land on the upper-left one: clear of the straight hops.
        const [x1, y1, x2, y2] = [C.dec + 8, r.cy + 16, C.dec + 6, cy - 18];
        arrows.push({ ...link(`${a}:b${i}`, [x1, y1], [x2, y2], color, "dashed"), points: [[0, 0], [-44, (y2 - y1) / 2], [x2 - x1, y2 - y1]], roundness: { type: 2 } });
      });
    });
    return [...out, ...this.convert(arrows)];
  }

  redrawWhy() {
    if (!this.whyApi) return;
    const marks = this.whyApi.getSceneElements().filter((e) => e.id.startsWith(MARK));
    this.replace(() => true, [...this.drawWhy(), ...marks], this.whyApi);
    this.whyHlSig = ""; // rows may have moved under their marks
    this.refreshMarkers();
    // A new decision while the Why canvas is showing: keep every row in view.
    const rows = Object.keys(this.model.decisions).length;
    if (rows !== this.whyRows && this.view === "why") this.fitWhy(true);
    this.whyRows = rows;
  }

  // Which decision or component a point on the Why canvas is over (scene coordinates).
  whyHit(x, y) {
    const inside = (e) => x >= e.x && x <= e.x + e.width && y >= e.y && y <= e.y + e.height;
    const els = (this.whyApi?.getSceneElements() ?? []).filter((e) => !e.id.startsWith(MARK) && e.type !== "arrow" && inside(e));
    // The smallest thing under the pointer, so a component's icon wins over its row.
    els.sort((a, b) => a.width * a.height - b.width * b.height);
    return els.length ? this.logicalIdsFor([els[0].id]) : [];
  }

  setStatus(id, v) {
    const node = this.model.nodes[id];
    if (!node || !STATUS[v]) return [];
    node.status = v;
    this.redrawNode(id);
    return [`node:${id}`];
  }

  rename(id, name) {
    const node = this.model.nodes[id];
    if (!node || !name) return [];
    node.name = name;
    this.redrawNode(id);
    return [`node:${id}`];
  }

  // Arrows bind to the hit-boxes; dashed when the link is asynchronous. `via` (HTTP, SQL,
  // queue…) shows as a small tag when it fits; `api` (the exact call) lives in the Plan tab.
  addEdge({ from, to, style, via, api }) {
    const key = `${from}>${to}`;
    const existing = this.model.edges[key];
    if (existing) {
      if (via) existing.via = via;
      if (api) existing.api = api;
      return [`edge:${key}`];
    }
    const async = style === "async" || (!style && /queue|event|pub.?sub|stream|webhook|job/i.test(via ?? ""));
    const A = this.model.nodes[from], B = this.model.nodes[to];
    if (!A || !B) return [];
    const els = this.scene();
    const ai = els.findIndex((e) => e.id === A.elId), bi = els.findIndex((e) => e.id === B.elId);
    if (ai === -1 || bi === -1) return [];
    const a = els[ai], b = els[bi];
    const dx = b.x + b.width / 2 - (a.x + a.width / 2);
    const dy = b.y + b.height / 2 - (a.y + a.height / 2);
    const p1 = edgePoint(a, dx, dy, 4), p2 = edgePoint(b, -dx, -dy, 4);
    const id = `edge-${from}-${to}`;
    // Only a short protocol tag, and only where it fits between the boxes.
    const tag = via && via.length <= 8 && via.length * 7.5 < Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) - 40 ? via : null;
    // convertToExcalidrawElements only binds arrows to shapes in the same batch,
    // so pass geometry-only proxies of both ends and keep just the arrow.
    const proxy = (e) => ({ type: e.type, id: e.id, x: e.x, y: e.y, width: e.width, height: e.height });
    const out = this.convert([
      proxy(a), proxy(b),
      {
        type: "arrow", id, x: p1[0], y: p1[1],
        points: [[0, 0], [p2[0] - p1[0], p2[1] - p1[1]]],
        strokeColor: "#495057", strokeWidth: 2, roughness: 1, strokeStyle: async ? "dashed" : "solid",
        start: { id: a.id }, end: { id: b.id },
        ...(tag ? { label: { text: tag, fontSize: 13, strokeColor: MUTED } } : {}),
      },
    ]);
    const arrow = out.find((e) => e.id === id);
    const text = out.find((e) => e.containerId === id);
    els[ai] = bump(a, { boundElements: [...(a.boundElements || []), { type: "arrow", id }] });
    els[bi] = bump(b, { boundElements: [...(b.boundElements || []), { type: "arrow", id }] });
    els.push(arrow);
    if (text) els.push(text);
    this.remember(text ? [arrow, text] : [arrow]);
    this.model.edges[key] = { from, to, elId: id, via: via ?? null, api: api ?? null };
    this.commit(els);
    return [`edge:${key}`];
  }

  // Sticky notes are the one place words belong on the board: they're the user's own.
  addNote(text) {
    if (!text) return [];
    const n = this.model.notes.length;
    const elId = `note-${n}`;
    const slot = this.noteSlot++;
    const out = this.remember(this.convert([{
      type: "rectangle", id: elId, x: NOTE_X, y: NOTE_Y + slot * 70, width: 210, height: 56,
      strokeColor: "#f08c00", backgroundColor: "#ffec99", fillStyle: "solid", strokeWidth: 1, roughness: 1, roundness: { type: 3 },
      label: { text, fontSize: 15, strokeColor: INK },
    }]));
    this.model.notes.push({ n, elId });
    this.commit([...this.scene(), ...out]);
    return [`note:${n}`];
  }

  // Delete elements by id (plus their bound text) and drop dangling bindings.
  kill(els, ids) {
    for (const e of els) if (ids.has(e.containerId)) ids.add(e.id);
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (ids.has(e.id) && !e.isDeleted) els[i] = bump(e, { isDeleted: true });
      else if (e.boundElements?.some((b) => ids.has(b.id)))
        els[i] = bump(e, { boundElements: e.boundElements.filter((b) => !ids.has(b.id)) });
    }
  }

  remove(id) {
    const node = this.model.nodes[id];
    if (!node) return [];
    const els = this.scene();
    const ids = new Set(els.filter((e) => e.id === node.elId || e.id.startsWith(`${node.elId}:`)).map((e) => e.id));
    for (const [k, e] of Object.entries(this.model.edges))
      if (e.from === id || e.to === id) {
        ids.add(e.elId);
        delete this.model.edges[k];
      }
    this.kill(els, ids);
    delete this.model.nodes[id];
    this.commit(els);
    return [];
  }

  unlink(from, to) {
    const key = `${from}>${to}`;
    const e = this.model.edges[key];
    if (!e) return [];
    const els = this.scene();
    this.kill(els, new Set([e.elId]));
    delete this.model.edges[key];
    this.commit(els);
    return [];
  }

  // Take ownership of a box the user drew: redraw it as a pictogram in the same spot.
  // It keeps the user's element id, so arrows already bound to it stay bound.
  adopt({ el, id, name, kind }) {
    const shape = this.scene().find((e) => e.id === el && !e.isDeleted);
    if (!shape || !name) return [];
    let nid = id || "item", k = 2;
    while (this.model.nodes[nid]) nid = `${id}-${k++}`;
    this.model.nodes[nid] = { id: nid, name, kind: KINDS.includes(kind) ? kind : "service", status: "planned", elId: el, cell: null };
    const ox = shape.x + shape.width / 2 - IW / 2, oy = shape.y + shape.height / 2 - (IH + 30) / 2;
    this.redrawNode(nid, { ox, oy });
    return [`node:${nid}`];
  }

  adoptEdge({ el, from, to }) {
    const key = `${from}>${to}`;
    if (this.model.edges[key]) return [`edge:${key}`];
    const els = this.scene();
    const i = els.findIndex((e) => e.id === el && !e.isDeleted);
    if (i === -1) return [];
    // Restyle the user's arrow to match the agent's, so the diagram reads as one drawing.
    els[i] = bump(els[i], { strokeColor: "#495057", strokeWidth: 2, roughness: 1 });
    this.model.edges[key] = { from, to, elId: el };
    this.known.add(el);
    for (const e of els) if (e.containerId === el) this.known.add(e.id);
    this.commit(els);
    return [`edge:${key}`];
  }

  adoptNote(el) {
    const n = this.model.notes.length;
    this.model.notes.push({ n, elId: el });
    this.known.add(el);
    return [`note:${n}`];
  }

  // ---- board -> agent: what did the user change? ----
  diff() {
    const els = this.api.getSceneElementsIncludingDeleted();
    const byId = new Map(els.map((e) => [e.id, e]));
    const live = (id) => {
      const e = byId.get(id);
      return e && !e.isDeleted ? e : null;
    };
    const name = (id) => this.model.nodes[id]?.name ?? id;
    const out = [];

    for (const n of Object.values(this.model.nodes)) {
      if (!live(n.elId)) {
        out.push({ key: `remove:${n.id}`, kind: "remove", node: n.id, name: n.name });
        continue;
      }
      const now = firstLine(live(`${n.elId}:label`)?.text);
      if (now && now !== n.name) out.push({ key: `rename:${n.id}:${now}`, kind: "rename", node: n.id, from: n.name, to: now });
    }

    // Deleting a decision's diamond rejects that decision.
    for (const d of Object.values(this.model.decisions)) {
      if (d.state === "rejected" || live(`dec-${d.id}`) || !byId.has(`dec-${d.id}`)) continue;
      out.push({ key: `reject:${d.id}`, kind: "reject", decision: d.id, label: `D${d.n}`, title: d.title, chose: d.chose });
    }

    for (const [k, e] of Object.entries(this.model.edges)) {
      if (live(e.elId)) continue;
      if (live(this.model.nodes[e.from]?.elId) && live(this.model.nodes[e.to]?.elId))
        out.push({ key: `unlink:${k}`, kind: "unlink", from: e.from, to: e.to, fromName: name(e.from), toName: name(e.to) });
    }

    for (const e of els) {
      if (e.isDeleted || this.known.has(e.id) || e.id.startsWith(MARK)) continue;
      if (e.type === "arrow") {
        const a = this.nodeByEl(e.startBinding?.elementId), b = this.nodeByEl(e.endBinding?.elementId);
        if (a && b && a !== b && !this.model.edges[`${a.id}>${b.id}`])
          out.push({ key: `link:${e.id}`, kind: "link", elId: e.id, from: a.id, to: b.id, fromName: a.name, toName: b.name });
      } else if (["rectangle", "ellipse", "diamond"].includes(e.type)) {
        const label = els.find((t) => t.containerId === e.id && !t.isDeleted);
        const nm = firstLine(label?.originalText ?? label?.text);
        if (nm) out.push({ key: `add:${e.id}:${nm}`, kind: "add", elId: e.id, name: nm });
      } else if (e.type === "text" && !e.containerId && e.text.trim()) {
        out.push({ key: `note:${e.id}:${e.text.trim()}`, kind: "note", elId: e.id, text: e.text.trim() });
      }
    }
    return out;
  }

  // ---- text <-> board linking ----
  // The Architecture element for a logical id. Phases, tasks and the title live in PhaseHeader.
  elementFor(lid) {
    const [k, v] = lid.split(":");
    switch (k) {
      case "node": return this.model.nodes[v]?.elId;
      case "edge": return this.model.edges[v]?.elId;
      case "note": return this.model.notes.find((n) => n.n === +v)?.elId;
      case "decision": return this.model.decisions[v] ? `dec-${v}` : null;
      default: return null;
    }
  }

  // The Why element for a logical id: a decision is its row's diamond.
  whyElementFor(lid) {
    const [k, v] = lid.split(":");
    return k === "decision" && this.model.decisions[v] ? `${WHY}d:${v}` : null;
  }

  logicalIdsFor(elIds) {
    const out = new Set();
    for (const id of elIds) {
      // Why canvas: why:<part>:<decision>[:<node>]… — a component there means the component.
      if (id.startsWith(WHY)) {
        const [, part, did, nid] = id.split(":");
        if (part === "c" && this.model.nodes[nid]) out.add(`node:${nid}`);
        else if (this.model.decisions[did]) out.add(`decision:${did}`);
        continue;
      }
      const node = this.nodeByEl(id);
      if (node) out.add(`node:${node.id}`);
      else if (id.startsWith("dec-")) {
        const d = Object.keys(this.model.decisions).find((k) => id === `dec-${k}` || id.startsWith(`dec-${k}-`));
        if (d) out.add(`decision:${d}`);
      } else {
        const edge = Object.entries(this.model.edges).find(([, e]) => e.elId === id);
        if (edge) out.add(`edge:${edge[0]}`);
        const note = this.model.notes.find((n) => n.elId === id);
        if (note) out.add(`note:${note.n}`);
      }
    }
    return [...out];
  }

  // Bring these into view on the canvas that's showing.
  scrollTo(lids) {
    const why = this.view === "why";
    const api = why ? this.whyApi : this.api;
    const ids = new Set(lids.map((l) => (why ? this.whyElementFor(l) : this.elementFor(l))).filter(Boolean));
    const els = api.getSceneElements().filter((e) => ids.has(e.id));
    if (els.length) api.scrollToContent(els, { animate: true, duration: 300 });
  }

  setHighlights(lids) {
    this.hl = new Set(lids);
    this.refreshMarkers();
  }

  // Highlighter marks on both canvases: a yellow halo behind shapes, a marker stroke under text and arrows.
  refreshMarkers() {
    this.hlSig = this.paintMarks(this.api, (l) => this.elementFor(l), this.hlSig);
    if (this.whyApi) this.whyHlSig = this.paintMarks(this.whyApi, (l) => this.whyElementFor(l), this.whyHlSig);
  }

  // Returns the marks' signature, so an unchanged set isn't repainted.
  paintMarks(api, elementFor, lastSig) {
    const els = api.getSceneElementsIncludingDeleted().filter((e) => !e.id.startsWith(MARK));
    const targets = [];
    for (const lid of this.hl) {
      const id = elementFor(lid);
      const t = id && els.find((e) => e.id === id && !e.isDeleted);
      if (t) targets.push([lid, t]);
    }
    const sig = targets
      .map(([l, t]) => `${l}:${t.version}:${t.x | 0}:${t.y | 0}:${t.width | 0}:${t.height | 0}`)
      .join("|");
    if (sig === lastSig) return sig;

    const marks = targets.map(([lid, t]) => {
      const id = `${MARK}${lid}`;
      const base = { id, strokeColor: "#ffd43b", backgroundColor: "#ffe066", locked: true };
      if (t.type === "arrow")
        return [t.id, { ...base, type: "line", x: t.x, y: t.y, points: t.points, strokeWidth: 14, opacity: 55, roughness: 0 }];
      const [x1, y1, x2, y2] = getCommonBounds([t]);
      if (t.type === "text") {
        const h = y2 - y1;
        return [t.id, { ...base, type: "line", x: x1 - 6, y: y1 + h / 2, points: [[0, 0], [x2 - x1 + 12, 0]], strokeWidth: h * 0.95, opacity: 60, roughness: 0 }];
      }
      const pad = Math.max(5, Math.min(12, (x2 - x1) * 0.12));
      return [t.id, {
        ...base, type: t.type === "ellipse" ? "ellipse" : "rectangle",
        x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2,
        strokeColor: "transparent", fillStyle: "solid", opacity: 60, roughness: 1, roundness: { type: 3 },
      }];
    });
    if (marks.length) {
      const conv = this.convert(marks.map(([, s]) => s));
      for (const [targetId, s] of marks) {
        const m = conv.find((c) => c.id === s.id);
        m.seed = seedOf(s.id);
        els.splice(els.findIndex((e) => e.id === targetId), 0, m);
      }
    }
    api.updateScene({ elements: els, captureUpdate: CaptureUpdateAction.NEVER });
    return sig;
  }
}
