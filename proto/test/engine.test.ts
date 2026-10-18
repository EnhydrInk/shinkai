import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_RULES, GameEngine, GameError, makeDeck, parseRules, type Card, type Rules } from "../src/engine.js";

let nextId = 0;
const card = (color: Card["color"], value: Card["value"]): Card => ({ id: `test-${nextId++}`, color, value });
function setup(hands: Card[][], top = card("red", "5"), overrides: Partial<Rules> = {}, rest?: Card[]) {
  const deck: Card[] = [];
  for (let i = 0; i < hands[0]!.length; i++) for (const hand of hands) deck.push(hand[i]!);
  deck.push(top, ...(rest ?? makeDeck(DEFAULT_RULES.enabledEffects)));
  const game = new GameEngine({ seats: hands.length, initialHand: hands[0]!.length, ...overrides }, { deck, random: () => 0.5 });
  const seats = hands.map((_, i) => game.join(`p${i}`, 1000));
  game.start(1000);
  return { game, seats, view: (i = 0) => game.view(seats[i]!) };
}
const filler = () => card("purple", "9");
function play(game: GameEngine, seat: string, c: Card, now = 1010, color?: "red" | "yellow" | "green" | "purple") {
  game.act(seat, game.view(seat).turnId, { type: "play", cardId: c.id, ...(color ? { color } : {}) }, now);
}
function errorCode(fn: () => unknown, code: string) { assert.throws(fn, (e: unknown) => e instanceof GameError && e.code === code); }

