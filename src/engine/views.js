// The board's views of one model, and their exports. Pure (no Excalidraw), so `node --test`
// and the server (for the decision log) use it too.
//   - C4 notation (container level, https://c4model.com): each box's type and technology.
//   - Layers (Frontend, Backend, Data, ML, External): what the board's layer filter shows.
//   - Flows: a request's numbered path through the components (a C4 dynamic view, or a UML
//     sequence diagram).
//   - Data flow (DFD, Gane-Sarson): processes, data stores and external entities, with the data
//     each link carries.
//   - Data model (ER): the tables the data stores hold, their keys and relations.
//   - Names in sentence case.
//   - Mermaid for each: the container view and the data flow as flowcharts, a flow as a sequence
//     diagram, the data model as an ER diagram. GitHub, GitLab and Notion render them inline.
//   - Which decisions are in progress (their status circle pulses on the board).
import { YOU } from "./palette.js";

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
// Each layer's color, the same in every view: the plate behind its components (Pictures, C4, data
// flow), a data store's tables (ER), a participant (sequence), the icons its parts get when the
// layer is opened up (explode.js), and the Mermaid exports. Soft fills, so status keeps its own colors.
export const LAYER_COLOR = {
  frontend: { stroke: "#1c7ed6", fill: "#e7f5ff" },
  backend: { stroke: "#7048e8", fill: "#f3f0ff" },
  data: { stroke: "#0ca678", fill: "#e6fcf5" },
  ml: { stroke: "#f08c00", fill: "#fff4e6" },
  external: { stroke: "#868e96", fill: "#f1f3f5" },
};
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
export const q = (s) => String(s ?? "").replace(/;/g, ",").replace(/"/g, "'").replace(/</g, "#lt;").replace(/>/g, "#gt;").replace(/\s+/g, " ").trim();
export const alias = (id) => `n_${String(id).replace(/[^A-Za-z0-9_]/g, "_")}`;

// Mermaid classes in the board's colors, so an export reads like the board: each layer's plate
// color, people in "you" pink. pairs: [[Mermaid id, layer key or null for a person]].
export function colorClasses(pairs) {
  const lines = [];
  const add = (name, c, ids) => ids.length && lines.push(`  classDef ${name} fill:${c.fill},stroke:${c.stroke},color:#1e1e1e`, `  class ${ids.join(",")} ${name}`);
  for (const l of LAYERS) add(l.key, LAYER_COLOR[l.key], pairs.filter(([, k]) => k === l.key).map(([id]) => id));
  add("person", YOU, pairs.filter(([, k]) => k === null).map(([id]) => id));
  return lines;
}

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
  // The board's layer colors (not C4's usual blues), so the export reads like the board.
  lines.push(...colorClasses(nodes.map((n) => [alias(n.id), layerOf(n)])));
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

// ---- data flow (DFD) ----
// What each component is in a data flow diagram: a process (transforms data), a data store
// (holds it), or an external entity (outside the system: people, third-party services).
export const dfdRole = (n) => (n.kind === "data" || n.kind === "queue" ? "store" : OUTSIDE.has(n.kind) ? "entity" : "process");

// Gane-Sarson ids, in the board's grid order: processes 1, 2, 3…; stores DS1, DS2… (D1 is a decision).
export function dfdIds(model) {
  const at = (n) => (n.cell ? n.cell[1] * 10 + n.cell[0] : 99);
  const count = { process: 0, store: 0 };
  const out = {};
  for (const n of Object.values(model.nodes ?? {}).sort((a, b) => at(a) - at(b))) {
    const role = dfdRole(n);
    if (role === "process") out[n.id] = String(++count.process);
    else if (role === "store") out[n.id] = `DS${++count.store}`;
  }
  return out;
}

// The data a link carries: its contract, else its protocol.
export const dataOf = (e) => e.api || tagCase(e.via) || "";

// The data flow as a Mermaid flowchart: processes rounded, data stores as cylinders, external
// entities square and outside the trust boundary.
export function toDfdMermaid(model, { only } = {}) {
  const at = (n) => (n.cell ? n.cell[1] * 10 + n.cell[0] : 99);
  const nodes = Object.values(model.nodes ?? {}).filter((n) => !only || only.has(n.id)).sort((a, b) => at(a) - at(b));
  const has = new Set(nodes.map((n) => n.id));
  const ids = dfdIds(model);
  const box = (n) => {
    const label = q(ids[n.id] ? `${ids[n.id]} · ${n.name}` : n.name);
    return dfdRole(n) === "process" ? `${alias(n.id)}("${label}")` : dfdRole(n) === "store" ? `${alias(n.id)}[("${label}")]` : `${alias(n.id)}["${label}"]`;
  };
  const lines = ["flowchart LR"];
  const inside = nodes.filter((n) => dfdRole(n) !== "entity");
  for (const n of nodes.filter((n) => dfdRole(n) === "entity" && n.kind === "user")) lines.push(`  ${box(n)}`);
  if (inside.length) {
    lines.push(`  subgraph system["${q(model.project || "System")}"]`);
    for (const n of inside) lines.push(`    ${box(n)}`);
    lines.push("  end");
  }
  for (const n of nodes.filter((n) => dfdRole(n) === "entity" && n.kind !== "user")) lines.push(`  ${box(n)}`);
  for (const e of Object.values(model.edges ?? {})) {
    if (!has.has(e.from) || !has.has(e.to)) continue;
    const label = clip(dataOf(e), 40);
    lines.push(`  ${alias(e.from)} ${e.async ? "-.->" : "-->"}${label ? `|"${q(label)}"|` : ""} ${alias(e.to)}`);
  }
  lines.push(...colorClasses(nodes.map((n) => [alias(n.id), layerOf(n)])));
  if (inside.length) lines.push("  style system fill:none,stroke:#444,stroke-dasharray:5 5");
  return `${lines.join("\n")}\n`;
}

// ---- data model (ER) ----
// A table's columns, from the agent: "id uuid pk", "document_id uuid fk>documents.id",
// "email text unique" (also "-> documents.id" or "references documents(id)"), or objects.
export function parseColumns(columns) {
  const items = Array.isArray(columns) ? columns : String(columns ?? "").split(/;|\n/);
  return items
    .map((c) => {
      if (c && typeof c === "object") {
        const [table, col] = String(c.fk ?? "").split(".");
        return c.name ? { name: String(c.name), type: String(c.type ?? ""), pk: !!c.pk, unique: !!c.unique, fk: table ? { table, col: col || "id" } : null } : null;
      }
      let r = String(c ?? "").trim();
      if (!r) return null;
      let fk = null;
      r = r.replace(/(?:\bfk\b\s*(?:>|->|→)?|->|→|\breferences\b)\s*([\w-]+)(?:\.([\w-]+)|\(([\w-]+)\))?/i, (_, table, a, b) => {
        fk = { table, col: a || b || "id" };
        return " ";
      });
      const pk = /\bpk\b|\bprimary\s+key\b/i.test(r);
      const unique = /\bunique\b|\buk\b/i.test(r);
      const [name, type = ""] = r.replace(/\bpk\b|\bprimary\s+key\b|\bunique\b|\buk\b/gi, " ").trim().split(/\s+/);
      return name ? { name, type, pk, unique, fk } : null;
    })
    .filter(Boolean);
}

// The data model as a Mermaid ER diagram: each table with its typed columns and keys, and a
// crow's-foot relation for every foreign key (one referenced row, many referencing ones).
export function toErMermaid(model) {
  const word = (s) => String(s ?? "").replace(/[^\w()[\]-]/g, "_").replace(/^[^A-Za-z_]/, "_$&") || "_";
  const tables = Object.values(model.tables ?? {});
  const lines = ["erDiagram"];
  for (const t of tables) {
    lines.push(`  ${word(t.name)} {`);
    for (const c of t.columns) {
      const keys = [c.pk && "PK", c.fk && "FK", c.unique && !c.pk && "UK"].filter(Boolean).join(", ");
      lines.push(`    ${word(c.type || "any")} ${word(c.name)}${keys ? ` ${keys}` : ""}`);
    }
    lines.push("  }");
  }
  const byName = new Map(tables.map((t) => [t.name, t]));
  for (const t of tables)
    for (const c of t.columns) {
      if (!c.fk || !byName.has(c.fk.table)) continue;
      lines.push(`  ${word(c.fk.table)} ||--${c.pk || c.unique ? "o|" : "o{"} ${word(t.name)} : "${q(c.name)}"`);
    }
  return `${lines.join("\n")}\n`;
}

// ---- inside a layer: the parts in each component (C4's component level) ----
// The agent's part ops: { id, of, name, kind, layer, links: [{ to, what }] }, `to` a part, table or
// component id. "Look inside" a layer keeps the board's map, opens each of the layer's components
// to show its parts, and adds the parts of other components that belong to the layer (an embedding
// step in a backend worker shows up under ML). Components it links to stay closed, at their place.

// A part's links, from the agent ("api.ask: POST /ask; vdb: top 8 chunks") or objects.
export function parseLinks(links) {
  const items = Array.isArray(links) ? links : String(links ?? "").split(/;|\n/);
  return items
    .map((l) => {
      if (l && typeof l === "object") return l.to ? { to: String(l.to), what: String(l.what ?? l.label ?? "").trim() } : null;
      const m = /^\s*([\w.#-]+)\s*(?::\s*(.*?))?\s*$/.exec(String(l ?? ""));
      return m && { to: m[1], what: m[2] ?? "" };
    })
    .filter(Boolean);
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i;
const KIND_OF_API = { client: "view", data: "store", queue: "queue", external: "API", user: "person" };
// What a component holds, in order: its tables (a data store's), then the parts the agent named;
// with none named, what it exposes (its api), each as a part.
export function partsOf(model, nodeId) {
  const n = model.nodes?.[nodeId];
  if (!n) return [];
  const tables = Object.values(model.tables ?? {})
    .filter((t) => t.of === nodeId)
    .map((t) => ({ id: t.id, of: nodeId, name: t.name, kind: "table", table: t, links: [] }));
  const own = Object.values(model.parts ?? {})
    .filter((p) => p.of === nodeId)
    .sort((a, b) => a.n - b.n);
  if (own.length) return [...tables, ...own];
  if (tables.length) return tables; // its api restates the tables
  return (n.api ?? []).map((a, i) => ({ id: `${nodeId}#${i}`, of: nodeId, name: a, kind: ROUTE.test(a) ? "route" : KIND_OF_API[n.kind] ?? "function", links: [], derived: true }));
}

// A part's layer: its own, else its component's.
export const partLayer = (model, p) => (LAYERS.some((l) => l.key === p.layer) ? p.layer : layerOf(model.nodes?.[p.of] ?? {}));

// The inside of one layer: { groups: [{ node, parts, partial }], stubs: [node], links: [{ from, to, what }] }.
// Link ends are { node, part } (part null: the component as a whole). Groups and stubs keep the
// board's grid order.
export function insideOf(model, layer) {
  const at = (n) => (n.cell ? n.cell[1] * 10 + n.cell[0] : 99);
  const nodes = Object.values(model.nodes ?? {}).sort((a, b) => at(a) - at(b));
  const groups = [];
  for (const node of nodes) {
    const all = partsOf(model, node.id);
    if (layerOf(node) === layer) groups.push({ node, parts: all, partial: false });
    else {
      const mine = all.filter((p) => !p.derived && p.kind !== "table" && partLayer(model, p) === layer);
      if (mine.length) groups.push({ node, parts: mine, partial: true });
    }
  }
  const open = new Map(groups.map((g) => [g.node.id, g]));
  const shown = new Map(groups.flatMap((g) => g.parts.map((p) => [p.id, p])));
  const partById = new Map(nodes.flatMap((n) => partsOf(model, n.id).map((p) => [p.id, p])));
  // Where a link lands: a part in view, else its component (open, or closed as a stub).
  const end = (id) => {
    const p = partById.get(id);
    if (p) return { node: p.of, part: shown.has(p.id) ? p.id : null };
    return model.nodes?.[id] ? { node: id, part: null } : null;
  };
  const links = [];
  const seen = new Set();
  const covered = new Set(); // component pairs a part link already draws
  const add = (from, to, what) => {
    if (!from || !to || (from.node === to.node && (!from.part || !to.part || from.part === to.part))) return;
    // At least one end is in this layer: a part shown here, or a component opened whole (a
    // component showing only some parts keeps the rest of its traffic off this view).
    const counts = (x) => (x.part ? shown.has(x.part) : open.has(x.node) && !open.get(x.node).partial);
    if (!counts(from) && !counts(to)) return;
    const k = `${from.node}/${from.part}>${to.node}/${to.part}`;
    if (seen.has(k)) return;
    seen.add(k);
    covered.add(`${from.node}>${to.node}`).add(`${to.node}>${from.node}`);
    links.push({ from, to, what: what ?? "" });
  };
  for (const p of partById.values()) for (const l of p.links ?? []) add({ node: p.of, part: shown.has(p.id) ? p.id : null }, end(l.to), l.what);
  // Links between components no part link covers: from the component to the part its contract
  // names ("POST /ask {question}" lands on the POST /ask route), else to the component.
  for (const e of Object.values(model.edges ?? {})) {
    if (covered.has(`${e.from}>${e.to}`)) continue;
    const target = open.get(e.to)?.parts.find((p) => p.kind !== "table" && e.api && String(e.api).startsWith(p.name));
    add({ node: e.from, part: null }, { node: e.to, part: target?.id ?? null }, e.api || tagCase(e.via) || "");
  }
  const stubIds = new Set(links.flatMap((l) => [l.from.node, l.to.node]).filter((id) => !open.has(id)));
  return { groups, stubs: nodes.filter((n) => stubIds.has(n.id)), links };
}

// The layers worth opening: those with a component, or a part of their own.
export function openableLayers(model) {
  const has = new Set(Object.values(model.nodes ?? {}).map(layerOf));
  for (const p of Object.values(model.parts ?? {})) if (model.nodes?.[p.of]) has.add(partLayer(model, p));
  return LAYERS.filter((l) => has.has(l.key));
}

// The inside of a layer as a Mermaid flowchart: a subgraph per component, its parts inside.
export function toInsideMermaid(model, layer) {
  const { groups, stubs, links } = insideOf(model, layer);
  const pid = (node, part) => (part ? `p_${String(part).replace(/[^A-Za-z0-9_]/g, "_")}` : alias(node));
  const lines = ["flowchart LR"];
  for (const g of groups) {
    lines.push(`  subgraph ${alias(g.node.id)}["${q(g.node.name)}${g.partial ? ` (${q(LAYERS.find((l) => l.key === layer)?.label ?? layer)} parts)` : ""}"]`);
    for (const p of g.parts) lines.push(`    ${pid(g.node.id, p.id)}["${q(p.name)}<br/>${q(p.kind ?? "")}"]`);
    if (!g.parts.length) lines.push(`    ${alias(g.node.id)}_empty["(no parts described)"]`);
    lines.push("  end");
  }
  for (const n of stubs) lines.push(`  ${alias(n.id)}(["${q(n.name)}"])`);
  for (const l of links) lines.push(`  ${pid(l.from.node, l.from.part)} -->${l.what ? `|"${q(clip(l.what, 40))}"|` : ""} ${pid(l.to.node, l.to.part)}`);
  // Colored as on the board: each part in its layer's color, each component's frame in its own.
  lines.push(...colorClasses(groups.flatMap((g) => g.parts.map((p) => [pid(g.node.id, p.id), partLayer(model, p)]))));
  for (const g of groups) {
    const c = LAYER_COLOR[layerOf(g.node)];
    if (c) lines.push(`  style ${alias(g.node.id)} fill:${c.fill},stroke:${c.stroke},stroke-dasharray:5 5`);
  }
  if (stubs.length) lines.push("  classDef stub fill:#f8f9fa,stroke:#adb5bd,color:#868e96", `  class ${stubs.map((n) => alias(n.id)).join(",")} stub`);
  return `${lines.join("\n")}\n`;
}

// ---- decisions on the board ----
// The decisions being worked on now, whose status circle on the board pulses: one shaping a part
// that's being built, or, while the run verifies, one whose check has no result yet. A proposed
// one waits for your approval (not in progress), and a rejected one is done with.
export function busyDecisions(model) {
  const verifying = model.phase === "verification";
  return Object.values(model.decisions ?? {})
    .filter((d) => d.state !== "proposed" && d.state !== "rejected")
    .filter((d) => (d.affects ?? []).some((a) => model.nodes?.[a]?.status === "building") || (verifying && !d.proof))
    .map((d) => d.id);
}
