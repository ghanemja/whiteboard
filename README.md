# Agent Whiteboard

A real coding agent works in a repo while an Excalidraw board shows what it's doing: its plan, the parts of the system it's touching, and how far along it is. You steer it by editing the board.

![The demo: the agent plans on the board, you pick another option for a decision (D3 → Qdrant), approve, it builds and ships; then the review card and the Timeline](screenshots/demo.gif)

The board is pictures, not prose. Components are hand-drawn pictograms (browser window, server rack, database cylinder, cloud, queue, clipboard, person) with a short name; status is color plus a corner badge (… building, ✓ verified, ✗ failed, ★ live). Above the board, the project's name and goal sit beside the four phases, drawn as milestones on a road (Plan → Build → Verify → Ship) with a dot per task: hover one to read it, click to open it in the Plan tab. Below that, the board has a tab per canvas: **Architecture** (what's being built; edit it to steer), **Why** (the reasoning behind it) and **Timeline** (how that reasoning moved over the run). Words stay in the side panel.

## Setup

Needs Node 20+ and git.

```bash
git clone https://github.com/ghanemja/whiteboard.git
cd whiteboard
npm install                  # also copies Excalidraw's fonts into public/fonts
npm run sandbox              # a safe repo to try: sandbox/linkshort (run again to reset)
cp .env.example .env.local   # set ANTHROPIC_API_KEY to run a real agent (optional)
npm run dev                  # http://localhost:5199
```