test("defaults, unique 104-card deck, configurable effects", () => {
  assert.equal(DEFAULT_RULES.initialHand, 7); assert.equal(DEFAULT_RULES.maxRounds, 10); assert.equal(DEFAULT_RULES.turnTimeoutMs, 60_000);
  const deck = makeDeck(DEFAULT_RULES.enabledEffects);
  assert.equal(deck.length, 104); assert.equal(new Set(deck.map((c) => c.id)).size, 104);
  assert.equal(makeDeck([]).length, 76);
  for (const value of ["skip", "reverse", "draw2"]) assert.equal(deck.filter((c) => c.value === value).length, 8);
  assert.equal(deck.filter((c) => c.value === "wild").length, 4);
});
test("config rejects bad seats, hand size, timeout, rounds and effects", () => {
  for (const rules of [{ seats: 1 }, { seats: 5 }, { initialHand: 0 }, { maxRounds: 1.2 }, { turnTimeoutMs: 0 }, { enabledEffects: ["wild", "wild"] }] as Partial<Rules>[]) {
    errorCode(() => parseRules(rules), "BAD_CONFIG");
  }
});
test("2, 3 and 4 seats start only when full; correct dealing and numeric top", () => {
  for (const seats of [2, 3, 4]) {
    const game = new GameEngine({ seats });
    for (let i = 0; i < seats; i++) {
      const seat = game.join(`p${i}`, 1000);
      assert.equal(game.view(seat).status, "lobby");
    }
    game.start(1000);
    const view = game.view("s1");
    assert.equal(view.you.hand.length, 7); assert.equal(view.players.length, seats);
    assert.match(view.topCard!.value, /^\d$/); assert.equal(view.currentSeatId, "s1");
    errorCode(() => game.join("extra", 1000), "GAME_STARTED");
  }
});
test("duplicate names and empty names are rejected before taking a seat", () => {
  const game = new GameEngine(); game.join("p", 0);
  errorCode(() => game.join(" p ", 0), "NAME_TAKEN"); errorCode(() => game.join(" ", 0), "BAD_NAME");
  assert.equal(game.view("s1").players.length, 1);
});
test("matching color or face is legal; others are not", () => {
  const sameColor = card("red", "2"), sameNumber = card("purple", "5"), bad = card("purple", "2");
  const { view } = setup([[sameColor, sameNumber, bad], [filler(), filler(), filler()]]);
  assert.deepEqual(view().legalActions, [{ type: "play", cardId: sameColor.id }, { type: "play", cardId: sameNumber.id }, { type: "draw" }]);
  assert.deepEqual(view(1).legalActions, []);
});
test("action faces also match across colors", () => {
  const r = card("red", "skip"), b = card("purple", "skip");
  const { game, seats } = setup([[r, filler()], [filler(), filler()], [b, filler()]]);
  play(game, seats[0]!, r);
  assert.ok(game.view(seats[2]!).legalActions.some((a) => a.type === "play" && a.cardId === b.id));
});
test("wild requires one of four colors; next match uses chosen color", () => {
  const wild = card("wild", "wild"), green = card("green", "1");
  const { game, seats, view } = setup([[wild, filler()], [green, filler()]]);
  assert.equal(view().legalActions.filter((a) => a.type === "play").length, 4);
  errorCode(() => play(game, seats[0]!, wild), "ILLEGAL_ACTION");
  play(game, seats[0]!, wild, 1010, "green");
  assert.equal(view().activeColor, "green"); assert.equal(view().topCard!.value, "wild");
  assert.ok(view(1).legalActions.some((a) => a.type === "play" && a.cardId === green.id));
});
test("skip advances two seats", () => {
  const c = card("red", "skip"); const { game, seats, view } = setup([[c, filler()], [filler(), filler()], [filler(), filler()], [filler(), filler()]]);
  play(game, seats[0]!, c); assert.equal(view().currentSeatId, seats[2]); assert.equal(view().completedSteps, 1);
});
test("reverse changes direction with four players", () => {
  const c = card("red", "reverse"); const { game, seats, view } = setup([[c, filler()], [filler(), filler()], [filler(), filler()], [filler(), filler()]]);
  play(game, seats[0]!, c); assert.equal(view().direction, -1); assert.equal(view().currentSeatId, seats[3]);
});
test("two-player reverse skips by default; can be configured", () => {
  for (const skips of [true, false]) {
    const c = card("red", "reverse"); const { game, seats, view } = setup([[c, filler()], [filler(), filler()]], undefined, { reverseSkipsInTwoPlayer: skips });
    play(game, seats[0]!, c); assert.equal(view().currentSeatId, seats[skips ? 0 : 1]);
  }
});
test("draw2 draws two for next seat and skips it without stacking", () => {
  const c = card("red", "draw2"); const { game, seats, view } = setup([[c, filler()], [card("purple", "draw2"), filler()], [filler(), filler()]]);
  play(game, seats[0]!, c); assert.equal(view(1).you.hand.length, 4); assert.equal(view().currentSeatId, seats[2]);
  assert.deepEqual(view(1).legalActions, []);
});
test("draw ends turn; voluntary draw can be disabled", () => {
  const { game, seats, view } = setup([[card("red", "2")], [filler()]], undefined, { allowVoluntaryDraw: false });
  errorCode(() => game.act(seats[0]!, 1, { type: "draw" }, 1010), "ILLEGAL_ACTION");
  const b = setup([[filler()], [filler()]], undefined, { allowVoluntaryDraw: false });
  assert.deepEqual(b.view().legalActions, [{ type: "draw" }]);
  b.game.act(b.seats[0]!, 1, { type: "draw" }, 1010);
  assert.equal(b.view().you.hand.length, 2); assert.equal(b.view().currentSeatId, b.seats[1]);
  assert.equal(view().turnId, 1);
});
test("illegal, foreign and out-of-turn actions cannot mutate state or reset deadline", () => {
  const { game, seats, view } = setup([[filler()], [card("red", "1")]]);
  const before = view();
  errorCode(() => game.act(seats[1]!, 1, { type: "draw" }, 1010), "NOT_YOUR_TURN");
  errorCode(() => play(game, seats[0]!, view(1).you.hand[0]!), "ILLEGAL_ACTION");
  errorCode(() => play(game, seats[0]!, before.you.hand[0]!), "ILLEGAL_ACTION");
  assert.deepEqual(view(), before);
});
test("duplicate turn cannot act twice even when skip leaves the same player next", () => {
  const c = card("red", "skip"), { game, seats, view } = setup([[c, filler()], [filler(), filler()]]);
  play(game, seats[0]!, c);
  errorCode(() => game.act(seats[0]!, 1, { type: "draw" }, 1020), "STALE_TURN");
  assert.equal(view().turnId, 2); assert.equal(view().you.hand.length, 1);
});
test("deadline expires at equality, forces draw, late play is rejected", () => {
  const c = card("red", "1"), { game, seats, view } = setup([[c], [filler()]], undefined, { turnTimeoutMs: 60 });
  assert.equal(game.expire(1059), false);
  errorCode(() => game.act(seats[0]!, 1, { type: "play", cardId: c.id }, 1060), "STALE_TURN");
  assert.equal(view().you.hand.length, 2); assert.equal(view().currentSeatId, seats[1]);
  assert.equal(game.metrics().timeoutSteps, 1); assert.equal(game.metrics().steps[0]!.elapsedMs, 60);
  assert.equal(game.expire(1060), false);
});
test("empty hand ends game, applies last-card penalty, no more timer actions", () => {
  const c = card("red", "draw2"), { game, seats, view } = setup([[c], [filler()]]);
  play(game, seats[0]!, c);
  assert.equal(view().status, "finished"); assert.equal(view(1).you.hand.length, 3);
  assert.deepEqual(view().result!.winners, [seats[0]]); assert.equal(view().result!.reason, "empty_hand");
  assert.equal(game.deadline, null); assert.equal(game.expire(1e9), false);
  errorCode(() => game.act(seats[0]!, 1, { type: "draw" }, 1020), "NOT_PLAYING");
});
test("round cap is seats × rounds, fewest wins and ties share win", () => {
  const { game, view } = setup([[filler()], [filler()], [filler()], [filler()]], undefined, { maxRounds: 1 });
  for (let n = 0; n < 4; n++) game.act(`s${n + 1}`, n + 1, { type: "draw" }, 1010 + n * 10);
  assert.equal(view().status, "finished"); assert.equal(view().result!.reason, "round_limit");
  assert.deepEqual(view().result!.winners, ["s1", "s2", "s3", "s4"]); assert.equal(view().completedSteps, 4);
});
test("can continue with an empty hand when stopOnEmptyHand=false", () => {
  const c = card("red", "1"), { game, seats, view } = setup([[c], [filler()]], undefined, { stopOnEmptyHand: false });
  play(game, seats[0]!, c); assert.equal(view().status, "playing"); assert.equal(view().you.hand.length, 0);
});
test("recycles discards while preserving top card", () => {
  const first = card("red", "1"), top = card("red", "0");
  const { game, seats, view } = setup([[first], [filler()]], top, { stopOnEmptyHand: false }, [card("green", "3")]);
  play(game, seats[0]!, first);
  game.act(seats[1]!, 2, { type: "draw" }, 1020);
  game.act(seats[0]!, 3, { type: "draw" }, 1030);
  assert.equal(view().topCard!.id, first.id); assert.equal(view().you.hand[0]!.id, top.id);
});
test("exhausted deck still advances, so no draw can stall a game", () => {
  const { game, seats, view } = setup([[filler()], [filler()]], undefined, {}, []);
  game.act(seats[0]!, 1, { type: "draw" }, 1010);
  assert.equal(view().you.hand.length, 1); assert.equal(view().currentSeatId, seats[1]);
});
test("metrics measure each step, slowest step and round, including partial round", () => {
  const { game, view } = setup([[filler()], [filler()]]);
  let now = 1000;
  for (const duration of [10, 20, 30, 40, 50]) { now += duration; game.act(view().currentSeatId!, view().turnId, { type: "draw" }, now); }
  const m = game.metrics();
  assert.equal(m.averageMs, 30); assert.equal(m.slowestStep!.elapsedMs, 50); assert.equal(m.slowestStep!.turnId, 5);
  assert.deepEqual(m.slowestRound, { round: 2, steps: 2, elapsedMs: 70, complete: true });
  assert.deepEqual(m.rounds.at(-1), { round: 3, steps: 1, elapsedMs: 50, complete: false });
});
test("view exposes only own hand and copies; events carry no hands", () => {
  const { game, view } = setup([[filler()], [filler()]]);
  const state = view(); assert.deepEqual(Object.keys(state.players[1]!).sort(), ["handCount", "name", "seatId"]);
  state.you.hand.length = 0; state.rules.initialHand = 99;
  assert.equal(view().you.hand.length, 1); assert.equal(view().rules.initialHand, 1);
  assert.equal(JSON.stringify(game.takeEvents()).includes('"hand"'), false);
  errorCode(() => game.view("unknown"), "UNKNOWN_SEAT");
});
test("external action hook is explicitly unimplemented and has no effect", () => {
  const { game, view } = setup([[filler()], [filler()]]); const before = view();
  errorCode(() => game.applyExternalAction({ type: "human_card", payload: {} }), "NOT_IMPLEMENTED");
  assert.deepEqual(view(), before);
});

