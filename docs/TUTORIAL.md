# Agent Whiteboard: a first tutorial

This guide takes you through one whole run, step by step. You don't need an API key: everything here works with the built-in demo, which never touches your files. It takes about 15 minutes.

**What you'll learn:** how a coding agent plans, builds and tests a change; how to steer it by editing a drawing of its plan; and how to check whether what it tells you is actually true.

**Words you'll see:**

- **Agent:** a program that uses an AI model to work on code by itself: it reads files, edits them and runs commands.
- **Run:** one task from start to finish: plan → build → verify (test) → ship.
- **Board:** the drawing on the left. It's the agent's plan as a picture, and you can edit it.
- **Part (component):** one piece of the system, like the web page, the server or the database.
- **Decision (◇):** a technical choice the agent made, like "use a background worker".

---

## 1. Set it up

You need [Node.js](https://nodejs.org) 20 or newer, and git. In a terminal:

```bash
git clone https://github.com/ghanemja/whiteboard.git
cd whiteboard
npm install          # downloads the libraries it uses
npm run sandbox      # makes a small practice repo in sandbox/linkshort
npm run dev          # starts the app
```

Open **http://localhost:5199** in your browser. Without an API key, a scripted demo starts by itself. That's all you need for this tutorial.

Optional: to see three real, recorded runs under "Saved boards" (section 9), also run:

```bash
cp fixtures/recordings/* recordings/
```

## 2. Take the tour

The first time you open the app, the demo starts and a short intro pops up over it: press **Show me around**. To take it again later, press **Tour** in the yellow tips card (or **Take the tour** on the start screen).

![The intro: a pop-up over the demo as it starts playing](../screenshots/tour/01-welcome.png)

The tour plays the demo as a lesson. The screen dims except for the part each step is about, and a yellow card pops out beside it to say what to look at; an orange ring or circle marks it. Everything still works under the dim, so try it yourself, or press **Next** and it does the step for you. **Back** shows the last step again; **Exit tour** leaves it (the demo keeps going as normal).

The rest of this guide covers the same run in more detail. Do the tour first, then read on, or follow along here instead.

## 3. The three areas

![The board on the left, the panel on the right, and the phase road along the top](../screenshots/first-time-help/2-plan-gate-tips-on-the-board.png)

1. **The board (left).** The plan as a drawing. Each picture is a part of the system; arrows show which part talks to which.
2. **The panel (right).** The agent talks here, and you answer. It has two tabs: **Chat & log** (what it said and did) and **Plan details** (the plan in words: open a section to read it; **Decisions** is last, with a bell when some need a look). The box at the bottom is for typing to it.
3. **The phase road (top).** Where the run is: **Plan → Build → Verify → Ship**, with a dot for each task.

### Legend

![Legend. Parts: color is their state (new, exists, being built, tested, failed, shipped). Decisions: dashed diamond proposed, solid approved, blue changed, a check mark or cross for its check. For you: a question note, an assumption note. Your marks: Why?, Not needed and Keep this stickers, and the red pen for something that isn't true.](../screenshots/tutorial/legend.svg)

## 4. A first run, end to end

### It plans

The agent reads the task and draws its plan. Parts appear one by one. The picture says what kind of part it is (a browser window is a web client, a server rack is a server, a cylinder is a database, a cloud is someone else's service), and the **color says its state**. The key under the board lists them all: grey = new (not built yet), orange = being built, green = tested, red = a test failed, purple = shipped.

![The plan being drawn, with the color key ringed under the board](../screenshots/tour/02-it-plans.png)

When the plan is ready, the agent **stops and waits for you**. The Plan milestone gets a blue ⏸, and a "The plan is ready" card appears at the bottom of the panel. Nothing gets built until you approve.

### Look at a decision

Diamonds (◇ D1, D2, …) are the agent's technical decisions. **Click one to see its other options:** they fan out beside the ◇, and the card lists them under **Instead of**, each with **Use this**. The card also says **why** it chose what it did, and the check that will prove it.

![D1 clicked: its other options fan out beside it on the board, and the card lists them, each with Use this](../screenshots/tutorial/decision-options.png)

**Use this** switches to that option (see section 5). Dashed diamonds are *proposed*: not approved yet.

### Approve

When you're happy with the plan, press **Approve plan & build** (or **Approve with changes** if you changed something; see section 5). The agent starts building.

![The Approve with changes button, ringed](../screenshots/tour/06-approve-with-changes.png)

### It builds

Now it edits files by itself. Parts turn **orange** while it changes them. In **Chat & log**, hover any sentence: the parts that sentence changed light up on the board. Under each part, small green and red blocks show how many lines it added and removed.

![A part being built, in orange; the tour card points at Chat & log](../screenshots/tour/07-build-hover-a-line.png)

### It tests (verify)

Each decision came with a check. When it runs the tests, each ◇ gets a ✓ (passed) or ✗ (failed). In the demo, D2 ("how PDFs are split") fails: the check wanted the right page for 45 of 50 questions, and it got 41. So the agent **changes D2** and tests again: 47 of 50, ✓.

Open the **Reasoning** tab to see the reasoning as a chain: **evidence → decision → what it shapes → proof**. D2's row shows the failed check as the reason it changed.

![The Reasoning tab: one row per decision, from evidence to proof](../screenshots/tour/09b-why-tab.png)

### It ships

The last phase deploys it. All parts turn purple (★ shipped), and a flag appears at the end of the road.

## 5. Steer it: change the plan

You don't have to type to change its mind. **Edit the board**, and your changes are sent to the agent. They work best at the plan gate, before anything is built, but you can send them later too.

### Pull the glass down

The board sits **behind glass**. You can click anything to learn what it is, but nothing moves by accident. To change the plan, press **Pull down to edit**, the first button in **Edit the plan** above the board: the glass slides away and the same button turns into **Glass back up**, which puts it back without sending. **Submit** sends your changes and puts the glass back too.

![The board behind glass, with Pull down to edit at the left of Edit the plan](../screenshots/glass/1-behind-glass.png)

Buttons that change the plan (**Use this**, **Rename**, **Remove** on a card, or any **Edit the plan** button) pull the glass down for you.

### Pick another option for a decision

Click a ◇, then press **Use this** next to one of the other options. Or drag one of the option pills that fan out beside the diamond onto it. To use your own idea, type it in the blank "+ your own" pill.

![The decision card with Use this ringed, and the tour card beside it](../screenshots/tour/04-use-this.png)

### Use the Edit the plan toolbar

**Edit the plan** above the board has buttons with words:

| Button | What it does |
| --- | --- |
| **Rename** | Change a part's name, for example to swap a technology ("Postgres" → "SQLite") |
| **Add a part** | Draw a box and name it: "I want this too" |
| **Connect** | Draw an arrow from one part to another |
| **Remove** | Remove the selected part or arrow, or reject the selected ◇ |
| **Add a note** | Write a note on the board, like "English PDFs only" |

### Stickers

The three stickers sit at the top of the board. Drag one onto a part or a ◇. It goes to the agent right away, and the answer pops up in a bubble beside the sticker:

- **Why?** asks it to explain (it changes nothing).
- **Not needed** asks it to drop that part or decision.
- **Keep this** tells it not to change that without asking you.

![Stickers on the plan, each with its answer beside it](../screenshots/stickers/1-stickers-on-the-plan-light.png)

### Send your changes

Your changes collect in a list at the bottom of the panel. At the plan gate:

- **Revise plan** redraws the plan with your changes and asks you again.
- **Approve with changes** folds them in and starts building.

Later on, press **Submit** (on the board or in the panel). Either way, the glass goes back up.

### Answer its questions

Sometimes the agent can't tell something from the code, so it asks you. Questions are orange sticky notes on the board (with a push pin), and **Plan details** shows "? 2 for you". Click the note, or open Plan details, and pick an answer or type your own. **Assumptions** (purple notes, ≈) are things it decided to believe; confirm one (✓) or correct it (✎).

![The question circled on the board, and the tour card beside it](../screenshots/tour/05-answer-its-question.png)

You can also just type in the box at the bottom ("Use SQLite instead"), or press **Ask why** on a decision.

## 6. See it other ways: Draw as and Zoom into

The bar above the board shows the same plan other ways. It never changes the plan.

![The bar above the board: Draw as and Zoom into](../screenshots/zoom/1-draw-as-and-zoom-into.png)

**Draw as** redraws the board in a standard notation:

| Draw as | What you see |
| --- | --- |
| **Pictures** | The pictograms (the default) |
| **C4** | The official C4 container diagram: each part's type and technology |
| **Data flow** | Processes, data stores and outside services, with the data on each arrow |
| **Database** | The tables each data store holds: columns, keys, and how they relate (an ER diagram) |
| **Sequence** | One request, step by step, as a sequence diagram (pick the flow under **Flows & export**) |

Each part sits on a colored plate: that's its **layer** (blue Frontend, violet Backend, teal Data, orange ML, grey External; the key under the board says which is which).

**Zoom into** opens one layer right there on the board, so you see what its parts are made of. Nothing moves: the other layers fade, and each of the layer's parts bursts into small pictures in the same color, joined by dashed lines: pages (a browser window), routes (a plug), steps (a gear), jobs (a clock), models (a sparkle), tables (a grid), stored files (a page), libraries (a parcel). The board zooms to fit. You can still edit it, and clicking a piece tells you about its part.

To see two views at once, press **+ Pin this view** (beside the board's tabs). The view opens in its own window over the board; pick another view for the board itself. Drag a window by its title, resize it from its corner, and close it with **−**.

- **Frontend**: pages and views, and the libraries they use.
- **Backend**: routes, jobs and steps, and their libraries.
- **Data**: tables, stored files, indexes.
- **ML**: the model pipeline, even inside backend parts (chunk → embed → index, retrieve → prompt → answer).

![Zoom into ML: the pipeline steps burst out of the API server, the worker and the vector index, next to Claude](../screenshots/zoom/2-ml-layer.png)

![Zoom into Data: the stored PDFs, the documents and chunks tables, and the index, around their stores](../screenshots/zoom/3-data-layer.png)

**Whole system** closes it again. **Look inside** on a part's card does the same as Zoom into. **Flows & export** copies any view as Mermaid or saves it as SVG or PNG.

## 7. The command prompt

An agent can run commands, and a command can do anything your terminal can: delete files, install things, send data. So it **asks before every command**.

![The command prompt: "Can it run this command? pytest -q", with Why am I asked? open, and Deny, Allow all, Allow once](../screenshots/tour/08-command-prompt.png)

- **Allow once:** run this one command.
- **Allow all:** run every command for the rest of this run, without asking.
- **Deny:** don't run it. The agent finds another way, or tells you why it needs it.

Read the command first. Running the tests (`npm test`, `pytest`) is usually fine. Be careful with anything that deletes (`rm`), installs, pushes or deploys. When in doubt, Deny. Editing files inside the repo doesn't ask, because you approved the plan.

(The demo only shows this prompt during the tour. With a real agent, it appears for every command.)

## 8. Check its work

Agents can be wrong about their own work, and they say so confidently. So the app checks what it said against what really happened: **git** (which files actually changed) and **the test output**.

### Receipts

Sentences that claim something checkable get a receipt in Chat & log:

- **✓ checked:** the record backs it up.
- **? can't tell:** nothing in the record says either way.
- **✗ not true:** the record contradicts it.

The **Chat & log** tab shows how many are not true ("✗ 1 not true").

### The Review card

When the run ends, a **Review** card at the end of Chat & log lists what to look at, worst first. In the demo, the agent says it "documented the setup in README.md", but no README.md changed. That's the ✗ **False claim** row. Click its link to jump to the sentence.

![The Review card with the False claim row ringed](../screenshots/tour/10-find-what-isnt-true.png)

### Red pen

The review is also marked on the board in red pen, the way a teacher marks homework: a ring round the part that owns a file a false claim names, a ✗ over a decision whose check failed, or a margin note under the board for a file no part owns (like the demo's README.md). Click a mark to open what it's about.

![Red pen on the board: a margin note for README.md](../screenshots/stickers/3-review-red-pen-light.png)

### The Timeline

The **Timeline** tab shows the whole run over time: your actions on top (pink), test runs (✓ ✗), then one lane per decision from proposed (dashed) to approved (solid) to proven (✓). Arrows show *why* something changed: from your click, or from a failed test. In the demo, find D2's ✗ and the change right after it.

![The Timeline of the demo run](../screenshots/tour/11-timeline-tab.png)

## 9. Saved runs and the decision log

Every run is recorded. The start screen lists them under **Saved boards**. With an API key, that's where you begin; with the demo, press **See saved runs** on the tour's last step. (To see the three sample runs, copy them first, see section 1.)

![The start screen: Take the tour, Watch the demo, and Saved boards with Replay, Open and Decisions](../screenshots/tutorial/saved-boards.png)


- **Replay** plays the run back as it happened. Pause, change the speed, or click any moment on the Timeline to jump there.
- **Open** shows the board as it ended.
- **Decisions** opens the **decision log**: a readable file with the final plan (goal, parts, connections, each decision with why, its check and its proof) and a timeline of who decided what, and when. It's saved next to the recording as `recordings/<id>.decisions.md`, so you can paste it into a pull request.

![A saved run reopened on its Timeline, with the Decision log button](../screenshots/tutorial/replay-timeline.png)

## 10. Your own task (needs an API key)

To run a real agent instead of the demo:

1. Copy the example settings: `cp .env.example .env.local`.
2. Put your key in it: `AGENT_KEY=sk-ant-…` (an [Anthropic API key](https://console.anthropic.com); the README's *Models* section has other options).
3. Restart `npm run dev`.

Now the start screen asks **What should the agent do?** The repository field starts at the practice repo (`sandbox/linkshort`, a tiny URL shortener with tests). Pick one of the example tasks, like "Let links expire after a given number of days", or describe your own. Everything from sections 4–9 works the same, except the commands are real now, so read each prompt. To reset the practice repo, run `npm run sandbox` again.

A run costs about $0.20–0.40.

To use OpenAI's Codex instead of Claude: install it (`npm i -g @openai/codex`), sign in (`codex login`), put `AGENT_ENGINE=codex` in `.env.local`, and restart. Everything works the same; the README's *Codex* section has the details.

## Tips

- The yellow **tips** card always says which step you're on and what to do. **Hide tips** puts it away; the **?** button brings it back.
- Click anything on the board to learn what it is. The legend (section 3) says what each color and mark means.
- **Highlights only** (in Chat & log) hides the narration and keeps what matters.
- **Draw as** and **Zoom into** (above the board) show the plan other ways; **Flows & export** shows one flow's steps and exports the view as Mermaid, SVG or PNG.
- The glass over the board keeps clicks safe: pull it down to change things.
- The ▶ / ⏸ button pauses the demo; **2×** changes its speed.

Questions or ideas? Open an issue on [GitHub](https://github.com/ghanemja/whiteboard/issues).
