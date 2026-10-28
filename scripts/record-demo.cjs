// Records the README's demo (screenshots/demo.gif) and an MP4 of the same frames, at most a minute,
// from the scripted demo in headless Chromium: an example run of an agent building DocQA, with a
// caption on every step and a ring on whatever is about to be clicked or is changing: the plan,
// D3 → Use this on Pinecone → close its card → Approve with changes, the build (the part being
// changed), the review, a short tour of the other views, and a card with what the board costs in
// tokens, standard and in shorthand mode.
//
//   npm run dev     # in another terminal, without an API key (the demo plays)
//   NODE_PATH=$(npm root -g) node scripts/record-demo.cjs <out-dir>
//   cp <out-dir>/demo.gif screenshots/demo.gif
//
// Playwright screenshots in a loop (~10 fps) with a fake cursor (headless frames have none), each
// frame tagged with a time warp (the waits sped up, the clicks at 1x), then ffmpeg: a concat list
// with per-frame durations, and the palette filters that keep the GIF small. Needs ffmpeg. It prints
// each step's place in the output and the total; keep the total at 60 s or less.
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL = process.env.WB_URL || "http://localhost:5199/";
const OUT = path.resolve(process.argv[2] || "demo-video");
const FRAMES = path.join(OUT, "frames");
const W = 1440, H = 900;
const WARP = { plan: 2.6, build: 2.6 }; // how much faster than real time the agent's planning and building play

// The card at the end. The numbers are docs/TOKEN_STUDY.md's: update them when it's rerun.
const TOKENS = {
  kicker: "TOKEN COST",
  title: "What the board costs, and shorthand mode",
  rows: [
    { big: "42–88", unit: "tokens", text: "per correction you send: only what changed. The agent reads the whole board when it needs it." },
    { big: "40.9k → 14.3k", unit: "tokens, first request", text: "Shorthand mode (on by default) gives the agent only the tools it uses and a one-string board tool." },
    { big: "–20 to –32%", unit: "board ops", text: "written as one line each instead of JSON. read_board answers in lines: –17%." },
    { big: "$0.67 → $0.39", unit: "per run, shorthand", text: "in a live A/B on a small task, cache cold (Claude Opus 5.5, effort low). With a warm cache: $0.38 → $0.27. Same tests, same proofs." },
  ],
  json: '{"op":"edge","from":"web","to":"api","via":"HTTP","api":"POST /ask {question}"}',
  jsonTokens: 26,
  line: 'edge web>api via=HTTP api="POST /ask {question}"',
  lineTokens: 15,
  foot: "o200k_base counts from scripts/token-study.mjs; first requests measured with scripts/prompt-size.mjs; costs as the Agent SDK billed them. docs/TOKEN_STUDY.md",
};

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

let page, warp = 1, capturing = true;
const frames = [];
async function captureLoop() {
  for (let n = 0; capturing; n++) {
    const t = Date.now();
    const file = path.join(FRAMES, `f${String(n).padStart(5, "0")}.jpg`);
    try {
      await page.screenshot({ path: file, type: "jpeg", quality: 88 });
      frames.push({ file, t, warp });
    } catch {}
    const spent = Date.now() - t;
    if (spent < 90) await new Promise((r) => setTimeout(r, 90 - spent));
  }
}

