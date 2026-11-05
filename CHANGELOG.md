# Changelog

[← Back to repository README / Назад к README библиотеки](README.md)

## Integration API update — 2026-11-05

- Add `createJsonRelay`, `jsonEventHandler` and named `RelayProfiles`, preserving processing/checkpoint ordering and bounded retries.
- Export the existing `validateCursor` for validating application snapshots before applying state.
- Make the bilingual README an existing-project integration entry; move development commands to CONTRIBUTING and add an order-notification walkthrough and complete module.

## Source update — 2026-11-05

- Add optional RFC 9449 DPoP proof helpers and a GET-only fetch adapter: non-extractable P-256 keys, per-request proof, trusted-origin checks, one nonce challenge retry and cancellation.
- Replace simple Bearer demo authentication with key-bound synthetic sessions and actual signature/token binding/replay checks; close streams at token expiry. The demo is not a production OAuth service.
- Add bilingual setup/server guidance and a typed integration example; keep existing generic transport, replay and checkpoint contracts.
- Registry publication is unchanged; this is an update to the unpublished 0.1.0 source.

## 0.1.0 — 2026-10-24

Initial source implementation; npm publication is pending.

- Add a framework-independent fetch SSE client with awaited handler/checkpoint commits, scoped persistence, bounded retries, token refresh and cancellation.
- Add protocol v1 controls for deterministic replay/live boundaries and explicit resynchronization.
- Reuse eventsource-parser 4.1.2 with streaming UTF-8 decoding and byte bounds.
- Add a bounded in-memory Node reference store and HTTP relay. Two listeners can share the same store in one process.
- Add a runnable failure demo, Node tests, headless Chromium scenarios and a clean-consumer package check.
- Document version 0.1.0 in English and Russian, including TypeScript 5.9.3, ES2022 output, runtime requirements and reliability limits.

Source review corrections:

- Preserve received backlog after EOF; reject application frames across an unconfirmed replay/live boundary.
- Release external signal listeners and unread subscription queues on explicit stop/close.
- Apply drain deadlines to heartbeats and destroy undrainable sockets on overflow.
- Avoid allocating stream capacity for rejected subscriptions; reject platform timer overflow.
- Restore matching demo state after reload; use memory checkpoints with memory-only guide state.
- Verify bilingual README/guide examples against packaged declarations and add regression coverage.

No durable distributed store, cross-tab ownership coordination or production application integration is included.

[← Back to repository README / Назад к README библиотеки](README.md)
