import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToBlob, exportToSvg, sceneCoordsToViewportCoords, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { Board, PHASES, STATUS, STICKERS, stickerItems } from "./engine/board";
import PhaseHeader from "./PhaseHeader";
import { Session } from "./engine/session";
import { AREAS, areaOf, fmt, STICKER_WORD } from "./engine/timeline";
import { LAYERS, layerOf, openableLayers, tagCase, toDfdMermaid, toErMermaid, toInsideMermaid, toMermaid, toSequence } from "./engine/views";
import { buildReview, penMarks } from "./engine/review";
import { advance, back as tourBack, holds, isFresh, next as tourNext, startTour, stepOf, targets as tourTargets, tourLength, waiting as tourWaiting } from "./engine/tour";
import { decisionsUrl, getAgentStatus, listRecordings } from "./agent/live";
import { TourCard, TourSpotlight } from "./Tour";

// Tasks that fit the sample repo (sandbox/linkshort, created by `npm run sandbox`).
const EXAMPLES = [
  "Count clicks per link and add GET /stats/:code",
  "Let links expire after a given number of days",
  "Support custom aliases like /launch",
];

// Stable props so Excalidraw doesn't re-render on every streamed character.
const INITIAL_DATA = { appState: { viewBackgroundColor: "#ffffff", currentItemRoughness: 1 } };
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false }, tools: { image: false } };
// The Why and Timeline canvases are drawn for you: look, pan and zoom, click to read (or, in a replay, to jump).
const WHY_UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false, export: false, clearCanvas: false, changeViewBackgroundColor: false, toggleTheme: false } };
const SPEEDS = [1, 2, 4];

const GLYPH = { rename: "✎", remove: "✕", add: "+", link: "→", unlink: "✂", note: "✐", reject: "◇", choose: "⇄", sticker: "◪" };

function describe(d) {
  switch (d.kind) {
    case "rename": return <>Rename <b>{d.from}</b> → <b>{d.to}</b></>;
    case "remove": return <>Remove <b>{d.name}</b></>;
    case "add": return <>Add <b>{d.name}</b></>;
    case "link": return <>Connect <b>{d.fromName}</b> → <b>{d.toName}</b></>;
    case "unlink": return <>Disconnect <b>{d.fromName}</b> → <b>{d.toName}</b></>;
    case "note": return <>Note “{d.text}”</>;
    case "reject": return <>Reject <b>{d.label}</b> ({d.title})</>;
    case "choose": return <><b>{d.label}</b> → <b>{d.to}</b></>;
    case "sticker":
      return (
        <>
          <span className="sticker-chip" style={{ background: STICKERS[d.sticker]?.fill, borderColor: STICKERS[d.sticker]?.stroke }}>{STICKER_WORD[d.sticker]}</span> on{" "}
          {d.decision ? <><b>{d.label}</b> ({d.title})</> : <b>{d.name}</b>}
        </>
      );
    default: return null;
  }
}

// **bold** and `code`, the two bits of markdown agents lean on most.
const Rich = ({ text }) =>
  text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((p, i) =>
    p.startsWith("**") && p.endsWith("**") && p.length > 4 ? (
      <b key={i}>{p.slice(2, -2)}</b>
    ) : p.startsWith("`") && p.endsWith("`") && p.length > 2 ? (
      <code key={i}>{p.slice(1, -1)}</code>
    ) : (
      <span key={i}>{p}</span>
    ),
  );

const ICONS = {
  play: <path d="M5 3.5v9l8-4.5z" fill="currentColor" />,
  pause: <path d="M4.5 3h2.5v10H4.5zM9 3h2.5v10H9z" fill="currentColor" />,
  stop: <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />,
  restart: <path d="M3.5 8a4.5 4.5 0 1 0 1.4-3.3M3.5 2.5v2.7h2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  fit: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  tour: <path d="M4 14V2.5M4 3h7.5l-1.8 2.7L11.5 8.5H4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
  tips: (
    <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.2" />
      <path d="M6.3 6.2a1.8 1.8 0 1 1 3 1.4c-.8.5-1.3.9-1.3 1.7" />
      <circle cx="8" cy="11.6" r=".5" fill="currentColor" />
    </g>
  ),
};
// The Edit the plan toolbar's pictures.
const TOOL_ICONS = {
  select: <path d="M3.5 2.5l9 4.5-4 1.2-1.6 4.3z" />,
  rename: <path d="M10.5 2.5l3 3L5 14H2v-3z" />,
  add: <path d="M3.5 2.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM8 5.5v5M5.5 8h5" />,
  connect: <path d="M2 8h11M9.5 4.5L13 8l-3.5 3.5" />,
  remove: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />,
  note: <path d="M3 2.5h10v7.5l-3.5 3.5H3zM9.5 13.5V10H13" />,
  tools: <path d="M2.5 13.5l3-1 7.5-7.5-2-2L3.5 10.5zM9.5 4.5l2 2M2.5 2.5h3M2.5 2.5v3" />,
  stickers: <path d="M3 3.5h10v6l-3.5 3.5H3zM9.5 13V9.5H13M5.5 6.5h5" />,
};
const ToolIcon = ({ name }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {TOOL_ICONS[name]}
  </svg>
);
const Icon = ({ name }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    {ICONS[name]}
  </svg>
);

