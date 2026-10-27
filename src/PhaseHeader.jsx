import { useMemo, useRef, useState } from "react";
import rough from "roughjs";
import { MILESTONE, PHASES, TASK } from "./engine/board";

// The journey above the board's tabs: the project's name and goal, then
// Plan → Build → Verify → Ship as hand-drawn milestones with a dot per task.
// Drawn with roughjs, the renderer Excalidraw uses, so it matches the canvases.

const gen = rough.generator();
const W = 660, H = 112, R = 26, CY = 36; // viewBox, milestone radius and center line
const X = (i) => 44 + i * 170; // milestone centers
const DOT = 9, GAP = 5, PER_ROW = 8;
const BLUE = "#1971c2";

const seedOf = (s) => {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) % 2 ** 31;
};

// The milestone pictograms (the same drawings the board used), centered on (cx, cy).
function icon(key, cx, cy, color, seed) {
  const k = 0.62;
  const o = (n, extra = {}) => ({ stroke: color, strokeWidth: 1.8, roughness: 1, seed: seed + n, ...extra });
  const P = (x, y) => [cx + x * k, cy + y * k];
  switch (key) {
    case "planning": // a little architecture sketch
      return [
        gen.rectangle(...P(-24, -20), 18 * k, 13 * k, o(1)),
        gen.rectangle(...P(6, -20), 18 * k, 13 * k, o(2)),
        gen.rectangle(...P(-9, 8), 18 * k, 13 * k, o(3)),
        gen.line(...P(-15, -7), ...P(-2, 8), o(4)),
        gen.line(...P(15, -7), ...P(2, 8), o(5)),
      ];
    case "implementation": // </>
      return [
        gen.linearPath([P(-10, -13), P(-23, 0), P(-10, 13)], o(1)),
        gen.linearPath([P(10, -13), P(23, 0), P(10, 13)], o(2)),
        gen.line(...P(5, -16), ...P(-5, 16), o(3)),
      ];
    case "verification": // magnifier with a check
      return [
        gen.circle(...P(-6, -6), 32 * k, o(1)),
        gen.line(...P(6, 6), ...P(20, 20), o(2, { strokeWidth: 3 })),
        gen.linearPath([P(-15, -6), P(-9, 0), P(1, -12)], o(3)),
      ];
    default: // deployment: rocket
      return [
        gen.curve([P(0, -24), P(9, -9), P(8, 10), P(-8, 10), P(-9, -9), P(0, -24)], o(1)),
        gen.circle(...P(0, -6), 8 * k, o(2)),
        gen.linearPath([P(-8, 2), P(-16, 15), P(-7, 11)], o(3)),
        gen.linearPath([P(8, 2), P(16, 15), P(7, 11)], o(4)),
        gen.linearPath([P(-4, 13), P(0, 23), P(4, 13)], o(5, { stroke: "#f76707" })),
      ];
  }
}

const Paths = ({ drawables }) =>
  drawables.flatMap((d) => gen.toPaths(d)).map((p, i) => <path key={i} d={p.d} stroke={p.stroke} strokeWidth={p.strokeWidth} fill={p.fill ?? "none"} />);

function phaseIndex(phase) {
  return phase === "complete" ? PHASES.length : PHASES.findIndex((p) => p.key === phase);
}