test("double numeric plays are listed, discard both, and publish faces", () => {
  const a = card("red", "5"), b = card("red", "5");
  const { game, seats, view } = setup([[a, b], [filler(), filler()]]);
  const pair = view().legalActions.find((a) => a.type === "play" && a.secondCardId);
  assert.ok(pair);
  game.act(seats[0]!, 1, pair, 1010);
  assert.equal(view().status, "finished");
  const event = game.takeEvents().find((e) => e.type === "card_played");
  assert.ok(event?.type === "card_played");
  assert.deepEqual(event.cards.map((c) => c.id).sort(), [a.id, b.id].sort());
});

test("double effects and foreign second card are rejected", () => {
  const a = card("red", "skip"), b = card("red", "skip");
  const { game, seats } = setup([[a, b], [filler(), filler()]]);
  errorCode(() => game.act(seats[0]!, 1, { type: "play", cardId: a.id, secondCardId: b.id }, 1010), "ILLEGAL_ACTION");
});

test("pure JSON restoration preserves state, deadline and next action", () => {
  const { game, seats } = setup([[filler()], [filler()]]);
  const copy = GameEngine.fromState(JSON.parse(JSON.stringify(game.exportState())), { random: () => 0.5 });
  assert.deepEqual(copy.view(seats[0]!), game.view(seats[0]!));
  game.act(seats[0]!, 1, { type: "draw" }, 1010);
  copy.act(seats[0]!, 1, { type: "draw" }, 1010);
  assert.deepEqual(copy.exportState(), game.exportState());
});

