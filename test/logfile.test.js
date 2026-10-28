// The run's log, downloaded as Markdown now that the panel doesn't show it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { logMarkdown } from "../src/engine/logfile.js";

const s = (id, text) => ({ type: "s", id, text, ids: new Set() });

test("what you said, what it said and did, and the review", () => {
  const md = logMarkdown({
    title: "DocQA",
    mode: "Demo",
    messages: [
      { id: "m-1", role: "you", kind: "chat", text: "Build a PDF chat app", items: [] },
      {
        id: "m-2",
        role: "agent",
        items: [
          { type: "phase", key: "planning" },
          s("s-1", "I'll plan it first."),
          s("s-2", "Then build."),
          { type: "br" },
          { type: "act", id: "a-1", kind: "command", labels: ["pytest -q"], ok: true, summary: "42 passed" },
          s("s-3", "I documented the setup in README.md."),
        ],
      },
      { id: "m-3", role: "you", kind: "approve", decisions: [{ kind: "rename", from: "Postgres", to: "SQLite" }], items: [] },
      { id: "m-4", role: "you", kind: "permission", decision: "deny", detail: "rm -rf build", items: [] },
      { id: "m-5", role: "notice", text: "The agent stopped early (error).", items: [] },
    ],
    receipts: new Map([["s-3", { verdict: "bad", claims: [{ verdict: "bad", why: "README.md wasn't changed", short: "README.md" }] }]]),
    review: [{ key: "contradicted", tone: "bad", icon: "✗", text: "False claim", links: [{ label: "README.md" }] }],
  });
  assert.match(md, /^# DocQA: log\n\n_Demo_\n/);
  assert.match(md, /\*\*You:\*\* Build a PDF chat app/);
  assert.match(md, /### Planning\n\nI'll plan it first\. Then build\./); // a paragraph's sentences stay together
  assert.match(md, /- Ran `pytest -q` ✓: 42 passed/);
  assert.match(md, /I documented the setup in README\.md\. _\(✗ not true: README\.md\)_/);
  assert.match(md, /\*\*You:\*\* Approved the plan with changes:\n {2}- Rename Postgres → SQLite/);
  assert.match(md, /\*\*You:\*\* Denied `rm -rf build`/);
  assert.match(md, /> ⚠ The agent stopped early/);
  assert.match(md, /## Review\n\n- ✗ False claim: README\.md\n$/);
});

test("an empty run is just its title", () => {
  assert.equal(logMarkdown({ title: "Nothing yet" }), "# Nothing yet: log\n");
});