export default function PhaseHeader({ model, reviewing, hl, onHover, onFocus }) {
  const wrap = useRef(null);
  const [tip, setTip] = useState(null);
  const cur = phaseIndex(model.phase);
  const tasks = Object.values(model.tasks);

  // The rough drawings only change with the phase, the review pause and the tasks' states.
  const sig = `${model.phase}|${reviewing}|${tasks.map((t) => `${t.id}:${t.phase}:${t.status}`).join(",")}`;
  const art = useMemo(() => {
    return PHASES.map((p, i) => {
      const state = cur === -1 || i > cur ? "future" : i < cur ? "done" : "current";
      const st = MILESTONE[state];
      const cx = X(i);
      const road =
        i < PHASES.length - 1 &&
        gen.line(cx + R + 8, CY, X(i + 1) - R - 8, CY, {
          stroke: i < cur ? MILESTONE.done.stroke : "#dee2e6",
          strokeWidth: 2.5,
          roughness: 1,
          seed: seedOf(`road-${i}`),
          ...(i < cur ? {} : { strokeLineDash: [8, 7] }),
        });
      const circle = gen.circle(cx, CY, R * 2, {
        stroke: st.stroke, strokeWidth: st.width, fill: st.fill, fillStyle: "solid", roughness: 1, seed: seedOf(p.key),
        ...(st.dash === "dashed" ? { strokeLineDash: [6, 5] } : {}),
      });
      return { p, i, state, st, cx, road, circle, icon: icon(p.key, cx, CY, st.icon, seedOf(`${p.key}-i`)) };
    });
  }, [sig]); // eslint-disable-line react-hooks/exhaustive-deps

  const showTip = (e, text) => {
    const box = wrap.current.getBoundingClientRect();
    const r = e.currentTarget.getBoundingClientRect();
    setTip({ text, x: r.left + r.width / 2 - box.left, y: r.bottom - box.top + 6 });
  };
  const hideTip = () => {
    setTip(null);
    onHover([]);
  };

  return (
    <header className="journey" ref={wrap}>
      <div className={`journey-title ${hl.has("title") ? "hl" : ""}`}>
        <h2>{model.project || "No plan yet"}</h2>
        {model.goal ? <p title={model.goal}>{model.goal}</p> : !model.project && <p>The agent draws its plan here.</p>}
      </div>
      <svg className="journey-strip" data-tour="road" viewBox={`0 0 ${W} ${H}`} role="list" aria-label="Development phases">
        {art.map(({ p, i, state, st, cx, road, circle, icon: ic }) => {
          const ts = tasks.filter((t) => t.phase === p.key).sort((a, b) => a.slot - b.slot);
          const done = ts.filter((t) => t.status === "done").length;
          const label = `${p.label}: ${state === "done" ? "done" : state === "current" ? (reviewing ? "waiting for your approval" : "in progress") : "not started"}${ts.length ? `, ${done} of ${ts.length} steps done` : ""}`;
          return (
            <g key={p.key} role="listitem" aria-label={label}>
              {road && <Paths drawables={[road]} />}
              <g
                className="ms"
                onMouseEnter={(e) => {
                  showTip(e, label);
                  onHover([`phase:${p.key}`]);
                }}
                onMouseLeave={hideTip}
                onClick={() => onFocus([`phase:${p.key}`])}
              >
                {hl.has(`phase:${p.key}`) && <circle cx={cx} cy={CY} r={R + 9} className="mark" />}
                <circle cx={cx} cy={CY} r={R + 4} fill="transparent" />
                <Paths drawables={[circle, ...ic]} />
                {state === "done" && (
                  <g>
                    <circle cx={cx + R * 0.72} cy={CY - R * 0.72} r={9} fill={st.stroke} />
                    <text x={cx + R * 0.72} y={CY - R * 0.72 + 4} className="badge">✓</text>
                  </g>
                )}
                {state === "current" && reviewing && (
                  <g>
                    <circle cx={cx + R * 0.72} cy={CY - R * 0.72} r={10} fill={BLUE} />
                    <rect x={cx + R * 0.72 - 4} y={CY - R * 0.72 - 4.5} width={2.6} height={9} fill="#fff" />
                    <rect x={cx + R * 0.72 + 1.4} y={CY - R * 0.72 - 4.5} width={2.6} height={9} fill="#fff" />
                  </g>
                )}
                <text x={cx} y={CY + R + 17} className="ms-label" fill={st.head}>
                  {p.short}
                </text>
              </g>
              {ts.map((t, k) => {
                const row = Math.floor(k / PER_ROW);
                const inRow = Math.min(PER_ROW, ts.length - row * PER_ROW);
                const x = cx - (inRow * DOT + (inRow - 1) * GAP) / 2 + (k % PER_ROW) * (DOT + GAP) + DOT / 2;
                const y = CY + R + 31 + row * (DOT + GAP);
                const c = TASK[t.status] ?? TASK.todo;
                const lid = `task:${t.id}`;
                return (
                  <g
                    key={t.id}
                    className="dot"
                    onMouseEnter={(e) => {
                      showTip(e, `${{ done: "✓", failed: "✗", building: "…" }[t.status] ?? "○"} ${t.text}`);
                      onHover([lid]);
                    }}
                    onMouseLeave={hideTip}
                    onClick={() => onFocus([lid])}
                  >
                    {hl.has(lid) && <circle cx={x} cy={y} r={DOT} className="mark" />}
                    <circle cx={x} cy={y} r={DOT / 2} fill={c.fill === "transparent" ? "#fff" : c.fill} stroke={c.stroke} strokeWidth={1.5} />
                  </g>
                );
              })}
            </g>
          );
        })}
        {model.phase === "complete" && (
          <Paths
            drawables={[
              gen.line(X(3) + R + 22, CY + 20, X(3) + R + 22, CY - 24, { stroke: MILESTONE.done.stroke, strokeWidth: 2.5, roughness: 1, seed: 7 }),
              gen.polygon([[X(3) + R + 22, CY - 24], [X(3) + R + 46, CY - 17], [X(3) + R + 22, CY - 10]], {
                stroke: MILESTONE.done.stroke, strokeWidth: 1.8, fill: "#8ce99a", fillStyle: "solid", roughness: 1, seed: 8,
              }),
            ]}
          />
        )}
      </svg>
      {tip && (
        <div className="journey-tip" style={{ left: tip.x, top: tip.y }} role="tooltip">
          {tip.text}
        </div>
      )}
    </header>
  );
}
