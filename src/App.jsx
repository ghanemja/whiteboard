import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw, viewportCoordsToSceneCoords } from "@excalidraw/excalidraw";
import { Board, PHASES } from "./engine/board";
import PhaseHeader from "./PhaseHeader";
import { Session } from "./engine/session";
import { fmt } from "./engine/timeline";
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

const GLYPH = { rename: "✎", remove: "✕", add: "+", link: "→", unlink: "✂", note: "✐", reject: "◇" };

function describe(d) {
  switch (d.kind) {
    case "rename": return <>Rename <b>{d.from}</b> → <b>{d.to}</b></>;
    case "remove": return <>Remove <b>{d.name}</b></>;
    case "add": return <>Add <b>{d.name}</b></>;
    case "link": return <>Connect <b>{d.fromName}</b> → <b>{d.toName}</b></>;
    case "unlink": return <>Disconnect <b>{d.fromName}</b> → <b>{d.toName}</b></>;
    case "note": return <>Note “{d.text}”</>;
    case "reject": return <>Reject <b>{d.label}</b> ({d.title})</>;
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

function EditList({ decisions }) {
  return (
    <ul className="edits">
      {decisions.map((d) => (
        <li key={d.key}>
          <span className={`g g-${d.kind}`}>{GLYPH[d.kind]}</span>
          <span>{describe(d)}</span>
        </li>
      ))}
    </ul>
  );
}

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

function AgentMessage({ m, phase, linked, onHover, onFocus }) {
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

  return (
    <div className="msg agent">
      <div className="who">
        <span className="avatar">A</span>Agent
        {m.streaming && <span className="typing">working…</span>}
      </div>
      {blocks.map((b, bi) => {
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
        return (
          <p key={bi}>
            {b.sentences.map((s) => (
              <span key={s.id}>
                <span
                  id={s.id}
                  className={["s", s.live && "live", linked.has(s.id) && "linked", s.ops > 0 && "has-ops"].filter(Boolean).join(" ")}
                  title={s.ops > 0 && !s.live ? "Hover to see what this changed on the board; click to jump there" : undefined}
                  onMouseEnter={() => s.ids.size && onHover([...s.ids])}
                  onMouseLeave={() => onHover([])}
                  onClick={() => s.ids.size && onFocus([...s.ids])}
                >
                  <Rich text={s.text} />
                </span>{" "}
              </span>
            ))}
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

const STATUS_DOT = { planned: "#adb5bd", building: "#e8590c", built: "#1971c2", verified: "#2f9e44", failed: "#e03131", live: "#6741d9" };
const KIND_WORD = { client: "client", service: "service", data: "data store", external: "external API", queue: "queue", test: "tests", user: "user" };

// The development plan as a document: goal, architecture, connections, the reasoning
// chain of decisions, and the steps. Every item is linked to its picture on the board.
function PlanView({ model, phase, selected, onHover, onFocus, onChallenge, canChallenge }) {
  const nodes = Object.values(model.nodes);
  const edges = Object.values(model.edges);
  const decisions = Object.values(model.decisions).sort((a, b) => a.n - b.n);
  const tasks = Object.values(model.tasks);
  const name = (id) => model.nodes[id]?.name ?? id;
  const dLabel = (id) => (model.decisions[id] ? `D${model.decisions[id].n}` : id);
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

      {nodes.length > 0 && (
        <section>
          <h3>Architecture</h3>
          {nodes.map((n) => (
            <div key={n.id} {...link(`node:${n.id}`)} className={["plan-card", selected.has(`node:${n.id}`) && "linked"].filter(Boolean).join(" ")}>
              <div className="pc-head">
                <span className="pc-dot" style={{ background: STATUS_DOT[n.status] }} title={n.status} />
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
                {e.via && <span className="chip">{e.via}</span>}
                {e.api && <code>{e.api}</code>}
              </li>
            ))}
          </ul>
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
                    {d.proof === "pass" ? "✓ proven" : d.proof === "fail" ? "✗ failed" : "unchecked"}
                  </span>
                )}
                <span className={`dstate ds-${d.state}`}>{d.state}</span>
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
                    <dd>{d.over.join(" · ")}</dd>
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
  const [speed, setSpeed] = useState(1);
  const [draft, setDraft] = useState("");
  const [repo, setRepo] = useState("");
  const [agent, setAgent] = useState(null); // { live, model, effort, defaultRepo } from the dev server
  const [recordings, setRecordings] = useState([]);
  const [tab, setTab] = useState("activity"); // "activity" | "plan"
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
    const board = new Board(api, { whyApi, timelineApi, onPhase: setPhase });
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
  const modeTitle = agent?.live ? `Claude Agent SDK · ${agent.model} · effort ${agent.effort}` : "Scripted demo. Set ANTHROPIC_API_KEY and restart the dev server to run a real agent.";

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
            </button>
            <button role="tab" aria-selected={tab === "plan"} className="tab" onClick={() => setTab("plan")}>
              Plan
              {Object.keys(s?.board.model.decisions ?? {}).length > 0 && (
                <span className="tab-count" title="Decisions">◇ {Object.keys(s.board.model.decisions).length}</span>
              )}
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
              canChallenge={!replayMode}
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
                <p>
                  Change anything on the board first: double-click a name to rename it, delete a component, or draw an arrow. You can
                  also ask for changes below. Nothing gets built until you approve.
                </p>
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
              <button className="primary" onClick={sendEdits}>
                Send to agent{st.busy ? " when it finishes" : ""}
              </button>
            </div>
          ) : awaitingTask ? null : (
            <p className="hint">
              <b>Steer from the board.</b> Double-click a name to rename it, draw an arrow between two components, or delete one.
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
          <span className="ct-hint">
            {boardView === "why"
              ? "Evidence → decision → what it shapes → proof. Click a row to read it."
              : boardView === "timeline"
                ? `How the decisions moved. ${replayMode ? "Click a moment to jump there." : "Click a mark to read it."}`
                : "Edit it to steer: rename, connect, delete, or draw a box."}
          </span>
        </div>
        <div className="canvases">
          <div className={`canvas ${boardView === "board" ? "on" : ""}`} role="tabpanel" aria-label="Architecture">
            <Excalidraw excalidrawAPI={setApi} initialData={INITIAL_DATA} onChange={onChange} UIOptions={UI_OPTIONS} />
            {model && !nodeCount && <p className="canvas-empty">The architecture appears here as the agent plans: each component, what it connects to, and its decisions.</p>}
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
