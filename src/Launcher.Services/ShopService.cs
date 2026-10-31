using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class ShopService : IShopService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly LauncherOptions _options;

    public ShopService(HttpClient http, IOptions<LauncherOptions> options)
    {
        _http = http;
        _options = options.Value;
    }

    public async Task<IReadOnlyList<ShopItem>> GetItemsAsync(AuthSession session, CancellationToken ct = default)
    {
        EnsureFirebaseSession(session);
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl("shop_items", session));
        using var response = await _http.SendAsync(request, ct);
        await EnsureSuccessAsync(response, "Не удалось загрузить магазин из Realtime Database.", ct);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);

        // RTDB отдаёт массив, если ключи товаров 0,1,2…; объект — если ключи строковые.
        IEnumerable<(string Id, JsonElement Value)> entries = document.RootElement.ValueKind switch
        {
            JsonValueKind.Object => document.RootElement.EnumerateObject().Select(p => (p.Name, p.Value)),
            JsonValueKind.Array => document.RootElement.EnumerateArray().Select((v, i) => (Id: i.ToString(), Value: v)),
            _ => Enumerable.Empty<(string, JsonElement)>(),
        };

        return entries
            .Where(entry => entry.Value.ValueKind == JsonValueKind.Object)
            .Select(entry => ParseItem(entry.Id, entry.Value))
            .Where(item => item.Enabled)
            .OrderBy(item => item.SortOrder)
            .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase)
            .ToArray();
    }

    public async Task WatchItemsAsync(AuthSession session, Action<IReadOnlyList<ShopItem>> onChanged, CancellationToken ct = default)
    {
        EnsureFirebaseSession(session);
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl("shop_items", session));
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
                    onChanged(await GetItemsAsync(session, ct));
                else if (eventName is "cancel" or "auth_revoked")
                    throw new HttpRequestException("Подписка на магазин RTDB закрыта; требуется переподключение.");

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

    public async Task<ShopOrderResult> CreateOrderAsync(AuthSession session, string itemId, string paymentMethod, string? tag = null, CancellationToken ct = default)
    {
        EnsureSignedIn(session);
        if (paymentMethod is not ("card" or "crypto")) throw new ArgumentException("Неизвестный способ оплаты.", nameof(paymentMethod));

        var item = (await GetItemsAsync(session, ct)).FirstOrDefault(candidate => candidate.Id == itemId)
            ?? throw new InvalidOperationException("Товар недоступен. Обновите каталог.");
        var isCard = paymentMethod == "card";
        var currency = isCard ? "UAH" : "USDT";
        var baseAmount = isCard ? item.PriceUah : item.PriceUsdt;
        if (baseAmount <= 0) throw new InvalidOperationException($"Для товара не задана цена в {currency}.");

        var requestedTag = item.Type.Equals("tag", StringComparison.OrdinalIgnoreCase)
            ? (tag ?? "").Trim().ToLowerInvariant()
            : null;
        if (item.Type.Equals("tag", StringComparison.OrdinalIgnoreCase) &&
            (requestedTag is null || requestedTag.Length is < 3 or > 16 || requestedTag.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_')))
            throw new ArgumentException("Тег должен содержать 3–16 латинских букв, цифр или символов подчёркивания.", nameof(tag));

        var orderId = $"order_{Guid.NewGuid():N}";
        var receiptCode = $"F-{RandomNumberGenerator.GetHexString(6, true)}";
        var amount = isCard ? baseAmount + RandomNumberGenerator.GetInt32(1, 100) / 100m : baseAmount;
        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var order = new Dictionary<string, object?>
        {
            ["uid"] = session.FirebaseUid,
            ["email"] = session.Email,
            ["nickname"] = session.Username,
            ["itemId"] = item.Id,
            ["itemName"] = item.Name,
            ["itemType"] = item.Type,
            ["amount"] = amount,
            ["baseAmount"] = baseAmount,
            ["currency"] = currency,
            ["paymentMethod"] = paymentMethod,
            ["tag"] = requestedTag,
            ["receiptCode"] = receiptCode,
            ["status"] = "pending",
            ["createdAt"] = timestamp,
            ["updatedAt"] = timestamp,
        };

        using (var orderResponse = await SendRtdbAsync(HttpMethod.Put, $"orders/{orderId}", session, order, ct))
            await EnsureSuccessAsync(orderResponse, "Не удалось создать заказ в Realtime Database.", ct);

        if (requestedTag is not null)
        {
            var reservation = new
            {
                tag = requestedTag,
                uid = session.FirebaseUid,
                itemId = item.Id,
                orderId,
                status = "reserved",
                reservedAt = timestamp,
            };
            try
            {
                using var tagResponse = await SendRtdbAsync(HttpMethod.Put, $"tags/{requestedTag}", session, reservation, ct);
                await EnsureSuccessAsync(tagResponse, "Этот тег уже занят или ожидает оплаты.", ct);
            }
            catch
            {
                using var rollback = await SendRtdbAsync(HttpMethod.Delete, $"orders/{orderId}", session, null, ct);
                await EnsureSuccessAsync(rollback, "Тег занят; не удалось удалить временный заказ.", ct);
                try
                {
                    using var release = await SendRtdbAsync(HttpMethod.Delete, $"tags/{requestedTag}", session, null, ct);
                    _ = release.IsSuccessStatusCode;
                }
                catch { }
                throw;
            }
        }

        var username = _options.TelegramBotUsername.Trim().TrimStart('@');
        if (string.IsNullOrWhiteSpace(username)) throw new InvalidOperationException("Не задан TelegramBotUsername в конфигурации лаунчера.");
        return new ShopOrderResult(orderId, receiptCode, amount, currency, $"https://t.me/{username}?start=pay_{orderId}");
    }

    public async Task<string> GetOrderStatusAsync(AuthSession session, string orderId, CancellationToken ct = default)
    {
        EnsureSignedIn(session);
        using var response = await SendRtdbAsync(HttpMethod.Get, $"orders/{Uri.EscapeDataString(orderId)}", session, null, ct);
        await EnsureSuccessAsync(response, "Не удалось получить статус заказа из Realtime Database.", ct);
        using var document = await JsonDocument.ParseAsync(await response.Content.ReadAsStreamAsync(ct), cancellationToken: ct);
        if (document.RootElement.ValueKind != JsonValueKind.Object || ReadString(document.RootElement, "uid") != session.FirebaseUid)
            throw new InvalidOperationException("Заказ не найден для текущего аккаунта.");
        return ReadString(document.RootElement, "status") ?? "unknown";
    }

    private async Task<HttpResponseMessage> SendRtdbAsync(HttpMethod method, string path, AuthSession session, object? payload, CancellationToken ct)
    {
        var request = new HttpRequestMessage(method, RtdbUrl(path, session));
        if (payload is not null) request.Content = JsonContent.Create(payload, options: JsonOptions);
        var response = await _http.SendAsync(request, ct);
        request.Dispose();
        return response;
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, string fallback, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var body = await response.Content.ReadAsStringAsync(ct);
        string? databaseError = null;
        try
        {
            using var document = JsonDocument.Parse(body);
            databaseError = ReadString(document.RootElement, "error");
        }
        catch (JsonException) { }
        throw new HttpRequestException(databaseError is null ? $"{fallback} (HTTP {(int)response.StatusCode})." : $"{fallback} {databaseError}", null, response.StatusCode);
    }

    /// <summary>
    /// RTDB REST принимает Firebase ID-токен только в query-параметре auth.
    /// Заголовок "Authorization: Bearer" работает лишь с Google OAuth2 access-токенами (сервисные аккаунты),
    /// поэтому с ID-токеном RTDB отвечала 401 и каталог оставался пустым.
    /// </summary>
    private string RtdbUrl(string path, AuthSession session)
    {
        var safePath = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
        return $"{DatabaseUrl()}/{safePath}.json?auth={Uri.EscapeDataString(session.FirebaseIdToken ?? "")}";
    }

    private string DatabaseUrl()
    {
        if (string.IsNullOrWhiteSpace(_options.FirebaseDatabaseUrl) ||
            !Uri.TryCreate(_options.FirebaseDatabaseUrl, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Не задан HTTPS FirebaseDatabaseUrl.");
        return _options.FirebaseDatabaseUrl.TrimEnd('/');
    }

    private static void EnsureSignedIn(AuthSession session)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Для магазину потрібен вхід у лаунчер через Microsoft.");
    }

    private static void EnsureFirebaseSession(AuthSession session)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Не удалось подключиться к Firebase. Проверьте вход и подключение.");
    }

    private static ShopItem ParseItem(string id, JsonElement value) => new(
        id,
        ReadString(value, "name") ?? "Товар",
        ReadString(value, "description") ?? "",
        ReadString(value, "type") ?? "item",
        ReadDecimal(value, "priceUah"),
        ReadDecimal(value, "priceUsdt"),
        ReadString(value, "iconUrl") ?? ReadAssetUrl(value, "icon"),
        value.TryGetProperty("enabled", out var enabled) && enabled.ValueKind == JsonValueKind.True,
        value.TryGetProperty("dynamicPrice", out var dynamicPrice) && dynamicPrice.ValueKind == JsonValueKind.True,
        value.TryGetProperty("salesCount", out var salesCount) && salesCount.TryGetInt32(out var count) ? count : 0,
        ReadString(value, "rarity") ?? "common",
        ReadString(value, "category") ?? "other",
        value.TryGetProperty("sortOrder", out var sortOrder) && sortOrder.TryGetInt32(out var order) ? order : 0,
        !value.TryGetProperty("giftable", out var giftable) || giftable.ValueKind == JsonValueKind.True,
        value.TryGetProperty("limited", out var limited) && limited.ValueKind == JsonValueKind.True,
        value.TryGetProperty("stock", out var stock) && stock.TryGetInt32(out var quantity) ? quantity : null,
        ReadInt64(value, "availableFrom"),
        ReadInt64(value, "availableUntil"),
        value.TryGetProperty("priceCoins", out var priceCoins) && priceCoins.TryGetDecimal(out var coinPrice) ? coinPrice : null,
        ReadAssetUrl(value, "iconOpen"));

    private static string? ReadAssetUrl(JsonElement value, string name)
    {
        if (!value.TryGetProperty("assets", out var assets) || assets.ValueKind != JsonValueKind.Object ||
            !assets.TryGetProperty(name, out var asset) || asset.ValueKind != JsonValueKind.String)
            return null;

        var path = asset.GetString();
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (Uri.TryCreate(path, UriKind.Absolute, out var absolute) &&
            (absolute.Scheme == Uri.UriSchemeHttps || absolute.Scheme == Uri.UriSchemeHttp))
            return absolute.ToString();

        var normalized = path.Replace('\\', '/');
        if (normalized.StartsWith("shop/", StringComparison.OrdinalIgnoreCase))
            return $"pack://application:,,,/Assets/Shop/{normalized[5..]}";
        return null;
    }

    private static long? ReadInt64(JsonElement value, string name) =>
        value.TryGetProperty(name, out var property) && property.TryGetInt64(out var number) ? number : null;

    private static string? ReadString(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;

    private static decimal ReadDecimal(JsonElement value, string name) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var property) && property.TryGetDecimal(out var number)
            ? number
            : 0;
}