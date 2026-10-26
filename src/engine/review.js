// The end of a run, as what needs a look rather than another summary: checks that never ran
// or failed, things it said that the record contradicts or can't back, what it asked you
// (on the board or in passing) and assumed, what it changed in the repo that nothing on the
// board owns, whether any of it is committed, the last test run, and commands you denied.
// Few words: a glyph, a one- or two-word label, and chips that link to where to look (their
// title has the detail). Pure, like timeline.js and claims.js.
//
// buildReview({
//   model,                         Board.model (decisions, questions, nodes, unowned)
//   claims: [{ id, text, verdict, claims: [{ text, verdict, why, short? }] }],   receipts, by sentence
//   passing: [{ id, text, kind: "asks" | "assumes" }],                           said in passing
//   changes: [{ path, add, del }] | null,  commits,                              from git, or null
//   lastTest: { ok, pass?, fail?, label } | null,
//   denied: [command],
// }) → [{ key, tone: "bad" | "warn" | "info" | "ok", icon, text, links: [{ label, lid, title? }] }]
// A link's lid is a logical id: decision:<id>, question:<id>, sentence:<id>, code[:<node>|:unowned].

const clip = (s, n) => {
  const t = String(s ?? "").replace(/`|\*\*/g, "").replace(/^\s*(?:[-*]|\d+\.)\s+/, ""); // markdown reads as noise here
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function buildReview({ model, claims = [], passing = [], changes = null, commits = 0, lastTest = null, denied = [] }) {
  const rows = [];
  // Sentence case: "False claim", "Open", "Tests 47/50".
  const row = (key, tone, icon, text, links = []) => rows.push({ key, tone, icon, text: text[0].toUpperCase() + text.slice(1), links });
  const decisions = Object.values(model.decisions ?? {})
    .filter((d) => d.state !== "rejected")
    .sort((a, b) => a.n - b.n);
  const dlink = (d) => ({ label: `D${d.n}`, lid: `decision:${d.id}`, title: d.title });
  const said = (c, label) => ({ label, lid: `sentence:${c.id}`, title: `“${clip(c.text, 200)}”${c.claims ? `\n${c.claims.map((x) => x.why).join("\n")}` : ""}` });

  const failed = decisions.filter((d) => d.proof === "fail");
  if (failed.length) row("failed", "bad", "✗", "check failed", failed.map(dlink));
  const unchecked = decisions.filter((d) => !d.proof);
  if (unchecked.length) row("unchecked", "warn", "◇", "unchecked", unchecked.map(dlink));

  const bad = claims.filter((c) => c.verdict === "bad");
  if (bad.length) row("contradicted", "bad", "✗", "false claim", bad.map((c) => said(c, c.claims.filter((x) => x.verdict === "bad").map((x) => x.short ?? clip(x.text, 24)).join(", "))));
  const unknown = claims.filter((c) => c.verdict === "unknown");
  if (unknown.length) row("unbacked", "warn", "?", "unverified", unknown.map((c) => said(c, clip(c.text, 28))));

  const questions = Object.values(model.questions ?? {});
  const qlink = (q) => ({ label: `${q.kind === "question" ? "Q" : "A"}${q.n}`, lid: `question:${q.id}`, title: q.text });
  const openQ = questions.filter((q) => q.kind === "question" && q.state === "open");
  if (openQ.length) row("questions", "warn", "?", "open", openQ.map(qlink));
  const openA = questions.filter((q) => q.kind === "assumption" && q.state === "open");
  if (openA.length) row("assumptions", "warn", "≈", "unconfirmed", openA.map(qlink));
  const asked = passing.filter((p) => p.kind === "asks");
  if (asked.length) row("asked", "warn", "?", "asked in passing", asked.map((p) => said(p, clip(p.text, 32))));
  const assumed = passing.filter((p) => p.kind === "assumes");
  if (assumed.length) row("assumed", "warn", "≈", "assumed in passing", assumed.map((p) => said(p, clip(p.text, 32))));

  if (changes) {
    const add = changes.reduce((a, f) => a + f.add, 0), del = changes.reduce((a, f) => a + f.del, 0);
    row("code", "info", "±", changes.length ? `${changes.length} files +${add} −${del} · ${commits ? `${commits} commit${commits === 1 ? "" : "s"}` : "uncommitted"}` : "no changes", changes.length ? [{ label: "diff", lid: "code" }] : []);
    const unowned = model.unowned ?? [];
    if (unowned.length) row("unowned", "warn", "±", "not on board", unowned.map((f) => ({ label: f.path, lid: "code:unowned" })));
  }

  if (lastTest) row("tests", lastTest.ok ? "ok" : "bad", lastTest.ok ? "✓" : "✗", `tests${lastTest.pass != null ? ` ${lastTest.pass}/${lastTest.pass + lastTest.fail}` : ""}`);
  else if (decisions.length) row("tests", "warn", "?", "no tests ran");
  if (denied.length) row("denied", "info", "✕", "denied", denied.map((c) => ({ label: clip(c, 32), lid: null, title: c })));

  if (!rows.some((r) => r.tone === "bad" || r.tone === "warn")) rows.unshift({ key: "clear", tone: "ok", icon: "✓", text: "All clear", links: [] });
  return rows;
}
