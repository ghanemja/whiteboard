// Shorthand board ops (AGENT_SHORTHAND): one op per line instead of a JSON object, about a fifth
// fewer tokens for the same plan (docs/TOKEN_STUDY.md, "Shorthand mode"). A line is the op, then
// its id, then key=value pairs:
//
//   node api name="API server" kind=service col=1 row=0 libs=fastify@4.28|zod@3 api="POST /links|GET /:code"
//   edge web>api via=HTTP api="POST /links {url}"
//   phase planning
//
// A value is a bare word or a quoted string ("…", JSON escapes); a list joins its items with |,
// quoted or not (\| inside quotes keeps a | in an item). Edges (unlink, adopt-edge) put from>to
// where the id goes, phase its name, adopt-note and answer the sticker's el. Lines starting with #
// are comments.
// The same lines describe the board when read_board answers in shorthand (stateLines).

// Where a line's second word goes, when it isn't key=value.
const POSITIONAL = { request: "kind", phase: "name", edge: "from>to", unlink: "from>to", "adopt-edge": "from>to", "adopt-note": "el", answer: "el" };
// Always lists. steps, links and columns are lists with two or more items; one item stays a string,
// which the board splits on ";" as well. A node's api is a list, an edge's the one call.
const LISTS = new Set(["over", "affects", "evidence", "builds_on", "paths", "libs", "options", "attrs", "methods", "implements", "uses"]);
const SPLITS = new Set(["steps", "links", "columns"]);
const NUMBERS = new Set(["col", "row"]);

// One line → its words: [{ key, items }]: key is what comes before the first "=" (null for a bare
// word), items the |-separated pieces of the value.
const PIPE = "\u0001"; // an escaped \| while a value is being split
function words(line) {
  const out = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    let key = null;
    const items = [""];
    let quoted = false;
    while (i < n && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '"') {
        // A JSON string: find its closing quote, skipping escapes.
        let j = i + 1;
        while (j < n && line[j] !== '"') j += line[j] === "\\" ? 2 : 1;
        if (j >= n) throw new Error("a quote isn't closed");
        let s;
        try {
          s = JSON.parse(line.slice(i, j + 1).replaceAll("\\|", "\\u0001"));
        } catch {
          throw new Error(`bad escape in ${line.slice(i, j + 1)}`);
        }
        const [first, ...more] = s.split("|");
        items[items.length - 1] += first;
        items.push(...more);
        quoted = true;
        i = j + 1;
      } else if (c === "=" && key === null && !quoted && items.length === 1) {
        key = items[0];
        items[0] = "";
        i++;
      } else if (c === "|") {
        items.push("");
        i++;
      } else {
        items[items.length - 1] += c;
        i++;
      }
    }
    out.push({ key, items: items.map((s) => s.replaceAll(PIPE, "|")), quoted });
  }
  return out;
}

// The value of key, from its items, in the shape the Op schema takes.
function value(op, key, items) {
  if (LISTS.has(key) || (key === "api" && op === "node")) return items.map((s) => s.trim()).filter(Boolean);
  if (SPLITS.has(key)) return items.length > 1 ? items.map((s) => s.trim()).filter(Boolean) : items[0];
  const s = items.join("|");
  return NUMBERS.has(key) && /^-?\d+$/.test(s) ? Number(s) : s;
}

// One line → one op (not yet checked against the schema). Throws with a short reason.
export function parseLine(line) {
  const [head, ...rest] = words(line);
  if (!head || head.key !== null) throw new Error("start the line with the op");
  const op = { op: head.items.join("|") };
  rest.forEach((w, i) => {
    if (w.key === null) {
      if (i > 0) throw new Error(`"${w.items.join("|")}" needs a key=, only the id comes bare (put a value with spaces in "…")`);
      const pos = POSITIONAL[op.op] ?? "id";
      const s = w.items.join("|");
      if (pos === "from>to") {
        const m = /^([^>\s]+)>([^>\s]+)$/.exec(s);
        if (!m) throw new Error(`write ${op.op}'s ends as from>to, not "${s}"`);
        op.from = m[1];
        op.to = m[2];
      } else op[pos] = s;
      return;
    }
    if (!/^[a-z_]+$/.test(w.key)) throw new Error(`"${w.key}" isn't a key`);
    if (w.key in op) throw new Error(`${w.key} is given twice`);
    op[w.key] = value(op.op, w.key, w.items);
  });
  return op;
}

