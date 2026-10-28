// The presentable look for exports (Export → Clean): the board's own shapes and words, drawn with
// straight lines, solid fills and a plain font, for slides and docs, instead of the hand-drawn
// sketch the board is on screen. What only makes sense on the live board (stickers and their answer
// bubbles, the tape and pins on notes) is left out. Pure: Excalidraw elements in, elements out, so
// it's tested under node --test; the export itself is Excalidraw's.
const HATCHED = new Set(["hachure", "cross-hatch", "zigzag"]);

export function presentable(elements, { fontFamily }) {
  const live = elements.filter((e) => !e.isDeleted);
  const drop = new Set(live.filter((e) => e.customData?.sticker || e.customData?.answers || e.id.startsWith("tape-") || /:pin(-|$)/.test(e.id)).map((e) => e.id));
  return live
    .filter((e) => !drop.has(e.id) && !drop.has(e.containerId))
    .map((e) => ({
      ...e,
      roughness: 0,
      fillStyle: HATCHED.has(e.fillStyle) ? "solid" : e.fillStyle,
      // Thinner lines read as a diagram rather than a drawing; text keeps its own.
      strokeWidth: e.type === "text" ? e.strokeWidth : Math.min(e.strokeWidth ?? 1, 1.5),
      ...(e.type === "text" ? { fontFamily } : {}),
    }));
}
