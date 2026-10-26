import { PHASES } from "./board";

// One-line, present-tense description of a board op, for the panel's live status line.
export function describeOp(a, model) {
  const name = (id) => model.nodes[id]?.name ?? id;
  switch (a.op) {
    case "project": return `Naming the project`;
    case "phase":
      return a.name === "complete" ? "Wrapping up" : `Starting ${PHASES.find((p) => p.key === a.name)?.label ?? a.name}`;
    case "task": {
      const text = a.text ?? model.tasks[a.id]?.text ?? "a task";
      if (a.status === "done") return `Checking off “${text}”`;
      if (a.status === "failed") return `Flagging “${text}”`;
      return `Adding “${text}”`;
    }
    case "node": return model.nodes[a.id] ? `Detailing ${model.nodes[a.id].name}` : `Drawing ${a.name}`;
    case "decision": {
      const d = model.decisions?.[a.id];
      if (d && a.proof && !a.chose) return a.proof === "pass" ? `Proving D${d.n}` : `D${d.n} failed its check`;
      return d ? `Revising ${a.title ?? d.title}` : `Deciding ${a.title ?? a.id}`;
    }
    case "edge": return `Connecting ${name(a.from)} → ${name(a.to)}`;
    case "flow": return `Mapping the flow “${a.name ?? a.id}”`;
    case "table": return `Modeling the ${a.name ?? a.id} table`;
    case "status": return `Marking ${name(a.id)} ${a.v}`;
    case "rename": return `Renaming ${name(a.id)} to ${a.name}`;
    case "remove": return `Removing ${name(a.id)}`;
    case "unlink": return `Disconnecting ${name(a.from)} → ${name(a.to)}`;
    case "adopt": return `Adding your ${a.name} to the plan`;
    case "adopt-edge": return `Keeping your arrow ${name(a.from)} → ${name(a.to)}`;
    case "note":
    case "adopt-note": return `Pinning your note`;
    default: return "Working";
  }
}
