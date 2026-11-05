# DPoP: поток уведомлений, привязанный к ключу браузера

[← Документация](index.md) · [Руководство 0.1.0](v0.1.0/guide.ru.md#retry-and-authentication) · [English](dpop.en.md) · [README](../README.md)

Панель поддержки держит поток уведомлений открытым во время работы пользователя. При reconnect нужны актуальный токен, свежий proof и последний подтверждённый курсор. `createDpopFetch` формирует доказательство и обрабатывает серверный nonce; relay отвечает за replay и checkpoint. Приложение передаёт OAuth-сессию вместо ручной сборки заголовков на каждом повторе.

DPoP по-прежнему передаёт access token в `Authorization: DPoP …` вместе с подписанным заголовком `DPoP`. Он привязывает токен к публичному ключу, но не скрывает токен, не шифрует SSE и не заменяет HTTPS. [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html).

## Попробовать полный сценарий

```sh
npm ci
npm test
npm run demo
```

Откройте напечатанный loopback URL. Запустите поток, опубликуйте событие и разорвите соединение: reconnect создаст новый proof и продолжит с обработанного курсора. Если nonce отсутствует, сервер выдаст challenge перед допуском к потоку. [Браузерный код](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/demo.js), [HTTP routes](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs), [fixture проверки proof](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/dpop-auth.mjs).

Демо выдаёт временные opaque tokens с привязкой к thumbprint ключа. Выбор аккаунта намеренно открыт для проверки: **это не сервис входа и не OAuth-сервер**. Проверка подписи настоящая, но выдача токенов и replay store — fixtures одного процесса. Не используйте эти routes для production-авторизации.

## Подключить свою OAuth-сессию

В [типизированном примере уведомлений](../examples/dpop-session.ts) передаются аккаунт, origin, пара ключей, чтение токена, refresh и бизнес-обработчик; возвращается обычный `SseRelayClient`. Вызовите `start()`, при смене аккаунта дождитесь `logout()`. В React тот же адаптер передаётся как `transport.fetch` в [SseRelayProvider](https://github.com/dlorian59/browser-sse-relay-react/blob/main/examples/notifications/integration.tsx).

1. Создайте P-256 ключ через `createDpopKeyPair()` до выдачи OAuth-токена либо используйте совместимую пару своего OAuth SDK. Private key неизвлекаемый; в proof экспортируется только публичный ключ.
2. Получите DPoP-токен с этим ключом через OAuth-клиент. Issuer должен связать токен с thumbprint публичного ключа (`cnf.jkt` в проверенном JWT или ответе introspection). Замена префикса заголовка не превращает Bearer-токен в привязанный.
3. Передайте пару и чтение текущего access token в `createDpopFetch({ keyPair, getAccessToken, origin })`. Результат укажите в `RelayOptions.fetch`. Токен не попадает в URL.
4. Обновляйте токен **с тем же ключом** через token-endpoint flow вашего OAuth-клиента. `refreshAuth` сообщает успех. Nonce resource server и authorization server — разные контексты; этот адаптер обслуживает только GET к ресурсу.
5. При logout остановите relay и дождитесь завершения, очистите состояние приложения и соответствующий checkpoint, затем отзовите/удалите OAuth-сессию по правилам приложения. Адаптер не управляет токенами или постоянным хранением ключей.

Пример интеграции не реализует OAuth discovery, login, хранение refresh token или token-endpoint nonce. Для интеграций SDK доступен `createDpopProof`, но полным OAuth flow управляет отдельный OAuth-клиент.

## Публичный API

| API | Контракт |
|---|---|
| `createDpopKeyPair()` | Promise ES256/P-256 CryptoKeyPair; private key неизвлекаемый. Требует WebCrypto в secure context. |
| `getDpopThumbprint(keyPair)` | SHA-256 JWK thumbprint публичного ключа в base64url; не идентификатор пользователя и не доказательство входа. |
| `createDpopProof({keyPair,url,method,accessToken?,nonce?})` | Новый подписанный JWT: typ dpop+jwt, alg ES256, публичный jwk, случайный jti, iat, htm, htu. Query/fragment исключаются; при токене добавляется ath. Для token endpoint accessToken/ath опускаются. |
| `createDpopFetch({keyPair,getAccessToken,origin,fetch?})` | Fetch-совместимый адаптер **только GET**. Относительный URL разрешается от origin. Управляет Authorization/DPoP, запрещает redirects, URL credentials, другие origin и небезопасные non-loopback URL. |
| `getAccessToken(signal)` | Sync/async чтение текущего токена на каждую HTTP-попытку; учитывайте отмену и завершайте promises. |
| Опция `fetch` | Необязательный underlying transport для наблюдаемости/тестов. Должен соблюдать параметры запроса, AbortSignal и redirect policy. Не передавайте адаптер самому себе. |

Один wrapper принадлежит одному доверенному origin и хранит его текущий resource nonce. Сохраняйте его на время сессии; для failover на другой доверенный origin создайте отдельный адаптер с явной маршрутизацией. Ключ и токен должны принадлежать аккаунту relay scope. Сервер получает пользователя из проверенного токена, а не из запрошенного scope.

Ответ может содержать `DPoP-Nonce`. Только `401` с DPoP challenge `use_dpop_nonce` и пригодным nonce вызывает немедленный повтор — максимум один на вызов адаптера. Body отклонённого ответа отменяется; повтор читает актуальный токен и создаёт новый proof/jti. Второй challenge возвращается вызывающему коду. Обычный 401 обрабатывается существующим `refreshAuth` relay. Перехода на Bearer нет. Бюджет соединений relay ограничивает последующие повторы.

Wrapper намеренно принимает только GET. Для бизнес-команд и загрузок нужен OAuth HTTP-клиент с retry policy, учитывающей побочные эффекты и время жизни потокового body. `createDpopProof` позволяет подписать такой запрос без его автоматического повторения.

## Что обязан проверить resource server

- Доверие access token, issuer, audience, срок и пользователя через ваш OAuth stack. `cnf.jkt` берётся только из проверенного токена или доверенного introspection response.
- Подпись proof, разрешённые алгоритм/публичный ключ, typ, method, точный внешний URI без query/fragment, допустимый iat, хеш токена (`ath`), привязку thumbprint и nonce policy. Проверка выполняется до подписки и побочных эффектов.
- Повторное использование proof ID в пределах окна допустимости. Между репликами нужен общий атомарный replay store по thumbprint ключа и jti; записи хранятся весь срок допустимости proof. При переполнении/недоступности — отказ. Map одного процесса не защищает другие реплики.
- Закрытие потока по проверенному сроку access token и правила отзыва уже открытых соединений. Проверка proof при подключении не означает постоянную перепроверку SSE-потока.
- Доверенную границу reverse proxy. Нельзя собирать проверяемый URL из произвольных клиентских forwarded headers. Демо использует заранее известные origin слушателей.

`createNodeRelay.authenticate` остаётся hook приложения. Middleware с возможностью ответить nonce challenge запускается **до** relay, после чего проверенный аккаунт передаётся в `authenticate`. [Локальный сервер](https://github.com/dlorian59/browser-sse-relay/blob/main/demo/server.mjs) показывает этот порядок и закрытие по expiry. Production OAuth verifier библиотека не экспортирует.

Для cross-origin разрешите конкретный origin приложения и заголовки запроса `Authorization`, `DPoP`, `Last-Event-ID`, `Accept`; откройте `X-Relay-Protocol`, `DPoP-Nonce`, `WWW-Authenticate` (и `Retry-After`, если используется). OPTIONS preflight не должен требовать proof. Cookie credentials требуют отдельной согласованной CORS policy.

## Жизнь ключа и границы

Helper создаёт ключ в памяти, не сохраняет его автоматически. Приложение может хранить неизвлекаемый CryptoKey через structured cloning в IndexedDB, если это поддерживают целевые браузеры и политика безопасности. Хранение, согласование между вкладками и rotation относятся к OAuth-сессии. Для нового ключа нужны заново привязанные токены: прежний токен с ним не работает.

Неизвлекаемость ограничивает кражу ключа вместе с токеном, но активный XSS всё ещё может просить WebCrypto подписывать запросы. Используйте HTTPS; HTTP loopback предназначен для локальной разработки. Исключайте токены и proofs из логов. DPoP не подписывает query parameters или body и не обеспечивает идемпотентность бизнес-команд. Границы replay/checkpoint не меняются.

| Симптом | Что проверить |
|---|---|
| Повторный 401 | Действительно ли токен привязан к этому ключу? Проверьте issuer/audience/expiry и refresh с тем же ключом. |
| Нет nonce retry | Откройте DPoP-Nonce и WWW-Authenticate через CORS; сервер должен выдать DPoP use_dpop_nonce challenge. |
| Верный ключ, неверный proof | Проверьте часы, метод и внешний scheme/host/port/path на доверенной proxy boundary. |
| После reload перестаёт работать | Восстановите ключ OAuth-сессии либо получите токен для нового ключа. Вместе с курсором восстановите состояние приложения. |
| Сервер отклонил replay | Создавайте proof на каждый запрос; не кэшируйте подписанные заголовки. |
| Адаптер отклоняет POST | Используйте GET-адаптер для SSE, отдельный подходящий клиент — для команд. |

[← Руководство 0.1.0](v0.1.0/guide.ru.md#retry-and-authentication) · [English](dpop.en.md) · [README](../README.md)
