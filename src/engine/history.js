// What you typed before (tasks and messages), for ↑ and ↓ in the message box, like a shell: ↑ goes
// back one entry, ↓ forward, and past the newest you get back what you were typing. Pure: storage
// is passed in (localStorage in the browser), so it's tested under node --test.
export const HISTORY_MAX = 100;

export function createHistory({ load = () => [], save = () => {} } = {}) {
  let items = [];
  try {
    items = (load() ?? []).filter((s) => typeof s === "string" && s.trim()).slice(-HISTORY_MAX);
  } catch {
    items = [];
  }
  let at = items.length; // items.length: not browsing
  let draft = ""; // what was in the box when browsing started

  return {
    get items() {
      return items.slice();
    },
    // A sent line: the newest entry (once, if it repeats the last one), and browsing ends.
    push(text) {
      const t = String(text ?? "").trim();
      at = items.length;
      if (!t) return;
      if (items.at(-1) !== t) items = [...items, t].slice(-HISTORY_MAX);
      at = items.length;
      draft = "";
      try {
        save(items);
      } catch {
        /* storage full or blocked: history still works for this page */
      }
    },
    // ↑: the entry before, or null when there's nothing older (leave the box as it is).
    up(current) {
      if (at === 0 || !items.length) return null;
      if (at === items.length) draft = current ?? "";
      at--;
      return items[at];
    },
    // ↓: the entry after, the draft past the newest, or null when not browsing.
    down() {
      if (at >= items.length) return null;
      at++;
      return at === items.length ? draft : items[at];
    },
    // Typing something else ends browsing; ↑ starts again from the newest.
    reset() {
      at = items.length;
    },
  };
}
