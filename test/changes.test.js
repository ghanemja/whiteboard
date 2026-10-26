// server/changes.js on a throwaway git repo: what a run changed, without touching the repo's index.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { commitsSince, diff, head, isRepo, snapshot } from "../server/changes.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });

test("a run's changes: edits, new files, deletions, on top of uncommitted work", async () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "wb-changes-"));
  try {
    sh(repo, "init", "-q");
    sh(repo, "config", "user.email", "t@example.com");
    sh(repo, "config", "user.name", "t");
    writeFileSync(path.join(repo, "a.js"), "one\ntwo\nthree\n");
    writeFileSync(path.join(repo, "gone.js"), "bye\n");
    writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "start");
    // Someone's uncommitted work from before the run isn't the run's.
    writeFileSync(path.join(repo, "a.js"), "one\ntwo\nthree\nbefore the run\n");
    sh(repo, "add", "a.js"); // staged, so the index differs from HEAD too
    const index = readFileSync(path.join(repo, ".git", "index"));

    assert.equal(await isRepo(repo), true);
    const start = await head(repo);
    const base = await snapshot(repo);

    // The run: edit a.js, add an untracked file, delete one, and write something ignored.
    writeFileSync(path.join(repo, "a.js"), "one\n2\nthree\nbefore the run\n");
    writeFileSync(path.join(repo, "new.js"), "fresh\nfile\n");
    rmSync(path.join(repo, "gone.js"));
    writeFileSync(path.join(repo, "node_modules"), "ignored\n");
    const now = await snapshot(repo);

    const files = await diff(repo, base, now);
    assert.deepEqual(
      files.map(({ path: p, add, del }) => [p, add, del]),
      [["a.js", 1, 1], ["gone.js", 0, 1], ["new.js", 2, 0]],
    );
    assert.match(files[0].patch, /^@@ .* @@\n one\n-two\n\+2\n three\n/);
    assert.ok(!files[0].patch.includes("before the run\n+"), "the earlier uncommitted line isn't part of the run's diff");
    // Nothing of the repo's own state moved.
    assert.deepEqual(readFileSync(path.join(repo, ".git", "index")), index);
    assert.equal(sh(repo, "status", "--porcelain"), "MM a.js\n D gone.js\n?? new.js\n");
    assert.equal(await commitsSince(repo, start), 0);
    // An unchanged tree snapshots the same.
    assert.equal(await snapshot(repo), now);
    sh(repo, "add", "-A");
    sh(repo, "commit", "-qm", "the run");
    assert.equal(await commitsSince(repo, start), 1);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("not a repo", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "wb-norepo-"));
  try {
    assert.equal(await isRepo(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
