# Token cost: the whiteboard vs. a chat assistant

How many tokens does a task take with the whiteboard, compared with a normal chatbot? This study counts them for the DocQA demo task. It counts exact text with a tokenizer: no model was run for the tables, because there was no API key where it was made. `scripts/token-study.mjs` computes every number in them (rerun on 2026-10-28, on the design where messages carry only what changed; the instructions keep changing, so rerun it for current numbers). [Live runs](#live-runs) adds six real runs of the agent, measured from their own transcripts.

## Summary

| Condition | 1. First plan | 2. Plan + 3 corrections | 3. Full run (counted part) |
|---|---:|---:|---:|
| A: chat, rewrites the plan | $0.0287 (23 in, 1,428 out) | $0.1475 (8,779 in, 5,618 out) | n/a |
| A: chat, changes only | $0.0287 (23 in, 1,428 out) | $0.0519 (4,685 in, 1,660 out) | n/a |
| B: agent, no board | $0.0287 (23 in, 1,428 out) | $0.0487 (4,866 in, 1,972 out) | $0.0551 (29,262 in, 1,972 out) |
| Whiteboard | $0.0751 (11,548 in, 2,012 out) | $0.0907 (53,914 in, 2,254 out) | $0.1518 (223,370 in, 3,340 out) |
| Whiteboard, reads the board after each correction | $0.0751 (11,548 in, 2,012 out) | $0.1187 (112,988 in, 2,284 out) | $0.1941 (353,724 in, 3,370 out) |
| **Whiteboard − B** | **+$0.0464 (+11,525 in, +584 out)** | **+$0.0420 (+49,048 in, +282 out)** | **+$0.0968 (+194,108 in, +1,368 out)** |
| Whiteboard − B, reads after each correction | +$0.0464 (+11,525 in, +584 out) | +$0.0700 (+108,122 in, +312 out) | +$0.1390 (+324,462 in, +1,398 out) |

Prices are Claude Opus 5.5's. "In" sums the input of every request, resent history included. B and the whiteboard leave out what they share (Claude Code's own prompt and tools, the repo reads, the build work), so neither is a whole run's bill. Their difference is the board's cost.

- **Shorthand mode (on by default) cuts a live run's cost by 29–42%** ([below](#shorthand-mode)): it gives the agent only the tools it uses, which shrinks its first request from 40,897 to 14,307 tokens, and writes board ops as lines (−20 to −32% output for the ops, −17% for a read). The tables in this summary are the standard mode's.
- **Messages carry only what changed.** A correction's message to the agent is 42–88 tokens, down from 1,142–1,188 when the board went with every message. The agent calls `read_board` for the whole board when it needs it; a read returns about 1,070 tokens.
- **So the board costs less.** Its extra cost over B is +$0.0420 for a plan and 3 corrections (was +$0.0592, 29% less) and +$0.0968 for the full run (was +$0.1275, 24% less). Input falls from 65,448 to 53,914 tokens, and from 302,884 to 223,370. The first plan costs slightly more (+$0.0464, was +$0.0454), because the fixed overhead grew by 203 tokens.
- **It still processes far more input than B.** The full run takes 223,370 input tokens against 29,262 for B, about 7.6 times as many. 96% of the board's input is cache reads, at a twentieth of the input price.
- **Reads are the swing factor.** If the agent read the board after every correction, the board would cost more than it did before: +$0.0700 and +$0.1390. Each read is an extra request, and every request re-reads the whole context. In the live runs the agent read the board only when the correction asked it to.
- **In real runs the saving is small.** Counted for the three recorded runs, the board's part falls 2–5%, to 22–34% of their cost. They had few corrections to save on, and the fixed overhead is paid on every turn.
- **Ops are not shorter than prose.** The DocQA plan is 1,878 tokens as `update_board` JSON, plus 134 of chat. The same plan in markdown is 1,428: the board writes 41% more.
- **Steering saves against a chat that rewrites the plan,** from 2 corrections on: the board's reply to a correction is 42–104 tokens, a rewrite 1,309–1,442. Against a chat that states only the change, the board now breaks even at 12 corrections (it never did before). It never catches up with B.
- **Slow replies at the plan gate raise the extra cost.** Past the cache's lifetime, the next request writes the whole context again: the full run's extra cost goes from $0.0968 to $0.2083 (from $0.2667 before).
- **Carrying on from a saved board costs one message:** 3,579–5,090 tokens for the three real runs, the only message that carries the whole board.

