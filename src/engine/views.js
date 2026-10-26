// The board's views of one model, and their exports. Pure (no Excalidraw), so `node --test`
// and the server (for the decision log) use it too.
//   - C4 notation (container level, https://c4model.com): each box's type and technology.
//   - Layers (Frontend, Backend, Data, ML, External): what the board's layer filter shows.
//   - Flows: a request's numbered path through the components (a C4 dynamic view, or a UML
//     sequence diagram).
//   - Names in sentence case.
//   - Mermaid: the container view as a flowchart, a flow as a sequence diagram. GitHub, GitLab
//     and Notion render both inline.

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

export const LAYERS = [
  { key: "frontend", label: "Frontend" },
  { key: "backend", label: "Backend" },
  { key: "data", label: "Data" },
  { key: "ml", label: "ML" },
  { key: "external", label: "External" },
];
const LAYER_OF_KIND = { client: "frontend", service: "backend", test: "backend", queue: "data", data: "data", external: "external" };
// A component's layer: the agent's, else its kind's. People have none: they stay in every view.
export const layerOf = (n) => (LAYERS.some((l) => l.key === n.layer) ? n.layer : n.kind === "user" ? null : (LAYER_OF_KIND[n.kind] ?? "backend"));

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// "server tests" → "Server tests". File and code names (store.js, src/api, createStore), one-word
// names and lowercase brands (pgvector, npm) stay as written.
const BRANDS = /^(npm|pnpm|yarn|git|pgvector|pytest|macos|ios|grpc|jq|curl|kubectl|k8s|vite|webpack|redis-cli)$/;
export function sentenceCase(name) {
  const s = String(name ?? "").trim();
  const first = s.split(/\s+/)[0];
  if (!/\s/.test(s) || !/^[a-z]+$/.test(first) || BRANDS.test(first) || /[./_()]|[a-z][A-Z]/.test(s)) return s;
  return s[0].toUpperCase() + s.slice(1);
}
// A protocol tag: "queue" → "Queue"; HTTP, S3 and gRPC stay as they are.
export const tagCase = (via) => (/^[a-z]+$/.test(via ?? "") ? via[0].toUpperCase() + via.slice(1) : via);

// The line under a box's name: "[Container: FastAPI 0.115]", cut to fit.
export function c4Tag(node, max = 28) {
  const type = C4_TYPE[node.kind] ?? "Container";
  const tech = node.libs?.[0];
  if (!tech || OUTSIDE.has(node.kind)) return `[${type}]`;
  return `[${type}: ${clip(tech, Math.max(4, max - type.length - 4))}]`;
}

// A flow's steps, from the agent ("web>api: POST /ask" strings, or {from, to, what}) or a
// demo tag ("web>api: POST /ask; api>vdb: top 8 chunks").
export function parseSteps(steps) {
  const items = Array.isArray(steps) ? steps : String(steps ?? "").split(/;|\n/);
  return items
    .map((s) => {
      if (s && typeof s === "object") return { from: String(s.from ?? ""), to: String(s.to ?? ""), what: String(s.what ?? s.label ?? "").trim() };
      const m = /^\s*([\w.-]+?)\s*(?:->|>|→)\s*([\w.-]+)\s*:?\s*(.*?)\s*$/.exec(String(s ?? ""));
      return m && { from: m[1], to: m[2], what: m[3] };
    })
    .filter((x) => x && x.from && x.to && x.from !== x.to);
}

// Text inside a Mermaid label: no quotes, angle brackets or statement breaks.
const q = (s) => String(s ?? "").replace(/;/g, ",").replace(/"/g, "'").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\s+/g, " ").trim();
const alias = (id) => `n_${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;

// The container view as a Mermaid flowchart in C4 notation. Mermaid's own C4 diagrams lay out one
// box per row, so this uses its flowchart layout: square boxes, the system's boundary as a
// subgraph, async links dashed. `only`: the component ids to include (a layer, say).
export function toMermaid(model, { only } = {}) {
  // In the board's grid order (rows, then columns).
  const at = (n) => (n.cell ? n.cell[1] * 10 + n.cell[0] : 99);
  const nodes = Object.values(model.nodes ?? {})
    .filter((n) => !only || only.has(n.id))
    .sort((a, b) => at(a) - at(b));
  const has = new Set(nodes.map((n) => n.id));
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
    if (!has.has(e.from) || !has.has(e.to)) continue;
    const label = [tagCase(e.via), e.api && clip(e.api, 40)].filter(Boolean).join(": ");
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
  if (inside.length) lines.push("  style system fill:none,stroke:#444,stroke-dasharray:5 5");
  return `${lines.join("\n")}\n`;
}

// A flow as a Mermaid sequence diagram, numbered. A step that runs back along a link drawn the
// other way (a reply) is dashed; one along an async link is an open arrow.
export function toSequence(model, flow) {
  const node = (id) => model.nodes?.[id];
  const ids = [...new Set(flow.steps.flatMap((s) => [s.from, s.to]))];
  const lines = ["sequenceDiagram", `  title ${q(flow.name)}`, "  autonumber"];
  for (const id of ids) lines.push(`  ${node(id)?.kind === "user" ? "actor" : "participant"} ${alias(id)} as ${q(node(id)?.name ?? id)}`);
  for (const s of flow.steps) {
    const fwd = model.edges?.[`${s.from}>${s.to}`], back = model.edges?.[`${s.to}>${s.from}`];
    const arrow = fwd?.async ? "-)" : !fwd && back ? "-->>" : "->>";
    lines.push(`  ${alias(s.from)}${arrow}${alias(s.to)}: ${q(s.what || fwd?.api || "…")}`);
  }
  return `${lines.join("\n")}\n`;
}
