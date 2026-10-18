import { createServer } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.js";
import { GameRoom, type RoomOptions } from "./room.js";

export async function startServer(options: RoomOptions & { port?: number } = {}) {
  // One shared room for every request/client; MCP transport lifetime is independent of the game.
  const room = new GameRoom(options);
  const transports = new Set<ReturnType<typeof createMcpServer>>();
  const server = createServer(async (req, res) => {
    const port = (server.address() as { port: number }).port;
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!allowedHosts.has(req.headers.host ?? "") || (req.headers.origin &&
      ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin))) {
      res.writeHead(403).end("Forbidden host/origin"); return;
    }
    if (req.url === "/health" && req.method === "GET") { res.writeHead(200, { "Content-Type": "application/json" }).end('{"ok":true}'); return; }
    if (req.url !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    const mcp = createMcpServer(room);
    transports.add(mcp);
    const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize: 16_384 });
    res.once("close", () => { transports.delete(mcp); void mcp.close().catch(() => {}); });
    try { await mcp.connect(transport); await transport.handleRequest(req, res); }
    catch {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }));
      else res.end();
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 3333, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
    });
  } catch (error) { room.close(); throw error; }
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      room.close();
      await Promise.all([...transports].map((mcp) => mcp.close()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}
