export const COLORS = ["red", "yellow", "green", "purple"] as const;
export type Color = (typeof COLORS)[number];
export const EFFECTS = ["skip", "reverse", "draw2", "wild"] as const;
export type Effect = (typeof EFFECTS)[number];
export type Face = `${0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}` | Effect;
export type Card = { id: string; color: Color | "wild"; value: Face };
export type Action = { type: "draw" } | { type: "play"; cardId: string; secondCardId?: string; color?: Color };
export type Rules = {
  seats: number;
  initialHand: number;
  maxRounds: number;
  turnTimeoutMs: number;
  enabledEffects: Effect[];
  stopOnEmptyHand: boolean;
  allowVoluntaryDraw: boolean;
  reverseSkipsInTwoPlayer: boolean;
};
export const DEFAULT_RULES: Rules = {
  seats: 4,
  initialHand: 7,
  maxRounds: 10,
  turnTimeoutMs: 60_000,
  enabledEffects: [...EFFECTS],
  stopOnEmptyHand: true,
  allowVoluntaryDraw: true,
  reverseSkipsInTwoPlayer: true,
};

export class GameError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}
function requireGame(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new GameError(code, message);
}

export function parseRules(input: Partial<Rules> = {}): Rules {
  const rules = { ...DEFAULT_RULES, ...input, enabledEffects: [...(input.enabledEffects ?? DEFAULT_RULES.enabledEffects)] };
  for (const [key, min, max] of [
    ["seats", 2, 4], ["initialHand", 1, 10], ["maxRounds", 1, 1000], ["turnTimeoutMs", 10, 3_600_000],
  ] as const) {
    requireGame(Number.isInteger(rules[key]) && rules[key] >= min && rules[key] <= max,
      "BAD_CONFIG", `${key} must be ${min}–${max} integer`);
  }
  requireGame(rules.enabledEffects.every((v) => EFFECTS.includes(v)) &&
    new Set(rules.enabledEffects).size === rules.enabledEffects.length, "BAD_CONFIG", "Invalid or duplicate enabled effects");
  for (const key of ["stopOnEmptyHand", "allowVoluntaryDraw", "reverseSkipsInTwoPlayer"] as const) {
    requireGame(typeof rules[key] === "boolean", "BAD_CONFIG", `${key} must be boolean`);
  }
  return rules;
}

export function makeDeck(effects: readonly Effect[]): Card[] {
  const cards: Card[] = [];
  const add = (color: Card["color"], value: Face) => cards.push({ id: `c${cards.length + 1}`, color, value });
  for (const color of COLORS) {
    add(color, "0");
    for (let n = 1; n <= 9; n++) for (let copy = 0; copy < 2; copy++) add(color, String(n) as Face);
    for (const effect of effects.filter((e) => e !== "wild")) for (let copy = 0; copy < 2; copy++) add(color, effect);
  }
  if (effects.includes("wild")) for (let n = 0; n < 4; n++) add("wild", "wild");
  return cards;
}
function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

export type StepTiming = {
  turnId: number; round: number; seatId: string; action: "play" | "draw" | "timeout";
  startedAt: number; actedAt: number; elapsedMs: number;
};
export type RoundTiming = { round: number; steps: number; elapsedMs: number; complete: boolean };
export type Metrics = {
  totalSteps: number; timeoutSteps: number; averageMs: number;
  slowestStep: StepTiming | null; slowestRound: RoundTiming | null;
  steps: StepTiming[]; rounds: RoundTiming[];
};
export type PublicEvent =
  | { type: "turn_started"; seatId: string; turnId: number; deadline: number }
  | { type: "card_played"; seatId: string; cards: Card[]; color: Color }
  | { type: "human_card_played"; seatId: string; card: "draw4" | "swap" | "peek"; targetSeatId?: string }
  | { type: "step_completed"; step: StepTiming }
  | { type: "game_finished"; winners: string[]; metrics: Metrics };

// Future human-card entry point. No commands are supported or exposed over MCP yet.
export type ExternalAction = { type: string; payload: Readonly<Record<string, unknown>> };

