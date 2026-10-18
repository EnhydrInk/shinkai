import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startServer } from "../src/server.js";
import { TableClient } from "../scripts/client.js";
import { GameRoom, MAX_WAIT_MS } from "../src/room.js";
import type { PublicEvent } from "../src/engine.js";

test("independent HTTP clients share one game; credentials isolate hands and legal actions", async () => {
  const events: PublicEvent[] = [];
  const server = await startServer({ port: 0, rules: { seats: 2, turnTimeoutMs: 10_000 }, onPublicEvent: (e) => events.push(e) });
  const a = new TableClient("client-a"), b = new TableClient("client-b");
  try {
    await Promise.all([a.connect(server.url), b.connect(server.url)]);
    assert.deepEqual((await a.listTools()).tools.map((t) => t.name).sort(), ["act", "get_state", "join_game", "wait_for_my_turn"]);
    const key = crypto.randomUUID();
    const one = await a.call("join_game", { name: "a", joinKey: key });
    assert.equal(one.state!.status, "lobby");
    const duplicate = await b.call("join_game", { name: "a", joinKey: crypto.randomUUID() });
    assert.equal(duplicate.code, "NAME_TAKEN"); assert.equal(duplicate.state, undefined);
    const two = await b.call("join_game", { name: "b", joinKey: crypto.randomUUID() });
    assert.equal(two.state!.status, "playing"); assert.notEqual(one.token, two.token);
    const retry = await a.call("join_game", { name: "a", joinKey: key });
    assert.equal(retry.token, one.token); assert.equal(retry.state!.players.length, 2);
    const own = await a.call("get_state", { token: one.token, seatId: "s2" });
    assert.equal(own.state!.you.seatId, "s1");
    assert.deepEqual(own.state!.players.map((p) => Object.keys(p).sort()), [["handCount", "name", "seatId"], ["handCount", "name", "seatId"]]);
    const serialized = JSON.stringify(own);
    for (const c of two.state!.you.hand) assert.equal(serialized.includes(`"${c.id}"`), false);
    assert.equal(serialized.includes(two.token!), false);
    for (const token of ["s2", "wrong-token"]) {
      const failed = await a.call("get_state", { token });
      assert.equal(failed.code, "INVALID_TOKEN"); assert.equal(failed.state, undefined);
    }
    const foreign = await a.call("act", { token: one.token, turnId: 1, action: { type: "play", cardId: two.state!.you.hand[0]!.id } });
    assert.equal(foreign.code, "ILLEGAL_ACTION"); assert.equal(foreign.state!.you.seatId, "s1");
    assert.deepEqual(foreign.state!.legalActions, own.state!.legalActions);
    const notTurn = await b.call("act", { token: two.token, turnId: 1, action: { type: "draw" } });
    assert.equal(notTurn.code, "NOT_YOUR_TURN");
    const waiting = await b.call("wait_for_my_turn", { token: two.token, waitMs: 20 });
    assert.equal(waiting.status, "waiting"); assert.equal(waiting.state!.deadline, own.state!.deadline);
    const pending = b.call("wait_for_my_turn", { token: two.token, waitMs: 1000 });
    const attempts = await Promise.all([a.call("act", { token: one.token, turnId: 1, action: { type: "draw" } }),
      a.call("act", { token: one.token, turnId: 1, action: { type: "draw" } })]);
    assert.equal(attempts.filter((r) => r.ok).length, 1);
    assert.equal(attempts.find((r) => !r.ok)!.code, "STALE_TURN");
    const ready = await pending;
    assert.equal(ready.status, "your_turn"); assert.equal(ready.state!.turnId, 2);
    await a.close();
    const reconnect = new TableClient("reconnected");
    try { await reconnect.connect(server.url); assert.equal((await reconnect.call("get_state", { token: one.token })).state!.you.seatId, "s1"); }
    finally { await reconnect.close(); }
    const eventText = JSON.stringify(events);
    assert.equal(eventText.includes(one.token!), false); assert.equal(eventText.includes('"hand"'), false);
  } finally { await Promise.all([a.close(), b.close()]); await server.close(); }
});

test("HTTP rejects foreign origins/hosts, GET is optional and health reveals no state", async () => {
  const server = await startServer({ port: 0 });
  try {
    assert.equal((await fetch(server.url)).status, 405);
    assert.equal((await fetch(server.url, { headers: { Origin: "https://foreign.invalid" } })).status, 403);
    // fetch may replace Host: use raw HTTP so this actually exercises server validation.
    const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(server.url, { headers: { Host: "foreign.invalid" } }, (res) => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    assert.equal(hostStatus, 403);
    assert.deepEqual(await (await fetch(server.url.replace("/mcp", "/health"))).json(), { ok: true });
  } finally { await server.close(); }
});

test("long poll caps an oversized wait at exactly 25s", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const room = new GameRoom({ now: () => 0 });
  try {
    const { token } = room.join("a", crypto.randomUUID());
    const pending = room.wait(token, MAX_WAIT_MS * 2);
    t.mock.timers.tick(24_999);
    assert.equal(await Promise.race([pending.then(() => "resolved"), Promise.resolve("pending")]), "pending");
    t.mock.timers.tick(1);
    assert.equal((await pending).status, "waiting");
  } finally { room.close(); }
});

test("cancelled waits leave the room usable; close releases pending waiters", async () => {
  const room = new GameRoom();
  try {
    assert.equal(MAX_WAIT_MS, 25_000);
    const { token } = room.join("a", crypto.randomUUID());
    const controller = new AbortController();
    const pending = room.wait(token, MAX_WAIT_MS * 2, controller.signal);
    controller.abort();
    await assert.rejects(pending, { code: "CANCELLED" });
    assert.equal((await room.wait(token, 0)).status, "waiting");
    const closing = room.wait(token);
    room.close();
    await assert.rejects(closing, { code: "SERVER_CLOSED" });
  } finally { room.close(); }
});
