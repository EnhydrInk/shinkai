export type EventName = 'turn.ready' | 'game.finished' | 'owner.message';
export interface EventArguments { roomId: string; seatId: string; aiToken?: string }
export interface PublicEvent {
 eventId: string;
 name: EventName;
 timestamp?: string;
 data: { roomId: string; seatId: string; publicEvent: Record<string, unknown> };
}
export interface EventsStorage {
 get<T = unknown>(key: string): Promise<T | undefined>;
 put<T>(key: string, value: T): Promise<unknown>;
 delete(key: string): Promise<unknown>;
 list<T = unknown>(options: { prefix: string }): Promise<Map<string, T>>;
}
export interface EventsOptions {
 storage: EventsStorage;
 authorize: (principal: string | null, args: EventArguments) => Promise<string | null>;
 webhookFetch?: (url: string, init: RequestInit) => Promise<Response>;
 schedule?: (at: number) => Promise<unknown>;
 now?: () => number;
}
export class EventsError extends Error { code: number; data?: { reason: string }; constructor(code: number, message: string, reason?: string) }
export function sign(secret: string, id: string, timestamp: number | string, body: string): Promise<string>;
export function eventDefinitions(): { events: Array<Record<string, unknown>> };
export class EventsService {
 constructor(options: EventsOptions);
 handle(method: string, params?: Record<string, any>, principal?: string | null): Promise<Record<string, any>>;
 ready(roomId: string, seatId: string): Promise<boolean>;
 onPublicEvent(event: PublicEvent): Promise<void>;
 drain(): Promise<void>;
}
