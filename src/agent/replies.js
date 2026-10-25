// Scripted agent replies to what the user did on the board or typed.
// A real agent would get the same structured decisions as input and stream
// back text with the same <board .../> ops.

const esc = (s) => String(s).replace(/"/g, "'").replace(/[<>]/g, "");
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 20) || "item";

let taskSeq = 0;
const taskId = () => `u${++taskSeq}`;

// Where a component should land once the agent has handled a change, given the phase.
const settled = (phase) =>
  ({ planning: "planned", implementation: "built", verification: "verified", deployment: "live", complete: "live" })[phase] ?? "built";

const op = (attrs) =>
  `<board ${Object.entries(attrs).map(([k, v]) => `${k}="${esc(v)}"`).join(" ")}/>`;

export function buildEditsReply(decisions, model) {
  const phase = model.phase ?? "planning";
  const taskPhase = phase === "complete" ? "deployment" : phase;
  const planning = phase === "planning";
  const done = settled(phase);
  const name = (id) => model.nodes[id]?.name ?? id;
  const used = new Set(Object.keys(model.nodes));

  const lines = [
    `Picked up ${decisions.length === 1 ? "your change" : `${decisions.length} changes`} from the board.`,
  ];

  for (const d of decisions) {
    const t = taskId();
    const task = (text, status) => op({ op: "task", id: t, phase: taskPhase, text, status });
    switch (d.kind) {
      case "rename":
        lines.push(
          planning
            ? `Updating the plan to use **${d.to}** instead of **${d.from}**${op({ op: "rename", id: d.node, name: d.to })}${task(`Use ${short(d.to, 20)}`, "done")}.`
            : `Switching **${d.from}** to **${d.to}**${op({ op: "rename", id: d.node, name: d.to })}${task(`Swap to ${short(d.to, 18)}`, "building")}. That changes code, so I'm rebuilding it${op({ op: "status", id: d.node, v: "building" })}. Rebuilt and re-tested${op({ op: "status", id: d.node, v: done })}${op({ op: "task", id: t, status: "done" })}.`,
        );
        break;
      case "remove":
        lines.push(
          `Dropping **${d.name}**${op({ op: "remove", id: d.node })} and its connections${task(`Remove ${short(d.name, 18)}`, "done")}.`,
        );
        break;
      case "unlink":
        lines.push(
          `Cutting the link from **${name(d.from)}** to **${name(d.to)}**${op({ op: "unlink", from: d.from, to: d.to })}.` +
            (planning
              ? ""
              : ` **${name(d.from)}** no longer calls it, so I'm updating that code${op({ op: "status", id: d.from, v: "building" })}. Done${op({ op: "status", id: d.from, v: done })}.`),
        );
        break;
      case "link":
        lines.push(
          `New connection from **${d.fromName}** to **${d.toName}**${op({ op: "adopt-edge", el: d.elId, from: d.from, to: d.to })}.` +
            (planning
              ? ""
              : ` Wiring it into **${d.fromName}**${op({ op: "status", id: d.from, v: "building" })}${task(`Wire ${short(d.fromName, 9)} → ${short(d.toName, 9)}`, "building")}. Connected${op({ op: "status", id: d.from, v: done })}${op({ op: "task", id: t, status: "done" })}.`),
        );
        break;
      case "add": {
        let id = slug(d.name);
        for (let k = 2; used.has(id); k++) id = `${slug(d.name)}-${k}`;
        used.add(id);
        lines.push(
          `You added **${d.name}**${op({ op: "adopt", el: d.elId, id, name: d.name })}, so it's part of the plan now${task(`Add ${short(d.name, 20)}`, planning ? "done" : "todo")}.` +
            (planning
              ? ""
              : ` Building it${op({ op: "status", id, v: "building" })}${op({ op: "task", id: t, status: "building" })}. Ready${op({ op: "status", id, v: done })}${op({ op: "task", id: t, status: "done" })}.`),
        );
        break;
      }
      case "note":
        lines.push(`Noted: “${short(d.text, 60)}”${op({ op: "adopt-note", el: d.elId })}.`);
        break;
    }
  }
  return lines.join("\n\n");
}

export function buildChatReply(text) {
  return `Got it${op({ op: "note", text: short(text, 70) })}. I pinned that under Your notes so it stays in view while I work.`;
}
