// Records the advertisement (screenshots/ad/ad.mp4, about 95 s) and a short GIF cut of it (ad.gif:
// steering, the build and the red pen, about 25 s), with music from scripts/ad-music.mjs, and the
// README's GIF (demo.gif: the scripted demo part alone, about 55 s).
// It opens on the problem in a few title cards, shows the answer in the app, and closes on the
// line and the repo URL. Captions on every beat, an orange ring on what to look at.
//
//   1. Three problems, quickly: the word vomit (agents explain in walls of markdown), cognitive
//      offloading (hand off the thinking and the understanding goes too), and the game of telephone
//      (between agents, sessions and days an idea drifts; nobody holds it the same way twice). Then
//      the idea: like a show on in the background, a board is something you take in without trying.
//   2. The scripted demo (an agent builds DocQA): the plan drawn as parts, links and ◇ decisions;
//      D3's card; Use this; a Why? sticker answered in a bubble; Approve with changes; the build
//      (orange, then green); a command prompt; D2 failing its eval, changing and proven ✓; the red
//      pen on a claim that isn't true; the Reasoning tab; the Timeline; C4, Database, UML (Class,
//      Component, Sequence, Activity ticked one by one), Zoom into ML, and a Clean PNG export.
//   3. A real run on the sample repo (sandbox/linkshort), replayed from its recording: Just map it,
//      then a question answered with nothing to approve. Then the board saved in the repo as
//      whiteboard.zip: the start screen finds it, Open it restores it, and its decisions.md.
//   4. The end card.
//
// Part 3 needs that real run first, made once with a model (in a cloud container, Claude Code's
// own sign-in does: ANTHROPIC_AUTH_TOKEN=placeholder-not-a-secret):
//
//   npm run sandbox                     # a repo with no board yet
//   ANTHROPIC_AUTH_TOKEN=… npm run dev  # live mode; the demo is still one click away
//   # in the app: Just map it, then ask "How does a short link get resolved to its URL?"
//   NODE_PATH=$(npm root -g) node scripts/record-ad.cjs <out-dir>
//
// The run's id is found by its task ("Map the codebase") in the saved runs; RUN=<id> picks one.
// Frames and warps work as in record-demo.cjs: screenshots in a loop, each tagged with how much
// faster than real time it plays, then ffmpeg. It prints each beat's place in the output.
const { chromium } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const URL = process.env.WB_URL || "http://localhost:5199/";
const OUT = path.resolve(process.argv[2] || "ad-video");
const FRAMES = path.join(OUT, "frames");
const W = 1440, H = 900;
const WARP = { plan: 3.8, build: 4, replay: 6 };
const REPO_URL = "github.com/ghanemja/whiteboard";
const QUESTION = "How does a short link get resolved to its URL?";

fs.rmSync(FRAMES, { recursive: true, force: true });
fs.mkdirSync(FRAMES, { recursive: true });

let page, warp = 1, capturing = true, paused = false;
const at = {}; // where each beat ends in the output, for the GIF cut
const frames = [];
async function captureLoop() {
  for (let n = 0; capturing; n++) {
    const t = Date.now();
    const file = path.join(FRAMES, `f${String(n).padStart(5, "0")}.jpg`);
    if (paused) {
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    try {
      await page.screenshot({ path: file, type: "jpeg", quality: 90 });
      frames.push({ file, t, warp });
    } catch (e) {
      if (process.env.DEBUG) console.log("frame:", e.message.split("\n")[0]);
    }
    const spent = Date.now() - t;
    if (spent < 90) await new Promise((r) => setTimeout(r, 90 - spent));
  }
}

const CURSOR = `(() => {
  const add = () => {
    if (document.getElementById("demo-cursor")) return;
    const c = document.createElement("div");
    c.id = "demo-cursor";
    c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2l14 9-6.5 1.5L9 19z" fill="#1e1b2e" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: "fixed", left: "-50px", top: "-50px", zIndex: 2147483647, pointerEvents: "none", transition: "transform 80ms" });
    document.body.appendChild(c);
    addEventListener("mousemove", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("dragover", (e) => { c.style.left = e.clientX - 3 + "px"; c.style.top = e.clientY - 2 + "px"; }, true);
    addEventListener("mousedown", () => (c.style.transform = "scale(0.82)"), true);
    addEventListener("mouseup", () => (c.style.transform = ""), true);
  };
  if (document.body) add(); else addEventListener("DOMContentLoaded", add);
  try { localStorage.setItem("wb-tour", "done"); localStorage.setItem("wb-uml", '["class"]'); localStorage.setItem("wb-diagram", "pictures"); localStorage.setItem("wb-export-look", "clean"); } catch {}
})();`;

const sleep = (ms) => page.waitForTimeout(ms);
const S = (fn, arg) => page.evaluate(fn, arg);
async function moveTo(x, y, steps = 14) {
  await page.mouse.move(x, y, { steps });
  await sleep(120);
}
async function clickAt(x, y) {
  await moveTo(x, y);
  await page.mouse.down();
  await sleep(80);
  await page.mouse.up();
  await sleep(220);
}
async function clickEl(selector) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 60000 });
  await el.scrollIntoViewIfNeeded();
  const b = await el.boundingBox();
  await clickAt(b.x + b.width / 2, b.y + b.height / 2);
}

