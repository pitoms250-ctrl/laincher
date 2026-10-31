# F Launcher — Minecraft-лаунчер (.NET 8, WPF, MVVM)

Зелёный дизайн из макета «F Launcher». Solution: `MinecraftLauncher.sln` (Visual Studio 2022, Windows).

## Слои и зависимости
```
Launcher.UI  ──►  Launcher.Services ──►  Launcher.Core  ──►  Launcher.Shared
     │                                        ▲
     └──────►  Launcher.Infrastructure ───────┘
Launcher.Tests ──► Launcher.Services
```
UI собирает граф через DI (App.xaml.cs). Services зависят только от интерфейсов Core; HTTP, DPAPI — в Infrastructure.

## Сборка и запуск
1. Visual Studio 2022 + workload «.NET desktop development», .NET 8 SDK.
2. Открыть `MinecraftLauncher.sln` → Restore → F5 (стартовый проект Launcher.UI).
3. CLI: `dotnet build MinecraftLauncher.sln`, `dotnet test`.
4. Публикация: `powershell build\publish.ps1` → `build\output\FLauncher.exe` (self-contained win-x64).
5. Установщик: поставить Inno Setup 6, затем `ISCC.exe build\installer.iss` → `build\output\FLauncher-Setup-1.0.0.exe`.

## Microsoft-вход
1. Лаунчер использует WebView2 OAuth2 Authorization Code + PKCE с loopback redirect `http://localhost`; если WebView2 Runtime отсутствует, автоматически доступен device-code fallback.
2. Azure App Registration должен поддерживать personal Microsoft accounts. В **Authentication → Mobile and desktop applications** добавьте redirect URI `http://localhost` и включите public client flows. Клиентский secret в WPF не добавляется.
3. В Firebase Authentication включите Microsoft provider и укажите Azure Application (client) ID и client secret Value. Secret хранится только в Firebase Console. Добавьте Firebase callback `https://furry-launcher.firebaseapp.com/__/auth/handler` как Web redirect URI Azure и `localhost` в Firebase Authorized domains.
4. В Firebase Authentication включите Anonymous provider для чтения магазина и предварительной проверки ZBT-ключа до входа Microsoft.
5. OAuth request проверяет PKCE/state; полученный Microsoft ID token обменивается на Firebase ID token через Firebase Auth REST API. При ошибке обмена интерфейс сообщает, что Firebase provider не настроен, а не представляет аккаунт как полностью подключённый.
6. Новые приложения должны пройти заявку на доступ к Minecraft API (https://aka.ms/AppRegInfo), иначе Xbox/Minecraft этап может вернуть `Invalid app registration`.

## Защита конфигурации и Firebase
- Firebase Web API key, database URL, Microsoft public client ID и Functions URL являются клиентской конфигурацией; ограничивайте API key в Google Cloud.
- Не включайте Azure client secret, service-account JSON, payment keys или webhook secrets в `appsettings.json`, WPF бинарник, CRM bundle или репозиторий.
- RTDB доступ контролируется Firebase Auth ID token и `database.rules.json`; покупка монет/кейсов остаётся на доверенных Cloud Functions.

## CRM и ЗБТ
- Отдельная React CRM и серверные операции ЗБТ/аналитики: [docs/crm-and-zbt-setup.md](docs/crm-and-zbt-setup.md).
- Firebase Hosting публикует собранный сайт из `crm/dist`; Cloud Functions работают в `europe-west1`.
- Gmail, Telegram, Claude, подписанные ссылки и App Check требуют отдельных секретов/провайдеров и пока не подключены.

## Источники
- Манифест версий и JSON версий: piston-meta.mojang.com (формат — wiki.vg/Game_files, minecraft.wiki/w/Version_manifest.json)
- Ассеты: resources.download.minecraft.net
- Java: Adoptium API v3 (api.adoptium.net, /v3/assets/latest/{major}/hotspot)
- Авторизация: login.microsoftonline.com (WebView2 authorization code + PKCE; device-code fallback), Xbox Live/XSTS, Firebase Auth REST, api.minecraftservices.com
- Новости: launchercontent.mojang.com/news.json (проверить доступность формата)
- Серверы: api.mcstatus.io/v2
- Моды: Modrinth API v2 (api.modrinth.com/v2) — открытый, без ключа; CurseForge требует ключ API
- Скины: minotar.net (скачивание по нику), api.minecraftservices.com/minecraft/profile/skins (загрузка)
- Архитектурные референсы (без копирования кода): PrismLauncher, HMCL, CmlLib.Core

## Статус требований
| Требование | Статус |
|---|---|
| .sln, слои, DI, Serilog, IOptions | ✅ |
| Все версии (release/snapshot/beta/alpha), фильтр/поиск | ✅ |
| client.jar/libraries/assets, докачка, SHA1, прогресс | ✅ |
| Java-чекер и автоустановка Temurin в /runtime | ✅ |
| Запуск игры, лог, «Стоп» | ✅ |
| Microsoft device-code + DPAPI, оффлайн-режим | ✅ (нужен свой Client ID) |
| Новости, серверы (статус, пинг, свои серверы) | ✅ |
| Навигация: Играть / Версии / Новости / Онлайн / Скины / Моды / Настройки | ✅ |
| Окно без системной рамки, только скруглённое | ✅ |
| Выбор диска/папки перед первой загрузкой (C: / D: / своя) + смена в настройках | ✅ |
| Библиотека модов: поиск Modrinth + прямое скачивание + зависимости | ✅ |
| Свои моды (.jar) | ✅ |
| Редактор скина: пиксельный холст, 4 инструмента, палитра, предпросмотр спереди/сзади, PNG, загрузка в аккаунт | ✅ |
| Приветственное окно с озвучкой ElevenLabs, слайды по таймкодам | ✅ |
| Статистика игры (запуски, время) | ✅ |
| Готовые сборки модов (.mrpack), автоустановка Forge/Fabric/Quilt | ❌ v1.1 |
| Автообновление лаунчера, профили | ❌ v1.1 |

Уникальное: «умный выбор диска» (подсказывает диск с максимумом места), редактор скина с живым предпросмотром, приветствие, синхронное с голосом.

## Риски
- Изменения API Mojang/Microsoft → URL вынесены в `appsettings.json`, парсинг защитный, кэш манифеста/новостей.
- Антивирус на скачанную JRE → SHA-256 с Adoptium, подпись сборки лаунчера (code signing).
- Права администратора → всё в `%APPDATA%`/`%LOCALAPPDATA%`, установщик `PrivilegesRequired=lowest`.
- Оффлайн-режим не даёт доступ к лицензионным серверам; в UI помечен.

## Дорожная карта
- **MVP (сейчас):** версии, Java, запуск, оффлайн, MS-вход, новости, серверы.
- **v1.0:** отдельные страницы UI, настройки (папки/JVM/тема), профили, update.json-апдейтер, лог-панель.
- **v1.1:** Fabric/Quilt/Forge (merge `inheritsFrom`-профилей), скины, импорт/экспорт, SQLite-кэш.