function humanSetup() {
  const skip = card("red", "skip");
  const base = setup([[skip, filler()], [filler(), filler()], [filler(), filler()]]);
  const state = base.game.exportState();
  state.humanCards.s2 = { type: "draw4", used: false };
  state.humanCards.s3 = { type: "draw4", used: false };
  return { ...base, game: GameEngine.fromState(state), skip };
}

test("pending human card fires even when its owner is skipped", () => {
  const { game, skip } = humanSetup();
  game.queueHumanCard("s2", { type: "draw4", targetSeatId: "s3" }, 1001);
  game.act("s1", 1, { type: "play", cardId: skip.id }, 1010);
  assert.equal(game.view("s3").you.hand.length, 6);
  assert.equal(game.view("s1").currentSeatId, "s1");
  assert.equal(game.humanView("s2")!.used, true);
  assert.ok(game.takeEvents().some((e) => e.type === "human_card_played"));
});

test("human +4 and AI +2 stack their draws and skip once", () => {
  const plus = card("red", "draw2");
  const { game: original } = setup([[filler(), filler()], [plus, filler()], [filler(), filler()]]);
  const state = original.exportState();
  state.humanCards.s2 = { type: "draw4", used: false };
  const game = GameEngine.fromState(state);
  game.queueHumanCard("s2", { type: "draw4", targetSeatId: "s3" }, 1001);
  game.act("s1", 1, { type: "draw" }, 1010);
  assert.equal(game.view("s1").currentSeatId, "s2");
  assert.equal(game.view("s3").you.hand.length, 6, "human +4 draws immediately before its owner plays");
  assert.equal(game.view("s1").players.find((p) => p.seatId === "s3")!.handCount, 6);
  game.act("s2", 2, { type: "play", cardId: plus.id }, 1020);
  assert.equal(game.view("s3").you.hand.length, 8);
  assert.equal(game.view("s1").currentSeatId, "s1");
});

