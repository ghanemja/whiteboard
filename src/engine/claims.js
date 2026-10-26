// Receipts for what the agent says. An agent's prose claims things ("all 12 tests pass",
// "the changes are in src/server.js and the README") that the run's own record can
// confirm or contradict: the test runner's output, the repo's actual diff, the commands
// it ran. Each sentence's claims get a verdict:
//   ok      the record backs it
//   bad     the record contradicts it (only ever from ground truth: the runner or git);
//           `short` is the one token to show inline (a file, "11/12"), `why` the hover,
//           `wrong` the files a file claim got wrong (for the review's red pen)
//   unknown nothing in the record says either way
// Pure functions, like timeline.js, so `node --test` can run them.

// ---- finding claims ----

const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = (s) => (s == null ? null : /^\d+$/.test(s) ? +s : NUM[s.toLowerCase()] ?? null);
const N = String.raw`(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)`;
// Plural: "the smoke test passed" is about one test, not the suite.
const KIND = String.raw`(?:(?:unit|e2e|integration|new|existing|server|the)\s+)*(?:tests|checks|specs)`;
const PASSES = String.raw`(?:now\s+)?(?:all\s+)?(?:pass(?:es|ed)?|are\s+passing|succeed(?:ed)?|are\s+green|go\s+green)\b`;

// "all 12 tests pass", "10 tests pass", "all 42 pass", "12/12 tests pass", "the tests pass", "npm test passes"
const TESTS_PASS = [
  new RegExp(String.raw`\ball\s+${N}\s+(?:${KIND}\s+)?${PASSES}`, "i"),
  new RegExp(String.raw`\b${N}\s*\/\s*${N}\s+(?:${KIND}\s+)?${PASSES}`, "i"),
  new RegExp(String.raw`\b${N}\s+(?:of\s+(?:the\s+)?${N}\s+)?${KIND}\s+${PASSES}`, "i"),
  new RegExp(String.raw`\b(?:all\s+(?:the\s+)?|the\s+)?${KIND}\s+${PASSES}`, "i"),
  /`?\b(?:npm|pnpm|yarn)\s+(?:run\s+)?test`?\s+(?:now\s+)?(?:passes|passed|is green)\b/i,
];
// A measured result: "41 times out of 50", "47 of 50", "11/12", next to what was measured.
const COUNT = /\b(\d+)\s*(?:\/|out of|times out of|of)\s*(\d+)\b/i;
const MEASURED = /\b(tests?|evals?|checks?|cases?|questions?|pass(?:es|ed)?|found|right|correct|retriev\w*|succeed\w*)\b/i;

// Files: a change verb and the files it names. A slash, backticks or a well-known name makes a
// token a file (bare "pdf.js" or "example.com" in prose is usually a library or a host).
const CHANGE = /\b(updat(?:e|ed|es|ing)|chang(?:e|ed|es)|edit(?:ed|s)?|modif(?:y|ied|ies)|add(?:ed|s)?|creat(?:ed|es)|wrote|rewrote|document(?:ed|s)|remov(?:ed|es)|delet(?:ed|es)|renam(?:ed|es)|touch(?:ed|es)|fix(?:ed|es)|now (?:documents|includes|has|lists|describes))\b/i;
const UNCHANGED = /\b(didn't|did not|haven't|have not|never|without)\s+(touch|chang|edit|modif)\w*|\b(left|leaves?|kept)\b[^.]{0,40}\b(alone|untouched|unchanged|as is)\b|\bno changes? (to|in)\b|\bunchanged\b|\buntouched\b/i;
const WELL_KNOWN = /^(README|CHANGELOG|LICENSE|CONTRIBUTING|Makefile|Dockerfile|package\.json|tsconfig\.json|pyproject\.toml|Cargo\.toml|go\.mod)(\.\w+)?$/i;
const HOSTS = /\.(com|org|net|io|dev|app|co|ai|sh)$/i;

