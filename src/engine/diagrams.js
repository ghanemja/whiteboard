// The read-only diagram views, drawn from the model as Excalidraw skeletons (Board converts and
// places them, as it does the Timeline's): the data model as an ER diagram, and a flow as a UML
// sequence diagram. Both use the official look: 1 px crisp lines and a plain typeface. Pure, so
// `node --test` can run it. Text centered on a point carries `_c: [x, y]`; right-aligned text
// carries `_r: x` (where its right edge goes).
import { INK, MUTED } from "./palette.js";
import { C4_TYPE, LAYERS, LAYER_COLOR, c4Tag, insideOf, layerOf, partLayer } from "./views.js";

const SANS = 6; // Nunito, Excalidraw's "Normal" typeface
const crisp = { strokeWidth: 1, roughness: 0, locked: true };
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const text = (id, x, y, t, size, color, extra = {}) => ({ type: "text", id, x, y, text: t, fontSize: size, strokeColor: color, fontFamily: SANS, ...crisp, ...extra });
const KEY = "#1971c2";

// ---- the data model: tables grouped by the data store that holds them ----
export const ER = { HEAD: 32, ROW: 22, GAP: 80, PAD: 24 };

export function drawEr(model) {
  const tables = Object.values(model.tables ?? {});
  if (!tables.length) return [];
  const sk = [];
  const groups = new Map(); // data store id ("" if unknown) -> its tables
  for (const t of tables) {
    const k = model.nodes?.[t.of] ? t.of : "";
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(t);
  }
  const width = (t) => Math.round(Math.max(200, t.name.length * 9 + 40, ...t.columns.map((c) => (c.name.length + c.type.length) * 7.2 + 76)));
  const at = new Map(); // table name -> { x, y, w, rows: [row center y], t }
  let gy = 0;
  for (const [store, ts] of groups) {
    const node = model.nodes?.[store];
    const top = gy + 40;
    let x = ER.PAD, tallest = 0;
    for (const t of ts) {
      const w = width(t), h = ER.HEAD + t.columns.length * ER.ROW + 8;
      const id = `er:t:${t.id}`;
      sk.push({ type: "rectangle", id, x, y: top, width: w, height: h, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", ...crisp });
      sk.push({ type: "rectangle", id: `${id}:h`, x, y: top, width: w, height: ER.HEAD, strokeColor: INK, backgroundColor: "#e7f5ff", fillStyle: "solid", ...crisp });
      sk.push(text(`${id}:n`, x, top, t.name, 15, INK, { _c: [x + w / 2, top + ER.HEAD / 2] }));
      const rows = t.columns.map((c, i) => {
        const cy = top + ER.HEAD + 4 + i * ER.ROW + ER.ROW / 2;
        const key = [c.pk && "PK", c.fk && "FK", c.unique && !c.pk && "UK"].filter(Boolean).join(" ");
        if (key) sk.push(text(`${id}:k${i}`, x + 8, cy - 7, key, 10, KEY));
        sk.push(text(`${id}:c${i}`, x + 46, cy - 9, c.name, 13, INK));
        if (c.type) sk.push(text(`${id}:y${i}`, x + w - 10, cy - 8, c.type, 12, MUTED, { _r: x + w - 10 }));
        return cy;
      });
      at.set(t.name, { x, y: top, w, rows, t });
      x += w + ER.GAP;
      tallest = Math.max(tallest, h);
    }
    // The store that holds them: a dashed frame with its name and C4 type.
    const label = node ? `${node.name} [${C4_TYPE[node.kind] ?? "Database"}${node.libs?.[0] ? `: ${node.libs[0]}` : ""}]` : "Other tables";
    const gid = `er:g:${store || "other"}`;
    sk.push({ type: "rectangle", id: gid, x: 8, y: gy, width: x - ER.GAP + ER.PAD - 8, height: tallest + 56, strokeColor: MUTED, backgroundColor: "transparent", strokeStyle: "dashed", ...crisp });
    sk.push(text(`${gid}:t`, 20, gy + 10, label, 13, MUTED));
    gy += tallest + 56 + 36;
  }
  // A crow's-foot line for each foreign key: many at the referencing column, one at the key it
  // references (one and only one when the column is itself unique).
  for (const t of tables)
    t.columns.forEach((c, i) => {
      const a = at.get(t.name), b = c.fk && at.get(c.fk.table);
      if (!b || a === b) return;
      const ay = a.rows[i];
      const bi = b.t.columns.findIndex((x) => x.name === c.fk.col);
      const by = bi >= 0 ? b.rows[bi] : b.y + ER.HEAD / 2;
      const right = b.x >= a.x + a.w;
      const left = b.x + b.w <= a.x;
      let pts;
      if (right || left) {
        const [ax, bx] = right ? [a.x + a.w, b.x] : [a.x, b.x + b.w];
        const mid = (ax + bx) / 2;
        pts = [[ax, ay], [mid, ay], [mid, by], [bx, by]];
      } else {
        // One above the other: out of the right side of both and back in.
        const ax = a.x + a.w, bx = b.x + b.w, out = Math.max(ax, bx) + 30;
        pts = [[ax, ay], [out, ay], [out, by], [bx, by]];
      }
      const [x0, y0] = pts[0];
      sk.push({
        type: "arrow", id: `er:r:${t.id}:${i}`, x: x0, y: y0, points: pts.map(([px, py]) => [px - x0, py - y0]),
        strokeColor: INK, startArrowhead: c.pk || c.unique ? "crowfoot_one" : "crowfoot_many", endArrowhead: "crowfoot_one", ...crisp,
      });
    });
  return sk;
}

// ---- a flow as a sequence diagram: lifelines, and numbered messages top to bottom ----
export const SEQ = { GAP: 230, BW: 170, BH: 44, TOP: 44, STEP: 58 };

export function drawSequence(model, flow) {
  if (!flow?.steps?.length) return [];
  const ids = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const xOf = new Map(ids.map((id, i) => [id, 30 + i * SEQ.GAP + SEQ.BW / 2]));
  const bottom = SEQ.TOP + SEQ.BH + 34 + flow.steps.length * SEQ.STEP;
  const sk = [text("sq:title", 30, 0, flow.name, 18, INK)];
  for (const id of ids) {
    const n = model.nodes?.[id];
    const cx = xOf.get(id);
    // People are actors: drawn with a pink fill, like "You" everywhere else.
    sk.push({ type: "rectangle", id: `sq:p:${id}`, x: cx - SEQ.BW / 2, y: SEQ.TOP, width: SEQ.BW, height: SEQ.BH, strokeColor: INK, backgroundColor: n?.kind === "user" ? "#fff0f6" : "#f8f9fa", fillStyle: "solid", ...crisp });
    sk.push(text(`sq:p:${id}:t`, cx, SEQ.TOP, n?.name ?? id, 14, INK, { _c: [cx, SEQ.TOP + SEQ.BH / 2] }));
    sk.push({ type: "line", id: `sq:l:${id}`, x: cx, y: SEQ.TOP + SEQ.BH, points: [[0, 0], [0, bottom - SEQ.TOP - SEQ.BH]], strokeColor: MUTED, strokeStyle: "dashed", ...crisp });
  }
  flow.steps.forEach((st, i) => {
    const y = SEQ.TOP + SEQ.BH + 44 + i * SEQ.STEP;
    const x1 = xOf.get(st.from), x2 = xOf.get(st.to);
    const fwd = model.edges?.[`${st.from}>${st.to}`], back = model.edges?.[`${st.to}>${st.from}`];
    // A reply runs back along a link drawn the other way: dashed. Async: an open arrowhead.
    const reply = !fwd && !!back;
    sk.push({
      type: "arrow", id: `sq:m:${i}`, x: x1, y, points: [[0, 0], [x2 - x1, 0]], strokeColor: INK,
      strokeStyle: reply ? "dashed" : "solid", startArrowhead: null, endArrowhead: reply || fwd?.async ? "arrow" : "triangle", ...crisp,
    });
    const label = `${i + 1}. ${st.what || fwd?.api || back?.api || ""}`.trim();
    sk.push(text(`sq:m:${i}:t`, (x1 + x2) / 2, y - 22, clip(label, 44), 13, INK, { _c: [(x1 + x2) / 2, y - 13] }));
  });
  return sk;
}

// ---- inside a layer: the board's map, with the layer's components opened to show their parts ----
// Each open component is a dashed frame at its place on the board, its parts stacked inside
// (tables drawn as in the data model); a component of another layer it talks to stays closed, a
// grey box at its place. Arrows carry what passes between them.
export const IN = { PAD: 16, HEAD: 50, GAP: 38, GX: 210, GY: 110, PH: 50, STUB: 46 };
export const LAYER_TINT = Object.fromEntries(Object.entries(LAYER_COLOR).map(([k, c]) => [k, c.fill]));
const FAINT = "#adb5bd";

export function drawInside(model, layer) {
  const { groups, stubs, links } = insideOf(model, layer);
  if (!groups.length) return [];
  const label = (k) => LAYERS.find((l) => l.key === k)?.label ?? k;
  const tableW = (t) => Math.round(Math.max(200, t.name.length * 9 + 40, ...t.columns.map((c) => (c.name.length + c.type.length) * 7.2 + 76)));
  const partW = (p) => (p.table ? tableW(p.table) : Math.round(Math.max(180, Math.min(300, p.name.length * 8 + 36))));
  const partH = (p) => (p.table ? ER.HEAD + p.table.columns.length * ER.ROW + 8 : IN.PH);
  // Sizes, then the grid: each used column as wide as its widest item, each row as tall as its tallest.
  const items = [
    ...groups.map((g) => {
      const inner = Math.max(220, g.node.name.length * 9.5 + 20, ...g.parts.map(partW));
      const h = IN.HEAD + (g.parts.length ? g.parts.reduce((s, p) => s + partH(p), 0) + IN.GAP * (g.parts.length - 1) : 30) + IN.PAD;
      return { g, node: g.node, w: inner + IN.PAD * 2, h };
    }),
    ...stubs.map((node) => ({ node, w: Math.round(Math.max(140, node.name.length * 8 + 36)), h: IN.STUB })),
  ];
  const cellOf = (n) => n.cell ?? [0, 0];
  const cols = [...new Set(items.map((i) => cellOf(i.node)[0]))].sort((a, b) => a - b);
  const rows = [...new Set(items.map((i) => cellOf(i.node)[1]))].sort((a, b) => a - b);
  const colW = new Map(cols.map((c) => [c, Math.max(...items.filter((i) => cellOf(i.node)[0] === c).map((i) => i.w))]));
  const rowH = new Map(rows.map((r) => [r, Math.max(...items.filter((i) => cellOf(i.node)[1] === r).map((i) => i.h))]));
  const colX = new Map(), rowY = new Map();
  cols.reduce((x, c) => (colX.set(c, x), x + colW.get(c) + IN.GX), 0);
  rows.reduce((y, r) => (rowY.set(r, y), y + rowH.get(r) + IN.GY), 0);

  const sk = [];
  const rects = new Map(); // "node/part" (part "null" for the component) -> { x, y, w, h }
  const tables = new Map(); // table name -> { x, y, w, rows: [row center y], t }
  sk.push(text("in:title", 0, -78, `${label(layer)} layer`, 22, INK));
  sk.push(text("in:sub", 0, -46, "Grey boxes are other layers.", 13, MUTED));
  for (const it of items) {
    const [c, r] = cellOf(it.node);
    const x = colX.get(c) + (colW.get(c) - it.w) / 2;
    if (!it.g) {
      // A component of another layer: closed, at its place.
      const y = rowY.get(r) + (rowH.get(r) - it.h) / 2;
      const id = `in:s:${it.node.id}`;
      sk.push({ type: "rectangle", id, x, y, width: it.w, height: it.h, strokeColor: FAINT, backgroundColor: "#f8f9fa", fillStyle: "solid", roundness: { type: 3 }, ...crisp });
      sk.push(text(`${id}:n`, x, y, clip(it.node.name, 24), 13, MUTED, { _c: [x + it.w / 2, y + 17] }));
      sk.push(text(`${id}:l`, x, y, `${label(layerOf(it.node))} ›`, 10, FAINT, { _c: [x + it.w / 2, y + 33] }));
      rects.set(`${it.node.id}/null`, { x, y, w: it.w, h: it.h });
      continue;
    }
    const { g } = it;
    const y = rowY.get(r);
    const gid = `in:g:${g.node.id}`;
    sk.push({ type: "rectangle", id: gid, x, y, width: it.w, height: it.h, strokeColor: g.partial ? MUTED : INK, backgroundColor: "transparent", strokeStyle: "dashed", ...crisp });
    sk.push(text(`${gid}:n`, x + IN.PAD, y + 10, g.node.name, 16, INK));
    sk.push(text(`${gid}:t`, x + IN.PAD, y + 31, g.partial ? `${C4_TYPE[g.node.kind] ?? "Container"} · only its ${label(layer)} parts` : c4Tag(g.node, 40), 11, MUTED));
    rects.set(`${g.node.id}/null`, { x, y, w: it.w, h: it.h });
    if (!g.parts.length) sk.push(text(`${gid}:e`, x + IN.PAD, y + IN.HEAD + 4, "No parts described yet", 12, MUTED));
    let py = y + IN.HEAD;
    const own = layerOf(g.node);
    for (const p of g.parts) {
      const pw = partW(p), ph = partH(p), px = x + (it.w - pw) / 2;
      const id = `in:p:${g.node.id}:${p.id}`;
      const pl = partLayer(model, p);
      if (p.table) {
        const t = p.table;
        sk.push({ type: "rectangle", id, x: px, y: py, width: pw, height: ph, strokeColor: INK, backgroundColor: "#ffffff", fillStyle: "solid", ...crisp });
        sk.push({ type: "rectangle", id: `${id}:h`, x: px, y: py, width: pw, height: ER.HEAD, strokeColor: INK, backgroundColor: LAYER_TINT.data, fillStyle: "solid", ...crisp });
        sk.push(text(`${id}:n`, px, py, t.name, 15, INK, { _c: [px + pw / 2, py + ER.HEAD / 2] }));
        const rowsAt = t.columns.map((col, i) => {
          const cy = py + ER.HEAD + 4 + i * ER.ROW + ER.ROW / 2;
          const key = [col.pk && "PK", col.fk && "FK", col.unique && !col.pk && "UK"].filter(Boolean).join(" ");
          if (key) sk.push(text(`${id}:k${i}`, px + 8, cy - 7, key, 10, KEY));
          sk.push(text(`${id}:c${i}`, px + 46, cy - 9, col.name, 13, INK));
          if (col.type) sk.push(text(`${id}:y${i}`, px + pw - 10, cy - 8, col.type, 12, MUTED, { _r: px + pw - 10 }));
          return cy;
        });
        tables.set(t.name, { x: px, y: py, w: pw, rows: rowsAt, t, id });
      } else {
        sk.push({ type: "rectangle", id, x: px, y: py, width: pw, height: ph, strokeColor: INK, backgroundColor: LAYER_TINT[pl] ?? "#ffffff", fillStyle: "solid", roundness: { type: 3 }, ...crisp });
        sk.push(text(`${id}:n`, px, py, clip(p.name, Math.floor((pw - 16) / 7.6)), 14, INK, { _c: [px + pw / 2, py + 18] }));
        sk.push(text(`${id}:k`, px, py, [p.kind, pl !== own && label(pl)].filter(Boolean).join(" · "), 11, MUTED, { _c: [px + pw / 2, py + 36] }));
      }
      rects.set(`${g.node.id}/${p.id}`, { x: px, y: py, w: pw, h: ph });
      py += ph + IN.GAP;
    }
  }
  // Foreign keys between tables drawn here: out of the right side of both and back in.
  for (const { t, x, w, rows: rs, id } of tables.values())
    t.columns.forEach((col, i) => {
      const b = col.fk && tables.get(col.fk.table);
      if (!b || b.t === t) return;
      const bi = b.t.columns.findIndex((c) => c.name === col.fk.col);
      const by = bi >= 0 ? b.rows[bi] : b.y + ER.HEAD / 2;
      const out = Math.max(x + w, b.x + b.w) + 24;
      const pts = [[x + w, rs[i]], [out, rs[i]], [out, by], [b.x + b.w, by]];
      sk.push({
        type: "arrow", id: `${id}:fk${i}`, x: pts[0][0], y: pts[0][1], points: pts.map(([px, py]) => [px - pts[0][0], py - pts[0][1]]),
        strokeColor: INK, startArrowhead: col.pk || col.unique ? "crowfoot_one" : "crowfoot_many", endArrowhead: "crowfoot_one", ...crisp,
      });
    });
  // The links. Between components: out of the side facing the other one (stacked in one column, out
  // of both right sides and down a lane beside them, so no line crosses a part). Inside one: straight
  // down to the next part, or along the left edge to a part further away. Several on one side of a
  // box spread out along it.
  const index = new Map(groups.flatMap((g) => g.parts.map((p, i) => [`${g.node.id}/${p.id}`, i])));
  const ends = links
    .map((l, i) => {
      const ka = `${l.from.node}/${l.from.part}`, kb = `${l.to.node}/${l.to.part}`;
      const a = rects.get(ka), b = rects.get(kb);
      if (!a || !b) return null;
      const fa = rects.get(`${l.from.node}/null`), fb = rects.get(`${l.to.node}/null`);
      let sa, sb;
      if (l.from.node === l.to.node) [sa, sb] = Math.abs(index.get(ka) - index.get(kb)) === 1 ? (b.y > a.y ? ["b", "t"] : ["t", "b"]) : ["l", "l"];
      else if (fb.x >= fa.x + fa.w) [sa, sb] = ["r", "l"];
      else if (fb.x + fb.w <= fa.x) [sa, sb] = ["l", "r"];
      else [sa, sb] = ["r", "r"];
      return { i, l, a, b, fa, fb, ka, kb, sa, sb };
    })
    .filter(Boolean);
  const slots = new Map(); // "box|side" -> the ends on it, in order along the side
  const use = (k, side, e, other) => (slots.get(`${k}|${side}`) ?? slots.set(`${k}|${side}`, []).get(`${k}|${side}`)).push({ e, other });
  for (const e of ends) use(e.ka, e.sa, e, e.b), use(e.kb, e.sb, e, e.a);
  const point = new Map(); // `${i}:a` or `${i}:b` -> [x, y]
  for (const [key, list] of slots) {
    const [k, side] = key.split("|");
    const r = rects.get(k);
    const across = side === "l" || side === "r";
    list.sort((p, q) => (across ? p.other.y + p.other.h / 2 - (q.other.y + q.other.h / 2) : p.other.x + p.other.w / 2 - (q.other.x + q.other.w / 2)));
    list.forEach(({ e }, j) => {
      const f = (j + 1) / (list.length + 1);
      const xy = side === "r" ? [r.x + r.w + 4, r.y + r.h * f] : side === "l" ? [r.x - 4, r.y + r.h * f] : side === "b" ? [r.x + r.w * f, r.y + r.h + 4] : [r.x + r.w * f, r.y - 4];
      point.set(`${e.i}:${k === e.ka ? "a" : "b"}`, xy);
    });
  }
  const lanes = new Map(); // a lane's x, by the column it runs beside: how many use it
  for (const e of ends) {
    const [x0, y0] = point.get(`${e.i}:a`), [x1, y1] = point.get(`${e.i}:b`);
    let pts = [[x0, y0], [x1, y1]];
    if (e.sa === "r" && e.sb === "r") {
      const edge = Math.max(e.fa.x + e.fa.w, e.fb.x + e.fb.w);
      const n = lanes.get(edge) ?? 0;
      lanes.set(edge, n + 1);
      const lx = edge + 22 + n * 14;
      pts = [[x0, y0], [lx, y0], [lx, y1], [x1, y1]];
    } else if (e.sa === "l" && e.sb === "l") {
      const lx = e.fa.x + 7;
      pts = [[x0, y0], [lx, y0], [lx, y1], [x1, y1]];
    }
    const faint = stubs.some((n) => n.id === e.l.from.node || n.id === e.l.to.node);
    const down = e.sa === "b" || e.sa === "t";
    const what = e.l.what && clip(e.l.what, 26);
    sk.push({
      type: "arrow", id: `in:l:${e.i}`, x: x0, y: y0, points: pts.map(([px, py]) => [px - x0, py - y0]), strokeColor: faint ? MUTED : INK, endArrowhead: "arrow", ...crisp,
      ...(what && !down ? { label: { text: what, fontSize: 11, strokeColor: MUTED, fontFamily: SANS } } : {}),
    });
    // Between two parts in a row the gap is short: the words go beside the arrow, not on it.
    if (what && down) sk.push(text(`in:l:${e.i}:w`, x0 + 7, (y0 + y1) / 2 - 7, what, 10.5, MUTED));
  }
  return sk;
}
