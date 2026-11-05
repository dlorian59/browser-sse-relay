# API reference · 0.1.0 · English

[← Documentation](../index.md) · [Guide](guide.en.md) · [Русский](reference.ru.md) · [README](../../README.md)

This reference covers the public exports of the browser entry and /server entry. Parser, queue and wire-encoding helpers are implementation details, not package exports. ESM only; browser entry has no Node dependency. [Client source](https://github.com/dlorian59/browser-sse-relay/blob/main/src/client.ts), [checkpoint source](https://github.com/dlorian59/browser-sse-relay/blob/main/src/checkpoint.ts), [server source](https://github.com/dlorian59/browser-sse-relay/blob/main/src/server/index.ts).


## DPoP transport

[Setup, full API, failure handling and server requirements](../dpop.en.md) · [Typed integration](../../examples/dpop-session.ts) · [Implementation](https://github.com/dlorian59/browser-sse-relay/blob/main/src/dpop.ts).

The root export also includes `createDpopKeyPair`, `getDpopThumbprint`, `createDpopProof`, `createDpopFetch`, and types `DpopProofOptions` / `DpopFetchOptions`. Inject the GET-only adapter through `RelayOptions.fetch`; generic headers remain supported. Each connection has a fresh ES256 proof with token hash/key binding and at most one immediate resource-nonce retry. OAuth issuance/refresh and production resource verification belong to the application. Private keys are not automatically persisted.

## Browser exports and identity

| Export | Contract |
|---|---|
| SseRelayClient | One-shot client. Constructor validates scope, callback, cursor and numeric limits; transport work starts at start(). |
| RelayOptions | Required scope, url, onEvent plus the options below. |
| RelayContext | Readonly scope, session AbortSignal, current attempt number, isCurrent(). A handler must check it before late effects. Signal represents the session, not each reconnect request. |
| RelayResult | Readonly state: resync / failed / closed, reason:string, cursor:string or undefined, optional error:unknown. Reasons are diagnostic strings, not a closed TypeScript enum. |
| RelayState | idle / connecting / replaying / live / waiting / authenticating / resync / failed / closed. |
| StreamScope | Readonly accountId and streamId. Each contains 1–256 UTF-16 code units; U+0000–U+001F are rejected. Scope is a namespace, not authentication. |
| RelayEvent | Readonly id, event and data strings. Data is not automatically JSON-decoded. |
| CheckpointStore | Async load/save/clear contract described below. |
| MemoryCheckpointStore | Scoped map owned by that store instance; no persistence or cross-tab locking. |
| LocalStorageCheckpointStore | Cursor-only adapter around an injected Storage-like object; no implicit window access. |
| ProtocolError | Error subclass with message; malformed controls/status/content fail closed. |
| ResyncError | Error subclass with readonly reason; state recovery is required. |

Cursors are opaque 1–1024 printable ASCII characters U+0021–U+007E, without spaces. Never sort them, derive account identity from them, or use one scope's cursor for another. Event names are 1–128 UTF-16 code units without CR, LF or NUL; relay- is reserved for protocol controls. MemoryEventStore rejects reserved application names.

## RelayOptions

| Field | Default / requirement | Behavior |
|---|---|---|
| scope | Required | Authenticated application identity; copied and frozen by the client. |
| url | Required | String or async/sync (context) → string; evaluated before every connection. Host validates any dynamically selected endpoints. |
| onEvent | Required | Awaited (event,context) → void/Promise<void>. Throw/reject closes the attempt and retries within budget; effects may repeat. |
| headers | Absent | HeadersInit or async/sync (context) → HeadersInit, rebuilt per attempt. Accept is forced to text/event-stream; caller Last-Event-ID is removed/replaced by the committed cursor. |
| credentials | same-origin | Standard fetch RequestCredentials; use include only with appropriate server auth/CORS policies. |
| checkpoint | Absent | Without a store, the client still maintains its cursor in memory for its own session. No automatic localStorage persistence. |
| initialCursor | Absent | Cursor of already-installed application state. Saves it to the supplied store before connecting and bypasses load; failure is initialization-failed. |
| signal | Absent | External cancellation calls stop; listener is detached on stop/completion. An already-aborted signal prevents work. |
| onState | Absent | (state,{attempt,cursor}) diagnostics. This callback is synchronous: thrown exceptions are ignored, but returned promises are not awaited or caught. Handle any asynchronous diagnostic work and its rejection yourself. This is not a transactional checkpoint notification. |
| refreshAuth | Absent | Async/sync (context) → boolean, called after HTTP401, once per request. true allows another bounded connection; false/rejection ends authentication-failed. |
| fetch | globalThis.fetch | Injectable compatible fetch implementation; browser/OS buffering lies outside library limits. |
| connectTimeoutMs | 10000 | HTTP response-header timeout. Does not time out URL/header callbacks, handlers, store operations or refreshAuth. |
| idleTimeoutMs | 45000 | Time without incoming body bytes; comments/heartbeats reset it. Not a handler-duration timeout. EOF clears it while received work drains. |
| retry | See below | Total connection budget, including successful connections that later reconnect. |
| limits | See below | Frame/queue/dedup accounting, not total process heap. |
| random | Math.random | Deterministic jitter injection. Expected [0,1]; out-of-range samples are clamped, nonfinite becomes 0.5. |

The request is GET with redirect:error and cache:no-store. Redirects are rejected rather than forwarding credentials. Application callbacks must settle and cooperate with cancellation: abort cannot interrupt arbitrary JavaScript promises or undo a remote effect.

### Retry and resource defaults

| Nested field | Default | Range / meaning |
|---|---|---|
| retry.maxAttempts | 8 | Positive safe integer; total attempts in one session, not consecutive failures. No reset upon live. |
| retry.minDelayMs | 250 | Integer 0–2147483647. |
| retry.maxDelayMs | 10000 | Same range, at least minDelayMs. |
| retry.jitter | 0.2 | Finite [0,1], multiplier 1−jitter … 1+jitter, then clamp to delay bounds. |
| limits.maxFrameBytes | 65536 | Positive safe integer; UTF-8 wire bytes between frame boundaries, including fields/comments. |
| limits.maxQueuedEvents | 128 | Positive safe integer; parsed queued frames, including controls. |
| limits.maxQueuedBytes | 1048576 | Positive safe integer; UTF-8 data+id+event bytes in parsed queue. |
| limits.dedupEntries | 1024 | Nonnegative safe integer; successfully committed IDs retained in this session. Zero disables this cache. |

connectTimeoutMs and idleTimeoutMs accept integers 1–2147483647. Reconnect delay grows exponentially by attempt; valid Retry-After seconds/date or SSE retry hints replace the base delay, then clamp/jitter applies. A successful auth refresh still consumes an attempt and the configured minimum delay. One active handler frame, one parser frame, browser buffers and application copies are outside queued-byte accounting. Queue/frame overflow returns resync; it never silently skips an event.

## Client methods, states and failures

| Member | Result |
|---|---|
| scope | Frozen StreamScope. |
| state | Current RelayState; initially idle. |
| committedCursor | Last successfully handled and saved cursor, or undefined. |
| dedupSize | Current bounded session duplicate cache size. |
| start(): Promise<RelayResult> | Starts once. Repeated calls return the same promise; after terminal result construct a new client. Promise resolves for ordinary protocol/network/handler/store failures. |
| stop(): void | Aborts transport and timers; starts no more handlers. Await start() to know existing work settled. Calling before start prevents connection. |
| logout(): Promise<void> | Stop, await started work, clear in-memory cursor/cache, then await scoped store.clear with a fresh signal. Clear failure rejects; external storage may retain the old cursor. |

idle → connecting → replaying → live; retry uses waiting, HTTP401 may use authenticating. resync, failed and closed are terminal. Context isCurrent() becomes false after stop or terminal state. It is not a distributed lock.

| Condition | Terminal result or recovery |
|---|---|
| stop / external abort | closed, stopped |
| HTTP204 | closed, server-closed |
| HTTP409/410 | resync, cursor-unavailable |
| relay-resync | resync with server reason |
| Oversized frame / client queue overflow | resync, frame-too-large / client-queue-overflow |
| Invalid protocol/header/control/boundary, other HTTP statuses | failed, protocol-error |
| HTTP401 without successful refresh, HTTP403 | failed, authentication-failed |
| Network/EOF/header timeout/idle timeout/HTTP408/429/5xx/handler or save error | Retry, then failed, retry-exhausted when budget ends; error retains underlying diagnostic/cause. |
| Initial load/save/invalid stored cursor or setup failure | failed, initialization-failed |

Application exceptions are always handler failures: throwing ProtocolError/ResyncError inside onEvent does not bypass retry policy. Snapshot recovery is a separate application action. [Runnable recovery](guide.en.md#snapshot-after-resync).

## Checkpoint stores

`load(scope,signal): Promise<string|undefined>`, `save(scope,cursor,signal): Promise<void>`, `clear(scope,signal): Promise<void>`. Implementations must check cancellation before committing and settle pending work. Processing order is awaited handler → awaited save → committed cursor. A durable side effect followed by failed save can repeat. Neither built-in store coordinates writers or tabs.

MemoryCheckpointStore() creates an empty map; clearing a scope does not affect another. LocalStorageCheckpointStore(storage,prefix?) accepts getItem/setItem/removeItem; default prefix is browser-sse-relay:v1:. Key suffix is JSON.stringify([accountId,streamId]). Missing getItem returns undefined; invalid stored cursors and storage exceptions surface. localStorage is not secure token storage, and a cursor does not restore domain state. Restore matching state/cursor or a fresh snapshot on reload. [Store example](guide.en.md#process-and-checkpoint).

## Server exports and configuration

/server exports MemoryEventStore, HistorySubscription, createNodeRelay, HistoryOptions, StoreStats, NodeRelayOptions and the StreamScope/RelayEvent types. It is Node-only. This release does not expose a pluggable durable log port: NodeRelayOptions.store requires MemoryEventStore. Production adapters must preserve the protocol and atomic replay/live boundary; do not claim that another database is supported merely by copying its name into configuration.

### HistoryOptions

All numeric options are positive safe integers; retentionMs is an age comparison, not a setTimeout. [History implementation](https://github.com/dlorian59/browser-sse-relay/blob/main/src/server/history.ts).

| Option | Default | Scope / meaning |
|---|---|---|
| maxEventsPerStream | 256 | Retained event count per account/stream. |
| retentionMs | 300000 | Event age in ms; pruning occurs during operations, not on a background timer. |
| maxRetainedBytes | 16777216 | Global UTF-8 encoded wire bytes; oldest events evicted across streams. |
| maxStreams | 64 | Scope entries; empty streams are not automatically deleted. Bounds lifetime cardinality. |
| maxSubscribers | 64 | Global active subscriber count. |
| maxQueuedFrames | 1024 | Per subscriber, includes hello and ready controls. |
| maxQueuedBytes | 1048576 | Per subscriber, full UTF-8 wire bytes including field framing. |
| maxEventBytes | 65536 | Full encoded application frame size, not just JSON payload bytes. Must also fit maxRetainedBytes. |
| now | Date.now | Injected clock returning epoch milliseconds for deterministic retention tests. |

| MemoryEventStore member | Behavior |
|---|---|
| append(scope,data,event='message') → RelayEvent | String payload, generated opaque UUID cursor, synchronous commit then subscriber notification. A slow subscriber's failure does not undo producer commit. Size/invalid input/capacity may throw before commit. |
| currentCursor(scope) → string | Prunes and returns current head, creating a scope if needed. Capture alongside application snapshot in the same consistent critical section. |
| subscribe(scope,cursor?) → HistorySubscription | Synchronously prunes, validates position, captures watermark and registers live listener with queued hello/replay/ready. No cursor means origin; expired origin also requires resync. |
| disconnect(scope?) → void | Closes selected/all live subscriptions; retained events and scope entries remain. |
| stats() → StoreStats | Prunes, then returns streams, retainedEvents, retainedBytes, subscribers. Does not report OS socket memory. |

Unknown/expired cursor throws ResyncError(cursor-unavailable); replay not fitting queue throws ResyncError(replay-too-large). Stream/subscriber capacity throws an ordinary error. Size overflow throws RangeError; invalid input throws TypeError. There is no scope deletion API; recreate the store only when intentionally discarding all state.

HistorySubscription is normally obtained through subscribe, not manually constructed. It is AsyncIterable<string> of encoded frames; watermark and after are readonly. queuedFrames/queuedBytes and error expose queue diagnostics. close() detaches and discards unread frames; iterator.return() does the same. onFailure(listener) returns unsubscribe and invokes immediately for an already failed subscription. fail(error) terminates/discards/detaches and notifies observers; observer exceptions do not roll back append. enqueue(wire) is public for the reference writer/heartbeat path: it accepts already-encoded frames, does not validate application payloads, and fails a slow subscriber on overflow. Applications should append through the store instead of injecting frames. Its constructor depends on an internal queue type; direct construction is not a supported application integration path.

### NodeRelayOptions and host responsibilities

| Field | Default / contract |
|---|---|
| store | Required MemoryEventStore. |
| authenticate(request) | Required sync/async accountId or undefined; no account means HTTP401. Derive identity from verified credentials, not request account query/header. |
| stream(request) | Required synchronous streamId selector, validated with authenticated account. |
| authorize(accountId,streamId,request) | Optional sync/async boolean. If absent, authenticated accounts may access the stream selected by stream(). false returns403. |
| heartbeatMs | 15000; integer1–2147483647. Keep below client idleTimeoutMs. |
| maxDrainWaitMs | 5000; integer1–2147483647. Bound each wait for socket drain. |

createNodeRelay returns an async (IncomingMessage,ServerResponse) handler. Host mounts route, supplies TLS, CORS allowlists, auth, request/proxy timeouts and buffering policy. It handles GET only (405 with Allow otherwise), auth (401/403), invalid request (400), unavailable cursor/replay capacity (409), other pre-header failure (503). Successful headers include text/event-stream, X-Relay-Protocol:1, no-cache/no-transform and X-Accel-Buffering:no. These are hints; configure actual proxy buffering and compression explicitly. Browser cross-origin clients need appropriate CORS and exposed X-Relay-Protocol; allow Authorization, DPoP and Last-Event-ID when used; expose DPoP-Nonce and WWW-Authenticate for DPoP challenges.

Heartbeat frames share the bounded writer/drain loop. Resync after headers is sent as a control only when the socket is writable; blocked or broken sockets are destroyed. Reconnect then validates retention again. close/error removes the subscription, listeners and timer. Authenticate/authorize promises have no library deadline or AbortSignal parameter: the host must bound external auth work; a closed response is rechecked after awaited hooks. [Actual server demo](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs).

## Protocol, examples and troubleshooting

The complete ordering and wire contract is [protocol v1](../PROTOCOL.md), also available [in Russian](../PROTOCOL.ru.md). The [guide](guide.en.md) provides checked client/store/auth/stop/server/snapshot examples. The [failure demo](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/demo.js) shows actual replay and recovery; source links refer to the public repository files.

| Symptom | Check |
|---|---|
| failed after several successful reconnects | maxAttempts counts total connections. Create a fresh session deliberately; do not silently create infinite retries. |
| Server rejects a small payload as too large | maxEventBytes includes id/event/data framing and UTF-8 expansion. |
| Heartbeats arrive but handler is stuck | Idle timeout observes bytes, not handler execution. Add cancellation/time bounds to business work. |
| Old scopes exhaust capacity | Empty stream entries remain; this is a bounded reference store, not an unbounded tenant registry. |
| Logout rejects / old cursor remains in storage | Handle clear failure before claiming account cleanup or reusing scope. |
| New client without cursor returns resync | Origin was pruned; fetch initial application snapshot. It never silently starts at latest. |

[← Documentation](../index.md) · [Guide](guide.en.md) · [Русский](reference.ru.md)
