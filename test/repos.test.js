// Picking the repo (server/repos.js): which git URLs we'll clone, the folder a clone goes in, a
// folder's subfolders for the picker, where it opens, and real clones from a throwaway bare repo,
// also through the two routes in runsMiddleware.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { cloneEnv, cloneError, cloneName, cloneRepo, crumbs, folderError, freeName, isGitUrl, listFolders, startFolder } from "../server/repos.js";
import { runsMiddleware } from "../server/runs.js";

const sh = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const tmp = (name) => mkdtempSync(path.join(os.tmpdir(), `wb-${name}-`));

// A bare repo with one commit, to clone from over file://.
function bareRepo(root, name = "tiny.git") {
  const work = path.join(root, "work");
  mkdirSync(work);
  sh(work, "init", "-q");
  sh(work, "config", "user.email", "t@example.com");
  sh(work, "config", "user.name", "t");
  writeFileSync(path.join(work, "README.md"), "hello\n");
  sh(work, "add", "-A");
  sh(work, "commit", "-qm", "start");
  sh(root, "clone", "-q", "--bare", work, name);
  return path.join(root, name);
}

test("git URLs: https, ssh, git, file and scp-style; nothing else", () => {
  for (const u of [
    "https://github.com/octocat/Hello-World.git",
    "https://github.com/octocat/Hello-World",
    "ssh://git@github.com/octocat/Hello-World.git",
    "git://example.com/repo.git",
    "git@github.com:octocat/Hello-World.git",
    "file:///tmp/repos/tiny.git",
  ])
    assert.equal(isGitUrl(u), true, u);
  for (const u of [
    "",
    "--upload-pack=touch /tmp/x",
    "-q",
    "ext::sh -c touch% /tmp/pwned",
    "http://example.com/repo.git", // in the clear
    "ftp://example.com/repo.git",
    "/home/me/code/repo", // a local path: Browse is for those
    "../repo",
    "https://github.com/a b.git",
    "https://github.com/a\nb.git",
    "ssh://-oProxyCommand=touch%20x/repo",
    "ssh://-oProxyCommand=x@host/repo",
    "git@-oProxyCommand=x:repo",
    "javascript:alert(1)",
    `https://example.com/${"a".repeat(2000)}`,
    null,
  ])
    assert.equal(isGitUrl(u), false, String(u));
});

test("a clone's folder name comes from the URL's last part", () => {
  assert.equal(cloneName("https://github.com/octocat/Hello-World.git"), "Hello-World");
  assert.equal(cloneName("https://github.com/octocat/Hello-World/"), "Hello-World");
  assert.equal(cloneName("git@github.com:octocat/Spoon-Knife.git"), "Spoon-Knife");
  assert.equal(cloneName("git@host:solo.git"), "solo");
  assert.equal(cloneName("file:///tmp/repos/tiny.git"), "tiny");
  assert.equal(cloneName("https://example.com/r.git?ref=main#x"), "r");
  assert.equal(cloneName("https://example.com/we!rd name.git"), "we-rd-name");
  // Never a hidden folder, never empty, never a path.
  assert.equal(cloneName("https://example.com/.git"), "repo");
  assert.equal(cloneName("https://example.com/..git"), "repo");
  assert.equal(cloneName("https://example.com/.hidden.git"), "hidden");
  assert.doesNotMatch(cloneName("https://example.com/a%2F..%2Fb"), /[/\\]/);
});

test("a free name: name, then name-2, name-3…", () => {
  const taken = new Set(["linkshort", "repo", "repo-2"]);
  assert.equal(freeName("Hello-World", (n) => taken.has(n)), "Hello-World");
  assert.equal(freeName("linkshort", (n) => taken.has(n)), "linkshort-2");
  assert.equal(freeName("repo", (n) => taken.has(n)), "repo-3");
});

test("crumbs: each part of the path, with the folder it opens", () => {
  assert.deepEqual(crumbs("/home/me/code"), [
    { name: "/", path: "/" },
    { name: "home", path: "/home" },
    { name: "me", path: "/home/me" },
    { name: "code", path: "/home/me/code" },
  ]);
  assert.deepEqual(crumbs("/"), [{ name: "/", path: "/" }]);
});

