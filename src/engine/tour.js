// The guided tour: the scripted demo run as a lesson. Each step says what to do and why,
// points at it (a ring round a button or tab, or a circle on the board: the words stay on its card),
// and waits until the person has done it; then the tour moves on by itself.
//
// Pure, so it can be tested without a browser. App builds a context (`ctx`) from the session
// and its own state on every render (see tourContext's fields below) and feeds it to advance().
//
// ctx: {
//   started, stage, phase, gate,        the demo has begun; "planning" | "building"; board phase; plan waits for you
//   selected: [lid],                    what's selected on the Architecture board
//   explainUse,                         the explain card shows a decision's "Use this" options
//   edits,                              changes queued to send (board edits, stickers, picks)
//   answered,                           questions answered so far
//   permission, permissions,            a command prompt is showing; prompts answered so far
//   hovers,                             Chat & log sentences hovered (each lights up what it changed)
//   view, tab,                          board tab: "board" | "why" | "timeline"; panel tab: "activity" | "plan"
//   testCaused,                         a decision was changed because its check failed
//   finished, reviewOpens,              the run is over (review card); review rows / red pen opened
//   firstDecision, firstQuestion, building: ids to point at (or null)
// }
// A step's done(ctx, start) gets the context from when the step began, so "did something new"
// is a comparison. Steps also count as done once the run has moved past them (you approved
// before answering, say), so the tour never waits for something that can't happen any more.
//
// How a step is shown (App's spotlight): the screen dims, its dom targets stay lit with a ring
// and its card pops out beside the first one. Two optional hints are only about that picture:
// spot(ctx) lists more areas to leave lit (what you read or watch, no ring), and place:
// "center" puts the card in the middle of the screen.

const past = (c, phases) => phases.includes(c.phase);
const LATE = ["verification", "deployment", "complete"];
// The board's area on the page: lit whenever the tour points at something drawn on it.
export const BOARD = '[data-tour="board"]';

