// Streaming parser for agent output. Plain text passes through to onText;
// <board op="..." .../> tags become onOp(attrs). Safe across arbitrary chunk
// boundaries, because a real LLM stream can split a tag anywhere.

const TAG = "<board";

export function findTagEnd(s, from = 0) {
  let quoted = false;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (c === ">" && !quoted) return i;
  }
  return -1;
}

// Accepts single quotes too: models occasionally use them despite the prompt.
export function parseAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w-]+)=(?:"([^"]*)"|'([^']*)')/g)) out[m[1]] = m[2] ?? m[3];
  return out;
}

export function createStreamParser({ onText, onOp }) {
  let buf = "";

  const drain = (final) => {
    while (buf) {
      const lt = buf.indexOf("<");
      if (lt === -1) {
        onText(buf);
        buf = "";
        return;
      }
      if (lt > 0) {
        onText(buf.slice(0, lt));
        buf = buf.slice(lt);
      }
      // Could still become "<board" once more text arrives.
      if (buf.length < TAG.length && TAG.startsWith(buf) && !final) return;
      if (!buf.startsWith(TAG)) {
        onText("<");
        buf = buf.slice(1);
        continue;
      }
      const end = findTagEnd(buf);
      if (end === -1) {
        if (final) buf = ""; // stream ended mid-tag: drop it
        return;
      }
      onOp(parseAttrs(buf.slice(0, end + 1)));
      buf = buf.slice(end + 1);
    }
  };

  return {
    push(chunk) {
      buf += chunk;
      drain(false);
    },
    end() {
      drain(true);
      buf = "";
    },
    reset() {
      buf = "";
    },
  };
}
