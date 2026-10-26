// The whiteboard's one tool, update_board: the ops an agent draws with. Claude gets it in-process
// (runs.js); any other agent over MCP's HTTP transport (board-mcp.js). Both draw through Run.emitOps.
import { z } from "zod";
import { LAYERS } from "../src/engine/views.js";

// One board op. Mirrors Board.apply() in src/engine/board.js.
const strs = z.array(z.string());
export const Op = z.object({
  op: z.enum(["project", "phase", "task", "node", "part", "edge", "flow", "table", "status", "decision", "question", "assumption", "rename", "note", "remove", "unlink", "adopt", "adopt-edge", "adopt-note"]),
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
  text: z.string().optional().describe("task text (≤26 chars), note text, or the question / assumption (≤60 chars)"),
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
  el: z.string().optional().describe("element id of a shape the user drew (adopt ops)"),
});

export const UPDATE_BOARD = {
  name: "update_board",
  description:
    "Draw on the shared whiteboard the user is watching. Pass several ops at once. Ops: project, phase, task, node, part, edge, flow, table, decision, question, assumption, status, rename, note, remove, unlink, adopt, adopt-edge, adopt-note.",
  input: { ops: z.array(Op).min(1) },
};

// What the tool tells the agent once it has drawn: how much, and any corrections (emitOps' notes).
export const boardReply = (ops, notes = []) => ({
  content: [{ type: "text", text: `Board updated (${ops.length} change${ops.length === 1 ? "" : "s"}).${notes.length ? `\n${notes.join("\n")}` : ""}` }],
});