export class GameEngine {
  readonly rules: Rules;
  private readonly players: { seatId: string; name: string; hand: Card[] }[] = [];
  private drawPile: Card[];
  private discardPile: Card[] = [];
  private activeColor: Color | null = null;
  private direction: 1 | -1 = 1;
  private currentIndex = 0;
  private phase: "lobby" | "playing" | "finished" = "lobby";
  private turnId = 0;
  private startedAt = 0;
  private steps: StepTiming[] = [];
  private winners: string[] = [];
  private finishReason: "empty_hand" | "round_limit" | null = null;
  private events: PublicEvent[] = [];
  private random: () => number;
  private humanCards: Record<string, { type: "draw4" | "swap" | "peek"; used: boolean; pending?: HumanAction }> = {};
  private penalties: Record<string, number> = {};
  private skipped: string[] = [];
  private peeks: Record<string, { targetSeatId: string; card: Card }> = {};

  constructor(rules: Partial<Rules> = {}, dependencies: { random?: () => number; deck?: Card[] } = {}) {
    this.rules = parseRules(rules);
    this.random = dependencies.random ?? Math.random;
    this.drawPile = dependencies.deck ? structuredClone(dependencies.deck) : shuffle(makeDeck(this.rules.enabledEffects), this.random);
    requireGame(this.drawPile.length > this.rules.seats * this.rules.initialHand, "BAD_DECK", "Not enough cards to deal");
    requireGame(new Set(this.drawPile.map((c) => c.id)).size === this.drawPile.length, "BAD_DECK", "Duplicate card IDs");
    requireGame(this.drawPile.slice(this.rules.seats * this.rules.initialHand).some((c) => /^\d$/.test(c.value)),
      "BAD_DECK", "A numeric initial discard is required after dealing");
  }

  join(name: string, now: number): string {
    requireGame(this.phase === "lobby", "GAME_STARTED", "The game has already started");
    requireGame(this.players.length < this.rules.seats, "ROOM_FULL", "All seats are occupied");
    const trimmed = name.trim();
    requireGame(trimmed.length >= 1 && trimmed.length <= 40, "BAD_NAME", "Name must contain 1–40 characters");
    requireGame(!this.players.some((p) => p.name === trimmed), "NAME_TAKEN", "Name is already taken");
    const seatId = `s${this.players.length + 1}`;
    this.players.push({ seatId, name: trimmed, hand: [] });

    return seatId;
  }

  start(now: number): void {
    requireGame(this.phase === "lobby" && this.players.length === this.rules.seats, "NOT_READY", "All seats must be occupied before starting");
    for (let i = 0; i < this.rules.initialHand; i++) for (const player of this.players) player.hand.push(this.drawPile.shift()!);
    const initial = this.drawPile.findIndex((c) => /^\d$/.test(c.value));
    const top = this.drawPile.splice(initial, 1)[0]!;
    this.discardPile.push(top);
    this.activeColor = top.color as Color;
    for (const player of this.players) this.humanCards[player.seatId] ??= { type: (["draw4", "swap", "peek"] as const)[Math.floor(this.random() * 3)]!, used: false };
    this.phase = "playing";
    this.beginTurn(now);
  }

  private beginTurn(now: number): void {
    for (let n = 0; n <= this.players.length; n++) {
      const seatId = this.players[this.currentIndex]!.seatId;
      this.activateHumanCard(seatId);
      const penalty = this.penalties[seatId] ?? 0;
      if (penalty) { this.draw(this.currentIndex, penalty); delete this.penalties[seatId]; }
      const skip = penalty > 0 || this.skipped.includes(seatId);
      this.skipped = this.skipped.filter((s) => s !== seatId);
      if (!skip) break;
      this.currentIndex = this.nextIndex();
    }
    this.turnId++;
    this.startedAt = now;
    this.events.push({ type: "turn_started", seatId: this.players[this.currentIndex]!.seatId,
      turnId: this.turnId, deadline: now + this.rules.turnTimeoutMs });
  }

