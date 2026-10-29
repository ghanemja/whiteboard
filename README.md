# Agent Whiteboard

A coding agent works in your repo and **draws** what it's doing on a whiteboard: its plan, the parts of the system, the decisions it makes and why, and its progress as it builds and tests. You read it at a glance, and you steer it by editing the board.

![The scripted demo: an agent draws its plan for DocQA (a chat-with-your-PDFs app) as parts, connections and numbered decisions; you read D3's reasons, pick another option, drop a Why? sticker and approve; it builds (each part orange, then green) and proves its decisions from the test output; the red pen marks a claim that isn't true; then the same plan as C4, Database and UML](screenshots/ad/demo.gif)

**Why:** agents explain themselves in walls of text, so we stop following what they do, and every new session has to be briefed again from a HANDOFF.md. A board you can glance at teaches you the system as the agent builds it, and it stays in the repo as the project's living record.

## What it does

- **Plans in pictures.** Parts, connections and numbered decisions (◇): what it chose, over what, why, and the evidence. Nothing is built until you approve.
- **Steer from the board.** Pick another option with **Use this**, drop a **Why?**, **Not needed** or **Keep this** sticker on a part or decision, rename or remove parts, then approve.
- **Proof, not promises.** Each decision names a check, ticked ✓ or ✗ from the real test output. Claims are checked against git and the test runner, and a false one gets the red pen.
- **Questions too.** Ask how something works and it answers on the board, with nothing to approve.
- **Many views.** Pictures, C4, Data flow, Database, Sequence and UML, Zoom into a layer, and the Reasoning and Timeline tabs. Exports go to Mermaid, or Clean SVG/PNG for slides.
- **A living document.** Every run is recorded and can be replayed. The board is saved in the repo as `whiteboard.zip`, with a readable decision log. The next person or agent starts from it, and a repo without one gets mapped first.
- **Any agent.** Claude (the default), Codex, or any agent that speaks ACP: Gemini CLI, OpenCode, Cursor, Copilot, goose and more.

## Quick start

Needs Node 20+ and git.

```bash
git clone https://github.com/ghanemja/whiteboard.git
cd whiteboard
npm install
npm run dev      # http://localhost:5199
```

With no key set, a scripted demo plays: press **Take the tour** for a guided walk through it. To run a real agent, put your Anthropic API key in `.env.local` as `AGENT_KEY=…` (see `.env.example`) and restart. Then pick a repo (the sample one is ready), and describe a task or ask a question.

| To use | Set in `.env.local` |
| --- | --- |
| Claude through Anthropic's API | `AGENT_KEY` |
| Another model (Ollama, LiteLLM, OpenRouter…) | `AGENT_URL`, `AGENT_KEY`, `AGENT_MODEL` |
| Codex | `AGENT_ENGINE=codex` |
| An ACP agent | `AGENT_ENGINE=gemini` (or `opencode`, `cursor`, `copilot`…), or `AGENT_COMMAND` |

The agent asks before every shell command and never pushes or deploys. A repo's own settings and hooks run when the agent starts in it, so only use repos you trust.

## Learn more

- [Tutorial](docs/TUTORIAL.md): a first run, step by step, no key needed.
- [Reference](docs/REFERENCE.md): every feature, setting, model and agent, and how the code fits together.
- [Token study](docs/TOKEN_STUDY.md): what the board costs, and shorthand mode.
- [HANDOFF.md](HANDOFF.md): for contributors and agents working on the code.

## License

MIT, see [LICENSE](LICENSE).
