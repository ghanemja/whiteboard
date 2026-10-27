// The guided tour on screen (the steps themselves are engine/tour.js): its card, and the
// spotlight that dims the page round what the step is about and pops the card out beside it.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BOARD } from "./engine/tour";
import { placeCard } from "./engine/spotlight";

// A step's "◇", drawn the way the board draws a decision: D in a purple diamond, dashed until
// the plan is approved.
const marked = (s, proposed) =>
  typeof s === "string" && s.includes("◇")
    ? s.split("◇").flatMap((part, i) => (i ? [<span key={i} className={`dmark${proposed ? " proposed" : ""}`} role="img" aria-label="decision">D</span>, part] : [part]))
    : s;

// The step's card: the same yellow note as the coach, with a step count and a way out.
// A step that waits for the run (it's still planning, say) says so instead of offering Next.
export function TourCard({ step, proposed, n, total, wait, manual, onBack, onNext, onSkip, onExit, finish }) {
  return (
    <div className="coach tour" role="region" aria-label="Tour">
      <div className="coach-top">
        <span className="coach-label">
          Tour · step {n} of {total}
        </span>
        <button className="linkish coach-hide" onClick={onExit} title="Leave the tour: the demo carries on as usual">
          Exit tour
        </button>
      </div>
      <div className="tour-bar" aria-hidden="true">
        <i style={{ width: `${(n / total) * 100}%` }} />
      </div>
      <b className="coach-title">{marked(step.title, proposed)}</b>
      <p>{marked(step.text, proposed)}</p>
      {wait && (
        <p className="tour-wait" role="status">
          <span className="dot" /> {marked(wait, proposed)}
        </p>
      )}
      <div className="tour-actions">
        <button className="linkish" onClick={onBack} disabled={n === 1}>
          ← Back
        </button>
        {finish ? (
          <span className="tour-finish">{finish}</span>
        ) : step.next || manual ? (
          <button className="primary" onClick={onNext}>
            Next →
          </button>
        ) : (
          <button className="linkish" onClick={onSkip} title="Do it for me and go on">
            Skip step
          </button>
        )}
      </div>
    </div>
  );
}

// Where an element is in the window (the first visible one the selector finds), cut to the window.
const rectOf = (sel, vw, vh) => {
  const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null);
  const r = el?.getBoundingClientRect();
  if (!r || r.width <= 0 || r.height <= 0) return null;
  const x = Math.max(r.left, 0), y = Math.max(r.top, 0);
  const w = Math.min(r.right, vw) - x, h = Math.min(r.bottom, vh) - y;
  return w > 0 && h > 0 ? { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) } : null;
};

// A ring round a target, kept on screen: a panel that starts at the window's edge still gets its whole ring.
const ringBox = (r, vw, vh, pad = 5) => {
  const x = Math.max(r.x, 8), y = Math.max(r.y, 8);
  const w = Math.min(r.x + r.w, vw - 8) - x, h = Math.min(r.y + r.h, vh - 8) - y;
  return { x: x - pad, y: y - pad, w: w + pad * 2, h: h + pad * 2 };
};