// Lines → ops, each checked with the Op schema (and its keys with Op's), plus one error per bad
// line, numbered as the agent wrote them.
export function parseLines(text, Op) {
  const ops = [], errors = [];
  const known = new Set(Object.keys(Op.shape));
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim();
      if (!line || line.startsWith("#")) return;
      const at = `line ${i + 1} (${line.length > 40 ? `${line.slice(0, 40)}…` : line})`;
      let op;
      try {
        op = parseLine(line);
      } catch (e) {
        return errors.push(`${at}: ${e.message}`);
      }
      const unknown = Object.keys(op).filter((k) => !known.has(k));
      if (unknown.length) return errors.push(`${at}: no such key ${unknown.join(", ")}`);
      const r = Op.safeParse(op);
      if (!r.success) return errors.push(`${at}: ${issues(r.error)}`);
      ops.push(r.data);
    });
  return { ops, errors };
}

// A zod error in a few words: "col: Too big: expected number to be <=2".
export const issues = (error) => error.issues.map((x) => `${x.path.length ? `${x.path.join(".")}: ` : ""}${x.message}`).join("; ");

// One value as written in a line: bare when it can be, quoted when it has spaces or quotes. A list
// item's own | is written \|.
const BARE = /^[^\s"|\\]+$/;
const word = (s) => (BARE.test(s) ? s : JSON.stringify(s));
function written(v) {
  if (!Array.isArray(v)) return word(String(v));
  const items = v.map(String);
  if (items.every((s) => BARE.test(s))) return items.join("|");
  return JSON.stringify(items.map((s) => s.replaceAll("|", PIPE)).join("|")).replaceAll("\\u0001", "\\|");
}

// One op → its line. parseLine(toLine(op)) gives the op back.
export function toLine(op) {
  const { op: name, ...rest } = op;
  const out = [name];
  const pos = POSITIONAL[name] ?? "id";
  if (pos === "from>to" && BARE.test(String(rest.from ?? "")) && BARE.test(String(rest.to ?? "")) && !`${rest.from}${rest.to}`.includes(">")) {
    out.push(`${rest.from}>${rest.to}`);
    delete rest.from;
    delete rest.to;
  } else if (pos !== "from>to" && rest[pos] != null && /^[^\s"|=]+$/.test(String(rest[pos]))) {
    out.push(String(rest[pos]));
    delete rest[pos];
  }
  for (const [k, v] of Object.entries(rest)) {
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    // A one-item steps, links or columns reads back as one string, which the board takes the same way.
    out.push(`${k}=${Array.isArray(v) && v.length === 1 && !(LISTS.has(k) || (k === "api" && name === "node")) ? word(v[0]) : written(v)}`);
  }
  return out.join(" ");
}

// The board as read_board returns it (Board.snapshot() in the browser), as lines: the ops that
// would draw it, plus # lines for what isn't an op (free cells, notes, kept stickers).
export function stateLines(state) {
  const s = state ?? {};
  const out = [];
  if (s.project || s.goal) out.push(toLine({ op: "project", ...(s.project ? { name: s.project } : {}), ...(s.goal ? { goal: s.goal } : {}) }));
  if (s.phase) out.push(toLine({ op: "phase", name: s.phase }));
  for (const { status, ...n } of s.nodes ?? []) out.push(toLine({ op: "node", ...n, ...(status ? { v: status } : {}) }));
  for (const e of s.edges ?? []) out.push(toLine({ op: "edge", ...e }));
  for (const d of s.decisions ?? []) out.push(toLine({ op: "decision", ...d }));
  for (const t of s.tasks ?? []) out.push(toLine({ op: "task", ...t }));
  for (const c of s.classes ?? []) out.push(toLine({ op: "class", ...c }));
  for (const { kind, ...q } of s.questions ?? []) out.push(toLine({ op: kind === "assumption" ? "assumption" : "question", ...q }));
  // Anything else a newer browser sends, kept rather than dropped.
  const known = new Set(["project", "goal", "phase", "nodes", "edges", "decisions", "tasks", "classes", "questions", "free_cells", "notes", "kept"]);
  for (const [k, v] of Object.entries(s)) if (!known.has(k) && v != null) out.push(`# ${k}: ${JSON.stringify(v)}`);
  if (s.free_cells?.length) out.push(`# free cells (col,row): ${s.free_cells.map((c) => `${c.col},${c.row}`).join(" ")}`);
  if (s.notes) out.push(`# notes: ${s.notes}`);
  if (s.kept?.length) out.push(`# kept (leave as they are): ${s.kept.map((k) => k.node ?? k.decision).join(" ")}`);
  return out.join("\n");
}
