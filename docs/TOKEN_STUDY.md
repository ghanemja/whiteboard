# Token cost: the whiteboard vs. a chat assistant

How many tokens does a task take with the whiteboard, compared with a normal chatbot? This study counts them for the DocQA demo task. It counts exact text with a tokenizer: no model was run, because there was no API key where it was made. `scripts/token-study.mjs` computes every number here (rerun on 2026-10-27, after the instructions gained a section on carrying on from a saved board and the decision log's diagrams gained layer colors; the instructions keep changing, so rerun it for current numbers).

## Summary

| Condition | 1. First plan | 2. Plan + 3 corrections | 3. Full run (counted part) |
|---|---:|---:|---:|
| A: chat, rewrites the plan | $0.0287 (23 in, 1,428 out) | $0.1475 (8,779 in, 5,618 out) | n/a |
| A: chat, changes only | $0.0287 (23 in, 1,428 out) | $0.0519 (4,685 in, 1,660 out) | n/a |
| B: agent, no board | $0.0287 (23 in, 1,428 out) | $0.0487 (4,866 in, 1,972 out) | $0.0551 (29,262 in, 1,972 out) |
| Whiteboard | $0.0741 (11,142 in, 2,012 out) | $0.1079 (65,448 in, 2,254 out) | $0.1826 (302,884 in, 3,340 out) |
| **Whiteboard − B** | **+$0.0454 (+11,119 in, +584 out)** | **+$0.0592 (+60,582 in, +282 out)** | **+$0.1275 (+273,622 in, +1,368 out)** |

Prices are Claude Opus 5.5's. "In" sums the input of every request, resent history included. B and the whiteboard leave out what they share (Claude Code's own prompt and tools, the repo reads, the build work), so neither is a whole run's bill. Their difference is the board's cost.

- **The board adds 4,402 tokens to every request:** 3,062 of instructions and 1,340 of tool schema. Prompt caching makes that cheap after the first request: $0.0009 per request, after a $0.0220 cache write.
- **In real runs, the board is roughly a quarter to a third of the bill.** Three recorded runs cost $0.2045–$0.3728 each, by the Agent SDK's own count. The board's part is an estimated 22–36% of that.
- **Ops are not shorter than prose.** The DocQA plan is 1,878 tokens as `update_board` JSON, plus 134 of chat. The same plan in markdown is 1,428: the board writes 41% more.
- **Steering only saves against a chat that rewrites the plan.** The board's reply to a correction is 42–104 tokens; a chat that rewrites the plan writes 1,309–1,442. So the board is cheaper from 2 corrections on. It never catches up with B, or with a chat that states only the change: every board message carries a 1,094–1,101-token snapshot (94% of the message), where a typed sentence is 10–17 tokens.
- **Slow replies at the plan gate double the extra cost.** Take more than 5 minutes per turn and the cache expires: the board's extra cost for the full run goes from $0.1275 to $0.2667.

- **Carrying on from a saved board costs one message.** A new session on a saved board starts with the task, the saved run's decision log as its handover and the board: 3,581–5,092 tokens for the three real runs. That's about $0.02 to write to the cache once and $0.001 per later request, and the new session doesn't resend the old conversation.