test("a folder's subfolders: no files, no hidden ones, git repos marked", () => {
  const root = tmp("folders");
  try {
    for (const d of ["beta", "Alpha", "app10", "app9", ".hidden", "repo/.git", "repo/src", "worktree"]) mkdirSync(path.join(root, d), { recursive: true });
    writeFileSync(path.join(root, "worktree", ".git"), "gitdir: /elsewhere\n"); // a worktree's .git is a file
    writeFileSync(path.join(root, "notes.txt"), "not a folder\n");
    symlinkSync(path.join(root, "beta"), path.join(root, "linked"));
    symlinkSync(path.join(root, "notes.txt"), path.join(root, "file-link"));
    symlinkSync(path.join(root, "nowhere"), path.join(root, "dangling"));

    const at = listFolders(root);
    assert.equal(at.path, root);
    assert.equal(at.parent, path.dirname(root));
    assert.equal(at.repo, false);
    assert.equal(at.crumbs.at(-1).path, root);
    assert.deepEqual(
      at.folders.map((f) => [f.name, f.repo]),
      [["Alpha", false], ["app9", false], ["app10", false], ["beta", false], ["linked", false], ["repo", true], ["worktree", true]],
    );
    assert.equal(at.folders.find((f) => f.name === "repo").path, path.join(root, "repo"));
    assert.equal(at.more, 0);
    // Inside a repo: it's marked, and .git isn't listed.
    const repo = listFolders(path.join(root, "repo"));
    assert.equal(repo.repo, true);
    assert.deepEqual(repo.folders.map((f) => f.name), ["src"]);
    // A long folder is cut, and says how many more.
    const cut = listFolders(root, { max: 2 });
    assert.deepEqual([cut.folders.length, cut.more], [2, 5]);
    // The top has no parent.
    assert.equal(listFolders("/").parent, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder that can't be listed says why", () => {
  const root = tmp("nofolder");
  try {
    writeFileSync(path.join(root, "file.txt"), "x");
    const missing = path.join(root, "missing");
    const thrown = (dir) => {
      try {
        listFolders(dir);
      } catch (err) {
        return folderError(err, dir);
      }
      assert.fail(`listed ${dir}`);
    };
    assert.deepEqual(thrown(missing), { status: 404, error: `No such folder: ${missing}` });
    assert.deepEqual(thrown(path.join(root, "file.txt")), { status: 400, error: `Not a folder: ${path.join(root, "file.txt")}` });
    // Unreadable (root can read anything, so this one is the error as fs throws it).
    assert.deepEqual(folderError(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }), "/root"), { status: 403, error: "Can't open: /root" });
    assert.equal(folderError(new Error("boom"), "/x").status, 500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("where the picker opens: the field's folder, else the default repo's parent, else home", () => {
  const root = tmp("start");
  try {
    const home = path.join(root, "home");
    const sandbox = path.join(root, "sandbox");
    mkdirSync(path.join(home, "code"), { recursive: true });
    mkdirSync(path.join(sandbox, "linkshort"), { recursive: true });
    const opts = { defaultRepo: path.join(sandbox, "linkshort"), home };
    assert.equal(startFolder(path.join(sandbox, "linkshort"), opts), path.join(sandbox, "linkshort"));
    assert.equal(startFolder(path.join(home, "code", "half-typ"), opts), path.join(home, "code"));
    assert.equal(startFolder("~/code", opts), path.join(home, "code"));
    assert.equal(startFolder("", opts), sandbox);
    assert.equal(startFolder("/no/such/place", opts), sandbox);
    assert.equal(startFolder("", { defaultRepo: "/no/such/sandbox/repo", home }), home);
    assert.equal(startFolder(null, { home }), home);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git never asks: no prompts, ssh in batch mode, only the allowed transports", () => {
  const env = cloneEnv({ PATH: "/bin" });
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.GIT_ALLOW_PROTOCOL, "https:ssh:git:file");
  assert.equal(env.GIT_SSH_COMMAND, "ssh -o BatchMode=yes");
  assert.equal(cloneEnv({ GIT_SSH_COMMAND: "my-ssh" }).GIT_SSH_COMMAND, "my-ssh"); // yours wins
  assert.equal(cloneError({ code: 128, stderr: "Cloning into 'x'...\nfatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }), "Not found, or private. fatal: could not read Username for 'https://github.com': terminal prompts disabled");
  assert.equal(cloneError({ killed: true }, 5), "Gave up after 5 minutes.");
  assert.match(cloneError({ code: "ENOENT" }), /git isn't installed/);
});

test("clone: into a free folder, never over one, and git's error when it fails", async () => {
  const root = tmp("clone");
  try {
    const bare = bareRepo(root);
    const into = path.join(root, "sandbox");
    const url = `file://${bare}`;
    const one = await cloneRepo(url, { into });
    assert.deepEqual(one, { path: path.join(into, "tiny"), name: "tiny" });
    assert.equal(readFileSync(path.join(into, "tiny", "README.md"), "utf8"), "hello\n");
    assert.ok(existsSync(path.join(into, "tiny", ".git")));
    // Twice at once: each gets its own folder.
    const [two, three] = await Promise.all([cloneRepo(url, { into }), cloneRepo(url, { into })]);
    assert.deepEqual([two.name, three.name].sort(), ["tiny-2", "tiny-3"]);

    await assert.rejects(cloneRepo("--upload-pack=touch x", { into }), { status: 400, message: /Not a git URL/ });
    await assert.rejects(cloneRepo(`file://${path.join(root, "missing.git")}`, { into }), (err) => {
      assert.equal(err.status, 400);
      assert.match(err.message, /does not appear to be a git repository|not found|does not exist/i);
      assert.doesNotMatch(err.message, /Cloning into/);
      return true;
    });
    assert.ok(!existsSync(path.join(into, "missing")), "a failed clone leaves no folder");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the routes: GET /folders, POST /clone", async () => {
  const root = tmp("routes");
  const sandbox = path.join(root, "sandbox");
  mkdirSync(path.join(sandbox, "linkshort", ".git"), { recursive: true });
  const bare = bareRepo(root);
  const mw = runsMiddleware({ defaultRepo: path.join(sandbox, "linkshort"), sandbox });
  const server = http.createServer((req, res) => {
    req.url = req.url.replace(/^\/api\/runs/, "");
    mw(req, res, () => ((res.statusCode = 404), res.end()));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/runs`;
  const get = async (q) => {
    const res = await fetch(`${base}/folders?${new URLSearchParams(q)}`);
    return [res.status, await res.json()];
  };
  const post = async (body, type = "application/json") => {
    const res = await fetch(`${base}/clone`, { method: "POST", headers: { "content-type": type }, body: JSON.stringify(body) });
    return [res.status, await res.json()];
  };
  try {
    // Opens on the field's folder; with nothing in it, on the default repo's parent.
    let [status, at] = await get({ near: path.join(sandbox, "linkshort") });
    assert.deepEqual([status, at.path, at.repo], [200, path.join(sandbox, "linkshort"), true]);
    [status, at] = await get({ near: "" });
    assert.deepEqual([status, at.path, at.folders.map((f) => [f.name, f.repo])], [200, sandbox, [["linkshort", true]]]);
    [status, at] = await get({ path: path.join(root, "nope") });
    assert.deepEqual([status, at.error], [404, `No such folder: ${path.join(root, "nope")}`]);

    [status, at] = await post({ url: `file://${bare}` });
    assert.deepEqual([status, at], [200, { path: path.join(sandbox, "tiny"), name: "tiny" }]);
    [status, at] = await post({ url: "ext::sh -c touch% /tmp/pwned" });
    assert.equal(status, 400);
    assert.match(at.error, /Not a git URL/);
    // Not JSON (what a form on another site would send): refused before anything runs.
    [status, at] = await post({ url: `file://${bare}` }, "text/plain");
    assert.equal(status, 415);
    assert.ok(!existsSync(path.join(sandbox, "tiny-2")));
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
