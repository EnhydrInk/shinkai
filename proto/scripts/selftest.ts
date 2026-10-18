import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { GameEngine, type GameView, type Metrics, type PublicEvent, type Rules } from "../src/engine.js";
import { startServer } from "../src/server.js";
import { TableClient, seededRandom } from "./client.js";

type Scenario = { name: string; seed: number; rules: Partial<Rules>; silentSeats: string[] };
const scenarios: Scenario[] = [
  { name: "four_random_bots", seed: 1018, rules: {}, silentSeats: [] },
  { name: "full_ten_rounds", seed: 77, rules: { stopOnEmptyHand: false }, silentSeats: [] },
  { name: "one_silent_seat", seed: 28, rules: { stopOnEmptyHand: false, turnTimeoutMs: 120 }, silentSeats: ["s1"] },
  { name: "all_silent_no_polling", seed: 9, rules: { maxRounds: 2, turnTimeoutMs: 30 }, silentSeats: ["s1", "s2", "s3", "s4"] },
];

function assertPrivate(state: GameView, seatId: string) {
  assert.equal(state.you.seatId, seatId);
  for (const player of state.players) assert.deepEqual(Object.keys(player).sort(), ["handCount", "name", "seatId"]);
  if (state.currentSeatId !== seatId) assert.deepEqual(state.legalActions, []);
}

function verifyMetrics(metrics: Metrics, steps: Extract<PublicEvent, { type: "step_completed" }>[]) {
  assert.deepEqual(metrics.steps, steps.map((e) => e.step));
  assert.equal(metrics.totalSteps, steps.length);
  for (const s of metrics.steps) assert.equal(s.elapsedMs, s.actedAt - s.startedAt);
  const total = metrics.steps.reduce((sum, s) => sum + s.elapsedMs, 0);
  assert.equal(metrics.averageMs, total / metrics.totalSteps);
  assert.equal(metrics.slowestStep!.elapsedMs, Math.max(...metrics.steps.map((s) => s.elapsedMs)));
  assert.equal(metrics.slowestRound!.elapsedMs, Math.max(...metrics.rounds.map((r) => r.elapsedMs)));
  assert.equal(metrics.rounds.reduce((sum, r) => sum + r.elapsedMs, 0), total);
}

async function run(scenario: Scenario) {
  const events: PublicEvent[] = [];
  let finish!: (event: Extract<PublicEvent, { type: "game_finished" }>) => void;
  const finished = new Promise<Extract<PublicEvent, { type: "game_finished" }>>((resolve) => { finish = resolve; });
  const engine = new GameEngine({ turnTimeoutMs: 1000, ...scenario.rules }, { random: seededRandom(scenario.seed) });
  const server = await startServer({ port: 0, engine, onPublicEvent: (event) => { events.push(event); if (event.type === "game_finished") finish(event); } });
  const clients = Array.from({ length: 4 }, (_, i) => new TableClient(`random-${i + 1}`));
  const start = performance.now();
  const counts = { waitCalls: 0, acts: 0 };
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.all(clients.map((c) => c.connect(server.url)));
    const seats: { token: string; seatId: string }[] = [];
    for (let i = 0; i < clients.length; i++) {
      const result = await clients[i]!.call("join_game", { name: `bot-${i + 1}`, joinKey: crypto.randomUUID() });
      assert.ok(result.ok && result.token && result.state);
      seats.push({ token: result.token, seatId: result.state.you.seatId });
    }
    const play = async (index: number) => {
      const { token, seatId } = seats[index]!;
      if (scenario.silentSeats.includes(seatId)) return;
      const random = seededRandom(scenario.seed + index + 1);
      for (let guard = 0; guard < 200; guard++) {
        counts.waitCalls++;
        const reply = await clients[index]!.call("wait_for_my_turn", { token, waitMs: 25_000 });
        assert.ok(reply.ok && reply.state); assertPrivate(reply.state, seatId);
        if (reply.status === "finished") return;
        if (reply.status === "waiting") continue;
        assert.equal(reply.status, "your_turn"); assert.ok(reply.state.legalActions.length);
        const action = reply.state.legalActions[Math.floor(random() * reply.state.legalActions.length)]!;
        await sleep(1 + Math.floor(random() * 5));
        const result = await clients[index]!.call("act", { token, turnId: reply.state.turnId, action });
        assert.ok(result.ok && result.state, JSON.stringify(result)); assertPrivate(result.state, seatId);
        counts.acts++;
        if (result.state.status === "finished") return;
      }
      throw new Error("bot 循环超过上限");
    };
    const timeout = new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error(`${scenario.name}: 15s 内未结束`)), 15_000); });
    const [event] = await Promise.race([Promise.all([finished, Promise.all(clients.map((_, i) => play(i)))]), timeout]);
    // For all-silent scenario this event must arrive BEFORE any state-query polling.
    const views = await Promise.all(clients.map((c, i) => c.call("get_state", { token: seats[i]!.token })));
    for (let i = 0; i < views.length; i++) {
      assert.equal(views[i]!.state!.status, "finished"); assertPrivate(views[i]!.state!, seats[i]!.seatId);
      assert.deepEqual(views[i]!.state!.result, views[0]!.state!.result);
    }
    const result = views[0]!.state!.result!;
    const metrics = event.metrics;
    verifyMetrics(metrics, events.filter((e) => e.type === "step_completed"));
    assert.ok(metrics.totalSteps <= engine.rules.seats * engine.rules.maxRounds);
    if (scenario.rules.stopOnEmptyHand === false) assert.equal(metrics.totalSteps, 40);
    if (scenario.silentSeats.length) {
      assert.ok(metrics.timeoutSteps > 0);
      for (const step of metrics.steps) {
        assert.equal(step.action === "timeout", scenario.silentSeats.includes(step.seatId));
        if (step.action === "timeout") assert.ok(step.elapsedMs >= engine.rules.turnTimeoutMs);
      }
    } else assert.equal(metrics.timeoutSteps, 0);
    if (scenario.silentSeats.length === 4) { assert.equal(metrics.timeoutSteps, 8); assert.equal(counts.waitCalls, 0); }
    const publicLog = JSON.stringify(events);
    for (const { token } of seats) assert.equal(publicLog.includes(token), false);
    assert.equal(publicLog.includes('"hand"'), false);
    return { scenario: scenario.name, seed: scenario.seed, rules: engine.rules, result: result.reason, winners: event.winners,
      wallMs: Math.round(performance.now() - start), ...counts, totalSteps: metrics.totalSteps, timeoutSteps: metrics.timeoutSteps,
      averageMs: Number(metrics.averageMs.toFixed(2)), slowestStep: metrics.slowestStep, slowestRound: metrics.slowestRound };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    await Promise.allSettled(clients.map((c) => c.close()));
    await server.close();
  }
}

const results = [];
for (const scenario of scenarios) { const result = await run(scenario); results.push(result); console.log(JSON.stringify(result)); }
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/selftest.json", JSON.stringify({ scenariosPassed: results.length, modelApiCalls: 0, results }, null, 2) + "\n");
console.log(`自测通过：${results.length}/${scenarios.length}；模型 API 调用 0；报告 artifacts/selftest.json`);