const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l14 9-6.5 1.5L9 19z" fill="#1e1b2e" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-50px", top: "-50px", zIndex: 2147483647, pointerEvents: "none", transition: "transform 80ms" });
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", () => (c.style.transform = "scale(0.82)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  };
  if (document.body) add(); else addEventListener("DOMContentLoaded", add);
})();`;

const sleep = (ms) => page.waitForTimeout(ms);
const S = (fn, arg) => page.evaluate(fn, arg);
async function moveTo(x, y, steps = 16) {
  await page.mouse.move(x, y, { steps });
  await sleep(140);
}
async function clickAt(x, y) {
  await moveTo(x, y);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
  await sleep(250);
}
async function clickEl(selector) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 60000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await clickAt(b.x + b.width / 2, b.y + b.height / 2);
}
// A caption under the board saying what's happening, in the app's own colours.
const caption = (text) =>
  S((text) => {
    let c = document.getElementById("demo-caption");
    if (!c) {
      c = document.createElement("div");
      c.id = "demo-caption";
      const board = document.querySelector(".lens-bar")?.getBoundingClientRect();
      Object.assign(c.style, {
        position: "fixed", bottom: "58px", left: `${board ? board.left + board.width / 2 : innerWidth / 3}px`, transform: "translateX(-50%)",
        zIndex: 2147483000, background: "var(--ink)", color: "var(--panel)", font: "600 20px var(--ui)", padding: "10px 22px",
        borderRadius: "999px", boxShadow: "var(--sh)", whiteSpace: "nowrap", transition: "opacity 200ms", opacity: "0",
      });
      document.body.appendChild(c);
    }
    c.textContent = text;
    c.style.opacity = text ? "1" : "0";
    // The corner label follows the layout, which settles after the intro.
    const l = document.getElementById("demo-label");
    const menu = document.querySelector('[data-tour="board"] .main-menu-trigger')?.getBoundingClientRect();
    if (l && menu) Object.assign(l.style, { top: `${menu.top + 2}px`, left: `${menu.right + 10}px` });
  }, text);

// What this is, in the corner for the whole video.
const label = (text) =>
  S((text) => {
    const c = document.createElement("div");
    c.id = "demo-label";
    // Beside Excalidraw's menu button, at the canvas's top left.
    const menu = document.querySelector('[data-tour="board"] .main-menu-trigger')?.getBoundingClientRect();
    Object.assign(c.style, {
      position: "fixed", top: `${menu ? menu.top + 2 : 220}px`, left: `${menu ? menu.right + 10 : 60}px`, zIndex: 2147483000,
      background: "var(--accent)", color: "var(--ink)", border: "var(--bw) solid var(--ink)", font: "700 15px var(--ui)",
      padding: "5px 12px", borderRadius: "999px", boxShadow: "var(--sh)", pointerEvents: "none",
    });
    c.textContent = text;
    document.body.appendChild(c);
  }, text);

// A pulsing orange ring round a rectangle on screen (null hides it).
const ringRect = (r) =>
  S((r) => {
    let c = document.getElementById("demo-ring");
    if (!c) {
      const st = document.createElement("style");
      st.textContent = "@keyframes demo-pulse{0%,100%{box-shadow:0 0 0 4px rgba(255,122,61,.35),0 0 18px 4px rgba(255,122,61,.55)}50%{box-shadow:0 0 0 9px rgba(255,122,61,.18),0 0 30px 10px rgba(255,122,61,.75)}}";
      document.head.appendChild(st);
      c = document.createElement("div");
      c.id = "demo-ring";
      Object.assign(c.style, { position: "fixed", zIndex: 2147482999, pointerEvents: "none", border: "4px solid #FF7A3D", borderRadius: "14px", animation: "demo-pulse 1s ease-in-out infinite", transition: "left 180ms, top 180ms, width 180ms, height 180ms, opacity 150ms" });
      document.body.appendChild(c);
    }
    if (!r) return void (c.style.opacity = "0");
    Object.assign(c.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px`, opacity: "1" });
  }, r);
const pad = (b, p = 8) => b && { x: b.x - p, y: b.y - p, w: b.width + 2 * p, h: b.height + 2 * p };
async function ring(selector, p) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 60000 });
  await el.scrollIntoViewIfNeeded();
  await ringRect(pad(await el.boundingBox(), p));
}
// A board element's rectangle on screen.
const boardRect = (id) =>
  S((id) => {
    const api = window.__wb.board.api;
    const e = api.getSceneElements().find((x) => x.id === id && !x.isDeleted);
    const st = api.getAppState();
    const z = st.zoom.value;
    return e && { x: (e.x + st.scrollX) * z + st.offsetLeft, y: (e.y + st.scrollY) * z + st.offsetTop, width: e.width * z, height: e.height * z };
  }, id);
// Ring a selector, wait, click it.
async function point(selector, ms = 700) {
  await ring(selector);
  await sleep(ms);
  await clickEl(selector);
  await ringRect(null);
}

