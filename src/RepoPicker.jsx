// The start screen's Repository field, and two ways to fill it without typing a path: Browse this
// computer's folders (git repos marked), or Clone a git URL into sandbox/ (server/repos.js).
import { useEffect, useRef, useState } from "react";
import { cloneRepo, listFolders } from "./agent/live";

const ICONS = {
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3.3l1.4 1.6H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  clone: (
    <>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="4.5" r="1.5" />
      <path d="M4.5 5v6M11.5 6c0 3.2-7 2.3-7 5" />
    </>
  ),
  up: <path d="M8 13V3.5M4 7.5l4-4 4 4" />,
};
const Icon = ({ name }) => (
  <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    {ICONS[name]}
  </svg>
);

export function RepoField({ value, onChange }) {
  const [open, setOpen] = useState(null); // "browse" | "clone" | null
  const [url, setUrl] = useState("");
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState(null); // why the last clone failed, in git's words
  const [cloned, setCloned] = useState(null); // { path, name }: the last clone, while the field still points at it
  const field = useRef(null);
  // A path's end says which repo it is: show that end, unless you're typing in the field.
  useEffect(() => {
    if (field.current && document.activeElement !== field.current) field.current.scrollLeft = field.current.scrollWidth;
  }, [value]);
  const toggle = (what) => {
    setOpen((o) => (o === what ? null : what));
    setError(null);
  };
  const clone = async (e) => {
    e.preventDefault();
    setCloning(true);
    setError(null);
    try {
      const c = await cloneRepo(url.trim());
      setCloned(c);
      onChange(c.path);
      setUrl("");
      setOpen(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setCloning(false);
    }
  };
  return (
    <div className="rp" onKeyDown={(e) => e.key === "Escape" && !cloning && setOpen(null)}>
      <div className="rp-head">
        <label htmlFor="repo">Repository</label>
        {/* Both stay put while a clone runs: its answer lands in the field. */}
        <button type="button" className="rp-btn" aria-expanded={open === "browse"} disabled={cloning} onClick={() => toggle("browse")} title="Pick a folder on this computer">
          <Icon name="folder" />
          Browse
        </button>
        <button type="button" className="rp-btn" aria-expanded={open === "clone"} disabled={cloning} onClick={() => toggle("clone")} title="Clone a git repo into sandbox/">
          <Icon name="clone" />
          Clone
        </button>
      </div>
      <input id="repo" ref={field} value={value} onChange={(e) => onChange(e.target.value)} spellCheck="false" />
      {cloned?.path === value && <p className="rp-done">✓ Cloned into sandbox/{cloned.name}</p>}
      {open === "browse" && (
        <Folders
          start={value}
          onUse={(p) => {
            onChange(p);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {open === "clone" && (
        <form className="rp-card" onSubmit={clone} aria-label="Clone a git repo">
          <div className="rp-url">
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/owner/repo.git" aria-label="Git URL" spellCheck="false" autoFocus disabled={cloning} />
            <button type="submit" className="primary" disabled={cloning || !url.trim()}>
              {cloning ? "Cloning…" : "Clone"}
            </button>
          </div>
          {error && (
            <p className="rp-error" role="alert">
              ✗ {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}

// The folder explorer: the path (each part opens that folder), Up, the subfolders with git repos
// marked, and Use this folder. It opens on the folder in the field (server: startFolder).
function Folders({ start, onUse, onClose }) {
  const [at, setAt] = useState(null); // the listing (server: listFolders)
  const [error, setError] = useState(null);
  const asked = useRef(0); // only the latest click's answer counts
  const list = useRef(null);
  const go = async (where) => {
    const n = ++asked.current;
    try {
      const got = await listFolders(where);
      if (n !== asked.current) return;
      setAt(got);
      setError(null);
    } catch (err) {
      if (n === asked.current) setError(err.message); // the last folder stays listed
    }
  };
  useEffect(() => {
    go({ near: start });
  }, []);
  useEffect(() => {
    list.current?.scrollTo(0, 0); // a new folder starts at the top
  }, [at?.path]);
  const last = at ? at.crumbs.length - 1 : -1;
  return (
    <div className="rp-card" role="group" aria-label="Choose a folder">
      {at && (
        <nav className="rp-crumbs" aria-label="Path">
          {at.crumbs.map((c, i) =>
            i < last ? (
              <button key={c.path} type="button" onClick={() => go({ path: c.path })}>
                {c.name}
              </button>
            ) : (
              <b key={c.path} aria-current="location">
                {c.name}
                {at.repo && <span className="rp-git">git</span>}
              </b>
            ),
          )}
        </nav>
      )}
      <ul className="rp-list" ref={list}>
        {at?.parent && (
          <li>
            <button type="button" className="rp-row" onClick={() => go({ path: at.parent })}>
              <Icon name="up" />
              Up
            </button>
          </li>
        )}
        {at?.folders.map((f) => (
          <li key={f.path}>
            <button type="button" className={`rp-row${f.repo ? " repo" : ""}`} onClick={() => go({ path: f.path })} title={f.path}>
              <Icon name="folder" />
              <span className="rp-name">{f.name}</span>
              {f.repo && <span className="rp-git">git</span>}
            </button>
          </li>
        ))}
        {!at && !error && <li className="rp-none">…</li>}
        {at && !at.folders.length && <li className="rp-none">No folders</li>}
        {at?.more > 0 && <li className="rp-none">+{at.more} more</li>}
      </ul>
      {error && (
        <p className="rp-error" role="alert">
          ✗ {error}
        </p>
      )}
      <div className="rp-actions">
        <button type="button" className="secondary" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="primary" disabled={!at} onClick={() => onUse(at.path)}>
          Use this folder
        </button>
      </div>
    </div>
  );
}