export const TOUR = [
  {
    id: "welcome",
    title: "Welcome! This is a run, start to finish",
    text: "A coding agent gets a task, plans it, builds it and tests it. Here it's a scripted demo: no API key, and it never touches your files. Three areas: (1) this panel, where it talks and you answer; (2) the board, its plan as a drawing; (3) the phase road: Plan → Build → Verify → Ship.",
    next: true,
    place: "center", // the three areas are the whole screen: the card sits in the middle, a ring round each
    dom: () => [
      { sel: '[data-tour="panel"]', label: "1 Panel" },
      { sel: '[data-tour="board"]', label: "2 Board" },
      { sel: '[data-tour="road"]', label: "3 Phase road" },
    ],
  },
  {
    id: "plans",
    title: "It plans first",
    text: "Watch the parts appear. Each picture is a part of the system: a browser window is the web client, a rack a server, a cylinder a database. The color says its state: the key under the board has them all. Grey means new: nothing is built yet.",
    enter: "demo",
    wait: (c) => (c.gate ? null : "Playing at 2×. The plan stops by itself when it's ready."),
    done: (c) => c.gate || c.stage === "building",
    dom: () => [{ sel: '[data-tour="key"]', label: "What the colors mean" }],
    spot: () => [BOARD], // the parts appear there
  },
  {
    id: "decision",
    title: "Click a ◇ decision",
    text: "A ◇ is a technical choice it made, like “a background worker”. Click the circled one: a card opens with what it chose, the other options, and why.",
    done: (c) => c.selected.some((l) => l.startsWith("decision:")) || c.stage === "building",
    board: (c) => (c.firstDecision ? [{ lid: `decision:${c.firstDecision}` }] : []),
  },
  {
    id: "steer",
    title: "Change its mind",
    text: "Press Use this on another option. It goes on your list of changes; nothing is sent yet.",
    done: (c, s) => c.edits > s.edits || c.stage === "building",
    dom: (c) => (c.explainUse ? [{ sel: '[data-tour="use-this"]', label: "Use this" }] : []),
    board: (c) => (!c.explainUse && c.firstDecision ? [{ lid: `decision:${c.firstDecision}` }] : []),
    spot: (c) => (c.explainUse ? [".explain"] : []), // the options, on the decision's card
    skip: "pick",
  },
  {
    id: "answer",
    title: "Answer its question",
    text: "It couldn't tell how big uploads get, so it asked you. Click the circled note and pick an answer. It updates the plan.",
    done: (c, s) => c.answered > s.answered || c.stage === "building",
    board: (c) => (c.firstQuestion ? [{ lid: `question:${c.firstQuestion}` }] : []),
    spot: (c) => (c.selected.includes(`question:${c.firstQuestion}`) ? [".explain"] : []), // its answers, on the note's card
    skip: "answer",
    clearSelection: true, // the decision's card from the last step would cover the note
  },
  {
    id: "approve",
    title: "Approve it, with your changes",
    text: "Nothing is built until you approve. Approve with changes sends your list along: it folds them in, then builds. (Revise plan would redraw the plan and ask again.)",
    wait: (c) => (c.gate ? null : "It's updating the plan…"),
    done: (c) => c.stage === "building",
    dom: (c) => (c.gate ? [{ sel: '[data-tour="approve"]', label: "Approve" }] : []),
    spot: (c) => (c.gate ? [".gate"] : []), // your list of changes
    skip: "approve",
    clearSelection: true,
  },
  {
    id: "build",
    title: "It builds: orange means being built",
    text: "It edits files by itself now. Hover a sentence in Chat & log: the parts it changed light up on the board. (The demo is paused for you.)",
    done: (c, s) => c.hovers > s.hovers || past(c, LATE),
    dom: () => [{ sel: '[data-tour="log-tab"]', label: "Chat & log" }],
    spot: (c) => [...(c.tab === "activity" ? [".transcript"] : []), BOARD], // the sentences to hover, and where they light up
    release: "build",
    clearSelection: true,
  },
  {
    id: "permission",
    title: "It asks before running a command",
    text: "A command can do anything your terminal can, so it asks every time. Read it, open “Why am I asked?”, then answer. Allow once lets this one run; Allow all, every command in this run; Deny, none (it finds another way).",
    wait: (c) => (c.permission ? null : "Building… a command is coming up."),
    done: (c, s) => c.permissions > s.permissions || past(c, ["deployment", "complete"]),
    dom: (c) => (c.permission ? [{ sel: '[data-tour="permit"]', label: "Allow or Deny" }] : []),
    skip: "allow",
  },
  {
    id: "why",
    title: "A check failed, so it changed a decision",
    text: "D2 said “the right page for 45 of 50 questions”. The eval found 41, so it changed D2. Open the Reasoning tab: each decision with its evidence, what it shapes, and the check that proves it.",
    wait: (c) => (c.testCaused ? null : "Testing… watch the ◇ decisions get ✓ or ✗."),
    done: (c) => (c.testCaused && c.view === "why") || past(c, ["complete"]),
    dom: (c) => (c.testCaused ? [{ sel: '[data-tour="why-tab"]', label: "Reasoning" }] : []),
    release: "verify",
  },
  {
    id: "untrue",
    title: "Find what it said that isn't true",
    text: "Agents can be wrong about their own work. The Review compares what it said with git and the test output. It claims it documented README.md, but no file like that changed: click that ✗ row, or the red pen mark on the board.",
    wait: (c) => (c.finished ? null : "Shipping… the review comes when it's done."),
    done: (c, s) => c.finished && c.reviewOpens > s.reviewOpens,
    // The review is at the end of Chat & log: open that tab first if Plan details is showing.
    dom: (c) =>
      !c.finished ? [] : c.tab === "activity" ? [{ sel: '[data-tour="untrue"]', label: "✗ not true" }] : [{ sel: '[data-tour="log-tab"]', label: "The review is in here" }],
    spot: (c) => (c.finished && c.view === "board" ? [BOARD] : []), // its red pen marks, on the Architecture board
    skip: "review",
  },
  {
    id: "timeline",
    title: "See the whole run on the Timeline",
    text: "One lane per decision, from proposed to proven. Your clicks are on top, test runs below. Spot D2's ✗ and the change that followed it.",
    done: (c) => c.view === "timeline",
    dom: () => [{ sel: '[data-tour="timeline-tab"]', label: "Timeline" }],
  },
  {
    id: "views",
    title: "See the same plan other ways",
    text: "The bar above the board redraws the plan. Draw as: C4, Data flow, Database, Sequence. Zoom into opens a layer: try ML. Then press Next.",
    next: true,
    dom: (c) => (c.view === "board" ? [{ sel: '[data-tour="lens"]', label: "Draw as · Zoom into" }] : [{ sel: '[data-tour="arch-tab"]', label: "Architecture" }]),
    spot: (c) => (c.view === "board" ? [BOARD] : []), // what each one draws
  },
  {
    id: "finish",
    title: "You've done a whole run!",
    text: "Next: start your own task on a real repo (that needs an API key, see the README), or replay a saved run from the start screen. The yellow tips keep explaining each step; Hide tips puts them away, and ? brings them back.",
    next: true,
    finish: true,
  },
];

