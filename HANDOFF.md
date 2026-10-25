# Handoff: Agent Whiteboard

Written 2026-10-25 so the work can continue in a fresh (cloud) session without losing anything. It covers what the product is and why, what's built and verified, how every part works, the gotchas we hit, and a full implementation plan for the next feature: **the Timeline tab**.

Read this first, then `README.md` (user-facing docs), then the code.

---

## 1. What this is

A live whiteboard for a coding agent. Instead of an LLM dumping text, a real Claude Agent SDK session works in a real repo and **draws** what it's doing on an Excalidraw board:

- the **phase** it's in (Plan → Build → Verify → Ship) with a dot per task,
- the **architecture**: components as hand-drawn pictograms, their connections, libraries and APIs,
- the **reasoning**: numbered decision diamonds (what was chosen, over what, why, the evidence, the check that proves it),
- **progress**: components change color as they're built, verified, failed, shipped.

It's **two-way**: the user edits the board (rename, delete, draw an arrow or a box, delete a decision diamond, write a note) or challenges a decision, and the agent re-plans and changes the code to match. The agent stops after planning and waits for approval.

Every run is recorded so it can be replayed, reopened, and read as a decision log.

### The user's standing requirements (keep honoring these)

1. **Build on Excalidraw** (the OSS base), not hand-rolled UI. When a visual needs a renderer, prefer the same stack (roughjs is what Excalidraw itself uses).
2. **Pictures, not prose, on the board.** Pictograms, colors, dots, badges. Words go in the side panel. Short labels only on the canvas.
3. **Plan gate:** the agent stops after planning for Approve / Revise / Approve with changes.
4. **Real agent on real repos** (Claude Agent SDK), with permission prompts for shell commands, never pushing/deploying.
5. **Record every run**: replay, reopen ("respawn") the board, and a readable decision log.
6. **The reasoning chain is first-class:** architecture, libraries, connections/APIs and technical decisions must be visible and challengeable.
7. **Don't delete existing features** when adding new views; add alongside.

### Status

- Everything below is **built and verified** (demo, live agent runs on the sandbox repo, reopened recordings, narrow window, dark theme). Build is clean (`npx vite build`).
- **Nothing is committed anywhere. This folder is not a git repo yet.** See section 9 for moving to the cloud.
- Next: **Timeline tab** (section 8). The user explicitly wants it ("I love that idea").

---

## 2. Run it

```bash
npm install          # also copies Excalidraw fonts into public/fonts (postinstall)
npm run sandbox      # creates/resets sandbox/linkshort: a tiny URL shortener with node:test tests
npm run dev          # http://localhost:5199 (port fixed in vite.config.js)
```

- With `ANTHROPIC_API_KEY` (shell or `.env.local`, see `.env.example`), the app runs **live agent** mode: pick a repo (defaults to `sandbox/linkshort`), describe a task or click a suggestion, and an Agent SDK session starts in that folder.
- Without a key it plays the **scripted demo** ("DocQA · chat with your PDFs"). The demo is also reachable in live mode via "Or watch the scripted demo".
- Settings (dev server only, loaded via `loadEnv` for `ANTHROPIC_` and `AGENT_` prefixes): `ANTHROPIC_MODEL` (default `claude-opus-5-5`), `AGENT_EFFORT` (default `low`), `AGENT_REPO` (default repo path).
- `.claude/launch.json` has a `whiteboard` config (`npm run dev`, port 5199) for the desktop app's preview pane.
- Saved runs live in `recordings/` (git-ignored). Three representative ones are copied into **`fixtures/recordings/`** so a fresh checkout has data: copy them into `recordings/` to see them under "Saved boards".

| Fixture | Task | What it shows |
| --- | --- | --- |
| `6e0ae61d` | Let links expire after a given number of days | 4 decisions with named-test checks; **you challenged D4** ("cap it at 365 days") → D4 changed with cause "you"; proofs **ticked by the server from test output** at 01:29; $0.37, 14 turns |
| `dafce9c8` | Count clicks per link and add GET /stats/:code | You challenged D2 (add `lastClickedAt`) and the change **rippled to D1, D2, D3**; recorded before the proof feature (no checks) |
| `f0b64cdb` | Support custom aliases like /launch | You challenged D1 (allow dots); D1 changed, kept its "Before" |

The sandbox currently has aliases + stats + expiry implemented (from those runs); `npm run sandbox` resets it to the original.

