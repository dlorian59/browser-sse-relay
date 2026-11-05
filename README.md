# browser-sse-relay

<details name="readme-language">
<summary><picture><source media="(prefers-color-scheme: dark)" srcset="assets/lang-en-dark.svg"><img src="assets/lang-en-light.svg" width="42" height="26" alt="EN"></picture></summary>

SSE delivery for dashboards, order tracking and notifications. It reconnects from the last **successfully processed** event, so a temporary network failure does not silently move the application past unfinished work.

Use it when your server retains events and supports the relay protocol. It is a browser transport, not an event database or an OAuth server.

## Get started — your existing TypeScript application

Add this dependency to your project's `package.json`:

```json
{ "dependencies": { "@59alex/browser-sse-relay": "0.1.0" } }
```

Coordinates identify the current source version; npm publication is still pending. Your artifact source must provide this version.

Copy this module into `src/orders/order-updates.ts`. Pass your existing authenticated fetch and the action that applies an order notification:

```ts
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
```

Call `start()` on the returned session when the view opens; call `stop()` when it closes. The server endpoint is `/api/events`, the stream is `notifications`, and payloads contain `key` and `text`. Account identity must match the verified server session.

[Full module and walkthrough](docs/integration.en.md) · [DPoP](docs/dpop.en.md) · [React](https://github.com/dlorian59/browser-sse-relay-react)

## What you can do

- **Receive typed business events:** `createJsonRelay({ decode, onData, ... })` parses JSON and waits for your handler before saving its position. [Order workflow](docs/integration.en.md#receive-orders).
- **Start with sensible limits:** `...RelayProfiles.NOTIFICATIONS` or `...RelayProfiles.LIVE_FEED` supplies named timeout, retry and queue settings. [Choose a profile](docs/integration.en.md#profiles).
- **Reconnect with key-bound authentication:** `fetch: createDpopFetch(session)` creates fresh proofs and handles a nonce challenge. [OAuth integration](docs/dpop.en.md).
- **Stop safely:** `client.stop()` aborts the stream; `await client.logout()` also clears its checkpoint after work settles. [Lifecycle](docs/integration.en.md#lifecycle).
- **Recover expired history:** inspect the `resync` result and resume from a matching snapshot/cursor. [Recovery](docs/v0.1.0/guide.en.md#snapshot-after-resync).

## Learn more

[Guided integration](docs/integration.en.md) → [Detailed behavior](docs/v0.1.0/guide.en.md) → [API reference](docs/v0.1.0/reference.en.md). [Versions and languages](docs/index.md) · [Develop/run examples](CONTRIBUTING.md).

Effects can repeat after checkpoint failure: business handlers must tolerate retries. The Node relay is a bounded in-memory reference, not durable distributed storage. No exactly-once promise. MIT licensed; see [LICENSE](LICENSE).

</details>

<details name="readme-language" open>
<summary><picture><source media="(prefers-color-scheme: dark)" srcset="assets/lang-ru-dark.svg"><img src="assets/lang-ru-light.svg" width="42" height="26" alt="RU"></picture></summary>

Доставка событий для панелей управления, состояния заказов и уведомлений. После обрыва соединение продолжается с последнего **успешно обработанного** события: приложение не пропускает работу, которую ещё не завершило.

Подходит, если сервер хранит события и поддерживает протокол relay. Это браузерный транспорт; он не заменяет базу событий и сервер авторизации.

## Get started — существующее приложение TypeScript

Добавьте зависимость в `package.json` своего проекта:

```json
{ "dependencies": { "@59alex/browser-sse-relay": "0.1.0" } }
```

Координаты соответствуют текущим исходникам; публикация в npm ещё не выполнена. Эта версия должна быть доступна из вашего источника пакетов.

Поместите модуль в `src/orders/order-updates.ts`. Передайте готовый авторизованный fetch приложения и действие, применяющее уведомление о заказе:

```ts
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
```

Вызовите `start()` у возвращённой сессии при открытии экрана, `stop()` — при закрытии. Endpoint сервера — `/api/events`, поток — `notifications`, поля сообщения — `key` и `text`. Аккаунт должен соответствовать проверенной серверной сессии.

[Полный модуль и разбор](docs/integration.ru.md) · [DPoP](docs/dpop.ru.md) · [React](https://github.com/dlorian59/browser-sse-relay-react)

## Возможности

- **Получать бизнес-события:** `createJsonRelay({ decode, onData, ... })` разбирает JSON и сохраняет позицию только после завершения обработчика. [Сценарий заказов](docs/integration.ru.md#receive-orders).
- **Выбрать готовые настройки:** `...RelayProfiles.NOTIFICATIONS` или `...RelayProfiles.LIVE_FEED` задаёт именованные тайм-ауты, повторы и ограничения очереди. [Выбор профиля](docs/integration.ru.md#profiles).
- **Подключаться с привязанным к ключу токеном:** `fetch: createDpopFetch(session)` создаёт новый proof и обрабатывает nonce сервера. [Интеграция OAuth](docs/dpop.ru.md).
- **Остановить работу:** `client.stop()` отменяет поток; `await client.logout()` дополнительно удаляет checkpoint после завершения текущей работы. [Жизнь сессии](docs/integration.ru.md#lifecycle).
- **Восстановить данные после удаления истории:** результат `resync` требует согласованного снимка и курсора. [Восстановление](docs/v0.1.0/guide.ru.md#snapshot-after-resync).

## Освоение

[Пошаговая интеграция](docs/integration.ru.md) → [Подробное поведение](docs/v0.1.0/guide.ru.md) → [Справочник API](docs/v0.1.0/reference.ru.md). [Версии и языки](docs/index.md) · [Разработка и запуск примеров](CONTRIBUTING.md).

При ошибке сохранения checkpoint действие может повториться: бизнес-обработчик должен это учитывать. Node relay — ограниченный журнал в памяти для примера, а не распределённое долговечное хранилище. Гарантия exactly-once не заявляется. Лицензия MIT: [LICENSE](LICENSE).

</details>
