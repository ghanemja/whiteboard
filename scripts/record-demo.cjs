// Records the README's demo (screenshots/demo.gif) and an MP4 of the same frames, from the
// scripted demo in headless Chromium: the intro, the plan, Use this on D3 → Pinecone, the build,
// the review, a tour of the other views (every notation, a flow, each layer opened up, a pinned
// view), the Timeline, and a card with what the board costs in tokens.
//
//   npm run dev     # in another terminal, without an API key (the demo plays)
//   NODE_PATH=$(npm root -g) node scripts/record-demo.cjs <out-dir>
//   cp <out-dir>/demo.gif screenshots/demo.gif
//
// Playwright screenshots in a loop (~10 fps) with a fake cursor (headless frames have none), each
// frame tagged with a time warp (the waits sped up, the clicks at 1x), then ffmpeg: a concat list
// with per-frame durations, and the palette filters that keep the GIF small. Needs ffmpeg.
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL = process.env.WB_URL || "http://localhost:5199/";
const OUT = path.resolve(process.argv[2] || "demo-video");
const FRAMES = path.join(OUT, "frames");
const W = 1440, H = 900;

// The card at the end. The numbers are docs/TOKEN_STUDY.md's: update them when it's rerun.
const TOKENS = {
  kicker: "TOKEN COST",
  title: "What the board adds",
  rows: [
    { big: "42–88 tokens", text: "per correction you send: only the change. The agent reads the whole board only when it needs it (it was 1,142–1,188 tokens a message)." },
    { big: "4,605 tokens", text: "on every request for the board’s instructions and its two tools, cached after the first." },
    { big: "$0.37–$0.65", text: "per run in six live runs of a small task (Claude Opus 5.5, effort low), as the Agent SDK billed them." },
  ],
  foot: "Counts from scripts/token-study.mjs (o200k_base) and the live runs’ own transcripts. Details in docs/TOKEN_STUDY.md.",
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
// A button in the bar above the board: "Draw it as" or "Zoom into a layer".
const lens = (group, label) => clickEl(`.lens-group[aria-label="${group}"] button.lens:text-is("${label}")`);
const boardPoint = (id) =>
  S((id) => {
    const api = window.__wb.board.api;
    const e = api.getSceneElements().find((x) => x.id === id);
    const st = api.getAppState();
    return e && { x: (e.x + e.width / 2 + st.scrollX) * st.zoom.value + st.offsetLeft, y: (e.y + e.height / 2 + st.scrollY) * st.zoom.value + st.offsetTop };
  }, id);

// A caption over the board naming the view on screen, in the app's own colours.
const caption = (text) =>
  S((text) => {
    let c = document.getElementById("demo-caption");
    if (!c) {
      c = document.createElement("div");
      c.id = "demo-caption";
      const board = document.querySelector(".lens-bar")?.getBoundingClientRect();
      Object.assign(c.style, {
        position: "fixed", bottom: "64px", left: `${board ? board.left + board.width / 2 : innerWidth / 3}px`, transform: "translateX(-50%)",
        zIndex: 2147483000, background: "var(--ink)", color: "var(--panel)", font: "600 19px var(--ui)", padding: "10px 20px",
        borderRadius: "999px", boxShadow: "var(--sh)", whiteSpace: "nowrap", transition: "opacity 250ms", opacity: "0",
      });
      document.body.appendChild(c);
    }
    c.textContent = text;
    c.style.opacity = text ? "1" : "0";
  }, text);

const tokenCard = (stats) => {
  const back = document.createElement("div");
  Object.assign(back.style, { position: "fixed", inset: "0", background: "rgba(30,27,46,0.38)", display: "grid", placeItems: "center", zIndex: 2147483000, opacity: "0", transition: "opacity 400ms" });
  const rows = stats.rows
    .map((r) => `<div style="display:grid;grid-template-columns:230px 1fr;gap:18px;align-items:baseline;padding:14px 0;border-top:2px solid var(--line)">
        <div style="font-family:var(--display);font-weight:800;font-size:34px;color:var(--ink);letter-spacing:-0.5px">${r.big}</div>
        <div style="font-family:var(--ui);font-size:19px;line-height:1.4;color:var(--soft)">${r.text}</div></div>`)
    .join("");
  back.innerHTML = `<div style="width:820px;background:var(--marker-soft);border:var(--bw) solid var(--ink);border-radius:var(--r-card);box-shadow:var(--sh-lg);padding:30px 36px 22px">
      <div style="font-family:var(--ui);font-weight:800;font-size:15px;letter-spacing:2px;color:var(--accent-ink)">${stats.kicker}</div>
      <div style="font-family:var(--display);font-weight:800;font-size:40px;color:var(--ink);margin:6px 0 14px">${stats.title}</div>
      ${rows}
      <div style="font-family:var(--ui);font-size:15px;color:var(--faint);padding-top:12px;border-top:2px solid var(--line)">${stats.foot}</div>
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
  const mark = (label) => console.log(`${label} (${frames.length} frames)`);

  // A first visit: the intro over the demo, which starts playing behind it.
  await moveTo(W / 2, H / 2 + 120, 1);
  await page.waitForSelector(".coach.tour.intro", { timeout: 15000 });
  await sleep(2600);
  await clickEl(".coach.tour.intro button:has-text('Skip the tour')");
  mark("intro");

  // It plans, sped up.
  await S(() => (window.__wb.player.speed = 4));
  warp = 3;
  await page.waitForFunction(() => window.__wb.awaitingApproval, null, { timeout: 180000 });
  warp = 1;
  await sleep(1200);
  mark("plan ready");

  // Steer: click D3, use Pinecone instead, approve with changes.
  const d3 = await boardPoint("dec-d3");
  if (!d3) throw new Error("no D3 diamond on the board");
  await clickAt(d3.x, d3.y);
  await page.waitForSelector(".ex-use", { timeout: 15000 });
  await sleep(1400);
  await clickEl(".ex-use:has-text('Pinecone')");
  await sleep(1400);
  await clickEl('[data-tour="approve"]');
  mark("approved");

  // It builds, tests and ships, sped up. A command prompt is answered as a user would.
  warp = 4;
  for (const until = Date.now() + 240000; ; ) {
    const st = await S(() => ({ done: window.__wb.board.model.phase === "complete" && !window.__wb.player.busy, permit: !!document.querySelector(".permit button.primary") }));
    if (st.done) break;
    if (st.permit) {
      warp = 1;
      await sleep(700);
      await clickEl(".permit button.primary");
      warp = 4;
    }
    if (Date.now() > until) throw new Error("the demo didn't finish");
    await sleep(400);
  }
  warp = 1;
  await sleep(1500);
  mark("shipped");

  // The review, at the top of the panel.
  const review = page.locator(".review").first();
  if (await review.count()) {
    await review.scrollIntoViewIfNeeded();
    const b = await review.boundingBox();
    if (b) await moveTo(b.x + b.width / 2, b.y + 20);
  }
  await sleep(2800);
  mark("review");

  // The same plan, seen other ways.
  if (await page.locator(".ex-close").count()) await clickEl(".ex-close");
  const views = [
    ["C4", "Draw as C4: container boxes, each with its type and technology"],
    ["Data flow", "Draw as Data flow: processes, data stores, and what each link carries"],
    ["Database", "Draw as Database: the tables each store holds, with keys and relations"],
    ["Sequence", "Draw as Sequence: one flow, message by message"],
  ];
  for (const [label, text] of views) {
    await caption(text);
    await lens("Draw it as", label);
    await sleep(2500);
  }
  await lens("Draw it as", "Pictures");
  await caption("Show a flow: the path a question takes, numbered on the arrows");
  await clickEl("details.view-menu > summary");
  await sleep(500);
  await page.selectOption("select.focus-pick", "flow:ask");
  await sleep(300);
  await clickEl("details.view-menu > summary");
  await sleep(2600);
  await clickEl("details.view-menu > summary");
  await page.selectOption("select.focus-pick", "");
  await clickEl("details.view-menu > summary");
  const layers = await page.$$eval('.lens-group[aria-label="Zoom into a layer"] button.lens', (bs) => bs.map((b) => b.textContent.trim()).filter((t) => t !== "Whole system"));
  for (const label of layers) {
    await caption(`Zoom into ${label}: what its parts are made of, in place`);
    await lens("Zoom into a layer", label);
    await sleep(2300);
  }
  await lens("Zoom into a layer", "Whole system");
  await caption("Pin this view: C4 stays open while the board shows Pictures");
  await lens("Draw it as", "C4");
  await clickEl("button.lens-pin");
  await lens("Draw it as", "Pictures");
  await sleep(2800);
  if (await page.locator(".pin-close").count()) await clickEl(".pin-close");
  await caption("");
  mark("views");

  // The Timeline: how the decisions moved.
  await clickEl('[data-tour="timeline-tab"]');
  await sleep(3400);
  mark("timeline");

  // What it costs in tokens.
  await moveTo(W - 40, 40);
  await S(tokenCard, TOKENS);
  await sleep(8500);
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
