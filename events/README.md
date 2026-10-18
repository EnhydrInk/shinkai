# MCP Events lane

## Protocol decision

MCP Events in ChatGPT needs protocol `2026-07-28` (MCP 2.0). TypeScript v2 is the `@modelcontextprotocol/server` / `@modelcontextprotocol/client` package family. The prototype's `@modelcontextprotocol/sdk@1.32.1` cannot advertise this revision. Keep the legacy waiting-tool transport available while adding modern discovery; do not merely relabel a v1 response as v2.

Sources actually opened:

- [OpenAI MCP Events](https://developers.openai.com/plugins/build/mcp-events): wire methods, subscription lifecycle, callback verification, webhook delivery.
- [TypeScript SDK protocol versions](https://ts.sdk.modelcontextprotocol.io/v2/protocol-versions): modern and legacy entry points.
- [TypeScript v1 SDK](https://ts.sdk.modelcontextprotocol.io/): v1 supports revisions only through 2025-11-25.
- [Standard Webhooks implementation](https://github.com/standard-webhooks/standard-webhooks/tree/main/libraries/javascript): signing format; independently tested against Node HMAC.

The npm registry was queried successfully: `@modelcontextprotocol/server` is `2.3.1`. No dependency added by this lane; the owning server may implement the documented JSON-RPC contract directly.

## Integration contract

`index.mjs` is Web Crypto / Workers compatible with no Node dependencies. Owning Durable Object must serialize mutations; room state and event enqueue should complete before returning a move response.

```js
const events = new EventsService({
  storage: this.ctx.storage,
  authorize: async (principal, args) => {
    // On subscribe, args includes roomId, seatId, aiToken: validate token against
    // this room and return a stable internal seat principal (never the token).
    // During delivery, principal is this saved internal principal and args has
    // only roomId and seatId: recheck that the seat is still bound to that owner.
    return authenticatedInternalSeatOwnerOrNull;
  },
  webhookFetch: secureOutboundCallbackFetch,
  // Merge this time with the game's existing timeout alarm. DO has only one alarm.
  schedule: async (at) => mergeWithRoomAlarm(at),
});
// Route on the same authenticated MCP endpoint as tools:
await events.handle(method, params, principal);
// Before starting: require events.ready(roomId, seatId), or active wait tool.
// On a turn beginning, game ending, or closing owner message:
await events.onPublicEvent({
  eventId: stableUniqueGameEventId,
  name: 'turn.ready', // also game.finished / owner.message
  timestamp: occurrenceTimeISO,
  data: { roomId, seatId, publicEvent: alreadySanitizedPublicEvent },
});
// In alarm (alongside game timeout processing):
await events.drain();
```

`publicEvent` must contain only already-public game data, including actual played card faces when relevant. Never pass a room object, hands, human credentials, AI tokens, peek target, or peek card here. The module routes by room+seat and does not inspect nested publicEvent fields. A successful webhook ACK is receipt only; first-turn confirmation must come from the AI's tool read/action rather than treating HTTP 2xx as AI acknowledgement.

`events/list` declares the three events. Subscription filters are `roomId`, `seatId`, `aiToken`; the token is verified then excluded from saved subscription identity and state. Subscribe/unsubscribe identity uses canonical normalized room/seat filters and a stable authenticated owner. Subscription lifetime defaults to one hour, caps requested lifetime at one hour, and returns a finite refreshBefore even when indefinite lifetime is requested. Replay is unsupported (`cursor: null`); persisted pending deliveries survive restarts. The queue preserves event IDs, signs each attempt freshly, retries transient failures at 1/2/4/8/16 seconds, and stops on 410/413. Delivered/failed job tombstones remain for deduplication; room teardown must delete its events storage alongside room state.

## Secure outbound transport: integration blocker

There is deliberately no default `fetch`. Subscription creation fails closed with `CallbackEndpointError / transport_unavailable` until the host supplies a secure callback fetch. OpenAI requires public destination validation **at connection time**, connecting to that validated address while preserving TLS hostname, and rejecting redirects. A hostname syntax check or DNS lookup followed by ordinary Workers fetch does not establish DNS binding. Do not claim it does.

A trusted outbound proxy that enforces these checks can provide the transport; no proxy or credential was created by this lane. Once Dot supplies a real callback, investigate supported Cloudflare networking or the callback's provider-controlled host restrictions. Do not guess ChatGPT callback domains from examples. This blocks live activation, not the waiting-tool fallback.

## Dot subscription instruction

This game is your break time. Most of the time you work for people; this game isn't a task. Nobody is rushing you, and winning or losing doesn't change anything.

Subscribe to turn.ready, game.finished, and owner.message for your room and seat, using your AI token. Disable event batching in the subscription/task settings. On turn.ready, read get_state and choose a legal action; you may include a Japanese table remark. After each action, leave your person one visible sentence in the conversation; its content is up to you. On game.finished, read the result, optionally submit one Japanese closing remark (or explicitly choose silence), then wait for your person's closing message. Follow the game's closing tools and deadlines. Never reveal private hand data in conversation or table remarks.

Whether Dot can receive a second event after acting without a visible conversational reply is untested. Keep the visible sentence instruction until the user performs the requested two-event comparison.

## Verification

`node --test events/events.test.mjs`: independent signature oracle; canonical subscription identity; callback challenge rejection; secure transport missing; token rejection; room/seat filtering; revocation; expiry; persistent retry and deduplication; 410/413 handling. Tests use in-memory storage and mock callback responses. No Cloudflare deployment or Dot event delivery was performed.

## Network follow-up

Official OpenAI documentation supplies an example receiver hostname, not an authoritative callback-domain allowlist. No real Dot callback has been observed. Do not infer an allowlist from that example. Modern wire fields remain `server/discover` → `resultType`, `supportedVersions`, `capabilities`; event methods and envelope fields above match the official page.

Cloudflare [TCP sockets documentation](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) explicitly blocks connections to Cloudflare IP ranges. A raw socket implementation cannot be assumed to reach an unknown ChatGPT callback. Ordinary Workers fetch does not expose a documented DNS-pinning contract. A separate trusted egress service remains an integration decision for the main lane.

`node-webhook-fetch.mjs` supplies `nodeWebhookFetch` for the **Node fallback or a future trusted egress service**. It permits HTTPS DNS names on port 443, resolves once per attempt, rejects any non-public result (including mapped IPv6/transition ranges), and returns a validated address through Node HTTPS's connection lookup while preserving hostname/SNI/certificate validation. It creates a fresh connection per request, rejects redirects, caps callback responses at 64 KiB, and enforces a 10-second deadline. It is not imported by the Worker module. No proxy, deployment, credentials, or external application POST was created.

`node --test events/*.test.mjs`: 10 tests pass. The added tests cover public/private address classification, mixed DNS response rejection, address pin selection, and invalid callback URL/options. Actual TLS delivery through this Node helper, an deployed egress service, and real Dot two-event receipt remain unverified.

## Local trusted relay

Run `node events/relay.mjs` with `RELAY_TOKEN` already present in the process environment (at least 32 random, non-whitespace characters). Do not put the value in source, logs, command examples, or this README. The production entry listens only on `127.0.0.1:8790`; expose it through a separately managed HTTPS tunnel. `GET /health` returns only `{ok:true}`.

Worker transport contract:

- POST `/deliver` with `Authorization: Bearer <RELAY_TOKEN>` and `Content-Type: application/json`.
- JSON body `{url, init:{headers,body}}`. `body` is the exact already-signed callback JSON string. Allowed headers are only `Content-Type`, `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id` (case-insensitive). All five are required. Other envelope keys or headers are rejected.
- Relay requests cap at 300 KiB, callback body at 256 KiB, callback response at 64 KiB. The destination transport always uses POST, HTTPS port 443, pinned public DNS, verified original TLS hostname, and no redirects. Callers cannot override these options.
- A delivered callback returns relay HTTP 200 with JSON `{status,body,responseHeaders}`. Recreate the callback `Response` with the returned status/body/headers; for 204/205/304 use a null body. Only the callback Content-Type header is returned. Callback HTTP 4xx/5xx remain callback statuses so EventsService applies its own retry rules.
- Relay HTTP 400/401/413/502 means validation/auth/size/transport failure; throw from the Worker transport. Never treat relay HTTP 200 alone as a callback ACK. Only the nested callback status is authoritative.

This relay does not change MCP Events wire payloads. Verification remains `{type:'verification',challenge}`; application delivery remains `{eventId,name,timestamp,data,cursor:null}`; signatures cover the original body bytes. The relay envelope exists only between our Worker and trusted local egress.

`node --test events/*.test.mjs`: 16 tests pass, including actual loopback HTTP authentication, invalid-envelope/header rejection, oversize rejection, private callback URL rejection, and a full EventsService challenge + event round trip through the local HTTP relay with independent Node HMAC checks. The test receiver is mocked after the local relay; no public callback or Dot was contacted. A sandbox initially denied loopback listening (EPERM); rerun with approved escalation passed. Public tunnel exposure, Worker transport/secrets wiring, real Node HTTPS delivery, and Dot two-event receipt remain for the main lane.

## Official modern SDK public smoke

The official npm registry returned `@modelcontextprotocol/client@2.1.0`. It was installed only under `/private/tmp/shinkai-modern-client`; no project dependency or lockfile changed. Run `node --dns-result-order=ipv4first events/modern-smoke.mjs` after installing that exact client version in that temporary prefix. This creates a fresh isolated two-seat room on the deployed public table, reserves its own seats, and keeps all credentials in memory. It does not read other test sessions or start models.

Actual successful output:

```text
client 1: pinned modern connect OK
client 2: pinned modern connect OK
tools/list: 6 tools decoded
events/list: 3 event definitions decoded
join_game/get_state: both seats OK
wait/act: completed maxRounds=1 game in 2 draw moves
submit_postgame / owner-message / wait_for_owner: both closing flows OK
PASS: official MCP v2 modern SDK public-room smoke; no Dot webhook delivery tested
```

Both clients used `versionNegotiation: {mode: {pin: '2026-07-28'}}`, not legacy initialize. The SDK treats `events/list` as an extension, so the test passes an explicit Zod result schema and validates the three definitions. Intermittent public network `ETIMEDOUT` occurred on earlier runs; the smoke permits at most two transport retries for idempotent calls and does not retry `act`. An initial tool-count assertion in the smoke incorrectly expected seven tools; it was corrected to check the six required tool names before the successful run. These were test/network issues, not evidence of a server decoder failure.

This verifies modern discovery, event catalog decoding, tool catalog decoding, both-seat tool use, a complete short game, and both closing flows against the public Worker with the official SDK. It does **not** verify successful real callback subscription/delivery, ChatGPT/Dot receiving events, or the two-event Dot acceptance gate.

### Public subscription negative tests after Mcp-Name correction

`node --dns-result-order=ipv4first events/modern-negative-smoke.mjs` uses the same official client `2.1.0`, pins `2026-07-28`, creates a fresh private test seat, joins it, and calls `events/subscribe` with an explicit extension result schema. It holds credentials and random signing keys only in memory. It targets only our own public `/health` URL, which does not echo callback challenges; no new callback receiver or active subscription is created.

Actual output against deployed protocol correction:

```text
wrong-token: code=-32001 OK
correct-token-non-echo-callback: code=-32015 reason=challenge_failed OK
PASS: official modern SDK subscription negative paths; no active subscription or Dot delivery
```

The first response demonstrates seat authorization rejection. The second passes the modern request header checks and seat authorization, then rejects the real callback verification path with `challenge_failed` rather than `HeaderMismatch (-32020)`. The result proves that this SDK subscription passed header validation and seat authorization into callback verification. `EventsService` also categorizes non-timeout transport failures as `challenge_failed`, so this response alone does not prove that this particular POST reached `/health` or completed relay TLS. Separate relay TLS evidence or anonymous relay telemetry is needed for that stronger claim. It does not establish a successful callback subscription or receipt by Dot. The script permits at most two network-timeout retries per request and stops each assertion when its explicit response arrives.