---

## 3. Architecture and file map

```
Browser (React + Excalidraw)                     Vite dev server (Node)
┌──────────────────────────────────┐            ┌──────────────────────────────────────┐
│ App.jsx                          │  NDJSON    │ vite.config.js  plugin "agentRuns"   │
│  ├ side panel: status, Activity/ │◄───────────│   /api/runs → server/runs.js         │
│  │  Plan tabs, gate/permission/  │  events    │ server/runs.js  Run = one Agent SDK  │
│  │  edits cards, message box     │            │   query(); board MCP tool; plan gate │
│  └ board: PhaseHeader, tabs,     │───────────►│   and permissions via canUseTool;    │
│     Architecture + Why canvases  │  control   │   mirror of the board; proofs from   │
│ engine/session.js  routes events │  POSTs     │   test output; decision log          │
│ engine/board.js    owns canvases │            │ server/recordings.js  jsonl + .md    │
└──────────────────────────────────┘            └──────────────────────────────────────┘
```

| File | Role |
| --- | --- |
| `vite.config.js` | Mounts `runsMiddleware` at `/api/runs` for dev and preview; `httpServer.once("close", stopAllRuns)`; `loadEnv` for `ANTHROPIC_`/`AGENT_`; port 5199; ignores `sandbox/` in the watcher; `window.EXCALIDRAW_ASSET_PATH = "/"` is set in `index.html`. |
| `server/runs.js` | One Agent SDK `query()` per run. In-process MCP server `board` with tool `update_board({ ops })`. Plan gate (`ExitPlanMode`) and Bash permission prompts via `canUseTool`. Activity events from tool use/results. A server-side **mirror** of the board (nodes, edges, tasks, decisions) for the decision log and for proofs. Test-output parsing. Endpoints. |
| `server/recordings.js` | `Recorder`: appends every event (with `t`) to `recordings/<id>.jsonl`, keeps the decision timeline, rewrites `recordings/<id>.decisions.md` (Current plan + Timeline). `listRecordings`, `readRecording`, `readDecisions`; ids must match `/^[\w-]+$/`. |
| `server/instructions.js` | `BOARD_INSTRUCTIONS` (appended to the Claude Code system prompt) and `PLAN_INSTRUCTIONS` (plan mode). Ops must match `Board.apply()`. |
| `src/App.jsx` | All React UI: side panel (Activity, Plan tab `PlanView`, saved runs, cards, message box) and the board area (`PhaseHeader`, canvas tabs, two `<Excalidraw>` instances). Creates `Board` + `Session` once **both** canvas APIs exist. |
| `src/PhaseHeader.jsx` | The journey above the tabs: project title + goal, milestones Plan/Build/Verify/Ship drawn with **roughjs** (`rough.generator()` → `toPaths` → SVG), task dots, ✓/⏸ badges, finish flag, tooltips, hover/click linking. |
| `src/engine/board.js` | Owns both canvases. Architecture: pictograms, edges, notes, decision diamonds with ✓/✗ proof badges, highlighter marks, agent cursor, `diff()` of user edits. Why: `drawWhy()` chains. Exports `PHASES`, `STATUS`, `KINDS`, `TASK`, `MILESTONE`. |
| `src/engine/session.js` | Modes `demo` / `agent` / `replay`. Routes events to board + transcript; plan gate and permission state; highlights; replay stepping. |
| `src/engine/transcript.js` | Agent messages as sentences + activity rows, each linked to the logical ids it touched (`sentencesTouching(lids)`). |
| `src/engine/caption.js` | One-line status ("Deciding …", "Proving D2", "D2 failed its check"…). |
| `src/engine/parser.js`, `player.js`, `src/agent/script.js`, `replies.js` | Scripted demo: prose with inline `<board op="…"/>` tags typed at reading pace. `PLAN_SCRIPT` / `BUILD_SCRIPT`. |
| `src/agent/live.js` | Browser side of `/api/runs`: `getAgentStatus`, `startRun`, `controlRun` (keepalive), `followRun`, `listRecordings`, `loadRecording`, `decisionsUrl`. |
| `src/styles.css` | Panel + board styles; light/dark tokens on `.app[data-theme]`. |
| `scripts/make-sandbox.mjs` | Creates `sandbox/linkshort` (git-initialized). |
| `scripts/cdp.mjs` | Headless-Chrome driver used for testing and screenshots (section 7). |
| `fixtures/recordings/` | Sample runs (see above). |
| `screenshots/` | `live-run/` (real-time frames + timelapse of a run), `why-view/`, `tabs/` (current layout). |

