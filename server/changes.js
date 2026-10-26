import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// What a run actually changed in the repo, from git rather than from what the agent says it
// did (it may edit through Bash, and summaries drift). A snapshot is the working tree as a
// git tree object, untracked files included and .gitignore respected, written through a
// throwaway index: the repo's own index, files and history are never touched (git only
// gains a few loose objects, which its gc prunes). Diffing the run's first snapshot against
// the latest one gives exactly this run's changes, even on top of uncommitted work.

const git = (repo, args, env = {}) =>
  new Promise((resolve, reject) =>
    execFile("git", args, { cwd: repo, env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
  );

export async function isRepo(repo) {
  try {
    return (await git(repo, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false;
  }
}

export async function head(repo) {
  try {
    return (await git(repo, ["rev-parse", "HEAD"])).trim();
  } catch {
    return null; // no commits yet
  }
}

export async function snapshot(repo) {
  const tmp = path.join(os.tmpdir(), `wb-index-${randomUUID()}`);
  try {
    // Start from the real index so only files that changed get hashed again.
    const real = path.resolve(repo, (await git(repo, ["rev-parse", "--git-path", "index"])).trim());
    if (existsSync(real)) copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    await git(repo, ["add", "-A", "--", "."], env);
    return (await git(repo, ["write-tree"], env)).trim();
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp}.lock`, { force: true });
  }
}

// Files that differ between two snapshots: [{ path, add, del, binary, patch }]. Patches start
// at the first hunk and are capped, per file and in total, so a generated file can't swamp a run.
export async function diff(repo, from, to, { maxFile = 24000, maxTotal = 240000, maxFiles = 60 } = {}) {
  const files = (await git(repo, ["diff", "--numstat", "--no-renames", "-z", from, to]))
    .split("\0")
    .filter(Boolean)
    .map((rec) => {
      const [a, d, ...p] = rec.split("\t");
      return { path: p.join("\t"), add: a === "-" ? 0 : +a, del: d === "-" ? 0 : +d, binary: a === "-" };
    });
  let total = 0;
  for (const f of files.slice(0, maxFiles)) {
    if (f.binary || total >= maxTotal) continue;
    const raw = await git(repo, ["diff", "--no-color", "--no-renames", "-U3", from, to, "--", f.path]);
    let patch = raw.slice(Math.max(0, raw.indexOf("\n@@") + 1));
    if (patch.length > maxFile) {
      const cut = patch.lastIndexOf("\n", maxFile);
      patch = `${patch.slice(0, cut)}\n… ${patch.slice(cut).split("\n").length - 1} more lines`;
    }
    f.patch = patch;
    total += patch.length;
  }
  return files;
}

// Commits made since `from` (the HEAD when the run started).
export async function commitsSince(repo, from) {
  if (!from) return 0;
  try {
    return +(await git(repo, ["rev-list", "--count", `${from}..HEAD`])).trim();
  } catch {
    return 0;
  }
}