// A flow's steps in order, over the board (the numbers match its dots). Hover one to find its link.
function FlowSteps({ flow, model, onHover, onClose }) {
  const name = (id) => model.nodes[id]?.name ?? id;
  return (
    <div className="flow-steps" role="region" aria-label={`Flow: ${flow.name}`}>
      <div className="fs-h">
        <span>{flow.name}</span>
        <button className="linkish" onClick={onClose} aria-label="Show all" title="Show all">
          ✕
        </button>
      </div>
      <ol>
        {flow.steps.map((st, i) => {
          const key = model.edges[`${st.from}>${st.to}`] ? `${st.from}>${st.to}` : `${st.to}>${st.from}`;
          return (
            <li key={i} onMouseEnter={() => onHover([`edge:${key}`, `node:${st.from}`, `node:${st.to}`])} onMouseLeave={() => onHover([])}>
              <span className="fs-n">{i + 1}</span>
              <span>
                {name(st.from)} → {name(st.to)}
                {st.what && <span className="fs-what">{st.what}</span>}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// Board edits grouped by what they change: ▢ architecture, ◇ decision, ✐ scope.
function EditList({ decisions }) {
  return (
    <ul className="edits">
      {Object.entries(AREAS).map(([a, { icon, label }]) => {
        const ds = decisions.filter((d) => areaOf(d) === a);
        return (
          ds.length > 0 && (
            <li key={a} className={`edit-area ea-${a}`}>
              <span className="ea-h">
                {icon} {label}
              </span>
              <ul>
                {ds.map((d) => (
                  <li key={d.key ?? editKey(d)}>
                    <span className={`g g-${d.kind}`}>{GLYPH[d.kind]}</span>
                    <span>{describe(d)}</span>
                  </li>
                ))}
              </ul>
            </li>
          )
        );
      })}
    </ul>
  );
}
const editKey = (d) => `${d.kind}:${d.node ?? d.decision ?? d.elId ?? ""}:${d.to ?? d.name ?? d.text ?? ""}`;

const phaseState = (key, current) => {
  const cur = current === "complete" ? PHASES.length : PHASES.findIndex((p) => p.key === current);
  const i = PHASES.findIndex((p) => p.key === key);
  return cur === -1 ? "todo" : i < cur ? "done" : i === cur ? "current" : "todo";
};

const ACT = {
  read: { icon: "◔", verb: "Read" },
  search: { icon: "⌕", verb: "Searched" },
  edit: { icon: "✎", verb: "Edited" },
  write: { icon: "+", verb: "Created" },
  command: { icon: "$", verb: "" },
  tool: { icon: "·", verb: "Used" },
};

// One row of real work: what the agent read, edited or ran.
function Activity({ a, linked, onHover, onFocus }) {
  const meta = ACT[a.kind] ?? ACT.tool;
  const many = a.labels.length > 1;
  const label =
    a.kind === "command" ? a.labels[0] : many ? `${meta.verb} ${a.labels.length} ${a.kind === "read" ? "files" : "patterns"}` : `${meta.verb} ${a.labels[0]}`;
  const hasIds = a.ids.size > 0;
  return (
    <div
      id={a.id}
      className={["act", `act-${a.kind}`, hasIds && "has-ops", linked.has(a.id) && "linked"].filter(Boolean).join(" ")}
      title={many ? a.labels.join("\n") : undefined}
      onMouseEnter={() => hasIds && onHover([...a.ids])}
      onMouseLeave={() => onHover([])}
      onClick={() => hasIds && onFocus([...a.ids])}
    >
      <span className="act-icon" aria-hidden="true">{meta.icon}</span>
      <span className="act-body">
        <span className="act-label">{label}</span>
        {a.summary && <span className="act-summary">{a.summary}</span>}
      </span>
      {a.ok === true && <span className="act-ok" aria-label="succeeded">✓</span>}
      {a.ok === false && <span className="act-bad" aria-label="failed">✗</span>}
    </div>
  );
}

// A sentence's receipt: what the run's record says about its claims (src/engine/claims.js).
const RC = { ok: "✓", unknown: "?", bad: "✗" };
const RC_WORD = { ok: "checked", unknown: "can't tell", bad: "not true" };
const RC_SAID = { ok: "Backed by the record", unknown: "Nothing in the record says either way", bad: "The record contradicts this" };
function Receipt({ r }) {
  const bad = r.claims.filter((c) => c.verdict === "bad");
  return (
    <span className={`rcpt rc-${r.verdict}`} title={`${RC_SAID[r.verdict]} (git and the test output):\n${r.claims.map((c) => `${RC[c.verdict]} “${c.text}”: ${c.why}`).join("\n")}`}>
      {RC[r.verdict]} {RC_WORD[r.verdict]}
      {bad.length > 0 && <span className="rcpt-why">: {bad.map((c) => c.short ?? c.why).join(", ")}</span>}
    </span>
  );
}

// Skim mode keeps the sentences that carry weight: they drew on the board, claim something
// checkable, ask you something or state an assumption (and the one being written).
const weighty = (s) => s.live || s.ops > 0 || s.claims?.length > 0 || s.asks || s.assumes;

function AgentMessage({ m, phase, linked, onHover, onFocus, receipts, skim }) {
  const [opened, setOpened] = useState(() => new Set()); // paragraphs expanded in skim mode
  // Paragraphs of sentences, with phase headings and activity rows in between.
  const blocks = [];
  let para = null;
  for (const it of m.items) {
    if (it.type === "br") para = null;
    else if (it.type === "phase" || it.type === "act") {
      blocks.push(it);
      para = null;
    } else if (it.text) {
      if (!para) blocks.push((para = { type: "p", sentences: [] }));
      para.sentences.push(it);
    }
  }
  const lastP = blocks.findLastIndex((b) => b.type === "p");
  // Skim: paragraphs with nothing worth keeping fold, and folds next to each other merge into one.
  const keep = (s) => weighty(s) || linked.has(s.id);
  const view = [];
  blocks.forEach((b, bi) => {
    if (b.type === "p" && skim && !opened.has(bi) && !b.sentences.some(keep)) {
      const last = view.at(-1);
      if (last?.type === "fold") {
        last.n += b.sentences.length;
        last.bis.push(bi);
      } else view.push({ type: "fold", n: b.sentences.length, bis: [bi] });
    } else view.push({ ...b, bi });
  });

  return (
    <div className="msg agent">
      <div className="who">
        <span className="avatar">A</span>Agent
        {m.streaming && <span className="typing">working…</span>}
      </div>
      {view.map((b) => {
        const bi = b.bi;
        if (b.type === "fold")
          return (
            <p key={`fold-${b.bis[0]}`} className="skimmed">
              <button className="skim-gap" onClick={() => setOpened((o) => new Set([...o, ...b.bis]))} title={`${b.n} sentence${b.n === 1 ? "" : "s"} skim folded away: show them`}>
                ⋯ {b.n}
              </button>
            </p>
          );
        if (b.type === "phase") {
          const i = PHASES.findIndex((p) => p.key === b.key);
          const st = phaseState(b.key, phase);
          return (
            <div key={bi} className={`section ${st}`}>
              <span className="num">{st === "done" ? "✓" : i + 1}</span>
              {PHASES[i]?.label}
            </div>
          );
        }
        if (b.type === "act") return <Activity key={b.id} a={b} linked={linked} onHover={onHover} onFocus={onFocus} />;
        // Inside a paragraph, a run of sentences that carry no weight folds into "⋯ n", which opens it.
        const all = !skim || opened.has(bi);
        const parts = [];
        for (const s of b.sentences) {
          if (all || keep(s)) parts.push(s);
          else if (parts.at(-1)?.gap) parts.at(-1).gap++;
          else parts.push({ gap: 1, id: `gap-${s.id}` });
        }
        return (
          <p key={bi} className={skim && !all ? "skimmed" : undefined}>
            {parts.map((s) =>
              s.gap ? (
                <span key={s.id}>
                  <button className="skim-gap" onClick={() => setOpened((o) => new Set(o).add(bi))} title="Show the whole paragraph">
                    ⋯ {s.gap}
                  </button>{" "}
                </span>
              ) : (
                <span key={s.id}>
                  <span
                    id={s.id}
                    className={["s", s.live && "live", linked.has(s.id) && "linked", s.ops > 0 && "has-ops", s.asks && "asks", s.assumes && "assumes"].filter(Boolean).join(" ")}
                    title={s.asks ? "The agent asked you this" : s.assumes ? "An assumption the agent is working from" : s.ops > 0 && !s.live ? "Hover to see what this changed on the board; click to jump there" : undefined}
                    onMouseEnter={() => s.ids.size && onHover([...s.ids])}
                    onMouseLeave={() => onHover([])}
                    onClick={() => s.ids.size && onFocus([...s.ids])}
                  >
                    <Rich text={s.text} />
                  </span>
                  {receipts?.get(s.id) && <Receipt r={receipts.get(s.id)} />}{" "}
                </span>
              ),
            )}
            {m.streaming && bi === lastP && <span className="caret" />}
          </p>
        );
      })}
    </div>
  );
}

const when = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(+d) ? "" : d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const minutes = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`);

// Saved runs: replay one as it happened, reopen its final board, or read its decisions.
function SavedRuns({ recordings, onReplay, onOpen }) {
  if (!recordings.length) return null;
  return (
    <div className="saved">
      <div className="saved-h">Saved boards</div>
      {recordings.slice(0, 6).map((r) => (
        <div key={r.id} className="saved-row">
          <div className="saved-what">
            <span className="saved-name">{r.project || r.brief}</span>
            <span className="saved-meta">
              {when(r.startedAt)} · {r.repo?.split("/").pop()} · {minutes(r.duration)}
              {r.cost != null ? ` · $${r.cost.toFixed(2)}` : ""}
              {r.phase === "complete" ? " · shipped" : ""}
            </span>
          </div>
          <div className="saved-actions">
            <button className="linkish" onClick={() => onReplay(r.id)} title="Watch the run play back on the board">
              Replay
            </button>
            <button className="linkish" onClick={() => onOpen(r.id)} title="Open the board as it ended">
              Open
            </button>
            <a className="linkish" href={decisionsUrl(r.id)} target="_blank" rel="noreferrer" title="Who decided what, and when">
              Decisions
            </a>
          </div>
        </div>
      ))}
    </div>
  );
}

// One changed file: path and +/−, opening to its patch.
function FileDiff({ f }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="fd">
      <button className="fd-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} title={open ? "Hide the diff" : "Show the diff"}>
        <span className="fd-caret" aria-hidden="true">{open ? "▾" : "▸"}</span>
        <code className="fd-path">{f.path}</code>
        <span className="fd-add">+{f.add}</span>
        <span className="fd-del">−{f.del}</span>
      </button>
      {open && (
        <pre className="patch">
          {(f.patch || (f.binary ? "Binary file" : "No diff recorded")).split("\n").map((l, i) => (
            <span key={i} className={l.startsWith("@@") ? "h" : l[0] === "+" ? "a" : l[0] === "-" ? "d" : undefined}>
              {l || " "}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}

// The end of a run: what needs a look, each row linked to where to look (src/engine/review.js).
function ReviewCard({ rows, onGo }) {
  const todo = rows.filter((r) => r.tone === "bad" || r.tone === "warn").length;
  return (
    <div className="review" role="region" aria-label="Review">
      <div className="rv-head">
        <span className="hand">Review</span>
        {todo > 0 && (
          <span className="rv-count" title={`${todo} to check before you trust this run`}>
            {todo} to look at
          </span>
        )}
      </div>
      <p className="rv-note">What the agent said, checked against git and the test output. Start with ✗ and ?.</p>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className={`rv rv-${r.tone}`} data-tour={r.tone === "bad" ? "untrue" : undefined}>
            <span className="rv-icon" aria-hidden="true">{r.icon}</span>
            <span className="rv-body">
              <span>{r.text}</span>
              {r.links.length > 0 && (
                <span className="rv-links">
                  {r.links.map((l, i) => (
                    <button key={i} className="rv-link" disabled={!l.lid} title={l.title} onClick={() => onGo(l.lid)}>
                      {l.label}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// One of its questions for you (answer it here) or an assumption it works from (confirm or correct it).
function QuestionCard({ q, dLabel, canAnswer, onAnswer, onConfirm, onCorrect, link }) {
  const [text, setText] = useState("");
  const isQ = q.kind === "question";
  const stop = (e) => e.stopPropagation();
  return (
    <div {...link(`question:${q.id}`)} className={["plan-card", "qcard", `q-${q.kind}`, `qs-${q.state}`, link(`question:${q.id}`).className].filter(Boolean).join(" ")}>
      <div className="pc-head">
        <span className={`qmark ${isQ ? "asks" : "assumes"}`}>{isQ ? "?" : "≈"}</span>
        <b>{isQ ? `Q${q.n}` : `A${q.n}`}</b>
        <span className="q-text">{q.text}</span>
        {q.about && (
          <span className="chip" title={`About ${dLabel(q.about)}`}>
            {dLabel(q.about)}
          </span>
        )}
      </div>
      {q.state === "answered" && (
        <p className="q-done" title="Answered">
          ✓ <b>{q.answer}</b>
        </p>
      )}
      {q.state === "confirmed" && <p className="q-done" title="Confirmed">✓</p>}
      {q.state === "corrected" && <p className="q-done corrected" title="Corrected">↻</p>}
      {q.state === "open" && canAnswer && isQ && (
        <form
          className="q-answer"
          onClick={stop}
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim()) onAnswer(q, text.trim());
          }}
        >
          {q.options.map((o) => (
            <button type="button" key={o} className="q-opt" onClick={() => onAnswer(q, o)}>
              {o}
            </button>
          ))}
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder={q.options.length ? "Other…" : "Answer…"} aria-label="Your answer" />
          <button type="submit" className="q-send" disabled={!text.trim()} title="Send your answer">
            ↵
          </button>
        </form>
      )}
      {q.state === "open" && canAnswer && !isQ && (
        <div className="q-answer" onClick={stop}>
          <button className="q-opt" onClick={() => onConfirm(q)} title="Right (the agent sees it with your next message or approval)" aria-label="Right">
            ✓
          </button>
          <button className="q-opt" onClick={() => onCorrect(q)} title="Correct it" aria-label="Correct it">
            ✎
          </button>
        </div>
      )}
      {q.state === "open" && !canAnswer && (
        <p className="q-done open" title="Left open">
          …
        </p>
      )}
    </div>
  );
}

const STATUS_DOT = { planned: "#adb5bd", building: "#e8590c", built: "#1971c2", verified: "#2f9e44", failed: "#e03131", live: "#6741d9" };
const KIND_WORD = { client: "Client", service: "Service", data: "Data store", external: "External API", queue: "Queue", test: "Tests", user: "User" };
// The diagrams the board can show (the Diagram picker above it).
const DIAGRAMS = [
  { key: "pictures", label: "Pictures", title: "Pictograms: what each part is at a glance" },
  { key: "c4", label: "C4", title: "C4 container diagram: each part's type and technology" },
  { key: "dfd", label: "Data flow", title: "Data flow diagram: processes, data stores, external entities, and the data between them" },
  { key: "er", label: "Database", title: "Entity-relationship (ER) diagram: the tables, their keys, and how they relate" },
  { key: "sequence", label: "Sequence", title: "UML sequence diagram: one flow, step by step" },
];
// Labels in sentence case: "proposed" → "Proposed".
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The development plan as a document: goal, architecture, connections, the reasoning
// chain of decisions, and the steps. Every item is linked to its picture on the board.
function PlanView({ model, phase, selected, onHover, onFocus, onChallenge, onPick, onShowFlow, canChallenge, changes = [], commits = 0, passing = [], onAnswer, onConfirm, onCorrect, onReply, onShow }) {
  const nodes = Object.values(model.nodes);
  const changed = nodes.filter((n) => n.diff);
  const byPath = new Map(changes.map((f) => [f.path, f]));
  const toCode = (id) => document.getElementById(`plan-code:${id}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  const edges = Object.values(model.edges);
  const decisions = Object.values(model.decisions).sort((a, b) => a.n - b.n);
  const tasks = Object.values(model.tasks);
  const name = (id) => model.nodes[id]?.name ?? id;
  const dLabel = (id) => (model.decisions[id] ? `D${model.decisions[id].n}` : id);
  const questions = Object.values(model.questions ?? {}).sort((a, b) => (a.kind === b.kind ? a.n - b.n : a.kind === "question" ? -1 : 1));
  if (!nodes.length && !decisions.length && !model.goal)
    return <p className="hint plan-empty">The plan appears here as the agent works: its goal, architecture, connections, and the decisions behind them.</p>;

  const link = (lid) => ({
    id: `plan-${lid}`,
    className: selected.has(lid) ? "linked" : undefined,
    onMouseEnter: () => onHover([lid]),
    onMouseLeave: () => onHover([]),
    onClick: () => onFocus([lid]),
  });

  return (
    <div className="plan">
      {model.goal && (
        <section>
          <h3>Goal</h3>
          <p className="plan-goal">{model.goal}</p>
        </section>
      )}

      {(questions.length > 0 || passing.length > 0) && (
        <section id="plan-questions">
          <h3 title="What it asked you, and what it's assuming">For you</h3>
          {questions.map((q) => (
            <QuestionCard key={q.id} q={q} dLabel={dLabel} canAnswer={canChallenge} onAnswer={onAnswer} onConfirm={onConfirm} onCorrect={onCorrect} link={link} />
          ))}
          {passing.length > 0 && (
            <div className="passing">
              <div className="ps-phase" title="Only said in its messages, not asked on the board">In passing</div>
              {passing.map((p) => (
                <div key={p.id} className="pass-row">
                  <span className={`qmark ${p.kind}`}>{p.kind === "asks" ? "?" : "≈"}</span>
                  <button className="pass-text" onClick={() => onShow(p.id)} title="Show it in the conversation">
                    {p.text}
                  </button>
                  {canChallenge && (
                    <button className="q-opt" onClick={() => onReply(p)} title={p.kind === "asks" ? "Reply" : "Correct it"} aria-label={p.kind === "asks" ? "Reply" : "Correct it"}>
                      {p.kind === "asks" ? "↩" : "✎"}
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {nodes.length > 0 && (
        <section>
          <h3>Architecture</h3>
          {nodes.map((n) => (
            <div key={n.id} {...link(`node:${n.id}`)} className={["plan-card", selected.has(`node:${n.id}`) && "linked"].filter(Boolean).join(" ")}>
              <div className="pc-head">
                <span className="pc-dot" style={{ background: STATUS_DOT[n.status] }} title={cap(n.status)} />
                <b>{n.name}</b>
                <span className="pc-kind">{KIND_WORD[n.kind] ?? n.kind}</span>
              </div>
              {n.libs?.length > 0 && (
                <div className="chips">
                  {n.libs.map((l) => (
                    <span key={l} className="chip">{l}</span>
                  ))}
                </div>
              )}
              {n.api?.length > 0 && (
                <ul className="pc-api">
                  {n.api.map((a) => (
                    <li key={a}><code>{a}</code></li>
                  ))}
                </ul>
              )}
              {n.paths?.length > 0 && <div className="pc-files">{n.paths.join(" · ")}</div>}
              {n.diff && (
                <button
                  className="pc-diff"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    toCode(n.id);
                  }}
                  title={`Changed in this run: ${n.diff.files.join(", ")}`}
                >
                  <span className="fd-add">+{n.diff.add}</span> <span className="fd-del">−{n.diff.del}</span>
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {edges.length > 0 && (
        <section>
          <h3>Connections</h3>
          <ul className="plan-edges">
            {edges.map((e) => (
              <li key={`${e.from}>${e.to}`} {...link(`edge:${e.from}>${e.to}`)}>
                <span>{name(e.from)} → {name(e.to)}</span>
                {e.via && <span className="chip">{tagCase(e.via)}</span>}
                {e.api && <code>{e.api}</code>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {Object.keys(model.tables ?? {}).length > 0 && (
        <section>
          <h3>Data model</h3>
          {Object.values(model.tables).map((t) => (
            <div
              key={t.id}
              {...(t.of && model.nodes[t.of] ? link(`node:${t.of}`) : {})}
              className={["plan-table", t.of && model.nodes[t.of] && link(`node:${t.of}`).className].filter(Boolean).join(" ")}
            >
              <div className="pt-name">
                <b>{t.name}</b>
                {t.of && model.nodes[t.of] && <span className="pc-kind">{name(t.of)}</span>}
              </div>
              <ul>
                {t.columns.map((c) => (
                  <li key={c.name}>
                    <code>{c.name}</code>
                    {c.type && <span className="pt-type">{c.type}</span>}
                    {c.pk && <span className="pt-key">PK</span>}
                    {c.fk && (
                      <span className="pt-key" title={`References ${c.fk.table}.${c.fk.col}`}>
                        FK → {c.fk.table}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {Object.keys(model.flows ?? {}).length > 0 && (
        <section>
          <h3>Flows</h3>
          {Object.values(model.flows).map((f) => (
            <div key={f.id} className="plan-flow">
              <button className="linkish pf-name" onClick={() => onShowFlow(f.id)} title="Show it on the board">
                {f.name}
              </button>
              <ol>
                {f.steps.map((st, i) => (
                  <li key={i}>
                    {name(st.from)} → {name(st.to)}
                    {st.what && <code>{st.what}</code>}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </section>
      )}

      {decisions.length > 0 && (
        <section>
          <h3>Decisions <span className="h3-note">the reasoning chain</span></h3>
          <details className="whats">
            <summary>What's a decision?</summary>
            <p>
              A technical choice the agent made, like which route to add or where data is kept. Pick another option under <b>Over</b>,
              press <b>Ask why</b>, or delete its ◇ on the board to reject it, and the plan changes to match. Its <b>Check</b> is how
              we'll know it was right: usually a test.
            </p>
          </details>
          {decisions.map((d) => (
            <div key={d.id} {...link(`decision:${d.id}`)} className={["plan-card", "decision", `ds-${d.state}`, selected.has(`decision:${d.id}`) && "linked"].filter(Boolean).join(" ")}>
              <div className="pc-head">
                <span className="dmark">D{d.n}</span>
                <b>{d.title}</b>
                {(d.proof || d.verify) && (
                  <span className={`dproof pf-${d.proof ?? "pending"}`} title={d.proof ? "Its check" : "Not checked yet"}>
                    {d.proof === "pass" ? "✓ Proven" : d.proof === "fail" ? "✗ Failed" : "Unchecked"}
                  </span>
                )}
                <span className={`dstate ds-${d.state}`}>{cap(d.state)}</span>
              </div>
              <dl>
                <dt>Chose</dt>
                <dd><b>{d.chose}</b></dd>
                {d.was?.length > 0 && (
                  <>
                    <dt>Before</dt>
                    <dd className="was">{d.was.join(" → ")}</dd>
                  </>
                )}
                {d.cause && (
                  <>
                    <dt>Because</dt>
                    <dd className={`cause cause-${d.cause.who}`}>
                      {d.cause.who === "you" ? "You asked: " : "A check failed: "}
                      {d.cause.text}
                    </dd>
                  </>
                )}
                {d.over.length > 0 && (
                  <>
                    <dt>Over</dt>
                    <dd className="over">
                      {canChallenge && d.state !== "rejected"
                        ? d.over.map((o, i) => (
                            <button
                              key={o}
                              className="alt-pick"
                              title="Pick this instead (then Submit)"
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onPick(d, i);
                              }}
                            >
                              ⇄ {o}
                            </button>
                          ))
                        : d.over.join(" · ")}
                    </dd>
                  </>
                )}
                {d.why && (
                  <>
                    <dt>Why</dt>
                    <dd>{d.why}</dd>
                  </>
                )}
                {d.evidence.length > 0 && (
                  <>
                    <dt>Evidence</dt>
                    <dd>
                      <ul className="evidence">
                        {d.evidence.map((ev) => (
                          <li key={ev}><Rich text={ev.replace(/(\b[\w./-]+\.(js|ts|tsx|jsx|py|json|md|go|rs|java|rb|yaml|yml|toml)\b)/g, "`$1`")} /></li>
                        ))}
                      </ul>
                    </dd>
                  </>
                )}
                {d.verify && (
                  <>
                    <dt>Check</dt>
                    <dd>{d.verify}</dd>
                  </>
                )}
                {d.proof && (
                  <>
                    <dt>Proof</dt>
                    <dd className={`proof pf-${d.proof}`}>
                      {d.proof === "pass" ? "✓ " : "✗ "}
                      {d.proof_by || (d.proof === "pass" ? "passed" : "failed")}
                    </dd>
                  </>
                )}
                {(d.affects.length > 0 || d.builds_on.length > 0) && (
                  <>
                    <dt>Links</dt>
                    <dd className="dlinks">
                      {d.affects.map((a) => (
                        <span key={a} className="chip" onMouseEnter={() => onHover([`node:${a}`])} onMouseLeave={() => onHover([])}>{name(a)}</span>
                      ))}
                      {d.builds_on.map((b) => (
                        <span key={b} className="chip builds" title="Builds on this decision" onMouseEnter={() => onHover([`decision:${b}`])} onMouseLeave={() => onHover([])}>
                          after {dLabel(b)}
                        </span>
                      ))}
                    </dd>
                  </>
                )}
              </dl>
              {canChallenge && d.state !== "rejected" && (
                <button
                  className="linkish challenge"
                  title="Challenge it: starts a message about this decision for you to finish"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onChallenge(d);
                  }}
                >
                  Ask why
                </button>
              )}
            </div>
          ))}
        </section>
      )}

      {changes.length > 0 && (
        <section id="plan-code">
          <h3 title={`${changes.length} files changed in this run, ${commits ? `in ${commits} commits` : "not committed"}`}>
            Code{" "}
            <span className="h3-note">
              <span className="fd-add">+{changes.reduce((a, f) => a + f.add, 0)}</span> <span className="fd-del">−{changes.reduce((a, f) => a + f.del, 0)}</span> ·{" "}
              {commits ? `${commits} commit${commits === 1 ? "" : "s"}` : "uncommitted"}
            </span>
          </h3>
          {changed.map((n) => (
            <div key={n.id} id={`plan-code:${n.id}`} className="code-group" onMouseEnter={() => onHover([`node:${n.id}`])} onMouseLeave={() => onHover([])}>
              <div className="cg-head">
                <span className="pc-dot" style={{ background: STATUS_DOT[n.status] }} />
                <b>{n.name}</b>
              </div>
              {n.diff.files.map((p) => byPath.get(p) && <FileDiff key={p} f={byPath.get(p)} />)}
            </div>
          ))}
          {model.unowned?.length > 0 && (
            <div id="plan-code:unowned" className="code-group unowned">
              <div className="cg-head" title="No component on the board owns these files">
                <b>Not on board</b>
              </div>
              {model.unowned.map((f) => <FileDiff key={f.path} f={byPath.get(f.path) ?? f} />)}
            </div>
          )}
        </section>
      )}

      {tasks.length > 0 && (
        <section>
          <h3>Steps</h3>
          {PHASES.map((p) => {
            const ts = tasks.filter((t) => t.phase === p.key).sort((a, b) => a.slot - b.slot);
            if (!ts.length) return null;
            return (
              <div key={p.key} id={`plan-phase:${p.key}`} className="plan-steps">
                <div className="ps-phase">{p.label}</div>
                {ts.map((t) => (
                  <div key={t.id} {...link(`task:${t.id}`)} className={["ps-task", `ts-${t.status}`, selected.has(`task:${t.id}`) && "linked"].filter(Boolean).join(" ")}>
                    <span className="ps-dot" />
                    {t.text}
                  </div>
                ))}
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

// The coach: which of the four steps you're on and what to do now, in a sentence or two.
// Hide tips folds it away (remembered per browser); the ? in the title bar brings it back.
const STEPS = ["Describe", "Plan", "Build", "Check"];
function Coach({ c, onHide, onTour }) {
  return (
    <div className="coach" role="region" aria-label="What to do now">
      <div className="coach-top">
        {c.n ? (
          <ol className="coach-steps" aria-label={`Step ${c.n} of ${STEPS.length}`}>
            {STEPS.map((name, i) => (
              <li key={name} className={i + 1 < c.n ? "done" : i + 1 === c.n ? "now" : ""} aria-current={i + 1 === c.n ? "step" : undefined}>
                {name}
              </li>
            ))}
          </ol>
        ) : (
          <span className="coach-label">{c.label}</span>
        )}
        <span className="coach-links">
          {onTour && (
            <button className="linkish coach-hide" onClick={onTour} title="Take the tour: a guided run of the demo that waits while you try each step">
              Tour
            </button>
          )}
          <button className="linkish coach-hide" onClick={onHide} title="Hide the tips (the ? button above brings them back)">
            Hide tips
          </button>
        </span>
      </div>
      <b className="coach-title">{c.title}</b>
      <p>{c.text}</p>
      {c.action && (
        <button className="secondary coach-act" onClick={c.action.run}>
          {c.action.label}
        </button>
      )}
    </div>
  );
}

// Click to explain: the one thing selected on the board, in plain words, and what you can do
// to it. The board stays pictures; the words are on this card beside it.
const STATUS_WORD = { planned: "New: not built yet", building: "Being built now", built: "Exists", verified: "Tested ✓", failed: "A test failed ✗", live: "Shipped ★" };
const KIND_HELP = {
  client: "What people use: a web page or an app.",
  service: "A program that answers requests from the other parts.",
  data: "Where data is kept: a database, a file or a cache.",
  external: "A service someone else runs, reached over the network.",
  queue: "A waiting line for jobs, so slow work runs in the background.",
  test: "Tests that check the code does what it should.",
  user: "A person using the system.",
};
const DSTATE_WORD = { proposed: "Proposed: not approved yet", accepted: "Approved", changed: "Changed", rejected: "Rejected" };
const PROOF_WORD = { pass: "Proven by a test ✓", fail: "Failed its check ✗" };
function Explain({ lid, model, live, onClose, onRename, onRemove, onAsk, onChallenge, onPick, onOpen, onCode, onInside, onAnswer, onConfirm, onCorrect }) {
  const [k, id] = lid.split(/:(.*)/s);
  const name = (n) => model.nodes[n]?.name ?? n;
  const n = k === "node" && model.nodes[id];
  const d = k === "decision" && model.decisions[id];
  const e = k === "edge" && model.edges[id];
  const q = k === "question" && model.questions[id];
  if (!n && !d && !e && !q) return null;
  const row = (label, value) => value && (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
  let body;
  if (n) {
    const links = Object.values(model.edges).filter((x) => x.from === id || x.to === id);
    const decs = Object.values(model.decisions).filter((x) => x.affects.includes(id) && x.state !== "rejected");
    body = (
      <>
        <div className="ex-kicker">You selected a part</div>
        <h3>{n.name}</h3>
        <div className="ex-chips">
          <span className="ex-status" style={{ "--st": STATUS[n.status]?.stroke }}>{STATUS_WORD[n.status] ?? n.status}</span>
          <span className="chip">{KIND_WORD[n.kind] ?? n.kind}</span>
        </div>
        <p className="ex-help">{KIND_HELP[n.kind]}</p>
        <dl className="ex-dl">
          {row("Exposes", n.api?.length > 0 && <code>{n.api.join("\n")}</code>)}
          {row("Uses", n.libs?.length > 0 && n.libs.join(", "))}
          {row(
            "Files",
            n.paths?.length > 0 && (
              <>
                <code>{n.paths.join("\n")}</code>
                {n.diff && (
                  <span className="ex-diff">
                    <b className="add">+{n.diff.add}</b> <b className="del">−{n.diff.del}</b>
                  </span>
                )}
              </>
            ),
          )}
          {row(
            "Decisions",
            decs.length > 0 &&
              decs.map((x) => (
                <button key={x.id} className="chip ex-chip" onClick={() => onOpen(`decision:${x.id}`)}>
                  ◇ D{x.n} {x.title}
                </button>
              )),
          )}
          {row(
            "Connects",
            links.length > 0 &&
              links.map((x) => (
                <div key={`${x.from}>${x.to}`}>
                  {x.from === id ? `→ ${name(x.to)}` : `← ${name(x.from)}`}
                  {x.via && <span className="ex-faint"> ({tagCase(x.via)})</span>}
                </div>
              )),
          )}
        </dl>
        <div className="ex-actions">
          {layerOf(n) && (
            <button className="secondary" onClick={() => onInside(layerOf(n))} title={`Open the ${LAYERS.find((l) => l.key === layerOf(n))?.label} layer: what's inside this part and its neighbours`}>
              Look inside
            </button>
          )}
          {live && (
            <>
              <button className="secondary" onClick={() => onRename(id)}>Rename</button>
              <button className="secondary" onClick={onRemove}>Remove</button>
              <button className="secondary" onClick={() => onAsk(`About ${n.name}: `)}>Ask about it</button>
              {n.diff && <button className="secondary" onClick={() => onCode(id)}>See the code</button>}
            </>
          )}
        </div>
      </>
    );
  } else if (d) {
    const canSwap = live && d.state !== "rejected" && d.over.length > 0;
    body = (
      <>
        <div className="ex-kicker">You selected a decision</div>
        <h3>
          <span className="ex-d">◇ D{d.n}</span> {d.title}
        </h3>
        <div className="ex-chips">
          <span className="chip">{DSTATE_WORD[d.state] ?? cap(d.state)}</span>
          <span className={`chip ex-proof pf-${d.proof ?? "pending"}`}>{PROOF_WORD[d.proof] ?? "Not tested yet"}</span>
        </div>
        <p className="ex-help">A technical choice the agent made. Keep it, swap it for another option, or ask why: the plan changes to match.</p>
        <div className="ex-k">It chose</div>
        <p className="ex-chose">{d.chose}</p>
        {canSwap ? (
          <>
            <div className="ex-k">Instead of</div>
            {d.over.slice(0, 3).map((o, i) => (
              <button key={o} className="ex-use" onClick={() => onPick(d, i)} data-tour={i === 0 ? "use-this" : undefined}>
                <span>⇄ {o}</span>
                <span className="ex-go">Use this</span>
              </button>
            ))}
            <p className="ex-faint">Or type your own in the blank “+ your own” option on the board.</p>
          </>
        ) : (
          d.over.length > 0 && (
            <>
              <div className="ex-k">Instead of</div>
              <p>{d.over.join(" · ")}</p>
            </>
          )
        )}
        {d.why && (
          <>
            <div className="ex-k">Why</div>
            <p>{d.why}</p>
          </>
        )}
        {d.verify && (
          <>
            <div className="ex-k">We'll know it's right when</div>
            <p>{d.verify}</p>
          </>
        )}
        <div className="ex-actions">
          {live && <button className="secondary" onClick={() => onChallenge(d)}>Ask why</button>}
          {live && d.state !== "rejected" && <button className="secondary" onClick={onRemove}>Reject it</button>}
          <button className="secondary" onClick={() => onOpen(lid)}>Full card</button>
        </div>
      </>
    );
  } else if (e) {
    body = (
      <>
        <div className="ex-kicker">You selected a connection</div>
        <h3>
          {name(e.from)} → {name(e.to)}
        </h3>
        <p className="ex-help">How two parts talk: the first one calls the second, or sends it data.</p>
        <dl className="ex-dl">
          {row("How", e.via && tagCase(e.via))}
          {row("Calls", e.api && <code>{e.api}</code>)}
        </dl>
        {live && (
          <div className="ex-actions">
            <button className="secondary" onClick={onRemove}>Disconnect</button>
            <button className="secondary" onClick={() => onAsk(`About ${name(e.from)} → ${name(e.to)}: `)}>Ask about it</button>
          </div>
        )}
      </>
    );
  } else {
    const dLabel = (a) => (model.decisions[a] ? `D${model.decisions[a].n}` : name(a));
    body = (
      <>
        <div className="ex-kicker">{q.kind === "question" ? "A question for you" : "Something it assumes"}</div>
        <p className="ex-help">
          {q.kind === "question"
            ? "The agent needs your answer to finish the plan. Pick an option or type your own."
            : "It's working from this. Confirm it if it's right, or correct it."}
        </p>
        <QuestionCard q={q} dLabel={dLabel} canAnswer={live} onAnswer={onAnswer} onConfirm={onConfirm} onCorrect={onCorrect} link={() => ({})} />
      </>
    );
  }
  return (
    <div className="explain" role="dialog" aria-label="About what you selected">
      <button className="ex-close" onClick={onClose} aria-label="Close" title="Close">
        ×
      </button>
      {body}
    </div>
  );
}

// What the colors mean, under the Pictures board (C4 and data flow draw their own key).
const KEY = [["planned", "New"], ["built", "Exists"], ["building", "Being built"], ["verified", "Tested ✓"], ["failed", "Failed ✗"], ["live", "Shipped ★"]];
function BoardKey() {
  return (
    <div className="board-key" aria-label="Key" data-tour="key">
      <b>Key</b>
      {KEY.map(([k, label]) => (
        <span key={k}>
          <i className="sw" style={{ borderColor: STATUS[k].stroke, background: STATUS[k].fill }} />
          {label}
        </span>
      ))}
      <span>
        <i className="sw sw-dia" />
        Decision, dashed until you approve
      </span>
      <span>
        <i className="sw" style={{ borderColor: "#f08c00", background: "#fff4e6" }} />
        Question for you
      </span>
    </div>
  );
}

export default function App() {
  const [api, setApi] = useState(null);
  const [whyApi, setWhyApi] = useState(null);
  const [timelineApi, setTimelineApi] = useState(null);
  const [diagramApi, setDiagramApi] = useState(null);
  const sessionRef = useRef(null);
  const [, setVersion] = useState(0);
  const [phase, setPhase] = useState(null);
  const [decisions, setDecisions] = useState([]);
  const [theme, setTheme] = useState("light");
  const [linked, setLinked] = useState(() => new Set());
  const [ownSel, setOwnSel] = useState(false); // only the board's own drawing is selected: no style panel
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState(null); // { live, provider, model, effort, defaultRepo } from the dev server
  const [recordings, setRecordings] = useState([]);
  const [tab, setTab] = useState("activity"); // "activity" | "plan"
  // Skim: only the sentences that carry weight. Remembered per browser.
  const [skim, setSkim] = useState(() => {
    try {
      return localStorage.getItem("wb-skim") === "1";
    } catch {
      return false;
    }
  });
  const toggleSkim = () =>
    setSkim((v) => {
      try {
        localStorage.setItem("wb-skim", v ? "0" : "1");
      } catch {
        /* private window: just this page */
      }
      return !v;
    });
  // Tips (the coach card and the circles it draws on the board) and Excalidraw's own drawing
  // tools: on and hidden by default, so a first run shows only what it needs. Remembered per browser.
  const remembered = (key, fallback) => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : v === "1";
    } catch {
      return fallback;
    }
  };
  const remember = (key, v) => {
    try {
      localStorage.setItem(key, v ? "1" : "0");
    } catch {
      /* private window: just this page */
    }
  };
  const [tips, setTips] = useState(() => remembered("wb-tips", true));
  const showTipsPref = (v) => {
    setTips(v);
    remember("wb-tips", v);
  };
  // The guided tour (engine/tour.js): its step, and whether it's someone's first visit. Then it
  // starts by itself (the demo), or is offered (with an API key: they came to run a task).
  const [tour, setTour] = useState(null);
  const tourRef = useRef(null);
  tourRef.current = tour;
  const [tourOffer, setTourOffer] = useState(() => {
    try {
      return !localStorage.getItem("wb-tour");
    } catch {
      return false;
    }
  });
  const markTour = (v) => {
    setTourOffer(false);
    try {
      localStorage.setItem("wb-tour", v);
    } catch {
      /* private window: just this page */
    }
  };
  const [autoTour, setAutoTour] = useState(false); // start the tour once the session is ready
  const reviewOpens = useRef(0); // review rows and red-pen marks opened (the tour waits for one)
  const lineHovers = useRef(0); // Chat & log sentences hovered to light up the board (and this one)
  const [tools, setTools] = useState(() => remembered("wb-tools", false));
  const toggleTools = () =>
    setTools((v) => {
      remember("wb-tools", !v);
      return !v;
    });
  const [toolHint, setToolHint] = useState(null); // what to do next with the tool just picked
  useEffect(() => {
    if (!toolHint) return;
    const t = setTimeout(() => setToolHint(null), 9000);
    return () => clearTimeout(t);
  }, [toolHint]);
  const [boardSel, setBoardSel] = useState([]); // what's selected on the Architecture board, as logical ids
  // Which diagram the board shows. Pictures, C4 and Data flow redraw the editable board in place
  // (steering works in all three); Database (ER) and Sequence are read-only, on their own canvas.
  // Remembered per browser.
  const [diagram, setDiagram] = useState(() => {
    try {
      const v = localStorage.getItem("wb-diagram") ?? localStorage.getItem("wb-style");
      return DIAGRAMS.some((d) => d.key === v) ? v : "pictures";
    } catch {
      return "pictures";
    }
  });
  const styleRef = useRef(["c4", "dfd"].includes(diagram) ? diagram : "pictures");
  const readOnlyDiagram = diagram === "er" || diagram === "sequence";
  // Zoom into a layer (a LAYERS key) or the whole system (null): the board's map, with that
  // layer's components opened to show their parts. Read-only, on the diagram canvas.
  const [inside, setInside] = useState(null);
  const readOnlyView = readOnlyDiagram || !!inside;
  const chooseInside = (k) => {
    setInside(k);
    if (k && focus) chooseFocus(null);
  };
  const chooseDiagram = (v) => {
    setDiagram(v);
    setInside(null);
    if (!["er", "sequence"].includes(v)) {
      styleRef.current = v;
      sessionRef.current?.board.setStyle(v);
    }
    // A sequence diagram is of one flow, so it shows the one picked (or the first); an ER diagram
    // has no layers or flows to narrow.
    if (v === "er" && focus) chooseFocus(null);
    if (v === "sequence" && !focus?.flow) {
      const first = Object.keys(sessionRef.current?.board.model.flows ?? {})[0];
      chooseFocus(first ? { flow: first } : null);
    }
    try {
      localStorage.setItem("wb-diagram", v);
    } catch {
      /* private window: just this page */
    }
  };
  // Narrow the board to one layer or one flow ({ layer } | { flow } | null); the rest fades.
  const [focus, setFocus] = useState(null);
  const chooseFocus = (f) => {
    setFocus(f);
    sessionRef.current?.board.setFocus(f);
  };
  // Export what the board shows: Mermaid (the container view, or the flow as a sequence
  // diagram) for a README or PR, or an SVG/PNG with a title.
  const [exported, setExported] = useState(null);
  const exportView = async (kind) => {
    const s = sessionRef.current;
    if (!s) return;
    const b = s.board, m = b.model;
    const flow = !inside && focus?.flow && m.flows[focus.flow];
    const layer = focus?.layer && LAYERS.find((l) => l.key === focus.layer);
    const name = diagram === "er" ? "Data model" : diagram === "sequence" ? "Sequence" : diagram === "dfd" ? "Data flow" : diagram === "c4" ? "Container view" : "Architecture";
    const view = inside ? `Inside the ${LAYERS.find((l) => l.key === inside)?.label} layer` : flow && diagram !== "er" ? `${name}: ${flow.name}` : layer ? `${name}: ${layer.label} layer` : name;
    const title = [m.project, view].filter(Boolean).join(" · ");
    const file = title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board";
    try {
      if (kind === "mermaid") {
        const only = layer && new Set(Object.values(m.nodes).filter((n) => [layer.key, null].includes(layerOf(n))).map((n) => n.id));
        const text = inside
          ? toInsideMermaid(m, inside)
          : diagram === "er" ? toErMermaid(m) : flow ? toSequence(m, flow) : diagram === "dfd" ? toDfdMermaid(m, { only }) : toMermaid(m, { only });
        await navigator.clipboard.writeText(`\`\`\`mermaid\n${text}\`\`\`\n`);
      } else {
        const api = readOnlyView ? b.diagramApi : b.api;
        const opts = {
          elements: readOnlyView ? b.diagramElements(title) : b.exportElements(title),
          appState: { ...api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, exportScale: 2 },
          files: api.getFiles(),
          exportPadding: 32,
        };
        const blob = kind === "svg" ? new Blob([(await exportToSvg(opts)).outerHTML], { type: "image/svg+xml" }) : await exportToBlob({ ...opts, mimeType: "image/png", getDimensions: (w, h) => ({ width: w * 2, height: h * 2, scale: 2 }) });
        const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `${file}.${kind}` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      }
      setExported("ok");
    } catch (e) {
      console.warn("Export failed", e); // no clipboard access, or the browser refused the download
      setExported("failed");
    }
    setTimeout(() => setExported(null), 1800);
  };
  // The read-only diagram follows the model as it changes (Board skips redraws that change nothing).
  useEffect(() => {
    if (inside) sessionRef.current?.board.drawDiagram("inside", inside);
    else if (readOnlyDiagram) sessionRef.current?.board.drawDiagram(diagram, focus?.flow);
  });
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [selLids, setSelLids] = useState(() => new Set()); // board selection, as logical ids
  const sentKeys = useRef(new Set());
  const diffTimer = useRef(null);
  const lastSel = useRef("");
  const scroller = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!api || !whyApi || !timelineApi || !diagramApi) return;
    // Fresh session: clear UI state that belonged to the previous one (e.g. after a hot reload).
    setPhase(null);
    setDecisions([]);
    setLinked(new Set());
    setSpeed(1);
    setFocus(null);
    const board = new Board(api, { whyApi, timelineApi, diagramApi, onPhase: setPhase, style: styleRef.current });
    const s = new Session({ board, onChange: () => setVersion((v) => v + 1) });
    sessionRef.current = s;
    if (import.meta.env.DEV) window.__wb = s;
    let alive = true;
    const timers = [];
    // Closing or reloading the tab stops a running agent instead of leaving it waiting.
    const onHide = () => s.dispose();
    window.addEventListener("pagehide", onHide);
    Promise.all([board.init(), getAgentStatus()]).then(([, status]) => {
      if (!alive) return;
      setAgent(status);
      setRepo((r) => r || status.defaultRepo || "");
      // The sticker sheet, in Excalidraw's Library (Stickers in Edit the plan opens it). Made once
      // the hand-drawn font is loaded, so the labels are measured right.
      api.updateLibrary({ libraryItems: stickerItems(), merge: true, defaultStatus: "unpublished" }).catch((e) => console.warn("Stickers didn't load", e));
      // Excalidraw measures its container after mount, so fit once it has real dimensions.
      timers.push(setTimeout(() => board.fit(), 150));
      // With an API key, wait for a task; otherwise play the scripted demo, as the tour on a first visit.
      if (status.live) document.getElementById("ask")?.focus();
      else if (tourOffer) setAutoTour(true);
      else timers.push(setTimeout(() => s.startDemo({ fresh: true }), 700));
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      window.removeEventListener("pagehide", onHide);
      s.dispose();
    };
  }, [api, whyApi, timelineApi, diagramApi]);

  // Keep the transcript pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && tabRef.current === "activity" && sessionRef.current?.transcript.messages.length) el.scrollTop = el.scrollHeight;
  });

  const runDiff = useCallback(() => {
    diffTimer.current = null;
    const s = sessionRef.current;
    if (!s) return;
    const st = s.board.api.getAppState();
    if (st.editingTextElement || st.newElement || st.selectedElementsAreBeingDragged) {
      diffTimer.current = setTimeout(runDiff, 400);
      return;
    }
    s.board.settlePick(); // an alternative dropped on its diamond
    const all = s.board.diff();
    const keys = new Set(all.map((d) => d.key));
    for (const k of sentKeys.current) if (!keys.has(k)) sentKeys.current.delete(k);
    const fresh = all.filter((d) => !sentKeys.current.has(d.key));
    setDecisions((prev) => (prev.map((d) => d.key).join() === fresh.map((d) => d.key).join() ? prev : fresh));
    s.board.refreshMarkers();
  }, []);

  // Show what these logical ids touched: their sentences and activity, and their Plan entries.
  const showLinked = useCallback((lids) => {
    const s = sessionRef.current;
    if (!s) return;
    const ids = s.transcript.sentencesTouching(lids);
    setLinked(new Set(ids));
    setSelLids(new Set(lids));
    // Bring the matching sentence (Activity) or plan entry (Plan) into view.
    const target = tabRef.current === "plan" ? lids[0] && `plan-${lids[0]}` : ids.at(-1);
    if (target) document.getElementById(target)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, []);
  // From the Timeline: open the Activity tab at your message, or at the command that ran the tests.
  const focusInActivity = useCallback((id) => {
    tabRef.current = "activity";
    setTab("activity");
    stick.current = false; // don't snap back to the bottom
    setLinked(new Set([id]));
    setTimeout(() => document.getElementById(id.startsWith("m-") ? `msg-${id}` : id)?.scrollIntoView({ block: "center", behavior: "smooth" }), 30);
  }, []);
  // From the review card: a sentence in Activity, the diff, or a card in the Plan tab.
  const goReview = (lid) => {
    if (!lid) return;
    reviewOpens.current++;
    const [k, v] = lid.split(/:(.*)/s);
    if (k === "sentence") return focusInActivity(v);
    if (k === "code") {
      tabRef.current = "plan";
      setTab("plan");
      return setTimeout(() => document.getElementById(v ? `plan-code:${v}` : "plan-code")?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
    }
    focusInPlan([lid]);
  };
  // From the header or the Why canvas: open the Plan tab at it.
  const focusInPlan = useCallback(
    (lids) => {
      if (!lids.length) return;
      tabRef.current = "plan";
      setTab("plan");
      setTimeout(() => showLinked(lids), 30); // once the Plan tab has rendered
    },
    [showLinked],
  );

  const onChange = useCallback(
    (elements, appState) => {
      setTheme((t) => (t === appState.theme ? t : appState.theme));
      const s = sessionRef.current;
      if (!s) return;

      // Board selection -> highlight the sentences and activity that drew it.
      const sel = Object.keys(appState.selectedElementIds || {})
        .filter((k) => appState.selectedElementIds[k])
        .sort()
        .join(",");
      if (sel !== lastSel.current) {
        lastSel.current = sel;
        // A red-pen mark on the review: open what it marks (the sentence, or the decision's card).
        const pen = sel && s.board.penLink(sel.split(","));
        if (pen) {
          goReview(pen);
          lastSel.current = ""; // so clearing the selection doesn't clear what goReview just linked
          s.board.api.updateScene({ appState: { selectedElementIds: {} } });
          return;
        }
        const lids = s.board.logicalIdsFor(sel ? sel.split(",") : []);
        showLinked(lids);
        setBoardSel(lids);
        // Restyling what the board draws does nothing (it's redrawn), so its style panel would only cover the board.
        setOwnSel(!!sel && sel.split(",").every((id) => s.board.known.has(id)));
        // A selected decision fans out its alternatives: drag one onto it to pick it.
        if (s.mode !== "replay") s.board.onSelect(sel ? sel.split(",") : [], appState);
      }

      // Throttled: the agent changes the scene constantly, so a pure debounce would never fire.
      if (!diffTimer.current) diffTimer.current = setTimeout(runDiff, 500);
    },
    [runDiff, showLinked],
  );

  const s = sessionRef.current;
  const st = s?.state ?? { busy: false, paused: false, playing: false, thinking: false, thinkingFor: 0 };

  // Nothing streams while the agent thinks, so tick the status line's timer ourselves.
  useEffect(() => {
    if (!st.thinking) return;
    const t = setInterval(() => setVersion((v) => v + 1), 1000);
    return () => clearInterval(t);
  }, [st.thinking]);

  const messages = s?.transcript.messages ?? [];
  const receipts = s?.receipts() ?? new Map();
  // Questions and assumptions it only mentioned in prose (a paragraph that also drew one on the board is covered).
  const passing = [];
  const said = new Map(); // sentence id -> text
  for (const m of messages) {
    if (m.role !== "agent") continue;
    for (const it of m.items) if (it.type === "s") said.set(it.id, it.text);
    let para = [];
    const flush = () => {
      if (!para.some((it) => [...it.ids].some((l) => l.startsWith("question:"))))
        for (const it of para) if (it.asks || it.assumes) passing.push({ id: it.id, text: it.text, kind: it.asks ? "asks" : "assumes" });
      para = [];
    };
    for (const it of m.items) {
      if (it.type === "s" && !it.live) para.push(it);
      else if (it.type !== "s") flush();
    }
    flush();
  }
  const openQuestions = Object.values(s?.board.model.questions ?? {}).filter((q) => q.state === "open").length;
  // Once the run is over: what needs a look.
  const finishedRun = !!s && messages.length > 0 && (s.mode === "replay" ? !s.state.replaying : s.mode === "agent" ? !!s.result && !s.state.busy : s.board.model.phase === "complete" && !s.state.busy);
  const review =
    finishedRun &&
    buildReview({
      model: s.board.model,
      claims: [...receipts].map(([id, r]) => ({ id, text: said.get(id) ?? "", ...r })),
      passing,
      changes: s.changes ? [...s.changes.values()] : null,
      commits: s.commits,
      lastTest: (s.board.tl?.tests ?? []).filter((k) => k.ok != null).at(-1) ?? null,
      denied: messages.filter((m) => m.role === "you" && m.kind === "permission" && m.decision === "deny").map((m) => m.detail),
    });
  // The review, marked on the board in red pen: the part behind a false claim, a failed check.
  const pen = review ? penMarks({ model: s.board.model, claims: [...receipts].map(([id, r]) => ({ id, ...r })), ownerOf: (f) => s.board.ownerOf(f) }) : null;
  useEffect(() => {
    const b = sessionRef.current?.board;
    if (!b) return;
    if (pen) b.showPen(pen);
    else b.hidePen();
  });
  const contradicted = [...receipts.values()].filter((r) => r.verdict === "bad").length;
  const project = s?.board.model.project;
  const agentMode = s?.mode === "agent";
  const replayMode = s?.mode === "replay";
  const awaitingTask = agent?.live && messages.length === 0;
  const reviewing = !!s?.awaitingApproval;
  const permission = replayMode ? null : s?.permission;
  const recording = s?.recording;

  // A plan waiting for approval opens on the Plan tab, so its reasoning is what you review.
  useEffect(() => {
    if (reviewing) setTab("plan");
  }, [reviewing]);
  // A finished run shows its review card, at the end of the activity.
  useEffect(() => {
    if (!finishedRun) return;
    setTab("activity");
    stick.current = true;
  }, [finishedRun]);
  // A fresh start goes back to the activity view.
  useEffect(() => {
    if (messages.length === 0) setTab("activity");
  }, [messages.length === 0]);

  // Challenge a decision: prefill the message box and put the cursor after it, once it has rendered.
  const caretToEnd = useRef(false);
  const challenge = (d) => {
    caretToEnd.current = true;
    setDraft(`About D${d.n} (${d.chose}${d.over.length ? ` over ${d.over.join(", ")}` : ""}): `);
  };
  // Correct an assumption, or reply to something it asked in passing, the same way.
  const prefill = (text) => {
    caretToEnd.current = true;
    setDraft(text);
  };
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  useEffect(() => {
    if (!caretToEnd.current) return;
    caretToEnd.current = false;
    const el = document.getElementById("ask");
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, [draft]);

  // Refresh the saved boards whenever the start screen shows or a run finishes.
  const showingStart = messages.length === 0;
  const lastResult = s?.result;
  useEffect(() => {
    if (showingStart || lastResult) listRecordings().then(setRecordings);
  }, [showingStart, lastResult]);

  const clearUi = () => {
    sentKeys.current.clear();
    setDecisions([]);
    setLinked(new Set());
    stick.current = true;
  };
  const runDemo = () => {
    if (!s) return;
    clearUi();
    s.startDemo();
  };
  const startTask = (brief) => {
    if (!s || !brief.trim()) return;
    clearUi();
    setDraft("");
    s.startAgent({ repo: repo.trim(), brief: brief.trim() });
  };
  const replay = (id, opts) => {
    if (!s) return;
    clearUi();
    s.startReplay(id, opts);
  };
  // Agent: stop it, clear the board, and put the task back in the box to rerun or edit.
  // Replay: back to the start screen. Demo: replay.
  const restart = async () => {
    if (!s) return;
    if (tour) exitTour();
    if (replayMode) {
      clearUi();
      await s.reset();
      s.mode = agent?.live ? "agent" : "demo";
      setPhase(null);
      return;
    }
    if (!agentMode) return runDemo();
    clearUi();
    const brief = s.brief;
    await s.reset();
    setPhase(null);
    setDraft(brief);
    document.getElementById("ask")?.focus();
  };
  // The board's tabs: Architecture (editable), Why (drawn from the decisions; its words are in the Plan tab)
  // and Timeline (how the decisions moved over the run).
  const boardView = s?.board.view ?? "board";
  const tl = s?.board.tl;
  const hasTimeline = !!tl?.segments.length;
  const model = s?.board.model;
  const nodeCount = model ? Object.keys(model.nodes).length : 0;
  const allDecisions = model ? Object.values(model.decisions) : [];
  const proofCount = (r) => allDecisions.filter((d) => d.state !== "rejected" && (d.proof ?? null) === r).length;
  const showView = (view) => {
    if (!s) return;
    s.board.setView(view);
    if (view === "why") {
      s.board.fitWhy();
      if (allDecisions.length && messages.length) setTab("plan");
    }
    // It may have grown while hidden; refit unless you've framed it yourself (⛶ fits it again).
    if (view === "timeline" && s.board.tlFollow) s.board.fitTimeline();
    setVersion((v) => v + 1);
  };
  // A click (not a drag) on the Why canvas opens what's under it in the Plan tab.
  const whyDown = useRef(null);
  const whyClick = (e) => {
    const d = whyDown.current;
    whyDown.current = null;
    if (!s || !whyApi || !d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) return;
    const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, whyApi.getAppState());
    focusInPlan(s.board.whyHit(x, y));
  };
  // The Timeline: a click in a replay jumps the board to that moment; otherwise a decision's
  // mark opens its card, your mark your message, a test run its command. Panning or zooming
  // it stops it refitting itself as the run grows.
  const tlDown = useRef(null);
  const tlClick = (e) => {
    const d = tlDown.current;
    tlDown.current = null;
    if (!s || !timelineApi || !d) return;
    if (Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 5) {
      s.board.tlFollow = false;
      return;
    }
    const { x, y } = viewportCoordsToSceneCoords({ clientX: e.clientX, clientY: e.clientY }, timelineApi.getAppState());
    const hit = s.board.timelineHit(x, y);
    if (!hit) return;
    if (replayMode && hit.t != null) return s.seekReplay(hit.t);
    if (hit.msg) return focusInActivity(hit.msg);
    const act = hit.tool && messages.flatMap((m) => m.items).find((it) => it.type === "act" && it.toolUseIds.includes(hit.tool));
    if (act) return focusInActivity(act.id);
    focusInPlan(hit.lids);
  };
  const sendEdits = () => {
    if (!s || !decisions.length) return;
    decisions.forEach((d) => sentKeys.current.add(d.key));
    s.sendEdits(decisions);
    setDecisions([]);
    setGlassUp(true);
    stick.current = true;
  };
  // Approve the plan; any pending board edits go along and get folded in before building.
  const approve = () => {
    if (!s) return;
    decisions.forEach((d) => sentKeys.current.add(d.key));
    s.approve(decisions);
    setDecisions([]);
    setGlassUp(true);
    stick.current = true;
  };
  const togglePlay = () => {
    if (!s) return;
    if (replayMode) s.toggleReplay();
    else if (agentMode && st.busy) s.stop();
    else if (s.permission) return; // the tour's command prompt: answer it below
    else if (s.held) s.release();
    else if (st.paused) s.player.resume();
    else if (st.busy) s.player.pause();
    else if (s.awaitingApproval) approve();
    else if (agentMode && s.brief) startTask(s.brief);
    else runDemo();
  };
  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (s) s.player.speed = next;
  };
  const sendChat = (e) => {
    e.preventDefault();
    const text = draft.trim();
    if (!s || !text) return;
    if (awaitingTask) return startTask(text);
    s.sendChat(text);
    setDraft("");
    stick.current = true;
  };

  let status = "Getting the board ready";
  if (replayMode) {
    if (!st.replaying) status = `Replay finished · recorded ${when(recording?.startedAt)}`;
    else if (st.paused) status = "Replay paused";
    else if (s.permission) status = "Here the agent asked to run a command";
    else if (s.gate) status = "Here the agent waited for your approval";
    else status = s.caption ? `${s.caption}…` : "Replaying…";
  } else if (permission) status = "Waiting for your OK";
  else if (s?.held) status = "Paused: the tour waits for you";
  else if (st.paused) status = "Paused";
  else if (st.thinking) status = st.thinkingFor >= 2 ? `Working… ${st.thinkingFor}s` : "Working…";
  else if (st.busy) status = s.caption ? `${s.caption}…` : "Working…";
  else if (awaitingTask) status = "Pick a repo and describe a task";
  else if (reviewing) status = "Plan ready. Review it on the board, then approve.";
  else if (decisions.length) status = "Your board changes are ready to send";
  else if (s?.result) status = `Done${s.result.cost != null ? ` · $${s.result.cost.toFixed(2)}` : ""}${s.result.turns ? ` · ${s.result.turns} turns` : ""}`;
  else if (phase === "complete") status = "Shipped. Edit the board to steer the next round.";
  else if (s && messages.length) status = "Idle";

  // The coach: where you are in Describe → Plan → Build → Check, and what to do now.
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const coach = !s
    ? null
    : replayMode
      ? {
          label: "Replay",
          title: st.replaying ? "You're watching a saved run" : "This saved run is over",
          text: "Nothing here reaches an agent. On the Timeline tab, click any moment to jump there. Done goes back to the start.",
        }
      : awaitingTask
        ? {
            n: 1,
            title: "Tell the agent what to build",
            text: "Pick an example, or describe your own task in the box at the bottom. It reads the code and draws a plan on the right, then waits for your OK. Nothing in your repo changes before that.",
            action: { label: "Watch a demo first", run: runDemo },
          }
        : !messages.length
          ? { n: 1, title: "Watch a demo run", text: "A scripted run is about to play on the board. It never touches your files." }
          : permission
            ? {
                n: 3,
                title: "It wants to run a command",
                text: "Read it at the bottom, then Allow or Deny. It asks before every command; editing files inside the repo doesn't ask, because you approved the plan.",
              }
            : reviewing
              ? {
                  n: 2,
                  title: "Check the plan",
                  text: `The drawing on the right is its plan. Nothing is built until you approve.${openQuestions ? ` It left ${plural(openQuestions, "question")} for you in Plan details.` : ""} Click a ◇ to see other options; pull the glass down to change the drawing.`,
                }
              : finishedRun || phase === "complete"
                ? {
                    n: 4,
                    title: "Check its work",
                    text: "The Review card compares what it said with git and the test output. Start with anything marked ✗ or ?. For another round, edit the board or type below.",
                  }
                : decisions.length
                  ? {
                      n: !phase || phase === "planning" ? 2 : 3,
                      title: `${plural(decisions.length, "change")} ready to send`,
                      text: st.busy ? "Press Submit: they go to the agent after its current step." : "Press Submit to send them to the agent.",
                    }
                  : !phase || phase === "planning"
                    ? { n: 2, title: "It's planning", text: "It reads the code and draws its plan on the board. When the plan is ready, it stops and waits for you." }
                    : {
                        n: 3,
                        title: phase === "verification" ? "It's testing its work" : "It's building",
                        text: "It edits files by itself. Orange parts are being changed now, green ones passed their tests. Changes you make on the board go after its current step.",
                      };

  // Edit the plan: each button picks the matching Excalidraw tool and says what to do with it.
  const editable = messages.length > 0 && !replayMode && boardView === "board" && !readOnlyView;
  // The board sits behind glass: you can look and click anything to learn what it is, but moving,
  // deleting or typing waits until you pull the glass down. Submit sends your changes and puts it
  // back. Use this, Rename and Remove on a card pull it down for you.
  const [glassUp, setGlassUp] = useState(true);
  const lowerGlass = () => setGlassUp(false);
  const raiseGlass = () => {
    setGlassUp(true);
    s?.board.api.setActiveTool({ type: "selection" });
    setToolHint(null);
  };
  useEffect(() => {
    if (!editable || !glassUp) return;
    const onBoard = (t) => !!t?.closest?.(".canvas.arch") && !t.closest(".explain, .board-submit, .glass-handle, button, input, textarea, select");
    const typing = (t) => !!t?.closest?.("input, textarea, select, [contenteditable]");
    let down = false;
    const handlers = {
      pointerdown: (e) => (down = onBoard(e.target)),
      // A click selects (to explain it); a drag would move it, so the drag never reaches the board.
      pointermove: (e) => down && e.buttons && e.stopPropagation(),
      pointerup: () => (down = false),
      dblclick: (e) => e.isTrusted && onBoard(e.target) && (e.stopPropagation(), e.preventDefault()),
      keydown: (e) => {
        if (typing(e.target) || !(onBoard(e.target) || e.target === document.body)) return;
        const k = e.key.toLowerCase();
        if (["delete", "backspace", "arrowup", "arrowdown", "arrowleft", "arrowright", "enter"].includes(k) || ((e.metaKey || e.ctrlKey) && ["v", "x", "z", "y", "d"].includes(k))) {
          e.stopPropagation();
          e.preventDefault();
        }
      },
      paste: (e) => !typing(e.target) && (e.stopPropagation(), e.preventDefault()),
    };
    for (const [type, fn] of Object.entries(handlers)) window.addEventListener(type, fn, true);
    return () => {
      for (const [type, fn] of Object.entries(handlers)) window.removeEventListener(type, fn, true);
    };
  }, [editable, glassUp]);
  const useTool = (type, hint) => {
    s?.board.api.setActiveTool({ type });
    setToolHint(hint);
  };
  // Rename = double-click the name for you, so you can type straight away.
  const renameOnBoard = (nodeId) => {
    const b = s?.board;
    const n = b?.model.nodes[nodeId];
    const label = n && b.api.getSceneElements().find((e) => e.id === `${n.elId}:label`);
    const canvas = document.querySelector(".canvas.arch canvas.interactive");
    if (!label || !canvas) return false;
    b.api.setActiveTool({ type: "selection" });
    const { x, y } = sceneCoordsToViewportCoords({ sceneX: label.x + label.width / 2, sceneY: label.y + label.height / 2 }, b.api.getAppState());
    // A part is a group: a double-click on a selected group first steps into it, the next edits the text.
    const dbl = () => canvas.dispatchEvent(new MouseEvent("dblclick", { clientX: x, clientY: y, bubbles: true }));
    dbl();
    setTimeout(() => !b.api.getAppState().editingTextElement && dbl(), 60);
    setToolHint("Type the new name, then click an empty spot.");
    return true;
  };
  // The sticker sheet is Excalidraw's Library sidebar.
  const openStickers = () => {
    s?.board.api.toggleSidebar({ name: "default", tab: "library", force: true });
    setToolHint("Drag a sticker onto a part or a ◇. Why? asks it to explain, Not needed asks to drop it, Keep this says leave it as is.");
  };
  const selected = boardSel.length === 1 ? boardSel[0] : null;
  const toolRename = () => {
    if (selected?.startsWith("node:") && renameOnBoard(selected.slice(5))) return;
    useTool("selection", "Double-click a part's name, type the new one, then click an empty spot.");
  };
  const toolRemove = () => {
    if (s?.board.deleteSelected()) return setToolHint(null);
    useTool("selection", "Click a part, an arrow or a ◇ first, then Remove. (The Delete key works too.)");
  };

  // ---- the guided tour: the demo as a lesson that waits for you at each step ----
  // What the tour's steps check (tour.js): the run's state and what you've done so far.
  const firstDecision = allDecisions.filter((d) => d.state !== "rejected").sort((a, b) => a.n - b.n)[0];
  const tourCtx = s && {
    started: messages.length > 0,
    stage: s.stage,
    phase: model.phase,
    gate: reviewing,
    selected: boardSel,
    explainUse: boardView === "board" && !!selected?.startsWith("decision:") && model.decisions[selected.slice(9)]?.over.length > 0,
    edits: decisions.length,
    answered: Object.values(model.questions).filter((q) => q.kind === "question" && q.state === "answered").length,
    permission: !!permission,
    permissions: messages.filter((m) => m.role === "you" && m.kind === "permission").length,
    hovers: lineHovers.current,
    view: boardView,
    tab,
    testCaused: allDecisions.some((d) => d.cause?.who === "test"),
    finished: !!review,
    reviewOpens: reviewOpens.current,
    firstDecision: firstDecision?.id ?? null,
    firstQuestion: Object.values(model.questions).find((q) => q.kind === "question" && q.state === "open")?.id ?? null,
    building: Object.values(model.nodes).find((n) => n.status === "building")?.id ?? null,
  };
  const tourCtxRef = useRef(null);
  tourCtxRef.current = tourCtx;
  const tourStep = stepOf(tour);
  const tourAt = tour && tourTargets(tour, tourCtx);
  const setSpeedTo = (v) => {
    setSpeed(v);
    if (s) s.player.speed = v;
  };
  // Start from an empty board: the first step shows the three areas, the second starts the demo.
  const takeTour = async () => {
    if (!s) return;
    markTour("taken");
    clearUi();
    setDraft("");
    await s.reset();
    if (s.mode === "replay") s.mode = agent?.live ? "agent" : "demo";
    setPhase(null);
    setTour(startTour(tourCtxRef.current));
  };
  useEffect(() => {
    if (!autoTour || !s) return;
    setAutoTour(false);
    takeTour();
  }, [autoTour, s]);
  const exitTour = () => {
    markTour("done");
    setTour(null);
  };
  // Skip step does the step for you (where there's something to do), then moves on.
  const skipTour = () => {
    if (!s || !tour) return;
    const m = s.board.model;
    switch (tourStep.skip) {
      case "pick": {
        const d = m.decisions[tourCtx.firstDecision];
        if (reviewing && d?.over.length) {
          showView("board");
          s.board.pickAlternative(d.id, 0);
        }
        break;
      }
      case "answer": {
        const q = m.questions[tourCtx.firstQuestion];
        if (reviewing && q) s.answerQuestion(q, q.options[0] ?? "50 MB");
        break;
      }
      case "approve":
        if (reviewing) approve();
        break;
      case "allow":
        if (s.permission) s.answerPermission("allow");
        break;
    }
    setTour(tourNext(tour, tourCtx));
  };
  // The finish line: your own task (live mode), the saved runs, or just stay on this board.
  const leaveTour = async (to) => {
    exitTour();
    if (!s || to === "stay") return;
    clearUi();
    await s.reset();
    s.mode = agent?.live ? "agent" : "demo";
    setPhase(null);
    if (to === "task") setTimeout(() => document.getElementById("ask")?.focus(), 50);
  };
  useEffect(() => {
    if (!s) return;
    s.tour = !!tour;
    s.onHold = (at) => holds(tourRef.current, at, tourCtxRef.current);
    if (tour) {
      const t2 = advance(tour, tourCtx);
      if (t2 !== tour) setTour(t2);
    }
    // Leaving the step a checkpoint waits for (done, skipped, or the tour's over) lets the demo go on.
    if (s.held && !holds(tour, s.held, tourCtx)) s.release();
  });
  // A step's action, the first time it's reached: the plan step starts the demo at 2×.
  const prevTour = useRef(null);
  useEffect(() => {
    const prev = prevTour.current;
    prevTour.current = tour;
    if (!isFresh(prev, tour)) return;
    if (stepOf(tour).enter === "demo") {
      runDemo();
      setSpeedTo(2);
    }
    if (stepOf(tour).clearSelection) s?.board.api.updateScene({ appState: { selectedElementIds: {} } });
  }, [tour]);
  // Where the tour's first circle on the board is, on screen, and the rest of the drawing round
  // it (around): the card sits beside the circle, over as little of the drawing as it can.
  const tourNote = () => {
    const b = s?.board;
    const els = b?.tips && b.api?.getSceneElements();
    const e = els?.find((x) => x.id === b.tips[0]);
    if (!e) return null;
    const st = b.api.getAppState();
    const rect = (x) => {
      const p = sceneCoordsToViewportCoords({ sceneX: x.x, sceneY: x.y }, st);
      return { x: p.x, y: p.y, w: x.width * st.zoom.value, h: x.height * st.zoom.value };
    };
    const tips = new Set(b.tips);
    // Parts, decisions, labels and notes; not arrows (their x, y is where they start) or the frame.
    const drawn = els.filter((x) => !x.isDeleted && !tips.has(x.id) && x.id !== "frame" && x.type !== "arrow" && x.type !== "line");
    return { ...rect(e), around: drawn.map(rect).filter((r) => r.w * r.h < (window.innerWidth * window.innerHeight) / 4) };
  };
  // Its circles on the board (the coach's own tips stay off while it runs).
  const tourTips = useRef("");
  useEffect(() => {
    const b = s?.board;
    if (!b) return;
    const want = tour && boardView === "board" && !readOnlyView ? tourAt.board : [];
    const sig = want.length ? `${s.gen}|${JSON.stringify(want)}` : "";
    if (sig === tourTips.current) return;
    tourTips.current = sig;
    if (want.length) {
      b.showTips(want);
      if (b.tips) b.fit(true);
    } else if (b.tips) b.hideTips();
  });

  // The coach's tips on the board itself, the first time a plan waits for you: circles round the
  // first decision and open question its note mentions (the words stay on the note: one ask).
  const tipsShown = useRef(false);
  if (!messages.length) tipsShown.current = false;
  useEffect(() => {
    const b = s?.board;
    if (!b) return;
    if (tour) {
      tipsShown.current = true; // the tour points at things itself
      return;
    }
    const want = tips && reviewing && editable;
    if (want && !tipsShown.current) {
      tipsShown.current = true;
      const m = b.model;
      const d = Object.values(m.decisions).filter((x) => x.state !== "rejected").sort((x, y) => x.n - y.n)[0];
      const q = Object.values(m.questions).find((x) => x.state === "open");
      b.showTips([d && { lid: `decision:${d.id}` }, q && { lid: `question:${q.id}` }].filter(Boolean));
      if (b.tips) b.fit(true);
    } else if (!want && b.tips) b.hideTips();
  });

  const playIcon = replayMode
    ? st.replaying && !st.paused ? "pause" : "play"
    : agentMode && st.busy ? "stop" : st.busy && !st.paused ? "pause" : "play";
  const playLabel = replayMode
    ? st.replaying ? (st.paused ? "Resume the replay" : "Pause the replay") : "Play the recording again"
    : agentMode && st.busy ? "Stop the agent" : st.paused ? "Resume" : st.busy ? "Pause" : reviewing ? "Continue: approve the plan" : agentMode ? "Run the task again" : "Replay";
  const modeLabel = replayMode ? "Replay" : agentMode || awaitingTask ? "Agent" : "Demo";
  const modeTitle = agent?.live
    ? `Claude Agent SDK · ${agent.provider ?? "Anthropic API"} · ${agent.model} · effort ${agent.effort}`
    : "Scripted demo. To run a real agent, set AGENT_KEY (Anthropic) or AGENT_URL (any other model) in .env.local and restart the dev server.";

  return (
    <div className="app" data-theme={theme}>
      {tourAt && (
        <TourSpotlight targets={tourAt.dom} spots={tourAt.spot} center={tourAt.place === "center"} note={tourNote}>
          <TourCard
            key={tour.i}
            step={tourStep}
            proposed={tourCtx.stage !== "building"}
            n={tour.i + 1}
            total={tourLength}
            wait={tourWaiting(tourStep, tourCtx)}
            manual={tour.manual}
            onBack={() => setTour(tourBack(tour, tourCtx))}
            onNext={() => setTour(tourNext(tour, tourCtx))}
            onSkip={skipTour}
            onExit={exitTour}
            finish={
              tourStep.finish && (
                <>
                  {agent?.live && (
                    <button className="secondary" onClick={() => leaveTour("task")}>
                      Start your own task
                    </button>
                  )}
                  <button className="secondary" onClick={() => leaveTour("start")}>
                    See saved runs
                  </button>
                  <button className="primary" onClick={() => leaveTour("stay")}>
                    Finish
                  </button>
                </>
              )
            }
          />
        </TourSpotlight>
      )}
      <aside className="agent" data-tour="panel">
        <header className="top">
          <div className="titlebar">
            <div className="brand">
              <h1>Agent Whiteboard</h1>
              <span className="proj">
                <span className={`mode ${modeLabel === "Agent" ? "live" : ""}`} title={modeTitle}>
                  {modeLabel}
                </span>
                {project || (awaitingTask ? "New task" : "No project yet")}
              </span>
            </div>
            <div className="playback" role="toolbar" aria-label="Playback">
              <button className="icon" onClick={togglePlay} title={playLabel} aria-label={playLabel}>
                <Icon name={playIcon} />
              </button>
              <button className="icon" onClick={restart} title="Start over" aria-label="Start over">
                <Icon name="restart" />
              </button>
              {!agentMode && (
                <button className="icon speed" onClick={cycleSpeed} title="Playback speed" aria-label={`Playback speed ${speed}×`}>
                  {speed}×
                </button>
              )}
              <button className="icon" onClick={() => s?.board.fit(true)} title="Fit board to screen" aria-label="Fit board to screen">
                <Icon name="fit" />
              </button>
              {!tips && !tour && (
                <button className="icon" onClick={takeTour} title="Take the tour: a guided run of the demo" aria-label="Take the tour">
                  <Icon name="tour" />
                </button>
              )}
              {!tips && (
                <button className="icon" onClick={() => showTipsPref(true)} title="Show tips: what to do at each step" aria-label="Show tips">
                  <Icon name="tips" />
                </button>
              )}
            </div>
          </div>
          {/* The coach says what the status line would while the run waits on you; while it works, the status line says what it's doing. */}
          {!(tips && coach && !replayMode && !st.busy && !st.thinking && !st.paused) && (
            <div className={`status ${st.playing && !permission ? "on" : ""}`} aria-live="polite">
              <span className="dot" />
              <span className="caption">{status}</span>
            </div>
          )}
          {/* Not before the dev server says whether there's a key: without one the tour starts by itself. */}
          {tour || !agent || autoTour ? null : tourOffer && s ? (
            <div className="coach tour-offer" role="region" aria-label="Take the tour">
              <div className="coach-top">
                <span className="coach-label">New here?</span>
              </div>
              <b className="coach-title">Take the tour: a whole run in a few minutes</b>
              <p>The demo plays as a lesson. It stops at each step until you've tried it: pick an option, answer a question, allow a command, check its work. No API key needed.</p>
              <div className="tour-actions">
                <button className="linkish" onClick={() => markTour("declined")}>
                  No thanks
                </button>
                <button className="primary" onClick={takeTour}>
                  Take the tour
                </button>
              </div>
            </div>
          ) : (
            tips && coach && <Coach c={coach} onHide={() => showTipsPref(false)} onTour={takeTour} />
          )}
        </header>

        {messages.length > 0 && (
          <div className="tabs" role="tablist" aria-label="Panel view">
            <button role="tab" aria-selected={tab === "activity"} className="tab" data-tour="log-tab" onClick={() => setTab("activity")} title="What the agent said and did, and what you sent it">
              Chat &amp; log
              {contradicted > 0 && (
                <span className="tab-count bad" title={`${contradicted} thing${contradicted === 1 ? "" : "s"} the agent said that git or the test output contradicts`}>
                  ✗ {contradicted} not true
                </span>
              )}
            </button>
            <button role="tab" aria-selected={tab === "plan"} className="tab" data-tour="plan-tab" onClick={() => setTab("plan")} title="The plan in words: its goal, parts, decisions, questions and code changes">
              Plan details
              {openQuestions > 0 ? (
                <span className="tab-count ask" title={`${openQuestions} open question${openQuestions === 1 ? "" : "s"} or assumption${openQuestions === 1 ? "" : "s"} for you`}>
                  ? {openQuestions} for you
                </span>
              ) : (
                Object.keys(s?.board.model.decisions ?? {}).length > 0 && (
                  <span className="tab-count" title="Technical choices the agent made">
                    ◇ {plural(Object.keys(s.board.model.decisions).length, "decision")}
                  </span>
                )
              )}
            </button>
          </div>
        )}
        {tab === "activity" && messages.length > 0 && (
          <div className="skim-row">
            <button className={`skim ${skim ? "on" : ""}`} aria-pressed={skim} onClick={toggleSkim} title="Hide the narration: keep what drew on the board, made a claim, asked you something or assumed something">
              {skim ? "✓ " : ""}Highlights only
            </button>
          </div>
        )}

        <div
          className="transcript"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          }}
        >
          {tab === "plan" && messages.length > 0 && s && (
            <PlanView
              model={s.board.model}
              phase={phase}
              selected={selLids}
              onHover={(ids) => s.setHover(ids)}
              onFocus={(ids) => s.board.scrollTo(ids)}
              onChallenge={challenge}
              onPick={(d, i) => {
                showView("board");
                s.board.pickAlternative(d.id, i);
              }}
              onShowFlow={(id) => {
                showView("board");
                chooseFocus({ flow: id });
              }}
              canChallenge={!replayMode}
              changes={s.board.changes}
              commits={s.commits}
              passing={passing}
              onAnswer={(q, text) => {
                s.answerQuestion(q, text);
                stick.current = true;
              }}
              onConfirm={(q) => s.confirmAssumption(q)}
              onCorrect={(q) => prefill(`About A${q.n} (${q.text}): `)}
              onReply={(p) => prefill(`About “${clip(p.text, 70)}”: `)}
              onShow={(id) => focusInActivity(id)}
            />
          )}
          {messages.length === 0 &&
            (awaitingTask ? (
              <div className="empty">
                <p className="hand">What should the agent do?</p>
                <p>
                  A real coding agent works in the repo below. It reads the code, draws its plan on the board and waits for you. Once
                  you approve, it builds and tests while the board keeps up. Edit the board at any point to steer it.
                </p>
                <label className="field" htmlFor="repo">
                  <span>Repository</span>
                  <input id="repo" value={repo} onChange={(e) => setRepo(e.target.value)} spellCheck="false" />
                </label>
                {repo === agent?.defaultRepo && (
                  <>
                    <p className="note">This is the sample repo, a tiny URL shortener with tests. Try one of these:</p>
                    <div className="examples">
                      {EXAMPLES.map((ex) => (
                        <button key={ex} className="example" onClick={() => startTask(ex)}>
                          {ex}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="start-demo">
                  {!tour && (
                    <button className="secondary" onClick={takeTour} title="A guided run of the demo: it waits while you try each step">
                      Take the tour
                    </button>
                  )}
                  <button className="linkish" onClick={runDemo}>
                    Or watch the scripted demo
                  </button>
                </div>
                <SavedRuns recordings={recordings} onReplay={(id) => replay(id)} onOpen={(id) => replay(id, { instant: true })} />
              </div>
            ) : (
              <div className="empty">
                <p className="hand">The board fills in as the agent works.</p>
                <p>Watch it plan, build, verify and ship a small app. Hover any sentence afterwards to see what it changed.</p>
                {!tour && (
                  <div className="start-demo">
                    <button className="secondary" onClick={takeTour} title="A guided run of the demo: it waits while you try each step">
                      Take the tour
                    </button>
                    <button className="linkish" onClick={runDemo}>
                      Watch the demo
                    </button>
                  </div>
                )}
                {agent && !agent.live && (
                  <p className="note">
                    This is the scripted demo. To run a real agent on a repo, set <code>ANTHROPIC_API_KEY</code> and restart{" "}
                    <code>npm run dev</code>.
                  </p>
                )}
                <SavedRuns recordings={recordings} onReplay={(id) => replay(id)} onOpen={(id) => replay(id, { instant: true })} />
              </div>
            ))}
          {(tab === "activity" ? messages : []).map((m) =>
            m.role === "notice" ? (
              <div key={m.id} className="msg notice" role="alert">
                {m.text}
              </div>
            ) : m.role === "agent" ? (
              <AgentMessage
                key={m.id}
                m={m}
                phase={phase}
                linked={linked}
                onHover={(ids) => {
                  if (ids.length) lineHovers.current++;
                  s?.setHover(ids);
                }}
                onFocus={(ids) => s?.board.scrollTo(ids)}
                receipts={receipts}
                skim={skim}
              />
            ) : (
              <div key={m.id} id={`msg-${m.id}`} className={["msg you", linked.has(m.id) && "linked"].filter(Boolean).join(" ")}>
                <div className="who">You</div>
                {m.kind === "chat" ? (
                  <p>{m.text}</p>
                ) : m.kind === "approve" ? (
                  <>
                    <p className="approved">
                      <span className="g g-approve">✓</span>
                      Approved the plan{m.decisions.length ? " with changes:" : ""}
                    </p>
                    {m.decisions.length > 0 && <EditList decisions={m.decisions} />}
                  </>
                ) : m.kind === "permission" ? (
                  <>
                    <p className="approved">
                      <span className={`g ${m.decision === "deny" ? "g-remove" : "g-approve"}`}>{m.decision === "deny" ? "✕" : "✓"}</span>
                      {m.decision === "deny" ? "Denied" : m.decision === "allow-all" ? "Allowed all commands, starting with" : "Allowed"}
                    </p>
                    <pre className="cmd small">{m.detail}</pre>
                  </>
                ) : (
                  <>
                    <p className="sub">Changed the board:</p>
                    <EditList decisions={m.decisions} />
                  </>
                )}
              </div>
            ),
          )}
          {tab === "activity" && review && <ReviewCard rows={review} onGo={goReview} />}
        </div>

        <footer className="composer">
          {replayMode ? (
            <div className="replaybar" role="region" aria-label="Replay">
              <div className="rb-what">
                <span className="rb-name">{recording?.project || recording?.brief || "Saved run"}</span>
                <span className="rb-meta">
                  Recorded {when(recording?.startedAt)} in {recording?.repo?.split("/").pop()}. This is a recording, so nothing here reaches an agent.
                </span>
              </div>
              <div className="rb-actions">
                {st.replaying && (
                  <button className="secondary" onClick={() => replay(recording.id, { instant: true })}>
                    Jump to end
                  </button>
                )}
                <a className="secondary" href={decisionsUrl(recording?.id)} target="_blank" rel="noreferrer">
                  Decision log
                </a>
                <button className="primary" onClick={restart}>
                  Done
                </button>
              </div>
            </div>
          ) : permission ? (
            <div className="permit" role="alertdialog" aria-label="Permission request" data-tour="permit">
              <div className="gh">{permission.tool === "Bash" ? "Can it run this command?" : `Can it use ${permission.tool}?`}</div>
              <pre className="cmd">{permission.detail}</pre>
              {permission.description && <p>What it's for: {permission.description}</p>}
              <details className="whats">
                <summary>Why am I asked?</summary>
                <p>
                  It asks before every command, because a command can do anything your terminal can. Editing files inside the repo doesn't ask:
                  you allowed that when you approved the plan. Not sure? Deny, and it will find another way or tell you why it needs it.
                </p>
              </details>
              <div className="gate-actions">
                <button className="secondary" onClick={() => s.answerPermission("deny")}>
                  Deny
                </button>
                {permission.tool === "Bash" && (
                  <button className="secondary" onClick={() => s.answerPermission("allow-all")} title="Allow every command for the rest of this run">
                    Allow all
                  </button>
                )}
                <button className="primary" onClick={() => s.answerPermission("allow")}>
                  Allow once
                </button>
              </div>
            </div>
          ) : reviewing ? (
            <div className="gate" role="region" aria-label="Plan review">
              <div className="gh">
                <span className="pause" aria-hidden="true">⏸</span>
                The plan is ready
              </div>
              {decisions.length > 0 ? (
                <>
                  <EditList decisions={decisions} />
                  <p>Revise plan: it redraws the plan with your changes and asks again. Approve with changes: it builds with them.</p>
                </>
              ) : (
                <p>Change anything first (on the board, or in Plan details), or approve to start building. Nothing is built until you approve.</p>
              )}
              <div className="gate-actions">
                {decisions.length > 0 && (
                  <button className="secondary" onClick={sendEdits} title="The agent updates the plan and asks again">
                    Revise plan
                  </button>
                )}
                <button className="primary" onClick={approve} data-tour="approve">
                  {decisions.length > 0 ? "Approve with changes" : "Approve plan & build"}
                </button>
              </div>
            </div>
          ) : decisions.length > 0 ? (
            <div className="pending">
              <div className="ph">
                Your changes <span className="count">{decisions.length}</span>
              </div>
              <EditList decisions={decisions} />
              <button className="primary" onClick={sendEdits} title={st.busy ? "Sent when the agent finishes this step" : "Send to the agent"}>
                Submit{st.busy ? " ⏳" : ""}
              </button>
            </div>
          ) : awaitingTask ? null : (
            <p className="hint">
              {/* One ask at a time: while the tour runs, its card is it. */}
              {!tour && <><b>Steer from the board:</b> use Edit the plan above it, click a ◇ to pick another option, or drop a sticker on a part. Then Submit.</>}
              {agentMode && s?.runId && s?.result && (
                <span className="after-run">
                  <button className="linkish" onClick={() => replay(s.runId)}>
                    Replay this run
                  </button>
                  <a className="linkish" href={decisionsUrl(s.runId)} target="_blank" rel="noreferrer">
                    Decision log
                  </a>
                </span>
              )}
            </p>
          )}
          {reviewing && !draft && allDecisions.length > 0 && (
            <div className="suggest" aria-label="Questions you could ask">
              {allDecisions
                .filter((d) => d.state !== "rejected")
                .sort((a, b) => a.n - b.n)
                .slice(0, 2)
                .map((d) => (
                  <button key={d.id} onClick={() => challenge(d)} title={`Starts a message about D${d.n}: ${d.chose}`}>
                    Ask why: D{d.n} {clip(d.title, 30)}
                  </button>
                ))}
            </div>
          )}
          <form className="ask" onSubmit={sendChat} hidden={replayMode}>
            <input
              id="ask"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={awaitingTask ? "Describe a task for the agent…" : reviewing ? "Ask for changes to the plan…" : "Tell the agent something…"}
            />
            <button type="submit" disabled={!draft.trim()}>
              {awaitingTask ? "Start" : "Send"}
            </button>
          </form>
        </footer>
      </aside>

      <main className="board">
        {model && <PhaseHeader model={model} reviewing={s.board.reviewing} hl={s.board.hl} onHover={(ids) => s.setHover(ids)} onFocus={focusInPlan} />}
        <div className="canvas-tabs" role="tablist" aria-label="Board">
          <button role="tab" aria-selected={boardView === "board"} data-tour="arch-tab" onClick={() => showView("board")} title="The components and how they connect. Edit it to steer the agent.">
            <span className="ct-icon" aria-hidden="true" />
            Architecture
            <span className="ct-sub">what it builds</span>
            {nodeCount > 0 && <span className="ct-count">{nodeCount}</span>}
          </button>
          <button role="tab" aria-selected={boardView === "why"} data-tour="why-tab" onClick={() => showView("why")} title="Each decision: its evidence, what it shapes, and the check that proves it">
            <span className="vs-diamond" aria-hidden="true" />
            Why
            <span className="ct-sub">the reasons</span>
            {allDecisions.length > 0 && <span className="ct-count" title="Decisions">{allDecisions.length}</span>}
            {(proofCount("pass") > 0 || proofCount("fail") > 0) && (
              <span className="ct-proofs" title={`${proofCount("pass")} proven, ${proofCount("fail")} failed, ${proofCount(null)} not checked yet`}>
                {proofCount("pass") > 0 && <span className="pf-pass">✓{proofCount("pass")}</span>}
                {proofCount("fail") > 0 && <span className="pf-fail">✗{proofCount("fail")}</span>}
              </span>
            )}
          </button>
          <button role="tab" aria-selected={boardView === "timeline"} data-tour="timeline-tab" onClick={() => showView("timeline")} title="How the decisions moved over the run: what changed, when, and because of what">
            <span className="tl-icon" aria-hidden="true" />
            Timeline
            <span className="ct-sub">what changed when</span>
            {hasTimeline && <span className="ct-count" title="How long the run took">{fmt(tl.duration)}</span>}
            {tl?.changes > 0 && (
              <span className="ct-changes" title={`${tl.changes} decision change${tl.changes === 1 ? "" : "s"}`}>
                ◆{tl.changes}
              </span>
            )}
          </button>
          {boardView === "board" && nodeCount > 0 && (
            // One flow's steps on the board, and Export. How to draw it and which layer: the bar below.
            <details className="export-menu view-menu">
              <summary title="Show one flow's steps, or export what the board shows">
                {exported === "ok" ? "✓ Exported" : exported === "failed" ? "✗ Export failed" : focus?.flow && !inside ? `Flow: ${model.flows[focus.flow]?.name ?? ""}` : "Flows & export"}
              </summary>
              <div className="export-items view-items">
                {!inside && diagram !== "er" && Object.keys(model.flows).length > 0 && (
                  <label>
                    <span>Show a flow</span>
                    <select
                      className="focus-pick"
                      value={focus?.flow ? `flow:${focus.flow}` : ""}
                      onChange={(e) => {
                        const [k, v] = e.target.value.split(":");
                        chooseFocus(k ? { [k]: v } : null);
                      }}
                      title="One flow's steps in order, numbered on the arrows"
                    >
                      {diagram !== "sequence" && <option value="">None</option>}
                      {Object.values(model.flows).map((f) => (
                        <option key={f.id} value={`flow:${f.id}`}>
                          {f.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <span className="vi-head">Export</span>
                <button onClick={() => exportView("mermaid")} title="Copy as a Mermaid diagram (GitHub renders it)">
                  Copy Mermaid
                </button>
                <button onClick={() => exportView("svg")}>Download SVG</button>
                <button onClick={() => exportView("png")}>Download PNG</button>
              </div>
            </details>
          )}
          <span className="ct-hint">
            {tour
              ? null
              : boardView === "why"
                ? "Evidence → decision → what it shapes → proof. Click a row to read it."
                : boardView === "timeline"
                  ? `How the decisions moved. ${replayMode ? "Click a moment to jump there." : "Click a mark to read it."}`
                  : inside
                    ? "Inside each part. Read-only."
                    : diagram === "er"
                      ? "The tables each data store holds: keys, columns and relations. Read-only."
                      : diagram === "sequence"
                        ? "One flow, step by step. Pick another under Flows. Read-only."
                        : "Click any part or ◇ to learn what it is."}
          </span>
        </div>
        {boardView === "board" && nodeCount > 0 && (
          // The same plan, seen other ways: how it's drawn, and how far in you look.
          <div className="lens-bar" data-tour="lens">
            <div className="lens-group" role="group" aria-label="Draw it as">
              <span className="lens-label">Draw as</span>
              {DIAGRAMS.map((d) => (
                <button key={d.key} className={`lens ${!inside && diagram === d.key ? "on" : ""}`} aria-pressed={!inside && diagram === d.key} onClick={() => chooseDiagram(d.key)} title={d.title}>
                  {d.label}
                </button>
              ))}
            </div>
            <div className="lens-group" role="group" aria-label="Zoom into a layer">
              <span className="lens-label">Zoom into</span>
              <button className={`lens ${!inside ? "on" : ""}`} aria-pressed={!inside} onClick={() => chooseInside(null)} title="The whole system: every part, closed">
                Whole system
              </button>
              {openableLayers(model).map((l) => (
                <button key={l.key} className={`lens ${inside === l.key ? "on" : ""}`} aria-pressed={inside === l.key} onClick={() => chooseInside(l.key)} title={`Open the ${l.label} layer: what's inside its parts`}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {editable && !glassUp && (
          <div className="edit-bar" role="toolbar" aria-label="Edit the plan">
            <span className="eb-label">Edit the plan:</span>
            <button onClick={() => useTool("selection", null)} title="Select, move and double-click things on the board">
              <ToolIcon name="select" />
              Select
            </button>
            <button onClick={toolRename} title="Rename the selected part (or double-click any name)">
              <ToolIcon name="rename" />
              Rename
            </button>
            <button onClick={() => useTool("rectangle", "Draw a box on the board, then type its name.")} title="Ask for a new part: draw a box and name it">
              <ToolIcon name="add" />
              Add a part
            </button>
            <button onClick={() => useTool("arrow", "Drag from one part to another.")} title="Ask for a new connection: draw an arrow between two parts">
              <ToolIcon name="connect" />
              Connect
            </button>
            <button onClick={toolRemove} title="Remove the selected part or connection, or reject the selected ◇ decision">
              <ToolIcon name="remove" />
              Remove
            </button>
            <button onClick={() => useTool("text", "Click an empty spot and type a note, like “English PDFs only”.")} title="Add a note that narrows what it builds">
              <ToolIcon name="note" />
              Add a note
            </button>
            <button onClick={openStickers} data-tour="stickers" title="Stickers to drag onto a part or a ◇: Why?, Not needed, Keep this">
              <ToolIcon name="stickers" />
              Stickers
            </button>
            <button className={`eb-tools ${tools ? "on" : ""}`} aria-pressed={tools} onClick={toggleTools} title="Show or hide Excalidraw's full drawing tools">
              <ToolIcon name="tools" />
              Drawing tools
            </button>
            <button className="gb-raise" onClick={raiseGlass} title="Back to looking: your changes stay in the list until you Submit">
              <span aria-hidden="true">⇡</span> Glass back up
            </button>
          </div>
        )}
        <div className="canvases" data-tour="board">
          <div
            className={`canvas arch ${boardView === "board" && !readOnlyView ? "on" : ""} ${ownSel ? "own-sel" : ""} ${tools ? "tools-on" : "tools-off"}`}
            role="tabpanel"
            aria-label="Architecture"
          >
            <Excalidraw excalidrawAPI={setApi} initialData={INITIAL_DATA} onChange={onChange} UIOptions={UI_OPTIONS} />
            {editable && (
              <div className={`glass ${glassUp ? "up" : "down"}`} aria-hidden="true">
                <span className="glass-glint" />
              </div>
            )}
            {editable && glassUp && (
              <button className="glass-handle" data-tour="glass" onClick={lowerGlass} title="Pull the glass down to move, rename, remove or add things, then Submit">
                <span aria-hidden="true">⇣</span> Pull down to edit
              </button>
            )}
            {toolHint && editable && (
              <p className="tool-hint" role="status">
                {toolHint}
              </p>
            )}
            {selected && boardView === "board" && !readOnlyView && model && (
              <Explain
                key={selected}
                lid={selected}
                model={model}
                live={!replayMode}
                onClose={() => s.board.api.updateScene({ appState: { selectedElementIds: {} } })}
                onRename={(id) => (lowerGlass(), renameOnBoard(id))}
                onRemove={() => (lowerGlass(), toolRemove())}
                onAsk={prefill}
                onChallenge={challenge}
                onPick={(d, i) => (lowerGlass(), s.board.pickAlternative(d.id, i))}
                onOpen={(lid) => focusInPlan([lid])}
                onCode={(id) => goReview(`code:${id}`)}
                onInside={chooseInside}
                onAnswer={(q, text) => {
                  s.answerQuestion(q, text);
                  stick.current = true;
                }}
                onConfirm={(q) => s.confirmAssumption(q)}
                onCorrect={(q) => prefill(`About A${q.n} (${q.text}): `)}
              />
            )}
            {decisions.length > 0 && !replayMode && (
              <button className="board-submit primary" onClick={sendEdits} title={st.busy ? "Sent when the agent finishes this step" : "Send your board changes to the agent"}>
                {Object.entries(AREAS).map(([a, { icon, label }]) => {
                  const n = decisions.filter((d) => areaOf(d) === a).length;
                  return n > 0 && <span key={a} className="bs-area" title={label}>{icon}{n}</span>;
                })}
                Submit{st.busy ? " ⏳" : ""}
              </button>
            )}
            {model && !nodeCount && <p className="canvas-empty">The architecture appears here as the agent plans: each component, what it connects to, and its decisions.</p>}
            {focus?.flow && model?.flows[focus.flow] && (
              <FlowSteps
                flow={model.flows[focus.flow]}
                model={model}
                onHover={(ids) => s.setHover(ids)}
                onClose={() => chooseFocus(null)}
              />
            )}
          </div>
          <div
            className={`canvas ${boardView === "board" && readOnlyView ? "on" : ""}`}
            role="tabpanel"
            aria-label={inside ? `Inside the ${LAYERS.find((l) => l.key === inside)?.label} layer` : diagram === "er" ? "Data model" : "Sequence"}
          >
            <Excalidraw excalidrawAPI={setDiagramApi} initialData={INITIAL_DATA} UIOptions={WHY_UI_OPTIONS} viewModeEnabled theme={theme} />
            {model && inside && !openableLayers(model).some((l) => l.key === inside) && (
              <p className="canvas-empty">Nothing in this layer yet. Its parts appear here once the agent draws them.</p>
            )}
            {model && !inside && diagram === "er" && !Object.keys(model.tables ?? {}).length && (
              <p className="canvas-empty">The data model appears here when the agent describes its tables: columns, keys and how they relate.</p>
            )}
            {model && !inside && diagram === "sequence" && !Object.keys(model.flows ?? {}).length && (
              <p className="canvas-empty">A flow appears here as a sequence diagram once the agent maps one: who calls whom, in order.</p>
            )}
          </div>
          <div
            className={`canvas ${boardView === "why" ? "on" : ""}`}
            role="tabpanel"
            aria-label="Why"
            onPointerDownCapture={(e) => (whyDown.current = [e.clientX, e.clientY])}
            onPointerUpCapture={whyClick}
          >
            <Excalidraw excalidrawAPI={setWhyApi} initialData={INITIAL_DATA} UIOptions={WHY_UI_OPTIONS} viewModeEnabled theme={theme} />
            {model && !allDecisions.length && (
              <p className="canvas-empty">Each technical decision appears here as a chain: the evidence behind it, what it shapes, and the check that proves it.</p>
            )}
          </div>
          <div
            className={`canvas ${boardView === "timeline" ? "on" : ""}`}
            role="tabpanel"
            aria-label="Timeline"
            onPointerDownCapture={(e) => (tlDown.current = [e.clientX, e.clientY])}
            onPointerUpCapture={tlClick}
            onWheelCapture={() => s && (s.board.tlFollow = false)}
          >
            <Excalidraw excalidrawAPI={setTimelineApi} initialData={INITIAL_DATA} UIOptions={WHY_UI_OPTIONS} viewModeEnabled theme={theme} />
            {model && !hasTimeline && (
              <p className="canvas-empty">The run appears here over time: what you did, each test run, and every decision as a lane, from proposed to proven.</p>
            )}
          </div>
        </div>
        {boardView === "board" && diagram === "pictures" && !inside && nodeCount > 0 && <BoardKey />}
      </main>
    </div>
  );
}
