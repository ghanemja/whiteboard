import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Choosing the repo a run works in, from the start screen: browse this machine's folders, or
// clone a git URL into sandbox/. The browser only ever sees folder names (never a file, let alone
// what's in one), and git is run without a shell, never stops to ask for a password, and only
// fetches over https, ssh, git or file.
//
//   GET  /api/runs/folders?path=…  -> { path, parent, repo, crumbs, folders: [{ name, path, repo }], more }
//   GET  /api/runs/folders?near=…  -> the same for where the picker opens (startFolder)
//   POST /api/runs/clone           <- { url }  -> { path, name }

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
// A git repo's top folder holds .git: a folder, or a file in a worktree or submodule.
const isRepo = (dir) => existsSync(path.join(dir, ".git"));

// /home/me/code -> /, home, me, code: each with the folder it opens.
export function crumbs(dir) {
  const { root } = path.parse(dir);
  const out = [{ name: root, path: root }];
  let at = root;
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) out.push({ name: part, path: (at = path.join(at, part)) });
  return out;
}

// A folder's subfolders, sorted by name; hidden ones are left out (.git only marks a repo).
// Throws what readdir throws (ENOENT, ENOTDIR, EACCES): folderError() words it.
export function listFolders(dir, { max = 500 } = {}) {
  const at = path.resolve(dir);
  const names = readdirSync(at, { withFileTypes: true })
    .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(at, e.name)))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
  const parent = path.dirname(at);
  return {
    path: at,
    parent: parent === at ? null : parent,
    repo: isRepo(at),
    crumbs: crumbs(at),
    folders: names.slice(0, max).map((name) => ({ name, path: path.join(at, name), repo: isRepo(path.join(at, name)) })),
    more: Math.max(0, names.length - max),
  };
}

// Why a folder can't be listed, in a few words, with the HTTP status for it.
export function folderError(err, dir) {
  const [status, why] = { ENOENT: [404, "No such folder"], ENOTDIR: [400, "Not a folder"], EACCES: [403, "Can't open"], EPERM: [403, "Can't open"] }[err?.code] ?? [500, null];
  return { status, error: why ? `${why}: ${dir}` : err?.message ?? String(err) };
}

// Where the picker opens: the folder in the repo field (or the one it's in, when the field names
// a file or is half typed), else the default repo's parent (sandbox/, where clones go), else home.
export function startFolder(field, { defaultRepo, home = os.homedir() } = {}) {
  const typed = String(field ?? "").trim().replace(/^~(?=$|[/\\])/, home);
  const tries = typed ? [path.resolve(typed), path.dirname(path.resolve(typed))] : [];
  if (defaultRepo) tries.push(path.dirname(path.resolve(defaultRepo)));
  return tries.find(isDir) ?? home;
}

// ---- clone ----

// What we'll clone from: https://, ssh://, git:// and file:// URLs, and scp-style user@host:path.
// Nothing that starts with "-" (git would read it as an option), no spaces or control characters,
// and no other transport (ext:: runs a command, http:// is in the clear).
export function isGitUrl(url) {
  const u = String(url ?? "");
  if (!u || u.length > 2000 || u.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(u)) return false;
  if (/^[\w.-]+@[A-Za-z0-9][\w.-]*:(?!\/\/)\S+$/.test(u)) return true; // git@github.com:owner/repo.git
  try {
    const { protocol, hostname, username, pathname } = new URL(u);
    if (protocol === "file:") return pathname.length > 1;
    return ["https:", "ssh:", "git:"].includes(protocol) && Boolean(hostname) && !hostname.startsWith("-") && !username.startsWith("-");
  } catch {
    return false;
  }
}

// The folder a clone goes in: the URL's last part without ".git", as one safe folder name
// (https://github.com/octocat/Hello-World.git -> Hello-World).
export function cloneName(url) {
  const last = String(url ?? "").replace(/[?#].*$/, "").replace(/[/\\]+$/, "").split(/[/\\:]/).pop();
  return last.replace(/\.git$/i, "").replace(/[^\w.-]+/g, "-").replace(/^[.-]+/, "").slice(0, 100) || "repo";
}

// name, or name-2, name-3… if that's taken.
export function freeName(name, taken) {
  if (!taken(name)) return name;
  for (let i = 2; ; i++) if (!taken(`${name}-${i}`)) return `${name}-${i}`;
}

// git must never wait for someone to type: no username or password prompt (a private or missing
// repo fails instead), no credential manager window, ssh in batch mode (no passphrase or new-host
// question) unless you've set your own ssh command; and only the transports isGitUrl lets through.
export const cloneEnv = (env = process.env) => ({
  ...env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_ALLOW_PROTOCOL: "https:ssh:git:file",
  ...(env.GIT_SSH_COMMAND || env.GIT_SSH ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes" }),
});

// git's own words for a failed clone: its error lines, without "Cloning into…".
export function cloneError({ code, killed, stderr }, minutes) {
  if (code === "ENOENT") return "git isn't installed (or isn't on the PATH).";
  if (killed) return `Gave up after ${minutes} minutes.`;
  const said = String(stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !/^Cloning into\b/.test(l)).join("\n");
  // GitHub and others answer a missing repo like a private one: they ask who you are.
  if (/terminal prompts disabled|could not read (Username|Password)/i.test(said)) return `Not found, or private. ${said}`;
  return said.slice(-600) || "git clone failed.";
}

const CLONE_MS = 5 * 60 * 1000;
const cloning = new Set(); // folders a clone is going into right now, so two at once can't pick the same one

// Clones url into into/<name> (a free name), with no shell. Resolves { path, name }; rejects with
// an Error whose status is 400 (bad URL, or git refused) or 504 (too slow). git removes a half-made
// clone itself, even when the timeout stops it.
export async function cloneRepo(url, { into, timeout = CLONE_MS } = {}) {
  const u = String(url ?? "").trim();
  if (!isGitUrl(u)) throw Object.assign(new Error("Not a git URL. Use https://, ssh://, git:// or git@host:path."), { status: 400 });
  mkdirSync(into, { recursive: true });
  const name = freeName(cloneName(u), (n) => existsSync(path.join(into, n)) || cloning.has(path.join(into, n)));
  const dest = path.join(into, name);
  cloning.add(dest);
  try {
    await new Promise((resolve, reject) => {
      const git = execFile("git", ["clone", "--", u, dest], { env: cloneEnv(), timeout, maxBuffer: 4 * 1024 * 1024 }, (err, _out, stderr) =>
        err ? reject(Object.assign(new Error(cloneError({ ...err, stderr }, timeout / 60000)), { status: err.killed ? 504 : 400 })) : resolve(),
      );
      git.stdin?.end(); // nothing to read: anything that tries gets end-of-file, not a wait
    });
    return { path: dest, name };
  } finally {
    cloning.delete(dest);
  }
}