export const tourLength = TOUR.length;

// A fresh tour, at the first step.
export function startTour(ctx) {
  return { i: 0, max: 0, manual: false, start: ctx };
}

export const stepOf = (tour) => (tour ? TOUR[tour.i] : null);

// Is this step waiting for something to happen first (and what to say meanwhile)?
export const waiting = (step, ctx) => step?.wait?.(ctx) ?? null;

// Move on through every step that's done. A step you came back to (Back) waits for Next,
// or it would skip itself straight away. Returns the same object when nothing changes.
export function advance(tour, ctx) {
  if (!tour) return tour;
  let t = tour;
  while (!t.manual && t.i < TOUR.length - 1) {
    const step = TOUR[t.i];
    if (step.next || !step.done?.(ctx, t.start)) break;
    t = enter(t, t.i + 1, ctx);
  }
  return t;
}

const enter = (t, i, ctx) => ({ i, max: Math.max(t.max, i), manual: false, start: ctx });

// Next (a step with no action to wait for, or one you came back to) and Skip step: on to the next one.
export function next(tour, ctx) {
  if (!tour || tour.i >= TOUR.length - 1) return tour;
  return enter(tour, tour.i + 1, ctx);
}

// Back: show the previous step again. It waits for Next, whatever the run's state.
export function back(tour, ctx) {
  if (!tour || tour.i === 0) return tour;
  return { ...tour, i: tour.i - 1, manual: true, start: ctx };
}

// The step was just reached for the first time (so its enter action, like starting the demo, runs once).
export const isFresh = (prev, tour) => !!tour && tour.i > (prev?.max ?? -1) && tour.i === tour.max;

// The demo pauses at a checkpoint (`<board op="tour" at="…"/>` in its script) only while the step
// that's about it waits for you; otherwise it plays straight through.
export function holds(tour, at, ctx) {
  const step = stepOf(tour);
  return !!step && step.release === at && !step.done?.(ctx, tour.start);
}

// Where to point: rings round page elements, and notes or circles on the board. Steps point
// only at what's there (their dom/board functions check the context), so a waiting step can
// still point, like the plan step at the color key.
// Also what stays lit while the rest of the screen dims (spot), and where the card goes
// (place): the board whenever a note is drawn on it, or while a step waits with nothing to
// click (the run is working on the board); the middle of the screen when there's nothing to show.
export function targets(tour, ctx) {
  const step = stepOf(tour);
  const dom = step?.dom?.(ctx) ?? [], board = step?.board?.(ctx) ?? [];
  const spot = [...(step?.spot?.(ctx) ?? [])];
  if (!spot.includes(BOARD) && (board.length || (!dom.length && waiting(step, ctx)))) spot.push(BOARD);
  const place = step?.place ?? (dom.length || spot.length ? "beside" : "center");
  return { dom, board, spot, place };
}
