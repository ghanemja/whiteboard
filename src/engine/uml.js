// The UML view: class, component, sequence and activity diagrams from the model, as Excalidraw
// skeletons in the board's look (hand-drawn, each part in its layer's color), stacked one under
// another for the ones ticked (drawUml), plus each as Mermaid. Pure, like diagrams.js: Board
// converts and places the skeletons; `_c: [x, y]` centers a text on a point, `_r: x` puts its
// right edge there.
//
// Where each comes from:
//   class      the agent's class ops (model.classes); a board without any shows its tables as
//              entities instead, so the view is never empty when there's a data model
//   component  the board's components: their interface (api) as provided interfaces, their
//              connections as dependencies
//   sequence   one flow, message by message (diagrams.js drawSequence)
//   activity   the same flow as actions, in a lane for the part that does each one
import { INK, MUTED, YOU } from "./palette.js";
import { drawSequence } from "./diagrams.js";
import { alias, C4_TYPE, colorClasses, LAYER_COLOR, layerOf, q, toSequence } from "./views.js";

export const UML_KINDS = [
  { key: "class", label: "Class", title: "Class diagram: the classes, interfaces and modules in the code, what they hold and do, and how they relate" },
  { key: "component", label: "Component", title: "Component diagram: the parts, the interfaces each provides, and what depends on what" },
  { key: "sequence", label: "Sequence", title: "Sequence diagram: one flow, message by message" },
  { key: "activity", label: "Activity", title: "Activity diagram: one flow's steps as actions, in a lane for the part that does each" },
];

const hand = { strokeWidth: 2, roughness: 1, locked: true };
const thin = { ...hand, strokeWidth: 1 };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (id, x, y, t, size, color, extra = {}) => ({ type: "text", id, x, y, text: t, fontSize: size, strokeColor: color, ...hand, ...extra });
const NONE = { stroke: MUTED, fill: "#f8f9fa" };
const colorOf = (node) => (node?.kind === "user" ? YOU : LAYER_COLOR[node ? layerOf(node) : ""] ?? NONE);
const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(/;|\n/)).map((s) => String(s).trim()).filter(Boolean);
// The hand font's width per character at a size, a little generous so nothing spills.
const wide = (s, size) => s.length * size * 0.56;

// Where the line from a box's center toward (tx, ty) leaves the box.
function exit(b, tx, ty) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const k = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * k, cy + dy * k];
}
const link = (id, a, b, style) => {
  const [x1, y1] = exit(a, b.x + b.w / 2, b.y + b.h / 2), [x2, y2] = exit(b, a.x + a.w / 2, a.y + a.h / 2);
  return { type: "arrow", id, x: x1, y: y1, points: [[0, 0], [x2 - x1, y2 - y1]], strokeColor: INK, startArrowhead: null, ...hand, strokeWidth: 1.5, ...style };
};

// ---- class diagram ----
// A class op onto what the board had for that id: { id, of (its component), name, kind (class |
// interface | abstract | enum | module), attrs ["name: type"], methods ["name(args): type"],
// extends (a class id or name), implements, uses (ids or names) }. Lists come as arrays from the
// tool, or as one string from the demo's tags ("a; b").
const items = (v, sep = /;|\n/) => (v == null ? null : (Array.isArray(v) ? v : String(v).split(sep)).map((s) => String(s).trim()).filter(Boolean));
export function mergeClass(prev, { id, of, name, kind, attrs, methods, extends: ext, implements: impl, uses }) {
  return {
    id, of: of ?? prev?.of ?? null, name: name ?? prev?.name ?? id, kind: kind ?? prev?.kind ?? "class",
    attrs: items(attrs) ?? prev?.attrs ?? [], methods: items(methods) ?? prev?.methods ?? [],
    extends: ext ?? prev?.extends ?? null, implements: items(impl, /[;,\n]/) ?? prev?.implements ?? [], uses: items(uses, /[;,\n]/) ?? prev?.uses ?? [],
  };
}

