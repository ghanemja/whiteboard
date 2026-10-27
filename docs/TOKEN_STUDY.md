# Token cost: the whiteboard vs. a chat assistant

How many tokens does a task take with the whiteboard, compared with a normal chatbot? This study counts them for the DocQA demo task. It counts exact text with a tokenizer: no model was run, because there was no API key where it was made. `scripts/token-study.mjs` computes every number here (run on 2026-10-27, for the design where messages carry only what changed; the instructions keep changing, so rerun it for current numbers).

## Summary

| Condition | 1. First plan | 2. Plan + 3 corrections | 3. Full run (counted part) |
|---|---:|---:|---:|
| A: chat, rewrites the plan | $0.0287 (23 in, 1,428 out) | $0.1475 (8,779 in, 5,618 out) | n/a |
| A: chat, changes only | $0.0287 (23 in, 1,428 out) | $0.0519 (4,685 in, 1,660 out) | n/a |
| B: agent, no board | $0.0287 (23 in, 1,428 out) | $0.0487 (4,866 in, 1,972 out) | $0.0551 (29,262 in, 1,972 out) |
| Whiteboard | $0.0742 (11,206 in, 2,012 out) | $0.0896 (52,546 in, 2,254 out) | $0.1500 (218,240 in, 3,340 out) |
| Whiteboard, reads the board after each correction | $0.0742 (11,206 in, 2,012 out) | $0.1174 (110,594 in, 2,284 out) | $0.1920 (347,568 in, 3,370 out) |
| **Whiteboard − B** | **+$0.0455 (+11,183 in, +584 out)** | **+$0.0409 (+47,680 in, +282 out)** | **+$0.0949 (+188,978 in, +1,368 out)** |
| Whiteboard − B, reads after each correction | +$0.0455 (+11,183 in, +584 out) | +$0.0687 (+105,728 in, +312 out) | +$0.1369 (+318,306 in, +1,398 out) |

Prices are Claude Opus 5.5's. "In" sums the input of every request, resent history included. B and the whiteboard leave out what they share (Claude Code's own prompt and tools, the repo reads, the build work), so neither is a whole run's bill. Their difference is the board's cost.

- **Messages carry only what changed.** A correction's message to the agent is 42–88 tokens, down from 1,142–1,188, because the board is no longer sent with it. The agent calls `read_board` for the whole board when it needs it. A read returns about 1,070 tokens.
- **The board's extra cost is lower than before, by about a quarter to a third.** Over B, plan + 3 corrections costs +$0.0409 (was +$0.0582), and the full run +$0.0949 (was +$0.1258). The first plan costs slightly more (+$0.0455, was +$0.0446), because the fixed overhead grew.
- **It still processes far more input than B.** The full run takes 218,240 input tokens against 29,262 for B, about 7.5 times as many. Most of the board's input is cache reads: 96% in the full run.
- **Reads are the swing factor.** If the agent reads the board after every correction, the board costs more than it did before: +$0.0687 for plan + 3 corrections and +$0.1369 for the full run. Each read is an extra request, and every request re-reads the whole context.
- **In real runs the saving is small.** The board's share is 21–34% of the measured cost, close to the 22–35% before. The fixed overhead is paid on every turn, and the recorded runs had few corrections to save on. See [Real runs](#real-runs).
- **Ops are not shorter than prose.** The DocQA plan is 1,878 tokens as `update_board` JSON, plus 134 of chat. The same plan in markdown is 1,428: the board writes 41% more.
- **Steering only saves against a chat that rewrites the plan.** The board's reply to a correction is 42–104 tokens; a chat that rewrites the plan writes 1,309–1,442. So the board is cheaper from 2 corrections on. Against a chat that states only the change, it now breaks even at 12 corrections (it never did before). It never catches up with B.
- **Slow replies at the plan gate raise the extra cost.** Take more than 5 minutes per turn and the cache expires: the full run's extra cost goes from $0.0949 to $0.2032 (from $0.2619 before).

