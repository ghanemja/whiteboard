// A layer, opened up in place on the Architecture board: each of its components bursts into
// what it's made of (its pages, routes, jobs, steps, tables, libraries), drawn as small icons in
// the layer's colors around the component, with dashed leader lines back to it. The rest of the
// board stays where it is, faded, so nothing moves and nothing swaps: the camera just refits.
//
// Pure (no Excalidraw), so the layout can be tested: Board measures the hit-boxes, passes them
// in, converts the skeletons, centers the text (`_c`) and commits them as `ex:*` elements.
import { LAYER_COLOR, insideOf, partLayer } from "./views.js";

export const EX = { W: 124, H: 86, ICON: 40, GAP: 16, REACH: 64, RING: 100, SPREAD: Math.PI * 0.8, TRIES: 36 };

// The picture for a part, from its kind (free text from the agent: "route", "view (pdf.js)"…).
export function iconOf(kind = "") {
  const k = kind.toLowerCase();
  if (/library|package|sdk/.test(k)) return "box";
  if (/table/.test(k)) return "table";
  if (/page|view|screen|component|form/.test(k)) return "window";
  if (/route|endpoint|api|handler/.test(k)) return "plug";
  if (/job|task|cron|queue|worker/.test(k)) return "clock";
  if (/model|llm|embed|prompt/.test(k)) return "spark";
  if (/index|search/.test(k)) return "lens";
  if (/object|file|bucket|blob|document/.test(k)) return "page";
  if (/step|function|method|pipeline/.test(k)) return "gear";
  return "dot";
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// What opening `layer` shows: [{ host, partial, items: [{ id, name, kind, layer, icon }] }].
// A component of the layer shows all its parts and its libraries; one of another layer only the
// parts that belong to this layer (an embedding step in a worker, opened under ML).
export function explodeOf(model, layer) {
  if (!layer) return [];
  return insideOf(model, layer).groups.map((g) => {
    const items = g.parts.map((p) => ({ id: p.id, name: p.name, kind: p.kind ?? "", layer: partLayer(model, p), icon: iconOf(p.kind) }));
    if (!g.partial)
      for (const [i, lib] of (g.node.libs ?? []).entries()) items.push({ id: `${g.node.id}#lib${i}`, name: lib, kind: "library", layer, icon: "box" });
    return { host: g.node.id, partial: g.partial, items };
  });
}

const overlaps = (a, b, m = 0) => a.x < b.x + b.w + m && b.x < a.x + a.w + m && a.y < b.y + b.h + m && b.y < a.y + a.h + m;
const centerOf = (b) => [b.x + b.w / 2, b.y + b.h / 2];

// Where a ray from a box's center toward (tx, ty) leaves the box.
function edgePoint(b, tx, ty) {
  const [cx, cy] = centerOf(b);
  const dx = tx - cx, dy = ty - cy;
  if (!dx && !dy) return [cx, cy];
  const s = Math.min(dx ? b.w / 2 / Math.abs(dx) : Infinity, dy ? b.h / 2 / Math.abs(dy) : Infinity);
  return [cx + dx * s, cy + dy * s];
}

// Positions: each group's items on arcs facing away from the middle of the board (a component on
// the left fans out to the left, one at the top fans upward), ring after ring if they don't fit,
// each item nudged outward until it clears every component and every item placed before it.
// boxes: { nodeId: { x, y, w, h } } (all components, for clearance); obstacles: more boxes to avoid.
export function explodeLayout(groups, boxes, obstacles = []) {
  const all = Object.values(boxes);
  if (!all.length) return [];
  const x0 = Math.min(...all.map((b) => b.x)), x1 = Math.max(...all.map((b) => b.x + b.w));
  const y0 = Math.min(...all.map((b) => b.y)), y1 = Math.max(...all.map((b) => b.y + b.h));
  const mid = [(x0 + x1) / 2, (y0 + y1) / 2];
  const solid = [...all, ...obstacles];
  const placed = [];
  const out = [];
  for (const g of groups) {
    const h = boxes[g.host];
    if (!h || !g.items.length) continue;
    const [hx, hy] = centerOf(h);
    const r0 = Math.hypot(h.w, h.h) / 2 + EX.REACH;
    // Fill rings outward: as many as fit in the spread at each radius, centered on `facing`.
    const slotsFor = (facing) => {
      const slots = [];
      for (let ring = 0; slots.length < g.items.length; ring++) {
        const r = r0 + ring * EX.RING;
        const step = (EX.W + EX.GAP) / r;
        const cap = Math.max(1, Math.floor(EX.SPREAD / step) + 1);
        const n = Math.min(cap, g.items.length - slots.length);
        for (let i = 0; i < n; i++) slots.push({ r, a: facing + (i - (n - 1) / 2) * step, step });
      }
      return slots;
    };
    // Face away from the middle of the board, unless another way is clearer: a component in the
    // middle (or hemmed in) opens toward the most room. Ties keep "away from the middle".
    const dx = hx - mid[0], dy = hy - mid[1];
    const away = Math.hypot(dx, dy) < 1 ? -Math.PI / 2 : Math.atan2(dy, dx);
    const blocked = (facing) =>
      slotsFor(facing).filter(({ r, a }) => {
        const b = { x: hx + Math.cos(a) * r - EX.W / 2, y: hy + Math.sin(a) * r - EX.H / 2, w: EX.W, h: EX.H };
        return solid.some((o) => overlaps(b, o, 12)) || placed.some((o) => overlaps(b, o, 8));
      }).length;
    let facing = away, best = blocked(away);
    for (let k = 1; k < 8 && best > 0; k++)
      for (const f of [away + (k * Math.PI) / 4, away - (k * Math.PI) / 4]) {
        const n = blocked(f);
        if (n < best) [facing, best] = [f, n];
      }
    const slots = slotsFor(facing);
    g.items.forEach((it, i) => {
      let { r, a, step } = slots[i];
      let box;
      for (let t = 0; t <= EX.TRIES; t++) {
        // Try the slot, then a little to either side, then further out.
        const a2 = a + (t % 3 === 1 ? step / 2 : t % 3 === 2 ? -step / 2 : 0);
        const r2 = r + Math.floor(t / 3) * 28;
        const cx = hx + Math.cos(a2) * r2, cy = hy + Math.sin(a2) * r2;
        box = { x: cx - EX.W / 2, y: cy - EX.H / 2, w: EX.W, h: EX.H };
        if (!solid.some((b) => overlaps(box, b, 12)) && !placed.some((b) => overlaps(box, b, 8))) break;
      }
      placed.push(box);
      const [cx, cy] = centerOf(box);
      const iy = box.y + EX.ICON / 2 + 4; // the icon's center
      const from = edgePoint(h, cx, iy);
      const to = edgePoint({ x: cx - EX.ICON / 2 - 6, y: iy - EX.ICON / 2 - 6, w: EX.ICON + 12, h: EX.ICON + 12 }, from[0], from[1]);
      out.push({ ...it, host: g.host, partial: g.partial, x: box.x, y: box.y, w: box.w, h: box.h, at: [cx, iy], from, to });
    });
  }
  return out;
}

// Excalidraw skeletons for the laid-out items: a leader, the icon, the name and kind. Ids `ex:<item>…`,
// each item's elements in one group. `look` is the board's line style (hand-drawn or crisp).
export function explodeSkeletons(items, { look = { strokeWidth: 2, roughness: 1 }, font = {} } = {}) {
  const sk = [];
  for (const it of items) {
    const c = LAYER_COLOR[it.layer] ?? LAYER_COLOR.backend;
    const id = `ex:${it.id}`;
    const g = [`g:${id}`];
    const [cx, cy] = it.at;
    const line = { strokeColor: c.stroke, backgroundColor: "transparent", ...look, groupIds: g };
    const fill = { strokeColor: c.stroke, backgroundColor: c.fill, fillStyle: "solid", ...look, groupIds: g };
    const solid = { strokeColor: c.stroke, backgroundColor: c.stroke, fillStyle: "solid", ...look, strokeWidth: 1, groupIds: g };
    const [fx, fy] = it.from, [tx, ty] = it.to;
    sk.push({ type: "line", id: `${id}:lead`, x: fx, y: fy, points: [[0, 0], [tx - fx, ty - fy]], ...line, strokeWidth: 1.5, strokeStyle: "dashed", opacity: 70 });
    sk.push(...icon(it.icon, id, cx, cy, { line, fill, solid }));
    sk.push({ type: "text", id: `${id}:n`, x: cx, y: cy, text: clip(it.name, 20), fontSize: 13, strokeColor: "#1b1b1f", groupIds: g, ...font, _c: [cx, cy + EX.ICON / 2 + 14] });
    if (it.kind) sk.push({ type: "text", id: `${id}:k`, x: cx, y: cy, text: clip(it.kind, 22), fontSize: 11, strokeColor: c.stroke, groupIds: g, ...font, _c: [cx, cy + EX.ICON / 2 + 31] });
  }
  return sk;
}

// The pictures, each about 40 px across, centered on (cx, cy).
function icon(kind, id, cx, cy, { line, fill, solid }) {
  const S = EX.ICON, h = S / 2;
  const poly = (sid, pts, style) => {
    const [x, y] = pts[0];
    return { type: "line", id: sid, x, y, points: pts.map(([px, py]) => [px - x, py - y]), ...style };
  };
  switch (kind) {
    case "window": // a page or view: a browser window
      return [
        { type: "rectangle", id: `${id}:i0`, x: cx - h, y: cy - h + 4, width: S, height: S - 8, ...fill, roundness: { type: 3 } },
        poly(`${id}:i1`, [[cx - h, cy - h + 13], [cx + h, cy - h + 13]], line),
        ...[0, 1, 2].map((i) => ({ type: "ellipse", id: `${id}:i${2 + i}`, x: cx - h + 5 + i * 6, y: cy - h + 7, width: 4, height: 4, ...solid })),
      ];
    case "plug": // a route: a pill with an arrow going in
      return [
        { type: "rectangle", id: `${id}:i0`, x: cx - h, y: cy - 12, width: S, height: 24, ...fill, roundness: { type: 3 } },
        { type: "arrow", id: `${id}:i1`, x: cx - h + 7, y: cy, points: [[0, 0], [S - 14, 0]], ...line, endArrowhead: "arrow", startArrowhead: null },
      ];
    case "clock": // a job: a clock
      return [
        { type: "ellipse", id: `${id}:i0`, x: cx - h, y: cy - h, width: S, height: S, ...fill },
        poly(`${id}:i1`, [[cx, cy - h + 8], [cx, cy], [cx + 10, cy + 6]], line),
      ];
    case "spark": // a model: a four-point sparkle
      return [poly(`${id}:i0`, [[cx, cy - h], [cx + 6, cy - 6], [cx + h, cy], [cx + 6, cy + 6], [cx, cy + h], [cx - 6, cy + 6], [cx - h, cy], [cx - 6, cy - 6], [cx, cy - h]], fill)];
    case "lens": // an index: a magnifier
      return [
        { type: "ellipse", id: `${id}:i0`, x: cx - h, y: cy - h, width: S - 12, height: S - 12, ...fill },
        poly(`${id}:i1`, [[cx + h - 14, cy + h - 14], [cx + h, cy + h]], { ...line, strokeWidth: (line.strokeWidth ?? 2) + 1.5 }),
      ];
    case "table": // a table: a header band and rows
      return [
        { type: "rectangle", id: `${id}:i0`, x: cx - h, y: cy - h + 4, width: S, height: S - 8, ...fill },
        { type: "rectangle", id: `${id}:i1`, x: cx - h, y: cy - h + 4, width: S, height: 9, ...solid, opacity: 55 },
        poly(`${id}:i2`, [[cx - h, cy + 2], [cx + h, cy + 2]], line),
        poly(`${id}:i3`, [[cx - h, cy + 10], [cx + h, cy + 10]], line),
        poly(`${id}:i4`, [[cx - 4, cy - h + 13], [cx - 4, cy + h - 4]], line),
      ];
    case "page": // a stored object: a page with a folded corner
      return [
        poly(`${id}:i0`, [[cx - 14, cy - h], [cx + 6, cy - h], [cx + 15, cy - h + 9], [cx + 15, cy + h], [cx - 14, cy + h], [cx - 14, cy - h]], fill),
        poly(`${id}:i1`, [[cx + 6, cy - h], [cx + 6, cy - h + 9], [cx + 15, cy - h + 9]], line),
        poly(`${id}:i2`, [[cx - 8, cy - 2], [cx + 9, cy - 2]], line),
        poly(`${id}:i3`, [[cx - 8, cy + 6], [cx + 9, cy + 6]], line),
      ];
    case "box": // a library: a parcel
      return [
        poly(`${id}:i0`, [[cx - h + 2, cy - 8], [cx, cy - h + 2], [cx + h - 2, cy - 8], [cx, cy + 2], [cx - h + 2, cy - 8]], fill),
        poly(`${id}:i1`, [[cx - h + 2, cy - 8], [cx - h + 2, cy + 10], [cx, cy + h - 2], [cx + h - 2, cy + 10], [cx + h - 2, cy - 8]], line),
        poly(`${id}:i2`, [[cx, cy + 2], [cx, cy + h - 2]], line),
      ];
    case "gear": // a step or function: a cog
      return [
        ...[0, 1, 2, 3].map((i) => {
          const a = (i * Math.PI) / 4;
          return poly(`${id}:t${i}`, [[cx - Math.cos(a) * h, cy - Math.sin(a) * h], [cx + Math.cos(a) * h, cy + Math.sin(a) * h]], { ...line, strokeWidth: (line.strokeWidth ?? 2) + 3 });
        }),
        { type: "ellipse", id: `${id}:i0`, x: cx - 14, y: cy - 14, width: 28, height: 28, ...fill },
        { type: "ellipse", id: `${id}:i1`, x: cx - 5, y: cy - 5, width: 10, height: 10, ...line },
      ];
    default:
      return [{ type: "rectangle", id: `${id}:i0`, x: cx - 14, y: cy - 14, width: 28, height: 28, ...fill, roundness: { type: 3 } }];
  }
}