### Event protocol (`/api/runs`)

- `POST /api/runs {repo, brief}` → `{id}`. `GET /api/runs/status`.
- `GET /api/runs/:id/events` → NDJSON stream, replays from the start. Each event has `t` (ms since run start).
- `POST /api/runs/:id/control` with `type`: `approve` (optional `edits`), `revise`, `chat` (`text`), `edits`, `permission` (`requestId`, `decision`: allow | allow-all | deny), `stop`. Every control also carries `board_state` (the board snapshot).
- `GET /api/runs/recordings`, `/recordings/:id` (jsonl), `/recordings/:id/decisions` (markdown, text/plain).
- Event types: `stage`, `text`, `break`, `op`, `activity`, `activity-result`, `gate`, `permission`, `answered`, `user`, `turn`, `done`, `error`, `stopped`, `closed`; recording-only: `meta`, `meta-update`, `decision` (log entries).

### Board ops (agent tool and demo tags alike)

`project {name, goal}`, `phase {name}` (planning | implementation | verification | deployment | complete), `task {id, phase, text, status}`, `node {id, name, kind, col, row, paths, libs, api, v}`, `edge {from, to, via, api, style}`, `decision {…}`, `status {id, v}`, `rename`, `note`, `remove`, `unlink`, `adopt {el, id, name, kind}`, `adopt-edge {el, from, to}`, `adopt-note {el}`.

**Decision op fields:** `id, title, chose, over[], why, affects[], evidence[], builds_on[], state (proposed|accepted|changed|rejected), verify, proof (pass|fail), proof_by`. Server-added on emitted ops: `cause` ("you" | "test"), `cause_text`, `fromTests: true` (proof set by the server from test output).

---

## 4. Features built (and how each works)

### 4.1 The live agent run (`server/runs.js`)