// The classes the agent drew, or, without any, the data model's tables as entities.
export function classesOf(model) {
  const drawn = Object.values(model.classes ?? {});
  if (drawn.length) return { from: "classes", classes: drawn.map((c) => ({ ...c, attrs: list(c.attrs), methods: list(c.methods), implements: list(c.implements), uses: list(c.uses) })) };
  const tables = Object.values(model.tables ?? {});
  const byName = new Map(tables.map((t) => [t.name, t]));
  return {
    from: tables.length ? "tables" : "none",
    classes: tables.map((t) => ({
      id: `table:${t.id}`, of: t.of, name: t.name, kind: "entity",
      attrs: t.columns.map((c) => `${c.name}: ${c.type}${c.pk ? " {id}" : ""}`),
      methods: [], implements: [],
      uses: [...new Set(t.columns.map((c) => c.fk && byName.get(c.fk.table)).filter(Boolean).map((r) => `table:${r.id}`))],
    })),
  };
}

const STEREO = { interface: "«interface»", abstract: "«abstract»", enum: "«enumeration»", entity: "«entity»", module: "«module»" };
export const CLS = { COLS: 3, GX: 70, GY: 60, HEAD: 46, ROW: 20 };

export function drawClasses(model) {
  const { from, classes } = classesOf(model);
  if (!classes.length) return [];
  // Grouped by the component that holds them, in the board's order.
  const order = Object.keys(model.nodes ?? {});
  classes.sort((a, b) => (order.indexOf(a.of) + 1 || 99) - (order.indexOf(b.of) + 1 || 99));
  const sk = [];
  if (from === "tables") sk.push(text("uc:note", 0, -34, "No classes drawn yet: the data model's tables, as entities", 14, MUTED));
  const boxes = new Map();
  let x = 0, y = 0, rowH = 0;
  classes.forEach((c, i) => {
    const lines = [...c.attrs, ...c.methods];
    const w = Math.round(Math.max(190, wide(c.name, 17) + 40, ...lines.map((l) => wide(clip(l, 46), 13) + 28)));
    const h = CLS.HEAD + Math.max(1, c.attrs.length) * CLS.ROW + 10 + Math.max(1, c.methods.length) * CLS.ROW + 10;
    if (i && i % CLS.COLS === 0) {
      x = 0;
      y += rowH + CLS.GY;
      rowH = 0;
    }
    const col = colorOf(model.nodes?.[c.of]);
    const id = `uc:c:${c.id}`;
    // A class box: name (and stereotype) on its component's layer color, then attributes, then operations.
    sk.push({ type: "rectangle", id, x, y, width: w, height: h, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", ...hand });
    sk.push({ type: "rectangle", id: `${id}:h`, x, y, width: w, height: CLS.HEAD, strokeColor: INK, backgroundColor: col.fill, fillStyle: "solid", ...hand });
    const st = STEREO[c.kind];
    if (st) sk.push(text(`${id}:s`, x, y, st, 12, MUTED, { _c: [x + w / 2, y + 12] }));
    sk.push(text(`${id}:n`, x, y, clip(c.name, 30), 17, INK, { _c: [x + w / 2, y + (st ? 30 : CLS.HEAD / 2)] }));
    let ry = y + CLS.HEAD + 5;
    c.attrs.forEach((a, k) => sk.push(text(`${id}:a${k}`, x + 12, ry + k * CLS.ROW, clip(a, 46), 13, INK)));
    ry += Math.max(1, c.attrs.length) * CLS.ROW + 5;
    sk.push({ type: "line", id: `${id}:sep`, x, y: ry, points: [[0, 0], [w, 0]], strokeColor: INK, ...thin });
    c.methods.forEach((m, k) => sk.push(text(`${id}:m${k}`, x + 12, ry + 5 + k * CLS.ROW, clip(m, 46), 13, INK)));
    boxes.set(c.id, { x, y, w, h });
    x += w + CLS.GX;
    rowH = Math.max(rowH, h);
  });
  let lift = 0; // arrows routed over a row, each a little higher than the last
  // Relations: inheritance (a hollow triangle), realization (dashed, hollow triangle),
  // dependency (dashed, open arrow); a table's foreign key is an association (solid, open arrow).
  for (const c of classes) {
    const a = boxes.get(c.id);
    const to = (ref) => boxes.get(ref) ?? boxes.get(classes.find((k) => k.name === ref)?.id);
    const add = (ref, style, k) => {
      const b = to(ref);
      if (!b || b === a) return;
      // Side by side on a row with another box between: over the top of the row, not through it.
      const between = a.y === b.y && [...boxes.values()].some((o) => o.y === a.y && o.x > Math.min(a.x, b.x) && o.x < Math.max(a.x, b.x));
      if (!between) return sk.push(link(`uc:r:${c.id}:${k}`, a, b, style));
      const up = 22 + (lift++ % 3) * 10, ax = a.x + a.w / 2 + (b.x > a.x ? 20 : -20), bx = b.x + b.w / 2;
      sk.push({ type: "arrow", id: `uc:r:${c.id}:${k}`, x: ax, y: a.y, points: [[0, 0], [0, -up], [bx - ax, -up], [bx - ax, 0]], strokeColor: INK, startArrowhead: null, ...hand, strokeWidth: 1.5, ...style });
    };
    if (c.extends) add(c.extends, { endArrowhead: "triangle_outline" }, "x");
    c.implements.forEach((r, k) => add(r, { endArrowhead: "triangle_outline", strokeStyle: "dashed" }, `i${k}`));
    c.uses.forEach((r, k) => add(r, { endArrowhead: "arrow", strokeStyle: c.kind === "entity" ? "solid" : "dashed" }, `u${k}`));
  }
  return sk;
}

export function toClassMermaid(model) {
  const { classes } = classesOf(model);
  const word = (s) => String(s ?? "").replace(/[^\w]/g, "_").replace(/^[^A-Za-z_]/, "_$&") || "_";
  const nameOf = new Map(classes.map((c) => [c.id, word(c.name)]));
  const ref = (r) => nameOf.get(r) ?? (classes.some((c) => c.name === r) ? word(r) : null);
  const member = (s) => String(s).replace(/[{}"]/g, "").replace(/</g, "~").replace(/>/g, "~");
  const lines = ["classDiagram"];
  for (const c of classes) {
    lines.push(`  class ${word(c.name)} {`);
    if (STEREO[c.kind]) lines.push(`    <<${c.kind}>>`);
    for (const a of c.attrs) lines.push(`    ${member(a)}`);
    // Mermaid writes a method's return type after a space, not a colon: "answer(q) Answer".
    for (const m of c.methods) lines.push(`    ${member(m).replace(/\)\s*:\s*/, ") ")}`);
    lines.push("  }");
  }
  for (const c of classes) {
    const me = word(c.name);
    if (c.extends && ref(c.extends)) lines.push(`  ${ref(c.extends)} <|-- ${me}`);
    for (const r of c.implements) if (ref(r)) lines.push(`  ${ref(r)} <|.. ${me}`);
    for (const r of c.uses) if (ref(r)) lines.push(`  ${me} ${c.kind === "entity" ? "-->" : "..>"} ${ref(r)}`);
  }
  return `${lines.join("\n")}\n`;
}

// ---- component diagram ----
export const CMP = { W: 230, H: 86, GX: 150, GY: 110, IF: 3, ROW: 20 };

export function drawComponents(model) {
  const nodes = Object.values(model.nodes ?? {});
  if (!nodes.length) return [];
  const sk = [];
  const boxes = new Map();
  let spare = 0;
  for (const n of nodes) {
    const [col, row] = n.cell ?? [spare++ % 3, 3 + Math.floor(spare / 3)];
    const api = list(n.api);
    const shown = api.slice(0, CMP.IF);
    const h = CMP.H + (shown.length ? 10 + shown.length * CMP.ROW + (api.length > CMP.IF ? CMP.ROW : 0) : 0);
    const x = col * (CMP.W + CMP.GX), y = row * (CMP.H + CMP.IF * CMP.ROW + 30 + CMP.GY);
    const c = colorOf(n);
    const id = `uk:c:${n.id}`;
    const person = n.kind === "user";
    const st = person ? "«actor»" : n.kind === "external" ? "«external»" : C4_TYPE[n.kind] === "Database" ? "«component» data" : "«component»";
    sk.push({ type: "rectangle", id, x, y, width: CMP.W, height: h, strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid", ...hand });
    // UML's component symbol in the corner: a box with two tabs on its left side.
    if (!person) {
      const ix = x + CMP.W - 30, iy = y + 10;
      sk.push({ type: "rectangle", id: `${id}:i`, x: ix, y: iy, width: 18, height: 22, strokeColor: c.stroke, backgroundColor: "#ffffff", fillStyle: "solid", ...thin });
      for (const k of [0, 1]) sk.push({ type: "rectangle", id: `${id}:i${k}`, x: ix - 5, y: iy + 4 + k * 9, width: 10, height: 5, strokeColor: c.stroke, backgroundColor: "#ffffff", fillStyle: "solid", ...thin });
    }
    sk.push(text(`${id}:s`, x, y, st, 12, MUTED, { _c: [x + CMP.W / 2, y + 26] }));
    sk.push(text(`${id}:n`, x, y, clip(n.name, 22), 17, INK, { _c: [x + CMP.W / 2, y + 50] }));
    if (n.libs?.[0]) sk.push(text(`${id}:l`, x, y, clip(n.libs[0], 26), 12, MUTED, { _c: [x + CMP.W / 2, y + 72] }));
    // What it provides: its interfaces (the first few), each with UML's provided-interface circle,
    // inside the box so no connection crosses them.
    if (shown.length) {
      const sy = y + CMP.H;
      sk.push({ type: "line", id: `${id}:sep`, x, y: sy, points: [[0, 0], [CMP.W, 0]], strokeColor: c.stroke, ...thin, opacity: 60 });
      shown.forEach((a, k) => {
        const ly = sy + 10 + k * CMP.ROW;
        sk.push({ type: "ellipse", id: `${id}:p${k}:o`, x: x + 12, y: ly + 4, width: 10, height: 10, strokeColor: c.stroke, backgroundColor: "#ffffff", fillStyle: "solid", ...thin, strokeWidth: 1.5 });
        sk.push(text(`${id}:p${k}:t`, x + 30, ly, clip(a, 28), 12, INK));
      });
      if (api.length > CMP.IF) sk.push(text(`${id}:more`, x + 30, sy + 10 + CMP.IF * CMP.ROW, `+${api.length - CMP.IF} more`, 11, MUTED));
    }
    boxes.set(n.id, { x, y, w: CMP.W, h });
  }
  // Dependencies: dashed, an open arrow to what it uses, labeled with how («HTTP»).
  for (const e of Object.values(model.edges ?? {})) {
    const a = boxes.get(e.from), b = boxes.get(e.to);
    if (!a || !b) continue;
    const l = link(`uk:d:${e.from}>${e.to}`, a, b, { strokeStyle: "dashed", endArrowhead: "arrow" });
    sk.push(l);
    if (e.via) {
      const [px, py] = l.points[1];
      const mx = l.x + px / 2, my = l.y + py / 2;
      sk.push(text(`uk:d:${e.from}>${e.to}:t`, mx, my, `«${clip(e.via, 10)}»`, 12, MUTED, { _c: [mx, my - 10], backgroundColor: "#ffffff" }));
    }
  }
  return sk;
}

export function toComponentMermaid(model) {
  const nodes = Object.values(model.nodes ?? {});
  const lines = ["flowchart LR"];
  for (const n of nodes) {
    const st = n.kind === "user" ? "«actor»" : n.kind === "external" ? "«external»" : "«component»";
    const api = list(n.api);
    lines.push(`  ${alias(n.id)}["${st}<br/><b>${q(n.name)}</b>${api.length ? `<br/>provides: ${q(api.slice(0, CMP.IF).join(", "))}${api.length > CMP.IF ? ", …" : ""}` : ""}"]`);
  }
  for (const e of Object.values(model.edges ?? {})) if (model.nodes?.[e.from] && model.nodes?.[e.to]) lines.push(`  ${alias(e.from)} -.->${e.via ? `|${q(e.via)}|` : ""} ${alias(e.to)}`);
  lines.push(...colorClasses(nodes.map((n) => [alias(n.id), n.kind === "user" ? null : layerOf(n)])));
  return `${lines.join("\n")}\n`;
}

// ---- activity diagram: a flow's steps as actions, each in the lane of the part that does it ----
// A step "web>api: POST /ask" is the API server's action (the part that receives it does it); the
// first lane is where the flow starts.
export const ACT = { LANE: 240, HEAD: 44, TOP: 70, STEP: 84, AW: 190, AH: 46 };

export function drawActivity(model, flow) {
  if (!flow?.steps?.length) return [];
  const lanes = [...new Set([flow.steps[0].from, ...flow.steps.map((s) => s.to)])];
  const laneX = (id) => lanes.indexOf(id) * ACT.LANE;
  const cx = (id) => laneX(id) + ACT.LANE / 2;
  const bottom = ACT.HEAD + ACT.TOP + flow.steps.length * ACT.STEP + 70;
  const sk = [text("ua:title", 0, -34, flow.name, 20, INK)];
  for (const id of lanes) {
    const n = model.nodes?.[id], c = n ? colorOf(n) : NONE, x = laneX(id);
    sk.push({ type: "rectangle", id: `ua:l:${id}`, x, y: 0, width: ACT.LANE, height: ACT.HEAD, strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid", ...hand });
    sk.push(text(`ua:l:${id}:t`, x, 0, clip(n?.name ?? id, 22), 15, INK, { _c: [x + ACT.LANE / 2, ACT.HEAD / 2] }));
    sk.push({ type: "rectangle", id: `ua:l:${id}:b`, x, y: ACT.HEAD, width: ACT.LANE, height: bottom - ACT.HEAD, strokeColor: c.stroke, backgroundColor: "transparent", ...thin, opacity: 60 });
  }
  // Start: a filled dot in the first lane.
  const sx = cx(lanes[0]), sy = ACT.HEAD + 26;
  sk.push({ type: "ellipse", id: "ua:start", x: sx - 11, y: sy - 11, width: 22, height: 22, strokeColor: INK, backgroundColor: INK, fillStyle: "solid", ...hand });
  let prev = { x: sx, y: sy + 11 };
  flow.steps.forEach((st, i) => {
    const x = cx(st.to), y = ACT.HEAD + ACT.TOP + i * ACT.STEP;
    const id = `ua:a:${i}`;
    sk.push({ type: "rectangle", id, x: x - ACT.AW / 2, y, width: ACT.AW, height: ACT.AH, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", roundness: { type: 3 }, ...hand });
    sk.push(text(`${id}:t`, x, y, clip(st.what || `${st.from} → ${st.to}`, 26), 14, INK, { _c: [x, y + ACT.AH / 2] }));
    sk.push(flowArrow(`ua:f:${i}`, prev, { x, y }));
    prev = { x, y: y + ACT.AH };
  });
  // End: a dot in a ring, under the last action.
  const ey = prev.y + 40;
  sk.push(flowArrow("ua:f:end", prev, { x: prev.x, y: ey - 13 }));
  sk.push({ type: "ellipse", id: "ua:end", x: prev.x - 13, y: ey - 13, width: 26, height: 26, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", ...hand });
  sk.push({ type: "ellipse", id: "ua:end:dot", x: prev.x - 7, y: ey - 7, width: 14, height: 14, strokeColor: INK, backgroundColor: INK, fillStyle: "solid", ...hand });
  return sk;
}
// Down, across to the next lane if it moves, then down into the next action.
function flowArrow(id, a, b) {
  const mid = a.y + (b.y - a.y) / 2;
  const pts = a.x === b.x ? [[0, 0], [0, b.y - a.y]] : [[0, 0], [0, mid - a.y], [b.x - a.x, mid - a.y], [b.x - a.x, b.y - a.y]];
  return { type: "arrow", id, x: a.x, y: a.y, points: pts, strokeColor: INK, startArrowhead: null, endArrowhead: "triangle", ...hand, strokeWidth: 1.5 };
}

export function toActivityMermaid(model, flow) {
  const lanes = [...new Set([flow.steps[0].from, ...flow.steps.map((s) => s.to)])];
  const lines = ["flowchart TD", `  start(( ))`];
  for (const id of lanes) {
    lines.push(`  subgraph ${alias(id)}_lane["${q(model.nodes?.[id]?.name ?? id)}"]`);
    flow.steps.forEach((s, i) => s.to === id && lines.push(`    a${i}("${q(s.what || `${s.from} to ${s.to}`)}")`));
    lines.push("  end");
  }
  lines.push(`  stop((( )))`);
  lines.push(`  start --> a0`);
  for (let i = 1; i < flow.steps.length; i++) lines.push(`  a${i - 1} --> a${i}`);
  lines.push(`  a${flow.steps.length - 1} --> stop`);
  lines.push("  style start fill:#1e1e1e,stroke:#1e1e1e", "  style stop fill:#1e1e1e,stroke:#1e1e1e");
  return `${lines.join("\n")}\n`;
}

// ---- the UML view: the ticked diagrams, one under another, each under its heading ----
// kinds: keys of UML_KINDS, in any order (drawn in UML_KINDS's); flow: for sequence and activity.
const EMPTY = {
  class: "No classes yet: the agent draws them for the code it reads or changes.",
  component: "No components yet.",
  sequence: "No flow yet: a sequence diagram follows one.",
  activity: "No flow yet: an activity diagram follows one.",
};

// A skeleton's extent (texts estimated), so the next diagram starts under it.
function bounds(sk) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const e of sk) {
    const pts = e.points ? e.points.map(([px, py]) => [e.x + px, e.y + py]) : [[e.x, e.y], [e.x + (e.width ?? wide(e.text ?? "", e.fontSize ?? 16)), e.y + (e.height ?? (e.fontSize ?? 16) * 1.3)]];
    if (e._c) pts.push([e._c[0] - wide(e.text, e.fontSize) / 2, e._c[1] - e.fontSize], [e._c[0] + wide(e.text, e.fontSize) / 2, e._c[1] + e.fontSize]);
    for (const [px, py] of pts) {
      x1 = Math.min(x1, px);
      y1 = Math.min(y1, py);
      x2 = Math.max(x2, px);
      y2 = Math.max(y2, py);
    }
  }
  return { x1, y1, x2, y2 };
}
const shift = (sk, dx, dy) => sk.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy, ...(e._c ? { _c: [e._c[0] + dx, e._c[1] + dy] } : {}), ...(e._r != null ? { _r: e._r + dx } : {}) }));

export function drawUml(model, { kinds = UML_KINDS.map((k) => k.key), flow = null } = {}) {
  const want = new Set(kinds);
  const out = [];
  let y = 0;
  for (const k of UML_KINDS.filter((k) => want.has(k.key))) {
    let sk = k.key === "class" ? drawClasses(model) : k.key === "component" ? drawComponents(model) : k.key === "sequence" ? drawSequence(model, flow) : drawActivity(model, flow);
    if (k.key === "sequence") sk = sk.map((e) => ({ ...e, id: `um:${e.id}` })); // sequence ids are the Sequence view's too
    out.push(text(`um:h:${k.key}`, 0, y, `${k.label} diagram`, 26, INK));
    y += 56;
    if (!sk.length) {
      out.push(text(`um:e:${k.key}`, 0, y, EMPTY[k.key], 15, MUTED));
      y += 70;
      continue;
    }
    const b = bounds(sk);
    out.push(...shift(sk, -b.x1, y - b.y1));
    y += b.y2 - b.y1 + 90;
  }
  return out;
}

// The ticked diagrams as Mermaid: [{ label, body }], one block each (GitHub renders each); a
// diagram with nothing to show is left out.
export function toUmlMermaid(model, { kinds = UML_KINDS.map((k) => k.key), flow = null } = {}) {
  const want = new Set(kinds);
  const hasFlow = !!flow?.steps?.length;
  const make = {
    class: () => classesOf(model).classes.length && toClassMermaid(model),
    component: () => Object.keys(model.nodes ?? {}).length && toComponentMermaid(model),
    sequence: () => hasFlow && toSequence(model, flow),
    activity: () => hasFlow && toActivityMermaid(model, flow),
  };
  return UML_KINDS.filter((k) => want.has(k.key))
    .map((k) => ({ label: k.label, body: make[k.key]() }))
    .filter((b) => b.body);
}
