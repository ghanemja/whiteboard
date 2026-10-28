// The whiteboard's one tool, update_board: the ops an agent draws with. Claude gets it in-process
// (runs.js); any other agent over MCP's HTTP transport (board-mcp.js). Both draw through Run.emitOps.
import { z } from "zod";
import { LAYERS } from "../src/engine/views.js";
import { issues, parseLines, stateLines } from "./shorthand.js";

// One board op. Mirrors Board.apply() in src/engine/board.js.
const strs = z.array(z.string());
export const Op = z.object({
  op: z.enum(["project", "phase", "task", "node", "part", "edge", "flow", "table", "status", "decision", "question", "assumption", "rename", "note", "remove", "unlink", "adopt", "adopt-edge", "adopt-note", "answer"]),
  id: z.string().optional().describe("component id (node/status/rename/remove/adopt), part id (part, e.g. api.ask), task id (task), decision id (decision), flow id (flow), q1… (question) or a1… (assumption)"),
  name: z.string().optional().describe("project name, phase name, component name (≤16 chars, sentence case), part name (≤24 chars), or flow name (≤24 chars)"),
  layer: z.enum(LAYERS.map((l) => l.key)).optional().describe("node: frontend | backend | data | ml | external (defaults from kind; set ml for models, embeddings, evals); part: only when it differs from its component's"),
  steps: z.union([z.string(), strs]).optional().describe('flow: the steps in order, each "from>to: what", e.g. ["web>api: POST /ask", "api>vdb: top 8 chunks"]'),
  of: z.string().optional().describe("table: the id of the data component that holds it; part: the id of the component it's inside"),
  links: z.union([z.string(), strs]).optional().describe('part: what it hands on, each "target: what" with target a part, table or component id, e.g. ["api.retrieve: the question", "vdb: nearest 8 chunks"]'),
  columns: z.union([z.string(), strs]).optional().describe('table: its columns, each "name type [pk] [unique] [fk>table.column]", e.g. ["id uuid pk", "document_id uuid fk>documents.id", "page int"]'),
  goal: z.string().optional().describe("project: the goal in one sentence"),
  kind: z.string().optional().describe("node: client | service | data | external | queue | test | user; part: one word, e.g. page, view, route, job, module, step, model, index, bucket, dataset"),
  col: z.number().int().min(0).max(2).optional(),
  row: z.number().int().min(0).max(2).optional(),
  paths: strs.optional().describe("node: repo-relative files or folders this component owns"),
  libs: strs.optional().describe("node: libraries/frameworks/runtimes it uses, with versions when known, main one first"),
  api: z.union([z.string(), strs]).optional().describe("node: the interface it exposes (endpoints, functions, events); edge: the exact call"),
  from: z.string().optional(),
  to: z.string().optional(),
  via: z.string().optional().describe("edge: protocol or mechanism, ≤8 chars ideally (HTTP, SQL, call, queue, event)"),
  style: z.enum(["sync", "async"]).optional(),
  v: z.enum(["planned", "building", "built", "verified", "failed", "live"]).optional().describe("component status"),
  phase: z.string().optional(),
  text: z.string().optional().describe("task text (≤26 chars), note text, the question / assumption (≤60 chars), or your answer to a sticker (one or two short sentences)"),
  status: z.enum(["todo", "building", "done", "failed"]).optional().describe("task status"),
  title: z.string().optional().describe("decision: what was decided, as a short question or topic"),
  chose: z.string().optional().describe("decision: the option chosen"),
  over: strs.optional().describe("decision: the alternatives considered and not chosen"),
  why: z.string().optional().describe("decision: the reasoning, one or two sentences"),
  affects: strs.optional().describe("decision: ids of the components it shapes"),
  evidence: strs.optional().describe("decision: facts from the repo behind it, with file paths"),
  builds_on: strs.optional().describe("decision: ids of earlier decisions this one follows from"),
  state: z
    .enum(["proposed", "accepted", "changed", "rejected", "open", "answered", "confirmed", "corrected"])
    .optional()
    .describe("decision: proposed | accepted | changed | rejected; question: open | answered; assumption: open | confirmed | corrected"),
  options: strs.optional().describe("question: 2 to 4 short answers to pick from, when it's a choice"),
  about: z.string().optional().describe("question / assumption: the decision id it bears on"),
  answer: z.string().optional().describe("question: the user's answer, once they've given it"),
  verify: z.string().optional().describe("decision: the check that will show it was right: a test by name, or a command and what it must show"),
  proof: z.enum(["pass", "fail"]).optional().describe("decision: the result of that check, once you've run it"),
  proof_by: z.string().optional().describe("decision: what proved or disproved it: the test's exact name as the runner printed it, or the command and what it showed"),
  el: z.string().optional().describe("element id of a shape the user drew (adopt ops), or of the sticker you're answering (answer)"),
});

