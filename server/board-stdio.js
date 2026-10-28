// A run's board as an MCP server on stdio, for an ACP agent that takes MCP servers only as commands
// (acp-run.js starts this for it). Each JSON-RPC message on stdin goes to the board's HTTP endpoint
// (board-mcp.js), one at a time and in order, and its answer comes back on stdout.
//
//   WHITEBOARD_BOARD_TOKEN=<the run's token> node server/board-stdio.js <the run's /mcp URL>
import { createInterface } from "node:readline";

const [url] = process.argv.slice(2);
const token = process.env.WHITEBOARD_BOARD_TOKEN ?? "";
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: line,
    });
    const text = await res.text();
    if (!res.ok && msg.id != null) return out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `The board answered ${res.status}: ${text.slice(0, 200)}` } });
    if (!text.trim()) return; // a notification's 202
    const body = JSON.parse(text);
    for (const m of Array.isArray(body) ? body : [body]) out(m);
  } catch (err) {
    if (msg.id != null) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Couldn't reach the board: ${err.message}` } });
  }
}

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (line.trim()) queue = queue.then(() => forward(line));
});
