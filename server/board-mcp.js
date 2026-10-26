// The whiteboard's update_board tool as an MCP server over HTTP (Streamable HTTP, stateless), for
// agents that can't take an in-process tool the way Claude's SDK does: Codex, opencode, any MCP
// client. Each run serves its own board at /api/runs/<id>/mcp, behind that run's bearer token
// (a client sends `Authorization: Bearer <token>`; Codex: `bearer_token_env_var` in its MCP config).
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { boardReply, UPDATE_BOARD } from "./board-tool.js";

const same = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

// One MCP request against one run's board. `draw(ops)` applies the ops (Run.emitOps) and returns
// its notes for the agent. Stateless: a fresh server and transport per request, so nothing lingers.
export async function serveBoardMcp(req, res, { token, draw }) {
  const auth = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!token || !auth || !same(auth, token)) {
    res.statusCode = 401;
    res.setHeader("www-authenticate", 'Bearer realm="whiteboard"');
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ error: "This run's board token is required." }));
  }
  const server = new McpServer({ name: "board", version: "1.0.0" });
  server.registerTool(UPDATE_BOARD.name, { description: UPDATE_BOARD.description, inputSchema: UPDATE_BOARD.input }, async ({ ops }) => boardReply(ops, draw(ops)));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