  private nextIndex(distance = 1): number {
    return (this.currentIndex + this.direction * distance + this.players.length * distance) % this.players.length;
  }

  private draw(seatIndex: number, count: number): void {
    for (let n = 0; n < count; n++) {
      if (!this.drawPile.length && this.discardPile.length > 1) {
        const top = this.discardPile.pop()!;
        this.drawPile = shuffle(this.discardPile, this.random);
        this.discardPile = [top];
      }
      const card = this.drawPile.shift();
      // When every remaining card is in hands, drawing is a no-op; the turn still advances.
      if (card) this.players[seatIndex]!.hand.push(card);
    }
  }

  legalActions(seatId: string): Action[] {
    if (this.phase !== "playing" || this.players[this.currentIndex]!.seatId !== seatId) return [];
    const top = this.discardPile.at(-1)!;
    const actions: Action[] = [];
    for (const card of this.players[this.currentIndex]!.hand) {
      if (card.value === "wild") for (const color of COLORS) actions.push({ type: "play", cardId: card.id, color });
      else if (card.color === this.activeColor || card.value === top.value) actions.push({ type: "play", cardId: card.id });
    }
    const singles = [...actions];
    const hand = this.players[this.currentIndex]!.hand;
    for (const a of singles) if (a.type === "play") {
      const first = hand.find((c) => c.id === a.cardId)!;
      if (!/^\d$/.test(first.value)) continue;
      for (const second of hand) if (second.id !== first.id && second.color === first.color && second.value === first.value && first.id < second.id)
        actions.push({ type: "play", cardId: first.id, secondCardId: second.id });
    }
    if (this.rules.allowVoluntaryDraw || !actions.length) actions.push({ type: "draw" });
    return actions;
  }

  act(seatId: string, turnId: number, action: Action, now: number): void {
    // A late request cannot beat the deadline even if the scheduler has not fired yet.
    this.expire(now);
    requireGame(this.phase === "playing", "NOT_PLAYING", "The game is not playing");
    requireGame(turnId === this.turnId, "STALE_TURN", "Turn changed; read the new state before acting");
    requireGame(this.players[this.currentIndex]!.seatId === seatId, "NOT_YOUR_TURN", "It is not your turn");
    const valid = this.legalActions(seatId).some((candidate) => candidate.type === action.type &&
      (candidate.type === "draw" || (action.type === "play" && candidate.cardId === action.cardId && candidate.color === action.color && candidate.secondCardId === action.secondCardId)));
    requireGame(valid, "ILLEGAL_ACTION", "Illegal action; choose an action from legalActions");
    this.resolve(action, now, false);
  }

  expire(now: number): boolean {
    if (this.phase !== "playing" || now < this.startedAt + this.rules.turnTimeoutMs) return false;
    this.resolve({ type: "draw" }, now, true);
    return true;
  }

  private resolve(action: Action, now: number, timedOut: boolean): void {
    const player = this.players[this.currentIndex]!;
    let distance = 1;
    if (action.type === "draw") this.draw(this.currentIndex, 1);
    else {
      const index = player.hand.findIndex((c) => c.id === action.cardId);
      const card = player.hand.splice(index, 1)[0]!;
      const cards = [card];
      if (action.secondCardId) cards.push(player.hand.splice(player.hand.findIndex((c) => c.id === action.secondCardId), 1)[0]!);
      this.discardPile.push(...cards);
      this.activeColor = card.value === "wild" ? action.color! : card.color as Color;
      this.events.push({ type: "card_played", seatId: player.seatId, cards: structuredClone(cards), color: this.activeColor });
      if (card.value === "skip") this.skipped.push(this.players[this.nextIndex()]!.seatId);
      if (card.value === "reverse") {
        this.direction = this.direction === 1 ? -1 : 1;
        if (this.players.length === 2 && this.rules.reverseSkipsInTwoPlayer) this.skipped.push(this.players[this.nextIndex()]!.seatId);
      }
      if (card.value === "draw2") { const target = this.players[this.nextIndex()]!.seatId; this.penalties[target] = (this.penalties[target] ?? 0) + 2; }
    }
    const step: StepTiming = { turnId: this.turnId, round: Math.floor(this.steps.length / this.rules.seats) + 1,
      seatId: player.seatId, action: timedOut ? "timeout" : action.type, startedAt: this.startedAt, actedAt: now,
      elapsedMs: Math.max(0, now - this.startedAt) };
    this.steps.push(step);
    this.events.push({ type: "step_completed", step: { ...step } });
    if (this.rules.stopOnEmptyHand && player.hand.length === 0) this.finish("empty_hand");
    else if (this.steps.length >= this.rules.maxRounds * this.rules.seats) this.finish("round_limit");
    else { this.currentIndex = this.nextIndex(distance); this.beginTurn(now); }
  }