The counts use OpenAI's o200k_base tokenizer, so Claude's real counts are likely higher (see [Caveats](#caveats)). With `ANTHROPIC_API_KEY` set, the script gives exact Claude counts.

## What changed

Before this change, every message carried the whole board as `<board_state>`. Now a message carries only the user's edits (and any assumptions they confirmed since the last message), and the agent reads the board with `read_board`. The "before" column is the script's output at commit `9edb62c`, the commit this change started from.

| | Before: whole board in each message | Now: edits in each message, `read_board` on demand |
|---|---:|---:|
| Fixed overhead per request | 4,243 | 4,434 (+191: 116 for `read_board`, 75 for longer instructions) |
| Message per correction, to the agent | 1,142–1,188 | 42–88 |
| Context at the last correction (plan + 3) | 10,090 | 6,988 |
| Whiteboard input, plan + 3 corrections | 64,176 | 52,546 |
| Whiteboard input, full run | 298,114 | 218,240 |
| Whiteboard − B, first plan | +$0.0446 | +$0.0455 |
| Whiteboard − B, plan + 3 corrections | +$0.0582 | +$0.0409 |
| Whiteboard − B, full run | +$0.1258 | +$0.0949 |
| Whiteboard − B, full run, cache cold at each turn | +$0.2619 | +$0.2032 |
| Whiteboard − B, with a read after each correction | n/a (no read tool) | +$0.0687 (plan + 3), +$0.1369 (full run) |
| Real runs: board share of measured cost | 22–24%, 32–35%, 29–31% | 21–23%, 32–34%, 29–30% (counted for the new messages) |

## What's compared

- **A: a chat assistant.** It writes the plan as markdown. You steer by typing sentences. It resends the whole conversation every turn, uncached. Two versions: after a correction it either rewrites the whole plan, or says only what changed.
- **B: the same coding agent without the board.** Claude Code through the Agent SDK, with no board instructions, no `update_board` or `read_board` tool and no board state. It writes the plan in markdown and edits it for each correction. **Whiteboard − B is the board's true overhead.**
- **Whiteboard:** the agent as `server/runs.js` runs it: messages carry the edits, and the agent has `update_board` and `read_board`.
- **Whiteboard, reads after each correction:** the same, plus one `read_board` call after each correction. It's the most reads a message-only design is likely to cost.

**Models.** Claude: `claude-opus-5-5` at effort `low` (`settings()` in `server/runs.js`; `AGENT_MODEL` and `AGENT_EFFORT` change them). Codex (`AGENT_ENGINE=codex`): Codex's default model and effort. The three real runs used `claude-opus-5-5` at effort `low`.

**Prices** (Opus 5.5, per million tokens): input $4.00, output $20.00, cache write (5 minutes) $5.00, cache read $0.20. They come from the `claude-api` skill's model table (cached 2026-10-06) and its Opus 5.5 notes. Codex isn't priced: OpenAI's prices couldn't be checked here.

**Metrics:** input and output tokens, the cache write/read split, cost per scenario, user turns and model requests, fixed overhead per request, context size per turn, tokens per correction, and the break-even point.

## Method

- **Exact text, estimated counts.** Everything counted is real text:
  - the board instructions and tool schemas (`server/instructions.js`, `server/board-tool.js`; the zod schemas turned into JSON Schema the way the MCP SDK does it);
  - the messages the agent gets at the plan gate, built by `ClaudeRun.control()` itself;
  - the board state that `read_board` returns, from a copy of `Board.snapshot()` (board.js needs Excalidraw, so it can't load in Node);
  - the DocQA demo as the agent's output (`src/agent/script.js`, `src/agent/replies.js`), its tags turned into `update_board` JSON. Demo-only tags (`tour`, `ask`, `run`, `diff`) are dropped.
- **The browser's side of a read.** A `read_board` request reaches the browser as a `board-read` event on the run's stream, and the browser answers with `Board.snapshot()`: the copy the study counts. The round trip itself (`session.js`, `POST /api/runs/:id/board`) isn't run here.
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
```

With neither js-tiktoken nor a key, it falls back to characters ÷ 4 and says so. `TOKENIZER_DIR` points it at js-tiktoken installed somewhere else.

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
| BOARD_INSTRUCTIONS | appended to the system prompt | 2,978 |
| update_board tool definition | tools (name, description, JSON schema) | 1,340 |
| read_board tool definition | tools (name, description, JSON schema) | 116 |
| **Total, every request** | cached prefix | **4,434** |
| PLAN_INSTRUCTIONS | once, in plan mode (replaces Claude Code's default plan text; counted in full) | 137 |
| Codex: CODEX_BOARD_INSTRUCTIONS | developer instructions, every request | 2,995 |
| Codex: update_board over MCP | tools, every request | 1,335 |
| Codex: read_board over MCP | tools, every request | 111 |
| Codex: CODEX_PLAN_INSTRUCTIONS | once, in the first turn | 145 |

Cached, the 4,434 tokens cost $0.0009 per request, after a $0.0222 write. Uncached, $0.0177 per request. For Codex, o200k_base is its own tokenizer, so those counts hold (message framing aside).

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

The whole message is what `runs.js` sends at the plan gate: the edit or answer and its own wrapper sentence, 73 tokens on average. Before this change it also carried the board: 1,094–1,101 tokens of snapshot, 94% of a message of 1,142–1,188. Now the board comes only through `read_board`, which returns about 1,070 tokens, plus 10 for the call.

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
| 1 · Whiteboard | 1 | 2 | 0 | 6,612 | 4,594 | 2,012 | $0.0742 |
| 2 · A chat, rewrites | 4 | 4 | 8,779 | 0 | 0 | 5,618 | $0.1475 |
| 2 · A chat, changes only | 4 | 4 | 4,685 | 0 | 0 | 1,660 | $0.0519 |
| 2 · B agent, no board | 4 | 4 | 0 | 1,723 | 3,143 | 1,972 | $0.0487 |
| 2 · Whiteboard | 4 | 8 | 0 | 7,090 | 45,456 | 2,254 | $0.0896 |
| 2 · Whiteboard, reads after each correction | 4 | 14 | 0 | 10,330 | 100,264 | 2,284 | $0.1174 |
| 3 · B agent, no board | 5 | 16 | 0 | 2,033 | 27,229 | 1,972 | $0.0551 |
| 3 · Whiteboard | 5 | 30 | 0 | 8,236 | 210,004 | 3,340 | $0.1500 |
| 3 · Whiteboard, reads after each correction | 5 | 36 | 0 | 11,476 | 336,092 | 3,370 | $0.1920 |

Most of the whiteboard's input is cache reads: 96% in the full run. So its big input counts cost less than they look. Reads add requests: scenario 2 goes from 8 requests to 14, and the full run from 30 to 36.

### How the context grows

Input tokens of the request that answers each user turn:

| User turn | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard | Whiteboard − B |
|---|---:|---:|---:|---:|---:|
| Plan | 23 | 23 | 23 | 4,594 | +4,571 |
| Another option for D1 | 1,468 | 1,468 | 1,468 | 6,700 | +5,232 |
| Answer Q1 (50 MB) | 2,918 | 1,571 | 1,652 | 6,852 | +5,200 |
| Not needed on the ingest worker | 4,370 | 1,623 | 1,723 | 6,988 | +5,265 |

After the full run the whiteboard's context is 8,236 tokens and B's is 2,033 (11,338 and 2,033 before this change). Every further request re-reads the 6,203-token difference, for $0.0012 cached.

### Where the extra cost goes

| Scenario | Fixed overhead | Extra output | Messages, results, bigger history | Total |
|---|---:|---:|---:|---:|
| 1. First plan | $0.0231 | $0.0117 | $0.0108 | **$0.0455** |
| 2. Plan + 3 corrections | $0.0284 | $0.0056 | $0.0069 | **$0.0409** |
| 2, cache cold at each correction | $0.0922 | $0.0056 | $0.0255 | **$0.1234** |
| 3. Full run | $0.0479 | $0.0274 | $0.0197 | **$0.0949** |
| 3, cache cold at each user turn | $0.1330 | $0.0274 | $0.0428 | **$0.2032** |

"Cold": you take more than 5 minutes before a turn, so that request writes the whole context again at $5.00 instead of reading it at $0.20. The build alone adds 10 `update_board` calls, 54 ops, 1,086 output tokens ($0.0217) and 60 tokens of tool results. Before this change, the messages and results cost $0.0254 in scenario 2 and $0.0526 in scenario 3, and the fixed overhead $0.0272 and $0.0458.

### Break-even

Cost after k corrections:

| Corrections | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard |
|---|---:|---:|---:|---:|
| 0 | $0.0287 | $0.0287 | $0.0287 | $0.0742 |
| 1 | $0.0633 | $0.0364 | $0.0394 | $0.0800 |
| 3 | $0.1475 | $0.0519 | $0.0487 | $0.0896 |
| 5 | $0.2565 | $0.0689 | $0.0567 | $0.0998 |
| 10 | $0.6227 | $0.1192 | $0.0847 | $0.1285 |
| 20 | $1.7807 | $0.2448 | $0.1363 | $0.1873 |

Each correction adds, on average: A rewriting $0.0396, A with changes only $0.0078, B $0.0067, the whiteboard $0.0051 (was $0.0112). So the whiteboard is cheaper than a chat that rewrites the plan from 2 corrections on, and than a chat that gives only the changes from 12. It is never cheaper (up to 100 corrections) than B. Corrections past the third repeat the three measured ones.

### Real runs

Three runs of the whiteboard with Claude, recorded in `fixtures/recordings/`:

| Run | Task | Turns | Measured cost | Board calls (ops) | Board output | Board input added | Board cost (est.) | Share |
|---|---|---:|---:|---:|---:|---|---:|---:|
| 6e0ae61d | Let links expire after a given number of days | 14 | $0.3728 | 5 (47) | 1,789 | 4,434/turn + 196 | $0.0794–$0.0846 | 21–23% |
| dafce9c8 | Count clicks per link and add GET /stats/:code | 16 | $0.2203 | 4 (32) | 1,329 | 4,434/turn + 190 | $0.0696–$0.0742 | 32–34% |
| f0b64cdb | Support custom aliases like /launch | 13 | $0.2045 | 4 (31) | 989 | 4,434/turn + 190 | $0.0585–$0.0613 | 29–30% |

All three: `claude-opus-5-5`, effort `low`. Measured cost and turns are the Agent SDK's own figures (`total_cost_usd`, `num_turns`, which counts model round trips). These runs were recorded with the whole board in every message, so their measured cost is the old design's. The board cost above is counted for the new messages, with no reads: the fixed overhead per turn, plus tool results, the edits and wrappers sent at the gate, and the plan-mode instructions. The low estimate writes every board token to the cache once and reads the fixed overhead on every turn. The high one also re-reads every board token on every later turn.

Before this change the same runs' board cost was $0.0817–$0.0888, $0.0711–$0.0775 and $0.0598–$0.0640. The saving is 2–5%. The message part drops by 550–750 tokens a run, but the fixed overhead adds 191 on every turn, which takes back 40–50% of that over 13–16 turns.

## Caveats

- **The tokenizer.** o200k_base is exact for OpenAI's GPT-5 family (Codex), not for Claude. Anthropic's guidance (the `claude-api` skill) is that tiktoken undercounts Claude by about 15–20% on text, and more on code. The board's JSON may be undercounted more than prose, so its share is likely understated. Set `ANTHROPIC_API_KEY` for exact counts.
- **No live runs.** The agent's output here is the scripted demo. A real agent writes other words, may send more or fewer ops, and may batch them differently: the real runs made 4–5 calls each, where the demo's pace gives 14.
- **Reads are the swing factor.** The default reads nothing after a correction, as the demo's agent does. The instructions ask for a read only when the whole picture is needed, but they're a request to the model, and how often a real agent reads is not measured. Each read costs more than the snapshot it replaced, because it adds a request that re-reads the whole context.
- **Thinking.** Opus 5.5 always thinks (at effort `low` here). Thinking is billed as output and isn't counted. The board could change how much it thinks.
- **Claude Code's own context isn't counted.** The whiteboard makes 14 more requests than B in the full run (20 more with reads), and each one re-reads that context too: $0.0280 for every 10k tokens of it. None of that happens if the agent sends `update_board` and `read_board` alongside its other tool calls.
- **Plan-mode mechanics are left out of both:** plan-file writes, `ExitPlanMode` round trips, and the file snippet an Edit returns. `PLAN_INSTRUCTIONS` is counted in full, though it replaces Claude Code's default plan text.
- **A sees no repo.** To plan as well as the agent, you'd paste code into the chat. That isn't counted.
- **The real runs predate this change.** They were recorded with the whole board in every message, and their agents sent fewer kinds of ops (no parts, flows or tables). Their board share for the new design is counted, not measured.
- **Not measured:** latency (every extra request is another round trip, and a read waits for the browser, up to 5 seconds), how often a real agent reads, and whether the plans or the steering are any better.
- **Prices** come from the `claude-api` skill, cached 2026-10-06. Check [Anthropic's pricing](https://www.anthropic.com/pricing) before budgeting on them.