test("human button locks on own turn and pending survives JSON", () => {
  const { game } = humanSetup();
  errorCode(() => game.queueHumanCard("s1", { type: "draw4", targetSeatId: "s2" }, 1001), "HUMAN_LOCKED");
  game.queueHumanCard("s2", { type: "draw4", targetSeatId: "s3" }, 1001);
  const restored = GameEngine.fromState(JSON.parse(JSON.stringify(game.exportState())));
  assert.deepEqual(restored.humanView("s2")!.pending, { type: "draw4", targetSeatId: "s3" });
});

test("explicit start rejects incomplete and repeated starts; lobby cannot overfill", () => {
  const game = new GameEngine({ seats: 2 });
  game.join("one", 0);
  errorCode(() => game.start(0), "NOT_READY");
  game.join("two", 0);
  errorCode(() => game.join("three", 0), "ROOM_FULL");
  assert.equal(game.view("s1").status, "lobby");
  game.start(0);
  assert.equal(game.view("s1").you.hand.length, 7);
  errorCode(() => game.start(0), "NOT_READY");
});

test("swap changes selected card only and peek details stay private and consume once", () => {
  for (const type of ["swap", "peek"] as const) {
    const { game: original } = setup([[filler(), filler()], [filler(), filler()]]);
    const state = original.exportState();
    state.humanCards.s2 = { type, used: false };
    const game = GameEngine.fromState(state, { random: () => 0.5 });
    const before = game.view("s2").you.hand;
    game.queueHumanCard("s2", type === "swap" ? { type, cardId: before[0]!.id } : { type, targetSeatId: "s1" }, 1001);
    game.act("s1", 1, { type: "draw" }, 1010);
    if (type === "swap") {
      assert.equal(game.view("s2").you.hand.length, 2);
      assert.ok(!game.view("s2").you.hand.some((c) => c.id === before[0]!.id));
      assert.ok(game.view("s2").you.hand.some((c) => c.id === before[1]!.id));
    } else {
      assert.ok(game.view("s2").you.peek);
      assert.equal(game.view("s1").you.peek, null);
      assert.ok(game.consumePeek("s2"));
      assert.equal(game.consumePeek("s2"), null);
      const event = game.takeEvents().find((e) => e.type === "human_card_played");
      assert.deepEqual(event, { type: "human_card_played", seatId: "s2", card: "peek" });
    }
  }
});

test("round-limit final draw2 applies before counting hands and selecting winners", () => {
  const first = card("red", "1"), plus = card("red", "draw2");
  const { game, seats, view } = setup([[first, filler()], [plus, filler()]], undefined, { maxRounds: 1 });
  play(game, seats[0]!, first, 1010);
  play(game, seats[1]!, plus, 1020);
  assert.equal(view().status, "finished");
  assert.equal(view().result!.reason, "round_limit");
  assert.equal(view().you.hand.length, 3);
  assert.equal(view(1).you.hand.length, 1);
  assert.deepEqual(view().result!.winners, [seats[1]]);
});