  private finish(reason: "empty_hand" | "round_limit"): void {
    for (const [seat, count] of Object.entries(this.penalties)) this.draw(this.players.findIndex((p) => p.seatId === seat), count);
    this.penalties = {};
    this.phase = "finished";
    this.finishReason = reason;
    const min = Math.min(...this.players.map((p) => p.hand.length));
    this.winners = this.players.filter((p) => p.hand.length === min).map((p) => p.seatId);
    this.events.push({ type: "game_finished", winners: [...this.winners], metrics: this.metrics() });
  }

  metrics(): Metrics {
    const steps = this.steps.map((s) => ({ ...s }));
    const rounds: RoundTiming[] = [];
    for (const step of steps) {
      let round = rounds.at(-1);
      if (!round || round.round !== step.round) { round = { round: step.round, steps: 0, elapsedMs: 0, complete: false }; rounds.push(round); }
      round.steps++;
      round.elapsedMs += step.elapsedMs;
      round.complete = round.steps === this.rules.seats;
    }
    return { totalSteps: steps.length, timeoutSteps: steps.filter((s) => s.action === "timeout").length,
      averageMs: steps.length ? steps.reduce((sum, s) => sum + s.elapsedMs, 0) / steps.length : 0,
      slowestStep: steps.reduce<StepTiming | null>((max, s) => !max || s.elapsedMs > max.elapsedMs ? s : max, null),
      slowestRound: rounds.reduce<RoundTiming | null>((max, r) => !max || r.elapsedMs > max.elapsedMs ? r : max, null),
      steps, rounds };
  }

  view(seatId: string) {
    const player = this.players.find((p) => p.seatId === seatId);
    requireGame(player, "UNKNOWN_SEAT", "Unknown seat");
    const playing = this.phase === "playing";
    return {
      status: this.phase,
      rules: structuredClone(this.rules),
      you: { seatId, name: player.name, hand: structuredClone(player.hand), peek: structuredClone(this.peeks[seatId] ?? null) },
      players: this.players.map((p) => ({ seatId: p.seatId, name: p.name, handCount: p.hand.length })),
      topCard: structuredClone(this.discardPile.at(-1) ?? null), activeColor: this.activeColor, direction: this.direction,
      currentSeatId: playing ? this.players[this.currentIndex]!.seatId : null,
      turnId: this.turnId,
      round: playing ? Math.floor(this.steps.length / this.rules.seats) + 1 : Math.ceil(this.steps.length / this.rules.seats),
      completedSteps: this.steps.length, maxSteps: this.rules.seats * this.rules.maxRounds,
      turnStartedAt: playing ? this.startedAt : null,
      deadline: playing ? this.startedAt + this.rules.turnTimeoutMs : null,
      legalActions: this.legalActions(seatId),
      result: this.phase === "finished" ? { reason: this.finishReason, winners: [...this.winners], metrics: this.metrics() } : null,
    };
  }


  humanView(seatId: string) {
    requireGame(this.players.some((p) => p.seatId === seatId), "UNKNOWN_SEAT", "Unknown seat");
    return structuredClone(this.humanCards[seatId] ?? null);
  }

