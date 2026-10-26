// Steering stickers: "Why?", "Not needed" and "Keep this", dragged from Excalidraw's Library onto
// a component or a decision diamond. Board.diff() turns each one into an edit with
// stickerEdit(); stickerItems() in board.js draws the sheet. Pure (no Excalidraw), so
// `node --test` can run it.

// customData.sticker on a sticker's box and label says which one it is; a drop from the Library keeps it.
export const STICKERS = {
  why: { label: "Why?", stroke: "#1971c2", fill: "#74c0fc", angle: -0.07 },
  drop: { label: "Not needed", stroke: "#c92a2a", fill: "#ff8787", angle: 0.05 },
  keep: { label: "Keep this", stroke: "#2b8a3e", fill: "#8ce99a", angle: -0.04 },
};

const box = (e) => [e.x, e.y, e.x + e.width, e.y + e.height];

// What a sticker is stuck on. Its center on a diamond picks that decision (diamonds sit on a
// component's corner, so that's the precise gesture); otherwise the component it overlaps most;
// otherwise any diamond it touches. null when it's on nothing.
//   live(elId) → the element if it's on the board, else null
export function stickerTarget(st, model, live) {
  const [sx1, sy1, sx2, sy2] = box(st);
  const cx = (sx1 + sx2) / 2, cy = (sy1 + sy2) / 2;
  const decs = Object.values(model.decisions ?? {})
    .filter((d) => d.state !== "rejected")
    .map((d) => [d, live(`dec-${d.id}`)])
    .filter(([, el]) => el);
  for (const [d, el] of decs) {
    const [x1, y1, x2, y2] = box(el);
    if (cx > x1 - 12 && cx < x2 + 12 && cy > y1 - 12 && cy < y2 + 12) return { decision: d };
  }
  let best = null, area = 0;
  for (const n of Object.values(model.nodes ?? {})) {
    const el = live(n.elId);
    if (!el) continue;
    const [x1, y1, x2, y2] = box(el);
    const a = Math.max(0, Math.min(sx2, x2) - Math.max(sx1, x1)) * Math.max(0, Math.min(sy2, y2) - Math.max(sy1, y1));
    if (a > area) [best, area] = [n, a];
  }
  if (best) return { node: best };
  const touched = decs.find(([, el]) => {
    const [x1, y1, x2, y2] = box(el);
    return sx1 < x2 + 4 && x1 < sx2 + 4 && sy1 < y2 + 4 && y1 < sy2 + 4;
  });
  return touched ? { decision: touched[0] } : null;
}

// The edit a sticker element makes, or null: its label (which rides on the box) and a sticker
// dropped on nothing make none. A sticker on nothing is just a drawing: nothing is sent.
//   { key, kind: "sticker", sticker, elId, node, name } or { …, decision, label, title, chose }
export function stickerEdit(e, model, live) {
  const sticker = e.customData?.sticker;
  if (!STICKERS[sticker] || e.containerId) return null;
  const hit = stickerTarget(e, model, live);
  if (hit?.node) return { key: `sticker:${e.id}:node:${hit.node.id}`, kind: "sticker", sticker, elId: e.id, node: hit.node.id, name: hit.node.name };
  const d = hit?.decision;
  return d ? { key: `sticker:${e.id}:decision:${d.id}`, kind: "sticker", sticker, elId: e.id, decision: d.id, label: `D${d.n}`, title: d.title, chose: d.chose } : null;
}