export const UPDATE_BOARD = {
  name: "update_board",
  description:
    "Draw on the shared whiteboard the user is watching. Pass several ops at once. Ops: project, phase, task, node, part, edge, flow, table, decision, question, assumption, status, rename, note, remove, unlink, adopt, adopt-edge, adopt-note, answer.",
  input: { ops: z.array(Op).min(1) },
};

// What the tool tells the agent once it has drawn: how much, and any corrections (emitOps' notes).
export const boardReply = (ops, notes = []) => ({
  content: [{ type: "text", text: `Board updated (${ops.length} change${ops.length === 1 ? "" : "s"}).${notes.length ? `\n${notes.join("\n")}` : ""}` }],
});

// The board as it is now, for when the agent needs the whole picture. Messages only carry what the
// user changed, so this is how the agent gets everything else back.
export const READ_BOARD = {
  name: "read_board",
  description:
    "Read the whiteboard the user is watching, as it is now: project, goal, phase, components (with status, libs, api and grid cell), connections, decisions (with their state and proof), tasks, questions and assumptions (with answers), free cells and the note count. Your messages carry only what the user changed, so call this when you need the whole picture, e.g. after a context reset, and not after each change.",
  input: {},
};

// The board's state as JSON (or shorthand lines), or a plain line when no browser is showing the
// board to read it from.
export const readBoardReply = (state, shorthand = false) => ({
  content: [{ type: "text", text: state ? (shorthand ? stateLines(state) : JSON.stringify(state)) : "The whiteboard isn't open in a browser, so its current state can't be read. Work from the messages and your own updates." }],
});

// Shorthand mode (AGENT_SHORTHAND): update_board takes one op per line (shorthand.js), and its
// schema is that one string, not every op's fields (the instructions describe those). JSON ops are
// still taken, checked here with Op instead of by the schema.
export const UPDATE_BOARD_SHORTHAND = {
  name: "update_board",
  description:
    "Draw on the shared whiteboard the user is watching. Send several ops at once as lines, one op per line: the op, its id, then key=value pairs; quote values with spaces; join list items with |. Ops: project, phase, task, node, part, edge, flow, table, decision, question, assumption, status, rename, note, remove, unlink, adopt, adopt-edge, adopt-note, answer.",
  input: {
    lines: z.string().optional().describe('ops, one per line, e.g. node api name="API server" kind=service col=1 row=0 libs=fastify@4.28'),
    ops: z.array(z.record(z.string(), z.unknown())).optional().describe("the same ops as JSON objects, only if a line can't say it"),
  },
};

export const READ_BOARD_SHORTHAND = { ...READ_BOARD, description: `${READ_BOARD.description} It answers in the same lines update_board takes.` };

// Shorthand lines (and any JSON ops) → drawn ops, and the reply: what was drawn, the board's
// notes, and an error for each line it couldn't draw, so the agent resends only those.
export function drawShorthand({ lines, ops = [] }, draw) {
  const { ops: fromLines, errors } = lines != null ? parseLines(lines, Op) : { ops: [], errors: [] };
  const fromJson = ops.flatMap((o, i) => {
    const r = Op.safeParse(o);
    if (r.success) return [r.data];
    errors.push(`ops[${i}]: ${issues(r.error)}`);
    return [];
  });
  const all = [...fromLines, ...fromJson];
  const failed = errors.length ? `\n${errors.length} not drawn; fix and resend only these:\n${errors.join("\n")}` : "";
  if (!all.length) return { content: [{ type: "text", text: `Nothing drawn.${failed || " Send ops as lines."}` }], isError: true };
  const reply = boardReply(all, draw(all));
  reply.content[0].text += failed;
  return reply;
}

// The two tools as an engine registers them: { name, description, input, run(args, { draw, read }) }.
export const boardTools = (shorthand = false) => [
  shorthand
    ? { ...UPDATE_BOARD_SHORTHAND, run: (args, { draw }) => drawShorthand(args, draw) }
    : { ...UPDATE_BOARD, run: ({ ops }, { draw }) => boardReply(ops, draw(ops)) },
  { ...(shorthand ? READ_BOARD_SHORTHAND : READ_BOARD), run: async (_, { read }) => readBoardReply(await read(), shorthand) },
];
