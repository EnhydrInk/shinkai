import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { GameView } from "../src/engine.js";

export type ToolReply = { ok: boolean; token?: string; state?: GameView; status?: "your_turn" | "waiting" | "finished"; code?: string; message?: string };
export class TableClient {
  private client: Client;
  constructor(name: string) { this.client = new Client({ name, version: "0.1.0" }); }
  async connect(url: string) { await this.client.connect(new StreamableHTTPClientTransport(new URL(url))); }
  async call(name: string, args: Record<string, unknown>): Promise<ToolReply> {
    const raw = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 35_000 });
    assert.ok(Array.isArray(raw.content));
    const text = raw.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text" && typeof text.text === "string");
    const result: ToolReply = JSON.parse(text.text);
    assert.equal(typeof result.ok, "boolean");
    assert.deepEqual(raw.structuredContent, result);
    assert.equal(Boolean(raw.isError), !result.ok);
    return result;
  }
  async listTools() { return this.client.listTools(); }
  async close() { await this.client.close(); }
}

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x100000000; };
}