const tokenCard = (stats) => {
  const back = document.createElement("div");
  Object.assign(back.style, { position: "fixed", inset: "0", background: "rgba(30,27,46,0.38)", display: "grid", placeItems: "center", zIndex: 2147483001, opacity: "0", transition: "opacity 400ms" });
  const rows = stats.rows
    .map((r) => `<div style="display:grid;grid-template-columns:250px 1fr;gap:18px;align-items:baseline;padding:10px 0;border-top:2px solid var(--line)">
        <div style="font-family:var(--display);font-weight:800;font-size:29px;color:var(--ink);letter-spacing:-0.5px;line-height:1.1">${r.big}<div style="font-family:var(--ui);font-size:14px;font-weight:700;color:var(--soft);letter-spacing:0">${r.unit}</div></div>
        <div style="font-family:var(--ui);font-size:18px;line-height:1.35;color:var(--soft)">${r.text}</div></div>`)
    .join("");
  const code = (tag, text, n) => `<div style="display:grid;grid-template-columns:96px 1fr 84px;gap:12px;align-items:center;margin-top:6px">
      <div style="font:800 13px var(--ui);letter-spacing:1px;color:var(--soft)">${tag}</div>
      <code style="font:13px ui-monospace,Menlo,monospace;background:var(--panel);border:2px solid var(--ink);border-radius:8px;padding:6px 10px;color:var(--ink);white-space:nowrap;overflow:hidden">${text.replace(/</g, "&lt;")}</code>
      <div style="font:800 18px var(--display);color:var(--ink);text-align:right">${n} tok</div></div>`;
  back.innerHTML = `<div style="width:900px;background:var(--marker-soft);border:var(--bw) solid var(--ink);border-radius:var(--r-card);box-shadow:var(--sh-lg);padding:26px 34px 18px">
      <div style="font-family:var(--ui);font-weight:800;font-size:15px;letter-spacing:2px;color:var(--accent-ink)">${stats.kicker}</div>
      <div style="font-family:var(--display);font-weight:800;font-size:36px;color:var(--ink);margin:4px 0 10px">${stats.title}</div>
      ${rows}
      <div style="padding:10px 0 12px;border-top:2px solid var(--line)">
        <div style="font:700 15px var(--ui);color:var(--ink);margin-bottom:2px">One board op, as JSON and as a shorthand line</div>
        ${code("JSON", stats.json, stats.jsonTokens)}${code("SHORTHAND", stats.line, stats.lineTokens)}
      </div>
      <div style="font-family:var(--ui);font-size:13px;color:var(--faint);padding-top:10px;border-top:2px solid var(--line)">${stats.foot}</div>
    </div>`;
  document.body.appendChild(back);
  requestAnimationFrame(() => (back.style.opacity = "1"));
};

