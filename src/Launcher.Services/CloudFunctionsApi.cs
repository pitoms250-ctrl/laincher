using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class CloudFunctionsService : ICloudApiService
{
    private readonly HttpClient _http;
    private readonly LauncherOptions _options;
    private readonly ILogger<CloudFunctionsService> _log;

    public CloudFunctionsService(HttpClient http, IOptions<LauncherOptions> options, ILogger<CloudFunctionsService> log)
    {
        _http = http;
        _options = options.Value;
        _log = log;
    }

    public bool IsConfigured =>
        !string.IsNullOrWhiteSpace(_options.FirebaseDatabaseUrl) &&
        Uri.TryCreate(_options.FirebaseDatabaseUrl, UriKind.Absolute, out var uri) &&
        uri.Scheme == Uri.UriSchemeHttps;

    private async Task<(HttpStatusCode Status, JsonElement Body, string? ETag)> RtdbAsync(
        HttpMethod method, string path, string idToken, object? payload, CancellationToken ct,
        string? ifMatch = null, bool requestETag = false)
    {
        var safePath = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
        using var req = new HttpRequestMessage(method,
            $"{_options.FirebaseDatabaseUrl!.TrimEnd('/')}/{safePath}.json?auth={Uri.EscapeDataString(idToken)}");
        if (requestETag) req.Headers.TryAddWithoutValidation("X-Firebase-ETag", "true");
        if (!string.IsNullOrWhiteSpace(ifMatch)) req.Headers.TryAddWithoutValidation("If-Match", ifMatch);
        if (payload is not null) req.Content = JsonContent.Create(payload);
        using var resp = await _http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        JsonElement body;
        try { body = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "null" : text).RootElement.Clone(); }
        catch (JsonException) { body = JsonDocument.Parse("null").RootElement.Clone(); }
        var etag = resp.Headers.ETag?.Tag ?? resp.Headers.FirstOrDefault(header =>
            header.Key.Equals("ETag", StringComparison.OrdinalIgnoreCase)).Value?.FirstOrDefault();
        return (resp.StatusCode, body, etag);
    }

    private static string? Str(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Flag(JsonElement o, string name) =>
        o.ValueKind == JsonValueKind.Object && o.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    public async Task<ZbtAccessResult> CheckZbtAccessAsync(AuthSession session, string installId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseIdToken) || string.IsNullOrWhiteSpace(session.FirebaseUid))
            return new ZbtAccessResult(false, null, "Firebase anonymous-профиль не створено. Увімкніть Anonymous sign-in.");
        try
        {
            var token = session.FirebaseIdToken!;
            var (profileStatus, profile, _) = await RtdbAsync(HttpMethod.Get, $"players/{session.FirebaseUid}", token, null, ct);
            if (!profileStatus.IsSuccess()) return new ZbtAccessResult(false, null, $"RTDB недоступна (HTTP {(int)profileStatus}).");
            var keyHash = Str(profile, "zbtKeyHash");
            if (string.IsNullOrWhiteSpace(keyHash)) return new ZbtAccessResult(false, null, "Нужен ключ ЗБТ.");

            var (keyStatus, keyRecord, _) = await RtdbAsync(HttpMethod.Get, $"keys/{keyHash}", token, null, ct);
            if (!keyStatus.IsSuccess() || keyRecord.ValueKind != JsonValueKind.Object)
                return new ZbtAccessResult(false, null, "Ключ не найден в RTDB /keys.");
            var campaignId = Str(keyRecord, "campaignId");
            if (!Flag(keyRecord, "used") || Str(keyRecord, "usedBy") != session.FirebaseUid ||
                Str(keyRecord, "installId") != installId || Str(keyRecord, "status") != "ACTIVATED" || Flag(keyRecord, "revoked"))
                return new ZbtAccessResult(false, null, "Ключ не активирован для этого профиля и устройства.");
            if (IsExpired(keyRecord, "expiresAt") || string.IsNullOrWhiteSpace(campaignId))
                return new ZbtAccessResult(false, null, "Ключ истёк или не связан с кампанией.");

            var (campaignStatus, campaign, _) = await RtdbAsync(HttpMethod.Get, $"zbtCampaigns/{campaignId}", token, null, ct);
            if (!campaignStatus.IsSuccess() || campaign.ValueKind != JsonValueKind.Object ||
                Str(campaign, "status") != "ACTIVE" || IsExpired(campaign, "expiresAt"))
                return new ZbtAccessResult(false, null, "Кампания ЗБТ неактивна или истекла.");

            await SavePlayerProfileAsync(session, installId, keyHash, campaignId, ct);
            return new ZbtAccessResult(true, campaignId, "Доступ ЗБТ подтверждён.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "CheckZbtAccess через RTDB не удался");
            return new ZbtAccessResult(false, null, "Нет связи с базой ЗБТ.");
        }
    }

    public async Task<ZbtAccessResult> RedeemZbtKeyAsync(AuthSession session, string key, string installId, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseIdToken) || string.IsNullOrWhiteSpace(session.FirebaseUid))
            return new ZbtAccessResult(false, null, "Firebase anonymous-профиль не створено. Увімкніть Anonymous sign-in.");
        if (!ZbtKeyFormat.TryValidate(key, out var compact, out var validationError))
            return new ZbtAccessResult(false, null, validationError);

        var token = session.FirebaseIdToken!;
        var uid = session.FirebaseUid!;
        var keyHash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(compact))).ToLowerInvariant();
        try
        {
            var (banStatus, banRecord, _) = await RtdbAsync(HttpMethod.Get, $"bans/{uid}", token, null, ct);
            if (banStatus.IsSuccess() && banRecord.ValueKind != JsonValueKind.Null)
                return new ZbtAccessResult(false, null, "Доступ до лаунчера заблоковано.");

            var (keyStatus, keyRecord, etag) = await RtdbAsync(HttpMethod.Get, $"keys/{keyHash}", token, null, ct, requestETag: true);
            if (keyStatus is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new ZbtAccessResult(false, null, "RTDB відхилила доступ. Перевірте Anonymous Auth і правила /keys.");
            if (!keyStatus.IsSuccess() || keyRecord.ValueKind != JsonValueKind.Object)
                return new ZbtAccessResult(false, null, "Такого ключа немає в RTDB /keys.");
            if (string.IsNullOrWhiteSpace(etag))
                return new ZbtAccessResult(false, null, "RTDB не повернула ETag; безпечна активація неможлива.");

            var campaignId = Str(keyRecord, "campaignId");
            if (Flag(keyRecord, "revoked") || Str(keyRecord, "status") == "REVOKED")
                return new ZbtAccessResult(false, null, "Ключ відкликано.");
            if (IsExpired(keyRecord, "expiresAt") || string.IsNullOrWhiteSpace(campaignId))
                return new ZbtAccessResult(false, null, "Ключ істёк або не пов'язаний з кампанією.");

            var (campaignStatus, campaign, _) = await RtdbAsync(HttpMethod.Get, $"zbtCampaigns/{campaignId}", token, null, ct);
            if (!campaignStatus.IsSuccess() || campaign.ValueKind != JsonValueKind.Object ||
                Str(campaign, "status") != "ACTIVE" || IsExpired(campaign, "expiresAt"))
                return new ZbtAccessResult(false, null, "Кампанія ЗБТ закрита або завершилася.");

            var alreadyActivated = Flag(keyRecord, "used") && Str(keyRecord, "usedBy") == uid && Str(keyRecord, "installId") == installId;
            if (!alreadyActivated)
            {
                if (Flag(keyRecord, "used") || Str(keyRecord, "status") != "UNUSED")
                    return new ZbtAccessResult(false, null, "Ключ уже використаний.");

                var keyObject = JsonNode.Parse(keyRecord.GetRawText())!.AsObject();
                var activatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                keyObject["status"] = "ACTIVATED";
                keyObject["used"] = true;
                keyObject["usedBy"] = uid;
                keyObject["activatedBy"] = uid;
                keyObject["installId"] = installId;
                keyObject["nickname"] = session.Username;
                keyObject["email"] = session.Email;
                keyObject["contactEmail"] = session.Email;
                keyObject["minecraftUuid"] = session.Uuid;
                keyObject["activatedAt"] = activatedAt;
                keyObject["usedAt"] = activatedAt;
                keyObject["device"] = JsonSerializer.SerializeToNode(GetDeviceSnapshot());

                var (writeStatus, _, _) = await RtdbAsync(HttpMethod.Put, $"keys/{keyHash}", token, keyObject, ct, etag);
                if (writeStatus == HttpStatusCode.PreconditionFailed)
                    return new ZbtAccessResult(false, null, "Ключ уже активував інший пристрій. Оновіть базу та спробуйте ще раз.");
                if (!writeStatus.IsSuccess())
                    return new ZbtAccessResult(false, null, $"RTDB відхилила активацію (HTTP {(int)writeStatus}).");
            }

            await SavePlayerProfileAsync(session, installId, keyHash, campaignId!, ct);
            return new ZbtAccessResult(true, campaignId, alreadyActivated ? "Ключ уже активовано для цього пристрою." : "Ключ активовано в Realtime Database.");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "RedeemZbtKey через RTDB не удался");
            return new ZbtAccessResult(false, null, "Нет связи с базой ЗБТ.");
        }
    }

    private async Task SavePlayerProfileAsync(AuthSession session, string installId, string keyHash, string campaignId, CancellationToken ct)
    {
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var payload = new
        {
            firebaseUid = session.FirebaseUid,
            nickname = session.Username,
            email = session.Email,
            contactEmail = session.Email,
            minecraftUuid = session.Uuid,
            installId,
            zbtCampaignId = campaignId,
            zbtKeyHash = keyHash,
            lastSeenAt = timestamp,
            device = GetDeviceSnapshot(),
        };
        var (status, _, _) = await RtdbAsync(HttpMethod.Patch, $"players/{session.FirebaseUid}",
            session.FirebaseIdToken!, payload, ct);
        if (!status.IsSuccess()) throw new HttpRequestException($"Не вдалося записати профіль у RTDB (HTTP {(int)status}).");
    }

    private static object GetDeviceSnapshot()
    {
        var memory = GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        var ramBucket = memory <= 0 ? "unknown" : memory < 8L * 1024 * 1024 * 1024 ? "<8GB" :
            memory < 16L * 1024 * 1024 * 1024 ? "8-16GB" : "16GB+";
        return new
        {
            os = RuntimeInformation.OSDescription,
            architecture = RuntimeInformation.ProcessArchitecture.ToString(),
            ramBucket,
            logicalProcessors = Math.Clamp(Environment.ProcessorCount, 1, 256),
        };
    }

    private static bool IsExpired(JsonElement value, string property) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(property, out var expiresAt) &&
        expiresAt.TryGetInt64(out var timestamp) && timestamp > 0 && timestamp < DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    private static bool TryLong(JsonElement value, string property, out long result)
    {
        result = 0;
        return value.ValueKind == JsonValueKind.Object && value.TryGetProperty(property, out var element) && element.TryGetInt64(out result);
    }

    public async Task<IReadOnlyList<NewsItem>> GetLauncherNewsAsync(AuthSession session, CancellationToken ct = default)
    {
        if (!IsConfigured || string.IsNullOrWhiteSpace(session.FirebaseIdToken)) return Array.Empty<NewsItem>();
        try
        {
            var (status, records, _) = await RtdbAsync(HttpMethod.Get, "announcements", session.FirebaseIdToken, null, ct);
            if (!status.IsSuccess() || records.ValueKind != JsonValueKind.Object) return Array.Empty<NewsItem>();
            return records.EnumerateObject()
                .Select(entry => entry.Value)
                .Where(item => Str(item, "status") == "PUBLISHED")
                .Select(item => new NewsItem(
                    Str(item, "title") ?? "",
                    TryLong(item, "publishedAt", out var publishedAt) || TryLong(item, "updatedAt", out publishedAt)
                        ? DateTimeOffset.FromUnixTimeMilliseconds(publishedAt).UtcDateTime
                        : DateTime.UtcNow,
                    null,
                    Str(item, "body") ?? "",
                    null))
                .OrderByDescending(item => item.Date)
                .Take(20)
                .ToList();
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Не вдалося прочитати оголошення RTDB");
            return Array.Empty<NewsItem>();
        }
    }

    public Task<bool> SetPlayerContactAsync(AuthSession session, string email, bool consent, CancellationToken ct = default) =>
        WritePlayerFieldsAsync(session, new { contactEmail = email, contactEmailConsent = consent, contactUpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, ct);

    public Task<bool> SetDiagnosticsConsentAsync(AuthSession session, bool consent, CancellationToken ct = default) =>
        WritePlayerFieldsAsync(session, new { shareDiagnostics = consent, consentUpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() }, ct);

    private async Task<bool> WritePlayerFieldsAsync(AuthSession session, object payload, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken)) return false;
        using var request = new HttpRequestMessage(HttpMethod.Patch,
            $"{_options.FirebaseDatabaseUrl!.TrimEnd('/')}/players/{Uri.EscapeDataString(session.FirebaseUid)}.json?auth={Uri.EscapeDataString(session.FirebaseIdToken)}")
        {
            Content = JsonContent.Create(payload)
        };
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode) _log.LogWarning("RTDB profile update failed: HTTP {StatusCode}", (int)response.StatusCode);
        return response.IsSuccessStatusCode;
    }
}

internal static class HttpStatusExtensions
{
    public static bool IsSuccess(this HttpStatusCode code) => (int)code is >= 200 and < 300;
}
