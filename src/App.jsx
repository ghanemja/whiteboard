import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToBlob, exportToSvg, FONT_FAMILY, MIME_TYPES, sceneCoordsToViewportCoords, serializeLibraryAsJSON, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { Board, PHASES, STATUS, STICKERS, stickerItems } from "./engine/board";
import PhaseHeader from "./PhaseHeader";
import { Session } from "./engine/session";
import { AREAS, areaOf, fmt, STICKER_WORD } from "./engine/timeline";
import { busyDecisions, LAYER_COLOR, LAYERS, layerOf, openableLayers, tagCase, toDfdMermaid, toErMermaid, toInsideMermaid, toMermaid, toSequence } from "./engine/views";
import { buildReview, penMarks } from "./engine/review";
import { logMarkdown } from "./engine/logfile";
import { createHistory } from "./engine/history";
import { presentable } from "./engine/present";
import { toUmlMermaid, UML_KINDS } from "./engine/uml";
import { advance, back as tourBack, holds, isFresh, next as tourNext, startTour, stepOf, targets as tourTargets, tourLength, waiting as tourWaiting } from "./engine/tour";
import { decisionsUrl, getAgentStatus, getRepoBoard, listRecordings } from "./agent/live";
import { TourCard, TourSpotlight } from "./Tour";
import { RepoField } from "./RepoPicker";
import { LiveSetup } from "./LiveSetup";

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
  download: <path d="M8 2.5v8M4.8 7.5L8 10.7l3.2-3.2M3 13.5h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
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

// The panel shows the plan, not the log (⇩ downloads that). What the agent says still reaches you
// here, at the top: its reply to what you typed last, an error, or the one line of the run you
// opened from the review, the red pen, the Timeline or Plan details.
function Said({ head, tone, onClose, children }) {
  return (
    <div className={["said", tone && `said-${tone}`].filter(Boolean).join(" ")} role={tone === "bad" ? "alert" : "region"} aria-label={head}>
      <div className="said-h">
        <span>{head}</span>
        <button className="linkish" onClick={onClose} aria-label="Close" title="Close">
          ✕
        </button>
      </div>
      {children}
    </div>
  );
}

// Sentences, each with its receipt; a long reply shows its first few, "⋯ n" opens the rest.
function Sentences({ items, receipts, first = 3 }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, first);
  return (
    <p>
      {shown.map((it) => (
        <span key={it.id}>
          <Rich text={it.text} />
          {receipts.get(it.id) && <> <Receipt r={receipts.get(it.id)} /></>}{" "}
        </span>
      ))}
      {shown.length < items.length && (
        <button className="skim-gap" onClick={() => setAll(true)} title="Show the rest">
          ⋯ {items.length - shown.length}
        </button>
      )}
    </p>
  );
}

