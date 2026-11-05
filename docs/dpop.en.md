# DPoP: a notification stream bound to the browser's key

[← Documentation](index.md) · [Guide 0.1.0](v0.1.0/guide.en.md#retry-and-authentication) · [Русский](dpop.ru.md) · [README](../README.md)

A support dashboard keeps its notification stream open while users work. Reconnect needs a current credential, a fresh proof and the last committed cursor. `createDpopFetch` supplies the proof and handles the server nonce; the relay continues to own replay and checkpoints. Your application supplies its OAuth session, not handwritten headers on every retry.

DPoP still sends the access token in `Authorization: DPoP …`, alongside the signed `DPoP` header. It binds the token to a public key; it does not hide the token, encrypt SSE or replace HTTPS. [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html).

## Try the complete flow

```sh
npm ci
npm test
npm run demo
```

Open the printed loopback URL. Start the stream, publish an event and disconnect: reconnect creates a new proof and resumes the processed cursor. The server challenges a missing nonce before admitting the stream. [Browser code](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/demo.js), [HTTP routes](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs), [proof verification fixture](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/dpop-auth.mjs).

The demo issues temporary opaque tokens bound to a key thumbprint. Its account-selection endpoint is deliberately open for testing: **it is not a login service or an OAuth server**. Verification is real, but token issuance and the replay store are single-process fixtures. Do not deploy those routes as authentication.

## Connect your OAuth session

Use the complete, typed [notification-session example](../examples/dpop-session.ts). It accepts the account, origin, key pair, token reader, refresh operation and business handler; it returns a normal `SseRelayClient`. Call `start()`, and await `logout()` when replacing the account. For React, pass the same adapter as `transport.fetch` in [SseRelayProvider](https://github.com/dlorian59/browser-sse-relay-react/blob/main/examples/notifications/integration.tsx).

1. Create a P-256 key with `createDpopKeyPair()` before OAuth token issuance, or reuse a compatible pair managed by your OAuth SDK. The private key is non-extractable; only the public key is exported in the proof.
2. Have the OAuth client obtain a DPoP-bound token using that key. The issuer must bind the token to the public-key thumbprint (`cnf.jkt` in a verified JWT or token-introspection result). A Bearer token does not become bound by changing its header prefix.
3. Supply that pair and the current access-token reader to `createDpopFetch({ keyPair, getAccessToken, origin })`. Inject the result through `RelayOptions.fetch`. No token goes into the URL.
4. Refresh with the **same key**, using your OAuth client's token-endpoint flow. `refreshAuth` returns whether refresh succeeded. Resource-server and authorization-server nonces are different contexts; this adapter handles only resource GET requests.
5. On logout, stop/await the relay, clear application state and the relevant checkpoint, then revoke/clear your OAuth session according to application policy. The adapter does not own tokens or persisted keys.

The integration example does not perform OAuth discovery, login, refresh-token storage or token-endpoint nonce handling. `createDpopProof` is available for SDK integrations, but a complete OAuth client remains responsible for those flows.

## Public API

| API | Contract |
|---|---|
| `createDpopKeyPair()` | Promise of an ES256/P-256 CryptoKeyPair; private key is non-extractable. Requires WebCrypto in a secure context. |
| `getDpopThumbprint(keyPair)` | SHA-256 JWK thumbprint of the public key, encoded base64url; not an identity or proof of login. |
| `createDpopProof({keyPair,url,method,accessToken?,nonce?})` | Fresh signed JWT: typ dpop+jwt, alg ES256, public jwk, random jti, iat, htm, htu. URL query/fragment are excluded; ath is included when a token is supplied. Token-endpoint use omits accessToken/ath. |
| `createDpopFetch({keyPair,getAccessToken,origin,fetch?})` | A fetch-compatible **GET-only** adapter. Relative URLs resolve against the supplied origin. It owns Authorization/DPoP, rejects redirects, URL credentials, other origins and insecure non-loopback URLs. |
| `getAccessToken(signal)` | Sync/async current token, called for each HTTP attempt; check cancellation and settle pending work. |
| `fetch` option | Optional underlying transport, useful for instrumentation and tests. It must honor the request, AbortSignal and redirect policy. Do not pass the adapter to itself. |

One wrapper owns one trusted origin and its current resource nonce. Keep it for a session; for failover to another trusted origin, create a separate adapter and explicitly route to it. Its token reader/key must belong to the same account as the relay scope. The server derives identity from the verified token, never from the requested scope alone.

A response may supply `DPoP-Nonce`. Only `401` with a DPoP `use_dpop_nonce` challenge and a usable nonce triggers an immediate retry, at most once per adapter call. The challenged body is cancelled; the retry obtains the current token and creates a new proof/jti. A second challenge is returned to the caller. An ordinary 401 goes through the relay's existing `refreshAuth` handling. The adapter never falls back to Bearer. The relay's connection budget still bounds repeated failures.

The wrapper is intentionally GET-only. For business commands and uploads, use an OAuth HTTP client whose retry policy respects their side effects and streaming body lifetime. `createDpopProof` can sign those requests without automatically replaying them.

## What the resource server must enforce

- Verify access-token trust, issuer, audience, expiry and account identity using your OAuth stack. Read `cnf.jkt` only from a verified token or authenticated introspection response.
- Verify the proof signature and allowed algorithm/public key, typ, method, exact externally visible target URI without query/fragment, bounded iat, token hash (`ath`), key-thumbprint binding and nonce policy. Validate before subscribing or performing effects.
- Reject reused proof IDs within the acceptance window. Across replicas, use an atomic shared replay store keyed by key thumbprint and jti; retain entries for the full accepted proof lifetime. Fail closed on capacity/unavailability. A per-process map is insufficient across replicas.
- Close streams at the validated access-token expiry and define revocation behavior for already-open connections. Proof checking at connection establishment does not continuously revalidate an open SSE stream.
- Establish a trusted reverse-proxy boundary. Do not build the proof target from arbitrary client-supplied forwarded headers. The demo uses known listener origins.

`createNodeRelay.authenticate` remains an application hook. Run middleware that can send nonce challenges **before** calling the relay, then pass the verified account into `authenticate`. The local [server](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs) demonstrates this order and expiry cleanup. No production OAuth verifier is exported by this package.

For cross-origin browsers, allow the exact application origin and request headers `Authorization`, `DPoP`, `Last-Event-ID`, `Accept`; expose `X-Relay-Protocol`, `DPoP-Nonce`, `WWW-Authenticate` (and `Retry-After` if used). OPTIONS preflight must not require a proof. Credentialed cookies require separate matching CORS policy.

## Key lifetime and limits

The helper creates keys in memory; it does not silently persist them. An application may store a non-extractable CryptoKey through IndexedDB structured cloning if supported by its browsers and security policy. Key storage, multi-tab coordination and rotation belong to the OAuth session layer. A new key requires newly bound tokens; do not reuse old tokens with it.

Non-extractability reduces token-and-key exfiltration but does not stop active XSS from asking WebCrypto to sign requests. Use HTTPS; loopback HTTP is only for local development. Keep tokens and proofs out of logs. DPoP does not sign query parameters or request bodies and does not provide business-command idempotency. Existing replay/checkpoint delivery limits remain unchanged.

| Symptom | Check |
|---|---|
| Repeating 401 | Is the token actually DPoP-bound to this key? Verify issuer/audience/expiry and refresh with the same key. |
| Nonce retry never occurs | Expose DPoP-Nonce and WWW-Authenticate through CORS; send the DPoP use_dpop_nonce challenge. |
| Correct key, invalid proof | Check clock skew, method and public URL scheme/host/port/path at the trusted proxy boundary. |
| Works until reload | Restore the OAuth session's key or obtain a new token bound to a new key. Restore application state with its cursor too. |
| Proof replay rejected | Generate a proof for every request; never cache signed headers. |
| POST rejected by adapter | Use the GET adapter for SSE; use an appropriate command client for POST. |

[← Guide 0.1.0](v0.1.0/guide.en.md#retry-and-authentication) · [Русский](dpop.ru.md) · [README](../README.md)
