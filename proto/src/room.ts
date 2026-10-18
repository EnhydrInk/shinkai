import { GameEngine, GameError, type Action, type PublicEvent, type Rules } from "./engine.js";

export const MAX_WAIT_MS = 25_000;
export type RoomOptions = {
  rules?: Partial<Rules>;
  engine?: GameEngine;
  now?: () => number;
  // Dot adapter can enqueue a webhook from these public events. Never attach hands/tokens.
  onPublicEvent?: (event: PublicEvent) => void;
};

export class GameRoom {
  private engine: GameEngine;
  private tokens = new Map<string, string>();
  private joins = new Map<string, { name: string; token: string }>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private now: () => number;
  private onPublicEvent: (event: PublicEvent) => void;

  constructor(options: RoomOptions = {}) {
    this.engine = options.engine ?? new GameEngine(options.rules);
    const epoch = Date.now() - performance.now();
    this.now = options.now ?? (() => Math.floor(epoch + performance.now()));
    this.onPublicEvent = options.onPublicEvent ?? (() => {});
  }

  private assertOpen(): void {
    if (this.closed) throw new GameError("SERVER_CLOSED", "服务器正在关闭");
  }

  private seat(token: string): string {
    this.assertOpen();
    const seat = this.tokens.get(token);
    if (!seat) throw new GameError("INVALID_TOKEN", "座位 token 无效；不能按名字或座位号查询手牌");
    return seat;
  }

  join(name: string, joinKey: string) {
    this.assertOpen();
    if (joinKey.length < 16 || joinKey.length > 128) throw new GameError("BAD_JOIN_KEY", "joinKey 需为私密的 16–128 字符随机串");
    const existing = this.joins.get(joinKey);
    if (existing) {
      if (existing.name !== name.trim()) throw new GameError("JOIN_KEY_REUSED", "该 joinKey 已用于另一个名字");
      return { token: existing.token, state: this.state(existing.token) };
    }
    const seatId = this.engine.join(name, this.now());
    const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
    this.tokens.set(token, seatId);
    this.joins.set(joinKey, { name: name.trim(), token });
    this.changed();
    return { token, state: this.engine.view(seatId) };
  }

  state(token: string) {
    const seat = this.seat(token);
    this.tick();
    return this.engine.view(seat);
  }

  act(token: string, turnId: number, action: Action) {
    const seat = this.seat(token);
    try { this.engine.act(seat, turnId, action, this.now()); }
    finally { this.changed(); }
    return this.engine.view(seat);
  }

  async wait(token: string, waitMs = MAX_WAIT_MS, signal?: AbortSignal) {
    const seat = this.seat(token);
    if (!Number.isFinite(waitMs) || waitMs < 0) throw new GameError("BAD_WAIT", "等待时长必须非负");
    this.tick();
    return new Promise<{ status: "your_turn" | "waiting" | "finished"; state: ReturnType<GameEngine["view"]> }>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const cleanup = () => {
        settled = true;
        if (timeout) clearTimeout(timeout);
        this.listeners.delete(check);
        signal?.removeEventListener("abort", abort);
      };
      const abort = () => {
        if (settled) return;
        cleanup();
        reject(new GameError("CANCELLED", "等待已取消，可以重新等待"));
      };
      const check = (force = false) => {
        if (settled) return;
        if (this.closed) { cleanup(); reject(new GameError("SERVER_CLOSED", "服务器正在关闭")); return; }
        const state = this.engine.view(seat);
        const status = state.status === "finished" ? "finished" : state.currentSeatId === seat ? "your_turn" : "waiting";
        if (force || status !== "waiting") { cleanup(); resolve({ status, state }); }
      };
      this.listeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => { this.tick(); check(true); }, Math.min(MAX_WAIT_MS, waitMs));
      if (signal?.aborted) abort(); else check();
    });
  }

  private tick(): void { if (this.engine.expire(this.now())) this.changed(); }

  private changed(): void {
    if (this.timer) clearTimeout(this.timer);
    const deadline = this.engine.deadline;
    if (deadline !== null && !this.closed) {
      this.timer = setTimeout(() => { this.tick(); if (this.engine.deadline !== null) this.scheduleIfEarly(); }, Math.max(1, deadline - this.now()));
      this.timer.unref();
    }
    for (const event of this.engine.takeEvents()) {
      try { this.onPublicEvent(event); }
      catch { console.error("公共事件接收器失败；牌局继续"); }
    }
    for (const listener of [...this.listeners]) listener();
  }

  private scheduleIfEarly(): void {
    // Timer granularity may wake slightly before the deadline.
    if (!this.closed && this.engine.deadline !== null && this.now() < this.engine.deadline) this.changed();
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const listener of [...this.listeners]) listener();
  }
}
