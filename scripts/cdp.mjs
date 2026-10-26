// Minimal Chrome DevTools Protocol driver for a headless Chrome on 127.0.0.1:<port>, used to
// drive and screenshot the app while testing (see HANDOFF.md, "Testing"). Start Chrome with e.g.
//   chrome --headless=new --remote-debugging-address=127.0.0.1 --remote-debugging-port=9444 \
//     --user-data-dir=/tmp/wb-chrome --window-size=1440,987 --force-device-scale-factor=2 http://localhost:5199/
//   node scripts/cdp.mjs <port> eval '<js>'        evaluate in the page, print the value as JSON
//   node scripts/cdp.mjs <port> click <x> <y>      a real mouse click at CSS pixel (x, y)
//   node scripts/cdp.mjs <port> drag <x1> <y1> <x2> <y2>  a real mouse drag, in small steps
//   node scripts/cdp.mjs <port> type '<text>'      type into the focused field
//   node scripts/cdp.mjs <port> shot <file.png>    full-resolution screenshot
//   node scripts/cdp.mjs <port> record <dir> <ms>  a JPEG every <ms> until <dir>/STOP exists; logs status to <dir>/frames.tsv
import { writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";

const [port, cmd, ...args] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let seq = 0;
const waiting = new Map();
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)(m);
    waiting.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
};

const STATUS = `(() => { const s = window.__wb; if (!s) return "no-session";
  const d = Object.values(s.board?.model?.decisions ?? {}).map((x) => "D" + x.n + ":" + x.state).join(" ");
  return [s.board?.model?.phase ?? "-", s.state?.busy ? "busy" : "idle", s.gate ? "gate" : "", s.permission ? "perm" : "", s.result ? "done" : "", d].join(" ").replace(/ +/g, " ");
})()`;

if (cmd === "eval") {
  console.log(JSON.stringify(await evaluate(args[0]), null, 1));
} else if (cmd === "click") {
  const [x, y] = args.map(Number);
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await send("Input.dispatchMouseEvent", type === "mouseMoved" ? { type, x, y } : { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
} else if (cmd === "drag") {
  const [x1, y1, x2, y2] = args.map(Number);
  const pause = () => new Promise((r) => setTimeout(r, 16));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1, y: y1 });
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: x1, y: y1, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 12; i++) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x1 + ((x2 - x1) * i) / 12, y: y1 + ((y2 - y1) * i) / 12, button: "left", buttons: 1 });
    await pause();
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x2, y: y2, button: "left", buttons: 0, clickCount: 1 });
} else if (cmd === "type") {
  await send("Input.insertText", { text: args[0] });
} else if (cmd === "shot") {
  const { data } = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(args[0], Buffer.from(data, "base64"));
  console.log(args[0], await evaluate(STATUS));
} else if (cmd === "record") {
  const [dir, ms] = [args[0], Number(args[1] ?? 1500)];
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  for (let n = 0; !existsSync(`${dir}/STOP`); n++) {
    const started = Date.now();
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 80 });
    const name = `${String(n).padStart(4, "0")}.jpg`;
    writeFileSync(`${dir}/${name}`, Buffer.from(data, "base64"));
    appendFileSync(`${dir}/frames.tsv`, `${name}\t${((started - t0) / 1000).toFixed(1)}\t${await evaluate(STATUS)}\n`);
    await new Promise((r) => setTimeout(r, Math.max(0, ms - (Date.now() - started))));
  }
}
ws.close();