The counts use OpenAI's o200k_base tokenizer, so Claude's real counts are likely higher (see [Caveats](#caveats)). With `ANTHROPIC_API_KEY` set, the script gives exact Claude counts.

## What's compared

- **A: a chat assistant.** It writes the plan as markdown. You steer by typing sentences. It resends the whole conversation every turn, uncached. Two versions: after a correction it either rewrites the whole plan, or says only what changed.
- **B: the same coding agent without the board.** Claude Code through the Agent SDK, with no board instructions, no `update_board` tool and no snapshots. It writes the plan in markdown and edits it for each correction. **Whiteboard − B is the board's true overhead.**
- **Whiteboard:** the agent as `server/runs.js` runs it.

**Models.** Claude: `claude-opus-5-5` at effort `low` (`settings()` in `server/runs.js`; `AGENT_MODEL` and `AGENT_EFFORT` change them). Codex (`AGENT_ENGINE=codex`): Codex's default model and effort. The three real runs used `claude-opus-5-5` at effort `low`.

**Prices** (Opus 5.5, per million tokens): input $4.00, output $20.00, cache write (5 minutes) $5.00, cache read $0.20. They come from the `claude-api` skill's model table (cached 2026-10-06) and its Opus 5.5 notes. Codex isn't priced: OpenAI's prices couldn't be checked here.

**Metrics:** input and output tokens, the cache write/read split, cost per scenario, user turns and model requests, fixed overhead per request, context size per turn, tokens per correction, and the break-even point.

## Method

- **Exact text, estimated counts.** Everything counted is real text:
  - the board instructions and tool schema (`server/instructions.js`, `server/board-tool.js`; the zod schema turned into JSON Schema the way the MCP SDK does it);
  - the messages the agent gets at the plan gate, built by `ClaudeRun.control()` itself;
  - the browser's `<board_state>`, from a copy of `Board.snapshot()` (board.js needs Excalidraw, so it can't load in Node);
  - the DocQA demo as the agent's output (`src/agent/script.js`, `src/agent/replies.js`), its tags turned into `update_board` JSON. Demo-only tags (`tour`, `ask`, `run`, `diff`) are dropped.
- **The prose plan** is `Run.planMarkdown()` of the same ops. Its Mermaid diagrams are dropped, since they redraw its tables. What it leaves to the diagrams or the board is added: parts, flows, tables and steps. So both forms carry the same information.
- **Requests.** One per user turn. The whiteboard adds one per `update_board` call, because the call's result goes back to the model. Every request resends everything before it.
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

## Results

### Fixed overhead per request

| Piece | Where | Tokens |
|---|---|---:|
| BOARD_INSTRUCTIONS | appended to the system prompt | 3,062 |
| update_board tool definition | tools (name, description, JSON schema) | 1,340 |
| **Total, every request** | cached prefix | **4,402** |
| PLAN_INSTRUCTIONS | once, in plan mode (replaces Claude Code's default plan text; counted in full) | 137 |
| Codex: CODEX_BOARD_INSTRUCTIONS | developer instructions, every request | 3,079 |
| Codex: update_board over MCP | tools, every request | 1,335 |
| Codex: CODEX_PLAN_INSTRUCTIONS | once, in the first turn | 145 |

Cached, the 4,402 tokens cost $0.0009 per request, after a $0.0220 write. Uncached, $0.0176 per request. The instructions' section on carrying on from a saved board is 159 of them. For Codex, o200k_base is its own tokenizer, so those counts hold (message framing aside).

### Writing the plan

| Form | What | Tokens |
|---|---|---:|
| Prose plan (A, B) | planMarkdown() without its diagrams, plus parts, flows, tables and steps | 1,428 |
| Whiteboard: update_board call | 42 ops as JSON, one call | 1,878 |
| Whiteboard: chat text | the demo's narration around the ops | 134 |
| **Whiteboard total** |  | **2,012** (+41% vs prose) |
| For reference: the decision log's plan | planMarkdown() as written, with its Mermaid diagrams | 2,075 |

JSON repeats its keys (`"op"`, `"id"`, `"of"`…) in every op, where a markdown table names its columns once.

### One correction: typed vs. on the board

What you send:

| Correction | Typed sentence (A, B) | Board: the edit or answer itself | Board: <board_state> | Board: whole message to the agent |
|---|---:|---:|---:|---:|
| Another option for D1 | 17 | 58 | 1,094 | 1,181 |
| Answer Q1 (50 MB) | 11 | 13 | 1,101 | 1,142 |
| Not needed on the ingest worker | 10 | 58 | 1,101 | 1,188 |

The whole message is what `runs.js` sends at the plan gate: the edit, the snapshot and a wrapper sentence. The snapshot is 94% of it on average.

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
| 1 · Whiteboard | 1 | 2 | 0 | 6,580 | 4,562 | 2,012 | $0.0741 |
| 2 · A chat, rewrites | 4 | 4 | 8,779 | 0 | 0 | 5,618 | $0.1475 |
| 2 · A chat, changes only | 4 | 4 | 4,685 | 0 | 0 | 1,660 | $0.0519 |
| 2 · B agent, no board | 4 | 4 | 0 | 1,723 | 3,143 | 1,972 | $0.0487 |
| 2 · Whiteboard | 4 | 8 | 0 | 10,351 | 55,097 | 2,254 | $0.1079 |
| 3 · B agent, no board | 5 | 16 | 0 | 2,033 | 27,229 | 1,972 | $0.0551 |
| 3 · Whiteboard | 5 | 30 | 0 | 11,497 | 291,387 | 3,340 | $0.1826 |

Most of the whiteboard's input is cache reads, which cost a twentieth of the input price. So its big input counts cost less than they look.

### How the context grows

Input tokens of the request that answers each user turn:

| User turn | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard | Whiteboard − B |
|---|---:|---:|---:|---:|---:|
| Plan | 23 | 23 | 23 | 4,562 | +4,539 |
| Another option for D1 | 1,468 | 1,468 | 1,468 | 7,761 | +6,293 |
| Answer Q1 (50 MB) | 2,918 | 1,571 | 1,652 | 9,013 | +7,361 |
| Not needed on the ingest worker | 4,370 | 1,623 | 1,723 | 10,249 | +8,526 |

After the full run the whiteboard's context is 11,497 tokens and B's is 2,033. Every further request re-reads the 9,464-token difference, for $0.0019 cached.

### Where the extra cost goes

| Scenario | Fixed overhead | Extra output | Snapshots, results, bigger history | Total |
|---|---:|---:|---:|---:|
| 1. First plan | $0.0229 | $0.0117 | $0.0108 | **$0.0454** |
| 2. Plan + 3 corrections | $0.0282 | $0.0056 | $0.0254 | **$0.0592** |
| 2, cache cold at each correction | $0.0916 | $0.0056 | $0.0597 | **$0.1569** |
| 3. Full run | $0.0475 | $0.0274 | $0.0526 | **$0.1275** |
| 3, cache cold at each user turn | $0.1321 | $0.0274 | $0.1073 | **$0.2667** |

"Cold": you take more than 5 minutes before a turn, so that request writes the whole context again at $5.00 instead of reading it at $0.20. The build alone adds 10 `update_board` calls, 54 ops, 1,086 output tokens ($0.0217) and 60 tokens of tool results.

### Break-even

Cost after k corrections:

| Corrections | A chat (rewrites) | A chat (changes only) | B agent, no board | Whiteboard |
|---|---:|---:|---:|---:|
| 0 | $0.0287 | $0.0287 | $0.0287 | $0.0741 |
| 1 | $0.0633 | $0.0364 | $0.0394 | $0.0855 |
| 3 | $0.1475 | $0.0519 | $0.0487 | $0.1079 |
| 5 | $0.2565 | $0.0689 | $0.0567 | $0.1324 |
| 10 | $0.6227 | $0.1192 | $0.0847 | $0.2050 |
| 20 | $1.7807 | $0.2448 | $0.1363 | $0.3844 |

Each correction adds, on average: A rewriting $0.0396, A with changes only $0.0078, B $0.0067, the whiteboard $0.0113. So the whiteboard is cheaper than a chat that rewrites the plan from 2 corrections on. It is never cheaper (up to 100 corrections) than a chat that gives only the changes, or than B. Corrections past the third repeat the three measured ones.

### Real runs

Three runs of the whiteboard with Claude, recorded in `fixtures/recordings/`:

| Run | Task | Turns | Measured cost | Board calls (ops) | Board output | Board input added | Board cost (est.) | Share |
|---|---|---:|---:|---:|---:|---|---:|---:|
| 6e0ae61d | Let links expire after a given number of days | 14 | $0.3728 | 5 (47) | 1,789 | 4,402/turn + 943 | $0.0829–$0.0900 | 22–24% |
| dafce9c8 | Count clicks per link and add GET /stats/:code | 16 | $0.2203 | 4 (32) | 1,329 | 4,402/turn + 794 | $0.0724–$0.0788 | 33–36% |
| f0b64cdb | Support custom aliases like /launch | 13 | $0.2045 | 4 (31) | 989 | 4,402/turn + 740 | $0.0610–$0.0651 | 30–32% |

All three: `claude-opus-5-5`, effort `low`. Measured cost and turns are the Agent SDK's own figures (`total_cost_usd`, `num_turns`, which counts model round trips). Board input added: the fixed overhead on every turn, plus tool results, the snapshots and wrappers sent at the gate, and the plan-mode instructions. The low estimate writes every board token to the cache once and reads the fixed overhead on every turn. The high one also re-reads every board token on every later turn.

### Carrying on from a saved board

**Done** on a saved run keeps its board, and the next thing you send starts a new session on it (HANDOFF 4.17). That session's first message is the task, the saved run's decision log (the handover) and the board, built by `Run.firstTurn` in `runs.js`. Here it is for a next task ("Add a GET /health endpoint that reports how many links are stored", 13 tokens) on each real run's board:

| Saved run | Decision log (handover) | <board_state> | Whole first message | Written to the cache once | Read by each later request |
|---|---:|---:|---:|---:|---:|
| 6e0ae61d | 4,185 | 877 | 5,092 | $0.0255 | $0.0010 |
| dafce9c8 | 2,930 | 761 | 3,719 | $0.0186 | $0.0007 |
| f0b64cdb | 2,905 | 647 | 3,581 | $0.0179 | $0.0007 |

The decision log is the one the server writes for that run today (`renderDecisions` over its recording). It's about 600 tokens longer than the logs saved with these runs, which the server wrote before the plan gained its data flow, database and sequence diagrams and their layer colors. The rest of the new session costs what any run does: the same 4,402 fixed tokens per request. It doesn't resend the earlier session's conversation, because it starts a fresh one.

## Caveats

- **The tokenizer.** o200k_base is exact for OpenAI's GPT-5 family (Codex), not for Claude. Anthropic's guidance (the `claude-api` skill) is that tiktoken undercounts Claude by about 15–20% on text, and more on code. The board's JSON may be undercounted more than prose, so its share is likely understated. Set `ANTHROPIC_API_KEY` for exact counts.
- **No live runs.** The agent's output here is the scripted demo. A real agent writes other words, may send more or fewer ops, and may batch them differently: the real runs made 4–5 calls each, where the demo's pace gives 14.
- **Thinking.** Opus 5.5 always thinks (at effort `low` here). Thinking is billed as output and isn't counted. The board could change how much it thinks.
- **Claude Code's own context isn't counted.** The whiteboard makes 14 more requests than B in the full run, and each one re-reads that context too: $0.0280 for every 10k tokens of it. None of that happens if the agent sends `update_board` alongside its other tool calls.
- **Plan-mode mechanics are left out of both:** plan-file writes, `ExitPlanMode` round trips, and the file snippet an Edit returns. `PLAN_INSTRUCTIONS` is counted in full, though it replaces Claude Code's default plan text.
- **A sees no repo.** To plan as well as the agent, you'd paste code into the chat. That isn't counted.
- **The real-run estimates use today's instructions.** Those runs had older ones, and their agents sent fewer kinds of ops (no parts, flows or tables).
- **Not measured:** latency (every extra request is another round trip), and whether the plans or the steering are any better.
- **Prices** come from the `claude-api` skill, cached 2026-10-06. Check [Anthropic's pricing](https://www.anthropic.com/pricing) before budgeting on them.
