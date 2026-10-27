import {
  CaptureUpdateAction,
  convertToExcalidrawElements,
  getCommonBounds,
} from "@excalidraw/excalidraw";
import { DECISION, INK, MILESTONE, MUTED, PHASES, PROOF, YOU } from "./palette";
import { buildTimeline, drawTimeline, TL, xToTime } from "./timeline";
import { c4Tag, dataOf, dfdIds, dfdRole, LAYER_COLOR, LAYERS, layerOf, parseColumns, parseLinks, parseSteps, sentenceCase, tagCase } from "./views";
import { explodeLayout, explodeOf, explodeSkeletons } from "./explode";
import { drawEr, drawInside, drawSequence } from "./diagrams";
import { STICKERS, stickerEdit } from "./stickers";

export { MILESTONE, PHASES, STICKERS };

// Owns the board's Excalidraw scenes and keeps them pictures, not documents:
//   - Architecture: hand-drawn pictograms colored by status, connections, and the
//     numbered decision diamonds pinned to what they shape. The user edits this one.
//   - Why: each decision as a chain, evidence → decision → what it shapes → proof.
//     Derived from the model; redrawn whenever a decision or component changes.
//   - Timeline: how the decisions moved over the run (src/engine/timeline.js), drawn
//     from the Session's timed events.
// The phase journey (milestones + task dots) is drawn above both by PhaseHeader,
// from this.model. Words live in the panel; on the boards there are only short names.
//
// It also applies board ops from the agent, paints highlighter marks behind
// whatever the current sentence touched, and diffs the user's edits.

// Component status is color + a corner badge; no words.
export const STATUS = {
  planned: { stroke: "#868e96", fill: "#f8f9fa", badge: null },
  building: { stroke: "#e8590c", fill: "#fff3bf", badge: "…" },
  built: { stroke: "#1971c2", fill: "#d0ebff", badge: null },
  verified: { stroke: "#2f9e44", fill: "#d3f9d8", badge: "✓" },
  failed: { stroke: "#e03131", fill: "#ffe3e3", badge: "✗" },
  live: { stroke: "#6741d9", fill: "#e5dbff", badge: "★" },
};

export const KINDS = ["client", "service", "data", "external", "queue", "test", "user"];

// Task dots, drawn by PhaseHeader.
export const TASK = {
  todo: { stroke: "#adb5bd", fill: "transparent" },
  building: { stroke: "#e8590c", fill: "#ffd8a8" },
  done: { stroke: "#2f9e44", fill: "#8ce99a" },
  failed: { stroke: "#e03131", fill: "#ffa8a8" },
};

// Scene geometry. Kept near the aspect of a typical board pane so "fit" stays readable.
const IW = 110, IH = 80; // pictogram size
// A C4 box, relative to the pictogram's origin: same center line, so the grid holds either.
const C4B = { x: -40, y: -10, w: 190, h: 92 };
// Data-flow (Gane-Sarson) shapes, on the same center column: a process, a data store, an external entity.
const DFD = { process: { x: -40, y: -10, w: 190, h: 92 }, store: { x: -40, y: 8, w: 190, h: 56 }, entity: { x: -30, y: -4, w: 170, h: 80 } };
// Where a component's hit-box sits relative to the pictogram's origin, per drawing style.
const shapeOf = (style, kind) => (style === "c4" ? C4B : style === "dfd" ? DFD[dfdRole({ kind })] : { x: -10, y: -10, w: IW + 20, h: IH + 74 });
// The C4 style is the official one: crisp 1 px lines and a plain typeface (Nunito, Excalidraw's "Normal").
const SANS = 6;
const FADE = 15; // opacity of what a layer or flow filter leaves out
const COL = 290, ROW = 180, NX0 = 55, NY0 = 90; // node grid (icon origin)
const NOTE_X = 860, NOTE_Y = 90;
const MARK = "hl-";
const AGENT = "agent-cursor"; // hashes to Excalidraw's purple cursor hue

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

const DW = 40; // decision diamond size

