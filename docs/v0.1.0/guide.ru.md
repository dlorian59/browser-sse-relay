# browser-sse-relay 0.1.0 — руководство

[← Back to documentation and versions / Назад к документации и версиям](../index.md)

[English](guide.en.md) · [Русский](guide.ru.md) · [Выбор версии](../index.md) · [README репозитория](../../README.md)

[Полный API и значения по умолчанию](reference.ru.md)

## Назначение

Библиотека нужна, когда после обрыва следует продолжить с последнего обработанного приложением события, а не с последнего полученного транспортом кадра. Сервер должен соблюдать [протокол v1](../PROTOCOL.md), хранить историю и предоставлять согласованный snapshot, если обычное восстановление уже невозможно.

| Задача | API |
|---|---|
| Сначала обработать, затем сохранить курсор | SseRelayClient.onEvent и CheckpointStore |
| Повторить запрос со свежей авторизацией | createDpopFetch, refreshAuth, настройки retry |
| Разделить аккаунты и потоки | StreamScope и scoped-ключи checkpoint |
| Остановить сессию и очистить состояние аккаунта | stop(), терминальный результат start(), logout() |
| Восстановиться через другой reference relay | MemoryEventStore и createNodeRelay |
| Продолжить после истечения истории | Результат resync и initialCursor из snapshot |
| Ограничить память и ожидание | Лимиты кадров, очередей, дублей, истории и тайм-ауты |

## Практический сценарий: панель переживает обрыв соединения

Задача: панель показывает накопленный счётчик конкретного аккаунта. После разрыва нужно продолжить с успешно обработанной позиции; если история уже удалена, согласованный снимок сервера восстанавливает недостающие данные.

Конфигурация: выполните `npm ci`, затем `npm run demo`. Loopback-пример создаёт два HTTP relay с общим ограниченным журналом в памяти. Синтетический токен и проверки CORS показывают подключение транспорта, но не заменяют production-аутентификацию. Сервер — [demo/server.mjs](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs); обработчик, checkpoint и восстановление — [demo/demo.js](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/demo.js). Комментарии объясняют ключевые шаги на английском, затем на русском.

Результат: Start → Publish → Disconnect/replay сохраняет актуальное значение. Ошибка checkpoint демонстрирует возможный повтор эффекта. Offline + expire history приводит к resync. Apply snapshot + resume сначала применяет значение счётчика, затем соответствующий курсор. При reload сохранённый курсор также вызывает получение снимка: localStorage хранит позицию, а не состояние страницы в памяти.

