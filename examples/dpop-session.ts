import {
  createDpopFetch, MemoryCheckpointStore, SseRelayClient,
  type RelayOptions,
} from '@59alex/browser-sse-relay';

export interface NotificationSession {
  accountId: string;
  origin: string;
  keyPair: CryptoKeyPair;
  readAccessToken(signal: AbortSignal): string | Promise<string>;
  refreshAccessToken(signal: AbortSignal): boolean | Promise<boolean>;
  onEvent: RelayOptions['onEvent'];
}

export function createNotificationSession(session: NotificationSession): SseRelayClient {
  // Reuse the key that the OAuth client used when obtaining this account's token.
  // Используйте ключ, с которым OAuth-клиент получил токен этого аккаунта.
  const authenticatedFetch = createDpopFetch({
    keyPair: session.keyPair,
    origin: session.origin,
    getAccessToken: signal => session.readAccessToken(signal),
  });

  return new SseRelayClient({
    scope: { accountId: session.accountId, streamId: 'notifications' },
    url: new URL('/api/events', session.origin).href,
    fetch: authenticatedFetch,
    // Fresh proof and server nonce retries are handled by the transport.
    // Транспорт создаёт свежий proof и обрабатывает серверный nonce.
    refreshAuth: ({ signal }) => session.refreshAccessToken(signal),
    checkpoint: new MemoryCheckpointStore(),
    onEvent: session.onEvent,
  });
}

// Call start() once; await logout() before replacing this account's session.
// Вызовите start() один раз; дождитесь logout() перед заменой сессии аккаунта.
// Persisted checkpoints also require matching application state or a snapshot.
// Постоянному checkpoint также нужны соответствующее состояние приложения или снимок.