// Questions for the user and assumptions the agent works from: sticky notes with a badge.
const QSTYLE = {
  question: { stroke: "#f08c00", fill: "#fff4e6", glyph: "?" },
  assumption: { stroke: "#7048e8", fill: "#f3f0ff", glyph: "≈" },
};
const QSTATES = ["open", "answered", "confirmed", "corrected"];
// The coach's tips: yellow sticky notes and an orange ring (showTips).
const TIP_RING = "#e8590c";
// The teacher's red pen on the review (showPen), and the tape and pins that say whose note is whose.
const PEN = "#e03131";
const TAPE = { fill: "#a5d8ff", stroke: "#74c0fc" };
const PIN = { head: "#fa5252", rim: "#c92a2a" };
const WHY = "why:"; // element id prefix of the Why view
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Chat text as words for the board: no markdown marks, no board tags, one space between words.
const plainWords = (s) => String(s).replace(/<board[^>]*\/?>/g, "").replace(/[*`_]/g, "").replace(/\s+/g, " ").trim();
// Lines of at most n characters, broken between words.
const wrapWords = (s, n) =>
  s.split(" ").reduce((lines, w) => {
    const last = lines.at(-1);
    if (last && (last + " " + w).length <= n) lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
    return lines;
  }, []).join("\n");
// Two elements' boxes touch (within m px).
const overlaps = (a, b, m = 0) => a.x < b.x + b.width + m && b.x < a.x + a.width + m && a.y < b.y + b.height + m && b.y < a.y + a.height + m;

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
  const shape = { strokeColor: s.stroke, backgroundColor: s.fill, fillStyle: "solid", strokeStyle: "solid", strokeWidth: 2, roughness: 1 };
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
        ln([[0, 12], [0, 68]], ink),
        ln([[110, 12], [110, 68]], ink),
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
// A push pin stuck in at (cx, top): a red head with a rim, a glint, and the needle's shadow.
function pinParts(pid, cx, top) {
  return [
    poly(`${pid}:pin-n`, [[cx + 1, top - 2], [cx + 5, top + 7]], { strokeColor: "#868e96", strokeWidth: 1.5, roughness: 0, opacity: 70 }),
    { type: "ellipse", id: `${pid}:pin`, x: cx - 8, y: top - 15, width: 16, height: 16, strokeColor: PIN.rim, backgroundColor: PIN.head, fillStyle: "solid", strokeWidth: 1.5, roughness: 1 },
    { type: "ellipse", id: `${pid}:pin-g`, x: cx - 4, y: top - 12, width: 5, height: 4, strokeColor: "transparent", backgroundColor: "#ffffff", fillStyle: "solid", strokeWidth: 1, roughness: 0, opacity: 80 },
  ];
}

// A strip of washi tape across the top of a note at (x, y, w): see-through, a little crooked.
function tapePart(id, x, y, w) {
  const tw = Math.min(84, Math.max(48, w * 0.4));
  return {
    type: "rectangle", id, x: x + w / 2 - tw / 2, y: y - 10, width: tw, height: 20, angle: (seedOf(id) % 2 ? -1 : 1) * 0.06,
    strokeColor: TAPE.stroke, backgroundColor: TAPE.fill, fillStyle: "solid", strokeWidth: 1, roughness: 1, opacity: 55,
  };
}

function edgePoint(el, dx, dy, gap) {
  const hw = el.width / 2, hh = el.height / 2;
  const t =
    el.type === "ellipse"
      ? 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2)
      : Math.min(hw / Math.abs(dx || 1e-6), hh / Math.abs(dy || 1e-6));
  const len = Math.hypot(dx, dy) || 1;
  return [el.x + hw + dx * t + (dx / len) * gap, el.y + hh + dy * t + (dy / len) * gap];
}

// The sticker sheet, as Excalidraw library items (api.updateLibrary). Each is a bright,
// hand-drawn label, a little crooked; its box and label carry customData.sticker, which a drop
// from the Library keeps (it gets new ids), so diff() knows a sticker wherever it lands.
export function stickerItems() {
  return Object.entries(STICKERS).map(([key, st]) => {
    const w = Math.max(104, st.label.length * 12 + 34);
    const els = convertToExcalidrawElements(
      [{
        type: "rectangle", id: `sticker-${key}`, x: 0, y: 0, width: w, height: 46, angle: st.angle,
        strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", strokeWidth: 2, roughness: 2, roundness: { type: 3 },
        customData: { sticker: key },
        label: { text: st.label, fontSize: 20, strokeColor: "#1e1e1e" },
      }],
      { regenerateIds: false },
    ).map((e) => ({ ...e, seed: seedOf(e.id), angle: st.angle, customData: { sticker: key } }));
    return { id: `wb-sticker-${key}`, status: "unpublished", name: st.label, created: 1, elements: els };
  });
}

export class Board {
  // api: the Architecture canvas; whyApi: the Why canvas; timelineApi: the Timeline canvas.
  constructor(api, { whyApi, timelineApi, diagramApi, onPhase, style } = {}) {
    this.api = api;
    this.diagramApi = diagramApi; // the read-only ER and sequence diagrams
    this.style = ["c4", "dfd"].includes(style) ? style : "pictures"; // how components are drawn (the viewer's choice)
    this.whyApi = whyApi;
    this.timelineApi = timelineApi;
    this.onPhase = onPhase;
    this.tlFollow = true; // refit the Timeline as it grows, until the user pans or zooms it
    this.tlFrame = "";
    this.reset();
  }

  reset() {
    this.model = { project: "", goal: null, phase: null, slots: {}, tasks: {}, nodes: {}, edges: {}, notes: [], decisions: {}, questions: {}, flows: {}, tables: {}, parts: {}, unowned: [] };
    this.diagramSig = null; // what the diagram canvas last drew
    this.focus = null; // what the board is narrowed to: { layer } or { flow }, the rest faded; { layer, explode } opens the layer up
    this.exSig = ""; // what the exploded layer last drew (drawExplode)
    this.known = new Set();
    this.hl = new Set();
    this.hlSig = "";
    this.whyHlSig = "";
    this.tlHlSig = "";
    this.noteSlot = 0;
    this.reviewing = false;
    this.view = "board"; // which canvas is showing: "board" (architecture), "why" or "timeline"
    this.tl = null; // the Timeline as last drawn (buildTimeline), for clicks and highlights
    this.changes = []; // the repo's actual changed files (git), attributed to components by their paths
    this.alt = null; // a decision's alternatives shown as ghosts: { did, ids, options, labels }
    this.tips = null; // ids of the coach's sticky notes on the board (showTips), not part of the plan
    this.pen = null; // the review's red-pen marks (showPen): { ids, links: elId -> lid, sig }
    this.stickers = new Map(); // stickers sent to the agent: elId -> { sticker, ids } (cleared or kept once it answers)
    this.whyRows = 0; // decisions drawn on the Why canvas, to refit it when one is added
    this.hideCursor();
  }

  // ---- scene helpers ----
  scene() {
    return [...this.api.getSceneElementsIncludingDeleted()];
  }
  // Decision diamonds stay above the components they sit on (a component redrawn later would
  // cover its diamond and take its clicks), a decision's option pills above those, and the
  // coach's tips and the review's red pen above everything.
  // A layer or flow filter fades what it leaves out, whatever was just drawn.
  commit(elements) {
    const on = (e, p) => e.id.startsWith(p) || e.containerId?.startsWith(p);
    // Stickers and their answers sit with the option pills, above the diamonds they're often stuck on.
    const layer = (e) => (on(e, "tip-") || on(e, "pen-") ? 3 : on(e, "alt-") || e.customData?.sticker || e.customData?.answers ? 2 : e.groupIds?.[0]?.startsWith("g:dec-") || e.id.startsWith("flow:") ? 1 : 0);
    const ls = elements.map(layer);
    if (ls.some((l, i) => i && l < ls[i - 1])) elements = elements.map((e, i) => [ls[i], i, e]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , e]) => e);
    this.api.updateScene({ elements: this.faded(elements), captureUpdate: CaptureUpdateAction.NEVER });
  }

  // Line and type for the drawing style: hand-drawn pictures, or the official C4 look.
  // C4 and data flow are the official notations; pictures are hand-drawn.
  get official() {
    return this.style === "c4" || this.style === "dfd";
  }
  look(width = 2) {
    return this.official ? { strokeWidth: 1, roughness: 0 } : { strokeWidth: width, roughness: 1 };
  }
  font() {
    return this.official ? { fontFamily: SANS } : {};
  }

  // What the focus keeps: { nodes, edges } (sets of ids and edge keys), or null for everything.
  focusSet() {
    const f = this.focus, m = this.model;
    if (!f) return null;
    let nodes;
    if (f.layer) {
      nodes = new Set(Object.values(m.nodes).filter((n) => [f.layer, null].includes(layerOf(n))).map((n) => n.id));
      // Opened up, a component of another layer with parts in this one stays in view: they burst out of it.
      if (f.explode) for (const g of explodeOf(m, f.layer)) nodes.add(g.host);
    }
    else if (m.flows[f.flow]) nodes = new Set(m.flows[f.flow].steps.flatMap((s) => [s.from, s.to]));
    else return null;
    const edges = new Set();
    if (f.layer) for (const [k, e] of Object.entries(m.edges)) if (nodes.has(e.from) && nodes.has(e.to)) edges.add(k);
    if (f.flow)
      for (const st of m.flows[f.flow].steps)
        for (const k of [`${st.from}>${st.to}`, `${st.to}>${st.from}`]) if (m.edges[k]) edges.add(k);
    return { nodes, edges };
  }

  // Elements outside the focus at FADE opacity; each one's own opacity comes back once it's in again.
  faded(els) {
    const keep = this.focusSet();
    if (!keep && !this.wasFocused) return els;
    this.wasFocused = !!keep;
    const edgeOf = new Map(Object.entries(this.model.edges).map(([k, e]) => [e.elId, k]));
    const inFocus = (e) => {
      const node = this.nodeByEl(e.id);
      if (node) return keep.nodes.has(node.id);
      const ek = edgeOf.get(e.id) ?? edgeOf.get(e.containerId);
      if (ek) return keep.edges.has(ek);
      const dec = e.groupIds?.[0]?.startsWith("g:dec-") || /^dec-.+-l\d+$/.test(e.id) ? this.model.decisions[e.groupIds?.[0]?.slice(6) ?? e.id.replace(/^dec-(.+)-l\d+$/, "$1")] : null;
      if (dec) return dec.affects.some((a) => keep.nodes.has(a));
      return true; // notes, questions, the key, flow steps, your own drawing
    };
    return els.map((e) => {
      if (e.isDeleted) return e;
      const own = e.customData?.o0 ?? e.opacity;
      const want = keep && !inFocus(e) ? Math.min(own, FADE) : own;
      return want === e.opacity ? e : bump(e, { opacity: want, customData: { ...e.customData, o0: own } });
    });
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
      await Promise.all([document.fonts.load("24px Excalifont", "Plan Build Verify Ship ✓✗★…"), document.fonts.load("18px Nunito", "Container Database")]);
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

  // Frame every canvas on its content.
  fit(animate = false) {
    this.api.scrollToContent(this.api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.94, animate });
    this.fitWhy(animate);
    this.tlFollow = true;
    this.fitTimeline(animate);
  }

  fitWhy(animate = false) {
    const els = this.whyApi?.getSceneElements() ?? [];
    if (els.length) this.whyApi.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.9, animate });
  }

  // Which canvas is showing. The cursor, highlights and "scroll to" follow it.
  setView(view) {
    this.hideCursor();
    this.view = ["why", "timeline"].includes(view) ? view : "board";
    this.refreshMarkers();
  }

  // The showing canvas, and how a logical id finds its element there.
  canvas() {
    if (this.view === "why") return [this.whyApi, (l) => this.whyElementFor(l)];
    if (this.view === "timeline") return [this.timelineApi, (l) => this.timelineElementFor(l)];
    return [this.api, (l) => this.elementFor(l)];
  }

  // ---- agent cursor: an Excalidraw collaborator that glides to whatever the agent touches ----
  // On the canvas that's showing: decisions have a place on all three, everything else only on Architecture.
  pointAt(lids, ms = 260) {
    // On the Timeline it goes to the decision's newest mark, which the next redraw draws.
    if (this.view === "timeline") this.tlPoint = { lids, ms };
    else this.glide(...this.canvas(), lids, ms);
  }

  glide(api, elementFor, lids, ms) {
    if (!api) return;
    const els = api.getSceneElements();
    let target = null;
    for (const lid of lids) {
      const id = elementFor(lid);
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
    this.timelineApi?.updateScene({ collaborators: new Map() });
  }

  // ---- ops ----
  apply(a) {
    const ids = this.applyOp(a);
    // An opened-up layer follows the plan as it changes (drawExplode skips what changes nothing).
    if (this.focus?.explode && ["node", "part", "table", "rename", "remove", "adopt"].includes(a.op)) this.drawExplode();
    return ids;
  }
  applyOp(a) {
    switch (a.op) {
      case "project": return this.setTitle(a.name, a.goal);
      case "decision": return this.setDecision(a);
      case "question":
      case "assumption": return this.setQuestion(a);
      case "phase": return this.setPhase(a.name);
      case "task": return this.setTask(a);
      case "node": return this.addNode(a);
      case "flow": return this.setFlow(a);
      case "table": return this.setTable(a);
      case "part": return this.setPart(a);
      case "edge": return this.addEdge(a);
      case "status": return this.setStatus(a.id, a.v);
      case "rename": return this.rename(a.id, a.name);
      case "note": return this.addNote(a.text);
      case "remove": return this.remove(a.id);
      case "unlink": return this.unlink(a.from, a.to);
      case "adopt": return this.adopt(a);
      case "adopt-edge": return this.adoptEdge(a);
      case "adopt-note": return this.adoptNote(a.el);
      case "answer": return this.answerSticker(a.el, a.text);
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
      ...(Object.keys(m.questions).length
        ? { questions: Object.values(m.questions).map(({ id, kind, text, state, answer }) => ({ id, kind, text, state, ...(answer ? { answer } : {}) })) }
        : {}),
      free_cells,
      notes: m.notes.length,
      // Keep this stickers still on the board: parts and decisions the user wants left as they are.
      ...(() => {
        const kept = (m.kept ?? []).filter((k) => this.api.getSceneElements().some((e) => e.id === k.elId));
        return kept.length ? { kept: kept.map(({ node, decision }) => (node ? { node } : { decision })) } : {};
      })(),
    };
  }

  // A component: an invisible hit-box (what arrows bind to and selection grabs),
  // the pictogram, its name underneath, and a status badge, all in one group.
  // In C4 style the hit-box is the visible box, with the name and "[Type: tech]" inside.
  drawNode(node, ox, oy, labelText) {
    const s = STATUS[node.status] ?? STATUS.planned;
    const pid = node.elId;
    const c4 = this.style === "c4", dfd = this.style === "dfd";
    node.style = this.style; // redrawNode finds the origin again from the hit-box
    const libs = node.libs ?? [];
    // Data flow (Gane-Sarson): a process is a rounded box with its number on top, a data store an
    // open-ended box with its id on the left, an external entity a box with a shadow.
    const b = shapeOf(this.style, node.kind), bx0 = ox + b.x, by0 = oy + b.y;
    const role = dfdRole(node);
    node.dfdId = dfd ? dfdIds(this.model)[node.id] ?? "" : "";
    const edge = { strokeColor: s.stroke, strokeWidth: 1, roughness: 0 };
    let labelAt = [ox + IW / 2, null]; // where the name is centered (x; y if not the default)
    const centers = {};
    const sk = dfd
      ? role === "process"
        ? [
            { type: "rectangle", id: pid, x: bx0, y: by0, width: b.w, height: b.h, strokeColor: s.stroke, backgroundColor: s.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: { type: 3 } },
            poly(`${pid}:0`, [[bx0, by0 + 24], [bx0 + b.w, by0 + 24]], edge),
            { type: "text", id: `${pid}:id`, x: bx0, y: by0, text: node.dfdId, fontSize: 12, strokeColor: MUTED, fontFamily: SANS },
            { type: "text", id: `${pid}:label`, x: ox, y: by0 + 38, text: labelText ?? node.name, fontSize: 17, strokeColor: INK, fontFamily: SANS },
          ]
        : role === "store"
          ? [
              { type: "rectangle", id: pid, x: bx0, y: by0, width: b.w, height: b.h, strokeColor: "transparent", backgroundColor: s.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0 },
              poly(`${pid}:0`, [[bx0 + b.w, by0], [bx0, by0], [bx0, by0 + b.h], [bx0 + b.w, by0 + b.h]], edge),
              poly(`${pid}:1`, [[bx0 + 52, by0], [bx0 + 52, by0 + b.h]], edge),
              { type: "text", id: `${pid}:id`, x: bx0, y: by0, text: node.dfdId, fontSize: 12, strokeColor: MUTED, fontFamily: SANS },
              { type: "text", id: `${pid}:label`, x: ox, y: by0 + b.h / 2 - 11, text: labelText ?? node.name, fontSize: 16, strokeColor: INK, fontFamily: SANS },
            ]
          : [
              { type: "rectangle", id: `${pid}:sh`, x: bx0 + 6, y: by0 + 6, width: b.w, height: b.h, strokeColor: "transparent", backgroundColor: "#ced4da", fillStyle: "solid", strokeWidth: 1, roughness: 0 },
              { type: "rectangle", id: pid, x: bx0, y: by0, width: b.w, height: b.h, strokeColor: s.stroke, backgroundColor: s.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0 },
              { type: "text", id: `${pid}:label`, x: ox, y: by0 + b.h / 2 - 12, text: labelText ?? node.name, fontSize: 17, strokeColor: INK, fontFamily: SANS },
            ]
      : c4
      ? [
          { type: "rectangle", id: pid, x: ox + C4B.x, y: oy + C4B.y, width: C4B.w, height: C4B.h, strokeColor: s.stroke, backgroundColor: s.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: null },
          { type: "text", id: `${pid}:label`, x: ox, y: oy + 8, text: labelText ?? node.name, fontSize: 17, strokeColor: INK, fontFamily: SANS },
          { type: "text", id: `${pid}:libs`, x: ox, y: oy + 34, text: c4Tag(node), fontSize: 12, strokeColor: MUTED, fontFamily: SANS },
        ]
      : [
          { type: "rectangle", id: pid, x: ox - 10, y: oy - 10, width: IW + 20, height: IH + 74, strokeColor: "transparent", backgroundColor: "transparent", strokeWidth: 1, roughness: 0 },
          ...iconParts(node.kind, ox, oy, s, pid),
          { type: "text", id: `${pid}:label`, x: ox, y: oy + IH + 8, text: labelText ?? node.name, fontSize: 18, strokeColor: INK },
        ];
    // The layer it's in, as a soft plate behind it: whole-board color coding (people have none).
    const lc = LAYER_COLOR[layerOf(node)];
    if (lc) {
      const pad = c4 || dfd ? 10 : 6;
      sk.unshift({ type: "rectangle", id: `${pid}:zone`, x: bx0 - pad, y: by0 - pad, width: b.w + pad * 2, height: b.h + pad * 2, strokeColor: lc.stroke, backgroundColor: lc.fill, fillStyle: "solid", strokeWidth: 1, roughness: c4 || dfd ? 0 : 1, roundness: { type: 3 }, opacity: 70 });
    }
    if (dfd && role === "process") centers[`${pid}:id`] = [ox + IW / 2, by0 + 12];
    if (dfd && role === "store") {
      centers[`${pid}:id`] = [bx0 + 26, by0 + b.h / 2];
      labelAt = [bx0 + 52 + (b.w - 52) / 2, null];
    }
    // The main library, small and grey under the name; the full stack is in the Plan tab.
    if (libs.length && !c4 && !dfd) {
      const first = libs[0].length > 18 ? `${libs[0].slice(0, 17)}…` : libs[0];
      sk.push({ type: "text", id: `${pid}:libs`, x: ox, y: oy + IH + 31, text: libs.length > 1 ? `${first} +${libs.length - 1}` : first, fontSize: 13, strokeColor: MUTED });
    }
    // What the run changed in its files (git): GitHub's five blocks, green for added lines, red for removed.
    const d = node.diff;
    if (d && d.add + d.del > 0) {
      const y = c4 ? oy + 60 : dfd ? (role === "process" ? oy + 62 : by0 + b.h + 8) : oy + IH + (libs.length ? 52 : 34);
      const red = d.del ? Math.max(1, Math.round((5 * d.del) / (d.add + d.del))) : 0;
      const green = d.add ? Math.max(1, 5 - red) : 0;
      const x0 = ox + IW / 2 - 40;
      for (let i = 0; i < 5; i++) {
        const c = i < green ? "#2f9e44" : i < green + red ? "#e03131" : "#dee2e6";
        sk.push({ type: "rectangle", id: `${pid}:d${i}`, x: x0 + i * 11, y, width: 9, height: 9, strokeColor: c, backgroundColor: c, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
      }
      sk.push({ type: "text", id: `${pid}:dt`, x: x0 + 60, y: y - 3, text: `+${d.add} −${d.del}`, fontSize: 12, strokeColor: MUTED, ...(c4 || dfd ? { fontFamily: SANS } : {}) });
    }
    const [bx, by] = c4 || dfd ? [bx0 + b.w - 14, by0 - 14] : [ox + IW - 14, oy - 14];
    if (s.badge) {
      sk.push({ type: "ellipse", id: `${pid}:badge`, x: bx, y: by, width: 28, height: 28, strokeColor: s.stroke, backgroundColor: s.stroke, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
      sk.push({ type: "text", id: `${pid}:badge-t`, x: bx, y: by, text: s.badge, fontSize: 17, strokeColor: "#ffffff" });
    }
    const out = this.convert(sk);
    const group = [`g:${pid}`];
    for (const e of out) {
      e.groupIds = group;
      if (e.id === `${pid}:label`) e.x = labelAt[0] - e.width / 2;
      if (e.id === `${pid}:libs`) e.x = ox + IW / 2 - e.width / 2;
      const c = centers[e.id];
      if (c) [e.x, e.y] = [c[0] - e.width / 2, c[1] - e.height / 2];
      if (e.id === `${pid}:badge-t`) {
        e.x = bx + 14 - e.width / 2;
        e.y = by + 14 - e.height / 2;
      }
    }
    return out;
  }

  addNode({ id, name, kind = "service", col = 0, row = 0, status, v, libs, api, paths, layer }) {
    if (!id) return [];
    const existing = this.model.nodes[id];
    if (existing) {
      // Repeating a node op fills in its details (libraries, APIs, files, layer) as the agent learns them.
      const relayer = layer != null && layer !== existing.layer;
      if (layer != null) existing.layer = layer;
      if (libs != null) existing.libs = list(libs);
      if (api != null) existing.api = list(api);
      if (paths != null) existing.paths = list(paths);
      if (libs != null || relayer) this.redrawNode(id); // the libraries under it, or its layer's plate
      if (paths != null) this.attributeChanges();
      return [`node:${id}`];
    }
    if (!name) return [];
    const cell = this.freeCell(col, row);
    const st = STATUS[v] ? v : STATUS[status] ? status : "planned";
    const node = {
      id, name: sentenceCase(name), kind: KINDS.includes(kind) ? kind : "service", status: st, elId: `node-${id}`, cell,
      libs: list(libs), api: list(api), paths: list(paths), layer: layer ?? null,
    };
    this.model.nodes[id] = node;
    const fresh = this.remember(this.drawNode(node, NX0 + cell[0] * COL, NY0 + cell[1] * ROW));
    this.commit([...this.scene(), ...fresh]);
    if (this.changes.length) this.attributeChanges();
    this.renumber();
    this.redrawKey();
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
    const off = shapeOf(node.style ?? "pictures", node.kind);
    const ox = at?.ox ?? main.x - off.x, oy = at?.oy ?? main.y - off.y;
    // Keep a rename the user typed but hasn't sent yet.
    const label = els.find((e) => e.id === `${node.elId}:label` && !e.isDeleted);
    const pending = label && firstLine(label.text) !== node.name ? label.text : undefined;
    const mine = (e) => e.id === node.elId || e.id.startsWith(`${node.elId}:`) || e.containerId === node.elId;
    this.replace(mine, this.drawNode(node, ox, oy, pending));
    // Decisions pinned to this component follow it if it moved.
    if (Object.values(this.model.decisions).some((d) => d.affects.includes(nodeId))) this.redrawDecisions();
  }

  // ---- what the run changed in the repo ----
  // files: [{ path, add, del, patch }] from git (server/changes.js), or the demo's script.
  setChanges(files) {
    this.changes = files ?? [];
    this.attributeChanges();
  }

  // Which component owns a repo file, by its declared paths (longest prefix wins, as on the server).
  ownerOf(file) {
    let best = null, len = -1;
    for (const n of Object.values(this.model.nodes))
      for (const p of n.paths ?? []) {
        const prefix = p.replace(/^\.\//, "").replace(/\/+$/, "");
        if ((file === prefix || file.startsWith(`${prefix}/`)) && prefix.length > len) [best, len] = [n.id, prefix.length];
      }
    return best;
  }

  // Each component's share of the changes (redrawn when it moves), and the files no component owns.
  attributeChanges() {
    const per = {};
    this.model.unowned = [];
    for (const f of this.changes) {
      const owner = this.ownerOf(f.path);
      if (!owner) this.model.unowned.push(f);
      else {
        const d = (per[owner] ??= { add: 0, del: 0, files: [] });
        d.add += f.add;
        d.del += f.del;
        d.files.push(f.path);
      }
    }
    for (const n of Object.values(this.model.nodes)) {
      const d = per[n.id] ?? null;
      const sig = d ? `${d.add}/${d.del}/${d.files.join()}` : "";
      if (sig === (n.diffSig ?? "")) continue;
      Object.assign(n, { diff: d, diffSig: sig });
      this.redrawNode(n.id);
    }
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
    if (changed && this.alt?.did === id) this.hideAlternatives(); // the pick landed
    this.redrawDecisions();
    return [`decision:${id}`];
  }

  // ---- questions for you, and the assumptions it's working from ----
  // { id, kind: "question" | "assumption", n, text, options[], about, state, answer }
  // state: open, then answered (a question) or confirmed / corrected (an assumption).
  setQuestion({ op, id, text, options, about, state, answer }) {
    if (!id) return [];
    const m = this.model;
    const prev = m.questions[id];
    if (!prev && !text) return [];
    const kind = prev?.kind ?? (op === "assumption" ? "assumption" : "question");
    const q = (m.questions[id] = {
      id,
      kind,
      n: prev?.n ?? Object.values(m.questions).filter((x) => x.kind === kind).length + 1,
      text: text ?? prev.text,
      options: options != null ? list(options) : prev?.options ?? [],
      about: about ?? prev?.about ?? null,
      state: QSTATES.includes(state) ? state : prev?.state ?? "open",
      answer: answer ?? prev?.answer ?? null,
      elId: prev?.elId ?? `q-${id}`,
      slot: prev?.slot ?? this.noteSlot++,
    });
    this.drawQuestion(q);
    return [`question:${id}`];
  }

  // A sticky in the notes column: the question (and its answer), a badge for what it is or that it's settled.
  drawQuestion(q) {
    const st = QSTYLE[q.kind];
    const x = NOTE_X, y = NOTE_Y + q.slot * 70, g = [`g:${q.elId}`];
    const settled = q.state === "answered" || q.state === "confirmed";
    const badge = settled ? "#2f9e44" : q.state === "corrected" ? "#1971c2" : st.stroke;
    const out = this.convert([
      {
        type: "rectangle", id: q.elId, x, y, width: 210, height: 56, strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid",
        strokeWidth: 1, strokeStyle: q.state === "open" && q.kind === "assumption" ? "dashed" : "solid", roughness: this.official ? 0 : 1, roundness: this.official ? null : { type: 3 },
        label: { text: clip(q.answer ? `${q.text} → ${q.answer}` : q.text, 76), fontSize: 14, strokeColor: q.state === "corrected" ? MUTED : INK, ...this.font() },
      },
      { type: "ellipse", id: `${q.elId}:b`, x: x - 12, y: y - 12, width: 24, height: 24, strokeColor: badge, backgroundColor: badge, fillStyle: "solid", strokeWidth: 1, roughness: 0 },
      { type: "text", id: `${q.elId}:g`, x, y, text: settled ? "✓" : q.state === "corrected" ? "↻" : st.glyph, fontSize: 15, strokeColor: "#ffffff" },
      // The agent's notes are pinned up; yours are taped (tapeNotes). The flat official styles skip both.
      ...(this.official ? [] : pinParts(q.elId, x + 105, y)),
    ]);
    for (const e of out) {
      e.groupIds = g;
      if (e.id === `${q.elId}:g`) [e.x, e.y] = [x - e.width / 2, y - e.height / 2];
    }
    this.replace((e) => e.id === q.elId || e.id.startsWith(`${q.elId}:`) || e.containerId === q.elId, out);
  }

  // ---- choosing a decision on the board ----
  // Selecting a diamond fans its alternatives out to its right as ghost pills, plus a blank one
  // to write your own. Drop one on the diamond and it's the pick: it settles beside it, solid,
  // the rest go, and diff() reports a "choose" edit. Delete it (or select the diamond) to undo.
  showAlternatives(did) {
    if (this.alt?.did === did && this.alt.picked == null) return;
    this.hideAlternatives();
    const d = this.model.decisions[did];
    const dia = this.api.getSceneElements().find((e) => e.id === `dec-${did}`);
    if (!d || !dia || d.state === "rejected") return;
    const options = [...d.over.slice(0, 3), ""];
    const labels = options.map((o) => (o ? clip(o, 24) : "+ your own"));
    const W = 176, H = 30, GAP = 6;
    const x = dia.x + dia.width + 14, y0 = dia.y + dia.height / 2 - (options.length * (H + GAP) - GAP) / 2;
    const out = this.remember(
      this.convert(
        options.map((o, i) => ({
          type: "rectangle", id: `alt-${did}-${i}`, x, y: y0 + i * (H + GAP), width: W, height: H,
          strokeColor: DECISION.proposed.stroke, backgroundColor: "#ffffff", fillStyle: "solid", strokeStyle: "dashed", ...this.look(1.5), roundness: this.official ? null : { type: 3 },
          label: { text: labels[i], fontSize: 13, strokeColor: o ? INK : MUTED, ...this.font() },
        })),
      ),
    );
    for (const e of out) e.seed = seedOf(e.id);
    this.alt = { did, ids: options.map((_, i) => `alt-${did}-${i}`), options, labels, picked: null };
    this.commit([...this.scene(), ...out]);
  }

  hideAlternatives() {
    if (!this.alt) return;
    const els = this.scene();
    this.kill(els, new Set(this.alt.ids));
    this.alt = null;
    this.commit(els);
  }

  // What ghost i says: the option, or what you typed over it (blank if you left "+ your own" as is).
  altText(i, els = this.scene()) {
    const a = this.alt;
    const label = els.find((t) => t.containerId === a.ids[i] && !t.isDeleted);
    const typed = firstLine(label?.originalText ?? label?.text);
    return typed && typed !== a.labels[i] ? typed : a.options[i];
  }

  // Make ghost i the pick: beside the diamond, solid in the "changed" color; the others go.
  settle(i) {
    const a = this.alt, els = this.scene();
    const dia = els.find((e) => e.id === `dec-${a.did}` && !e.isDeleted);
    const g = els.find((e) => e.id === a.ids[i] && !e.isDeleted);
    if (!dia || !g) return;
    const dx = dia.x + dia.width + 8 - g.x, dy = dia.y + dia.height / 2 - g.height / 2 - g.y;
    const c = DECISION.changed;
    for (const [k, e] of els.entries()) {
      if (e.id === g.id) els[k] = bump(e, { x: e.x + dx, y: e.y + dy, strokeStyle: "solid", strokeColor: c.stroke, backgroundColor: c.fill });
      else if (e.containerId === g.id) els[k] = bump(e, { x: e.x + dx, y: e.y + dy, strokeColor: c.stroke });
    }
    this.kill(els, new Set(a.ids.filter((id) => id !== g.id)));
    a.picked = i;
    this.commit(els);
  }

  // After a drag: a ghost (with something to say) dropped on its diamond becomes the pick.
  settlePick() {
    const a = this.alt;
    if (!a || a.picked != null) return;
    const els = this.scene();
    const dia = els.find((e) => e.id === `dec-${a.did}` && !e.isDeleted);
    const i = a.ids.findIndex((id, k) => {
      const g = els.find((e) => e.id === id && !e.isDeleted);
      return g && dia && overlaps(g, dia, 6) && this.altText(k, els);
    });
    if (i !== -1) this.settle(i);
  }

  // Pick alternative i from outside the board (the Plan tab).
  pickAlternative(did, i) {
    this.hideAlternatives();
    this.showAlternatives(did);
    if (this.alt?.did === did) this.settle(i);
  }

  // The pick, as a "choose" edit, while it's still by its diamond.
  choice(els = this.scene()) {
    const a = this.alt, d = a && this.model.decisions[a.did];
    if (!d || a.picked == null) return null;
    const dia = els.find((e) => e.id === `dec-${d.id}` && !e.isDeleted);
    const g = els.find((e) => e.id === a.ids[a.picked] && !e.isDeleted);
    const to = g && dia && overlaps(g, dia, 40) && this.altText(a.picked, els);
    return to && to !== d.chose ? { key: `choose:${d.id}:${to}`, kind: "choose", decision: d.id, label: `D${d.n}`, title: d.title, from: d.chose, to } : null;
  }

  // The selection changed: a diamond shows its alternatives; they go away once you click elsewhere,
  // unless you're moving or typing in one, or there's a pick waiting to be sent.
  onSelect(ids, st = {}) {
    if (st.editingTextElement || st.selectedElementsAreBeingDragged) return;
    if (this.tips && ids.some((id) => this.tips.includes(id))) return this.hideTips(); // clicking a tip dismisses them
    const did = this.logicalIdsFor(ids).find((l) => l.startsWith("decision:"))?.slice("decision:".length);
    if (did) return this.showAlternatives(did);
    if (!this.alt) return;
    const els = this.scene();
    const ghost = (id) => this.alt.ids.includes(id) || els.some((e) => e.id === id && this.alt.ids.includes(e.containerId));
    if (ids.some(ghost) || this.choice(els)) return;
    this.hideAlternatives();
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
      sk.push({ type: "diamond", id: `dec-${d.id}`, x, y, width: DW, height: DW, strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", strokeStyle: st.dash, ...this.look(2), groupIds: g });
      sk.push({ type: "text", id: `dec-${d.id}-t`, x, y, text: `D${d.n}`, fontSize: 14, strokeColor: st.stroke, groupIds: g, ...this.font() });
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
        sk.push(poly(`dec-${d.id}-l${i}`, [[cx, cy], [ex, ey]], { strokeColor: st.stroke, strokeStyle: "dotted", ...this.look(1.5), opacity: 55, locked: true }));
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

  // ---- the Timeline canvas: how the decisions moved over the run ----
  // events: the run's timed events; now: where the board is in them (a replay's position).
  redrawTimeline(events, { now } = {}) {
    if (!this.timelineApi) return;
    const tl = (this.tl = buildTimeline(events, this.model));
    this.tlNow = now ?? tl.end;
    const sk = drawTimeline(tl, now == null ? {} : { now });
    // Text centered on its point once measured; seeds from ids, so redraws never re-wobble.
    const at = new Map();
    const out = this.convert(sk.map(({ _c, ...e }) => (_c && at.set(e.id, _c), e)));
    for (const e of out) {
      const c = at.get(e.id);
      if (c) {
        e.x = c[0] - e.width / 2;
        e.y = c[1] - e.height / 2;
      }
      e.seed = seedOf(e.id);
    }
    const marks = this.timelineApi.getSceneElements().filter((e) => e.id.startsWith(MARK));
    this.replace(() => true, [...out, ...marks], this.timelineApi);
    this.tlHlSig = null; // repaint: lanes may have moved under their marks, or gone
    this.refreshMarkers();
    // Keep the whole run in view as it grows, unless the user has panned or zoomed.
    const frame = out.find((e) => e.id === "tl:frame");
    const size = frame ? `${Math.round(frame.width)}x${Math.round(frame.height)}` : "";
    if (size !== this.tlFrame && this.view === "timeline" && this.tlFollow) this.fitTimeline();
    this.tlFrame = size;
    if (this.tlPoint && this.view === "timeline") this.glide(this.timelineApi, (l) => this.timelineMarkFor(l), this.tlPoint.lids, this.tlPoint.ms);
    this.tlPoint = null;
  }

  fitTimeline(animate = false) {
    const els = this.timelineApi?.getSceneElements() ?? [];
    if (els.length) this.timelineApi.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.95, animate });
  }

  // What a point on the Timeline canvas (scene coordinates) is over: the moment it stands
  // for (t, ms), the decision it belongs to (lids), your message (msg) or the test run (tool).
  timelineHit(x, y) {
    const tl = this.tl;
    if (!tl?.segments.length) return null;
    const pad = 5;
    const near = (e) => x >= e.x - pad && x <= e.x + e.width + pad && y >= e.y - pad && y <= e.y + e.height + pad;
    const els = this.timelineApi.getSceneElements().filter((e) => /^tl:[ykmr]:/.test(e.id) && e.type !== "arrow" && near(e));
    els.sort((a, b) => a.width * a.height - b.width * b.height);
    const at = x >= TL.X0 - 6 ? Math.max(0, xToTime(tl, x)) : null; // left of the axis are the lane labels
    if (!els.length) return { t: at, lids: [] };
    const [, part, a, b] = els[0].id.split(":");
    const lane = tl.lanes[+a];
    switch (part) {
      case "y": {
        const y = tl.you[+a];
        return { t: y.t, lids: y.target ? [`decision:${y.target}`] : [], msg: y.msg ?? null };
      }
      case "k":
        return { t: tl.tests[+a].t, lids: [], tool: tl.tests[+a].toolUseId };
      case "m":
        return { t: lane.marks[+b].t, lids: [`decision:${lane.id}`] };
      default:
        return { t: at, lids: [`decision:${lane.id}`] };
    }
  }

  // The Timeline element for a logical id: a decision is its lane's title, a phase its band.
  timelineElementFor(lid) {
    const [k, v] = lid.split(":");
    const i = k === "decision" ? this.tl?.lanes.findIndex((l) => l.id === v) : k === "phase" ? this.tl?.phases.findIndex((p) => p.key === v) : -1;
    if (i == null || i === -1) return null;
    return k === "decision" ? `tl:l:${i}:t` : `tl:p:${i}`;
  }

  // A decision's newest mark on its lane (up to the now line), where the agent's cursor goes.
  timelineMarkFor(lid) {
    const [k, v] = lid.split(":");
    const i = k === "decision" ? this.tl?.lanes.findIndex((l) => l.id === v) : -1;
    const m = i == null || i === -1 ? -1 : this.tl.lanes[i].marks.findLastIndex((m) => m.t <= this.tlNow + 5);
    return m === -1 ? null : `tl:m:${i}:${m}`;
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
    node.name = sentenceCase(name);
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
    const edge = { from, to, elId: `edge-${from}-${to}`, via: via ?? null, api: api ?? null, async };
    if (!this.drawEdge(edge, els)) return [];
    this.model.edges[key] = edge;
    this.commit(els);
    return [`edge:${key}`];
  }

  // An edge's arrow between its two hit-boxes, into els (replacing an earlier drawing of it).
  drawEdge(edge, els) {
    const { via, async } = edge;
    const A = this.model.nodes[edge.from], B = this.model.nodes[edge.to];
    const ai = els.findIndex((e) => e.id === A?.elId && !e.isDeleted), bi = els.findIndex((e) => e.id === B?.elId && !e.isDeleted);
    if (ai === -1 || bi === -1) return false;
    const a = els[ai], b = els[bi];
    const dx = b.x + b.width / 2 - (a.x + a.width / 2);
    const dy = b.y + b.height / 2 - (a.y + a.height / 2);
    const p1 = edgePoint(a, dx, dy, 4), p2 = edgePoint(b, -dx, -dy, 4);
    const id = edge.elId;
    // Only a short protocol tag, and only where it fits between the boxes.
    // On the link: its protocol, short; in a data flow diagram, as much of the data it carries as
    // fits (the rest is in the Plan tab and the exports), else its protocol.
    const dfd = this.style === "dfd";
    const room = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) - 30;
    const fits = Math.floor(room / (dfd ? 6.4 : 7.5));
    const word = dfd ? (fits >= 8 ? clip(dataOf(edge), Math.min(fits, 30)) : tagCase(via) ?? "") : via && via.length <= 8 ? tagCase(via) : "";
    const tag = word && word.length <= fits ? word : null;
    // convertToExcalidrawElements only binds arrows to shapes in the same batch,
    // so pass geometry-only proxies of both ends and keep just the arrow.
    const proxy = (e) => ({ type: e.type, id: e.id, x: e.x, y: e.y, width: e.width, height: e.height });
    const out = this.convert([
      proxy(a), proxy(b),
      {
        type: "arrow", id, x: p1[0], y: p1[1],
        points: [[0, 0], [p2[0] - p1[0], p2[1] - p1[1]]],
        strokeColor: "#495057", ...this.look(2), strokeStyle: async ? "dashed" : "solid",
        start: { id: a.id }, end: { id: b.id },
        ...(tag ? { label: { text: tag, fontSize: dfd ? 12 : 13, strokeColor: MUTED, ...this.font() } } : {}),
      },
    ]);
    const arrow = out.find((e) => e.id === id);
    const text = out.find((e) => e.containerId === id);
    const bind = (e) => bump(e, { boundElements: [...(e.boundElements || []).filter((x) => x.id !== id), { type: "arrow", id }] });
    els[ai] = bind(a);
    els[bi] = bind(b);
    this.upsert(els, text ? [arrow, text] : [arrow]);
    return true;
  }

  // Redraw every arrow from the hit-boxes as they are now (after the drawing style changed).
  // An arrow you deleted stays deleted: that's an unlink waiting to be sent.
  redrawEdges() {
    const els = this.scene();
    const edges = Object.values(this.model.edges).filter((e) => els.some((x) => x.id === e.elId && !x.isDeleted));
    // Their old labels go; drawEdge makes new ones.
    this.kill(els, new Set(els.filter((x) => edges.some((e) => x.containerId === e.elId)).map((x) => x.id)));
    for (const e of edges) this.drawEdge(e, els);
    this.commit(els);
  }

  // Pictures or C4: redraw the components, then their arrows and diamonds, in the new style.
  setStyle(style) {
    const next = ["c4", "dfd"].includes(style) ? style : "pictures";
    if (next === this.style) return;
    this.style = next;
    this.hideAlternatives();
    for (const id of Object.keys(this.model.nodes)) this.redrawNode(id);
    this.redrawEdges();
    this.redrawDecisions();
    for (const q of Object.values(this.model.questions)) this.drawQuestion(q);
    this.tapeNotes();
    this.redrawKey();
    this.drawFlowSteps();
    this.drawExplode();
  }

  // ---- layers and flows: narrow the board to one ----
  // A flow: the steps a request takes through the components, in order (from the agent's
  // flow op: "web>api: POST /ask", …).
  setFlow({ id, name, steps }) {
    if (!id) return [];
    const prev = this.model.flows[id];
    const parsed = steps != null ? parseSteps(steps) : prev?.steps ?? [];
    if (!prev && !parsed.length) return [];
    this.model.flows[id] = { id, n: prev?.n ?? Object.keys(this.model.flows).length + 1, name: sentenceCase(name ?? prev?.name ?? id), steps: parsed };
    if (this.focus?.flow === id) this.setFocus(this.focus);
    return [`flow:${id}`];
  }

  // { layer: "ml" }, { flow: "ask" }, or null for the whole board.
  // { layer, explode: true } opens the layer up in place (drawExplode) and frames it.
  setFocus(focus) {
    const was = this.focus;
    this.focus = focus?.layer || focus?.flow ? focus : null;
    this.hideAlternatives();
    this.drawFlowSteps();
    this.drawExplode();
    const opened = (f) => (f?.explode ? f.layer : null);
    if (opened(was) !== opened(this.focus)) this.fitFocus(true);
  }

  // ---- a layer opened up: its components' parts burst out around them (explode.js) ----
  // Drawn on this canvas, in place: nothing moves, the rest of the board fades, and the parts
  // are the board's own drawing (remembered, so diff() skips them). Redrawn when the model or
  // the drawing style changes; skipped when nothing it shows did.
  drawExplode() {
    const layer = this.focus?.explode ? this.focus.layer : null;
    const els = this.scene();
    const live = els.filter((e) => !e.isDeleted);
    const boxes = {};
    for (const n of Object.values(this.model.nodes)) {
      const b = live.find((e) => e.id === n.elId);
      if (b) boxes[n.id] = { x: b.x, y: b.y, w: b.width, h: b.height };
    }
    const groups = layer ? explodeOf(this.model, layer) : [];
    const sig = layer ? JSON.stringify([layer, this.style, groups, boxes]) : "";
    if (sig === this.exSig) return;
    this.exSig = sig;
    this.kill(els, new Set(els.filter((e) => e.id.startsWith("ex:")).map((e) => e.id)));
    // Keep clear of the notes column and the key, too.
    const obstacles = live
      .filter((e) => e.id.startsWith("key:") || Object.values(this.model.questions).some((q) => q.elId === e.id) || this.model.notes.some((n) => n.elId === e.id))
      .map((e) => ({ x: e.x, y: e.y, w: e.width, h: e.height }));
    const items = explodeLayout(groups, boxes, obstacles);
    const centers = new Map();
    const out = this.convert(explodeSkeletons(items, { look: this.look(2), font: this.font() }).map(({ _c, ...e }) => (_c && centers.set(e.id, _c), e)));
    for (const e of out) {
      const c = centers.get(e.id);
      if (c) [e.x, e.y] = [c[0] - e.width / 2, c[1] - e.height / 2];
      e.groupIds = [`g:${e.id.split(":").slice(0, 2).join(":")}`];
      e.seed = seedOf(e.id);
    }
    this.commit([...els, ...this.remember(out)]);
  }

  // Frame what the focus keeps (an opened layer and its parts), or the whole board.
  fitFocus(animate = false) {
    const keep = this.focusSet();
    if (!keep) return this.api.scrollToContent(this.api.getSceneElements(), { fitToViewport: true, viewportZoomFactor: 0.94, animate });
    const els = this.api.getSceneElements().filter((e) => e.id.startsWith("ex:") || keep.nodes.has(this.nodeByEl(e.id)?.id));
    if (!els.length) return;
    // A layer of one small part would fill the screen: frame at least a board's worth around it.
    const [x1, y1, x2, y2] = getCommonBounds(els);
    const w = Math.max(x2 - x1, 820), h = Math.max(y2 - y1, 520);
    const frame = { ...els[0], id: "fit-frame", x: (x1 + x2) / 2 - w / 2, y: (y1 + y2) / 2 - h / 2, width: w, height: h, angle: 0, type: "rectangle", points: undefined };
    this.api.scrollToContent([frame], { fitToViewport: true, viewportZoomFactor: 0.86, animate });
  }

  // A focused flow's steps as numbered dots along its links, in order; a step with no link drawn
  // gets a thin dashed arrow of its own. Several steps on one link spread out along it.
  drawFlowSteps() {
    const els = this.scene();
    this.kill(els, new Set(els.filter((e) => e.id.startsWith("flow:")).map((e) => e.id)));
    const flow = this.model.flows[this.focus?.flow];
    const sk = [];
    const centers = {};
    if (flow) {
      const box = (id) => els.find((e) => e.id === this.model.nodes[id]?.elId && !e.isDeleted);
      const along = {}; // edge element id (or pair) -> step indexes on it
      const segs = flow.steps.map((st, i) => {
        const e = this.model.edges[`${st.from}>${st.to}`] ?? this.model.edges[`${st.to}>${st.from}`];
        const arrow = e && els.find((x) => x.id === e.elId && !x.isDeleted);
        if (arrow) {
          const [[x0, y0], [x1, y1]] = [arrow.points[0], arrow.points.at(-1)].map(([px, py]) => [arrow.x + px, arrow.y + py]);
          (along[arrow.id] ??= []).push(i);
          return { key: arrow.id, a: [x0, y0], b: [x1, y1], reverse: e.from !== st.from };
        }
        const A = box(st.from), B = box(st.to);
        if (!A || !B) return null;
        const dx = B.x + B.width / 2 - (A.x + A.width / 2), dy = B.y + B.height / 2 - (A.y + A.height / 2);
        const a = edgePoint(A, dx, dy, 4), b = edgePoint(B, -dx, -dy, 4);
        sk.push({ type: "arrow", id: `flow:${flow.id}:a${i}`, x: a[0], y: a[1], points: [[0, 0], [b[0] - a[0], b[1] - a[1]]], strokeColor: "#1971c2", strokeStyle: "dashed", ...this.look(1.5), endArrowhead: "arrow", locked: true });
        (along[`pair${i}`] ??= []).push(i);
        return { key: `pair${i}`, a, b };
      });
      segs.forEach((g, i) => {
        if (!g) return;
        const on = along[g.key], k = on.indexOf(i);
        // Near the link's ends, clear of its tag in the middle: one step by where it starts, several spread end to end.
        const t = on.length === 1 ? (g.reverse ? 0.82 : 0.18) : 0.18 + (0.64 * k) / (on.length - 1);

        const [cx, cy] = [g.a[0] + (g.b[0] - g.a[0]) * t, g.a[1] + (g.b[1] - g.a[1]) * t];
        const D = 24;
        sk.push({ type: "ellipse", id: `flow:${flow.id}:${i}`, x: cx - D / 2, y: cy - D / 2, width: D, height: D, strokeColor: "#1971c2", backgroundColor: "#1971c2", fillStyle: "solid", strokeWidth: 1, roughness: 0, locked: true });
        sk.push({ type: "text", id: `flow:${flow.id}:${i}t`, x: cx, y: cy, text: String(i + 1), fontSize: 14, strokeColor: "#ffffff", fontFamily: SANS, locked: true });
        centers[`flow:${flow.id}:${i}t`] = [cx, cy];
      });
    }
    const out = this.remember(this.convert(sk));
    for (const e of out) {
      e.seed = seedOf(e.id);
      const c = centers[e.id];
      if (c) [e.x, e.y] = [c[0] - e.width / 2, c[1] - e.height / 2];
    }
    this.commit([...els, ...out]);
  }

  // ---- the data model: tables held by the data stores ----
  // { id, name, of (the data component), columns: [{ name, type, pk, unique, fk: { table, col } }] }
  setTable({ id, name, of, columns }) {
    const key = id || name;
    if (!key) return [];
    const prev = this.model.tables[key];
    this.model.tables[key] = { id: key, name: name ?? prev?.name ?? key, of: of ?? prev?.of ?? null, columns: columns != null ? parseColumns(columns) : prev?.columns ?? [] };
    return [`table:${key}`, ...(this.model.tables[key].of ? [`node:${this.model.tables[key].of}`] : [])];
  }

  // ---- inside a component: its parts (the "Look inside" layer views) ----
  // { id, of (the component), name, kind (route, page, job, step, model…), layer (when not its
  // component's: an embedding step in a worker is ml), links: [{ to: part, table or component, what }] }
  setPart({ id, of, name, kind, layer, links }) {
    if (!id) return [];
    const prev = this.model.parts[id];
    if (!prev && (!of || !name)) return [];
    this.model.parts[id] = {
      id, n: prev?.n ?? Object.keys(this.model.parts).length + 1, of: of ?? prev.of, name: name ?? prev.name,
      kind: kind ?? prev?.kind ?? "", layer: layer ?? prev?.layer ?? null, links: links != null ? parseLinks(links) : prev?.links ?? [],
    };
    return [`part:${id}`, `node:${this.model.parts[id].of}`];
  }

  // Data-flow numbering follows the grid, so a new or removed component can shift the others'.
  renumber() {
    if (this.style !== "dfd") return;
    const ids = dfdIds(this.model);
    for (const n of Object.values(this.model.nodes)) if ((n.dfdId ?? "") !== (ids[n.id] ?? "")) this.redrawNode(n.id);
  }

  // ---- the diagram canvas: the data model (ER), a flow as a sequence diagram, or inside a layer ----
  // Read-only, drawn from the model; redrawn only when what it shows changes, and refit when the
  // diagram itself changes (not on every redraw, so a pan or zoom holds).
  // `flowId` is the flow for a sequence diagram, the layer for inside.
  drawDiagram(kind, flowId) {
    if (!this.diagramApi) return;
    const flow = this.model.flows[flowId] ?? Object.values(this.model.flows)[0];
    const sk = this.diagramSkeleton(kind, flowId);
    const sig = JSON.stringify(sk);
    const which = `${kind}:${kind === "sequence" ? flow?.id : kind === "inside" ? flowId : ""}`;
    if (sig === this.diagramSig && which === this.diagramWhich) return;
    const refit = which !== this.diagramWhich || !this.diagramSig;
    this.diagramSig = sig;
    this.diagramWhich = which;
    const out = this.diagramScene(kind, flowId, sk);
    this.diagramApi.updateScene({ elements: out, captureUpdate: CaptureUpdateAction.NEVER });
    if (refit && out.length) setTimeout(() => this.diagramApi.scrollToContent(out, { fitToViewport: true, viewportZoomFactor: 0.9 }), 40);
  }

  // A diagram from the model: kind "er", "sequence" (arg: the flow id, else the first flow) or
  // "inside" (arg: the layer). The skeleton, then the elements: the diagram canvas draws these,
  // and so does a view pinned beside the board.
  diagramSkeleton(kind, arg) {
    const flow = this.model.flows[arg] ?? Object.values(this.model.flows)[0];
    return kind === "er" ? drawEr(this.model) : kind === "sequence" ? drawSequence(this.model, flow) : kind === "inside" ? drawInside(this.model, arg) : [];
  }
  diagramScene(kind, arg, sk = this.diagramSkeleton(kind, arg)) {
    const at = new Map(), right = new Map();
    const out = this.convert(sk.map(({ _c, _r, ...e }) => (_c && at.set(e.id, _c), _r != null && right.set(e.id, _r), e)));
    for (const e of out) {
      const c = at.get(e.id);
      if (c) [e.x, e.y] = [c[0] - e.width / 2, c[1] - e.height / 2];
      if (right.has(e.id)) e.x = right.get(e.id) - e.width;
      e.seed = seedOf(e.id);
    }
    return out;
  }

  // The diagram canvas for export, with a title above it.
  diagramElements(title) {
    const els = this.diagramApi?.getSceneElements() ?? [];
    if (!title || !els.length) return els;
    const [x1, y1] = getCommonBounds(els);
    return [...els, ...this.convert([{ type: "text", id: "export:title", x: x1, y: y1 - 46, text: title, fontSize: 22, strokeColor: INK, fontFamily: SANS }])];
  }

  // The official style's key, under the diagram: what the colors and lines mean.
  redrawKey() {
    const els = this.scene();
    this.kill(els, new Set(els.filter((e) => e.id.startsWith("key:")).map((e) => e.id)));
    const boxes = Object.values(this.model.nodes).map((n) => els.find((e) => e.id === n.elId && !e.isDeleted)).filter(Boolean);
    if (!this.official || !boxes.length) return this.commit(els);
    const x0 = Math.min(...boxes.map((b) => b.x));
    let y = Math.max(...boxes.map((b) => b.y + b.height)) + 44;
    const sk = [{ type: "text", id: "key:title", x: x0, y: y - 2, text: "Key", fontSize: 13, strokeColor: INK, fontFamily: SANS }];
    let x = x0 + 42;
    const label = (id, text) => {
      sk.push({ type: "text", id, x, y: y - 1, text, fontSize: 12, strokeColor: MUTED, fontFamily: SANS });
      x += text.length * 6.6 + 18;
    };
    // Data flow: the notation's shapes on a row of their own, then what the colors mean.
    if (this.style === "dfd") {
      const ink = { strokeColor: "#495057", backgroundColor: "#f8f9fa", fillStyle: "solid", strokeWidth: 1, roughness: 0 };
      sk.push({ type: "rectangle", id: "key:proc", x, y: y - 2, width: 26, height: 18, ...ink, roundness: { type: 3 } });
      x += 32;
      label("key:proc:t", "Process");
      sk.push(poly("key:store", [[x + 26, y - 1], [x, y - 1], [x, y + 15], [x + 26, y + 15]], { strokeColor: "#495057", strokeWidth: 1, roughness: 0 }));
      x += 32;
      label("key:store:t", "Data store");
      sk.push({ type: "rectangle", id: "key:ent:s", x: x + 3, y: y + 1, width: 24, height: 16, strokeColor: "transparent", backgroundColor: "#ced4da", fillStyle: "solid", strokeWidth: 1, roughness: 0 });
      sk.push({ type: "rectangle", id: "key:ent", x, y: y - 2, width: 24, height: 16, ...ink });
      x += 32;
      label("key:ent:t", "External entity");
      sk.push({ type: "arrow", id: "key:flow", x, y: y + 7, points: [[0, 0], [26, 0]], strokeColor: "#495057", strokeWidth: 1, roughness: 0, endArrowhead: "arrow" });
      x += 32;
      label("key:flow:t", "Data flow");
      x = x0 + 42;
      y += 26;
    }
    for (const [k, st] of Object.entries(STATUS)) {
      sk.push({ type: "rectangle", id: `key:${k}`, x, y, width: 14, height: 14, strokeColor: st.stroke, backgroundColor: st.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
      x += 20;
      label(`key:${k}:t`, k[0].toUpperCase() + k.slice(1));
    }
    for (const [k, dash] of this.style === "dfd" ? [] : [["sync", "solid"], ["async", "dashed"]]) {
      sk.push({ type: "line", id: `key:${k}`, x, y: y + 7, points: [[0, 0], [26, 0]], strokeColor: "#495057", strokeStyle: dash, strokeWidth: 1, roughness: 0 });
      x += 32;
      label(`key:${k}:t`, k === "sync" ? "Synchronous" : "Asynchronous");
    }
    sk.push({ type: "diamond", id: "key:dec", x, y: y - 2, width: 18, height: 18, strokeColor: DECISION.accepted.stroke, backgroundColor: DECISION.accepted.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0 });
    x += 24;
    label("key:dec:t", "Decision");
    // The layers on the board: the plate colors.
    const used = LAYERS.filter((l) => Object.values(this.model.nodes).some((n) => layerOf(n) === l.key));
    if (used.length) {
      x = x0 + 42;
      y += 26;
      for (const l of used) {
        const c = LAYER_COLOR[l.key];
        sk.push({ type: "rectangle", id: `key:layer:${l.key}`, x, y, width: 14, height: 14, strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid", strokeWidth: 1, roughness: 0, roundness: { type: 3 } });
        x += 20;
        label(`key:layer:${l.key}:t`, l.label);
      }
    }
    const out = this.remember(this.convert(sk.map((e) => ({ ...e, locked: true }))));
    for (const e of out) e.seed = seedOf(e.id);
    this.commit([...els, ...out]);
  }

  // What to export: the board as it shows (faded where a filter leaves things out), without
  // the highlighter, a decision's open option pills, the coach's tips or the review's red pen.
  // Tape and pins stay: they say whose note is whose.
  exportElements(title) {
    const els = this.api.getSceneElements().filter((e) => !e.id.startsWith(MARK) && e.id !== "frame" && !(this.alt && (this.alt.ids.includes(e.id) || this.alt.ids.includes(e.containerId))) && !this.tips?.includes(e.id) && !e.id.startsWith("pen-"));
    if (!title || !els.length) return els;
    const [x1, y1] = getCommonBounds(els);
    return [...els, ...this.convert([{ type: "text", id: "export:title", x: x1, y: y1 - 46, text: title, fontSize: 22, strokeColor: INK, fontFamily: SANS }])];
  }

  // ---- the coach's tips: circles on the board, the way a teacher circles what to look at ----
  // tips: [{ lid }]. The words stay on the coach's or the tour's card, so the board never asks a
  // second thing. They're the board's own drawing (remembered, so diff() skips them), never
  // exported, and they go when you click one, approve, or hide tips.
  showTips(tips) {
    this.hideTips();
    const els = this.scene();
    const live = els.filter((e) => !e.isDeleted && !e.id.startsWith(MARK) && e.id !== "frame");
    const targets = tips
      .map((t) => live.find((e) => e.id === this.elementFor(t.lid)))
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);
    if (!targets.length) return;
    const out = targets.map((el, i) => {
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      return { type: "ellipse", id: `tip-${i}`, x: x1 - 18, y: y1 - 16, width: x2 - x1 + 36, height: y2 - y1 + 32, strokeColor: TIP_RING, backgroundColor: "transparent", strokeWidth: 2.5, roughness: 2 };
    });
    const conv = this.remember(this.convert(out));
    for (const e of conv) e.seed = seedOf(e.id);
    this.tips = conv.map((e) => e.id);
    this.commit([...els, ...conv]);
  }

  hideTips() {
    if (!this.tips) return;
    const els = this.scene();
    this.kill(els, new Set(this.tips));
    this.tips = null;
    this.commit(els);
  }

  // ---- the review's red pen: what a teacher would mark ----
  // marks: { circles: [{ node, lid }], notes: [{ file, lid }], crosses: [{ decision, lid }] } (review.js
  // penMarks): a rough red ring round the part that owns a file a false claim names, a margin note
  // for such a file no part owns, and a scribbled ✗ over a decision whose check failed. Board-drawn
  // like the tips (pen-*, remembered, on top, never exported); clicking one opens what it marks.
  showPen(marks) {
    const els = this.scene();
    const live = els.filter((e) => !e.isDeleted && !e.id.startsWith(MARK) && e.id !== "frame" && !e.id.startsWith("pen-") && !this.tips?.includes(e.id));
    const at = (id) => live.find((e) => e.id === id);
    const out = [], links = new Map(), centers = {};
    const sigOf = [];
    const mark = (id, lid, parts) => {
      for (const p of parts) {
        p.groupIds = [`g:${id}`];
        links.set(p.id, lid);
      }
      out.push(...parts);
    };
    const pen = { strokeColor: PEN, backgroundColor: "transparent", roughness: 2.5 };
    for (const c of marks?.circles ?? []) {
      const el = at(this.model.nodes[c.node]?.elId);
      if (!el) continue;
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      const id = `pen-c-${c.node}`;
      sigOf.push(`${id}:${x1 | 0}:${y1 | 0}`);
      mark(id, c.lid, [{ type: "ellipse", id, x: x1 - 22, y: y1 - 14, width: x2 - x1 + 40, height: y2 - y1 + 30, strokeWidth: 2.5, ...pen }]);
    }
    for (const c of marks?.crosses ?? []) {
      const el = at(`dec-${c.decision}`);
      if (!el) continue;
      const [x1, y1, x2, y2] = getCommonBounds([el]);
      const id = `pen-x-${c.decision}`, k = 7;
      sigOf.push(`${id}:${x1 | 0}:${y1 | 0}`);
      mark(id, c.lid, [
        poly(id, [[x1 - k, y1 - k], [(x1 + x2) / 2, (y1 + y2) / 2 + 2], [x2 + k, y2 + k]], { strokeWidth: 3, ...pen }),
        poly(`${id}-2`, [[x2 + k, y1 - k + 2], [x1 - k + 2, y2 + k]], { strokeWidth: 3, ...pen }),
      ]);
    }
    // A file no part owns: a note in the margin, under the board, the way a teacher writes beside the work.
    const notes = marks?.notes ?? [];
    if (notes.length && live.length) {
      const [bx, , , by] = getCommonBounds(live);
      notes.forEach((f, i) => {
        const id = `pen-n-${i}`, y = by + 26 + i * 40;
        sigOf.push(`${id}:${f.file}:${bx | 0}:${by | 0}`);
        centers[id] = [bx, y];
        mark(id, f.lid, [
          { type: "text", id, x: bx, y, text: `✗ ${clip(f.file, 30)} · not on the board`, fontSize: 20, strokeColor: PEN },
          poly(`${id}-u`, [[bx, y + 30], [bx + 120, y + 32], [bx + 250, y + 29]], { strokeWidth: 2, ...pen }),
        ]);
      });
    }
    const sig = sigOf.join("|");
    if (sig === (this.pen?.sig ?? "")) return;
    this.hidePen();
    if (!out.length) return;
    const conv = this.remember(this.convert(out));
    for (const e of conv) e.seed = seedOf(e.id);
    // A label measured, its underline fits it.
    for (const e of conv) {
      if (!centers[e.id]) continue;
      const u = conv.find((x) => x.id === `${e.id}-u`);
      if (u) u.points = [[0, 0], [e.width * 0.5, 2], [e.width + 6, -1]];
    }
    this.pen = { ids: conv.map((e) => e.id), links, sig };
    this.commit([...this.scene(), ...conv]);
    // A margin note sits under the board, often out of view: refit so every mark shows.
    const st = this.api.getAppState(), z = st.zoom.value;
    const [x1, y1, x2, y2] = getCommonBounds(conv);
    const vx = -st.scrollX, vy = -st.scrollY, vw = st.width / z, vh = st.height / z;
    if (x1 < vx || y1 < vy || x2 > vx + vw || y2 > vy + vh - 70 / z) // 70 px: the zoom and undo controls
      this.api.scrollToContent(this.api.getSceneElements().filter((e) => !e.id.startsWith(MARK)), { fitToViewport: true, viewportZoomFactor: 0.88, animate: true });
  }

  hidePen() {
    if (!this.pen) return;
    const els = this.scene();
    this.kill(els, new Set(this.pen.ids));
    this.pen = null;
    this.commit(els);
  }

  // The red-pen mark among these element ids, as what it points at (a sentence or a decision).
  penLink(ids) {
    for (const id of ids) if (this.pen?.links.has(id)) return this.pen.links.get(id);
    return null;
  }

  // ---- steering stickers (stickers.js) ----
  // Sent: the agent has them now, so diff() stops reporting them. Once it has answered
  // (settleStickers), Why? and Not needed come off; Keep this stays as a standing constraint.
  markSent(edits) {
    const els = this.scene();
    for (const d of edits) {
      if (d.kind !== "sticker") continue;
      const ids = [d.elId, ...els.filter((e) => e.containerId === d.elId).map((e) => e.id)];
      ids.forEach((id) => this.known.add(id));
      this.stickers.set(d.elId, { sticker: d.sticker, ids });
      if (d.sticker === "keep") (this.model.kept ??= []).push({ elId: d.elId, ...(d.node ? { node: d.node } : { decision: d.decision }) });
    }
  }

  // The turn that answers them is over. They stay on the board with their answers beside them;
  // one it didn't answer on the board gets the start of its reply (fallback) instead.
  settleStickers(fallback) {
    const answered = new Set(this.scene().filter((e) => !e.isDeleted && e.customData?.answers).map((e) => e.customData.answers));
    for (const [el] of this.stickers) if (fallback && !answered.has(el)) this.answerSticker(el, fallback);
    this.stickers.clear();
  }

  // ---- a reply beside what it answers: a speech bubble by the user's sticker ----
  // Drawn on the board (so it pans and zooms with it), grouped, remembered so diff() skips it,
  // and tagged with the sticker it answers (customData.answers); it goes when the sticker does.
  answerSticker(el, text) {
    const els = this.scene();
    const st = els.find((e) => e.id === el && !e.isDeleted);
    if (!st || !text) return [];
    const old = new Set(els.filter((e) => e.customData?.answers === el).map((e) => e.id));
    if (old.size) this.kill(els, old);
    const [, y1, x2, y2] = getCommonBounds([st]);
    const pad = 12, x = x2 + 24, mid = (y1 + y2) / 2, g = [`g:ans-${el}`], tag = { answers: el };
    const [t] = this.convert([{ type: "text", id: `ans-${el}-x`, x: x + pad, y: 0, text: wrapWords(plainWords(text), 30), fontSize: 16, strokeColor: INK, groupIds: g, ...this.font() }]);
    const y = mid - Math.min(24, t.height / 2 + pad);
    const out = this.convert([
      { type: "rectangle", id: `ans-${el}`, x, y, width: t.width + pad * 2, height: t.height + pad * 2, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", strokeWidth: 1.5, roughness: 1, roundness: { type: 3 }, groupIds: g },
      // The tail: a wedge from the bubble's edge to the sticker.
      { type: "line", id: `ans-${el}-t`, x: x + 1, y: mid, points: [[0, -7], [-20, 0], [0, 7]], strokeColor: INK, strokeWidth: 1.5, roughness: 1, groupIds: g },
    ]);
    out.splice(1, 0, { ...t, y: y + pad });
    for (const e of out) Object.assign(e, { customData: tag, seed: seedOf(e.id) });
    this.remember(out);
    this.commit([...els, ...out]);
    return [];
  }

  // A bubble goes when the user deletes the sticker it answers.
  tidyAnswers() {
    const els = this.scene();
    const live = new Set(els.filter((e) => !e.isDeleted).map((e) => e.id));
    const orphans = new Set(els.filter((e) => !e.isDeleted && e.customData?.answers && !live.has(e.customData.answers)).map((e) => e.id));
    if (!orphans.size) return;
    this.kill(els, orphans);
    this.commit(els);
  }

  // The Remove button: delete what's selected as the Delete key would (so it can be undone);
  // diff() then reads it like any other edit. False when nothing is selected.
  deleteSelected() {
    const st = this.api.getAppState();
    const ids = new Set(Object.keys(st.selectedElementIds ?? {}).filter((k) => st.selectedElementIds[k]));
    if (!ids.size) return false;
    const els = this.scene();
    this.kill(els, ids);
    this.api.updateScene({ elements: els, appState: { selectedElementIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    return true;
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
    this.tapeNotes();
    return [`note:${n}`];
  }

  // Your notes are taped to the board; the agent's questions and assumptions are pinned
  // (drawQuestion), so whose note is whose shows at a glance. The tape is grouped with its note,
  // so it moves with it, and it's the board's own drawing (remembered). The official notations
  // (C4, data flow) are flat, so the tape comes off there and back on in Pictures.
  tapeNotes() {
    const els = this.scene();
    const stale = new Set(els.filter((e) => e.id.startsWith("tape-") && !e.isDeleted).map((e) => e.id));
    const fresh = [];
    if (!this.official)
      for (const n of this.model.notes) {
        const i = els.findIndex((e) => e.id === n.elId && !e.isDeleted);
        if (i === -1) continue;
        const id = `tape-${n.elId}`, g = `g:${n.elId}`;
        stale.delete(id);
        const [x1, y1, x2] = getCommonBounds([els[i]]);
        fresh.push({ ...tapePart(id, x1, y1, x2 - x1), groupIds: [g] });
        if (!els[i].groupIds?.includes(g)) els[i] = bump(els[i], { groupIds: [...(els[i].groupIds ?? []), g] });
      }
    this.kill(els, stale);
    const conv = this.convert(fresh);
    for (const e of conv) e.seed = seedOf(e.id);
    this.upsert(els, conv);
    this.commit(els);
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
    this.renumber();
    this.redrawKey();
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
    const cy = shape.y + shape.height / 2;
    const b = shapeOf(this.style, kind);
    const ox = shape.x + shape.width / 2 - IW / 2, oy = this.official ? cy - b.y - b.h / 2 : cy - (IH + 30) / 2;
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
    this.tapeNotes();
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
    // Dragging one of its alternatives onto a diamond picks it.
    const pick = this.choice(els);
    if (pick) out.push(pick);

    for (const [k, e] of Object.entries(this.model.edges)) {
      if (live(e.elId)) continue;
      if (live(this.model.nodes[e.from]?.elId) && live(this.model.nodes[e.to]?.elId))
        out.push({ key: `unlink:${k}`, kind: "unlink", from: e.from, to: e.to, fromName: name(e.from), toName: name(e.to) });
    }

    for (const e of els) {
      if (e.isDeleted || this.known.has(e.id) || e.id.startsWith(MARK)) continue;
      // A sticker from the Library, dropped on a part or a ◇ (stickers.js).
      if (e.customData?.sticker) {
        const st = stickerEdit(e, this.model, live);
        if (st) out.push(st);
        continue;
      }
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
      case "question": return this.model.questions[v]?.elId ?? null;
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
      // An opened-up layer's part: the component it came out of.
      if (id.startsWith("ex:")) {
        const item = id.split(":")[1];
        const host = this.model.parts[item]?.of ?? this.model.tables[item]?.of ?? item.split("#")[0];
        if (this.model.nodes[host]) out.add(`node:${host}`);
        continue;
      }
      const node = this.nodeByEl(id);
      const q = id.startsWith("q-") && Object.values(this.model.questions).find((x) => id === x.elId || id.startsWith(`${x.elId}:`));
      if (node) out.add(`node:${node.id}`);
      else if (q) out.add(`question:${q.id}`);
      else if (id.startsWith("dec-")) {
        const d = Object.keys(this.model.decisions).find((k) => id === `dec-${k}` || id.startsWith(`dec-${k}-`));
        if (d) out.add(`decision:${d}`);
      } else {
        const edge = Object.entries(this.model.edges).find(([, e]) => e.elId === id);
        if (edge) out.add(`edge:${edge[0]}`);
        const note = this.model.notes.find((n) => n.elId === id || id === `tape-${n.elId}`);
        if (note) out.add(`note:${note.n}`);
      }
    }
    return [...out];
  }

  // Bring these into view on the canvas that's showing.
  scrollTo(lids) {
    const [api, elementFor] = this.canvas();
    const ids = new Set(lids.map(elementFor).filter(Boolean));
    const els = api.getSceneElements().filter((e) => ids.has(e.id));
    if (els.length) api.scrollToContent(els, { animate: true, duration: 300 });
  }

  setHighlights(lids) {
    this.hl = new Set(lids);
    this.refreshMarkers();
  }

  // Highlighter marks on every canvas: a yellow halo behind shapes, a marker stroke under text and arrows.
  refreshMarkers() {
    this.hlSig = this.paintMarks(this.api, (l) => this.elementFor(l), this.hlSig);
    if (this.whyApi) this.whyHlSig = this.paintMarks(this.whyApi, (l) => this.whyElementFor(l), this.whyHlSig);
    if (this.timelineApi) this.tlHlSig = this.paintMarks(this.timelineApi, (l) => this.timelineElementFor(l), this.tlHlSig);
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
