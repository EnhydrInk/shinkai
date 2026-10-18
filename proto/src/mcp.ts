import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { COLORS, GameError } from "./engine.js";
import { GameRoom, MAX_WAIT_MS } from "./room.js";

function reply(value: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError };
}

export function createMcpServer(room: GameRoom): McpServer {
  const server = new McpServer({ name: "tabletop", version: "0.1.0" }, {
    instructions: "共享牌桌。只入座一次，保管 token 和 joinKey。用 wait_for_my_turn 等待，轮到时从 legalActions 选择并用当前 turnId 调 act。status=finished 就停止。",
  });
  const tokenSchema = z.string().min(1).max(128).describe("join_game 返回的私密座位 token");
  const wrap = async (operation: () => unknown | Promise<unknown>, token?: string) => {
    try { return reply({ ok: true, ...await operation() as Record<string, unknown> }); }
    catch (error) {
      if (!(error instanceof GameError)) { console.error("工具内部错误"); return reply({ ok: false, code: "INTERNAL_ERROR", message: "服务器内部错误" }, true); }
      let state;
      if (token) { try { state = room.state(token); } catch { /* invalid credentials: no state */ } }
      return reply({ ok: false, code: error.code, message: error.message, ...(state ? { state } : {}) }, true);
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  server.registerTool("join_game", {
    description: "入座并取得私密 token。满配置人数自动开局。同一个私密 joinKey 重试可取回原 token；不要使用别人的 key。",
    inputSchema: { name: z.string().min(1).max(40), joinKey: z.string().min(16).max(128).describe("自己生成的私密随机串；重试时原样使用，避免重复入座") },
    annotations: { ...write, idempotentHint: true },
  }, ({ name, joinKey }) => wrap(() => room.join(name, joinKey)));
  server.registerTool("get_state", {
    description: "查询自己的手牌、公共局面和自己的合法出法；不返回其他玩家手牌。", inputSchema: { token: tokenSchema }, annotations: read,
  }, ({ token }) => wrap(() => ({ state: room.state(token) }), token));
  server.registerTool("wait_for_my_turn", {
    description: "长轮询等待自己的回合或结束；最多 25 秒。waiting 时再次调用，your_turn 时按 legalActions 出手，finished 时停止。等待不会重置回合超时。",
    inputSchema: { token: tokenSchema, waitMs: z.number().int().min(0).max(MAX_WAIT_MS).default(MAX_WAIT_MS) }, annotations: read,
  }, ({ token, waitMs }, extra) => wrap(() => room.wait(token, waitMs, extra.signal), token));
  server.registerTool("act", {
    description: "提交 legalActions 中的一项并结束回合。必须带当前 turnId；过期、越权或不合法出法返回原因和自己的最新局面。摸牌结束回合。",
    inputSchema: { token: tokenSchema, turnId: z.number().int().min(1), action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("draw") }).strict(),
      z.object({ type: z.literal("play"), cardId: z.string().min(1).max(64), color: z.enum(COLORS).optional() }).strict(),
    ]) }, annotations: { ...write, idempotentHint: true },
  }, ({ token, turnId, action }) => wrap(() => ({ state: room.act(token, turnId, action) }), token));
  return server;
}
