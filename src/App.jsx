import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, exportToBlob, exportToSvg, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { Board, PHASES } from "./engine/board";
import PhaseHeader from "./PhaseHeader";
import { Session } from "./engine/session";
import { AREAS, areaOf, fmt } from "./engine/timeline";
import { LAYERS, layerOf, tagCase, toMermaid, toSequence } from "./engine/views";
import { buildReview } from "./engine/review";
import { decisionsUrl, getAgentStatus, listRecordings } from "./agent/live";

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

const GLYPH = { rename: "✎", remove: "✕", add: "+", link: "→", unlink: "✂", note: "✐", reject: "◇", choose: "⇄" };

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
};
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
const RC_SAID = { ok: "Backed by the record", unknown: "Nothing in the record says either way", bad: "The record contradicts this" };
function Receipt({ r }) {
  const bad = r.claims.filter((c) => c.verdict === "bad");
  return (
    <span className={`rcpt rc-${r.verdict}`} title={`${RC_SAID[r.verdict]}:\n${r.claims.map((c) => `${RC[c.verdict]} “${c.text}”: ${c.why}`).join("\n")}`}>
      {RC[r.verdict]}
      {bad.length > 0 && <span className="rcpt-why">{bad.map((c) => c.short ?? c.why).join(", ")}</span>}
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
            {todo}
          </span>
        )}
      </div>
      <ul>
        {rows.map((r) => (
          <li key={r.key} className={`rv rv-${r.tone}`}>
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
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onChallenge(d);
                  }}
                >
                  Challenge this
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

export default function App() {
  const [api, setApi] = useState(null);
  const [whyApi, setWhyApi] = useState(null);
  const [timelineApi, setTimelineApi] = useState(null);
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
  // How components are drawn: pictograms or C4 boxes. Remembered per browser.
  const [drawStyle, setDrawStyle] = useState(() => {
    try {
      return localStorage.getItem("wb-style") === "c4" ? "c4" : "pictures";
    } catch {
      return "pictures";
    }
  });
  const styleRef = useRef(drawStyle);
  const chooseStyle = (v) => {
    styleRef.current = v;
    setDrawStyle(v);
    sessionRef.current?.board.setStyle(v);
    try {
      localStorage.setItem("wb-style", v);
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
    const flow = focus?.flow && m.flows[focus.flow];
    const layer = focus?.layer && LAYERS.find((l) => l.key === focus.layer);
    const view = flow ? `Flow: ${flow.name}` : layer ? `${layer.label} layer` : drawStyle === "c4" ? "Container view" : "Architecture";
    const title = [m.project, view].filter(Boolean).join(" · ");
    const file = title.replace(/[^\w]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "board";
    try {
      if (kind === "mermaid") {
        const only = layer && new Set(Object.values(m.nodes).filter((n) => [layer.key, null].includes(layerOf(n))).map((n) => n.id));
        await navigator.clipboard.writeText(`\`\`\`mermaid\n${flow ? toSequence(m, flow) : toMermaid(m, { only })}\`\`\`\n`);
      } else {
        const opts = {
          elements: b.exportElements(title),
          appState: { ...b.api.getAppState(), exportBackground: true, viewBackgroundColor: "#ffffff", exportWithDarkMode: false, exportScale: 2 },
          files: b.api.getFiles(),
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
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const [selLids, setSelLids] = useState(() => new Set()); // board selection, as logical ids
  const sentKeys = useRef(new Set());
  const diffTimer = useRef(null);
  const lastSel = useRef("");
  const scroller = useRef(null);
  const stick = useRef(true);

  useEffect(() => {
    if (!api || !whyApi || !timelineApi) return;
    // Fresh session: clear UI state that belonged to the previous one (e.g. after a hot reload).
    setPhase(null);
    setDecisions([]);
    setLinked(new Set());
    setSpeed(1);
    setFocus(null);
    const board = new Board(api, { whyApi, timelineApi, onPhase: setPhase, style: styleRef.current });
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
      // With an API key, wait for a task; otherwise play the scripted demo.
      if (!status.live) timers.push(setTimeout(() => s.startDemo({ fresh: true }), 700));
      else document.getElementById("ask")?.focus();
    });
    return () => {
      alive = false;
      timers.forEach(clearTimeout);
      window.removeEventListener("pagehide", onHide);
      s.dispose();
    };
  }, [api, whyApi, timelineApi]);

  // Keep the transcript pinned to the bottom while streaming, unless the user scrolled up.
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current && tabRef.current === "activity") el.scrollTop = el.scrollHeight;
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
        showLinked(s.board.logicalIdsFor(sel ? sel.split(",") : []));
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
    stick.current = true;
  };
  // Approve the plan; any pending board edits go along and get folded in before building.
  const approve = () => {
    if (!s) return;
    decisions.forEach((d) => sentKeys.current.add(d.key));
    s.approve(decisions);
    setDecisions([]);
    stick.current = true;
  };
  const togglePlay = () => {
    if (!s) return;
    if (replayMode) s.toggleReplay();
    else if (agentMode && st.busy) s.stop();
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
  else if (st.paused) status = "Paused";
  else if (st.thinking) status = st.thinkingFor >= 2 ? `Working… ${st.thinkingFor}s` : "Working…";
  else if (st.busy) status = s.caption ? `${s.caption}…` : "Working…";
  else if (awaitingTask) status = "Pick a repo and describe a task";
  else if (reviewing) status = "Plan ready. Review it on the board, then approve.";
  else if (decisions.length) status = "Your board changes are ready to send";
  else if (s?.result) status = `Done${s.result.cost != null ? ` · $${s.result.cost.toFixed(2)}` : ""}${s.result.turns ? ` · ${s.result.turns} turns` : ""}`;
  else if (phase === "complete") status = "Shipped. Edit the board to steer the next round.";
  else if (s && messages.length) status = "Idle";

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
      <aside className="agent">
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
            </div>
          </div>
          <div className={`status ${st.playing && !permission ? "on" : ""}`} aria-live="polite">
            <span className="dot" />
            <span className="caption">{status}</span>
          </div>
        </header>

        {messages.length > 0 && (
          <div className="tabs" role="tablist" aria-label="Panel view">
            <button role="tab" aria-selected={tab === "activity"} className="tab" onClick={() => setTab("activity")}>
              Activity
              {contradicted > 0 && (
                <span className="tab-count bad" title={`${contradicted} thing${contradicted === 1 ? "" : "s"} the agent said that the record contradicts`}>
                  ✗ {contradicted}
                </span>
              )}
            </button>
            <button role="tab" aria-selected={tab === "plan"} className="tab" onClick={() => setTab("plan")}>
              Plan
              {Object.keys(s?.board.model.decisions ?? {}).length > 0 && (
                <span className="tab-count" title="Decisions">◇ {Object.keys(s.board.model.decisions).length}</span>
              )}
              {openQuestions > 0 && (
                <span className="tab-count ask" title={`${openQuestions} open question${openQuestions === 1 ? "" : "s"} or assumption${openQuestions === 1 ? "" : "s"} for you`}>
                  ? {openQuestions}
                </span>
              )}
            </button>
            {tab === "activity" && (
              <button className={`skim ${skim ? "on" : ""}`} aria-pressed={skim} onClick={toggleSkim} title="Skim: hide the narration, keep what drew on the board, made a claim, asked you something or assumed something">
                Skim
              </button>
            )}
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
                <button className="linkish" onClick={runDemo}>
                  Or watch the scripted demo
                </button>
                <SavedRuns recordings={recordings} onReplay={(id) => replay(id)} onOpen={(id) => replay(id, { instant: true })} />
              </div>
            ) : (
              <div className="empty">
                <p className="hand">The board fills in as the agent works.</p>
                <p>Watch it plan, build, verify and ship a small app. Hover any sentence afterwards to see what it changed.</p>
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
                onHover={(ids) => s?.setHover(ids)}
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
            <div className="permit" role="alertdialog" aria-label="Permission request">
              <div className="gh">{permission.tool === "Bash" ? "Run this command?" : `Use ${permission.tool}?`}</div>
              <pre className="cmd">{permission.detail}</pre>
              {permission.description && <p>{permission.description}</p>}
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
                  Allow
                </button>
              </div>
            </div>
          ) : reviewing ? (
            <div className="gate" role="region" aria-label="Plan review">
              <div className="gh">
                <span className="pause" aria-hidden="true">⏸</span>
                Plan ready for review
              </div>
              {decisions.length > 0 ? (
                <EditList decisions={decisions} />
              ) : (
                <p>Edit the board (rename, connect, delete, or select a ◇ to pick another option) or type below. Nothing is built until you approve.</p>
              )}
              <div className="gate-actions">
                {decisions.length > 0 && (
                  <button className="secondary" onClick={sendEdits} title="The agent updates the plan and asks again">
                    Revise plan
                  </button>
                )}
                <button className="primary" onClick={approve}>
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
              <b>Steer from the board:</b> rename, connect, delete, or select a ◇ to pick another option. Then Submit.
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
          <button role="tab" aria-selected={boardView === "board"} onClick={() => showView("board")} title="The components and how they connect. Edit it to steer the agent.">
            <span className="ct-icon" aria-hidden="true" />
            Architecture
            {nodeCount > 0 && <span className="ct-count">{nodeCount}</span>}
          </button>
          <button role="tab" aria-selected={boardView === "why"} onClick={() => showView("why")} title="Each decision: its evidence, what it shapes, and the check that proves it">
            <span className="vs-diamond" aria-hidden="true" />
            Why
            {allDecisions.length > 0 && <span className="ct-count" title="Decisions">{allDecisions.length}</span>}
            {(proofCount("pass") > 0 || proofCount("fail") > 0) && (
              <span className="ct-proofs" title={`${proofCount("pass")} proven, ${proofCount("fail")} failed, ${proofCount(null)} not checked yet`}>
                {proofCount("pass") > 0 && <span className="pf-pass">✓{proofCount("pass")}</span>}
                {proofCount("fail") > 0 && <span className="pf-fail">✗{proofCount("fail")}</span>}
              </span>
            )}
          </button>
          <button role="tab" aria-selected={boardView === "timeline"} onClick={() => showView("timeline")} title="How the decisions moved over the run: what changed, when, and because of what">
            <span className="tl-icon" aria-hidden="true" />
            Timeline
            {hasTimeline && <span className="ct-count" title="How long the run took">{fmt(tl.duration)}</span>}
            {tl?.changes > 0 && (
              <span className="ct-changes" title={`${tl.changes} decision change${tl.changes === 1 ? "" : "s"}`}>
                ◆{tl.changes}
              </span>
            )}
          </button>
          {boardView === "board" && (
            <span className="style-toggle" role="group" aria-label="Drawing style">
              <button aria-pressed={drawStyle === "pictures"} onClick={() => chooseStyle("pictures")} title="Pictograms">
                Pictures
              </button>
              <button aria-pressed={drawStyle === "c4"} onClick={() => chooseStyle("c4")} title="C4 model: containers and how they connect">
                C4
              </button>
            </span>
          )}
          {boardView === "board" && nodeCount > 0 && (
            <select
              className="focus-pick"
              value={focus?.layer ? `layer:${focus.layer}` : focus?.flow ? `flow:${focus.flow}` : ""}
              onChange={(e) => {
                const [k, v] = e.target.value.split(":");
                chooseFocus(k ? { [k]: v } : null);
              }}
              aria-label="Show"
              title="Show one layer, or one flow's steps in order"
            >
              <option value="">All</option>
              <optgroup label="Layers">
                {LAYERS.filter((l) => Object.values(model.nodes).some((n) => layerOf(n) === l.key)).map((l) => (
                  <option key={l.key} value={`layer:${l.key}`}>
                    {l.label}
                  </option>
                ))}
              </optgroup>
              {Object.keys(model.flows).length > 0 && (
                <optgroup label="Flows">
                  {Object.values(model.flows).map((f) => (
                    <option key={f.id} value={`flow:${f.id}`}>
                      {f.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          )}
          {boardView === "board" && nodeCount > 0 && (
            <details className="export-menu">
              <summary title="Export what the board shows">{exported === "ok" ? "✓ Exported" : exported === "failed" ? "✗ Export failed" : "Export"}</summary>
              <div className="export-items">
                <button onClick={() => exportView("mermaid")} title={focus?.flow ? "Copy as a Mermaid sequence diagram" : "Copy as a Mermaid diagram in C4 notation (GitHub renders it)"}>
                  Copy Mermaid
                </button>
                <button onClick={() => exportView("svg")}>Download SVG</button>
                <button onClick={() => exportView("png")}>Download PNG</button>
              </div>
            </details>
          )}
          <span className="ct-hint">
            {boardView === "why"
              ? "Evidence → decision → what it shapes → proof. Click a row to read it."
              : boardView === "timeline"
                ? `How the decisions moved. ${replayMode ? "Click a moment to jump there." : "Click a mark to read it."}`
                : "Edit to steer: rename, connect, delete, draw. Select a ◇ to pick another option."}
          </span>
        </div>
        <div className="canvases">
          <div className={`canvas ${boardView === "board" ? "on" : ""} ${ownSel ? "own-sel" : ""}`} role="tabpanel" aria-label="Architecture">
            <Excalidraw excalidrawAPI={setApi} initialData={INITIAL_DATA} onChange={onChange} UIOptions={UI_OPTIONS} />
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
      </main>
    </div>
  );
}