- **No key:** a scripted demo plays.
- **With a key:** pick a repo, describe a task; a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) session starts in that folder.
- **Saved runs:** `cp fixtures/recordings/* recordings/` adds three real runs under "Saved boards".
- **Tests:** `npm test`.
- **Settings** (`.env.local`): `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `low`), `AGENT_REPO` (default repo).

## What happens in a run

1. **Plan.** The agent starts in plan mode: it can read the repo but not change it. It draws the components the task involves (existing ones blue, new ones dashed grey) and their connections, then asks to exit plan mode. That request waits for you: the board shows ⏸ on the Plan milestone.
2. **Review.** Edit the board (see [Steering from the board](#steering-from-the-board)) or type a request. **Revise plan** (or **Submit** on the board) sends your changes back so the agent re-plans; **Approve with changes** folds them in and goes on to build; **Approve plan & build** goes straight on.
3. **Build and verify.** The agent edits files (allowed automatically inside the repo) and the component that owns each file turns orange. It asks before every shell command: **Allow**, **Allow all** for the rest of the run, or **Deny**. Components turn green when verified, purple ★ when done.
4. **Afterwards** the session stays open: board edits and messages become new turns. Stop the agent with ■, start over with ↺. Closing the tab stops it, and an idle agent stops after 15 minutes.

## Steering from the board

Edit the board; each change is sorted by what you touched:

| | Area | Edit |
| --- | --- | --- |
| ▢ | Architecture | rename (double-click a name), delete, draw a box, draw an arrow between two |
| ◇ | Decision | select a diamond → its alternatives fan out → drag one onto it (or type your own in the blank one); delete a diamond to reject it |
| ✐ | Scope | drop a text note ("English PDFs only") |

Queued changes show in the panel by area, and **Submit** (panel, or floating on the board with ▢ ◇ ✐ counts) sends them. While the agent works they go after its current step. The agent gets each edit with its area; the decision log lists them the same way. In the Plan tab, clicking an alternative under **Over** picks it too. A picked option sits beside its diamond in blue until the agent applies it; delete it to undo.

## The reasoning behind the plan

The board shows what is being built; the **Plan** tab shows why.

- **Goal:** one line on what the task is for.
- **Architecture:** each component with its libraries and versions, the interface it exposes (routes, functions, tables) and the files that own it. On the board, libraries are a small caption under the pictogram.
- **Connections:** how two parts talk (HTTP, queue, SQL, call…) and the exact API on that edge. On the board, the protocol is a short tag on the arrow.
- **Decisions:** the few technical choices that shaped the plan. Each says what was chosen, the real alternatives it beat, why (the deciding reason and the cost accepted), evidence from the repo, which components it affects and which earlier decisions it builds on. On the board each is a numbered diamond (D1, D2…) on the component it affects most, with dotted ties to the others: dashed while proposed, solid once you approve, blue when changed, grey when rejected.

To push back, **Challenge this** on a decision starts a message ("About D1 …") for you to finish; on the board, pick another of its options or delete the diamond to reject it. When the agent changes a decision, because you challenged it or because verification proved it wrong, the card keeps the old choice struck through under **Before** and says what caused the change under **Because**. Selecting a component on the board scrolls the Plan tab to it.

Every decision also names its **check**: how we'll know it was right, usually a test by name. Its result is drawn on the diamond: ✓ proven, ✗ failed. The agent reports proofs after running the tests, and the server compares them with the test runner's own output (node --test, Jest/Vitest, pytest -v, go test -v). Where the output disagrees, the output wins and the agent is told. Later test runs keep re-checking, so a regression crosses a diamond again. A decision whose choice changes goes back to unchecked.

The **Why** tab draws each decision as a chain: evidence (files from the repo, facts, your request, a failed check) → the decision → the components it shapes → its proof. Dashed purple links show which decisions build on which. It's drawn from the decisions, so it's read-only: pan and zoom it, and click a row to open that decision in the Plan tab. The tab itself counts the decisions and how many are proven (✓) or failed (✗).

The **Timeline** tab answers "what changed, when, and because of what?" across the run, left to right with mm:ss ticks:

- **You** (top): a pink mark for each thing you did: the start, a message (a **?** when it challenges a decision, with the decision named above it), approving the plan, board edits (their count), and each command you allowed or denied.
- **Tests:** a ✓ or ✗ for every test run (a command like `npm test`, `pytest` or `go test`, or one that printed per-test results), with its pass count when the runner printed one.
- **One lane per decision:** a dashed diamond when it's proposed and a dashed lane while the plan isn't approved; the lane turns solid when you approve (a faint line drops from your approval to the decisions it made solid). A blue diamond marks a change, with an arrow from what caused it: from your message, or from the ✗ of the check that failed. When one message changes several decisions, the arrow goes to the one you asked about and dashed arcs ripple from it to the rest. A ✓ or ✗ is its check's result; a dotted tie leads up to the test run that ticked it. A grey diamond ends the lane when it's rejected.
- **Phases** (bottom): Plan, Build, Verify and Ship as segments in the milestone colors, with a flag when it shipped.

Waits longer than 15 seconds (reading the plan, a permission you hadn't answered yet) are drawn short, with a break on the axis that says how long they were, so a long pause doesn't flatten the rest. An orange line marks now. During a live run the Timeline grows as events arrive and keeps the whole run in view, unless you've panned or zoomed it (⛶ fits it again). Click a decision's mark to open its card in the Plan tab, one of your marks to see that message, or a test run to see its command. The tab shows the run's length and how many times a decision changed (◆).

## Checking what it says

Don't take the agent's word for it. Glyphs and counts, details on hover:

- **Receipts.** After a checkable claim: ✓ backed, ✗ contradicted (with the one wrong thing, e.g. "✗ README.md"), ? no evidence. Test claims vs the runner's counts, file claims vs git, "I ran X" vs the commands run. ✗ comes only from the runner or git. Activity tab: ✗ n.
- **What it changed.** Git, not the agent's summary: the working tree vs how the run found it (untracked included, your index untouched). Components show +/− blocks; Plan → **Code** has every diff by component, plus files **not on board**.
- **Questions and assumptions.** "?" and "≈" sticky notes. Plan → **For you**: pick an option or type (↵), confirm ✓ or correct ✎. Ones only said in prose: **In passing**.
- **Skim.** Activity → Skim: keeps sentences that drew, claimed, asked or assumed; the rest fold to "⋯ n".
- **Review.** When a run ends: failed/unchecked checks, false or unverified claims, open questions, changed and unowned files, commits, last test run, denied commands. Each chip links to its card, sentence or diff.

The demo shows all five, including a false claim (a README it never touched) and a question buried in its summary.

## Saved boards and decision logs

Every run is saved in `recordings/` (git-ignored) while it happens:

- `<id>.jsonl`: every event with its time: what the agent drew, said, read, edited and ran, and what you did (approvals, board edits, messages, allowed or denied commands). It's also where the agent's session id is kept.
- `<id>.decisions.md`: a readable log of the development decisions. It opens with the current plan (goal, an architecture table with libraries and interfaces, connections, its questions and assumptions, the files it changed and which component owns each, and each decision with what it beat, why, its evidence, what it replaced and why, its check and its proof), then a timeline: the plan the agent proposed, what you approved, challenged or changed, every decision the agent revised, each decision proven or failed (by the agent or by a test run), every command you allowed, and how the run ended, each with its time.

The start screen lists saved boards. **Replay** plays a run back on the board at its own rhythm (long waits are shortened, and pause and speed work as usual). **Open** jumps straight to the finished board. **Decisions** opens the decision log. A finished live run also links to its replay and decision log.

In a replay the Timeline shows the whole run, with what hasn't happened yet faded and the now line following playback. It's a scrubber: click any moment (a mark, or anywhere along the axis) and the board, the phases and the panel jump to that point and pause there; play continues from it. Recordings made before the server recorded what caused a change still show it: a decision that changed right after you asked for something changed because of you (the Plan and Why tabs say so too), and a test run the agent said had failed counts as failed.

The panel lists what the agent actually did (files read and edited, commands and whether they passed) and links each row to the component it touched. Hover a sentence or row to highlight it on the board; select a component to find what changed it.

The agent loads the repo's project settings and `CLAUDE.md`, not your global Claude Code settings or hooks. It's told never to push, publish or deploy; "Ship" means tests pass and docs match.

## How it fits together

| File | Role |
| --- | --- |
| `server/runs.js` | One Agent SDK `query()` per run: the in-process `update_board` MCP tool, plan gate and permission prompts via `canUseTool`, activity events, `/api/runs` endpoints |
| `server/recordings.js` | Writes each run to `recordings/` (events + decision log), lists and serves them |
| `server/changes.js` | What a run changed in the repo, from git: working-tree snapshots through a throwaway index, and their diff |
| `server/instructions.js` | What the agent is told about the board (appended to the Claude Code system prompt) |
| `src/agent/live.js` | Browser side of `/api/runs`: start, follow the event stream, send approvals and messages |
| `src/engine/session.js` | Routes agent events to the board and the transcript; plan gate and permission state; keeps the run's timed events for the Timeline and seeks replays |
| `src/engine/board.js` | Owns the three Excalidraw canvases: the Architecture pictograms and decision diamonds, the Why chains, the Timeline, highlighter marks, and `diff()` of your edits |
| `src/engine/timeline.js` | The Timeline as pure functions: `buildTimeline(events)` (lanes, marks, causes, the time axis with compressed waits), `timeToX`, `drawTimeline` (Excalidraw skeletons) |
| `src/engine/palette.js` | Phases and the colors the canvases share |
| `src/engine/claims.js` | Receipts: finds checkable claims in the agent's sentences (and questions or assumptions said in passing) and checks them against the run's record |
| `src/engine/review.js` | The end-of-run review card: what needs a look, and where |
| `src/PhaseHeader.jsx` | The journey above the tabs: title, goal, milestones and task dots, drawn with roughjs (Excalidraw's renderer) |
| `src/engine/transcript.js` | Sentences and activity rows, each linked to the board items it touched |
| `src/engine/parser.js`, `player.js`, `src/agent/script.js`, `replies.js` | The scripted demo (inline `<board/>` tags typed out at reading pace) |
| `scripts/make-sandbox.mjs` | Creates the sample repo |
| `test/*.test.js` | `npm test`: the Timeline over the sample runs in `fixtures/recordings/`, claims and receipts, the review card, and git change tracking on a throwaway repo |

Board ops (`update_board` tool and demo tags alike): `project`, `phase`, `task`, `node`, `edge`, `decision`, `question`, `assumption`, `status`, `rename`, `note`, `remove`, `unlink`, `adopt`, `adopt-edge`, `adopt-note`. See `Board.apply()`. The demo's script also uses `diff` and `run` to stand in for what a live run gets from git and the test runner.

## License

MIT, see [LICENSE](LICENSE). The Claude Agent SDK it depends on has its own license (see that package).