// A caption at the bottom of the board, large, in the app's ink and paper.
const caption = (text) =>
  S((text) => {
    let c = document.getElementById("ad-caption");
    if (!c) {
      c = document.createElement("div");
      c.id = "ad-caption";
      Object.assign(c.style, {
        position: "fixed", bottom: "64px", left: "505px", transform: "translateX(-50%)", maxWidth: "960px", textAlign: "center",
        zIndex: 2147483000, background: "var(--ink)", color: "#fff", font: "650 25px/1.25 var(--ui)", padding: "12px 26px",
        borderRadius: "22px", boxShadow: "4px 4px 0 var(--accent)", transition: "opacity 200ms", opacity: "0", textWrap: "balance",
      });
      document.body.appendChild(c);
    }
    c.innerHTML = text;
    c.style.opacity = text ? "1" : "0";
  }, text);

// What's on screen, in the corner: scripted, or a real run replayed.
const label = (text) =>
  S((text) => {
    let c = document.getElementById("ad-label");
    if (!c) {
      c = document.createElement("div");
      c.id = "ad-label";
      Object.assign(c.style, {
        position: "fixed", bottom: "14px", left: "505px", transform: "translateX(-50%)", zIndex: 2147483000,
        background: "var(--accent)", color: "var(--ink)", border: "var(--bw) solid var(--ink)", font: "750 15px var(--ui)",
        padding: "4px 12px", borderRadius: "999px", boxShadow: "var(--sh)", pointerEvents: "none", whiteSpace: "nowrap",
      });
      document.body.appendChild(c);
    }
    c.textContent = text;
    c.style.display = text ? "" : "none";
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
// The screen rectangle round a set of board elements (by id, or by a test on the element).
const boardRect = (ids) =>
  S((ids) => {
    const api = window.__wb.board.api;
    const st = api.getAppState();
    const z = st.zoom.value;
    const els = api.getSceneElements().filter((e) => !e.isDeleted && (Array.isArray(ids) ? ids.includes(e.id) : e.id.startsWith(ids)));
    if (!els.length) return null;
    const x1 = Math.min(...els.map((e) => e.x)), y1 = Math.min(...els.map((e) => e.y));
    const x2 = Math.max(...els.map((e) => e.x + e.width)), y2 = Math.max(...els.map((e) => e.y + e.height));
    return { x: (x1 + st.scrollX) * z + st.offsetLeft, y: (y1 + st.scrollY) * z + st.offsetTop, width: (x2 - x1) * z, height: (y2 - y1) * z };
  }, ids);
async function point(selector, ms = 600) {
  await ring(selector);
  await sleep(ms);
  await clickEl(selector);
  await ringRect(null);
}

// A full-screen card: the title cards at the start and the end, on paper, in ink and orange.
const card = (html) =>
  S((html) => {
    let c = document.getElementById("ad-card");
    if (!c) {
      c = document.createElement("div");
      c.id = "ad-card";
      Object.assign(c.style, { position: "fixed", inset: "0", zIndex: 2147483646, background: "var(--paper)", display: "grid", placeItems: "center", transition: "opacity 350ms", opacity: "0", overflow: "hidden" });
      document.body.appendChild(c);
    }
    if (html == null) return void (c.style.opacity = "0", setTimeout(() => (c.style.display = "none"), 380));
    c.style.display = "grid";
    c.innerHTML = html;
    requestAnimationFrame(() => (c.style.opacity = "1"));
  }, html);
const big = (lines, { kicker = "", sub = "", back = "" } = {}) =>
  `${back}<div style="position:relative;text-align:center;max-width:1180px;padding:0 40px">
    ${kicker ? `<div style="font:800 22px var(--ui);letter-spacing:3px;color:var(--accent-ink);margin-bottom:18px">${kicker}</div>` : ""}
    <div style="font:800 76px/1.04 var(--display);color:var(--ink);letter-spacing:-2px;text-wrap:balance">${lines}</div>
    ${sub ? `<div style="font:500 32px/1.35 var(--ui);color:var(--soft);margin-top:26px;text-wrap:balance">${sub}</div>` : ""}
  </div>`;
const mark = (s) => `<span style="background:var(--accent);border:3px solid var(--ink);border-radius:14px;padding:0 14px;box-shadow:5px 5px 0 var(--ink);display:inline-block;transform:rotate(-1.2deg)">${s}</span>`;

// The wall of markdown behind the second card: this repo's own HANDOFF.md, scrolling.
const handoff = fs.readFileSync(path.join(__dirname, "..", "HANDOFF.md"), "utf8").replace(/&/g, "&amp;").replace(/</g, "&lt;");
const wall = `<div style="position:absolute;inset:-40px;columns:3;column-gap:28px;padding:0 30px;font:13px/1.5 ui-monospace,Menlo,monospace;color:var(--ink);opacity:.13;white-space:pre-wrap;overflow:hidden">
  <div style="animation:ad-scroll 9s linear forwards">${handoff.slice(0, 26000)}</div></div>
  <style>@keyframes ad-scroll{to{transform:translateY(-900px)}}</style>`;

// The idea passed along, drifting a little at each hop.
const hops = [["You", "Rate-limit the login"], ["Agent", "Limit login rates"], ["Next session", "Add login limits"], ["Day 3", "Cap all requests?"], ["Teammate", "Why is the API slow?"]];
const telephone = `Keeping agents on track and in sync: between agents, sessions and days, the idea drifts. Nobody holds it the same way twice.
  <div style="display:flex;gap:10px;justify-content:center;margin-top:30px;flex-wrap:nowrap">${hops
    .map(([who, said], i) => `<div style="opacity:0;animation:ad-in 300ms ${350 + i * 520}ms forwards;display:flex;align-items:center;gap:10px">${i ? '<span style="font:800 30px var(--display);color:var(--ink)">→</span>' : ""}
      <div style="background:${i === hops.length - 1 ? "var(--accent-soft)" : "var(--panel)"};border:3px solid var(--ink);border-radius:14px;box-shadow:4px 4px 0 var(--ink);padding:8px 14px;text-align:left;transform:rotate(${i % 2 ? 1 : -1}deg)">
      <div style="font:800 14px var(--ui);letter-spacing:1px;color:var(--accent-ink)">${who.toUpperCase()}</div>
      <div style="font:600 20px var(--hand);color:var(--ink);white-space:nowrap">“${said}”</div></div></div>`)
    .join("")}</div><style>@keyframes ad-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}</style>`;


// The idea card's picture: a show on in the background while people work, and bits of it drifting
// over to them. Ink lines on paper, the accent for the show, the app's hand font for the bubbles.
const ink = 'stroke="var(--ink)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"';
const show = `<svg viewBox="0 0 900 360" width="900" height="360" style="display:block;margin:18px auto 0;overflow:visible">
  <style>
    .sw-bar{animation:sw-bar 4.5s linear forwards;transform-box:fill-box;transform-origin:0 50%}
    @keyframes sw-bar{from{transform:scaleX(.18)}to{transform:scaleX(.62)}}
    .sw-scene{animation:sw-pan 4.5s ease-in-out infinite alternate}
    @keyframes sw-pan{to{transform:translateX(-28px)}}
    .sw-code rect{transform-box:fill-box;transform-origin:0 50%;animation:sw-type 1.6s steps(6) infinite}
    .sw-code rect:nth-child(2){animation-delay:.4s}.sw-code rect:nth-child(3){animation-delay:.8s}.sw-code rect:nth-child(4){animation-delay:1.2s}
    @keyframes sw-type{from{transform:scaleX(.1)}to{transform:scaleX(1)}}
    .sw-look{transform-box:fill-box;transform-origin:50% 100%;animation:sw-look 4.5s ease-in-out infinite}
    @keyframes sw-look{0%,30%,62%,100%{transform:rotate(0)}38%,54%{transform:rotate(14deg)}}
    .sw-look2{transform-box:fill-box;transform-origin:50% 100%;animation:sw-look2 4.5s ease-in-out infinite}
    @keyframes sw-look2{0%,12%,40%,100%{transform:rotate(0)}18%,34%{transform:rotate(-12deg)}}
    .sw-steam path{animation:sw-steam 1.8s ease-in-out infinite;opacity:0}
    .sw-steam path:nth-child(2){animation-delay:.9s}
    @keyframes sw-steam{0%{opacity:0;transform:translateY(6px)}40%{opacity:.7}100%{opacity:0;transform:translateY(-16px)}}
    .sw-b{opacity:0;animation:sw-b .6s ease-out forwards}
    @keyframes sw-b{from{opacity:0;transform:translate(var(--dx),var(--dy)) scale(.6)}to{opacity:1;transform:none}}
    .sw-page{transform-box:fill-box;transform-origin:0 50%;animation:sw-page 2.2s ease-in-out infinite}
    @keyframes sw-page{0%,70%{transform:scaleX(1)}85%{transform:scaleX(-1)}100%{transform:scaleX(1)}}
  </style>
  <!-- the screen on the wall, playing a show -->
  <rect x="300" y="6" width="300" height="172" rx="14" fill="var(--ink)" ${ink}/>
  <clipPath id="sw-clip"><rect x="312" y="18" width="276" height="134" rx="6"/></clipPath>
  <g clip-path="url(#sw-clip)"><g class="sw-scene">
    <rect x="300" y="18" width="340" height="134" fill="#ffe6d8"/>
    <circle cx="540" cy="54" r="18" fill="var(--marker)"/>
    <path d="M300 152 Q360 92 420 122 T540 112 T660 128 V160 H300Z" fill="#b2f2bb"/>
    <path d="M300 152 Q380 120 460 140 T640 136 V160 H300Z" fill="#69db7c"/>
    <circle cx="420" cy="104" r="9" fill="var(--ink)"/><path d="M420 113 v24 M420 120 l-10 8 M420 120 l10 8 M420 137 l-7 12 M420 137 l7 12" ${ink} stroke-width="2.5"/>
    <circle cx="470" cy="108" r="9" fill="var(--accent-ink)"/><path d="M470 117 v22 M470 124 l-10 6 M470 124 l10 6 M470 139 l-7 11 M470 139 l7 11" stroke="var(--accent-ink)" stroke-width="2.5" stroke-linecap="round"/>
  </g></g>
  <rect x="312" y="160" width="276" height="6" rx="3" fill="#ffffff55"/>
  <rect class="sw-bar" x="312" y="160" width="276" height="6" rx="3" fill="var(--accent)"/>
  <path d="M450 178 v14 M410 194 h80" ${ink}/>
  <!-- the desk: a mug, a laptop, a stack of books -->
  <path d="M30 300 H480" ${ink}/>
  <path d="M50 300 V316 M460 300 V350 M50 316 V350" ${ink}/>
  <rect x="58" y="262" width="34" height="38" rx="6" fill="var(--panel)" ${ink}/><path d="M92 272 q14 0 14 12 t-14 10" fill="none" ${ink}/>
  <g class="sw-steam" fill="none" stroke="var(--soft)" stroke-width="2.5" stroke-linecap="round"><path d="M68 252 q-6 -8 0 -16 t0 -16"/><path d="M82 252 q-6 -8 0 -16 t0 -16"/></g>
  <path d="M205 300 L215 210 H345 L335 300 Z" fill="var(--panel)" ${ink}/>
  <g class="sw-code"><rect x="228" y="228" width="80" height="7" rx="3" fill="#7048e8"/><rect x="236" y="244" width="64" height="7" rx="3" fill="#1c7ed6"/><rect x="236" y="260" width="88" height="7" rx="3" fill="#0ca678"/><rect x="228" y="276" width="52" height="7" rx="3" fill="var(--accent)"/></g>
  <path d="M190 300 H350" ${ink} stroke-width="5"/>
  <rect x="372" y="284" width="92" height="16" rx="3" fill="#e7f5ff" ${ink}/>
  <rect x="380" y="268" width="80" height="16" rx="3" fill="#fff4e6" ${ink}/>
  <rect x="368" y="252" width="88" height="16" rx="3" fill="var(--accent-soft)" ${ink}/>
  <!-- someone at the desk, working, glancing up now and then -->
  <path d="M120 360 Q118 270 150 240 Q176 222 196 250 L214 292" fill="var(--marker-soft)" ${ink}/>
  <g class="sw-look"><circle cx="150" cy="205" r="27" fill="var(--panel)" ${ink}/><path d="M124 196 Q150 168 176 196" fill="var(--ink)" ${ink}/><circle cx="164" cy="208" r="2.5" fill="var(--ink)"/></g>
  <!-- someone on the couch with a book, the show on -->
  <path d="M600 350 V280 Q600 262 618 262 H850 Q868 262 868 280 V350" fill="#f3f0ff" ${ink}/>
  <path d="M612 300 H856" ${ink}/>
  <path d="M700 300 Q696 244 730 228 Q760 220 772 252 L790 300" fill="#e6fcf5" ${ink}/>
  <g class="sw-look2"><circle cx="736" cy="196" r="26" fill="var(--panel)" ${ink}/><path d="M710 190 Q736 160 762 190 L764 214" fill="var(--accent-ink)" ${ink}/><circle cx="724" cy="200" r="2.5" fill="var(--ink)"/></g>
  <path d="M760 276 L790 262 L820 276 L790 284 Z" fill="var(--panel)" ${ink}/><path class="sw-page" d="M790 262 L818 250 L820 276" fill="var(--marker-soft)" ${ink} stroke-width="2"/>
  <!-- what drifts over from the show -->
  <g font-family="var(--hand)" font-size="21" fill="var(--ink)">
    <g class="sw-b" style="--dx:120px;--dy:-30px;animation-delay:.5s"><rect x="150" y="96" width="140" height="38" rx="18" fill="var(--panel)" ${ink} stroke-width="2.5"/><text x="220" y="122" text-anchor="middle">who's who</text></g>
    <g class="sw-b" style="--dx:-110px;--dy:-30px;animation-delay:1.3s"><rect x="640" y="104" width="170" height="38" rx="18" fill="var(--panel)" ${ink} stroke-width="2.5"/><text x="725" y="130" text-anchor="middle">what happened</text></g>
    <g class="sw-b" style="--dx:130px;--dy:-10px;animation-delay:2.1s"><rect x="18" y="140" width="110" height="38" rx="18" fill="var(--accent-soft)" ${ink} stroke-width="2.5"/><text x="73" y="166" text-anchor="middle">and why</text></g>
  </g>
</svg>`;

async function record() {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: W, height: H }, acceptDownloads: true });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(CURSOR);
  await page.goto(URL);
  await page.waitForFunction(() => window.__wb?.board?.api, null, { timeout: 30000 });
  const live = await S(() => fetch("/api/runs/status").then((r) => r.json()).then((s) => s.live));
  if (!live) throw new Error("start the dev server in live mode (a model configured): part 3 needs the start screen and the saved board");
  const runs = await S(() => fetch("/api/runs/recordings").then((r) => r.json()));
  const real = process.env.RUN || (runs.recordings ?? runs).find((r) => /map the codebase/i.test(r.brief || "") || r.map)?.id;
  if (!real) throw new Error("no saved run of Just map it: make one first (see the top of this file)");

  await card(big(`The word vomit.`, { kicker: "PROBLEM 1", sub: "Agents explain themselves in walls of text: chat, HANDOFF.md, plans, logs. Nobody reads it all.", back: wall }));
  const loop = captureLoop();
  const outAt = () => frames.reduce((s, f, i) => s + (i < frames.length - 1 ? (frames[i + 1].t - f.t) / 1000 / f.warp : 0), 0);
  const beat = (step) => console.log(`${(at[step] = outAt()).toFixed(1).padStart(5)} s  ${step}`);

  // START=real begins at part 3, to retune it without the rest.
  if (process.env.START !== "real") {
  // 1. Three problems, quickly, then the idea.
  await sleep(2900);
  await card(big(`Cognitive ${mark("offloading")}.`, { kicker: "PROBLEM 2", sub: "We hand the thinking to the agent, partly because it's so hard to follow what it's doing. Then someone has to scale and deploy what nobody can explain." }));
  await sleep(3100);
  await card(big(`A game of ${mark("telephone")}.`, { kicker: "PROBLEM 3", sub: telephone }));
  await sleep(3800);
  await card(big(`Ever learned from a show you ${mark("half watched")}?`, { kicker: "THE IDEA: PASSIVE LEARNING", sub: `Netflix on in the background while you work: pieces of it stick.${show}` }));
  await sleep(4500);
  await card(big(`So the agent ${mark("draws")} its work.`, { kicker: "AGENT WHITEBOARD", sub: "Not a cure for cognitive offloading: 20% better. Its plan, reasoning and progress on a board you take in at a glance, and can question and steer." }));
  await sleep(2600);
  beat("problem cards");

  // 2. The scripted demo, from live mode's start screen.
  await page.locator("button:has-text('Or watch the scripted demo')").waitFor({ timeout: 30000 });
  await page.locator("button:has-text('Or watch the scripted demo')").evaluate((b) => b.click());
  await S(() => (window.__wb.player.speed = 4));
  await sleep(300);
  await card(null);
  await label("Scripted demo: an agent builds DocQA");
  await caption("The agent draws its plan as pictures: parts, connections, numbered decisions ◇");
  warp = WARP.plan;
  await page.waitForFunction(() => window.__wb.awaitingApproval, null, { timeout: 180000 });
  warp = 1;
  await caption("Nothing is built until you approve it");
  await sleep(1000);
  beat("plan drawn");

  const d3 = await boardRect(["dec-d3"]);
  if (!d3) throw new Error("no D3 on the board");
  await caption("Click D3: which vector store, and why");
  await ringRect(pad(d3, 10));
  await sleep(700);
  await clickAt(d3.x + d3.width / 2, d3.y + d3.height / 2);
  await ringRect(null);
  await page.waitForSelector(".explain", { timeout: 15000 });
  await caption("What it chose, over what, why, and the evidence");
  await ring(".explain", 4);
  await sleep(1700);
  await caption("Disagree? <b>Use this</b> on another option");
  await point(".ex-use:has-text('Pinecone')", 600);
  await sleep(500);
  await clickEl(".ex-close");
  beat("D3 and Use this");

  // A Why? sticker on D1, answered in a bubble beside it.
  await caption("Or ask: drop a <b>Why?</b> sticker on a decision");
  const why = page.locator(".sticker-tray .sticker").filter({ hasText: "Why?" }).first();
  await ring(".sticker-tray", 4);
  await sleep(400);
  await ringRect(null);
  const d1 = await boardRect(["dec-d1"]);
  const wb = await why.boundingBox();
  await moveTo(wb.x + wb.width / 2, wb.y + wb.height / 2);
  await why.dragTo(page.locator(".canvas.arch canvas.interactive").first(), {
    targetPosition: await S(({ x, y }) => { const r = document.querySelector(".canvas.arch canvas.interactive").getBoundingClientRect(); return { x: x - r.left, y: y - r.top }; }, { x: d1.x + d1.width / 2, y: d1.y + d1.height / 2 }),
  });
  await page.waitForFunction(() => window.__wb.board.api.getSceneElements().some((e) => !e.isDeleted && e.customData?.answers && !e.customData?.pending && e.type === "rectangle"), null, { timeout: 60000 });
  await S(() => window.__wb.board.api.updateScene({ appState: { selectedElementIds: {} } }));
  await caption("It answers beside the sticker: the reason, from the repo");
  await ringRect(pad(await boardRect("ans-"), 8));
  await sleep(2100);
  await ringRect(null);
  beat("Why? sticker");

  await caption("<b>Approve with changes</b>: it takes your pick, then builds");
  await point('[data-tour="approve"]', 800);

  // 3. The build: the part being changed rings orange, then goes green; one command prompt.
  await caption("It builds: each part turns orange as it's changed, green once tested");
  warp = WARP.build;
  let ringed = null, saidD2 = false;
  for (const until = Date.now() + 240000; ; ) {
    const st = await S(() => {
      const m = window.__wb.board.model;
      return {
        done: m.phase === "complete" && !window.__wb.player.busy,
        permit: !!document.querySelector(".permit button.primary"),
        building: Object.values(m.nodes).find((n) => n.status === "building")?.elId ?? null,
        d2: m.decisions.d2?.proof ?? null,
        d2changed: m.decisions.d2?.state === "changed",
      };
    });
    if (st.done) break;
    if (st.permit) {
      warp = 1;
      await caption("It asks before every shell command");
      await point(".permit button.primary", 900);
      await caption("It builds: each part turns orange as it's changed, green once tested");
      warp = WARP.build;
    }
    if (st.d2 === "fail" && !saidD2) {
      saidD2 = true;
      warp = 1.4;
      await caption("D2 fails its check: the eval finds 41 of 50 pages. So D2 changes.");
      ringed = "d2";
      await ringRect(pad(await boardRect(["dec-d2", "dec-d2-pf"]), 12));
      await sleep(1800);
      warp = WARP.build;
    } else if (st.d2 === "pass" && saidD2 === true) {
      saidD2 = "proven";
      warp = 1.2;
      await caption("Eval again: 47 of 50. D2 is proven ✓ from the run's output");
      await ringRect(pad(await boardRect(["dec-d2", "dec-d2-pf"]), 12));
      await sleep(2000);
      await caption("It builds: each part turns orange as it's changed, green once tested");
      warp = WARP.build;
      ringed = null;
    } else if (st.building !== ringed && ringed !== "d2") {
      ringed = st.building;
      await ringRect(ringed ? pad(await boardRect([ringed]), 6) : null);
    }
    if (Date.now() > until) throw new Error("the demo didn't finish");
    await sleep(250);
  }
  await ringRect(null);
  warp = 1;
  beat("built and shipped");

  // 4. The red pen: a claim that isn't true, marked on the board.
  await caption("Then the red pen. It said “I documented the setup in README.md”.");
  await page.waitForFunction(() => window.__wb.board.api.getSceneElements().some((e) => !e.isDeleted && e.id.startsWith("pen-")), null, { timeout: 20000 });
  // Close in on the mark, with the parts above it in view.
  await S(() => {
    const api = window.__wb.board.api;
    const near = ["eval", "s3"].map((n) => window.__wb.board.model.nodes[n]?.elId).filter(Boolean);
    const els = api.getSceneElements().filter((e) => !e.isDeleted && (e.id.startsWith("pen-") || near.includes(e.id)));
    api.scrollToContent(els, { fitToViewport: true, viewportZoomFactor: 0.7, animate: true, duration: 500 });
  });
  await sleep(700);
  const pen = await boardRect("pen-");
  await ringRect(pad(pen, 14));
  await sleep(1800);
  await caption("It never touched README.md. The board says so, in red.");
  await clickAt(pen.x + pen.width / 2, pen.y + pen.height / 2);
  await ringRect(null);
  await sleep(400);
  if (await page.locator(".said").count()) await ring(".said", 4);
  await sleep(2100);
  await ringRect(null);
  await S(() => window.__wb.board.fit(true));
  beat("red pen");

  // 5. The Reasoning tab, then the Timeline.
  await caption("Reasoning: each decision's evidence, what it shapes, and the proof");
  await point('.canvas-tabs button[data-tour="why-tab"]', 300);
  await sleep(2500);
  beat("reasoning");

  // The Timeline.
  await caption("The Timeline: when each decision changed, and what changed it");
  await clickEl('.canvas-tabs button[data-tour="timeline-tab"]');
  await sleep(1900);
  await clickEl('.canvas-tabs button[data-tour="arch-tab"]');
  beat("timeline");

  // 6. Views.
  if (await page.locator(".ex-close").count()) await clickEl(".ex-close");
  const lens = (group, l) => `.lens-group[aria-label="${group}"] button.lens:text-is("${l}")`;
  await caption("The same plan, as C4");
  await point(lens("Draw it as", "C4"), 250);
  await sleep(900);
  beat("· c4");
  await caption("As the database: tables, keys, relations");
  await point(lens("Draw it as", "Database"), 250);
  await sleep(1000);
  beat("· database");
  await caption("As UML: the class diagram, then tick Component, Sequence, Activity");
  await point(lens("Draw it as", "UML"), 250);
  await sleep(300);
  for (const k of ["Component", "Sequence", "Activity"]) {
    await clickEl(`.uml-pick label.uml-box:has-text("${k}")`);
    await sleep(200);
  }
  await sleep(700);
  beat("· uml");
  await caption("Zoom into a layer: ML, opened up in place");
  await clickEl(lens("Draw it as", "Pictures"));
  await point(lens("Zoom into a layer", "ML"), 300);
  await sleep(1500);
  await clickEl(lens("Zoom into a layer", "Whole system"));
  beat("· zoom");
  await caption("Export it <b>Clean</b>, ready for slides");
  await clickEl(lens("Draw it as", "C4"));
  await clickEl("details.view-menu > summary");
  const download = page.waitForEvent("download", { timeout: 20000 });
  await clickEl(".view-items button:has-text('Download PNG')");
  const png = path.join(OUT, "export.png");
  await (await download).saveAs(png);
  await S((src) => {
    const d = document.createElement("div");
    d.id = "ad-export";
    Object.assign(d.style, { position: "fixed", inset: "0", zIndex: 2147482990, background: "rgba(30,27,46,.45)", display: "grid", placeItems: "center" });
    d.innerHTML = `<img src="${src}" style="max-width:1000px;max-height:640px;background:#fff;border:3px solid var(--ink);border-radius:16px;box-shadow:var(--sh-lg);padding:14px">`;
    document.body.appendChild(d);
  }, `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`);
  await sleep(2000);
  await S(() => document.getElementById("ad-export")?.remove());
  await clickEl(lens("Draw it as", "Pictures"));
  beat("views");
  }

  // 7. A real run, replayed: the map of a repo it had never seen, then a question.
  await card(big(`Now a ${mark("real")} run.`, { sub: "A repo with no board yet: a tiny URL shortener. Replayed from its recording." }));
  await sleep(600);
  // A fresh page in live mode (the demo can't go back to the start screen), its load not filmed.
  paused = true;
  await page.goto(URL);
  await page.waitForFunction(() => window.__wb?.board?.api, null, { timeout: 30000 });
  await card(big(`Now a ${mark("real")} run.`, { sub: "A repo with no board yet: a tiny URL shortener. Replayed from its recording." }));
  await page.waitForSelector(`.saved-row`, { timeout: 15000 });
  await sleep(400);
  paused = false;
  await sleep(700);
  await page.locator(".saved-row").filter({ hasText: "linkshort" }).locator("button:has-text('Replay')").first().evaluate((b) => b.click());
  await page.waitForFunction(() => window.__wb.replay, null, { timeout: 15000 });
  await card(null);
  await label("Real run, replayed: Claude on the sample repo");
  await caption("No board yet, so it maps the code first: parts, links, flows, the choices already made");
  warp = WARP.replay;
  // The question you typed: the replay reaches its user event.
  await page.waitForFunction(() => { const r = window.__wb.replay; return r && (r.done || r.events.slice(0, r.i).some((e) => e.type === "user")); }, null, { timeout: 120000 });
  warp = 1;
  await caption(`Ask a question: “${QUESTION}”`);
  await sleep(1200);
  warp = WARP.replay;
  // Stop at the answer's end (the recording goes on to the agent stopping once it sat idle).
  await page.waitForFunction(() => { const r = window.__wb.replay; return r && (r.done || r.events.slice(0, r.i).filter((e) => e.type === "done").length >= 2); }, null, { timeout: 120000 });
  await S(() => !window.__wb.replay.done && window.__wb.toggleReplay());
  warp = 1;
  await caption("It answers, and points at the flow it drew. Nothing to approve, no files changed.");
  await ring('.said[aria-label="Its reply"]', 4);
  await sleep(2100);
  await ringRect(null);
  await clickEl("details.view-menu > summary");
  const f2 = await page.$$eval("select.focus-pick option", (os) => os.find((o) => /resolve|redirect|follow/i.test(o.textContent))?.value ?? os.at(-1)?.value);
  await page.selectOption("select.focus-pick", f2);
  await clickEl("details.view-menu > summary");
  await sleep(1700);
  beat("real run: map and question");

  // 8. The living document: whiteboard.zip in the repo.
  await clickEl('button[title^="Start over"], button[aria-label^="Start over"]');
  await page.waitForSelector(".repo-board", { timeout: 15000 });
  await label("Real: the start screen, on the same repo");
  await caption("The board was saved in the repo as <b>whiteboard.zip</b>. Commit it.");
  await ring(".repo-board", 6);
  await sleep(1900);
  await caption("Whoever opens the repo next, person or agent, starts from this board");
  await point(".repo-board button:has-text('Open it')", 500);
  await page.waitForFunction(() => Object.keys(window.__wb.board.model.nodes).length > 0, null, { timeout: 15000 });
  await sleep(1000);
  const log = await S((id) => fetch(`/api/runs/recordings/${id}/decisions`).then((r) => r.text()), real);
  // The log's top, its goal, its first decisions and its timeline: the diagrams are left out here.
  const all = log.split("\n");
  const from = (h, n) => all.slice(all.findIndex((l) => l.startsWith(h)), all.findIndex((l) => l.startsWith(h)) + n);
  const lines = [all[0], ...from("### Goal", 3), ...from("### Decisions", 20), ...from("## Timeline", 6)].filter((l) => l.trim()).join("\n");
  await S((text) => {
    const d = document.createElement("div");
    d.id = "ad-log";
    Object.assign(d.style, { position: "fixed", top: "70px", right: "34px", width: "760px", height: "690px", zIndex: 2147482990, background: "var(--panel)", border: "3px solid var(--ink)", borderRadius: "16px", boxShadow: "var(--sh-lg)", overflow: "hidden" });
    d.innerHTML = `<div style="font:800 17px var(--ui);padding:10px 18px;border-bottom:2px solid var(--ink);background:var(--marker-soft)">whiteboard.zip › decisions.md</div><pre style="margin:0;padding:12px 20px;font:16px/1.45 var(--ui);white-space:pre-wrap;color:var(--ink)"></pre>`;
    const esc = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    d.querySelector("pre").innerHTML = text.split("\n").map((l) => {
      const h = /^(#+)\s*(.*)$/.exec(l);
      if (h) return `<div style="font:800 ${h[1].length === 1 ? 22 : 17}px var(--display);margin:${h[1].length === 1 ? 0 : 8}px 0 2px">${esc(h[2])}</div>`;
      return `<div>${esc(l).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, '<code style="background:var(--accent-soft);border-radius:4px;padding:0 3px">$1</code>')}</div>`;
    }).join("");
    document.body.appendChild(d);
  }, lines);
  await caption("Inside: the decision log. The plan, the diagrams, every decision and why. The handoff, kept as it works.");
  await sleep(3700);
  await S(() => document.getElementById("ad-log")?.remove());
  beat("whiteboard.zip");

  // 9. The end card.
  await caption("");
  await label("");
  await moveTo(W - 30, H - 30);
  await card(big(`See what your agent is building, ${mark("and why")}.`, {
    kicker: "AGENT WHITEBOARD",
    sub: `<span style="font:800 34px var(--display);color:var(--ink)">${REPO_URL}</span><br><span style="font-size:22px">Open source · Claude, Codex, or any ACP agent</span>`,
  }));
  await sleep(4200);
  beat("end card");

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
  // The picture, then the music (scripts/ad-music.mjs: the beat comes in with the app) laid under it.
  const silent = path.join(OUT, "ad-silent.mp4"), music = path.join(OUT, "music.wav");
  execFileSync("ffmpeg", [...input, "-vf", "fps=30,scale=1440:-2,format=yuv420p", "-c:v", "libx264", "-crf", "21", "-preset", "slow", silent]);
  execFileSync("node", [path.join(__dirname, "ad-music.mjs"), music, String(Math.ceil(total) + 1), String(at["problem cards"] ?? 16)]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", silent, "-i", music, "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", path.join(OUT, "ad.mp4")]);
  fs.rmSync(silent);
  // The GIF is a short cut (the whole ad is ~10 MB as a GIF): from the plan to the red pen.
  const from = at["plan drawn"] ?? 0, to = at["red pen"] ?? from + 25;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(from), "-t", String(to - from), "-i", path.join(OUT, "ad.mp4"), "-vf", "fps=8,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", path.join(OUT, "ad.gif")]);
  // The README's GIF: the scripted demo alone, from the app's first frame to the end of the views.
  const d0 = at["problem cards"] ?? 0, d1 = at["views"] ?? d0 + 50;
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(d0 + 1), "-t", String(d1 - d0 - 1), "-i", path.join(OUT, "ad.mp4"), "-vf", "fps=8,scale=760:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", path.join(OUT, "demo.gif")]);
  const mb = (f) => (fs.statSync(path.join(OUT, f)).size / 1e6).toFixed(1);
  console.log(`${total.toFixed(1)} s: ad.mp4 ${mb("ad.mp4")} MB, ad.gif ${mb("ad.gif")} MB, demo.gif ${mb("demo.gif")} MB, in ${OUT}`);
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
