// Turns streamed text + board ops into messages made of sentences.
// Each sentence remembers which board items (logical ids) it touched, which is
// what links a line of text to the shapes it drew.

let seq = 0;
const nextId = (p) => `${p}-${++seq}`;

export class Transcript {
  constructor(handlers) {
    this.h = handlers;
    this.clear();
  }

  clear() {
    this.messages = [];
    this.cur = null;
    this.sent = null;
    this.pendingEnd = false;
    this.h.onChange?.();
  }

  startMessage(role) {
    this.cur = { id: nextId("m"), role, items: [], streaming: true };
    this.messages.push(this.cur);
    this.sent = null;
    this.pendingEnd = false;
    this.h.onChange?.();
  }

  addUserMessage(data) {
    const m = { id: nextId("m"), role: "you", items: [], streaming: false, ...data };
    this.messages.push(m);
    this.h.onChange?.();
    return m;
  }

  addNotice(text) {
    this.messages.push({ id: nextId("m"), role: "notice", items: [], streaming: false, text });
    this.h.onChange?.();
  }

  text(chunk) {
    if (!this.cur) return;
    for (const ch of chunk) {
      if (this.pendingEnd) {
        this.pendingEnd = false;
        if (/\s/.test(ch)) {
          this.closeSentence();
          if (ch === "\n") this.breakPara();
          continue;
        }
      }
      if (ch === "\n") {
        this.closeSentence();
        this.breakPara();
        continue;
      }
      if (!this.sent) {
        if (/\s/.test(ch)) continue;
        this.openSentence();
      }
      this.sent.text += ch;
      if (".!?".includes(ch)) this.pendingEnd = true;
    }
    this.h.onChange?.();
  }

  // Tie board changes to text. Inline tags (demo) belong to the sentence being written;
  // an agent's tool calls come after it speaks, so they attach to the last sentence it wrote.
  op(ids, { attachToLast = false } = {}) {
    if (!this.cur) return;
    if (this.pendingEnd) {
      this.pendingEnd = false;
      this.closeSentence();
    }
    let target = this.sent;
    if (!target && attachToLast) target = [...this.cur.items].reverse().find((it) => it.type === "s" && it.text);
    if (!target) {
      this.openSentence();
      target = this.sent;
    }
    ids.forEach((i) => target.ids.add(i));
    target.ops++;
    this.h.onChange?.();
  }

  // A row for real work the agent did (read, edit, command…). Consecutive reads and searches fold into one row.
  activity({ kind, label, node, toolUseId }) {
    if (!this.cur) return;
    this.pendingEnd = false;
    this.closeSentence();
    const last = this.cur.items.at(-1);
    if (last?.type === "act" && last.kind === kind && (kind === "read" || kind === "search")) {
      last.labels.push(label);
      last.toolUseIds.push(toolUseId);
    } else {
      this.cur.items.push({
        type: "act", id: nextId("a"), kind, labels: [label], toolUseIds: [toolUseId],
        ids: new Set(node ? [`node:${node}`] : []), ok: null, summary: "",
      });
    }
    this.h.onChange?.();
  }

  activityResult({ toolUseId, ok, summary }) {
    for (const m of this.messages)
      for (const it of m.items)
        if (it.type === "act" && it.toolUseIds.includes(toolUseId)) {
          it.ok = ok;
          it.summary = summary;
          this.h.onChange?.();
          return;
        }
  }

  // A section break in the message when the agent moves to a new development phase.
  phase(key) {
    if (!this.cur || key === "complete") return;
    this.pendingEnd = false;
    this.closeSentence();
    this.cur.items.push({ type: "phase", key });
    this.h.onChange?.();
  }

  openSentence() {
    this.sent = { type: "s", id: nextId("s"), text: "", ids: new Set(), ops: 0, live: true };
    this.cur.items.push(this.sent);
    this.h.onOpen?.(this.sent);
  }

  closeSentence() {
    if (!this.sent) return;
    this.sent.live = false;
    this.h.onClose?.(this.sent);
    this.sent = null;
  }

  breakPara() {
    const it = this.cur.items;
    if (it.length && it[it.length - 1].type !== "br") it.push({ type: "br" });
  }

  endMessage() {
    if (!this.cur) return;
    this.pendingEnd = false;
    this.closeSentence();
    while (this.cur.items.at(-1)?.type === "br") this.cur.items.pop();
    this.cur.streaming = false;
    // A reply that failed before saying anything leaves no empty bubble behind.
    if (!this.cur.items.some((it) => it.text || it.type === "phase" || it.type === "act")) this.messages.splice(this.messages.indexOf(this.cur), 1);
    this.cur = null;
    this.h.onChange?.();
  }

  sentencesTouching(lids) {
    if (!lids.length) return [];
    const want = new Set(lids);
    const out = [];
    for (const m of this.messages)
      for (const it of m.items)
        if ((it.type === "s" || it.type === "act") && [...it.ids].some((i) => want.has(i))) out.push(it.id);
    return out;
  }
}