// One line of the run, opened from elsewhere: a sentence, your message, or a command it ran.
function SaidLine({ line, receipts }) {
  if (line.type === "s") return <Sentences items={[line]} receipts={receipts} />;
  if (line.type === "act")
    return (
      <p className="said-act">
        <code>{line.labels.join(", ")}</code> {line.ok === true ? <span className="act-ok">✓</span> : line.ok === false ? <span className="act-bad">✗</span> : null}
        {line.summary && <span className="act-summary">{line.summary}</span>}
      </p>
    );
  if (line.kind === "chat") return <p>{line.text}</p>;
  if (line.kind === "permission") return <p>{{ deny: "Denied", "allow-all": "Allowed every command, starting with" }[line.decision] ?? "Allowed"} <code>{line.detail}</code></p>;
  return (
    <>
      <p className="sub">{line.kind === "approve" ? `Approved the plan${line.decisions.length ? " with changes:" : ""}` : "Changed the board:"}</p>
      {line.decisions.length > 0 && <EditList decisions={line.decisions} />}
    </>
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
  { key: "uml", label: "UML", title: "UML: class, component, sequence and activity diagrams. Tick the ones to show, one or all" },
];
// The views drawn on their own read-only canvas, rather than by redrawing the editable board.
const READ_ONLY = ["er", "sequence", "uml"];
// Labels in sentence case: "proposed" → "Proposed".
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// The development plan as a document: goal, architecture, connections, the reasoning
// chain of decisions, and the steps. Every item is linked to its picture on the board.
// A Plan section: closed until you open it, so the tab reads as a short list of headings.
// Anything that points into it (a click on the board, the review) opens it first (reveal()).
function Sec({ id, title, hint, note, count, badge, children }) {
  return (
    <details className="plan-sec" id={id}>
      <summary title={hint}>
        <h3>{title}</h3>
        {note}
        {count > 0 && <span className="sec-count">{count}</span>}
        {badge}
      </summary>
      {children}
    </details>
  );
}

// What needs a look among the decisions: not approved yet, changed, or failed their check.
function DecisionBell({ decisions }) {
  const proposed = decisions.filter((d) => d.state === "proposed").length;
  const changed = decisions.filter((d) => d.state === "changed").length;
  const failed = decisions.filter((d) => d.proof === "fail").length;
  const n = proposed + changed + failed;
  if (!n) return null;
  const why = [proposed && `${proposed} not approved yet`, changed && `${changed} changed`, failed && `${failed} failed its check`].filter(Boolean).join(", ");
  return (
    <span className="sec-bell" title={`To look at: ${why}`} aria-label={`${n} to look at: ${why}`}>
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.6L3 10.6h10l-1.4-2.2V5.8A3.6 3.6 0 0 0 8 2.2zM6.6 12.2a1.4 1.4 0 0 0 2.8 0" />
      </svg>
      {n}
    </span>
  );
}

// Open the Plan sections round an element, then bring it into view.
function reveal(el, block = "nearest") {
  for (let d = el?.closest("details"); d; d = d.parentElement?.closest("details")) d.open = true;
  el?.scrollIntoView({ block, behavior: "smooth" });
}

function PlanView({ model, phase, selected, onHover, onFocus, onChallenge, onPick, onShowFlow, canChallenge, changes = [], commits = 0, passing = [], onAnswer, onConfirm, onCorrect, onReply, onShow }) {
  const nodes = Object.values(model.nodes);
  const changed = nodes.filter((n) => n.diff);
  const byPath = new Map(changes.map((f) => [f.path, f]));
  const toCode = (id) => reveal(document.getElementById(`plan-code:${id}`), "start");
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
        <Sec title="Architecture" count={nodes.length}>
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
        </Sec>
      )}

      {edges.length > 0 && (
        <Sec title="Connections" count={edges.length}>
          <ul className="plan-edges">
            {edges.map((e) => (
              <li key={`${e.from}>${e.to}`} {...link(`edge:${e.from}>${e.to}`)}>
                <span>{name(e.from)} → {name(e.to)}</span>
                {e.via && <span className="chip">{tagCase(e.via)}</span>}
                {e.api && <code>{e.api}</code>}
              </li>
            ))}
          </ul>
        </Sec>
      )}

      {Object.keys(model.tables ?? {}).length > 0 && (
        <Sec title="Data model" count={Object.keys(model.tables ?? {}).length}>
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
        </Sec>
      )}

      {Object.keys(model.flows ?? {}).length > 0 && (
        <Sec title="Flows" count={Object.keys(model.flows).length}>
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
        </Sec>
      )}

      {changes.length > 0 && (
        <Sec
          id="plan-code"
          title="Code"
          hint={`${changes.length} files changed in this run, ${commits ? `in ${commits} commits` : "not committed"}`}
          note={
            <span className="h3-note">
              <span className="fd-add">+{changes.reduce((a, f) => a + f.add, 0)}</span> <span className="fd-del">−{changes.reduce((a, f) => a + f.del, 0)}</span> ·{" "}
              {commits ? `${commits} commit${commits === 1 ? "" : "s"}` : "uncommitted"}
            </span>
          }
        >
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
        </Sec>
      )}

      {tasks.length > 0 && (
        <Sec title="Steps" count={tasks.length}>
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
        </Sec>
      )}

      {decisions.length > 0 && (
        <Sec title="Decisions" note={<span className="h3-note">the reasoning chain</span>} count={decisions.length} badge={<DecisionBell decisions={decisions} />}>
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
        </Sec>
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

// What the colors mean, under the Pictures board (C4 and data flow draw their own key). Under the
// database and sequence diagrams only the layers apply: they color those too.
const KEY = [["planned", "New"], ["built", "Exists"], ["building", "Being built"], ["verified", "Tested ✓"], ["failed", "Failed ✗"], ["live", "Shipped ★"]];
function BoardKey({ model, layersOnly = false }) {
  const layers = LAYERS.filter((l) => Object.values(model?.nodes ?? {}).some((n) => layerOf(n) === l.key));
  return (
    <div className="board-key" aria-label="Key" data-tour="key">
      {!layersOnly && (
        <>
          <b>Key</b>
          {KEY.map(([k, label]) => (
            <span key={k}>
              <i className="sw" style={{ borderColor: STATUS[k].stroke, background: STATUS[k].fill }} />
              {label}
            </span>
          ))}
          <span title="Its circle is its check: ? not run yet, ✓ passed, ✗ failed. It pulses while the work is in progress. Point at a ◇ to see the other parts it shapes.">
            <i className="sw sw-dia" />
            Decision, dashed until you approve
          </span>
          <span>
            <i className="sw" style={{ borderColor: "#f08c00", background: "#fff4e6" }} />
            Question for you
          </span>
        </>
      )}
      {layers.length > 0 && (
        <span className="bk-layers" title="The plate behind each part: which layer it's in. Zoom into one to open it up.">
          <b>Layers</b>
          {layers.map((l) => (
            <span key={l.key}>
              <i className="sw sw-layer" style={{ borderColor: LAYER_COLOR[l.key].stroke, background: LAYER_COLOR[l.key].fill }} />
              {l.label}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

// The decisions in progress (busyDecisions): each one's status circle on the board pulses.
// Excalidraw doesn't animate, so a CSS ring sits over the circle and follows the board as it pans,
// zooms or redraws (api.onChange), moved straight on the DOM so nothing re-renders. It's not part
// of the scene, so exports and the undo history never see it. Reduced motion: a still ring.
function DecisionPulse({ api, ids }) {
  const box = useRef(null);
  const key = ids.join();
  useEffect(() => {
    if (!api || !key) return;
    let last = null;
    const place = (els, st) => {
      const root = box.current;
      const now = [els, st.scrollX, st.scrollY, st.zoom.value, st.offsetLeft, st.offsetTop];
      if (!root || (last && now.every((v, i) => v === last[i]))) return;
      last = now;
      const r = root.getBoundingClientRect(), z = st.zoom.value;
      for (const ring of root.children) {
        const el = els.find((e) => e.id === `dec-${ring.dataset.id}-pf` && !e.isDeleted);
        // Faded by a layer or flow filter: no pulse either.
        ring.hidden = !el || el.opacity <= 50;
        if (ring.hidden) continue;
        const x = (el.x + el.width / 2 + st.scrollX) * z + st.offsetLeft - r.left;
        const y = (el.y + el.height / 2 + st.scrollY) * z + st.offsetTop - r.top;
        ring.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      }
    };
    place(api.getSceneElements(), api.getAppState());
    return api.onChange(place);
  }, [api, key]);
  if (!ids.length) return null;
  return (
    <div className="dec-pulses" ref={box} aria-hidden="true">
      {ids.map((id) => (
        <span key={id} className="dec-pulse" data-id={id} />
      ))}
    </div>
  );
}

// The stickers, always in sight at the top of the board: drag one onto a part or a ◇. The drop is Excalidraw's
// own library drop, so the board gets the same sticker elements (stickerItems) and turns them into
// edits as before. A drop pulls the glass down, so you can move it or Submit.
const STICKER_SAYS = { why: "Asks it to explain", drop: "Asks it to drop that", keep: "Says leave it as is" };
function StickerTray({ onDropped }) {
  return (
    <div className="sticker-tray" data-tour="stickers" role="group" aria-label="Stickers: drag one onto a part or a decision">
      {Object.entries(STICKERS).map(([key, st]) => (
        <span
          key={key}
          className="sticker"
          draggable
          title={`${STICKER_SAYS[key]}. Drag it onto a part or a ◇.`}
          style={{ "--st-stroke": st.stroke, "--st-fill": st.fill, transform: `rotate(${st.angle}rad)` }}
          onDragStart={(e) => {
            const item = stickerItems().find((i) => i.id === `wb-sticker-${key}`);
            e.dataTransfer.setData(MIME_TYPES.excalidrawlib, serializeLibraryAsJSON([item]));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onDragEnd={(e) => e.dataTransfer.dropEffect !== "none" && onDropped()}
        >
          {st.label}
        </span>
      ))}
      <span className="st-hint">drag onto a part or ◇</span>
    </div>
  );
}

// A canvas nobody sees: where a pinned view's mirror board draws its Reasoning and Timeline.
const NO_CANVAS = new Proxy(
  {},
  { get: (_, k) => (k === "getAppState" ? () => ({ zoom: { value: 1 }, scrollX: 0, scrollY: 0, width: 1, height: 1, offsetLeft: 0, offsetTop: 0 }) : String(k).startsWith("getScene") ? () => [] : () => {}) },
);
const ARCH_STYLES = ["pictures", "c4", "dfd"];

// A view pinned beside the board: its own small, read-only canvas, dragged by its title bar,
// resized from its corner, closed with −. Pictures, C4 and Data flow get a mirror Board in that
// style, fed every op the session applies; Database, Sequence and a layer are drawn from the
// board's model. So two views of the same plan can be open at once, and both keep up with it.
function PinnedView({ v, s, theme, onClose, onChange }) {
  const [api, setApi] = useState(null);
  const box = useRef(null);
  useEffect(() => {
    if (!api || !s) return;
    let alive = true, t;
    // Fit the drawing, not the board's invisible frame round its whole grid.
    const fit = () => alive && api.scrollToContent(api.getSceneElements().filter((e) => e.id !== "frame"), { fitToViewport: true, viewportZoomFactor: 0.9 });
    const soon = () => (clearTimeout(t), (t = setTimeout(fit, 150)));
    let watch;
    if (ARCH_STYLES.includes(v.kind)) {
      const b = new Board(api, { style: v.kind, whyApi: NO_CANVAS, timelineApi: NO_CANVAS });
      const apply = (op) => {
        try {
          b.apply(op);
        } catch {
          /* a mirror is best effort: the main board is the real one */
        }
      };
      const replay = async () => {
        b.reset();
        await b.init();
        if (!alive) return;
        s.opLog.forEach(apply);
        soon();
      };
      replay();
      watch = (op) => (op ? (apply(op), soon()) : replay());
    } else {
      let sig = "";
      const draw = () => {
        const els = s.board.diagramScene(v.kind, v.arg);
        const next = JSON.stringify(els.map((e) => [e.id, Math.round(e.x), Math.round(e.y), e.text ?? ""]));
        if (next === sig) return;
        sig = next;
        api.updateScene({ elements: els });
        soon();
      };
      draw();
      watch = () => draw();
    }
    s.opWatchers.add(watch);
    return () => {
      alive = false;
      clearTimeout(t);
      s.opWatchers.delete(watch);
    };
  }, [api, s, v.kind, v.arg]);
  // Resized from its corner: Excalidraw measures again, and the size is kept.
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(() => {
      const r = box.current?.getBoundingClientRect();
      if (r && (Math.round(r.width) !== v.w || Math.round(r.height) !== v.h)) onChange({ w: Math.round(r.width), h: Math.round(r.height) });
      api?.refresh();
    });
    ro.observe(box.current);
    return () => ro.disconnect();
  });
  // Dragged by the title bar, kept inside the board's area.
  const drag = (e) => {
    if (e.target.closest("button")) return;
    const area = box.current.parentElement.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY, left: v.x, top: v.y };
    const move = (m) =>
      onChange({
        x: Math.max(0, Math.min(area.width - v.w, start.left + m.clientX - start.x)),
        y: Math.max(0, Math.min(area.height - 40, start.top + m.clientY - start.y)),
      });
    const up = () => (removeEventListener("pointermove", move), removeEventListener("pointerup", up));
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
  };
  return (
    <div className="pin" ref={box} style={{ left: v.x, top: v.y, width: v.w, height: v.h }} role="region" aria-label={`Pinned view: ${v.title}`}>
      <div className="pin-head" onPointerDown={drag}>
        <span className="pin-title">{v.title}</span>
        <button className="pin-close" onClick={onClose} title="Unpin this view" aria-label={`Unpin ${v.title}`}>
          −
        </button>
      </div>
      <div className="pin-body">
        <Excalidraw excalidrawAPI={setApi} initialData={INITIAL_DATA} UIOptions={WHY_UI_OPTIONS} viewModeEnabled theme={theme} />
      </div>
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
  const [ownSel, setOwnSel] = useState(false); // only the board's own drawing is selected: no style panel
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState("");
  // What you typed before, for ↑ / ↓ in the message box (kept in this browser).
  const history = useRef(null);
  history.current ??= createHistory({
    load: () => JSON.parse(localStorage.getItem("wb-history") ?? "[]"),
    save: (items) => localStorage.setItem("wb-history", JSON.stringify(items)),
  });
  const browseHistory = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.nativeEvent.isComposing) return;
    const v = e.key === "ArrowUp" ? history.current.up(draft) : e.key === "ArrowDown" ? history.current.down() : null;
    if (v == null) return;
    e.preventDefault();
    setDraft(v);
    const el = e.currentTarget;
    requestAnimationFrame(() => el.setSelectionRange(v.length, v.length));
  };
  const [repo, setRepo] = useState("");
  // The board saved in the picked repo (whiteboard.zip), if any: { file, saved }.
  const [repoBoard, setRepoBoard] = useState(null);
  const [agent, setAgent] = useState(null); // { live, provider, model, effort, defaultRepo } from the dev server
  const [recordings, setRecordings] = useState([]);
  const [quote, setQuote] = useState(null); // the line of the run opened at the top of the panel (Said)
  const [closed, setClosed] = useState(() => new Set()); // replies and errors you closed
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
  const partOpens = useRef(0); // parts clicked on the board (the tour's build step waits for one)
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
  const readOnlyDiagram = READ_ONLY.includes(diagram);
  // UML: which of its diagrams to show (all of them, or the ones ticked), remembered per browser.
  const [umlKinds, setUmlKinds] = useState(() => {
    try {
      const v = JSON.parse(localStorage.getItem("wb-uml") ?? "null");
      return Array.isArray(v) && v.length ? v.filter((k) => UML_KINDS.some((u) => u.key === k)) : UML_KINDS.map((u) => u.key);
    } catch {
      return UML_KINDS.map((u) => u.key);
    }
  });
  const chooseUml = (keys) => {
    const next = UML_KINDS.map((u) => u.key).filter((k) => keys.includes(k));
    setUmlKinds(next);
    try {
      localStorage.setItem("wb-uml", JSON.stringify(next));
    } catch {
      /* private window: just this page */
    }
  };
  // Zoom into a layer (a LAYERS key) or the whole system (null): in place on the board, that
  // layer's components burst open to show their parts while the rest fades, and the camera
  // refits (Board.drawExplode). The board stays the editable one.
  const [inside, setInside] = useState(null);
  const readOnlyView = readOnlyDiagram;
  const chooseInside = (k) => {
    setInside(k);
    setFocus(null);
    // The data model and sequence diagrams are separate canvases: open the layer on the board.
    if (k && readOnlyDiagram) chooseDiagram(styleRef.current, { keepInside: true });
    sessionRef.current?.board.setFocus(k ? { layer: k, explode: true } : null);
  };
  const chooseDiagram = (v, { keepInside = false } = {}) => {
    setDiagram(v);
    // Pictures, C4 and Data flow keep a layer open (redrawn in that style); the others close it.
    if (inside && !keepInside && READ_ONLY.includes(v)) {
      setInside(null);
      sessionRef.current?.board.setFocus(null);
    }
    if (!READ_ONLY.includes(v)) {
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
  // The UML view's diagrams and flow, as Board.drawDiagram("uml", …) takes them.
  const umlArg = `${umlKinds.join(",")}|${focus?.flow ?? ""}`;
  const chooseFocus = (f) => {
    if (f) setInside(null); // a flow replaces an opened layer
    setFocus(f);
    sessionRef.current?.board.setFocus(f);
  };
  // Views pinned beside the board, each in its own window: { id, kind, arg, title, x, y, w, h }.
  const [pins, setPins] = useState([]);
  // + Pin this view: what the board shows now, in a window of its own (one of each).
  const pinView = () => {
    const m = sessionRef.current?.board.model;
    if (!m) return;
    const flow = focus?.flow && m.flows[focus.flow];
    const v = inside
      ? { kind: "inside", arg: inside, title: `Inside: ${LAYERS.find((l) => l.key === inside)?.label}` }
      : diagram === "sequence"
        ? { kind: "sequence", arg: flow?.id ?? Object.keys(m.flows)[0], title: `Sequence: ${(flow ?? Object.values(m.flows)[0])?.name ?? ""}` }
        : diagram === "uml"
          ? { kind: "uml", arg: umlArg, title: `UML: ${UML_KINDS.filter((u) => umlKinds.includes(u.key)).map((u) => u.label).join(", ")}` }
          : { kind: diagram, title: DIAGRAMS.find((d) => d.key === diagram)?.label ?? "View" };
    setPins((ps) => {
      if (ps.some((p) => p.kind === v.kind && p.arg === v.arg)) return ps;
      const area = document.querySelector(".canvases")?.getBoundingClientRect();
      const w = 420, h = 300, k = ps.length;
      return [...ps, { ...v, id: `pin-${Date.now()}`, w, h, x: Math.max(0, (area?.width ?? 900) - w - 24 - k * 28), y: 64 + k * 28 }];
    });
  };
  const pinned = !!pins.find((p) => (inside ? p.kind === "inside" && p.arg === inside : p.kind === diagram && (diagram === "uml" ? p.arg === umlArg : diagram !== "sequence" || p.arg === (focus?.flow ?? p.arg))));

  // Export what the board shows: Mermaid (the container view, or the flow as a sequence
  // diagram) for a README or PR, or an SVG/PNG with a title.
  const [exported, setExported] = useState(null);
  // SVG/PNG in the board's hand-drawn sketch, or clean (straight lines, a plain font) for slides and docs.
  const [exportLook, setExportLook] = useState(() => {
    try {
      return localStorage.getItem("wb-export-look") === "sketch" ? "sketch" : "clean";
    } catch {
      return "clean";
    }
  });
  const chooseExportLook = (look) => {
    setExportLook(look);
    try {
      localStorage.setItem("wb-export-look", look);
    } catch {
      /* storage blocked: it's still set for this page */
    }
  };
  const exportView = async (kind) => {
    const s = sessionRef.current;
    if (!s) return;
    const b = s.board, m = b.model;
    const flow = !inside && focus?.flow && m.flows[focus.flow];
    const layer = focus?.layer && LAYERS.find((l) => l.key === focus.layer);
    const umlNames = UML_KINDS.filter((u) => umlKinds.includes(u.key)).map((u) => u.label).join(", ");
    const name = diagram === "uml" ? `UML: ${umlNames}` : diagram === "er" ? "Data model" : diagram === "sequence" ? "Sequence" : diagram === "dfd" ? "Data flow" : diagram === "c4" ? "Container view" : "Architecture";
    const view = inside ? `Inside the ${LAYERS.find((l) => l.key === inside)?.label} layer` : flow && diagram !== "er" && diagram !== "uml" ? `${name}: ${flow.name}` : layer ? `${name}: ${layer.label} layer` : name;
    const title = [m.project, view].filter(Boolean).join(" · ");
    const file = title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board";
    try {
      if (kind === "mermaid" && diagram === "uml" && !inside) {
        const blocks = toUmlMermaid(m, { kinds: umlKinds, flow: flow || Object.values(m.flows)[0] });
        if (!blocks.length) throw new Error("nothing to export");
        await navigator.clipboard.writeText(blocks.map((b) => `${b.label} diagram:\n\n\`\`\`mermaid\n${b.body}\`\`\`\n`).join("\n"));
      } else if (kind === "mermaid") {
        const only = layer && new Set(Object.values(m.nodes).filter((n) => [layer.key, null].includes(layerOf(n))).map((n) => n.id));
        const text = inside
          ? toInsideMermaid(m, inside)
          : diagram === "er" ? toErMermaid(m) : flow ? toSequence(m, flow) : diagram === "dfd" ? toDfdMermaid(m, { only }) : toMermaid(m, { only });
        await navigator.clipboard.writeText(`\`\`\`mermaid\n${text}\`\`\`\n`);
      } else {
        const api = readOnlyView ? b.diagramApi : b.api;
        const drawn = readOnlyView ? b.diagramElements(title) : b.exportElements(title);
        const opts = {
          elements: exportLook === "clean" ? presentable(drawn, { fontFamily: FONT_FAMILY.Nunito }) : drawn,
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
    const b = sessionRef.current?.board;
    if (readOnlyDiagram) b?.drawDiagram(diagram, diagram === "uml" ? umlArg : focus?.flow);
    // A fresh board (start over, a replay) forgets the opened layer: open it again.
    else if (b && inside && !(b.focus?.explode && b.focus.layer === inside)) b.setFocus({ layer: inside, explode: true });
  });
  const [selLids, setSelLids] = useState(() => new Set()); // board selection, as logical ids
  const sentKeys = useRef(new Set());
  const diffTimer = useRef(null);
  const lastSel = useRef("");
  const scroller = useRef(null);

  useEffect(() => {
    if (!api || !whyApi || !timelineApi || !diagramApi) return;
    // Fresh session: clear UI state that belonged to the previous one (e.g. after a hot reload).
    setPhase(null);
    setDecisions([]);
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
      // Excalidraw measures its container after mount, so fit once it has real dimensions.
      timers.push(setTimeout(() => board.fit(), 150));
      // With an API key, wait for a task; otherwise play the scripted demo, as the tour on a first visit.
      // A first visit, key or not: the demo starts and the intro pops up over it (the tour).
      if (tourOffer) setAutoTour(true);
      else if (status.live) document.getElementById("ask")?.focus();
      else timers.push(setTimeout(() => s.startDemo({ fresh: true }), 700));
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      window.removeEventListener("pagehide", onHide);
      s.dispose();
    };
  }, [api, whyApi, timelineApi, diagramApi]);

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
    let fresh = all.filter((d) => !sentKeys.current.has(d.key));
    // A sticker goes to the agent as soon as it's on something; its answer pops up beside it.
    const stickers = fresh.filter((d) => d.kind === "sticker");
    if (stickers.length && s.mode !== "replay") {
      stickers.forEach((d) => sentKeys.current.add(d.key));
      s.sendEdits(stickers);
      fresh = fresh.filter((d) => d.kind !== "sticker");
    }
    setDecisions((prev) => (prev.map((d) => d.key).join() === fresh.map((d) => d.key).join() ? prev : fresh));
    s.board.refreshMarkers();
    s.board.tidyAnswers();
  }, []);

  // Light up these logical ids' entries in Plan details, and bring the first into view.
  const showLinked = useCallback((lids) => {
    setSelLids(new Set(lids));
    if (lids[0]) reveal(document.getElementById(`plan-${lids[0]}`));
  }, []);
  // From the Timeline, the review or Plan details: that line of the run (a sentence, your message,
  // a command) at the top of the panel.
  const showSaid = useCallback((id) => {
    setQuote(id);
    scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  // From the review card: what it said, the diff, or a card in Plan details.
  const goReview = (lid) => {
    if (!lid) return;
    reviewOpens.current++;
    const [k, v] = lid.split(/:(.*)/s);
    if (k === "sentence") return showSaid(v);
    if (k === "code") return reveal(document.getElementById(v ? `plan-code:${v}` : "plan-code"), "start");
    focusInPlan([lid]);
  };
  // From the header or the Why canvas: Plan details, at it.
  const focusInPlan = useCallback(
    (lids) => {
      if (lids.length) showLinked(lids);
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
        if (lids.some((l) => l.startsWith("node:"))) partOpens.current++;
        showLinked(lids);
        setBoardSel(lids);
        // Restyling what the board draws does nothing (it's redrawn), so its style panel would only cover
        // the board; a sticker means what it says, whatever its colors.
        const scene = sel ? new Map(s.board.api.getSceneElements().map((e) => [e.id, e])) : null;
        setOwnSel(!!sel && sel.split(",").every((id) => s.board.known.has(id) || !!scene.get(id)?.customData?.sticker));
        // A selected decision fans out its alternatives: drag one onto it to pick it.
        if (s.mode !== "replay") s.board.onSelect(sel ? sel.split(",") : [], appState);
      }

      // Throttled: the agent changes the scene constantly, so a pure debounce would never fire.
      if (!diffTimer.current) diffTimer.current = setTimeout(runDiff, 500);
    },
    [runDiff, showLinked],
  );
  // The pointer over the board: a ◇ under it shows its ties (Board.hoverAt), but not mid-drag, so
  // nothing redraws under a move. Stable, like onChange.
  const onPointerUpdate = useCallback(({ pointer, button }) => button !== "down" && sessionRef.current?.board.hoverAt(pointer.x, pointer.y), []);

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
  // What the panel shows of the log (Said): its words since the last thing you typed (not the task
  // itself), the latest error since you last did anything, and the line you opened.
  const lastYou = messages.findLastIndex((m) => m.role === "you");
  const lastChat = messages.findLastIndex((m) => m.role === "you" && m.kind === "chat");
  const answering = lastChat > 0 && lastChat === lastYou ? messages[lastChat] : null;
  const reply = answering ? messages.slice(lastChat + 1).flatMap((m) => (m.role === "agent" ? m.items.filter((it) => it.type === "s" && it.text.trim()) : [])) : [];
  const notice = messages.slice(lastYou + 1).findLast((m) => m.role === "notice");
  const quoted = quote && (messages.find((m) => m.id === quote && m.role === "you") ?? messages.flatMap((m) => m.items).find((it) => it.id === quote));
  const close = (id) => setClosed((c) => new Set(c).add(id));
  // Once the run is over: what needs a look.
  const finishedRun = !!s && messages.length > 0 && (s.mode === "replay" ? !s.state.replaying : s.mode === "agent" ? !!s.result && !s.answered && !s.state.busy : s.board.model.phase === "complete" && !s.state.busy);
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
  // Something new at the top of the panel (the review, a reply, an error): scroll up to it.
  const fresh = `${!!review}|${answering?.id ?? ""}|${notice?.id ?? ""}`;
  useEffect(() => {
    if (fresh !== "false||") scroller.current?.scrollTo({ top: 0, behavior: "smooth" });
  }, [fresh]);
  // The review, marked on the board in red pen: the part behind a false claim, a failed check.
  const pen = review ? penMarks({ model: s.board.model, claims: [...receipts].map(([id, r]) => ({ id, ...r })), ownerOf: (f) => s.board.ownerOf(f) }) : null;
  useEffect(() => {
    const b = sessionRef.current?.board;
    if (!b) return;
    if (pen) b.showPen(pen);
    else b.hidePen();
  });
  const project = s?.board.model.project;
  const agentMode = s?.mode === "agent";
  const replayMode = s?.mode === "replay";
  const awaitingTask = agent?.live && messages.length === 0;
  useEffect(() => {
    if (!awaitingTask || !repo.trim()) return setRepoBoard(null);
    let live = true;
    const timer = setTimeout(() => getRepoBoard(repo.trim()).then((b) => live && setRepoBoard(b)).catch(() => live && setRepoBoard(null)), 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [repo, awaitingTask]);
  const reviewing = !!s?.awaitingApproval;
  const permission = replayMode ? null : s?.permission;
  const recording = s?.recording;
  const lastRun = s?.runId ?? s?.parent?.id; // the run on the board, live or kept

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
    setQuote(null);
    setClosed(new Set());
  };
  const runDemo = () => {
    if (!s) return;
    clearUi();
    s.startDemo();
  };
  // A repo with a saved board carries on from it; one without is mapped first (the server does that).
  const startTask = async (brief) => {
    if (!s || !brief.trim()) return;
    clearUi();
    setDraft("");
    if (repoBoard?.saved && (await s.openRepoBoard(repo.trim()))) return s.carryOn({ text: brief.trim() });
    s.startAgent({ repo: repo.trim(), brief: brief.trim() });
  };
  const mapRepo = () => {
    if (!s) return;
    clearUi();
    s.startAgent({ repo: repo.trim(), brief: "", map: true });
  };
  const openSavedBoard = () => {
    if (!s) return;
    clearUi();
    s.openRepoBoard(repo.trim());
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
    if (hit.msg) return showSaid(hit.msg);
    const act = hit.tool && messages.flatMap((m) => m.items).find((it) => it.type === "act" && it.toolUseIds.includes(hit.tool));
    if (act) return showSaid(act.id);
    focusInPlan(hit.lids);
  };
  const sendEdits = () => {
    if (!s || !decisions.length) return;
    decisions.forEach((d) => sentKeys.current.add(d.key));
    s.sendEdits(decisions);
    setDecisions([]);
    setGlassUp(true);
  };
  // Approve the plan; any pending board edits go along and get folded in before building.
  const approve = () => {
    if (!s) return;
    decisions.forEach((d) => sentKeys.current.add(d.key));
    s.approve(decisions);
    setDecisions([]);
    setGlassUp(true);
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
    else if (s.parent) replay(s.parent.id); // a kept board: watch the run it came from again
    else if (agentMode && s.brief) startTask(s.brief);
    else runDemo();
  };
  // Done: stop replaying and keep this board, to carry on from it (a living document).
  const keepBoard = () => {
    if (!s) return;
    if (tour) exitTour();
    s.keepBoard({ live: !!agent?.live });
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
    history.current.push(text);
    if (awaitingTask) return startTask(text);
    s.sendChat(text);
    setDraft("");
  };
  // The whole log, as Markdown: what you asked and changed, what it said and did, the review.
  const downloadLog = () => {
    if (!s || !messages.length) return;
    const title = project || s.brief || "Run";
    const when = new Date(recording?.startedAt ?? Date.now()).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
    const md = logMarkdown({ title, mode: modeLabel, when, messages, receipts, review: review || null });
    const file = title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "run";
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: `${file}-log.md` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
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
  else if (s?.carriesOn) status = "Carry on: edit the board or type below. It starts a new session from this board.";
  else if (s?.result) status = `${s.mapReady ? "Map ready" : s.answered ? "Answered" : "Done"}${s.result.cost != null ? ` · $${s.result.cost.toFixed(2)}` : ""}${s.result.turns ? ` · ${s.result.turns} turns` : ""}`;
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
          text: "Nothing here reaches an agent. On the Timeline tab, click any moment to jump there. Done keeps this board, so you can carry on from it.",
        }
      : awaitingTask
        ? {
            n: 1,
            title: "Tell the agent what to build",
            text: "Pick an example, or describe your own task in the box at the bottom. It reads the code and draws a plan on the board, then waits for your OK. Nothing in your repo changes before that.",
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
            : s?.answered && !st.busy && !s.gate
              ? s.mapReady
                ? {
                    n: 1,
                    title: "The map is ready",
                    text: "The board shows the code as it is today, and it's saved in the repo. Ask about it, or describe a change in the box at the bottom: the agent plans a change on this map.",
                  }
                : {
                    n: 1,
                    title: "It answered",
                    text: "Its answer is at the top of the panel, and the board shows what it's about. Nothing changed. Ask more, or describe a change: it plans it on this board first.",
                  }
            : reviewing
              ? {
                  n: 2,
                  title: "Check the plan",
                  text: `The drawing is its plan. Nothing is built until you approve.${openQuestions ? ` It left ${plural(openQuestions, "question")} for you in Plan details.` : ""} Click a ◇ to see other options; pull the glass down to change the drawing.`,
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
    const onBoard = (t) => !!t?.closest?.(".canvas.arch") && !t.closest(".explain, .board-submit, button, input, textarea, select");
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
    partOpens: partOpens.current,
    view: boardView,
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
  // Start from an empty board: the intro starts the demo behind it, the next step speeds it up.
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
  // A step's action, the first time it's reached: the intro starts the demo, the plan step plays it at 2×.
  const prevTour = useRef(null);
  useEffect(() => {
    const prev = prevTour.current;
    prevTour.current = tour;
    if (!isFresh(prev, tour)) return;
    if (stepOf(tour).enter === "demo") {
      runDemo();
      setSpeedTo(1);
    }
    if (stepOf(tour).enter === "fast") setSpeedTo(2);
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
    : agentMode && st.busy ? "Stop the agent" : st.paused ? "Resume" : st.busy ? "Pause" : reviewing ? "Continue: approve the plan" : s?.parent ? "Replay the run this board came from" : agentMode ? "Run the task again" : "Replay";
  const modeLabel = replayMode ? "Replay" : agentMode || awaitingTask ? "Agent" : "Demo";
  // Which agent, where its model runs (Claude's), its model and effort (when set).
  const claudeSdk = !agent?.engine || agent.engine === "Claude Agent SDK";
  const modeTitle = agent?.live
    ? [agent.engine ?? "Claude Agent SDK", claudeSdk && (agent.provider ?? "Anthropic API"), agent.model, agent.effort && `effort ${agent.effort}`].filter(Boolean).join(" · ")
    : "Scripted demo. To run a real agent, set AGENT_KEY (Anthropic), AGENT_URL (any other model) or AGENT_ENGINE (another coding agent) in .env.local and restart the dev server.";

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
            live={!!agent?.live}
            onOwnTask={() => leaveTour("task")}
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
              {messages.length > 0 && (
                <button className="icon" onClick={downloadLog} title="Download the log: what it said and did, and what you sent it (Markdown)" aria-label="Download the log">
                  <Icon name="download" />
                </button>
              )}
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
          {tour || !agent || autoTour ? null : (
            tips && coach && <Coach c={coach} onHide={() => showTipsPref(false)} onTour={takeTour} />
          )}
        </header>

        <div className="transcript" ref={scroller}>
          {messages.length > 0 && s && (
            <>
              {notice && !closed.has(notice.id) && (
                <Said head="⚠ It stopped" tone="bad" onClose={() => close(notice.id)}>
                  <p>{notice.text}</p>
                </Said>
              )}
              {quoted && (
                <Said head={quoted.type === "s" ? "It said" : quoted.type === "act" ? "It ran" : "You"} onClose={() => setQuote(null)}>
                  <SaidLine line={quoted} receipts={receipts} />
                </Said>
              )}
              {reply.length > 0 && !closed.has(answering.id) && (
                <Said head="Its reply" onClose={() => close(answering.id)}>
                  <Sentences key={answering.id} items={reply} receipts={receipts} />
                </Said>
              )}
              {review && <ReviewCard rows={review} onGo={goReview} />}
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
                onAnswer={(q, text) => s.answerQuestion(q, text)}
                onConfirm={(q) => s.confirmAssumption(q)}
                onCorrect={(q) => prefill(`About A${q.n} (${q.text}): `)}
                onReply={(p) => prefill(`About “${clip(p.text, 70)}”: `)}
                onShow={showSaid}
              />
            </>
          )}
          {messages.length === 0 &&
            (awaitingTask ? (
              <div className="empty">
                <p className="hand">What should the agent do?</p>
                <p>
                  A real coding agent works in the repo below. Ask it about the code and it answers, showing what it means on the
                  board. Ask for a change and it draws its plan and waits for you; once you approve, it builds and tests while the board
                  keeps up. Edit the board at any point to steer it.
                </p>
                <RepoField value={repo} onChange={setRepo} />
                {repoBoard?.file &&
                  (repoBoard.saved ? (
                    <p className="note repo-board">
                      ▣ This repo has a saved board (<code>{repoBoard.file}</code>): <b>{repoBoard.saved.project || "untitled"}</b>, {repoBoard.saved.runs} run{repoBoard.saved.runs === 1 ? "" : "s"}
                      {repoBoard.saved.savedAt ? `, saved ${new Date(repoBoard.saved.savedAt).toLocaleDateString(undefined, { dateStyle: "medium" })}` : ""}. Your task carries on from it.{" "}
                      <button className="linkish" onClick={openSavedBoard}>
                        Open it
                      </button>
                    </p>
                  ) : repoBoard.error ? (
                    <p className="note repo-board">⚠ {repoBoard.error}</p>
                  ) : (
                    !repoBoard.missing && (
                      <p className="note repo-board">
                        No board saved in this repo yet, so the agent first maps the code as it is onto the board, then plans your task. The board is saved in the repo as <code>{repoBoard.file}</code>.{" "}
                        <button className="linkish" onClick={mapRepo}>
                          Just map it
                        </button>
                      </p>
                    )
                  ))}
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
                <p>Watch it plan, build, verify and ship a small app. Click any part afterwards to see what it changed.</p>
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
                {agent && !agent.live && <LiveSetup className="note" />}
                <SavedRuns recordings={recordings} onReplay={(id) => replay(id)} onOpen={(id) => replay(id, { instant: true })} />
              </div>
            ))}
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
                <button className="primary" onClick={keepBoard} title="Keep this board and carry on from it: edit it or type, and a new session starts from here">
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
              {agentMode && lastRun && (s?.result || s?.carriesOn) && (
                <span className="after-run">
                  <button className="linkish" onClick={() => replay(lastRun)}>
                    Replay this run
                  </button>
                  <a className="linkish" href={decisionsUrl(lastRun)} target="_blank" rel="noreferrer">
                    Decision log
                  </a>
                </span>
              )}
            </p>
          )}
          <form className="ask" onSubmit={sendChat} hidden={replayMode}>
            <input
              id="ask"
              value={draft}
              onChange={(e) => {
                history.current.reset();
                setDraft(e.target.value);
              }}
              onKeyDown={browseHistory}
              title="↑ and ↓ bring back what you typed before"
              placeholder={awaitingTask || s?.answered ? "Ask about the code, or describe a change…" : reviewing ? "Ask for changes to the plan…" : s?.carriesOn ? "What's next? A new session starts from this board…" : "Tell the agent something…"}
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
            {nodeCount > 0 && <span className="ct-count">{nodeCount}</span>}
          </button>
          <button role="tab" aria-selected={boardView === "why"} data-tour="why-tab" onClick={() => showView("why")} title="Each decision: its evidence, what it shapes, and the check that proves it">
            <span className="vs-diamond" aria-hidden="true" />
            Reasoning
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
                <div className="export-look" role="radiogroup" aria-label="How the SVG and PNG look">
                  {[
                    ["clean", "Clean", "Straight lines and a plain font, for slides and docs"],
                    ["sketch", "Sketch", "Hand-drawn, as on the board"],
                  ].map(([k, label, tip]) => (
                    <button key={k} role="radio" aria-checked={exportLook === k} className={exportLook === k ? "on" : ""} onClick={() => chooseExportLook(k)} title={tip}>
                      {label}
                    </button>
                  ))}
                </div>
                <button onClick={() => exportView("svg")}>Download SVG</button>
                <button onClick={() => exportView("png")}>Download PNG</button>
              </div>
            </details>
          )}
          {boardView === "board" && nodeCount > 0 && (
            <button className="lens-pin" onClick={pinView} disabled={pinned} title={pinned ? "This view is pinned already" : "Keep this view open in its own window, then pick another: see both at once"}>
              <span aria-hidden="true">+</span> Pin this view
            </button>
          )}
          <span className="ct-hint">
            {tour
              ? null
              : boardView === "why"
                ? "Evidence → decision → what it shapes → proof. Click a row to read it."
                : boardView === "timeline"
                  ? `How the decisions moved. ${replayMode ? "Click a moment to jump there." : "Click a mark to read it."}`
                  : inside
                    ? `The ${LAYERS.find((l) => l.key === inside)?.label} layer, opened up: what each part is made of. Whole system closes it.`
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
                <button key={d.key} className={`lens ${diagram === d.key ? "on" : ""}`} aria-pressed={diagram === d.key} onClick={() => chooseDiagram(d.key)} title={d.title}>
                  {d.label}
                </button>
              ))}
            </div>
            {diagram === "uml" && (
              // Which UML diagrams to show: all of them, or the ones ticked, stacked one under another.
              <div className="lens-group uml-pick" role="group" aria-label="UML diagrams to show">
                <span className="lens-label">Show</span>
                <label className="uml-box" title="Every UML diagram, one under another">
                  <input
                    type="checkbox"
                    checked={umlKinds.length === UML_KINDS.length}
                    ref={(el) => el && (el.indeterminate = umlKinds.length > 0 && umlKinds.length < UML_KINDS.length)}
                    onChange={(e) => chooseUml(e.target.checked ? UML_KINDS.map((u) => u.key) : [])}
                  />
                  All
                </label>
                {UML_KINDS.map((u) => (
                  <label key={u.key} className="uml-box" title={u.title}>
                    <input type="checkbox" checked={umlKinds.includes(u.key)} onChange={(e) => chooseUml(e.target.checked ? [...umlKinds, u.key] : umlKinds.filter((k) => k !== u.key))} />
                    {u.label}
                  </label>
                ))}
              </div>
            )}
            <div className="lens-group" role="group" aria-label="Zoom into a layer">
              <span className="lens-label">Zoom into</span>
              <button className={`lens ${!inside ? "on" : ""}`} aria-pressed={!inside} onClick={() => chooseInside(null)} title="The whole system: every part, closed">
                Whole system
              </button>
              {openableLayers(model).map((l) => (
                <button key={l.key} className={`lens ${inside === l.key ? "on" : ""}`} aria-pressed={inside === l.key} onClick={() => chooseInside(l.key)} title={`Open the ${l.label} layer in place: what its parts are made of`}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {editable && (
          // Always there while the plan is editable, glass up or down, so neither the glass switch
          // (first, a fixed width) nor the board below moves when you flip it. A tool pressed with
          // the glass up pulls it down first, like Rename on a card.
          <div className="edit-bar" role="toolbar" aria-label="Edit the plan">
            <button
              className={`glass-toggle ${glassUp ? "up" : "down"}`}
              data-tour="glass"
              aria-pressed={!glassUp}
              onClick={glassUp ? lowerGlass : raiseGlass}
              title={glassUp ? "Pull the glass down to move, rename, remove or add things, then Submit" : "Back to looking: your changes stay in the list until you Submit"}
            >
              <span aria-hidden="true">{glassUp ? "⇣" : "⇡"}</span> {glassUp ? "Pull down to edit" : "Glass back up"}
            </button>
            <span className="eb-label">Edit the plan:</span>
            <button onClick={() => (lowerGlass(), useTool("selection", null))} title="Select, move and double-click things on the board">
              <ToolIcon name="select" />
              Select
            </button>
            <button onClick={() => (lowerGlass(), toolRename())} title="Rename the selected part (or double-click any name)">
              <ToolIcon name="rename" />
              Rename
            </button>
            <button onClick={() => (lowerGlass(), useTool("rectangle", "Draw a box on the board, then type its name."))} title="Ask for a new part: draw a box and name it">
              <ToolIcon name="add" />
              Add a part
            </button>
            <button onClick={() => (lowerGlass(), useTool("arrow", "Drag from one part to another."))} title="Ask for a new connection: draw an arrow between two parts">
              <ToolIcon name="connect" />
              Connect
            </button>
            <button onClick={() => (lowerGlass(), toolRemove())} title="Remove the selected part or connection, or reject the selected ◇ decision">
              <ToolIcon name="remove" />
              Remove
            </button>
            <button onClick={() => (lowerGlass(), useTool("text", "Click an empty spot and type a note, like “English PDFs only”."))} title="Add a note that narrows what it builds">
              <ToolIcon name="note" />
              Add a note
            </button>
            <button className={`eb-tools ${tools ? "on" : ""}`} aria-pressed={tools} onClick={() => (tools || lowerGlass(), toggleTools())} title="Show or hide Excalidraw's full drawing tools">
              <ToolIcon name="tools" />
              Drawing tools
            </button>
          </div>
        )}
        <div className="canvases" data-tour="board">
          <div
            className={`canvas arch ${boardView === "board" && !readOnlyView ? "on" : ""} ${ownSel ? "own-sel" : ""} ${tools ? "tools-on" : "tools-off"}`}
            role="tabpanel"
            aria-label="Architecture"
            onPointerLeave={() => s?.board.hoverAt(null)}
          >
            <Excalidraw excalidrawAPI={setApi} initialData={INITIAL_DATA} onChange={onChange} onPointerUpdate={onPointerUpdate} UIOptions={UI_OPTIONS} />
            {boardView === "board" && !readOnlyView && model && <DecisionPulse api={api} ids={busyDecisions(model)} />}
            {editable && (
              <div className={`glass ${glassUp ? "up" : "down"}`} aria-hidden="true">
                <span className="glass-glint" />
              </div>
            )}
            {editable && <StickerTray onDropped={lowerGlass} />}
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
                onAnswer={(q, text) => s.answerQuestion(q, text)}
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
            aria-label={diagram === "er" ? "Data model" : "Sequence"}
          >
            <Excalidraw excalidrawAPI={setDiagramApi} initialData={INITIAL_DATA} UIOptions={WHY_UI_OPTIONS} viewModeEnabled theme={theme} />
            {model && diagram === "er" && !Object.keys(model.tables ?? {}).length && (
              <p className="canvas-empty">The data model appears here when the agent describes its tables: columns, keys and how they relate.</p>
            )}
            {model && diagram === "sequence" && !Object.keys(model.flows ?? {}).length && (
              <p className="canvas-empty">A flow appears here as a sequence diagram once the agent maps one: who calls whom, in order.</p>
            )}
          </div>
          <div
            className={`canvas ${boardView === "why" ? "on" : ""}`}
            role="tabpanel"
            aria-label="Reasoning"
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
          {s &&
            pins.map((v) => (
              <PinnedView
                key={v.id}
                v={v}
                s={s}
                theme={theme}
                onClose={() => setPins((ps) => ps.filter((p) => p.id !== v.id))}
                onChange={(d) => setPins((ps) => ps.map((p) => (p.id === v.id ? { ...p, ...d } : p)))}
              />
            ))}
        </div>
        {boardView === "board" && (diagram === "pictures" || readOnlyDiagram) && nodeCount > 0 && <BoardKey model={model} layersOnly={readOnlyDiagram} />}
      </main>
    </div>
  );
}
