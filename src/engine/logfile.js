import { PHASES } from "./palette.js";
import { describeEdit } from "./timeline.js";

// The run's log as a Markdown file: what you asked and changed, what the agent said (with what
// git and the test output say about its claims) and what it did, then the review. The panel
// shows the plan, not the log; ⇩ in the panel's toolbar downloads this. Pure, so `node --test`
// can run it.
//
//   logMarkdown({ title, mode, when, messages, receipts, review }) → string
//     messages   Transcript.messages: { role: "you" | "agent" | "notice", kind?, text?, items, decisions?, … }
//     receipts   sentence id → { verdict: "ok" | "unknown" | "bad", claims: [{ verdict, why, short? }] }
//     review     buildReview rows, or null while the run is going

const RECEIPT = { ok: "✓ checked", unknown: "? can't tell", bad: "✗ not true" };
const ACT = { read: "Read", search: "Searched", edit: "Edited", write: "Created", command: "Ran", tool: "Used" };

export function logMarkdown({ title = "Run", mode = "", when = "", messages = [], receipts = new Map(), review = null }) {
  const out = [`# ${title}: log`, ""];
  if (mode || when) out.push(`_${[mode, when].filter(Boolean).join(" · ")}_`, "");
  for (const m of messages) {
    if (m.role === "notice") out.push(`> ⚠ ${m.text}`, "");
    else if (m.role === "you") out.push(...you(m), "");
    else if (m.role === "agent") out.push(...agent(m, receipts), "");
  }
  if (review?.length) {
    out.push("## Review", "");
    for (const r of review) out.push(`- ${r.icon} ${r.text}${r.links.length ? `: ${r.links.map((l) => l.label).join(", ")}` : ""}`);
    out.push("");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

function you(m) {
  const edits = (m.decisions ?? []).map((d) => `  - ${describeEdit(d)}`);
  switch (m.kind) {
    case "chat":
      return [`**You:** ${m.text}`];
    case "approve":
      return [`**You:** Approved the plan${edits.length ? " with changes:" : ""}`, ...edits];
    case "permission":
      return [`**You:** ${{ deny: "Denied", "allow-all": "Allowed every command, starting with" }[m.decision] ?? "Allowed"} \`${m.detail}\``];
    default:
      return [`**You:** Changed the board:`, ...edits];
  }
}

function agent(m, receipts) {
  const out = ["**Agent:**"];
  let para = [];
  const flush = () => {
    if (para.length) out.push("", para.join(" "));
    para = [];
  };
  for (const it of m.items) {
    if (it.type === "s" && it.text.trim()) {
      const r = receipts.get(it.id);
      const bad = r?.claims.filter((c) => c.verdict === "bad").map((c) => c.short ?? c.why) ?? [];
      para.push(`${it.text.trim()}${r ? ` _(${RECEIPT[r.verdict]}${bad.length ? `: ${bad.join(", ")}` : ""})_` : ""}`);
    } else if (it.type === "br") flush();
    else if (it.type === "phase") {
      flush();
      out.push("", `### ${PHASES.find((p) => p.key === it.key)?.label ?? it.key}`);
    } else if (it.type === "act") {
      flush();
      const what = it.kind === "command" ? `\`${it.labels[0]}\`` : it.labels.map((l) => `\`${l}\``).join(", ");
      const result = it.ok === true ? " ✓" : it.ok === false ? " ✗" : "";
      out.push("", `- ${ACT[it.kind] ?? ACT.tool} ${what}${result}${it.summary ? `: ${it.summary}` : ""}`);
    }
  }
  flush();
  return out;
}
