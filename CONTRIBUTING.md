# Develop and run examples / Разработка и запуск примеров

[← README](README.md) · [Verification](docs/VERIFICATION.md)

Node 22.12+ and npm are needed for this repository's development tools. The commands below build this repository; they are not steps for adding the library to an existing application.

Для инструментов этого репозитория нужны Node 22.12+ и npm. Команды собирают саму библиотеку; это не инструкция её подключения к существующему приложению.

```sh
npm ci
npm test
npm run test:package
npm run test:browser
npm run demo
```

The loopback demo uses synthetic sessions and real DPoP verification. Production OAuth issuance and a durable retained log belong to your application. See [DPoP EN](docs/dpop.en.md) / [RU](docs/dpop.ru.md).

Демо работает на loopback с синтетическими сессиями и настоящей проверкой DPoP. Рабочий OAuth и долговечный журнал событий принадлежат приложению.
