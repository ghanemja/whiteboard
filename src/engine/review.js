// The end of a run, as what needs a look rather than another summary: checks that never ran
// or failed, things it said that the record contradicts or can't back, what it asked you
// (on the board or in passing) and assumed, what it changed in the repo that nothing on the
// board owns, whether any of it is committed, the last test run, and commands you denied.
// Each row links to where to look. Pure, like timeline.js and claims.js.
//
// buildReview({
//   model,                         Board.model (decisions, questions, nodes, unowned)
//   claims: [{ id, text, verdict, claims: [{ text, verdict, why }] }],   receipts, by sentence
//   passing: [{ id, text, kind: "asks" | "assumes" }],                    said in passing
//   changes: [{ path, add, del }] | null,  commits,                       from git, or null
//   lastTest: { ok, pass?, fail?, label } | null,
//   denied: [command],
// }) → [{ key, tone: "bad" | "warn" | "info" | "ok", icon, text, links: [{ label, lid }] }]
// A link's lid is a logical id: decision:<id>, question:<id>, sentence:<id>, code[:<node>|:unowned].

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n) => {
  const t = String(s ?? "").replace(/`|\*\*/g, ""); // markdown reads as noise here
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

export function buildReview({ model, claims = [], passing = [], changes = null, commits = 0, lastTest = null, denied = [] }) {
  const rows = [];
  const decisions = Object.values(model.decisions ?? {})
    .filter((d) => d.state !== "rejected")
    .sort((a, b) => a.n - b.n);
  const dlink = (d) => ({ label: `D${d.n}`, lid: `decision:${d.id}` });

  const failed = decisions.filter((d) => d.proof === "fail");
  if (failed.length) rows.push({ key: "failed", tone: "bad", icon: "✗", text: `${plural(failed.length, "decision")} failed ${failed.length === 1 ? "its" : "their"} check`, links: failed.map(dlink) });
  const unchecked = decisions.filter((d) => !d.proof);
  if (unchecked.length) rows.push({ key: "unchecked", tone: "warn", icon: "◇", text: `${plural(unchecked.length, "decision")} never got a check result`, links: unchecked.map(dlink) });

  const bad = claims.filter((c) => c.verdict === "bad");
  for (const c of bad)
    rows.push({
      key: `claim-${c.id}`, tone: "bad", icon: "✗",
      text: `It said “${clip(c.text, 90)}”, but ${c.claims.filter((x) => x.verdict === "bad").map((x) => x.why).join("; ")}`,
      links: [{ label: "Show", lid: `sentence:${c.id}` }],
    });
  const unknown = claims.filter((c) => c.verdict === "unknown");
  if (unknown.length)
    rows.push({
      key: "unbacked", tone: "warn", icon: "?",
      text: `${plural(unknown.length, "claim")} nothing in the record backs or refutes`,
      links: unknown.map((c, i) => ({ label: clip(c.text, 40), lid: `sentence:${c.id}`, title: c.claims.map((x) => x.why).join("; "), key: i })),
    });

  const questions = Object.values(model.questions ?? {});
  const qlabel = (q) => `${q.kind === "question" ? "Q" : "A"}${q.n}`;
  const openQ = questions.filter((q) => q.kind === "question" && q.state === "open");
  if (openQ.length) rows.push({ key: "questions", tone: "warn", icon: "?", text: `${plural(openQ.length, "question")} for you still open`, links: openQ.map((q) => ({ label: `${qlabel(q)} ${clip(q.text, 36)}`, lid: `question:${q.id}` })) });
  const openA = questions.filter((q) => q.kind === "assumption" && q.state === "open");
  if (openA.length) rows.push({ key: "assumptions", tone: "warn", icon: "≈", text: `${plural(openA.length, "assumption")} you haven't confirmed`, links: openA.map((q) => ({ label: `${qlabel(q)} ${clip(q.text, 36)}`, lid: `question:${q.id}` })) });
  const asked = passing.filter((p) => p.kind === "asks");
  if (asked.length) rows.push({ key: "asked", tone: "warn", icon: "?", text: `It asked ${asked.length === 1 ? "something" : `${asked.length} things`} in passing`, links: asked.map((p) => ({ label: clip(p.text, 48), lid: `sentence:${p.id}` })) });
  const assumed = passing.filter((p) => p.kind === "assumes");
  if (assumed.length) rows.push({ key: "assumed", tone: "warn", icon: "≈", text: `It assumed ${assumed.length === 1 ? "something" : `${assumed.length} things`} in passing`, links: assumed.map((p) => ({ label: clip(p.text, 48), lid: `sentence:${p.id}` })) });

  if (changes) {
    if (changes.length) {
      const add = changes.reduce((a, f) => a + f.add, 0), del = changes.reduce((a, f) => a + f.del, 0);
      rows.push({
        key: "code", tone: "info", icon: "±",
        text: `${plural(changes.length, "file")} changed (+${add} −${del}), ${commits ? `in ${plural(commits, "commit")}` : "not committed"}`,
        links: [{ label: "Read the diff", lid: "code" }],
      });
    } else rows.push({ key: "code", tone: "info", icon: "±", text: "No files changed in the repo", links: [] });
    const unowned = model.unowned ?? [];
    if (unowned.length) rows.push({ key: "unowned", tone: "warn", icon: "±", text: `${plural(unowned.length, "changed file")} no component on the board owns`, links: unowned.map((f) => ({ label: f.path, lid: "code:unowned" })) });
  }

  if (lastTest) rows.push({ key: "tests", tone: lastTest.ok ? "ok" : "bad", icon: lastTest.ok ? "✓" : "✗", text: `The last test run ${lastTest.ok ? "passed" : "failed"}${lastTest.pass != null ? ` (${lastTest.pass}/${lastTest.pass + lastTest.fail})` : ""}`, links: [] });
  else if (decisions.length) rows.push({ key: "tests", tone: "warn", icon: "?", text: "No tests ran", links: [] });
  if (denied.length) rows.push({ key: "denied", tone: "info", icon: "✕", text: `You denied ${plural(denied.length, "command")}`, links: denied.map((c) => ({ label: clip(c, 40), lid: null })) });

  if (!rows.some((r) => r.tone === "bad" || r.tone === "warn"))
    rows.unshift({ key: "clear", tone: "ok", icon: "✓", text: "Nothing needs a look: every decision is proven, every claim is backed, and nothing is waiting on you.", links: [] });
  return rows;
}
