# Add reliable order updates to an existing application

[← README](../README.md) · [Versions](index.md) · [Русский](integration.ru.md)

## 1. Understand the object you are adding

A relay client is one connection session for one account and one logical stream. It receives an event, waits for your business handler, saves the event position, then considers that event complete. If the connection breaks, it asks the server for the events after that position.

Use it for order status, alerts and live dashboards where reconnecting must preserve progress. A native EventSource is enough when missing an update is acceptable or the application always reloads the entire state. This package expects the [relay protocol](PROTOCOL.md): it cannot recover history that the server never retained.

Your application owns login and business actions. The library owns parsing, retry delays, the processing/checkpoint boundary and transport cancellation. The optional Node reference server keeps history in memory; production retention is a separate server responsibility.

## 2. Put the integration in your project

Dependencies and the complete first module are in [Get started](../README.md). A typical layout is:

```text
src/
  auth/session.ts                 existing OAuth/session transport
  orders/order-updates.ts         copy examples/orders.ts
  orders/order-page.ts            start on open, stop on close
server/
  events-route.ts                existing authenticated relay-protocol endpoint
```

[Full order module](../examples/orders.ts) · [DPoP session adapter](../examples/dpop-session.ts) · [Executable reference server](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs).

The frontend and server agree on `/api/events`, stream `notifications`, authenticated account identity and JSON `{key,text}` messages. `key` is a business identifier; the SSE event ID is a separate processing position supplied by the server. Do not use a user-editable account string to authorize access.

<a id="receive-orders"></a>
## 3. Receive and apply an order update

`watchOrderUpdates(accountId, authenticatedFetch, applyNotice)` in the source returns a client. Call its `start()` once. `applyNotice` receives a decoded notice and an AbortSignal; it may be asynchronous. The session does not advance its cursor until the returned promise finishes and checkpoint saving succeeds.

`decodeOrderNotice` validates your business fields. Invalid JSON or fields leave the event uncommitted and consume the normal bounded retry budget. This is deliberate: silently skipping malformed data would hide a gap. Fix the payload or recover from a matching snapshot instead of pretending it was handled.

`jsonEventHandler({decode,onData})` is the same adapter when you already construct `SseRelayClient` or use a framework provider. It never starts its own connection.

<a id="profiles"></a>
## 4. Select a named policy

Start with `RelayProfiles.NOTIFICATIONS`, the default for `createJsonRelay`. For a busy display, choose `RelayProfiles.LIVE_FEED`. Both remain bounded; these names are starting points, not latency or throughput guarantees.

| Setting | NOTIFICATIONS | LIVE_FEED |
|---|---|---|
| Total connection attempts per session | 8 | 8 |
| Retry delay range | 250 ms–10 s | 250 ms–5 s |
| Connection / byte-idle timeout | 10 s / 45 s | 10 s / 30 s |
| Maximum queued events | 128 | 256 |
| Maximum queued bytes | 1 MiB | 2 MiB |
| Maximum frame size | 64 KiB | 64 KiB |
| Recent committed IDs | 1024 | 2048 |

Use `...RelayProfiles.LIVE_FEED` in the options object; supply a specific `retry`, `limits` or timeout only when your server/application needs a different value. The profile and nested settings are frozen. The client copies values before use. Heartbeats must arrive more often than the selected byte-idle timeout.

An exhausted session is terminal. A deliberate new `start` owner or UI reconnect begins a new finite budget; the package does not hide an unlimited retry loop.

<a id="lifecycle"></a>
## 5. Match the lifetime of the view and its cursor

`createJsonRelay` supplies a memory checkpoint for its own session. Keep your application state for that same lifetime. A cursor says what has been processed; it does not contain the orders themselves.

- `stop()` aborts the stream and future handlers. An already-running business operation must honor its signal.
- `await logout()` also waits for running work and clears the account/stream checkpoint. Then discard the account's view and OAuth session as appropriate.
- A custom persistent checkpoint requires matching persisted application state, or snapshot recovery after reload. Restoring only the cursor would skip the data needed to rebuild a fresh screen.

A business effect can happen before checkpoint saving fails. Make that effect idempotent, for example by upserting an order by its business key. The browser cannot transactionally commit a remote payment and its local cursor.

## 6. Recover a missing history window

When the server no longer retains the requested position, the result is `resync`. Fetch an authorized snapshot containing a consistent state and cursor; apply the state first, then create a new client with `initialCursor`. See the [complete recovery walkthrough](v0.1.0/guide.en.md#snapshot-after-resync).

For a ready React list, [SseFeed](https://github.com/dlorian59/browser-sse-relay-react) manages this order through `snapshotUrl` and its restore button; `loadSnapshot` is the alternative for an existing application SDK. It is appropriate for a bounded display of keyed records, not a durable business ledger.

## 7. Connect authentication

Reuse your existing authenticated fetch. If your OAuth deployment supports DPoP, `createDpopFetch` signs every request with the token-bound key and handles one resource nonce challenge. The [DPoP guide](dpop.en.md) covers key lifetime, refresh, required server checks and CORS. The relay does not implement login or convert a Bearer token into a bound token.

## Common integration mistakes

| Symptom | Cause and correction |
|---|---|
| Reconnect skips visible orders | A cursor survived while the view did not. Restore matching state or snapshot. |
| An operation executes twice | Processing succeeded but its checkpoint failed. Use a business idempotency key/upsert. |
| Repeated decoding failures | The server payload differs from the business contract. Validate and correct it; do not acknowledge bad data. |
| A quiet stream keeps reconnecting | The selected idle timeout is shorter than heartbeat intervals. Align both. |
| Authentication fails after reload | The token and DPoP key no longer match. Restore the OAuth session or obtain a newly bound token. |

## Next steps

[Detailed behavior](v0.1.0/guide.en.md) · [Full API](v0.1.0/reference.en.md) · [Protocol](PROTOCOL.md) · [Run the executable examples](../CONTRIBUTING.md) · [Verification](VERIFICATION.md).

[← README](../README.md) · [Русский](integration.ru.md)
