import { findTagEnd } from "./parser";

const TAG = "<board";

// Types agent messages out at a readable pace, pausing briefly on each board op so
// the change lands visibly. An item is either a finished script ({ script } or
// { build }) or a live stream ({ stream }) whose text arrives while it plays;
// live items wait for text to arrive and speed up when they fall behind.
export class Player {
  constructor({ onStart, onChunk, onEnd, onState }) {
    this.h = { onStart, onChunk, onEnd, onState };
    this.queue = [];
    this.cur = null;
    this.pos = 0;
    this.speed = 1;
    this.paused = false;
    this.timer = null;
  }

  get busy() {
    return !!this.cur || this.queue.length > 0;
  }

  // True while a live item is waiting for its first words (the model is thinking).
  get thinking() {
    return !!this.cur?.stream && this.cur.script === "" && this.cur.streaming;
  }

  enqueue(item) {
    this.queue.push(item);
    if (!this.cur) this.next();
    this.h.onState?.();
  }

  next() {
    const item = (this.cur = this.queue.shift() || null);
    if (item) {
      if (item.build) item.script = item.build();
      if (item.stream) {
        item.script = "";
        item.streaming = true;
        item.startedAt = Date.now();
        item.abort = new AbortController();
        item
          .stream({
            signal: item.abort.signal,
            onText: (t) => {
              item.script += t;
            },
          })
          .catch((err) => {
            item.error = err;
          })
          .finally(() => {
            item.streaming = false;
            this.h.onState?.();
          });
      }
      this.pos = 0;
      this.h.onStart?.(item);
      this.schedule(0);
    }
    this.h.onState?.();
  }

  schedule(delay) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.step(), delay);
  }

  step() {
    if (this.paused || !this.cur) return;
    const item = this.cur;
    const s = item.script;
    const live = !!item.stream;

    if (this.pos >= s.length) {
      if (item.streaming) return this.schedule(40); // wait for more text
      this.cur = null;
      this.h.onEnd?.(item);
      this.next();
      return;
    }

    let out = "";
    let delay = 28;
    // Live replies can outrun the typewriter; widen the step as the backlog grows.
    let budget = live ? 2 + Math.floor((s.length - this.pos) / 80) : 2;
    while (budget > 0 && this.pos < s.length) {
      if (s[this.pos] === "<") {
        const rest = s.slice(this.pos, this.pos + TAG.length);
        // A tag that hasn't fully arrived yet: hold here until it has.
        if (item.streaming && rest.length < TAG.length && TAG.startsWith(rest)) break;
        if (rest === TAG) {
          const end = findTagEnd(s, this.pos);
          if (end === -1 && item.streaming) break;
          const stop = end === -1 ? s.length : end + 1;
          out += s.slice(this.pos, stop);
          this.pos = stop;
          delay = 140;
          break;
        }
      }
      const ch = s[this.pos++];
      out += ch;
      budget--;
      if (".!?".includes(ch) && /\s/.test(s[this.pos] ?? " ")) {
        delay = live ? 200 : 320;
        break;
      }
      if (ch === "\n") {
        delay = 180;
        break;
      }
    }
    if (out) this.h.onChunk?.(out);
    else delay = 40; // stalled on a partial tag
    this.schedule(delay / this.speed);
  }

  pause() {
    this.paused = true;
    clearTimeout(this.timer);
    this.h.onState?.();
  }

  resume() {
    this.paused = false;
    if (this.cur) this.schedule(0);
    this.h.onState?.();
  }

  stop() {
    clearTimeout(this.timer);
    this.cur?.abort?.abort();
    this.queue = [];
    this.cur = null;
    this.paused = false;
    this.h.onState?.();
  }
}
