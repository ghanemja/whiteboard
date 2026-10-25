import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { runsMiddleware, stopAllRuns } from "./server/runs.js";

// Serves /api/runs from the dev (and preview) server: Claude Agent SDK sessions
// working in a local repo. The Anthropic key never reaches the browser.
const agentRuns = () => {
  const defaultRepo = process.env.AGENT_REPO || path.resolve("sandbox/linkshort");
  return {
    name: "agent-runs",
    configureServer(server) {
      server.middlewares.use("/api/runs", runsMiddleware({ defaultRepo }));
      server.httpServer?.once("close", stopAllRuns);
    },
    configurePreviewServer(server) {
      server.middlewares.use("/api/runs", runsMiddleware({ defaultRepo }));
      server.httpServer?.once("close", stopAllRuns);
    },
  };
};

export default defineConfig(({ mode }) => {
  // Pick up ANTHROPIC_* / AGENT_* from .env / .env.local for the server side only
  // (not VITE_-prefixed, so none of it is exposed to client code).
  for (const [k, v] of Object.entries(loadEnv(mode, process.cwd(), ["ANTHROPIC_", "AGENT_"]))) process.env[k] ??= v;

  return {
    plugins: [react(), agentRuns()],
    // Excalidraw's build reads this flag; Vite doesn't define process.env by default.
    define: { "process.env.IS_PREACT": JSON.stringify("false") },
    server: { port: 5199, watch: { ignored: ["**/sandbox/**"] } },
  };
});
