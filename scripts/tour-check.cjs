// End-to-end check of the guided tour in headless Chromium: takes it from a first visit (where it
// starts by itself) to the finish with real clicks, drags and hovers, and screenshots each step. Then checks the
// plain demo still plays straight through (no prompt, no pauses, no tour once it's been taken).
//
//   npm run dev     # in another terminal (http://localhost:5199)
//   NODE_PATH=$(npm root -g) node scripts/tour-check.cjs [out-dir] [light|dark]
//
// Playwright isn't a dependency: the cloud image has it installed globally (hence NODE_PATH).
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = process.env.WB_URL || "http://localhost:5199/";
const out = process.argv[2] || "tour-shots";
const theme = process.argv[3] || "light";
fs.mkdirSync(out, { recursive: true });

const fail = (msg) => {
  throw new Error(msg);
};

let page;
(async () => {
  const browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const shot = async (name) => {
    await page.mouse.move(1, 1); // no stray hover
    await page.waitForTimeout(350);
    await page.screenshot({ path: path.join(out, `${name}.png`) });
    console.log("shot", name);
  };
  const stepLabel = () => page.evaluate(() => document.querySelector(".coach.tour .coach-label")?.textContent ?? "");
  const title = () => page.evaluate(() => document.querySelector(".coach.tour .coach-title")?.textContent ?? "");
  const waitStep = async (n, timeout = 90000) => {
    await page.waitForFunction((n) => document.querySelector(".coach.tour .coach-label")?.textContent.includes(`step ${n} of`), n, { timeout });
    await page.waitForTimeout(300);
    console.log(await stepLabel(), "·", await title());
  };
  const S = (fn, arg) => page.evaluate(fn, arg);
  // Client coordinates of a board element's center (the Architecture canvas).
  const boardPoint = (id) =>
    S((id) => {
      const api = window.__wb.board.api;
      const e = api.getSceneElements().find((x) => x.id === id);
      const st = api.getAppState();
      return e && { x: (e.x + e.width / 2 + st.scrollX) * st.zoom.value + st.offsetLeft, y: (e.y + e.height / 2 + st.scrollY) * st.zoom.value + st.offsetTop };
    }, id);

  await page.goto(URL);
  await page.waitForFunction(() => window.__wb?.board?.api, null, { timeout: 30000 });
  if (theme === "dark") await S(() => window.__wb.board.api.updateScene({ appState: { theme: "dark" } }));
  // A first visit (no API key): the tour starts by itself, with no demo playing behind it.
  if (await page.$(".tour-offer")) fail("a first visit starts the tour, not an offer");

  // 1 Welcome: the three areas.
  await waitStep(1, 15000);
  if (await S(() => window.__wb.transcript.messages.length)) fail("the demo waits for the tour's second step");
  const rings = await page.$$eval(".tour-ring", (r) => r.length);
  if (rings !== 3) fail(`welcome should ring 3 areas, rings ${rings}`);
  await shot("01-welcome");
  await page.click(".coach.tour button.primary"); // Next

  // 2 It plans (the tour plays it at 2×; faster here).
  await waitStep(2);
  if ((await S(() => window.__wb.player.speed)) !== 2) fail("the plan step plays at 2×");
  await page.waitForFunction(() => Object.keys(window.__wb.board.model.nodes).length >= 3, null, { timeout: 60000 });
  await shot("02-it-plans");
  await S(() => (window.__wb.player.speed = 4));

  // 3 Click a decision.
  await waitStep(3, 120000);
  if (!(await S(() => window.__wb.board.tips?.length))) fail("a note should point at a ◇ on the board");
  await shot("03-click-a-decision");
  const d1 = await boardPoint("dec-d1");
  await page.mouse.click(d1.x, d1.y);

  // 4 Use this (or a sticker).
  await waitStep(4);
  await page.waitForSelector('[data-tour="use-this"]');
  await shot("04-use-this");
  await page.click('[data-tour="use-this"]');

  // 5 Answer its question: on the board, through its explain card.
  await waitStep(5);
  await shot("05-answer-its-question");
  const qEl = await S(() => window.__wb.board.model.questions.q1.elId);
  const q = await boardPoint(qEl);
  await page.mouse.click(q.x, q.y);
  await page.waitForSelector(".explain .q-opt");
  await page.click(".explain .q-opt >> nth=1"); // 200 MB

  // 6 Approve with changes.
  await waitStep(6);
  await page.waitForSelector('[data-tour="approve"]', { timeout: 60000 });
  await page.waitForFunction(() => document.querySelector(".coach.tour .tour-wait") === null, null, { timeout: 60000 });
  await shot("06-approve-with-changes");
  const label = await page.textContent('[data-tour="approve"]');
  if (!/with changes/.test(label)) fail(`expected Approve with changes, got ${label}`);
  await page.click('[data-tour="approve"]');

  // 7 Build: it pauses for you; hover a log line.
  await waitStep(7);
  await page.waitForFunction(() => window.__wb.held === "build", null, { timeout: 60000 });
  const typed = await S(() => window.__wb.transcript.messages.length);
  await page.waitForTimeout(1200);
  if ((await S(() => window.__wb.player.paused)) !== true) fail("the demo should wait at the build checkpoint");
  await shot("07-build-hover-a-line");
  await page.click('[data-tour="log-tab"]');
  await page.hover(".msg.agent .s.has-ops >> nth=-1");
  await page.waitForTimeout(300);
  await shot("07b-hovered-line-lights-the-board");

  // 8 The command prompt.
  await waitStep(8);
  await page.waitForSelector('[data-tour="permit"]', { timeout: 60000 });
  await page.click(".permit .whats summary");
  await shot("08-command-prompt");
  await page.click('.permit button.primary'); // Allow once

  // 9 A check failed: open the Reasoning tab.
  await waitStep(9);
  await page.waitForFunction(() => window.__wb.held === "verify", null, { timeout: 90000 });
  await shot("09-check-failed-open-why");
  await page.click('[data-tour="why-tab"]');
  await page.waitForTimeout(600);
  await shot("09b-why-tab");

  // 10 Find what isn't true.
  await waitStep(10);
  await page.waitForFunction(() => window.__wb.board.model.phase === "complete" && !window.__wb.player.busy, null, { timeout: 120000 });
  await page.waitForTimeout(600);
  // The review is at the end of Chat & log; if Plan details is open, the tour points at the tab first.
  if (!(await page.$('[data-tour="untrue"]'))) {
    const tabRing = await page.$$eval(".tour-tag", (t) => t.map((x) => x.textContent));
    if (!tabRing.includes("The review is in here")) fail(`no ring on Chat & log: ${tabRing}`);
    await page.click('[data-tour="log-tab"]');
  }
  await page.waitForSelector('[data-tour="untrue"]', { timeout: 10000 });
  await page.waitForTimeout(800);
  await shot("10-find-what-isnt-true");
  await page.click('[data-tour="untrue"] .rv-link');

  // 11 The Timeline.
  await waitStep(11);
  await shot("11-timeline-tab");
  await page.click('[data-tour="timeline-tab"]');

  // 12 Other ways to see it: back to Architecture, open the ML layer, then Next.
  await waitStep(12);
  await shot("12-see-it-other-ways");
  await page.click('[data-tour="arch-tab"]');
  await page.waitForSelector('[data-tour="lens"]');
  await page.click('[data-tour="lens"] .lens:text-is("ML")');
  await page.waitForTimeout(900);
  if (!(await S(() => document.querySelector('.canvas.on[aria-label^="Inside the ML layer"]')))) fail("Zoom into ML should show the ML layer");
  await shot("12b-zoom-into-ml");
  await page.click(".coach.tour button:has-text('Next')");

  // 13 Finish.
  await waitStep(13);
  await page.waitForTimeout(600);
  await shot("13-finish");
  await page.click(".coach.tour .tour-finish button.primary");
  await page.waitForTimeout(400);
  if (await page.$(".coach.tour")) fail("Finish should close the tour");
  const stored = await S(() => localStorage.getItem("wb-tour"));
  if (!stored) fail("the tour should be remembered as taken");
  console.log("tour ok; messages before the build pause:", typed);

  // Back, Skip step and Exit: from the ? / coach entry point, on a fresh board.
  await page.click(".coach .coach-links button:has-text('Tour')");
  await waitStep(1);
  await page.click(".coach.tour button.primary"); // Next → the plan step starts the demo
  await waitStep(2);
  await S(() => (window.__wb.player.speed = 4));
  await waitStep(3, 120000);
  await page.click(".coach.tour .tour-actions button:has-text('Skip step')");
  await waitStep(4);
  await page.click(".coach.tour .tour-actions button:has-text('Back')");
  await waitStep(3);
  if (!(await page.$(".coach.tour button:has-text('Next')"))) fail("a step you came back to waits for Next");
  await page.click(".coach.tour button:has-text('Next')");
  await waitStep(4);
  await page.click(".coach.tour .tour-actions button:has-text('Skip step')"); // picks an option for you
  await waitStep(5);
  await page.waitForFunction(() => document.querySelectorAll(".gate .edits li li").length >= 1, null, { timeout: 5000 });
  await page.click(".coach.tour .coach-hide:has-text('Exit tour')");
  if (await page.$(".coach.tour")) fail("Exit should close the tour");
  await page.click('.gate button.primary');
  await page.waitForFunction(() => window.__wb.board.model.phase === "complete" && !window.__wb.player.busy, null, { timeout: 180000 });
  if (await S(() => window.__wb.transcript.messages.some((m) => m.kind === "permission"))) fail("no command prompt outside the tour");
  console.log("back/skip/exit ok; the demo finished as usual after Exit");

  // The plain demo, for someone who's taken the tour: no tour, no prompt, no pause.
  await page.reload();
  await page.waitForFunction(() => window.__wb?.mode === "demo" && window.__wb.transcript.messages.length > 0, null, { timeout: 30000 });
  if (await page.$(".tour-offer") || (await page.$(".coach.tour"))) fail("the tour starts by itself only on a first visit");
  await S(() => (window.__wb.player.speed = 4));
  await page.waitForFunction(() => window.__wb.awaitingApproval, null, { timeout: 120000 });
  await page.click('.gate button.primary');
  await page.waitForFunction(() => window.__wb.board.model.phase === "complete" && !window.__wb.player.busy, null, { timeout: 180000 });
  if (await S(() => window.__wb.held || window.__wb.permission)) fail("plain demo paused");
  console.log("plain demo ok");

  if (errors.length) fail(`page errors: ${errors.join(" | ")}`);
  await browser.close();
  console.log("ALL OK");
})().catch(async (e) => {
  console.error("FAILED:", e.message);
  await page?.screenshot({ path: path.join(out, "failed.png") }).catch(() => {});
  console.error(await page?.evaluate(() => JSON.stringify({ stage: window.__wb.stage, phase: window.__wb.board.model.phase, held: window.__wb.held, busy: window.__wb.player.busy, paused: window.__wb.player.paused, card: document.querySelector(".coach")?.innerText })).catch(() => ""));
  process.exit(1);
});
