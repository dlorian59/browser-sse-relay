import { createJsonRelay, RelayProfiles } from '@59alex/browser-sse-relay';

export interface OrderNotice { key: string; text: string }
export function decodeOrderNotice(value: unknown): OrderNotice {
  // These are your business fields; invalid messages must not advance the cursor.
  // Это бизнес-поля приложения; неверное сообщение не должно продвигать курсор.
  if (!value || typeof value !== 'object' || !('key' in value) || !('text' in value)
      || typeof value.key !== 'string' || !value.key || typeof value.text !== 'string') {
    throw new TypeError('Invalid order notification');
  }
  return { key: value.key, text: value.text };
}
export function watchOrderUpdates(accountId: string, authenticatedFetch: typeof fetch,
  applyNotice: (notice: OrderNotice, signal: AbortSignal) => void | Promise<void>) {
  // Reuse the application's authenticated transport; the relay owns reconnect and checkpoint ordering.
  // Используем авторизованный транспорт приложения; relay управляет повторами и порядком checkpoint.
  return createJsonRelay({
    ...RelayProfiles.NOTIFICATIONS,
    scope: { accountId, streamId: 'notifications' },
    url: '/api/events', fetch: authenticatedFetch,
    decode: decodeOrderNotice,
    onData: (notice, context) => applyNotice(notice, context.signal),
  });
}
// Start the returned session once; stop it with the page, or await logout before discarding account state.
// Запустите сессию один раз; остановите вместе со страницей или дождитесь logout перед удалением данных аккаунта.
