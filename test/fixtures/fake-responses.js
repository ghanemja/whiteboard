// A scripted stand-in for OpenAI's Responses API, for running Codex without a model: each request
// gets the next step of the script. A step is a list of output items: { text } for a message
// (streamed as deltas), or a function_call item as the API returns it.
import http from "node:http";

export function fakeResponses(script) {
  const requests = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (!req.url.endsWith("/responses")) {
        res.writeHead(404);
        return res.end();
      }
      const j = JSON.parse(body || "{}");
      requests.push(j);
      const step = script[Math.min(n++, script.length - 1)];
      res.writeHead(200, { "content-type": "text/event-stream" });
      const ev = (e) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      ev({ type: "response.created", response: { id: `resp_${n}` } });
      step.forEach((item, i) => {
        const id = `item_${n}_${i}`;
        if (item.text) for (const piece of item.text.match(/.{1,16}/gs)) ev({ type: "response.output_text.delta", item_id: id, output_index: i, content_index: 0, delta: piece });
        ev({ type: "response.output_item.done", output_index: i, item: item.text ? { type: "message", role: "assistant", id, content: [{ type: "output_text", text: item.text }] } : item });
      });
      ev({ type: "response.completed", response: { id: `resp_${n}`, usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 120 } } });
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/v1`, requests })));
}

// Codex settings that send it to the fake instead of OpenAI.
export const fakeProvider = (url) =>
  [`model_provider="fake"`, `model_providers.fake.name="fake"`, `model_providers.fake.base_url="${url}"`, `model_providers.fake.wire_api="responses"`, `model="fake-model"`].flatMap((c) => ["-c", c]);

// A function call to the board, the way a model makes one.
export const draw = (callId, ops) => ({ type: "function_call", call_id: callId, namespace: "mcp__board", name: "update_board", arguments: JSON.stringify({ ops }) });
// A shell command; escalated, so Codex asks the user first.
export const shell = (callId, cmd, justification) => ({
  type: "function_call", call_id: callId, name: "exec_command",
  arguments: JSON.stringify({ cmd, ...(justification ? { sandbox_permissions: "require_escalated", justification } : {}) }),
});
