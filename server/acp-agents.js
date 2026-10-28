// Coding agents that speak the Agent Client Protocol (ACP, agentclientprotocol.com), by the name
// AGENT_ENGINE takes: how to start each one in ACP mode (from the ACP registry), and how to install
// it. Any other ACP agent runs from AGENT_COMMAND, the command that starts it in ACP mode.
export const ACP_AGENTS = {
  gemini: { name: "Gemini CLI", command: "gemini --acp", install: "npm i -g @google/gemini-cli" },
  opencode: { name: "OpenCode", command: "opencode acp", install: "npm i -g opencode-ai" },
  goose: { name: "goose", command: "goose acp", install: "see https://block.github.io/goose/docs/getting-started/installation" },
  cursor: { name: "Cursor", command: "cursor-agent acp", install: "curl https://cursor.com/install -fsS | bash" },
  copilot: { name: "GitHub Copilot", command: "copilot --acp", install: "npm i -g @github/copilot" },
  cline: { name: "Cline", command: "cline --acp", install: "npm i -g cline" },
  qwen: { name: "Qwen Code", command: "qwen --acp", install: "npm i -g @qwen-code/qwen-code" },
  kimi: { name: "Kimi CLI", command: "kimi acp", install: "uv tool install kimi-cli" },
  auggie: { name: "Auggie", command: "auggie --acp", install: "npm i -g @augmentcode/auggie" },
  kilo: { name: "Kilo", command: "kilo acp", install: "npm i -g @kilocode/cli" },
  droid: { name: "Factory Droid", command: "droid exec --output-format acp-daemon", install: "npm i -g droid" },
  vibe: { name: "Mistral Vibe", command: "vibe-acp", install: "uv tool install mistral-vibe" },
  pi: { name: "pi", command: "pi-acp", install: "npm i -g pi-acp, and pi itself" },
  "claude-acp": { name: "Claude Agent", command: "claude-agent-acp", install: "npm i -g @agentclientprotocol/claude-agent-acp" },
};

// A command line as its words: spaces split them, quotes keep them together.
export const words = (line) => [...String(line ?? "").matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

// The ACP agent a run starts: { name, command (its words), install }. AGENT_COMMAND starts any ACP
// agent (named by AGENT_ENGINE if that's a name of its own, else by its program); without it,
// AGENT_ENGINE picks one of the agents above. Null for "acp" with no command.
export function acpAgent(env = process.env) {
  const id = String(env.AGENT_ENGINE ?? "").trim().toLowerCase();
  const known = ACP_AGENTS[id];
  const own = words(env.AGENT_COMMAND);
  if (own.length) return { name: known?.name ?? (id && id !== "acp" ? env.AGENT_ENGINE.trim() : own[0].split(/[\\/]/).pop()), command: own, install: null };
  return known ? { name: known.name, command: words(known.command), install: known.install } : null;
}
