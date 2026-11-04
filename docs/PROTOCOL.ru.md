# Протокол восстановления v1

[← Документация](index.md) · [English](PROTOCOL.md) · [Справочник 0.1.0](v0.1.0/reference.ru.md)

## Scope и порядок

Поток определяется парой accountId/streamId. Сервер аутентифицирует аккаунт; query/header с желаемым аккаунтом не заменяет credentials. Клиент сверяет scope до вызова обработчика. Курсор — непрозрачные 1–1024 печатных ASCII-символа без пробелов, допустимые только для этой пары; он не является секретом авторизации.

Retained log задаёт полный порядок событий внутри scope. У каждого прикладного события уникальный id-курсор, event-тип и строковое data. Типы с relay- зарезервированы. Клиент не сравнивает курсоры численно/лексикографически. Last-Event-ID содержит последний успешно обработанный и сохранённый cursor.

Без cursor запрашивается origin журнала. Если origin уже не покрывается retention, нужен resync: нельзя молча начать с latest. Для существующего снимка приложение передаёт соответствующий cursor и отвечает за согласованность этой пары.

## HTTP и кадры

GET с Accept:text/event-stream и необязательным Last-Event-ID. Успех требует HTTP200, Content-Type:text/event-stream, X-Relay-Protocol:1 и body.

1. relay-hello без id: JSON `{ protocol: 1, scope, after, watermark }`, до прикладных событий.
2. Прикладные кадры с собственными непустыми id/event/data идут по retained-порядку до зафиксированного watermark.
3. relay-ready без id: JSON `{ scope, watermark }`, после всех replay events, до всех последующих live events. Ещё одно прикладное событие после достижения watermark, но до ready, — ошибка протокола, не передаётся handler. Control не является checkpoint.
4. Live-события продолжают тот же порядок. Комментарии могут поддерживать соединение; SSE retry принимается как ограниченная подсказка задержки.
5. relay-resync с JSON `{ reason }` после hello завершает сессию, если history/queue не позволяют продолжить.

HTTP409/410 требует resync. HTTP401 может вызвать refreshAuth один раз для запроса; успешный refresh расходует общий retry budget. HTTP403 завершает authentication failure,204 — штатное закрытие. Network/408/429/5xx и EOF допускают bounded retry. Иные статусы и неверный протокол завершаются ошибкой.

## Граница подтверждения

Клиент ждёт handler, затем checkpoint.save; только после обоих обновляет committedCursor и bounded duplicate set. Ошибка handler/save закрывает текущую попытку и повторяет с предыдущего подтверждённого cursor. Если эффект уже произошёл, а save не удался, эффект может повториться. Обработчик обеспечивает идемпотентность или транзакционную дедупликацию по scope+cursor.

At-least-once ограничено сохранённой историей, бюджетом попыток и успешной политикой восстановления приложения. Нет exactly-once effects или бесконечной eventual delivery. При потере retention безопасен snapshot/resync. Duplicate cache включает только подтверждённые ID текущей сессии, ограничен и не сохраняется; он не заменяет бизнес-идемпотентность. Подтверждённый duplicate пропускается без движения курсора назад.

## Жизненный цикл и отмена

idle → connecting → replaying → live; перед повтором возможны waiting/authenticating. resync/failed/closed — terminal; для новой сессии нужен новый SseRelayClient.

Ожидание headers по умолчанию 10 с, отсутствие body-байтов 45 с. Heartbeat/comment обновляет byte-idle; EOF останавливает его, пока полученная очередь обрабатывается. Таймеры — целые до 2147483647 мс, ноль разрешён только reconnect delays. Бюджет считает все соединения одной сессии и не сбрасывается после успеха. Таймеры не прерывают произвольные promises URL/header/handler/store/auth.

Stop отменяет fetch/timers и предотвращает последующие handlers. Текущий handler получает отменённый session signal и сам останавливает свою работу. Logout ждёт завершения операции перед clear checkpoint. Custom store проверяет сигнал до commit и завершает promises. Отмена не откатывает уже выполненную запись некооперативного адаптера.

Store предполагает одного writer на scope. Перед переиспользованием ждите logout; вкладки координируются снаружи. Сохранённый cursor не содержит application state: восстановите согласованное состояние либо снимок до resume пустого представления. После async boundaries клиент снова проверяет signal перед handler/save. Headers вычисляются на каждый запрос; redirects запрещены.

## Replay/live и ограничения reference relay

MemoryEventStore.subscribe синхронно делает prune, проверяет cursor, фиксирует watermark, регистрирует bounded subscriber и добавляет hello/replay/ready без await. Последующие append попадают после watermark. Так устраняется разрыв между отдельным чтением history и подпиской на live.

Два relay могут использовать один объект MemoryEventStore: это failover внутри одного процесса, не distributed persistence, consensus или сохранность после restart. Внешняя production-реализация обязана обеспечить такую же атомарную subscribe/replay границу. Текущий NodeRelayOptions требует именно MemoryEventStore, отдельного durable adapter port нет.

Retention ограничивается числом, возрастом, общими wire-байтами и количеством scope. Пустые scope entries не удаляются автоматически. Ограничены subscriber count, очереди, event size и socket drain wait. Слишком большой replay/медленная подписка требуют resync. Close удаляет непрочитанные frames и queue accounting, но не retained history. Heartbeat проходит тот же bounded drain loop; overflow при заблокированном сокете уничтожает его вместо отправки недоставляемого control. После reconnect retention проверяется заново.

Client limits учитывают raw frame bytes, parsed queue count и UTF-8 data/id/event bytes, а также duplicate history. Активный handler frame, parser frame, browser/OS buffers и копии приложения — дополнительные. Frame/queue overflow возвращает resync вместо молчаливой потери событий.

Сервер host задаёт TLS, CORS, auth, proxy buffering/timeouts. Heartbeat должен приходить чаще client idle timeout. Заголовки против buffering — подсказки, не гарантия конфигурации reverse proxy. [Точные параметры и значения](v0.1.0/reference.ru.md).

[← Документация](index.md) · [English](PROTOCOL.md)
