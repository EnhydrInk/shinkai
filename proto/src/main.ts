import { readFile } from "node:fs/promises";
import { z } from "zod";
import { EFFECTS } from "./engine.js";
import { startServer } from "./server.js";

const configSchema = z.object({
  seats: z.number().int().optional(), initialHand: z.number().int().optional(), maxRounds: z.number().int().optional(),
  turnTimeoutMs: z.number().int().optional(), enabledEffects: z.array(z.enum(EFFECTS)).optional(),
  stopOnEmptyHand: z.boolean().optional(), allowVoluntaryDraw: z.boolean().optional(), reverseSkipsInTwoPlayer: z.boolean().optional(),
}).strict();

async function main() {
  const parsed = configSchema.parse(JSON.parse(await readFile(process.env.GAME_CONFIG ?? "config/default.json", "utf8")));
  const rules = Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
  const port = Number(process.env.PORT ?? 3333);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT 必须在 1–65535");
  const server = await startServer({ port, rules, onPublicEvent: (event) => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ type: "listening", url: server.url, config: process.env.GAME_CONFIG ?? "config/default.json" }));
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await server.close(); };
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "启动失败"); process.exitCode = 1; });