function filesIn(sentence) {
  const out = new Set();
  const add = (tok) => {
    const t = tok.replace(/^\.\//, "").replace(/[),.:;]+$/, "");
    if (!t || t.includes("://") || HOSTS.test(t) || /\s/.test(t)) return;
    out.add(t);
  };
  for (const m of sentence.matchAll(/`([^`\s]+)`/g)) if (/\.[a-z][a-z0-9]{0,5}$/i.test(m[1]) || m[1].includes("/") || WELL_KNOWN.test(m[1])) add(m[1]);
  for (const m of sentence.matchAll(/(?<![`\w/.-])([\w.-]+(?:\/[\w.-]+)+\.[a-z][a-z0-9]{0,5})\b/gi)) add(m[1]);
  for (const m of sentence.matchAll(/\b(README|CHANGELOG|package\.json|tsconfig\.json|pyproject\.toml|Makefile|Dockerfile)\b/g)) add(m[1]);
  // "README" and "README.md" are the same claim.
  for (const f of [...out]) if (!f.includes(".") && [...out].some((g) => g !== f && g.startsWith(`${f}.`))) out.delete(f);
  return [...out];
}

// Plans and conditions aren't claims: "I'll run them to make sure the tests pass".
const INTENT = /\b(will|I'll|we'll|going to|make sure|ensure|should|until|so that|once|if|let me|let's|need to|needs to|want to|plan to|next)\b/i;
const stated = (s, at) => !INTENT.test(s.slice(0, at));

// Commands it says it ran (not ones it tells you to run).
const RAN = /\b(?:I|I've|we)\s+(?:also\s+)?(?:ran|re-?ran|executed)\s+`([^`]+)`/gi;

export function findClaims(sentence) {
  const s = String(sentence ?? "").replace(/\*\*/g, "");
  const claims = [];
  if (asksYou(s)) return claims;
  for (const re of TESTS_PASS) {
    const m = re.exec(s);
    if (!m || !stated(s, m.index)) continue;
    const nums = m.slice(1).map(num).filter((v) => v != null);
    claims.push({ kind: "tests", text: m[0].trim(), pass: nums[0] ?? null, total: nums[1] ?? (/\ball\b/i.test(m[0]) ? nums[0] ?? null : null) });
    break;
  }
  if (!claims.length) {
    const m = COUNT.exec(s);
    if (m && MEASURED.test(s) && +m[1] <= +m[2] && stated(s, m.index)) claims.push({ kind: "count", text: m[0], pass: +m[1], total: +m[2] });
  }
  const files = filesIn(s);
  const verb = CHANGE.exec(s);
  if (files.length && UNCHANGED.test(s)) claims.push({ kind: "untouched", text: files.join(", "), files });
  else if (files.length && verb && stated(s, verb.index)) claims.push({ kind: "files", text: files.join(", "), files });
  for (const m of s.matchAll(RAN)) claims.push({ kind: "ran", text: m[1], command: m[1] });
  return claims;
}

// ---- questions and assumptions said in passing ----

// A question to you, buried in the prose ("Should I also add OCR for scanned PDFs?").
export const asksYou = (sentence) => {
  const s = String(sentence ?? "").trim();
  return /\?["')\]]*$/.test(s) && s.split(/\s+/).length >= 4 && !/^(why|how come)\b/i.test(s);
};
// A premise it's working from that you might not share.
export const assumes = (sentence) =>
  /\b(I(?:'m| am)? assum(?:e|ed|ing)|I've assumed|I'll assume|assuming (?:that|the|you|it|this|there)|presumably|I took it that|I(?:'ve| have)? treated .{1,40} as|defaulting to|by default I|I(?:'m| am) guessing|I guessed)\b/i.test(String(sentence ?? ""));

// ---- checking them ----

// evidence: {
//   tests: test runs up to the sentence, oldest first: [{ t, ok, pass?, fail?, inferred? }] (timeline.js),
//   changes: the repo's actual changed files ([{ path, add, del }]) from git, or null when not recorded,
//   edited: paths the agent's edit tools touched (a fallback for runs recorded before git diffs),
//   commands: the commands it ran (null when not recorded),
// }
const sameFile = (claimed, actual) => {
  const c = claimed.toLowerCase(), a = actual.toLowerCase();
  if (c.endsWith("/")) return a.startsWith(c) || a.includes(`/${c}`); // a folder: anything in it
  if (a === c || a.endsWith(`/${c}`)) return true;
  const base = a.split("/").pop();
  return !c.includes(".") && !c.includes("/") && (base === c || base.startsWith(`${c}.`)); // README → README.md
};

export function checkClaim(claim, ev = {}) {
  switch (claim.kind) {
    case "tests":
    case "count": {
      const run = ev.tests?.at(-1);
      if (!run) return { verdict: "unknown", why: "no test run in this session" };
      const counted = run.pass != null;
      const said = claim.total != null && claim.pass != null ? `${claim.pass}/${claim.total}` : claim.pass != null ? `${claim.pass}` : null;
      const got = counted ? `${run.pass}/${run.pass + run.fail}` : null;
      // "3 of 4 tests pass" is a measurement, not a claim that everything passed.
      if (claim.kind === "count" || (claim.total != null && claim.pass < claim.total)) {
        if (!counted) return { verdict: "unknown", why: "the last run didn't print its counts" };
        return run.pass === claim.pass && run.pass + run.fail === claim.total
          ? { verdict: "ok", why: `the runner reported ${got}` }
          : { verdict: "bad", why: `the runner reported ${got}, not ${said}`, short: got };
      }
      if (run.ok === false) return run.inferred ? { verdict: "unknown", why: "the last run's result wasn't recorded" } : { verdict: "bad", why: `the last test run failed${got ? ` (${got})` : ""}`, short: got ?? "failed" };
      if (!counted || claim.pass == null) return { verdict: "ok", why: `the last test run passed${got ? ` (${got})` : ""}` };
      const all = claim.total ?? claim.pass;
      return run.pass === claim.pass && run.fail === 0 && run.pass + run.fail === all
        ? { verdict: "ok", why: `the runner reported ${got}` }
        : { verdict: "bad", why: `the runner reported ${got}, not ${said}`, short: got };
    }
    case "files":
    case "untouched": {
      const changed = ev.changes;
      if (changed) {
        const hit = (f) => changed.some((c) => sameFile(f, c.path));
        const wrong = claim.files.filter((f) => (claim.kind === "files" ? !hit(f) : hit(f)));
        if (!wrong.length) return { verdict: "ok", why: claim.kind === "files" ? `the diff changes ${claim.files.length === 1 ? "it" : `all ${claim.files.length}`}` : "the diff doesn't touch it" };
        return { verdict: "bad", why: `${wrong.join(", ")} ${claim.kind === "files" ? "wasn't changed in this run" : "was changed in this run"}`, short: wrong.join(", "), wrong };
      }
      // No diff recorded: an edit tool's word is support, but its silence proves nothing.
      if (claim.kind === "files" && ev.edited?.length && claim.files.every((f) => ev.edited.some((p) => sameFile(f, p))))
        return { verdict: "ok", why: "edited in this run" };
      return { verdict: "unknown", why: "this run didn't record the repo's diff" };
    }
    case "ran": {
      if (!ev.commands) return { verdict: "unknown", why: "commands weren't recorded" };
      const want = claim.command.trim().toLowerCase();
      return ev.commands.some((c) => c.toLowerCase().includes(want))
        ? { verdict: "ok", why: "it's in the run's commands" }
        : { verdict: "bad", why: "no such command ran in this session", short: claim.command };
    }
    default:
      return { verdict: "unknown", why: "" };
  }
}

// A sentence's verdict: contradicted beats unverified beats backed.
export function receipt(claims, ev) {
  if (!claims?.length) return null;
  const checked = claims.map((c) => ({ ...c, ...checkClaim(c, ev) }));
  const verdict = checked.some((c) => c.verdict === "bad") ? "bad" : checked.some((c) => c.verdict === "unknown") ? "unknown" : "ok";
  return { verdict, claims: checked };
}
