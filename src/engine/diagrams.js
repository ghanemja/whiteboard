// The read-only diagram views, drawn from the model as Excalidraw skeletons (Board converts and
// places them, as it does the Timeline's): the data model as an ER diagram, and a flow as a UML
// sequence diagram. Both use the official look: 1 px crisp lines and a plain typeface. Pure, so
// `node --test` can run it. Text centered on a point carries `_c: [x, y]`; right-aligned text
// carries `_r: x` (where its right edge goes).
import { INK, MUTED } from "./palette.js";
import { C4_TYPE } from "./views.js";

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
