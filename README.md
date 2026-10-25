# Agent Whiteboard

A real coding agent works in a repo while an Excalidraw board shows what it's doing: its plan, the parts of the system it's touching, and how far along it is. You steer it by editing the board.

The board is pictures, not prose. Components are hand-drawn pictograms (browser window, server rack, database cylinder, cloud, queue, clipboard, person) with a short name; status is color plus a corner badge (… building, ✓ verified, ✗ failed, ★ live). Above the board, the project's name and goal sit beside the four phases, drawn as milestones on a road (Plan → Build → Verify → Ship) with a dot per task: hover one to read it, click to open it in the Plan tab. Below that, the board has a tab per canvas: **Architecture** (what's being built; edit it to steer) and **Why** (the reasoning behind it). Words stay in the side panel.

## Run

```bash
npm install
npm run sandbox
npm run dev
```

Opens on http://localhost:5199. `npm run sandbox` creates `sandbox/linkshort`, a tiny URL shortener with real tests, as a safe repo to try the agent on (run it again to reset it). `npm install` also copies Excalidraw's fonts into `public/fonts`.

With `ANTHROPIC_API_KEY` set in the shell (or in `.env.local`, see `.env.example`), pick a repo, describe a task, and a [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) session starts in that folder. Without a key the app plays a scripted demo.

## What happens in a run

1. **Plan.** The agent starts in plan mode: it can read the repo but not change it. It draws the components the task involves (existing ones blue, new ones dashed grey) and their connections, then asks to exit plan mode. That request waits for you: the board shows ⏸ on the Plan milestone.
2. **Review.** Edit the board (double-click a name to rename it, delete a component, draw an arrow, drop a text note) or type a request. **Revise plan** sends your changes back so the agent re-plans; **Approve with changes** folds them in and goes on to build; **Approve plan & build** goes straight on.
3. **Build and verify.** The agent edits files (allowed automatically inside the repo) and the component that owns each file turns orange. It asks before every shell command: **Allow**, **Allow all** for the rest of the run, or **Deny**. Components turn green when verified, purple ★ when done.
4. **Afterwards** the session stays open: board edits and messages become new turns. Stop the agent with ■, start over with ↺. Closing the tab stops it, and an idle agent stops after 15 minutes.

## The reasoning behind the plan

The board shows what is being built; the **Plan** tab shows why.

- **Goal:** one line on what the task is for.
- **Architecture:** each component with its libraries and versions, the interface it exposes (routes, functions, tables) and the files that own it. On the board, libraries are a small caption under the pictogram.
- **Connections:** how two parts talk (HTTP, queue, SQL, call…) and the exact API on that edge. On the board, the protocol is a short tag on the arrow.
- **Decisions:** the few technical choices that shaped the plan. Each says what was chosen, the real alternatives it beat, why (the deciding reason and the cost accepted), evidence from the repo, which components it affects and which earlier decisions it builds on. On the board each is a numbered diamond (D1, D2…) on the component it affects most, with dotted ties to the others: dashed while proposed, solid once you approve, blue when changed, grey when rejected.

To push back, **Challenge this** on a decision starts a message ("About D1 …") for you to finish, and deleting a diamond rejects that decision. When the agent changes a decision, because you challenged it or because verification proved it wrong, the card keeps the old choice struck through under **Before** and says what caused the change under **Because**. Selecting a component on the board scrolls the Plan tab to it.

Every decision also names its **check**: how we'll know it was right, usually a test by name. Its result is drawn on the diamond: ✓ proven, ✗ failed. The agent reports proofs after running the tests, and the server compares them with the test runner's own output (node --test, Jest/Vitest, pytest -v, go test -v). Where the output disagrees, the output wins and the agent is told. Later test runs keep re-checking, so a regression crosses a diamond again. A decision whose choice changes goes back to unchecked.

The **Why** tab draws each decision as a chain: evidence (files from the repo, facts, your request, a failed check) → the decision → the components it shapes → its proof. Dashed purple links show which decisions build on which. It's drawn from the decisions, so it's read-only: pan and zoom it, and click a row to open that decision in the Plan tab. The tab itself counts the decisions and how many are proven (✓) or failed (✗).

## Saved boards and decision logs

Every run is saved in `recordings/` (git-ignored) while it happens:

- `<id>.jsonl`: every event with its time: what the agent drew, said, read, edited and ran, and what you did (approvals, board edits, messages, allowed or denied commands). It's also where the agent's session id is kept.
- `<id>.decisions.md`: a readable log of the development decisions. It opens with the current plan (goal, an architecture table with libraries and interfaces, connections, and each decision with what it beat, why, its evidence, what it replaced and why, its check and its proof), then a timeline: the plan the agent proposed, what you approved, challenged or changed, every decision the agent revised, each decision proven or failed (by the agent or by a test run), every command you allowed, and how the run ended, each with its time.

The start screen lists saved boards. **Replay** plays a run back on the board at its own rhythm (long waits are shortened, and pause and speed work as usual). **Open** jumps straight to the finished board. **Decisions** opens the decision log. A finished live run also links to its replay and decision log.

The panel lists what the agent actually did (files read and edited, commands and whether they passed) and links each row to the component it touched. Hover a sentence or row to highlight it on the board; select a component to find what changed it.

Settings: `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `low`), `AGENT_REPO` (default repo path). The agent loads the repo's project settings and `CLAUDE.md`, not your global Claude Code settings or hooks. It's told never to push, publish or deploy; "Ship" means tests pass and docs match.

## How it fits together

| File | Role |
| --- | --- |
| `server/runs.js` | One Agent SDK `query()` per run: the in-process `update_board` MCP tool, plan gate and permission prompts via `canUseTool`, activity events, `/api/runs` endpoints |
| `server/recordings.js` | Writes each run to `recordings/` (events + decision log), lists and serves them |
| `server/instructions.js` | What the agent is told about the board (appended to the Claude Code system prompt) |
| `src/agent/live.js` | Browser side of `/api/runs`: start, follow the event stream, send approvals and messages |
| `src/engine/session.js` | Routes agent events to the board and the transcript; plan gate and permission state |
| `src/engine/board.js` | Owns both Excalidraw canvases: the Architecture pictograms and decision diamonds, the Why chains, highlighter marks, and `diff()` of your edits |
| `src/PhaseHeader.jsx` | The journey above the tabs: title, goal, milestones and task dots, drawn with roughjs (Excalidraw's renderer) |
| `src/engine/transcript.js` | Sentences and activity rows, each linked to the board items it touched |
| `src/engine/parser.js`, `player.js`, `src/agent/script.js`, `replies.js` | The scripted demo (inline `<board/>` tags typed out at reading pace) |
| `scripts/make-sandbox.mjs` | Creates the sample repo |

Board ops (`update_board` tool and demo tags alike): `project`, `phase`, `task`, `node`, `edge`, `decision`, `status`, `rename`, `note`, `remove`, `unlink`, `adopt`, `adopt-edge`, `adopt-note`. See `Board.apply()`.