The counts use OpenAI's o200k_base tokenizer, so Claude's real counts are likely higher (see [Caveats](#caveats)). With `ANTHROPIC_API_KEY` set, the script gives exact Claude counts.

## What changed

Before, every message carried the whole board as `<board_state>`. Now a message carries only the user's edits (and any assumptions they confirmed since the last message), and the agent reads the board with `read_board`. The "before" column is the script's output on `main` at `5cca0da`, the last commit without `read_board`, with the same demo and tokenizer.

| | Before: whole board in each message | Now: edits in each message, `read_board` on demand |
|---|---:|---:|
| Fixed overhead per request | 4,402 | 4,605 (+203: 116 for `read_board`, 87 for longer instructions) |
| Message per correction, to the agent | 1,142–1,188 | 42–88 |
| Context at the last correction (plan + 3) | 10,249 | 7,159 |
| Whiteboard input, plan + 3 corrections | 65,448 | 53,914 |
| Whiteboard input, full run | 302,884 | 223,370 |
| Each correction, on average | $0.0113 | $0.0052 |
| Whiteboard − B, first plan | +$0.0454 | +$0.0464 |
| Whiteboard − B, plan + 3 corrections | +$0.0592 | +$0.0420 |
| Whiteboard − B, full run | +$0.1275 | +$0.0968 |
| Whiteboard − B, full run, cache cold at each turn | +$0.2667 | +$0.2083 |
| Whiteboard − B, with a read after each correction | n/a (no read tool) | +$0.0700 (plan + 3), +$0.1390 (full run) |
| Real runs: board share of measured cost (counted) | 22–24%, 33–36%, 30–32% | 22–23%, 32–34%, 29–31% |
| Live runs: the correction's message | 612–697 tokens | 44–67 tokens |

## What's compared

- **A: a chat assistant.** It writes the plan as markdown. You steer by typing sentences. It resends the whole conversation every turn, uncached. Two versions: after a correction it either rewrites the whole plan, or says only what changed.
- **B: the same coding agent without the board.** Claude Code through the Agent SDK, with no board instructions, no `update_board` or `read_board` tool and no board state. It writes the plan in markdown and edits it for each correction. **Whiteboard − B is the board's true overhead.**
- **Whiteboard:** the agent as `server/runs.js` runs it: messages carry the edits, and the agent has `update_board` and `read_board`.
- **Whiteboard, reads after each correction:** the same, plus one `read_board` call after each correction: the most reads a message-only design is likely to cost.

**Models.** Claude: `claude-opus-5-5` at effort `low` (`settings()` in `server/runs.js`; `AGENT_MODEL` and `AGENT_EFFORT` change them). Codex (`AGENT_ENGINE=codex`): Codex's default model and effort. The recorded and live runs used `claude-opus-5-5` at effort `low`.

**Prices** (Opus 5.5, per million tokens): input $4.00, output $20.00, cache write (5 minutes) $5.00, cache read $0.20. They come from the `claude-api` skill's model table (cached 2026-10-06) and its Opus 5.5 notes. Codex isn't priced: OpenAI's prices couldn't be checked here.

**Metrics:** input and output tokens, the cache write/read split, cost per scenario, user turns and model requests, fixed overhead per request, context size per turn, tokens per correction, and the break-even point.

## Method

- **Exact text, estimated counts.** Everything counted is real text:
  - the board instructions and tool schemas (`server/instructions.js`, `server/board-tool.js`; the zod schemas turned into JSON Schema the way the MCP SDK does it);
  - the messages the agent gets at the plan gate, built by `ClaudeRun.control()` itself, and a carried-on session's first message, built by `Run.firstTurn`;
  - the board state that `read_board` returns (and a carried-on session starts with), from a copy of `Board.snapshot()` (board.js needs Excalidraw, so it can't load in Node);
  - the DocQA demo as the agent's output (`src/agent/script.js`, `src/agent/replies.js`), its tags turned into `update_board` JSON. Demo-only tags (`tour`, `ask`, `run`, `diff`) are dropped.
- **The browser's side of a read.** A `read_board` request reaches the browser as a `board-read` event on the run's stream, and the browser answers with `Board.snapshot()`: the copy the study counts. The round trip itself (`session.js`, `POST /api/runs/:id/board`) isn't run by the script; the live runs below exercised it.
- **The prose plan** is `Run.planMarkdown()` of the same ops. Its Mermaid diagrams are dropped, since they redraw its tables. What it leaves to the diagrams or the board is added: parts, flows, tables and steps. So both forms carry the same information.
- **Requests.** One per user turn. The whiteboard adds one per `update_board` call, and one per `read_board` call in the reads variant, because each call's result goes back to the model. Every request resends everything before it.
- **Caching.** B and the whiteboard: the first request writes to the cache; each later one reads what came before and writes what's new. A: no caching.
- **Left out of B and the whiteboard**, because it's the same in both: Claude Code's own prompt and tools, the repo reads, and the build's file edits and commands. A has none of these.
- **Real runs.** The three recorded runs in `fixtures/recordings/` give a real cost and turn count, and the ops the agent actually sent.

To reproduce:

```bash
npm i --no-save js-tiktoken@1.0.21   # o200k_base counts, without touching package.json
node scripts/token-study.mjs         # prints every table here
ANTHROPIC_API_KEY=sk-ant-… node scripts/token-study.mjs   # exact Claude counts (count_tokens)
node scripts/token-study.mjs --dump texts/                # also saves every text it counts
node scripts/prompt-size.mjs                              # the whole first request, standard vs shorthand (a one-turn call; needs a model)
```

With neither js-tiktoken nor a key, it falls back to characters ÷ 4 and says so (`npm install` and `npm audit fix` remove a `--no-save` package, so install it again after them). `TOKENIZER_DIR` points it at js-tiktoken installed somewhere else.

## Scenarios

All three use the DocQA task: "Build DocQA: people upload PDFs and ask questions about them, and every answer cites the page it came from."

1. **First plan.** The agent plans and stops at the plan gate.
2. **Plan + 3 corrections**, the ones the tour teaches, one turn each:
   - pick another option for D1: "Process during the upload request";
   - answer Q1: 50 MB;
   - put **Not needed** on the ingest worker.

   In A and B you type them instead: "For D1, process uploads during the upload request instead of in a background worker." "The largest PDF people will upload is 50 MB." "Drop the ingest worker; we don't need it."
3. **Full run.** Scenario 2, then approve, build and verify (the demo's build). Both agents make 12 requests for the build: 8 file changes, 3 commands and a closing summary. The whiteboard adds 10 `update_board` calls (54 ops).

The reads variant adds a `read_board` call after each correction: the call, then the whole board as the result. The default reads nothing: the demo's agent doesn't read, and the instructions say an ordinary change needs no read.

## Results

### Fixed overhead per request

| Piece | Where | Tokens |
|---|---|---:|
| BOARD_INSTRUCTIONS | appended to the system prompt | 3,149 |
| update_board tool definition | tools (name, description, JSON schema) | 1,340 |
| read_board tool definition | tools (name, description, JSON schema) | 116 |
| **Total, every request** | cached prefix | **4,605** |
| PLAN_INSTRUCTIONS | once, in plan mode (replaces Claude Code's default plan text; counted in full) | 137 |
| Codex: CODEX_BOARD_INSTRUCTIONS | developer instructions, every request | 3,166 |
| Codex: update_board over MCP | tools, every request | 1,335 |
| Codex: read_board over MCP | tools, every request | 111 |
| Codex: CODEX_PLAN_INSTRUCTIONS | once, in the first turn | 145 |

Cached, the 4,605 tokens cost $0.0009 per request, after a $0.0230 write. Uncached, $0.0184 per request. For Codex, o200k_base is its own tokenizer, so those counts hold (message framing aside).

### Writing the plan

| Form | What | Tokens |
|---|---|---:|
| Prose plan (A, B) | planMarkdown() without its diagrams, plus parts, flows, tables and steps | 1,428 |
| Whiteboard: update_board call | 42 ops as JSON, one call | 1,878 |
| Whiteboard: chat text | the demo's narration around the ops | 134 |
| **Whiteboard total** |  | **2,012** (+41% vs prose) |
| For reference: the decision log's plan | planMarkdown() as written, with its Mermaid diagrams | 1,863 |

JSON repeats its keys (`"op"`, `"id"`, `"of"`…) in every op, where a markdown table names its columns once.

### One correction: typed vs. on the board

What you send:

| Correction | Typed sentence (A, B) | Board: the edit or answer itself | Board: whole message to the agent | Board: read_board result (only if the agent reads) |
|---|---:|---:|---:|---:|
| Another option for D1 | 17 | 58 | 88 | 1,089 |
| Answer Q1 (50 MB) | 11 | 13 | 42 | 1,094 |
| Not needed on the ingest worker | 10 | 58 | 88 | 1,027 |

The whole message is what `runs.js` sends at the plan gate: the edit or answer and its own wrapper sentence, 73 tokens on average. Before, it also carried the board: 1,094–1,101 tokens of snapshot, 94% of a message of 1,142–1,188. Now the board comes only through `read_board`, which returns about 1,070 tokens, plus 10 for the call.

What the model writes back:

| Correction | A reply: rewrites the plan | A reply: changes only | B: Edit of its plan file (old + new) | Whiteboard: text + update_board call |
|---|---:|---:|---:|---:|
| Another option for D1 | 1,439 | 92 | 173 | 104 (2 ops) |
| Answer Q1 (50 MB) | 1,442 | 42 | 61 | 42 (1 op) |
| Not needed on the ingest worker | 1,309 | 98 | 310 | 96 (3 ops) |

The board's replies are short, because one op changes one thing. B's edits are longer: an edit names the old text as well as the new.

### Requests and the cache split

| Condition | User turns | Requests | Uncached in | Cache write | Cache read | Output | Cost |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 · A chat | 1 | 1 | 23 | 0 | 0 | 1,428 | $0.0287 |
| 1 · B agent, no board | 1 | 1 | 0 | 23 | 0 | 1,428 | $0.0287 |
| 1 · Whiteboard | 1 | 2 | 0 | 6,783 | 4,765 | 2,012 | $0.0751 |
| 2 · A chat, rewrites | 4 | 4 | 8,779 | 0 | 0 | 5,618 | $0.1475 |
| 2 · A chat, changes only | 4 | 4 | 4,685 | 0 | 0 | 1,660 | $0.0519 |
| 2 · B agent, no board | 4 | 4 | 0 | 1,723 | 3,143 | 1,972 | $0.0487 |
| 2 · Whiteboard | 4 | 8 | 0 | 7,261 | 46,653 | 2,254 | $0.0907 |
| 2 · Whiteboard, reads after each correction | 4 | 14 | 0 | 10,501 | 102,487 | 2,284 | $0.1187 |
| 3 · B agent, no board | 5 | 16 | 0 | 2,033 | 27,229 | 1,972 | $0.0551 |
| 3 · Whiteboard | 5 | 30 | 0 | 8,407 | 214,963 | 3,340 | $0.1518 |
| 3 · Whiteboard, reads after each correction | 5 | 36 | 0 | 11,647 | 342,077 | 3,370 | $0.1941 |

Most of the whiteboard's input is cache reads: 96% in the full run. So its big input counts cost less than they look. Reads add requests: scenario 2 goes from 8 requests to 14, and the full run from 30 to 36.

### How the context grows

Input tokens of the request that answers each user turn:

| User turn | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard | Whiteboard − B |
|---|---:|---:|---:|---:|---:|
| Plan | 23 | 23 | 23 | 4,765 | +4,742 |
| Another option for D1 | 1,468 | 1,468 | 1,468 | 6,871 | +5,403 |
| Answer Q1 (50 MB) | 2,918 | 1,571 | 1,652 | 7,023 | +5,371 |
| Not needed on the ingest worker | 4,370 | 1,623 | 1,723 | 7,159 | +5,436 |

After the full run the whiteboard's context is 8,407 tokens and B's is 2,033 (11,497 and 2,033 before). Every further request re-reads the 6,374-token difference, for $0.0013 cached.

### Where the extra cost goes

| Scenario | Fixed overhead | Extra output | Messages, results, bigger history | Total |
|---|---:|---:|---:|---:|
| 1. First plan | $0.0239 | $0.0117 | $0.0108 | **$0.0464** |
| 2. Plan + 3 corrections | $0.0295 | $0.0056 | $0.0069 | **$0.0420** |
| 2, cache cold at each correction | $0.0958 | $0.0056 | $0.0255 | **$0.1270** |
| 3. Full run | $0.0497 | $0.0274 | $0.0197 | **$0.0968** |
| 3, cache cold at each user turn | $0.1381 | $0.0274 | $0.0428 | **$0.2083** |

"Cold": the cache has expired before a turn, so that request writes the whole context again at $5.00 instead of reading it at $0.20. The build alone adds 10 `update_board` calls, 54 ops, 1,086 output tokens ($0.0217) and 60 tokens of tool results. Before, the messages and results cost $0.0254 in scenario 2 and $0.0526 in scenario 3, and the fixed overhead $0.0282 and $0.0475.

### Break-even

Cost after k corrections:

| Corrections | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard |
|---|---:|---:|---:|---:|
| 0 | $0.0287 | $0.0287 | $0.0287 | $0.0751 |
| 1 | $0.0633 | $0.0364 | $0.0394 | $0.0809 |
| 3 | $0.1475 | $0.0519 | $0.0487 | $0.0907 |
| 5 | $0.2565 | $0.0689 | $0.0567 | $0.1010 |
| 10 | $0.6227 | $0.1192 | $0.0847 | $0.1300 |
| 20 | $1.7807 | $0.2448 | $0.1363 | $0.1895 |

Each correction adds, on average: A rewriting $0.0396, A with changes only $0.0078, B $0.0067, the whiteboard $0.0052 (was $0.0113). So the whiteboard is cheaper than a chat that rewrites the plan from 2 corrections on, and than a chat that gives only the changes from 12 (before: never). It is never cheaper (up to 100 corrections) than B. Corrections past the third repeat the three measured ones.

### Real runs

Three runs of the whiteboard with Claude, recorded in `fixtures/recordings/`:

| Run | Task | Turns | Measured cost | Board calls (ops) | Board output | Board input added | Board cost (est.) | Share |
|---|---|---:|---:|---:|---:|---|---:|---:|
| 6e0ae61d | Let links expire after a given number of days | 14 | $0.3728 | 5 (47) | 1,789 | 4,605/turn + 196 | $0.0807–$0.0859 | 22–23% |
| dafce9c8 | Count clicks per link and add GET /stats/:code | 16 | $0.2203 | 4 (32) | 1,329 | 4,605/turn + 190 | $0.0710–$0.0756 | 32–34% |
| f0b64cdb | Support custom aliases like /launch | 13 | $0.2045 | 4 (31) | 989 | 4,605/turn + 190 | $0.0598–$0.0626 | 29–31% |

All three: `claude-opus-5-5`, effort `low`. Measured cost and turns are the Agent SDK's own figures (`total_cost_usd`, `num_turns`, which counts model round trips). They were recorded with the whole board in every message, so their measured cost is the old design's; the board's part here is counted for the new messages, with no reads: the fixed overhead per turn, plus tool results, the edits and wrappers sent at the gate, and the plan-mode instructions. The low estimate writes every board token to the cache once and reads the fixed overhead on every turn. The high one also re-reads every board token on every later turn.

Counted the old way the same runs come to $0.0829–$0.0900, $0.0724–$0.0788 and $0.0610–$0.0651, so the saving is 2–5%. The messages drop by 550–750 tokens a run, but the fixed overhead adds 203 on each of 13–16 turns.

### Carrying on from a saved board

**Done** on a saved run keeps its board, and the next thing you send starts a new session on it (HANDOFF 4.17). That session has no context yet, so its first message carries the task, the saved run's decision log (the handover) and the board, built by `Run.firstTurn` in `runs.js`. Here it is for a next task ("Add a GET /health endpoint that reports how many links are stored", 13 tokens) on each real run's board:

| Saved run | Decision log (handover) | <board_state> | Whole first message | Written to the cache once | Read by each later request |
|---|---:|---:|---:|---:|---:|
| 6e0ae61d | 4,183 | 877 | 5,090 | $0.0255 | $0.0010 |
| dafce9c8 | 2,928 | 761 | 3,717 | $0.0186 | $0.0007 |
| f0b64cdb | 2,903 | 647 | 3,579 | $0.0179 | $0.0007 |

The decision log is the one the server writes for that run today (`renderDecisions` over its recording). The rest of the new session costs what any run does: the same 4,605 fixed tokens per request, and messages with only what changed. It doesn't resend the earlier session's conversation, because it starts a fresh one.

## Live runs

Six runs of the real agent (Claude Opus 5.5, effort `low`) on the sample repo, all with the task "Support custom aliases like /launch" and one correction at the plan gate ("Aliases are 3 to 20 letters, digits or dashes, and an alias that is already taken is refused."), driven through the app's own UI in headless Chromium. Usage comes from each run's Agent SDK transcript (one entry per request, with its token usage); priced as below, it matches the SDK's own `total_cost_usd` to the cent.

| Date | Code | Requests | Cost | update_board calls (ops) | read_board | The correction's message | Tests ran |
|---|---|---:|---:|---:|---|---:|---|
| 10-27 | before (`9edb62c`) | 10 | $0.649 | 2 (13) | — | 612 tokens, board included | no |
| 10-27 | `read_board` (`bac431c`) | 10 | $0.618 | 2 (4) | not called | 53 tokens | no |
| 10-27 | `read_board` (`bac431c`) | 9 | $0.366 | 1 (13) | not called | 53 tokens | yes |
| 10-27 | `read_board` (`bac431c`), asked to read the board | 11 | $0.366 | 2 (6) | called once: 667 tokens | 44 tokens | no |
| 10-28 | before (`main` at `5cca0da`) | 10 | $0.648 | 1 (9) | — | 697 tokens, board included | yes: 8 pass, every decision proven |
| 10-28 | this version, asked to read the board | 11 | $0.649 | 1 (6) | called once: 635 tokens | 67 tokens | no |

- **The correction's message shrinks as designed:** 44–67 tokens without the board, 612–697 with it. A live plan is smaller than the demo's (6–13 ops against 42), so its board is 635–667 tokens as `read_board` returned it, not 1,100.
- **`read_board` works end to end:** asked, the agent called it once and the browser answered with the board as drawn. Unasked, it never called it.
- **Whole-run cost doesn't separate the two designs.** The same design on the same task cost $0.366 and $0.618; both designs reach $0.65. Which commands ran, and how the agent chose to write its tests, decide more than the board does.
- **Commands.** Each run asked twice: once to append to a test file with a shell heredoc, once to run `npm test`. Answers came from an allowlist of test commands only. The heredoc was declined every time, and every agent then made the same change with its Edit tool. `npm test` was declined in four runs (piped into `grep`, or before the allowlist was in place); in those the tests never ran, and the agent said so. Each agent took each "no" once.
- **Cache writes cost more than the tables assume.** These runs cached with the 1-hour lifetime: writes billed at $8 per million tokens (twice the input price), not the 5-minute $5 the tables use. Whether a run with your own API key does the same isn't tested.

## Shorthand mode

Shorthand mode (`AGENT_SHORTHAND`, on by default since 2026-10-28; README, [Shorthand mode](../README.md#shorthand-mode)) is a "caveman" for the board. Caveman, a Claude Code skill, makes the model reply in terse English and claims 65–75% fewer output tokens; independent tests found 12–25% less output and 1–3% off the bill, because output is a small share of what a run costs. So shorthand mode goes after input as well as output:

- **Fewer tools.** A Claude run gets only the built-in tools agents used in every live run (Read, Glob, Grep, Edit, Write, Bash) and ExitPlanMode, which a `tools` list drops unless it's named (checked: without it the plan gate's call fails with "No such tool available").
- **Board ops as lines.** `update_board` takes one op per line (`edge web>api via=HTTP api="POST /ask"`), and its schema is one string instead of every op's fields. `read_board` and a carried-on session's `<board_state>` come back in the same lines.
- **Terse chat:** results first, file:line, numbers; names, errors, questions and the final summary stay whole.

The instructions grow by the line syntax and the chat style; every other rule is unchanged (`test/shorthand.test.js` checks each line of the standard instructions is still there). They weren't compressed: at most 3,149 tokens, read from the cache on every request at $0.20 per million, a shorter version would save under a cent a run and risks dropping a rule.

### Counted (scripts/token-study.mjs, section 12)

These are the counts at `112f34e`, the code the live A/B ran. The instructions have grown since: classifying each request as a question or a change, and the `class` op for the UML view. Rerun on 2026-10-28 after those, the fixed part per request is 5,230 tokens standard and 4,354 in shorthand (instructions 4,012, update_board 216, read_board 126): +412 in shorthand, about $0.003 more for a run's cold first request and well under a cent across its cached ones.

| Fixed, every request | Standard | Shorthand | Change |
|---|---:|---:|---:|
| Board instructions | 3,149 | 3,617 | +15% |
| update_board tool definition | 1,340 | 199 | −85% |
| read_board tool definition | 116 | 126 | +9% |
| **Total** | **4,605** | **3,942** | **−14%** |

| Board ops the agent writes (output) | JSON call | Lines call | Change |
|---|---:|---:|---:|
| First plan (42 ops, one call) | 1,878 | 1,498 | −20% |
| The three corrections' replies (6 ops) | 183 | 140 | −23% |
| The build (54 ops, 10 calls) | 1,086 | 743 | −32% |

| The board as the agent reads it (input) | JSON | Lines | Change |
|---|---:|---:|---:|
| `read_board` after each correction | 1,027–1,094 | 852–908 | −17% |
| Carry-on `<board_state>`, the three saved runs | 640–870 | 507–720 | −17 to −21% |

A lines call is counted as it's sent: inside the tool call's JSON, where the line's quotes and newlines are escaped (the bare lines are 3–10% shorter still). On the demo's full run, that's 663 tokens less on every request and 766 fewer output tokens: about $0.02 a run. The tool trim is the big lever, and it isn't in these counts.

### The whole first request (scripts/prompt-size.mjs)

A one-turn call with the run's own options (`ClaudeRun.queryOptions`), in plan mode, Claude Haiku 5.5:

| | Tools | First request |
|---|---:|---:|
| Standard | 44 built-in + 2 board | 41,795 |
| Shorthand | 7 built-in + 2 board | 15,214 (−64%) |

This cloud container's Claude Code ships tools a local install may not have (Artifact, Cron, Monitor, Workflow…), so on your machine the standard number, and the saving, is smaller. Claude Code's own prompt changes with its version: rerun the script for current numbers.

### Live A/B

The same task and correction as the earlier live runs ("Support custom aliases like /launch"; "Aliases are 3 to 20 letters, digits or dashes, and an alias that is already taken is refused."), Claude Opus 5.5 at effort `low`, driven through the UI by `scripts/live-run.cjs`, read with `scripts/live-usage.mjs`, on 2026-10-28 at `112f34e`. The sandbox was reset before each run, with the allowlist of test commands. Order: standard, shorthand, standard, shorthand, about 1.3 minutes each, so the first of each mode wrote its prompt to the cache (cold) and the second read it (warm).

| | Standard, cold | Shorthand, cold | Standard, warm | Shorthand, warm |
|---|---:|---:|---:|---:|
| **Cost** | **$0.668** | **$0.386** | **$0.383** | **$0.274** |
| Requests | 11 | 11 | 12 | 10 |
| First request | 40,897 | 14,307 | 40,897 | 14,305 |
| … of it written to the cache / read | 40,895 / 0 | 14,305 / 0 | 5,262 / 35,633 | 1,525 / 12,778 |
| Cache writes, whole run (1-hour) | 53,169 | 25,501 | 17,099 | 12,828 |
| Cache reads, whole run | 465,274 | 191,031 | 545,362 | 186,842 |
| Output | 7,493 | 7,175 | 6,842 | 6,682 |
| Chat text (o200k_base) | 203 | 196 | 240 | 187 |
| update_board calls (as lines) | 4 (0) | 5 (5) | 5 (0) | 5 (5) |
| update_board input (o200k_base) | 1,310 | 1,079 | 915 | 926 |
| Lines it couldn't draw | — | 0 | — | 0 |
| read_board | not called | not called | not called | not called |
| Tests ran | yes, 8/8 | yes, 8/8 | no | yes, 8/8 |
| Decisions proven | 3 of 3 | 3 of 3 | 0 of 3 | 3 of 3 |

- **Shorthand cost 42% less cold and 29% less warm.** Nearly all of it is input: the first request is 26,590 tokens smaller, and every later request re-reads that difference. Cold, the first request's cache write alone falls from $0.327 to $0.114 at the 1-hour rate.
- **Output barely moved:** 2–4% less. The board calls are shorter cold (−18%), and the same warm, where that plan had more ops. The chat was already short (187–240 tokens a run), and terse chat didn't change its size; the final summaries stayed whole and clear.
- **Same work done.** Every run finished with 8/8 tests passing (run again afterwards in the sandbox). The warm standard run didn't run its tests, because the driver's allowlist declined `npm test 2>&1 | grep -E "^(not ok|ok)…"` (the `|` inside the pattern made it look like a pipe into something else), so it proved none of its decisions. The other three each proved all three. Each agent tried one heredoc that was declined, then made the change with Edit or Write.
- **Every shorthand line drew:** 10 calls, no errors, the plan as complete as the standard runs' (project, phases, tasks, nodes, edges, parts, flows, decisions with checks).
- **So it's on by default.** The cost difference is larger than the run-to-run spread seen before ($0.37–$0.65 for the same design), cold and warm alike, and nothing it measured got worse. One run per cell is still few: the earlier live runs showed how much one run can vary. What it gives up: the agent can't search the web, fetch URLs or start subagents, which no recorded run had used.

## Caveats

- **The tokenizer.** o200k_base is exact for OpenAI's GPT-5 family (Codex), not for Claude. Anthropic's guidance (the `claude-api` skill) is that tiktoken undercounts Claude by about 15–20% on text, and more on code. The board's JSON may be undercounted more than prose, so its share is likely understated. Set `ANTHROPIC_API_KEY` for exact counts.
- **The tables use the scripted demo.** A real agent writes other words, may send more or fewer ops, and may batch them differently: the recorded runs made 4–5 calls each, where the demo's pace gives 14. The six live runs are too few, and too varied, to settle the whole-run cost.
- **Reads.** The default reads nothing after a correction, as the demo's agent does; the live agents read only when asked. A real agent told less plainly might read more, and each read costs more than the snapshot it replaced, because it adds a request.
- **Cache lifetime.** The tables price writes at the 5-minute rate and count a slow reply (over 5 minutes) as a cold cache. The live runs cached for an hour, at $8 per million to write: dearer writes, but far fewer cold turns.
- **Thinking.** Opus 5.5 always thinks (at effort `low` here). Thinking is billed as output and isn't counted. The board could change how much it thinks.
- **Claude Code's own context isn't counted.** The whiteboard makes 14 more requests than B in the full run (20 more with reads), and each one re-reads that context too: $0.0280 for every 10k tokens of it. None of that happens if the agent sends `update_board` and `read_board` alongside its other tool calls.
- **Plan-mode mechanics are left out of both:** plan-file writes, `ExitPlanMode` round trips, and the file snippet an Edit returns. `PLAN_INSTRUCTIONS` is counted in full, though it replaces Claude Code's default plan text.
- **A sees no repo.** To plan as well as the agent, you'd paste code into the chat. That isn't counted.
- **The recorded runs predate `read_board`.** Their agents had older instructions and sent fewer kinds of ops (no parts, flows or tables), and their board share for the new design is counted, not measured.
- **Not measured:** latency (every extra request is another round trip, and a read waits for the browser, up to 5 seconds), and whether the plans or the steering are any better.
- **Prices** come from the `claude-api` skill, cached 2026-10-06. Check [Anthropic's pricing](https://www.anthropic.com/pricing) before budgeting on them.