async function record() {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(CURSOR);
  await page.goto(URL);
  await page.waitForFunction(() => window.__wb?.board?.api, null, { timeout: 30000 });
  const loop = captureLoop();
  // Where each step lands in the output, to keep the whole under a minute.
  const outAt = () => frames.reduce((s, f, i) => s + (i < frames.length - 1 ? (frames[i + 1].t - f.t) / 1000 / f.warp : 0), 0);
  const mark = (step) => console.log(`${outAt().toFixed(1).padStart(5)} s  ${step}`);

  // A first visit: the intro over the demo, which starts playing behind it.
  await moveTo(W / 2, H / 2 + 120, 1);
  await page.waitForSelector(".coach.tour.intro", { timeout: 15000 });
  await label("Example run · scripted demo");
  await caption("An agent builds DocQA, a chat-with-your-PDFs app. This run is scripted.");
  await sleep(2200);
  await point(".coach.tour.intro button:has-text('Skip the tour')", 500);
  mark("intro");

  // It plans, sped up.
  await caption("It reads the repo and draws its plan: parts, links, decisions (◇)");
  await S(() => (window.__wb.player.speed = 4));
  warp = WARP.plan;
  await page.waitForFunction(() => window.__wb.awaitingApproval, null, { timeout: 180000 });
  warp = 1;
  await caption("The plan waits for you: nothing is built until you approve");
  await sleep(1500);
  mark("plan ready");

  // Steer: click D3, use Pinecone instead, close its card, approve with changes.
  await caption("Click decision D3: which vector store, and why");
  const d3 = await boardRect("dec-d3");
  if (!d3) throw new Error("no D3 diamond on the board");
  await ringRect(pad(d3, 10));
  await sleep(900);
  await clickAt(d3.x + d3.width / 2, d3.y + d3.height / 2);
  await ringRect(null);
  await page.waitForSelector(".ex-use", { timeout: 15000 });
  await sleep(900);
  await caption("Use this: switch D3 to Pinecone");
  await point(".ex-use:has-text('Pinecone')", 900);
  await sleep(900);
  await caption("Close the card");
  await point(".ex-close", 500);
  await caption("Approve with changes: it updates the plan, then builds");
  await point('[data-tour="approve"]', 900);
  mark("approved");

  // It builds, tests and ships, sped up, with a ring on the part it's changing. A command prompt
  // is answered as a user would.
  await caption("It builds: the part it's changing turns orange, then green once tested");
  warp = WARP.build;
  let ringed = null;
  for (const until = Date.now() + 240000; ; ) {
    const st = await S(() => ({
      done: window.__wb.board.model.phase === "complete" && !window.__wb.player.busy,
      permit: !!document.querySelector(".permit button.primary"),
      building: Object.values(window.__wb.board.model.nodes).find((n) => n.status === "building")?.elId ?? null,
    }));
    if (st.done) break;
    if (st.permit) {
      warp = 1;
      await caption("It asks before every shell command: allow this test run");
      await point(".permit button.primary", 1000);
      await caption("It builds: the part it's changing turns orange, then green once tested");
      warp = WARP.build;
    }
    if (st.building !== ringed) {
      ringed = st.building;
      await ringRect(ringed ? pad(await boardRect(ringed), 6) : null);
    }
    if (Date.now() > until) throw new Error("the demo didn't finish");
    await sleep(300);
  }
  await ringRect(null);
  warp = 1;
  mark("shipped");

  // The review, at the top of the panel.
  await caption("The review: what to check, and the red pen on a claim that isn't true");
  await ring(".review", 6);
  const b = await page.locator(".review").first().boundingBox();
  if (b) await moveTo(b.x + b.width / 2, b.y + 24);
  await sleep(2600);
  await ringRect(null);
  mark("review");

  // The same plan, seen other ways.
  if (await page.locator(".ex-close").count()) await clickEl(".ex-close");
  const lensSel = (group, l) => `.lens-group[aria-label="${group}"] button.lens:text-is("${l}")`;
  const views = [
    ["C4", "Draw as C4: containers, with their type and technology"],
    ["Data flow", "Data flow: processes, stores, and what each link carries"],
    ["Database", "Database: the tables, with keys and relations"],
    ["Sequence", "Sequence: one flow, message by message"],
  ];
  for (const [l, text] of views) {
    await caption(text);
    await point(lensSel("Draw it as", l), 300);
    await sleep(850);
  }
  await clickEl(lensSel("Draw it as", "Pictures"));
  await caption("A flow: the path a question takes, numbered on the arrows");
  await ring("details.view-menu > summary", 6);
  await clickEl("details.view-menu > summary");
  await ringRect(null);
  await page.selectOption("select.focus-pick", "flow:ask");
  await clickEl("details.view-menu > summary");
  await sleep(1300);
  await clickEl("details.view-menu > summary");
  await page.selectOption("select.focus-pick", "");
  await clickEl("details.view-menu > summary");
  const layers = await page.$$eval('.lens-group[aria-label="Zoom into a layer"] button.lens', (bs) => bs.map((b) => b.textContent.trim()).filter((t) => t !== "Whole system"));
  for (const l of layers.filter((l) => l === "ML")) {
    await caption(`Zoom into ${l}: its parts, opened up in place`);
    await point(lensSel("Zoom into a layer", l), 300);
    await sleep(1300);
  }
  await clickEl(lensSel("Zoom into a layer", "Whole system"));
  await caption("Pin this view: C4 stays open beside Pictures");
  await clickEl(lensSel("Draw it as", "C4"));
  await point("button.lens-pin", 400);
  await clickEl(lensSel("Draw it as", "Pictures"));
  await sleep(1300);
  mark("views");

  // What it costs in tokens.
  await caption("");
  await moveTo(W - 40, 40);
  await S(tokenCard, TOKENS);
  await sleep(7500);
  mark("token card");

  capturing = false;
  await loop;
  await browser.close();
  if (errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
}

// Each frame lasts as long as it did, divided by its warp.
function encode() {
  const list = path.join(OUT, "frames.txt");
  let txt = "", total = 0;
  frames.forEach((f, i) => {
    const d = Math.max(0.02, (i < frames.length - 1 ? (frames[i + 1].t - f.t) / 1000 : 1) / f.warp);
    total += d;
    txt += `file '${f.file}'\nduration ${d.toFixed(3)}\n`;
  });
  txt += `file '${frames.at(-1).file}'\n`;
  fs.writeFileSync(list, txt);
  const input = ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list];
  execFileSync("ffmpeg", [...input, "-vf", "fps=30,scale=1440:-2,format=yuv420p", "-c:v", "libx264", "-crf", "22", "-preset", "slow", "-movflags", "+faststart", path.join(OUT, "demo.mp4")]);
  execFileSync("ffmpeg", [...input, "-vf", "fps=10,scale=1000:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", path.join(OUT, "demo.gif")]);
  const mb = (f) => (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1);
  console.log(`${total.toFixed(1)} s: demo.mp4 ${mb("demo.mp4")} MB, demo.gif ${mb("demo.gif")} MB, in ${OUT}`);
}

record()
  .then(encode)
  .catch(async (e) => {
    console.error("FAILED:", e.message);
    try {
      await page.screenshot({ path: path.join(OUT, "failed.png") });
    } catch {}
    process.exit(1);
  });