  setHumanCard(seatId: string, type: HumanAction["type"]): void {
    requireGame(this.phase === "lobby", "GAME_STARTED", "Set demo cards before starting");
    requireGame(this.players.some((p) => p.seatId === seatId), "UNKNOWN_SEAT", "Unknown seat");
    this.humanCards[seatId] = { type, used: false };
  }

  queueHumanCard(seatId: string, action: HumanAction, now: number): void {
    this.expire(now);
    requireGame(this.phase === "playing", "NOT_PLAYING", "The game is not playing");
    requireGame(this.players[this.currentIndex]!.seatId !== seatId, "HUMAN_LOCKED", "Your AI is currently playing");
    const card = this.humanCards[seatId];
    requireGame(card && !card.used && !card.pending && card.type === action.type, "HUMAN_UNAVAILABLE", "Human card is unavailable");
    if (action.type === "swap") requireGame(this.players.find((p) => p.seatId === seatId)!.hand.some((c) => c.id === action.cardId), "BAD_CARD", "Card is not in your hand");
    else requireGame(action.targetSeatId !== seatId && this.players.some((p) => p.seatId === action.targetSeatId), "BAD_TARGET", "Choose an opponent");
    card.pending = structuredClone(action);
  }

  private activateHumanCard(seatId: string): void {
    const human = this.humanCards[seatId];
    if (!human?.pending) return;
    const action = human.pending;
    human.used = true;
    delete human.pending;
    const player = this.players.find((p) => p.seatId === seatId)!;
    this.events.push({ type: "human_card_played", seatId, card: action.type, ...(action.type === "draw4" ? { targetSeatId: action.targetSeatId } : {}) });
    if (action.type === "draw4") {
      this.draw(this.players.findIndex((p) => p.seatId === action.targetSeatId), 4);
      this.skipped.push(action.targetSeatId);
    }
    if (action.type === "swap") {
      const index = player.hand.findIndex((c) => c.id === action.cardId);
      const old = player.hand.splice(index, 1)[0]!;
      this.draw(this.players.indexOf(player), 1);
      this.drawPile.push(old);
      shuffle(this.drawPile, this.random);
    }
    if (action.type === "peek") {
      const target = this.players.find((p) => p.seatId === action.targetSeatId)!;
      const card = target.hand[Math.floor(this.random() * target.hand.length)];
      if (card) this.peeks[seatId] = { targetSeatId: target.seatId, card: structuredClone(card) };
    }
  }

  consumePeek(seatId: string) {
    const peek = structuredClone(this.peeks[seatId] ?? null);
    delete this.peeks[seatId];
    return peek;
  }

  exportState() {
    return structuredClone({ rules: this.rules, players: this.players, drawPile: this.drawPile, discardPile: this.discardPile,
      activeColor: this.activeColor, direction: this.direction, currentIndex: this.currentIndex, phase: this.phase,
      turnId: this.turnId, startedAt: this.startedAt, steps: this.steps, winners: this.winners, finishReason: this.finishReason,
      events: this.events, humanCards: this.humanCards, penalties: this.penalties, skipped: this.skipped, peeks: this.peeks });
  }

  static fromState(state: EngineState, dependencies: { random?: () => number } = {}): GameEngine {
    const game: GameEngine = Object.create(GameEngine.prototype);
    Object.assign(game, structuredClone(state), { random: dependencies.random ?? Math.random });
    return game;
  }

  get deadline(): number | null { return this.phase === "playing" ? this.startedAt + this.rules.turnTimeoutMs : null; }
  takeEvents(): PublicEvent[] { return this.events.splice(0); }
  applyExternalAction(_action: ExternalAction): never { throw new GameError("NOT_IMPLEMENTED", "External action is not implemented"); }
}
export type GameView = ReturnType<GameEngine["view"]>;

export type HumanAction = { type: "draw4" | "peek"; targetSeatId: string } | { type: "swap"; cardId: string };
export type EngineState = ReturnType<GameEngine["exportState"]>;
