// The board in C4 notation (container level, https://c4model.com): the same components and
// connections, drawn as C4's boxes and written as Mermaid for docs. Pure, so `node --test` can run it.

// What each component kind is in C4 terms.
export const C4_TYPE = {
  client: "Container",
  service: "Container",
  test: "Container",
  data: "Database",
  queue: "Queue",
  external: "External system",
  user: "Person",
};
const OUTSIDE = new Set(["external", "user"]); // drawn outside the system's boundary

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// The line under a box's name: "[Container: FastAPI 0.115]", cut to fit.
export function c4Tag(node, max = 28) {
  const type = C4_TYPE[node.kind] ?? "Container";
  const tech = node.libs?.[0];
  if (!tech || OUTSIDE.has(node.kind)) return `[${type}]`;
  return `[${type}: ${clip(tech, Math.max(4, max - type.length - 4))}]`;
}

// As a Mermaid flowchart in C4 notation, for a README or a PR (GitHub, GitLab and Notion render
// it inline). Mermaid's own C4 diagrams lay out one box per row, so this uses its flowchart
// layout: square boxes, the system's boundary as a subgraph, async links dashed.
export function toMermaid(model) {
  const q = (s) => String(s ?? "").replace(/"/g, "'").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\s+/g, " ").trim();
  const alias = (id) => `n_${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;
  // In the board's grid order (rows, then columns).
  const at = (n) => (n.cell ? n.cell[1] * 10 + n.cell[0] : 99);
  const nodes = Object.values(model.nodes ?? {}).sort((a, b) => at(a) - at(b));
  const tag = (n) => {
    const type = C4_TYPE[n.kind] ?? "Container";
    const tech = OUTSIDE.has(n.kind) ? "" : (n.libs ?? []).slice(0, 2).join(", ");
    return tech ? `[${type}: ${tech}]` : `[${type}]`;
  };
  const box = (n) => `${alias(n.id)}["${q(n.name)}<br/>${q(tag(n))}"]`;
  const title = model.project || "Architecture";
  const lines = ["flowchart LR"];
  for (const n of nodes.filter((n) => n.kind === "user")) lines.push(`  ${box(n)}`);
  const inside = nodes.filter((n) => !OUTSIDE.has(n.kind));
  if (inside.length) {
    lines.push(`  subgraph system["${q(title)}"]`);
    for (const n of inside) lines.push(`    ${box(n)}`);
    lines.push("  end");
  }
  for (const n of nodes.filter((n) => n.kind === "external")) lines.push(`  ${box(n)}`);
  for (const e of Object.values(model.edges ?? {})) {
    if (!model.nodes[e.from] || !model.nodes[e.to]) continue;
    const label = [e.via, e.api && clip(e.api, 40)].filter(Boolean).join(": ");
    lines.push(`  ${alias(e.from)} ${e.async ? "-.->" : "-->"}${label ? `|"${q(label)}"|` : ""} ${alias(e.to)}`);
  }
  // C4's usual colors: blue containers, dark blue people, grey external systems.
  const of = (pred) => nodes.filter(pred).map((n) => alias(n.id)).join(",");
  const groups = [
    ["container", "fill:#438dd5,stroke:#2e6295,color:#fff", of((n) => !OUTSIDE.has(n.kind))],
    ["person", "fill:#08427b,stroke:#052e56,color:#fff", of((n) => n.kind === "user")],
    ["external", "fill:#999999,stroke:#6b6b6b,color:#fff", of((n) => n.kind === "external")],
  ];
  for (const [name, style, ids] of groups) if (ids) lines.push(`  classDef ${name} ${style}`, `  class ${ids} ${name}`);
  lines.push("  style system fill:none,stroke:#444,stroke-dasharray:5 5");
  return `${lines.join("\n")}\n`;
}