- `query({ prompt: inbox (async iterable of user turns), options })` with `cwd: repo`, `model`, `effort`, `permissionMode: "plan"`, `planModeInstructions`, `systemPrompt: { type: "preset", preset: "claude_code", append: BOARD_INSTRUCTIONS }`, **`settingSources: ["project"]`** (keeps the user's global hooks/settings out), `mcpServers: { board }` (`createSdkMcpServer({ name: "board", alwaysLoad: true })`), `canUseTool`, `includePartialMessages: true`, `abortController`. Needs zod 4 and `@modelcontextprotocol/sdk` as a peer.
- **Plan gate:** `canUseTool("ExitPlanMode")` emits `gate` and waits. Approve → `setPermissionMode("acceptEdits")` and allow. Revise/chat at the gate → deny with the user's message so the agent re-plans and calls ExitPlanMode again. "Approve with changes" sets `autoApprovePlan` so the next ExitPlanMode passes.
- **Permissions:** every Bash command asks the browser (`permission` event: command + description); Allow / Allow all (for the run) / Deny. File edits inside the repo are auto-allowed after approval.
- **Activity:** tool uses become activity rows (read, search, edit, write, command); edits to a file a component owns (`paths`, longest prefix) auto-mark that component `building`. Tool results: ANSI stripped; failure detected by regex (`N failed|errors`, `no such file`, `command not found`, Traceback, `^FAILED`) because `cmd | tail` exits 0.
- **Lifecycle:** runs live in `globalThis.__agentRuns` (survives module reloads); stopped on dev-server close, on tab close (`pagehide` + keepalive stop), after 15 min idle (60 min while waiting on the user). A finished run that's closed between turns doesn't add a "Stopped" log entry (`this.idle`).

### 4.2 Pictures-first board (Architecture tab)

Pictograms per kind (client = browser window, service = server rack, data = cylinder, external = cloud, queue, test = clipboard, user = person), name under it, main library in small grey text, status = color + corner badge (… building, ✓ verified, ✗ failed, ★ live). 3×3 grid (`freeCell`, spills below), arrows bind to invisible hit-boxes (`convertToExcalidrawElements` only binds within one batch, so geometry proxies are passed and points computed by hand), dashed when async, short protocol tag (`via`) on the arrow if it fits.

### 4.3 Steering from the board

`Board.diff()` compares the scene with the model: rename (label text changed), remove (hit-box deleted), unlink (arrow deleted), link (user arrow between two components), add (user box with a label), note (free text), **reject** (decision diamond deleted). The panel lists pending edits; Send / Revise plan / Approve with changes. The agent applies them (`adopt*` ops keep the user's element ids).

### 4.4 Reasoning chain: decisions, Plan tab, Challenge

- Decisions are diamonds "D#" pinned to the top-left of the first affected component, dotted ties to the others. States: proposed (dashed, light purple), accepted (solid purple, set on approval), changed (blue), rejected (grey dotted).
- **Plan tab** (`PlanView`): Goal; Architecture cards (status dot, libs chips, API, files); Connections (via + exact API); Decisions cards (Chose, Before (struck), Because, Over, Why, Evidence, Check, Proof, Links incl. "after D#"); Steps per phase. Board selection scrolls to the card; hovering a card highlights it on the board.
- **Challenge this** prefills `About D2 (<chose> over <alternatives>): ` in the message box (caret at end).
- **History:** a changed choice keeps `was[]`; "Changed D#" goes into the log.
- **Rules (server mirror and `Board.setDecision` agree):** a decision is `changed` **only when `chose` actually differs** (agents repeat decisions to report proofs). Changing `chose` resets `proof` to unchecked.

### 4.5 Checks and proofs (✓/✗ on diamonds)

- Every decision carries `verify` (how we'll know: ideally a test by name). The agent reports `proof` + `proof_by` after running tests.
- The server parses per-test lines in any Bash output (`testResults()`): TAP (`ok N - name` / `not ok`), node spec (`✔`/`✖`), Jest/Vitest (`✓`/`✕`/`×`), pytest -v (`::name PASSED|FAILED|ERROR`), go test -v (`--- PASS|FAIL: Name`). Latest result per name is kept in `run.tests`.
- `findTest(results, text, minLength)`: names match when one contains the other (quotes stripped, case-insensitive); the longest match wins.
- **The runner's word beats the agent's:** a claimed proof that disagrees with the parsed result is corrected and the agent is told in the `update_board` tool result. When a proof matches a test, `proof_by` is normalized to the test's own name (drops "ok 11 - ").
- **Auto-ticks:** on every test run, each decision whose `proof_by` (or, if none, its `verify` when the matched name is ≥ 12 chars) names a printed test gets its proof updated, emitted as a decision op with `fromTests: true`, logged as "Tests: Proved D#". Later runs re-check, so regressions cross a diamond again.
- **Cause of a change:** if the user sent chat/revise/edits this turn (`run.steer`, cleared on ExitPlanMode and on turn end), a changed decision gets `cause: "you", cause_text: gist(message)` (strips the "About D# (…):" prefix). Else, if its previous proof failed, `cause: "test"` with that proof's text. The client infers the test cause for older recordings.
- Instructions tell the agent to print each test's result line (no `| tail` cutting them off) and to fix the code or change the decision when a check fails.

### 4.6 Why tab

Its own Excalidraw canvas (read-only, `viewModeEnabled`). One row per decision: **Evidence** (page icon for files, note icon for facts, pink person for "You: …", red ✗ for a failed check; the cause is deduped from evidence) → **Decision** (diamond, title, chosen option) → **Shapes** (mini pictograms of affected components in their status colors) → **Proof** (✓ / ✗ / dashed "?" with the test name or the check). Dashed purple links show `builds_on` (straight between adjacent rows, bowed around rows in between). Each row has an invisible hit rect `why:r:<id>`; a click (not a drag) maps scene coords (`viewportCoordsToSceneCoords`) through `board.whyHit()` → logical ids → opens the card in the Plan tab. Refits when a decision is added while it's showing.

### 4.7 Layout: header + tabs (latest change)

- **PhaseHeader** above the board: title + goal on the left; milestones on the right with task dots, ✓ when done, blue ⏸ while waiting for plan approval, flag when complete. Hover → tooltip + highlights linked text; click → Plan tab at that phase/step (`plan-phase:<key>`, `plan-task:<id>` anchors). In dark theme it uses Excalidraw's own trick (`filter: invert(93%) hue-rotate(180deg)`).
- **Canvas tabs:** Architecture (component count; hint "Edit it to steer…") and Why (decision count + ✓n ✗n once proofs exist; hint "Evidence → decision → what it shapes → proof. Click a row to read it.").
- Both canvases stay mounted and measured; inactive is `visibility: hidden; pointer-events: none` under the active one. Excalidraw's `handleKeyboardGlobally` is false by default, so shortcuts don't cross canvases.
- The agent's cursor (an Excalidraw collaborator) moves on whichever canvas is showing. Highlights paint on both (`paintMarks` per canvas). The panel's old phase bar was removed (the header replaces it).

### 4.8 Recording, replay, decision log

- `recordings/<id>.jsonl`: every event with `t`, plus `meta` (id, brief, repo, model, effort, startedAt, project) and `meta-update` (agent session id, project, goal).
- `recordings/<id>.decisions.md`: header, **Current plan** (Goal, Architecture table, Connections, Decisions with Chose / Before / Over / Why / Changed because / Check / Proof / Evidence / Affects / Builds on), then **Timeline** (`### mm:ss · You|Agent|Tests: title`, lines, a `sh` code block for commands, a quote of what the agent said).
- Start screen "Saved boards": **Replay** (plays at its rhythm, gaps capped at 1.5 s, pause/speed work), **Open** (instant: applies all events, no cursor/flash), **Decisions** (the markdown).

---

## 5. Data shapes

```js
// Board.model
{ project, goal, phase, slots: {phase: n}, tasks: {id: {id, phase, text, status, slot}},
  nodes: {id: {id, name, kind, status, elId, cell, libs[], api[], paths[]}},
  edges: {"from>to": {from, to, elId, via, api}}, notes: [{n, elId}],
  decisions: {id: {id, n, title, chose, was[], over[], why, affects[], evidence[], builds_on[],
                   state, verify, proof, proof_by, cause: {who, text} | null}} }
```

Element id conventions: nodes `node-<id>` (+ `:label`, `:libs`, `:badge`…), edges `edge-<from>-<to>`, decisions `dec-<id>` (+ `-t`, `-pf`, `-l<i>`), highlight marks `hl-<lid>`, Why canvas `why:<part>:<decisionId>[:<nodeId>]…` with parts `h` (headers), `r` (row hit rect), `e` (evidence), `d` (diamond/title), `c` (component), `p` (proof), `a` (arrows). Logical ids (lids): `node:<id>`, `edge:<from>><to>`, `decision:<id>`, `task:<id>`, `phase:<key>`, `note:<n>`, `title`.

---

## 6. Gotchas we hit (read before changing things)

1. **Never edit `src/` during a live run.** Vite hot-reloads the page, the Session is disposed, and the agent is stopped (pagehide/dispose). Same for demo/replay state: any client edit resets it.
2. **After editing `server/*.js`, restart the dev server.** Vite restarts on config-dependency changes, but two edits within ~1 s once left the stale module loaded.
3. Text is measured when elements are created, so `Board.init()` awaits `document.fonts.load("24px Excalifont")` first, or labels clip.
4. Excalidraw measures its container after mount: fit after a short delay (`setTimeout(fit, 150)`), and use an invisible `frame` element so "fit" frames the whole grid even when empty.
5. All programmatic scene updates use `CaptureUpdateAction.NEVER` so they don't pollute the user's undo history.
6. `regenerateIds: false` in `convertToExcalidrawElements`, and keep element `seed`s on redraw (`replace()`), or shapes re-wobble.
7. Fractional indices: let Excalidraw handle them (`syncInvalidIndices` happens in updateScene).
8. Run-state UI that depends on hover must re-render: `Session.sync()` calls `notify()` (rAF-batched) because the header is React.
9. Old recordings lack `cause`/`fromTests`; the client infers "test" causes from a previous failed proof. "You" causes in old runs could be inferred from a preceding user chat (not done yet; the Timeline plan does it).
10. Agents sometimes name components after files (`store.js`); instructions could push for role names.
11. Two stray 3–6 s recordings (`31ae60d3`, `f18e705b`) came from clicks in the browser pane between turns; safe to delete.

---

## 7. Testing

- **Build:** `npx vite build`. **Server syntax:** `node --check server/runs.js`.
- **Sandbox tests:** `npm --prefix sandbox/linkshort test` (node:test; currently 12 pass after the expiry run).
- **Parser check:** the test-output parser was validated against real `npm test` TAP output from the sandbox plus pytest/go/jest/spec samples (copy `server/runs.js` to a temp `.mjs` with `export { testResults, findTest, gist }` appended and import it).
- **Visual/E2E:** `scripts/cdp.mjs` drives a headless Chrome at 1440×987 @2x:
  - start Chrome with `--remote-debugging-port=9444` (use your own port; another local session once used 9333),
  - `node scripts/cdp.mjs 9444 eval 'window.__wb.awaitingApproval'` (in dev, `window.__wb` is the Session),
  - demo: click "Or watch the scripted demo", set `window.__wb.player.speed = 4`, poll `awaitingApproval`, click "Approve plan & build", poll `board.model.phase === "complete" && !player.busy`,
  - reopen a run instantly: `await window.__wb.startReplay("<id>", { instant: true })`,
  - switch tabs by clicking `.canvas-tabs button` by text; real clicks with `click x y` (CSS px),
  - `shot file.png`; `record dir 1500` captured the real-time frames in `screenshots/live-run/`.
  - In a Linux cloud box there's no `/Applications/Google Chrome.app`; use any Chromium (`npx playwright install chromium` or the system `chromium`) with the same flags.
- **Live agent check** (needs `ANTHROPIC_API_KEY`): run a sandbox task, approve, allow only test/read/edit commands inside the sandbox, confirm diamonds tick from the output and the `.decisions.md` reads right. Each run costs about $0.20–0.40 at effort low.

---

## 8. NEXT: the Timeline tab

### 8.1 Goal

A third board tab, **Timeline**, that shows **how the thinking moved over the run**: one lane per decision across time, the user's actions on top, test runs, and the phases underneath. It answers "what changed, when, and because of what?" at a glance, and in a replay it doubles as a **scrubber**: click a moment and the board jumps there. It's the view to put in a PR description or review afterwards.

Agreed sketch (from the stats run `dafce9c8`): lanes You / D1 / D2 / D3; dashed purple diamonds when proposed (0:19); your challenge on the You lane (1:04) with an arrow into D2; blue diamonds on all three at 1:11 with arcs showing the ripple from D2; solid lane lines after approval (1:38); "allowed test" (2:02); green ✓ diamonds when verified (2:09); a Planning / Build+verify band at the bottom; ticks 0:00 / 1:00 / 2:00; legend.

```
            0:00         0:30         1:00         1:30         2:00
 You        ●start                     ●challenged D2    ●approved    ●allowed test
 Tests                                                          ✓  ✓
 D1 store        ◇┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄◆(blue)────────────────────✓
 D2 route        ◇┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄◆(blue, cause: you)────────✓
 D3 tests        ◇┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄◆(blue)────────────────────✓
 phases     [ Planning ............................ ][ Build ][Verify][Ship]
```

### 8.2 What it draws (Excalidraw, hand-drawn, pictures first)

- **Time axis** left→right; mm:ss ticks. **Idle gaps longer than ~15 s** (the user reading the plan, a pending permission) are **compressed** to a fixed width with a small "⋯ 0:32" break marker, so a 10-minute wait doesn't flatten everything else.
- **You lane** (top): start (brief), chat/challenge (pink person dot; the "About D#" target known), approve (with or without edits), board edits (count), permission allow/allow-all/deny, stop. Short label or none; the words go in the panel.
- **Tests lane:** each test-like command run as a small ✓ (green) or ✗ (red) tick, from `activity` (kind command) + `activity-result` (`ok`).
- **One lane per decision** (D1…Dn, label = "D# short title"), starting at its first op:
  - proposed: dashed purple diamond; lane line dashed while proposed,
  - accepted: lane turns solid purple at the approval time,
  - changed: blue diamond; a small connector from the cause: from the You mark (cause "you") or from the red ✗ (cause "test"); ripple arcs when one challenge changes several decisions in the same turn,
  - proof: ✓ green / ✗ red circle on the lane; `fromTests` proofs get a tiny link to the Tests tick that produced them,
  - rejected: grey diamond, lane ends.
- **Phase band** (bottom): segments per phase in the milestone colors (Plan/Build/Verify/Ship), from `op phase` times.
- **Now line:** a vertical marker at the current time (live: last event; replay: current replay position).

### 8.3 Data: one timed event stream for every mode

Build the timeline from a list of `{ t, ...event }`, the same shape the server streams and records:

- **agent + replay:** `Session.onAgentEvent(e)` already receives every event with `e.t`, including the `user` events the server emits for each control. (Live mode currently ignores `user` events in the transcript because the panel already shows them; the timeline should still consume them.)
- **demo:** there are no events, so synthesize them: on `startDemo` set `this.t0 = performance.now()`; in `applyOp` (demo) push `{ t: now - t0, type: "op", op }`; in `approve`/`sendChat`/`sendEdits` (demo) push `{ t, type: "user", kind, text, edits }`.
- Keep the stream on the Session: `this.events = []`, reset in `reset()`.

Derivation is a **pure function**, easy to unit-test on `fixtures/recordings/*.jsonl`:

```js
// src/engine/timeline.js
export function buildTimeline(events, model) → {
  duration,                       // ms
  segments: [{ from, to, x0, x1 }], // time → x mapping with compressed gaps
  you: [{ t, kind, label, lid? }],
  tests: [{ t, ok, label, toolUseId }],
  lanes: [{ id, n, title, marks: [{ t, kind: "proposed"|"accepted"|"changed"|"proof"|"rejected",
            state?, proof?, cause?: {who, text, t?}, fromTests?, was?, chose? }] }],
  phases: [{ key, from, to }],
}
export function timeToX(timeline, t) → x
export function drawTimeline(timeline, opts) → Excalidraw skeletons (ids "tl:<part>:<…>")
```

Rules:

| Event | Timeline effect |
| --- | --- |
| `op` decision, first time for an id | lane created, `proposed` (or `accepted` if outside planning) |
| `op` decision with a different `chose` | `changed` mark; cause = `op.cause` or, for old recordings: a `user` chat/revise/edits event since the last `gate`/`done` → "you", else a previous failed proof → "test" |
| `op` decision with `proof` | `proof` mark (pass/fail), `fromTests` → link to the nearest preceding test tick |
| `op` decision with `state: "rejected"`, or a `user` edits event with `kind: "reject"` | `rejected` |
| `user` kind `approve` | You mark; every lane still `proposed` becomes `accepted` at this t |
| `user` kind `chat`/`revise`/`edits`/`permission` | You mark (permission: allow/deny glyph); `About D#` → remember the target lane for the connector |
| `activity` command + `activity-result` | Tests tick if the command looks like a test run (same regex family as the server: `test|pytest|jest|vitest|mocha|go test|cargo test|node --test`) or the result printed per-test lines |
| `op` phase | phase boundary |
| `gate`, `permission`, `done` | candidates for gap compression; `done` ends the run |

### 8.4 Code plan by file

1. **`src/engine/timeline.js`** (new): `buildTimeline`, `timeToX`, `drawTimeline` (skeletons with roughness 1, Excalifont labels, colors from `DECISION`/`PROOF`/`MILESTONE`/`YOU` in board.js; export what's needed). Layout constants: lane height ~56, left gutter ~150 for lane labels, ~6–10 px per second adaptive to fit ~1400 px, gap threshold 15 s → 40 px.
2. **`src/engine/board.js`:** accept `timelineApi` in the constructor; `redrawTimeline(events)` → `replace(() => true, drawTimeline(buildTimeline(events, this.model)), this.timelineApi)` (keeps seeds); `timelineHit(x, y)` like `whyHit` (returns lids for decisions, and the event `t` for scrubbing); `fitTimeline()`; `paintMarks` on the third canvas for `decision:` lids (lane label or latest mark); `setView("timeline")`; `pointAt` on the timeline canvas when it's showing (cursor to the newest mark).
3. **`src/engine/session.js`:** `this.events` stream (above); call `board.redrawTimeline(this.events)` throttled (rAF or ~250 ms) on new events; in replay, `seekReplay(t)`: reset board + transcript, apply every event with `e.t <= t` instantly (`this.instant = true`), set `replay.i`, pause; expose `replayT` for the now line.
4. **`src/App.jsx`:** third `<Excalidraw excalidrawAPI={setTimelineApi} viewModeEnabled theme={theme} …>` in `.canvases`; create Board only when all three APIs exist; a third tab button "Timeline" (icon: tiny lanes/clock; badge: run duration "2:10" or number of changes); hint "How the decisions moved. Click a moment to jump there." (replay) / "…Click a mark to read it." (live); pointer capture like the Why canvas: in replay a click seeks, otherwise it opens the decision card (Plan tab) or the user's message (Activity tab; give user bubbles an anchor id `msg-<id>`); empty state text.
5. **`src/styles.css`:** tab icon, nothing else special (canvas styles are shared).
6. **`README.md`:** document the Timeline tab. Keep HANDOFF in sync or delete it when done.
7. **Server:** nothing required. Optional: stamp `cause` on rejects, and add the target decision id to `user` chat events when the text starts with "About D#".

### 8.5 Edge cases

- Live run still going: lanes grow to the right; auto-fit while the tab is showing unless the user panned (track a "follow" flag, reset on tab switch).
- Decisions added after approval start as `accepted`.
- Many decisions (6+): lanes stack; the canvas pans. Long titles clip (~20 chars) since words live in the panel.
- Demo speed changes: demo `t` is wall-clock, so 4× speed compresses the timeline; that's fine (or scale by `player.speed`).
- Runs without decisions: show You/Tests/phases only, with an empty-state hint.
- Recordings from before proofs/causes (e.g. `dafce9c8`, `f0b64cdb`): no ✓/✗, causes inferred.
- Seeking while a replay is playing: pause first; seeking back re-applies from the start (cheap: recordings are small).

### 8.6 Acceptance criteria

- [ ] A third tab "Timeline" sits next to Architecture and Why; switching tabs keeps each canvas's camera.
- [ ] For `6e0ae61d`: You lane shows start, the D4 challenge (0:34), approve (0:49), and the allowed commands; D4 shows proposed → changed (cause you, connector from the challenge) → ✓; D1–D3 proposed → accepted → ✓; the Tests lane shows the failing run (an old alias test broke) and the passing re-run, and the 01:29 proofs link to it.
- [ ] For `dafce9c8`: one challenge → D1–D3 all changed at the same moment with ripple arcs; no proofs.
- [ ] For the demo: D2 shows ✗ (eval 41/50) → changed (cause test) → ✓ (47/50).
- [ ] Idle gaps > 15 s are compressed with a visible break marker.
- [ ] In a replay, clicking a moment jumps the board, header and panel to that moment and pauses; the now line follows the replay.
- [ ] Clicking a decision mark opens its card in the Plan tab; clicking a You mark shows that message.
- [ ] Live run: the timeline updates as events arrive, without stealing the camera if the user panned.
- [ ] `buildTimeline` has a `node --test` unit test over `fixtures/recordings/*.jsonl`.
- [ ] Works in dark theme and in a narrow window. Build clean.

### 8.7 After the Timeline (backlog, from the sketches the user saw)

- **Ghost alternatives** on the Architecture tab: the rejected options (`over`) as faded ghosts by their decision; hover for "why not" (needs a per-alternative reason); **drag a ghost onto a component to request a swap** (reuses the Challenge path). Closest to the original pitch: "influence technical decisions by dragging components".
- **Blast radius on hover:** hovering a diamond lights everything it affects; hovering a component shows the decisions constraining it.
- **Confidence fill** on diamonds (sure / leaning / guess), guesses flagged ⚠ until a proof.
- **Trade-off chips** per alternative (qualitative +/− on 2–3 criteria).
- **Open questions** as "?" sticky notes the user answers by editing.
- **ADR export:** each decision as `docs/adr/NNN-*.md` in the repo at the end of a run (opt-in).
- **Run diff:** two recordings side by side.
- **Resume an agent from a saved board** (the Agent SDK session id is already saved in `meta-update`).

---

## 9. Moving to the cloud

- The code is on GitHub: **https://github.com/ghanemja/whiteboard** (branch `main`; the repo is **public**). A cloud session starts from that repo.
- `.gitignore` excludes `node_modules`, `dist`, `public/fonts`, `sandbox`, `recordings`, `.env*`. `fixtures/recordings/` (136 KB) and `screenshots/` (6.8 MB) are committed; the recordings contain local paths (`/Users/janelle/...`) and agent session ids, nothing secret.
- In the cloud: `npm install && npm run sandbox && npm run dev`. Live agent runs need `ANTHROPIC_API_KEY` in that environment; without it the app runs the demo, which is enough to build and check most of the Timeline (plus the fixtures for real runs).
- Not movable: the **cable chamfer** change for the user's `cable` repo lives in a separate local git worktree (`~/Documents/cable-chamfer`, branch `whiteboard/chamfer`), uncommitted, 80/80 tests passing, **waiting for the user's review; don't commit it without them.**
