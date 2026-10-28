// How to go from the demo to a real agent, in one place, so the intro and the start screen say
// the same thing (and name the same setting as the README and .env.example).
export function LiveSetup({ className = "live-setup" }) {
  return (
    <p className={className}>
      <b>Run it on your own code:</b> copy <code>.env.example</code> to <code>.env.local</code>, put your Anthropic API key in it as{" "}
      <code>AGENT_KEY=…</code> (or name another coding agent: <code>AGENT_ENGINE=gemini</code>, <code>opencode</code>, <code>cursor</code>…), then restart{" "}
      <code>npm run dev</code>. It starts on a sample repo; <b>Browse</b> picks your own.{" "}
      <a href="https://github.com/ghanemja/whiteboard#models" target="_blank" rel="noreferrer">
        Other models and agents
      </a>
    </p>
  );
}
