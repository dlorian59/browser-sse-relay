# Справочник API · 0.1.0 · Русский

[← Документация](../index.md) · [Руководство](guide.ru.md) · [English](reference.en.md) · [README](../../README.md)

Здесь перечислены публичные exports браузерного entry и /server. Parser, queue и функции кодирования кадров — внутренние детали, не exports пакета. Только ESM; browser entry не зависит от Node. Исходники: [клиент](https://github.com/dlorian59/browser-sse-relay/blob/main/src/client.ts), [checkpoint](https://github.com/dlorian59/browser-sse-relay/blob/main/src/checkpoint.ts), [server entry](https://github.com/dlorian59/browser-sse-relay/blob/main/src/server/index.ts).

## Browser exports и идентичность

| Export | Контракт |
|---|---|
| SseRelayClient | Одноразовая сессия. Конструктор проверяет scope, callback, cursor и числовые настройки; transport запускается через start(). |
| RelayOptions | Обязательные scope, url, onEvent и параметры ниже. |
| RelayContext | Readonly scope, AbortSignal сессии, номер попытки, isCurrent(). Проверяйте актуальность перед поздними эффектами. Signal относится ко всей сессии, не отдельному reconnect. |
| RelayResult | Readonly state: resync / failed / closed, reason:string, cursor:string либо undefined, необязательный error:unknown. Reason — диагностическая строка, не закрытый TypeScript enum. |
| RelayState | idle / connecting / replaying / live / waiting / authenticating / resync / failed / closed. |
| StreamScope | Readonly accountId и streamId: по 1–256 кодовых единиц UTF-16, U+0000–U+001F запрещены. Namespace, а не аутентификация. |
| RelayEvent | Readonly строки id, event, data. JSON автоматически не декодируется. |
| CheckpointStore | Асинхронные load/save/clear, описанные ниже. |
| MemoryCheckpointStore | Scoped map одного экземпляра; без persistence и блокировок между вкладками. |
| LocalStorageCheckpointStore | Только курсоры, переданный Storage-подобный объект; не обращается к window автоматически. |
| ProtocolError | Подкласс Error с message; некорректный протокол прекращает работу. |
| ResyncError | Подкласс Error с readonly reason; требуется восстановление состояния. |

Курсор — непрозрачная строка из 1–1024 ASCII-символов U+0021–U+007E, без пробелов. Не сортируйте курсоры, не выводите из них аккаунт и не переносите между scope. Имя события содержит 1–128 кодовых единиц UTF-16 без CR/LF/NUL; префикс relay- зарезервирован. MemoryEventStore отклоняет такие прикладные события.

## RelayOptions

| Поле | По умолчанию / обязательность | Поведение |
|---|---|---|
| scope | Обязательно | Идентичность приложения после auth; клиент копирует и замораживает объект. |
| url | Обязательно | Строка либо sync/async (context) → string, вычисляется перед каждым подключением. Допустимые динамические endpoints проверяет приложение. |
| onEvent | Обязательно | Awaited (event,context) → void/Promise<void>. Ошибка завершает попытку и вызывает retry в рамках бюджета; эффект может повториться. |
| headers | Не задано | HeadersInit либо sync/async callback; заново для каждой попытки. Accept принудительно text/event-stream, пользовательский Last-Event-ID заменяется подтверждённым курсором. |
| credentials | same-origin | Стандартный RequestCredentials. include требует согласованных серверных auth/CORS policies. |
| checkpoint | Не задано | Без store курсор всё равно хранится внутри сессии. Автоматического localStorage нет. |
| initialCursor | Не задано | Курсор уже установленного состояния. До подключения сохраняется в store вместо load; ошибка даёт initialization-failed. |
| signal | Не задано | Внешняя отмена вызывает stop; listener удаляется при stop/completion. Уже отменённый signal предотвращает работу. |
| onState | Не задано | (state,{attempt,cursor}) — диагностика. Callback синхронный: выброшенные исключения игнорируются, но возвращённые promises не ожидаются и их rejection не перехватывается. Асинхронную диагностику и её ошибки обрабатывает приложение. Это не транзакционное уведомление checkpoint. |
| refreshAuth | Не задано | Sync/async (context) → boolean после HTTP401, один вызов на запрос. true разрешает следующую попытку; false/reject заканчивает authentication-failed. |
| fetch | globalThis.fetch | Совместимая реализация fetch; буферы браузера/ОС не входят в лимиты библиотеки. |
| connectTimeoutMs | 10000 | Ожидание HTTP headers. Не ограничивает время URL/headers callbacks, handler, store или refreshAuth. |
| idleTimeoutMs | 45000 | Время без байтов body; комментарии/heartbeat его обновляют. Это не timeout обработчика. EOF останавливает таймер, пока очередь дорабатывается. |
| retry | Таблица ниже | Общий бюджет подключений, включая успешные с последующим reconnect. |
| limits | Таблица ниже | Учёт frame/queue/dedup, не всей памяти процесса. |
| random | Math.random | Для детерминированного jitter в тестах. Ожидается [0,1]; выход за границы обрезается, nonfinite заменяется 0.5. |

Запрос использует GET, redirect:error и cache:no-store. Redirect отклоняется, credentials не перенаправляются автоматически. Прикладные promises должны завершаться и учитывать отмену: abort не прерывает произвольный JavaScript и не откатывает удалённый эффект.

### Retry и лимиты

| Поле | Значение | Допустимость / смысл |
|---|---|---|
| retry.maxAttempts | 8 | Положительное safe integer; суммарные подключения сессии, без сброса при live. |
| retry.minDelayMs | 250 | Целое 0–2147483647. |
| retry.maxDelayMs | 10000 | Тот же диапазон, не меньше minDelayMs. |
| retry.jitter | 0.2 | Конечное [0,1]; множитель 1−jitter … 1+jitter, затем ограничение диапазоном задержки. |
| limits.maxFrameBytes | 65536 | Положительное safe integer; UTF-8 wire-байты между границами кадров, включая поля/комментарии. |
| limits.maxQueuedEvents | 128 | Положительное safe integer; разобранные кадры очереди, включая controls. |
| limits.maxQueuedBytes | 1048576 | Положительное safe integer; UTF-8 data+id+event в очереди. |
| limits.dedupEntries | 1024 | Неотрицательное safe integer; только успешно подтверждённые ID текущей сессии. Ноль отключает кеш. |

connectTimeoutMs/idleTimeoutMs: целые 1–2147483647. Задержка экспоненциально растёт с попыткой; Retry-After в секундах/HTTP date и SSE retry могут заменить базу, затем применяются bounds/jitter. Успешный refresh тоже расходует попытку и учитывает минимальную задержку. Активный handler frame, parser frame, буферы браузера и копии приложения не входят в queuedBytes. Переполнение frame/queue приводит к resync, а не скрытому пропуску.

## Методы, состояния и ошибки

| Член | Поведение |
|---|---|
| scope | Замороженный StreamScope. |
| state | Текущий RelayState, первоначально idle. |
| committedCursor | Последний обработанный и сохранённый cursor либо undefined. |
| dedupSize | Размер ограниченного кеша дублей сессии. |
| start(): Promise<RelayResult> | Запуск один раз; повтор возвращает тот же promise. После terminal создайте новый клиент. Обычные network/protocol/handler/store ошибки разрешают promise результатом. |
| stop(): void | Отмена transport/timers, новые handlers не начинаются. Для ожидания текущей работы await start(). До первого start предотвращает подключение. |
| logout(): Promise<void> | Stop, ожидание начатой работы, очистка cursor/cache в памяти, затем scoped store.clear со свежим signal. Ошибка clear отклоняет promise; внешний store может сохранить старый cursor. |

Переходы idle → connecting → replaying → live; retry использует waiting, HTTP401 — authenticating. resync/failed/closed терминальны. isCurrent() становится false при stop/terminal; это не распределённая блокировка.

| Причина | Результат |
|---|---|
| Stop / внешняя отмена | closed, stopped |
| HTTP204 | closed, server-closed |
| HTTP409/410 | resync, cursor-unavailable |
| relay-resync | resync с серверным reason |
| Размер кадра / очередь клиента | resync, frame-too-large / client-queue-overflow |
| Неверный protocol/header/control/boundary, прочие HTTP statuses | failed, protocol-error |
| HTTP401 без успешного refresh, HTTP403 | failed, authentication-failed |
| Network/EOF/header timeout/idle timeout/HTTP408/429/5xx/handler/save error | Retry, затем failed, retry-exhausted; error сохраняет причину для диагностики. |
| Начальный load/save, неверный сохранённый cursor, ошибка setup | failed, initialization-failed |

Исключения внутри onEvent всегда считаются handler failure: даже ProtocolError/ResyncError от приложения не обходят retry policy. Восстановление снимка выполняется отдельно: [пример](guide.ru.md#snapshot-after-resync).

## Checkpoint stores

`load(scope,signal): Promise<string|undefined>`, `save(scope,cursor,signal): Promise<void>`, `clear(scope,signal): Promise<void>`. Реализация проверяет отмену до записи и завершает pending promises. Порядок: awaited handler → awaited save → committed cursor. Надёжный эффект при неудавшемся save может повториться. Встроенные stores не координируют writers/вкладки.

MemoryCheckpointStore() создаёт пустую map; clear одного scope не меняет другой. LocalStorageCheckpointStore(storage,prefix?) принимает getItem/setItem/removeItem; prefix по умолчанию browser-sse-relay:v1:. Суффикс ключа — JSON.stringify([accountId,streamId]). Отсутствующее значение даёт undefined; неверный cursor и ошибки storage не скрываются. localStorage не является защищённым token storage, а cursor не восстанавливает бизнес-состояние. После reload нужны соответствующее состояние либо новый снимок. [Пример store](guide.ru.md#process-and-checkpoint).

## Server exports и конфигурация

/server экспортирует MemoryEventStore, HistorySubscription, createNodeRelay, HistoryOptions, StoreStats, NodeRelayOptions, типы StreamScope/RelayEvent. Это Node-only entry. В версии 0.1.0 нет подключаемого durable log port: NodeRelayOptions.store требует MemoryEventStore. Production adapter должен сохранять протокол и атомарную границу replay/live; указание имени базы в конфигурации не делает её поддерживаемой.

### HistoryOptions

Все числовые параметры — положительные safe integer; retentionMs участвует в сравнении возраста, а не setTimeout. [Исходник](https://github.com/dlorian59/browser-sse-relay/blob/main/src/server/history.ts).

| Параметр | Значение | Область / смысл |
|---|---|---|
| maxEventsPerStream | 256 | Retained count одного account/stream. |
| retentionMs | 300000 | Возраст в мс; pruning при операциях, без фонового таймера. |
| maxRetainedBytes | 16777216 | Общие UTF-8 wire-байты; старейшие события удаляются между всеми streams. |
| maxStreams | 64 | Scope entries, в том числе опустевшие; автоматически не удаляются. |
| maxSubscribers | 64 | Общее число активных подписчиков. |
| maxQueuedFrames | 1024 | На подписчика, включая hello/ready. |
| maxQueuedBytes | 1048576 | На подписчика; полные UTF-8 wire-байты с framing. |
| maxEventBytes | 65536 | Полный encoded application frame, не только JSON payload; должен помещаться в maxRetainedBytes. |
| now | Date.now | Epoch milliseconds, внедряется для детерминированных тестов retention. |

| MemoryEventStore | Поведение |
|---|---|
| append(scope,data,event='message') → RelayEvent | Строка, непрозрачный UUID cursor, синхронный commit, затем уведомление подписчиков. Медленный подписчик не откатывает producer commit. Размер/input/capacity могут дать ошибку до commit. |
| currentCursor(scope) → string | Prune и текущий head; при необходимости создаёт scope. Получать вместе со снимком в одной согласованной секции. |
| subscribe(scope,cursor?) → HistorySubscription | Синхронно prune, проверка позиции, watermark, регистрация live и очередь hello/replay/ready. Без cursor — origin; просроченный origin тоже требует resync. |
| disconnect(scope?) → void | Закрыть выбранные/все subscriptions; history и scope entries остаются. |
| stats() → StoreStats | После prune возвращает streams, retainedEvents, retainedBytes, subscribers; не включает socket memory ОС. |

Неизвестный/просроченный cursor даёт ResyncError(cursor-unavailable); слишком большой replay — ResyncError(replay-too-large). Capacity scopes/subscribers — обычная Error; размер — RangeError; input — TypeError. API удаления scope нет. Пересоздание store означает намеренную потерю всего его состояния.

HistorySubscription получают через subscribe, не создают вручную. AsyncIterable<string> выдаёт encoded frames; watermark/after readonly. queuedFrames/queuedBytes/error — диагностика. close() отсоединяет и удаляет непрочитанные кадры, iterator.return() делает то же. onFailure(listener) возвращает unsubscribe; для уже failed подписки вызывает listener сразу. fail(error) завершает очередь, отсоединяет и уведомляет observers; ошибки observers не откатывают append. enqueue(wire) публичен для reference writer/heartbeat: принимает готовые кадры без проверки прикладной схемы; overflow завершает медленного подписчика. Прикладные события добавляйте через store.append. Конструктор зависит от внутреннего queue-типа и не является поддерживаемым способом интеграции приложения.

### NodeRelayOptions и ответственность приложения

| Поле | Значение / контракт |
|---|---|
| store | Обязательный MemoryEventStore. |
| authenticate(request) | Обязательный sync/async accountId либо undefined; отсутствие аккаунта — HTTP401. Используйте проверенные credentials, не query/header с желаемым аккаунтом. |
| stream(request) | Обязательный синхронный streamId, проверяется вместе с authenticated account. |
| authorize(accountId,streamId,request) | Необязательный sync/async boolean. Без него аккаунту разрешён выбранный stream; false —403. |
| heartbeatMs | 15000, целое 1–2147483647; меньше client idleTimeoutMs. |
| maxDrainWaitMs | 5000, целое 1–2147483647; отдельное ожидание socket drain. |

createNodeRelay возвращает async (IncomingMessage,ServerResponse). Приложение задаёт route, TLS, CORS allowlists, auth, request/proxy timeouts и buffering policy. Handler принимает GET (иначе 405 с Allow), возвращает 401/403 при auth,400 при неверном запросе,409 при недоступном cursor/replay capacity,503 при иной ошибке до headers. При успехе: text/event-stream, X-Relay-Protocol:1, no-cache/no-transform, X-Accel-Buffering:no. Это подсказки: реальные proxy buffering/compression настраиваются отдельно. Для cross-origin нужны CORS, exposed X-Relay-Protocol и разрешённые Authorization/Last-Event-ID, если используются.

Heartbeat идёт через тот же bounded writer/drain loop. Resync после headers отправляется control-кадром только при доступном сокете; заблокированный/сломанный сокет уничтожается. Reconnect снова проверяет retention. Close/error удаляет subscription/listeners/timer. У authenticate/authorize нет собственного timeout и аргумента AbortSignal: приложение ограничивает внешнюю auth-работу; закрытие response проверяется после awaited hooks. [Исполняемый server demo](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs).

## Протокол, примеры и диагностика

Полный контракт: [протокол v1 на русском](../PROTOCOL.ru.md), [English](../PROTOCOL.md). [Руководство](guide.ru.md) содержит проверяемые примеры client/store/auth/stop/server/snapshot; [демо](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/demo.js) показывает replay/recovery. Ссылки на исходники относятся к файлам репозитория; при блокировке публичного аккаунта они могут быть недоступны.

| Симптом | Что проверить |
|---|---|
| failed после нескольких успешных reconnect | maxAttempts считает все подключения. Новый client создаётся явно; не вводите бесконечный скрытый retry. |
| Маленький payload не проходит размер | maxEventBytes включает framing и расширение UTF-8. |
| Heartbeat есть, handler завис | Idle timeout наблюдает байты, не выполнение handler. Бизнес-работе нужны cancellation/time bounds. |
| Старые scope исчерпали capacity | Пустые entries остаются; reference store — не неограниченный tenant registry. |
| Logout rejected / cursor остался | Обработать clear failure до подтверждения выхода или переиспользования scope. |
| Новый client без cursor получил resync | Origin удалён: нужен начальный снимок. Клиент не начинает молча с latest. |

[← Документация](../index.md) · [Руководство](guide.ru.md) · [English](reference.en.md)