Для React-панели уведомлений отдельная [интеграция browser-sse-relay-react](https://github.com/dlorian59/browser-sse-relay-react) предоставляет provider, hook и доступный компонент статуса поверх того же протокола. Репозиторий опубликован; npm-релиз пока не выполнялся. В соседнем checkout файлы examples/notifications/main.tsx и server.mjs показывают уведомления по аккаунтам, StrictMode, logout и snapshot recovery. Стандартный checkpoint живёт вместе с provider/scope; пользовательское постоянное хранилище по-прежнему требует соответствующего состояния приложения.

Граница: relay-пример работает в одном процессе, без durable/distributed storage. Production-снимку нужны согласованные состояние/курсор и авторизованный аккаунт. Идемпотентность и надёжное выполнение бизнес-эффектов задаёт приложение.

<a id="language-and-runtime"></a>
## Язык и среда выполнения

Версия 0.1.0 использует TypeScript 5.9.3 со strict mode, exact optional properties и проверкой индексного доступа. Интерфейсы, readonly-контракты событий и scope, а также union-типы состояний выявляют ошибки при компиляции, но не создают авторизацию во время выполнения. Результат сборки — ES2022 ESM и декларации типов, без CommonJS-бандла.

Во время выполнения используются стандартные механизмы: async/await, optional chaining, nullish coalescing, Map/Set, потоковый fetch, ReadableStream reader, TextDecoder, Headers и AbortController/AbortSignal. Нет декораторов TypeScript, preview API и привязки к lifecycle фреймворка. Поля private в TypeScript — ограничение компилятора, а не граница безопасности.

Для эталонного Node-сервера и инструментов разработки нужен Node 22.12+. Локальные проверки выполнены на Node 24.21.0 и headless Chromium 156.0.8078.4. Firefox, WebKit и старые браузеры не проверены. Потребителю в браузере нужны перечисленные API и сборщик с поддержкой ESM либо import map. В демо import map уже настроен.

## Установка проверенного локального пакета

```sh
npm ci
npm test
npm run test:package
npm install /path/to/output/59alex-browser-sse-relay-0.1.0.tgz
```

Проверка пакета создаёт чистый consumer, проверяет оба export path и декларации TypeScript, затем обрабатывает событие через настоящий HTTP SSE. Это не публикация в npm. Перед выпуском ещё нужно подтвердить доступ к npm и владение именем пакета.

<a id="process-and-checkpoint"></a>
## Обработка и checkpoint

Браузерный пример для потока счётчика. Endpoint должен отправлять управляющие кадры протокола v1 и JSON-события с числовым полем value. Scope должен соответствовать авторизованному аккаунту, а не произвольному идентификатору из пользовательского ввода.

```ts
import { SseRelayClient, MemoryCheckpointStore } from '@59alex/browser-sse-relay';

const scope = { accountId: 'account-42', streamId: 'counter' };
const checkpoint = new MemoryCheckpointStore();
let counter = 0;

const options = {
  scope,
  url: '/api/events?stream=counter',
  checkpoint,
  async onEvent(event, context) {
    context.signal.throwIfAborted();
    const payload = JSON.parse(event.data);
    if (typeof payload.value !== 'number' || !Number.isFinite(payload.value)) {
      throw new Error('Invalid counter payload');
    }
    counter = payload.value; // Repeating this assignment is idempotent.
    // Повторное присваивание этого значения идемпотентно.
  },
} satisfies import('@59alex/browser-sse-relay').RelayOptions;

let client = new SseRelayClient(options);
const finished = client.start();
```

Счётчик и checkpoint в примере живут столько же, сколько страница. При использовании LocalStorageCheckpointStore сначала восстановите соответствующее состояние приложения либо установите новый согласованный snapshot. Один сохранённый курсор не восстановит обнулённый счётчик в памяти.

Наблюдаемая последовательность: завершение обработчика → завершение checkpoint.save → изменение committedCursor. Пока оба этапа не закончились, reconnect использует предыдущий курсор. Если присваивание успешно, а сохранение checkpoint завершилось ошибкой, то же событие может обработаться ещё раз. Для своих эффектов используйте идемпотентность или транзакционную дедупликацию; checkpoint браузера не может атомарно подтвердить отдельный побочный эффект в backend.

Окно дедупликации содержит только успешно подтверждённые ID текущей сессии и имеет ограниченный размер. Оно не долговечное. Новая сессия после сбоя может повторить эффект. Ошибки хранилища расходуют ограниченный бюджет повторов, а не игнорируются.

Без адаптера курсор живёт только в экземпляре клиента. В примере MemoryCheckpointStore хранит общий курсор в памяти процесса. LocalStorageCheckpointStore сохраняет только курсор, а не состояние приложения. Свой адаптер реализует load(scope, signal), save(scope, cursor, signal) и clear(scope, signal). Проверяйте отмену непосредственно перед сохранением и завершайте все Promise. Не разрешайте двум сессиям одновременно записывать checkpoint одного scope; перед повторным использованием дождитесь logout. Координация владельцев между вкладками не входит в библиотеку.

<a id="retry-and-authentication"></a>
## Повторы и авторизация

Для защищённого потока уведомлений используйте DPoP-токен своего OAuth-провайдера. Адаптер подписывает каждый GET тем же ключом, с которым получен токен; при проверке привязки сервером одного скопированного токена недостаточно. [Настройка, серверные проверки и диагностика](../dpop.ru.md) · [Код интеграции](../../examples/dpop-session.ts).

```ts
import { createDpopFetch, type RelayOptions } from '@59alex/browser-sse-relay';

export function authenticatedClient(
  keyPair: CryptoKeyPair,
  readAccessToken: (signal: AbortSignal) => string | Promise<string>,
  refreshAccessToken: (signal: AbortSignal) => boolean | Promise<boolean>,
) {
  // The OAuth client must obtain and refresh tokens using this same key.
  // OAuth-клиент должен получать и обновлять токены с тем же ключом.
  const authentication = {
    fetch: createDpopFetch({ keyPair, origin: location.origin, getAccessToken: readAccessToken }),
    refreshAuth: ({ signal }) => refreshAccessToken(signal),
    retry: { maxAttempts: 8, minDelayMs: 250, maxDelayMs: 10000, jitter: 0.2 },
    connectTimeoutMs: 10000,
    idleTimeoutMs: 45000,
  } satisfies Partial<RelayOptions>;
  return new SseRelayClient({ ...options, ...authentication });
}
```

Используйте возвращённый клиент вместо запуска предыдущего: у одного checkpoint scope должен быть один владелец. Передайте ключ OAuth-сессии, получение текущего токена и его обновление. Не создавайте новый ключ при каждом reconnect. `createDpopFetch` заново формирует Authorization/DPoP, обрабатывает один nonce challenge на вызов, запрещает другие origin и redirects. Адаптер принимает только GET и поэтому не повторяет потоковые загрузки или бизнес-команды.

Если адаптер вернул 401, relay вызывает настроенный `refreshAuth`. False или исключение refresh завершают авторизацию; 403 терминален. Повторные 401 расходуют конечный бюджет соединений. Одно соединение может выполнить до двух HTTP-запросов из-за nonce challenge; maxAttempts считает соединения relay, а не эти внутренние запросы, и не сбрасывается после успешной работы. Generic `headers` и cookie-based `credentials` доступны приложениям с другими контрактами авторизации.

Сетевые ошибки, тайм-ауты, HTTP 408/429 и 5xx повторяются с ограниченной задержкой и jitter. SSE retry и HTTP Retry-After ограничены заданным диапазоном. HTTP 204 штатно закрывает поток, 409/410 требует resync. Другие HTTP-ошибки и неверные управляющие кадры завершаются ошибкой. Для cross-origin сервер разрешает Authorization, DPoP и Last-Event-ID, открывает X-Relay-Protocol, DPoP-Nonce и WWW-Authenticate конкретному origin приложения.

В спокойном потоке heartbeat должен приходить чаще idleTimeoutMs. После EOF byte-idle timer останавливается, пока обрабатываются полученные события. Connect timer охватывает DPoP fetch wrapper, но получение токена должно учитывать AbortSignal и завершать promise: таймер не прерывает произвольный код приложения. То же относится к обработчикам и checkpoint adapters.

<a id="stop-and-logout"></a>
## Остановка и logout

Продолжение первого примера с активным клиентом:

```ts
client.stop();
const stopped = await client.start(); // Returns the same session promise.
// Возвращает promise той же сессии.
console.log(stopped.state, stopped.reason, stopped.cursor);

await client.logout(); // Await in-flight work, then clear this scope's checkpoint.
// Дождаться текущей работы и очистить checkpoint этого scope.
```

stop() прерывает транспорт и отложенные повторы, запрещая запуск следующего обработчика. Уже выполненный эффект текущего обработчика отменить невозможно. Такой обработчик получает отменённый signal и может проверить context.isCurrent() перед применением своего отложенного эффекта.

logout() ждёт завершения сессии, затем удаляет её scoped-курсор. Обработчик или адаптер, не завершающий свою операцию, может задержать это ожидание. Завершённый экземпляр не запускается заново: создайте новый SseRelayClient. Memory/localStorage-адаптеры используют оба поля accountId и streamId, поэтому logout одного аккаунта не стирает курсор другого.

<a id="snapshot-after-resync"></a>
## Snapshot после resync

Resync — терминальный результат, а не указание удалить курсор и начать с самого свежего события. Приложение обязано установить состояние и соответствующую позицию лога. Продолжение использует options и counter из первого примера, а также endpoint приложения, атомарно возвращающий { value, cursor, scope }.

```ts
const result = await finished;
if (result.state === 'resync') {
  const response = await fetch('/api/snapshot');
  if (!response.ok) throw new Error('Snapshot unavailable');
  const snapshot = await response.json();
  if (snapshot.scope.accountId !== scope.accountId || snapshot.scope.streamId !== scope.streamId) {
    throw new Error('Snapshot scope mismatch');
  }
  if (typeof snapshot.value !== 'number' || !Number.isFinite(snapshot.value)) {
    throw new Error('Invalid snapshot');
  }
  counter = snapshot.value; // Apply application state BEFORE committing its cursor.
  // Установить состояние приложения ДО подтверждения его курсора.
  client = new SseRelayClient({ ...options, initialCursor: snapshot.cursor });
  void client.start();
}
```

initialCursor проверяется, сохраняется и заменяет устаревший checkpoint. События между снятием snapshot и новой подпиской будут воспроизведены, если история ещё покрывает позицию. Если за время получения snapshot нужная история тоже успела истечь, потребуется новый resync; библиотека не придумывает другой курсор.

Демо получает согласованный snapshot счётчика, читая состояние и MemoryEventStore.currentCursor в одном синхронном участке JavaScript. Рабочее приложение с базой данных и логом должно обеспечить эквивалентную согласованность. Асинхронно прочитать базу, а затем отдельно запросить последний курсор лога — способ потерять события.

<a id="reference-relay-and-handoff"></a>
## Эталонный relay и граница replay/live

Эта Node-фабрика запускает два listener с одним журналом. Передайте получение проверенного аккаунта из авторизации host-приложения. Nonce middleware и закрытие по expiry до подписки показаны в полном [HTTP-примере](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs) и [требованиях к серверу](../dpop.ru.md#что-обязан-проверить-resource-server).

```ts
import { createServer } from 'node:http';
import { MemoryEventStore, createNodeRelay, type NodeRelayOptions } from '@59alex/browser-sse-relay/server';

export function startReferenceRelays(authenticate: NodeRelayOptions['authenticate']) {
  const store = new MemoryEventStore({ maxEventsPerStream: 256, retentionMs: 300000 });
  const servers = [8081, 8082].map(port => {
    const relay = createNodeRelay({
      store,
      // The host supplies an account derived from verified credentials.
      // Host передаёт аккаунт, полученный из проверенных credentials.
      authenticate,
      stream: () => 'counter',
    });
    return createServer((request, response) => { void relay(request, response); })
      .listen(port, '127.0.0.1');
  });
  return { store, servers };
}
```

subscribe синхронно проверяет позицию, фиксирует watermark, регистрирует подписчика и помещает hello/replay/ready в очередь, не отдавая управление event loop. Новые события идут после ready. Это детерминированная граница в одном процессе JavaScript. Тесты публикуют события, пока replay ещё не прочитан, и проверяют точный порядок результата.

Запрос без курсора означает чтение с начала лога. Если начало истекло, сервер требует resync, а не скрывает пропуск. Курсор непосредственно перед границей вытеснения остаётся пригодным, пока все следующие события доступны. Курсоры — непрозрачные строки printable ASCII, уникальные внутри потока; клиент не должен разбирать их или сравнивать порядок.

Два listener с общим MemoryEventStore не являются распределённым хранилищем. Перезапуск процесса уничтожает историю. Межпроцессный адаптер должен отдельно гарантировать порядок лога, атомарную подписку replay/live и долговечность; такого production-адаптера в 0.1.0 нет.

<a id="limits-and-contracts"></a>
## Лимиты и контракты

Все интервалы таймеров (соединение, простой, повторы, heartbeat и drain) ограничены 2 147 483 647 мс; ноль допустим только для задержки повторов. После EOF таймер простоя прекращается, а уже полученные события дорабатываются. Явное закрытие подписки удаляет её непрочитанную очередь, сохраняя историю. Heartbeat проходит через ту же проверку drain, что и события; при переполнении заблокированный сокет уничтожается.

```ts
const limitedClient = new SseRelayClient({
  ...options,
  limits: {
    maxFrameBytes: 65536,
    maxQueuedEvents: 128,
    maxQueuedBytes: 1048576,
    dedupEntries: 1024,
  },
});
```

Это стандартные клиентские лимиты. Размер кадра измеряется в wire bytes; размер очереди — в UTF-8 байтах data, id и типа события. Помимо очереди в памяти могут находиться один кадр текущего обработчика и ограниченный кадр парсера. Буферы браузера/ОС и копии приложения в этот расчёт не входят. Переполнение очереди и слишком большой кадр требуют resync, а не молчаливого пропуска события.

Серверные значения по умолчанию: 256 событий на поток, 300 секунд хранения, 16 MiB общей истории, 64 scope, 64 подписчика, 1024 кадра и 1 MiB очереди на подписчика, 64 KiB на прикладной кадр. Переполнение подписчика и слишком большой replay требуют resync. Сокет, который не освобождает буфер записи, закрывается через пять секунд. Если сеть уже оборвалась, доставка управляющего кадра resync не гарантируется; следующий reconnect снова проверит наличие истории.

Проверка scope не заменяет авторизацию. HTTP host определяет аккаунт и допустимые потоки, отвечает за TLS, разрешённые origins, квоты и согласованные snapshot. Транспортное подтверждение не доказывает долговечность эффекта приложения.

| Альтернатива | Когда подходит |
|---|---|
| Нативный EventSource | Стандартный SSE-транспорт браузера без владения checkpoint на уровне приложения. |
| fetch-event-source | Fetch-based SSE с настройкой ответа, заголовков и повторов; восстановление приложения и хранение позиции остаются вашей задачей. |
| browser-sse-relay | Протокол retained history, курсор после awaited handler/checkpoint, явный resync и исполняемая эталонная модель отказов. |

См. [выбор парсера](../PARSER-DECISION.md). Это не drop-in клиент произвольного SSE-endpoint без управляющих кадров протокола v1.

<a id="run-and-verify"></a>
## Запуск и проверка

```sh
npm ci
npm test
npm run demo
# Open the printed loopback URL yourself.

npx playwright install chromium
npm run test:browser
npm run test:package
```

Браузерная проверка запускается headless. Она проверяет первый checkpoint, replay через relay B после обрыва, повтор эффекта при ошибке checkpoint, терминальный resync после истечения истории, восстановление snapshot и logout без старых callback/reconnect. Версия браузера и снимок записываются в output/playwright. Проверка пакета устанавливает tarball в новый временный consumer, проверяет публичные типы и обрабатывает HTTP-событие.

Если браузер не запускается, обычно отсутствует его бинарник Playwright: выполните команду установки выше. 401 означает отказ host-аутентификации. protocol-error часто указывает на отсутствие заголовка/управляющего кадра, чужой scope, неверный формат или watermark replay. cursor-unavailable требует согласованного snapshot, а не цикла запросов без курсора. retry-exhausted требует решения приложения: клиент не переподключается бесконечно.

Оставшиеся условия выпуска: авторизация npm и владение именем, публикация в реестре, интеграция в рабочее приложение и дополнительные браузеры. [Проверки](../VERIFICATION.md) и [план](../../ROADMAP.md) отделяют проверенные исходники от опубликованных артефактов.

[← Back to documentation and versions / Назад к документации и версиям](../index.md)
