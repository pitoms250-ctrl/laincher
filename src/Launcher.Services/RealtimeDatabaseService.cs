using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Net;
using System.Globalization;
using System.Net.Http.Json;
using System.Text;
using System.Text.RegularExpressions;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class RealtimeDatabaseService : IRealtimeDatabaseService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly HttpClient _http;
    private readonly LauncherOptions _options;
    private readonly ILogger<RealtimeDatabaseService> _log;

    public RealtimeDatabaseService(HttpClient http, IOptions<LauncherOptions> options, ILogger<RealtimeDatabaseService> log)
    {
        _http = http;
        _options = options.Value;
        _log = log;
    }

    public async Task<bool?> GetZbtEnabledAsync(CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{GetDatabaseBaseUrl()}/config/zbtEnabled.json");
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Не удалось прочитать режим ЗБТ из RTDB (HTTP {(int)response.StatusCode}).");
        var text = await response.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(text) || string.Equals(text.Trim(), "null", StringComparison.OrdinalIgnoreCase)) return null;
        using var document = JsonDocument.Parse(text);
        return document.RootElement.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.False => false,
            _ => throw new InvalidOperationException("RTDB config/zbtEnabled должен содержать boolean."),
        };
    }

    public async Task WatchZbtEnabledAsync(Action<bool?> onChanged, CancellationToken ct = default)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, $"{GetDatabaseBaseUrl()}/config/zbtEnabled.json");
        request.Headers.Accept.ParseAdd("text/event-stream");
        using var response = await _http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
        response.EnsureSuccessStatusCode();

        await using var stream = await response.Content.ReadAsStreamAsync(ct);
        using var reader = new StreamReader(stream);
        var eventName = "";
        var eventData = new StringBuilder();
        while (await reader.ReadLineAsync(ct) is { } line)
        {
            if (line.Length == 0)
            {
                if (eventName is "put" or "patch")
                {
                    using var document = JsonDocument.Parse(eventData.ToString());
                    if (!document.RootElement.TryGetProperty("data", out var data))
                        throw new InvalidOperationException("RTDB event for config/zbtEnabled has no data.");
                    onChanged(data.ValueKind switch
                    {
                        JsonValueKind.True => true,
                        JsonValueKind.False => false,
                        JsonValueKind.Null => null,
                        _ => throw new InvalidOperationException("RTDB config/zbtEnabled должен содержать boolean."),
                    });
                }
                else if (eventName is "cancel" or "auth_revoked")
                    throw new HttpRequestException("Подписка на config/zbtEnabled закрыта; требуется переподключение.");

                eventName = "";
                eventData.Clear();
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal))
                eventName = line[6..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (eventData.Length > 0) eventData.Append('\n');
                eventData.Append(line[5..].TrimStart());
            }
        }
    }

    public async Task<ZbtAccessResult> PreviewZbtKeyAsync(AuthSession session, string key, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            return new ZbtAccessResult(false, null, "Firebase-профиль устройства не создан.");
        if (!ZbtKeyFormat.TryValidate(key, out var compact, out var validationError))
            return new ZbtAccessResult(false, null, validationError);

        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(compact))).ToLowerInvariant();
        try
        {
            var keyRecord = await GetNodeAsync($"keys/{keyHash}", session, ct);
            if (keyRecord is null) return new ZbtAccessResult(false, null, "Ключ не найден в RTDB.");
            if (GetBoolean(keyRecord, "revoked") || GetBoolean(keyRecord, "used") || keyRecord["status"]?.ToString() != "UNUSED")
                return new ZbtAccessResult(false, null, "Ключ уже использован или отозван.");
            if (IsExpired(keyRecord["expiresAt"])) return new ZbtAccessResult(false, null, "Срок действия ключа истёк.");

            var campaignId = keyRecord["campaignId"]?.ToString();
            if (string.IsNullOrWhiteSpace(campaignId)) return new ZbtAccessResult(false, null, "Ключ не привязан к кампании ЗБТ.");
            var campaign = await GetNodeAsync($"zbtCampaigns/{Uri.EscapeDataString(campaignId)}", session, ct);
            if (campaign is null || campaign["status"]?.ToString() != "ACTIVE" || IsExpired(campaign["expiresAt"]))
                return new ZbtAccessResult(false, null, "Кампания ЗБТ неактивна или завершилась.");
            return new ZbtAccessResult(true, campaignId, "Ключ проверен. Войдите через Microsoft для активации.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Не удалось проверить ZBT key до авторизации");
            return new ZbtAccessResult(false, null, "Не удалось проверить ключ в Realtime Database.");
        }
    }

    public async Task<ZbtAccessResult> CheckZbtAccessAsync(AuthSession session, string installId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            return new ZbtAccessResult(false, null, "Войдите через Microsoft для проверки доступа ЗБТ.");
        try
        {
            var uid = Uri.EscapeDataString(session.FirebaseUid);
            var player = await GetNodeAsync($"players/{uid}", session, ct);
            var profile = await GetNodeAsync($"players/{uid}/profile", session, ct);
            var keyHash = player?["zbtKeyHash"]?.ToString();
            var campaignId = player?["zbtCampaignId"]?.ToString();
            if (string.IsNullOrWhiteSpace(keyHash) || string.IsNullOrWhiteSpace(campaignId))
                return new ZbtAccessResult(false, null, "Для этого аккаунта ещё не активирован ZBT-ключ.");

            var key = await GetNodeAsync($"keys/{Uri.EscapeDataString(keyHash)}", session, ct);
            if (key is null || !GetBoolean(key, "used") || GetBoolean(key, "revoked") ||
                key["status"]?.ToString() != "ACTIVATED" || key["usedBy"]?.ToString() != session.FirebaseUid ||
                key["installId"]?.ToString() != installId || IsExpired(key["expiresAt"]))
                return new ZbtAccessResult(false, null, "Ключ не активирован для этого аккаунта или устройства.");

            var campaign = await GetNodeAsync($"zbtCampaigns/{Uri.EscapeDataString(campaignId)}", session, ct);
            if (campaign is null || campaign["status"]?.ToString() != "ACTIVE" || IsExpired(campaign["expiresAt"]))
                return new ZbtAccessResult(false, null, "Кампания ЗБТ неактивна или завершилась.");
            return new ZbtAccessResult(true, campaignId, "Доступ ЗБТ подтверждён.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Не удалось проверить ZBT доступ в RTDB");
            return new ZbtAccessResult(false, null, "Не удалось проверить доступ ЗБТ. Проверьте соединение.");
        }
    }

    public async Task<ZbtAccessResult> RedeemZbtKeyAsync(AuthSession session, string key, string installId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            return new ZbtAccessResult(false, null, "Для активации ключа войдите через Microsoft.");
        if (string.IsNullOrWhiteSpace(installId) || installId.Length > 64)
            return new ZbtAccessResult(false, null, "Некорректный идентификатор установки.");
        if (!ZbtKeyFormat.TryValidate(key, out var compact, out var validationError))
            return new ZbtAccessResult(false, null, validationError);

        var uid = Uri.EscapeDataString(session.FirebaseUid);
        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(compact))).ToLowerInvariant();
        try
        {
            var (keyRecord, etag) = await GetNodeWithETagAsync($"keys/{keyHash}", session, ct);
            if (keyRecord is null) return new ZbtAccessResult(false, null, "Ключ не найден в RTDB.");
            var alreadyActivated = GetBoolean(keyRecord, "used") && keyRecord["usedBy"]?.ToString() == session.FirebaseUid &&
                keyRecord["installId"]?.ToString() == installId && keyRecord["status"]?.ToString() == "ACTIVATED";
            if (!alreadyActivated)
            {
                var preview = await PreviewZbtKeyAsync(session, compact, ct);
                if (!preview.Ok) return preview;
                if (string.IsNullOrWhiteSpace(etag))
                    return new ZbtAccessResult(false, null, "RTDB не вернула ETag; безопасная активация невозможна.");

                keyRecord["used"] = true;
                keyRecord["status"] = "ACTIVATED";
                keyRecord["usedBy"] = session.FirebaseUid;
                keyRecord["activatedBy"] = session.FirebaseUid;
                keyRecord["installId"] = installId;
                keyRecord["activatedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                keyRecord["nickname"] = Clean(session.Username, 16);
                keyRecord["minecraftUuid"] = Clean(session.Uuid, 64);
                keyRecord["email"] = session.Email;

                using var request = new HttpRequestMessage(HttpMethod.Put,
                    RtdbUrl($"keys/{keyHash}", session)) { Content = JsonContent.Create(keyRecord) };
                request.Headers.TryAddWithoutValidation("If-Match", etag);
                using var response = await _http.SendAsync(request, ct);
                if (response.StatusCode == HttpStatusCode.PreconditionFailed)
                    return new ZbtAccessResult(false, null, "Ключ уже активировал другой пользователь. Обновите список ключей.");
                if (!response.IsSuccessStatusCode)
                    return new ZbtAccessResult(false, null, $"RTDB отклонила активацию ключа (HTTP {(int)response.StatusCode}).");
            }

            await RegisterPlayerAsync(session, session.Username, GetLocale(), ct: ct);
            await WriteAsync($"players/{uid}", new
            {
                zbtKeyHash = keyHash,
                zbtCampaignId = keyRecord["campaignId"]?.ToString(),
                installId,
            }, session, HttpMethod.Patch, ct);
            return await CheckZbtAccessAsync(session, installId, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Не удалось активировать ZBT-ключ в RTDB");
            return new ZbtAccessResult(false, null, "Не удалось активировать ключ. Проверьте подключение и повторите попытку.");
        }
    }

    public async Task RegisterPlayerAsync(AuthSession session, string nickname, string locale, int launchCount = 0,
        double totalPlayMinutes = 0, string? lastVersion = null, CancellationToken ct = default)
    {
        var uid = GetUid(session);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var existingProfile = await GetNodeAsync($"players/{uid}/profile", session, ct);
        var profileNickname = Clean(nickname, 16);
        if (profileNickname.Length == 0) profileNickname = "Player";
        var createdAt = long.TryParse(existingProfile?["createdAt"]?.ToString(), out var previousCreatedAt)
            ? previousCreatedAt
            : now;

        await WriteAsync($"players/{uid}/profile", new
        {
            nickname = profileNickname,
            minecraftUuid = Clean(session.Uuid, 64),
            locale = locale is "ru-RU" or "uk-UA" or "en-US" ? locale : "en-US",
            createdAt,
            lastSeenAt = now,
        }, session, HttpMethod.Patch, ct);

        var existing = await GetNodeAsync($"players/{uid}", session, ct);
        await WriteAsync($"players/{uid}", new
        {
            firebaseUid = session.FirebaseUid,
            nickname = profileNickname,
            email = session.Email,
            contactEmail = session.Email,
            minecraftUuid = session.Uuid,
            locale,
            launchCount = Math.Max(0, launchCount),
            totalPlayMinutes = Math.Max(0, totalPlayMinutes),
            lastVersion,
            createdAt = existing?["createdAt"]?.GetValue<long>() ?? now,
            lastSeenAt = now,
        }, session, HttpMethod.Patch, ct);
    }

    public async Task<bool> IsPlayerBannedAsync(AuthSession session, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid)) return false;
        if (string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Для проверки блокировки требуется активная Firebase-сессия.");

        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl($"bans/{session.FirebaseUid}", session));
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"Не удалось проверить статус аккаунта (HTTP {(int)response.StatusCode}).");

        var body = await response.Content.ReadAsStringAsync(ct);
        return !string.IsNullOrWhiteSpace(body) && !string.Equals(body.Trim(), "null", StringComparison.OrdinalIgnoreCase);
    }

    public Task SetPresenceAsync(AuthSession session, string state, string launcherVersion, string? gameVersion = null,
        CancellationToken ct = default) =>
        WriteAsync($"presence/{GetUid(session)}", new
        {
            state,
            heartbeatAt = ServerTimestamp.Value,
            launcherVersion,
            gameVersion
        }, session, HttpMethod.Put, ct);

    public Task RecordEventAsync(AuthSession session, string eventType, string area, string locale, string launcherVersion,
        string? gameVersion = null, CancellationToken ct = default) =>
        PostAsync($"playerEvents/{GetUid(session)}", new
        {
            eventType = Clean(eventType, 48),
            area = Clean(area, 48),
            occurredAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            locale = Clean(locale, 10),
            launcherVersion = Clean(launcherVersion, 32),
            gameVersion = Clean(gameVersion, 32),
        }, session, ct);

    public Task ReportErrorAsync(AuthSession session, string area, string title, string description, string locale,
        string launcherVersion, string? gameVersion = null, string? stack = null, CancellationToken ct = default)
    {
        // Схема /errorReports/{uid}/{errorId}: occurredAt, area, title, description, device{os,architecture,ramBucket,logicalProcessors}
        var errorId = $"err_{DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()}_{Guid.NewGuid():N}"[..40];
        var fullDescription = string.IsNullOrWhiteSpace(stack) ? description : $"{description}\n{stack}";
        return WriteAsync($"errorReports/{GetUid(session)}/{errorId}", new
        {
            occurredAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            area = Clean(area, 48),
            title = Clean(title, 160),
            description = Scrub(fullDescription, 4000),
            device = GetDeviceSnapshot(),
        }, session, HttpMethod.Put, ct);
    }

    private async Task PostAsync(string path, object payload, AuthSession session, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Для облачной записи требуется активная Firebase-сессия.");

        using var request = new HttpRequestMessage(HttpMethod.Post, RtdbUrl(path, session))
        {
            Content = JsonContent.Create(payload, options: JsonOptions)
        };
        using var response = await _http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (response.IsSuccessStatusCode) return;

        _log.LogWarning("Realtime Database write failed for {Path}: HTTP {StatusCode}", path, (int)response.StatusCode);
        throw new HttpRequestException($"Не вдалося записати в RTDB {path} (HTTP {(int)response.StatusCode}): {text}");
    }

    private async Task<JsonNode?> GetNodeAsync(string path, AuthSession session, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl(path, session));
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Ошибка чтения RTDB «{path}» (HTTP {(int)response.StatusCode}). Проверьте правила базы и вход в аккаунт.");
        var text = await response.Content.ReadAsStringAsync(ct);
        return string.IsNullOrWhiteSpace(text) || text == "null" ? null : JsonNode.Parse(text);
    }

    private async Task<(JsonNode? Node, string? ETag)> GetNodeWithETagAsync(string path, AuthSession session, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl(path, session));
        request.Headers.TryAddWithoutValidation("X-Firebase-ETag", "true");
        using var response = await _http.SendAsync(request, ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException($"RTDB read failed (HTTP {(int)response.StatusCode}).");
        var node = string.IsNullOrWhiteSpace(text) || text == "null" ? null : JsonNode.Parse(text);
        var etag = response.Headers.ETag?.Tag ?? response.Headers.FirstOrDefault(header =>
            header.Key.Equals("ETag", StringComparison.OrdinalIgnoreCase)).Value?.FirstOrDefault();
        return (node, etag);
    }

    private static string Clean(string? value, int limit) => (value ?? "").Trim()[..Math.Min((value ?? "").Trim().Length, limit)];

    private static bool GetBoolean(JsonNode? node, string property) =>
        bool.TryParse(node?[property]?.ToString(), out var value) && value;

    private static bool IsExpired(JsonNode? value) =>
        long.TryParse(value?.ToString(), out var expiresAt) && expiresAt > 0 &&
        expiresAt < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static string GetLocale() => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName switch
    {
        "ru" => "ru-RU",
        "uk" => "uk-UA",
        _ => "en-US",
    };

    private static string Scrub(string value, int limit)
    {
        var safe = Regex.Replace(value, @"Bearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer <REDACTED>", RegexOptions.IgnoreCase);
        safe = Regex.Replace(safe, @"((?:access|refresh|id)_token\s*[=:]\s*)[^\s,;]+", "$1<REDACTED>", RegexOptions.IgnoreCase);
        safe = Regex.Replace(safe, @"([A-Z]:\\Users\\)[^\\\s]+", "$1<USER>", RegexOptions.IgnoreCase);
        return safe.Length <= limit ? safe : safe[..limit];
    }

    private async Task WriteAsync<T>(string path, T payload, AuthSession session, HttpMethod method, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Для облачной записи требуется активная Firebase-сессия.");

        using var request = new HttpRequestMessage(method, RtdbUrl(path, session))
        {
            Content = JsonContent.Create(payload, options: JsonOptions)
        };

        using var response = await _http.SendAsync(request, ct);
        if (response.IsSuccessStatusCode) return;

        _log.LogWarning("Realtime Database write failed for {Path}: HTTP {StatusCode}", path, (int)response.StatusCode);
        throw new HttpRequestException($"Не удалось отправить данные в Firebase «{path}» (HTTP {(int)response.StatusCode}). Проверьте правила RTDB.");
    }

    private static string GetUid(AuthSession session) =>
        !string.IsNullOrWhiteSpace(session.FirebaseUid)
            ? Uri.EscapeDataString(session.FirebaseUid)
            : throw new InvalidOperationException("У аккаунта нет Firebase UID.");

    /// <summary>
    /// RTDB REST принимает Firebase ID-токен только через ?auth=. "Authorization: Bearer" работает лишь
    /// с Google OAuth2 access-токенами, поэтому с ID-токеном RTDB отвечала 401 и данные не читались.
    /// </summary>
    private string RtdbUrl(string path, AuthSession session)
    {
        var safePath = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
        return $"{GetDatabaseBaseUrl()}/{safePath}.json?auth={Uri.EscapeDataString(session.FirebaseIdToken ?? "")}";
    }

    private string GetDatabaseBaseUrl()
    {
        if (string.IsNullOrWhiteSpace(_options.FirebaseDatabaseUrl) ||
            !Uri.TryCreate(_options.FirebaseDatabaseUrl, UriKind.Absolute, out var databaseUri) ||
            databaseUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Укажите HTTPS Launcher:FirebaseDatabaseUrl в конфигурации.");
        return _options.FirebaseDatabaseUrl.TrimEnd('/');
    }

    private static DeviceSnapshot GetDeviceSnapshot()
    {
        var ramBytes = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        var ramBucket = ramBytes <= 0 ? "unknown" : ramBytes < 8L * 1024 * 1024 * 1024 ? "<8GB" :
            ramBytes < 16L * 1024 * 1024 * 1024 ? "8-16GB" : "16GB+";
        return new DeviceSnapshot(RuntimeInformation.OSDescription, RuntimeInformation.ProcessArchitecture.ToString(), ramBucket,
            Environment.ProcessorCount);
    }

    private sealed record DeviceSnapshot(string Os, string Architecture, string RamBucket, int LogicalProcessors);
    private sealed record ServerTimestamp([property: JsonPropertyName(".sv")] string Operation)
    {
        public static ServerTimestamp Value { get; } = new("timestamp");
    }
}