// The spotlight. targets: the step's [{ sel, label }] to click, each lit with a ring and a
// label; spots: selectors of areas to leave lit without a ring (what to read or watch);
// center: the card in the middle of a dimmed screen (rings still drawn, nothing cut out);
// note(): where the tour's circle on the board is, if any, so the card's arrow points at
// it. The dim, the rings and the labels let every click through, so the page works as usual
// underneath; only the card takes clicks. Re-measured as the layout moves, scrolls or resizes.
export function TourSpotlight({ targets, spots, center, note, children }) {
  const [geo, setGeo] = useState(null);
  const noteRef = useRef(note);
  noteRef.current = note;
  const key = JSON.stringify([targets.map((t) => [t.sel, t.label]), spots]);
  useLayoutEffect(() => {
    const measure = () => {
      const vw = window.innerWidth, vh = window.innerHeight;
      const rings = targets.map((t) => ({ t, r: rectOf(t.sel, vw, vh) })).filter((x) => x.r).map(({ t, r }) => ({ key: t.sel, label: t.label, ...ringBox(r, vw, vh) }));
      const areas = spots.map((sel) => ({ sel, r: rectOf(sel, vw, vh) })).filter((x) => x.r).map(({ sel, r }) => ({ key: sel, ...r }));
      let n = null;
      try {
        n = noteRef.current?.() ?? null;
      } catch {
        /* the board is between scenes */
      }
      const round = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
      const next = { vw, vh, rings, areas, note: n && { ...round(n), around: (n.around ?? []).map(round) } };
      setGeo((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    measure();
    const t = setInterval(measure, 150);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true); // the panel's own scrolling moves its targets
    return () => {
      clearInterval(t);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [key]);

  // What's cut out of the dim: each target (its ring's shape) and each area to leave lit.
  const holes = geo ? [...(center ? [] : geo.rings.map((r) => ({ ...r, r: 12 }))), ...geo.areas.map((a) => ({ ...a, r: 10 }))] : [];
  const holeKeys = new Set(holes.map((h) => h.key));
  // Holes that just closed fade out (a new step's open ones fade in), so the light moves softly.
  const [gone, setGone] = useState([]);
  const shown = useRef([]);
  useEffect(() => {
    const left = shown.current.filter((h) => !holeKeys.has(h.key));
    shown.current = holes;
    if (!left.length) return;
    const leftKeys = new Set(left.map((h) => h.key));
    setGone((g) => [...g.filter((h) => !leftKeys.has(h.key)), ...left.map((h) => ({ ...h, at: Date.now() }))]);
  });
  useEffect(() => {
    if (!gone.length) return;
    const t = setTimeout(() => setGone((g) => g.filter((h) => Date.now() - h.at < 380)), 400);
    return () => clearTimeout(t);
  }, [gone]);

  // The card: beside the first target, else the first lit area, else in the middle. When that's
  // the board and the tour has circled something on it, right beside the circle, over as little
  // of the drawing as it can. It keeps off the other targets and the lit areas.
  let anchor = null;
  const avoid = [];
  if (geo && !center) {
    const board = geo.areas.find((a) => a.key === BOARD);
    anchor = geo.rings[0] ?? geo.areas[0] ?? null;
    const n = geo.note;
    const onBoard = anchor && anchor === board && n && n.x >= board.x && n.y >= board.y && n.x + n.w <= board.x + board.w && n.y + n.h <= board.y + board.h;
    if (onBoard) anchor = { x: n.x, y: n.y, w: n.w, h: n.h };
    for (const r of geo.rings.slice(1)) avoid.push({ ...r, weight: 1000 });
    for (const a of geo.areas) if (a !== anchor && !(onBoard && a === board)) avoid.push({ ...a, weight: a === board ? 10 : 1 });
    if (onBoard) avoid.push(...n.around);
  }
  const card = useRef(null);
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!geo || !card.current) return;
    const p = placeCard(anchor, { w: card.current.offsetWidth, h: card.current.offsetHeight }, { w: geo.vw, h: geo.vh }, avoid);
    setPos((q) => (q && q.side === p.side && q.x === p.x && q.y === p.y && q.caret === p.caret ? q : p));
  });
  // Glide from place to place, but not in from the corner the first time.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!pos || ready) return;
    const f = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(f);
  }, [pos, ready]);

  const side = pos?.side ?? "center";
  const caret = side === "right" ? { left: -8, top: pos.caret - 7 } : side === "left" ? { right: -8, top: pos.caret - 7 } : side === "below" ? { top: -8, left: pos.caret - 7 } : { bottom: -8, left: pos?.caret - 7 };
  return (
    <div className="tour-layer">
      {geo && (
        <svg className="tour-dim" width={geo.vw} height={geo.vh} aria-hidden="true">
          <defs>
            <mask id="tour-cutouts" maskUnits="userSpaceOnUse" x="0" y="0" width={geo.vw} height={geo.vh}>
              <rect x="0" y="0" width={geo.vw} height={geo.vh} fill="#fff" />
              {gone
                .filter((h) => !holeKeys.has(h.key))
                .map((h) => (
                  <rect key={`out:${h.key}`} className="tour-hole out" x={h.x} y={h.y} width={h.w} height={h.h} rx={h.r} />
                ))}
              {holes.map((h) => (
                <rect key={h.key} className="tour-hole" x={h.x} y={h.y} width={h.w} height={h.h} rx={h.r} />
              ))}
            </mask>
          </defs>
          <rect className="tour-shade" x="0" y="0" width={geo.vw} height={geo.vh} mask="url(#tour-cutouts)" />
        </svg>
      )}
      <div className="tour-rings" aria-hidden="true">
        {geo?.rings.map((b) => {
          // At the top of the window the tag goes under the ring; a tall ring (an area) keeps it inside, at its top.
          const tall = b.h >= geo.vh / 2;
          const where = tall ? "inside" : b.y < 40 ? "below" : "";
          return (
            <div key={b.key} className="tour-ring" style={{ left: b.x, top: b.y, width: b.w, height: b.h }}>
              {b.label && <span className={`tour-tag ${where}`}>{marked(b.label)}</span>}
            </div>
          );
        })}
      </div>
      <div
        ref={card}
        className={`tour-pop at-${side} ${ready ? "ready" : ""}`}
        style={{ transform: `translate(${pos?.x ?? 0}px, ${pos?.y ?? 0}px)`, visibility: pos ? undefined : "hidden" }}
      >
        {side !== "center" && <span key={side} className="tour-caret" style={caret} aria-hidden="true" />}
        {children}
      </div>
    </div>
  );
}
