using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class WalletService : IWalletService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly LauncherOptions _options;

    public WalletService(HttpClient http, IOptions<LauncherOptions> options)
    {
        _http = http;
        _options = options.Value;
    }

    public async Task<WalletSnapshot> GetSnapshotAsync(AuthSession session, CancellationToken ct = default)
    {
        EnsureSignedIn(session);

        // Cloud Functions не используем (нужен платный тариф) — читаем кошелёк напрямую из RTDB: /wallets/{uid}.
        // Ожидаемая структура: coins, updatedAt и (необязательно) вложенные owned / caseInventory / equipped / ledger.
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl($"wallets/{session.FirebaseUid}", session));
        using var response = await _http.SendAsync(request, ct);
        if (!response.IsSuccessStatusCode)
            throw new HttpRequestException(
                $"Не удалось прочитать кошелёк из Realtime Database (HTTP {(int)response.StatusCode}). Проверьте правила для /wallets/{{uid}}.",
                null, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync(ct);
        using var document = JsonDocument.Parse(string.IsNullOrWhiteSpace(body) ? "null" : body);

        // Кошелька ещё нет (новый аккаунт) — это не ошибка: 0 монет.
        var root = document.RootElement.ValueKind == JsonValueKind.Object ? document.RootElement : default;
        var wallet = root;
        var owned = new List<OwnedShopItem>();
        var ownedNode = GetObject(root, "owned");
        if (ownedNode.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in ownedNode.EnumerateObject())
            {
                var value = property.Value;
                var name = ReadString(value, "name") ?? ReadString(value, "itemName") ?? property.Name;
                var type = ReadString(value, "type") ?? ReadString(value, "itemType") ?? "item";
                owned.Add(new OwnedShopItem(property.Name, name, type,
                    ReadInt64(value, "acquiredAt"), ReadNullableInt64(value, "expiresAt")));
            }
        }

        var cases = new List<CaseInventoryCount>();
        var casesNode = GetObject(root, "caseInventory");
        if (casesNode.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in casesNode.EnumerateObject())
            {
                var count = property.Value.ValueKind == JsonValueKind.Number && property.Value.TryGetInt32(out var numericCount)
                    ? numericCount
                    : ReadInt32(property.Value, "count");
                if (count > 0) cases.Add(new CaseInventoryCount(property.Name, count));
            }
        }

        var equipped = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var equippedNode = GetObject(root, "equipped");
        if (equippedNode.ValueKind == JsonValueKind.Object)
        {
            foreach (var property in equippedNode.EnumerateObject())
                equipped[property.Name] = ReadString(property.Value, "itemId") ?? property.Name;
        }

        var ledger = new List<WalletLedgerEntry>();
        var ledgerNode = GetObject(root, "ledger");
        if (ledgerNode.ValueKind == JsonValueKind.Object)
        {
            ledger.AddRange(ledgerNode.EnumerateObject().Select(property => new WalletLedgerEntry(
                property.Name,
                ReadInt32(property.Value, "delta"),
                ReadString(property.Value, "reason") ?? "",
                ReadString(property.Value, "ref"),
                ReadInt32(property.Value, "balanceAfter"),
                ReadInt64(property.Value, "ts"))));
        }

        return new WalletSnapshot(Math.Max(0, ReadInt32(wallet, "coins")), ReadInt64(wallet, "updatedAt"),
            owned, cases, equipped, ledger.OrderByDescending(entry => entry.Timestamp).Take(100).ToArray());
    }

    public Task<WalletPurchaseResult> PurchaseWithCoinsAsync(AuthSession session, string itemId, string requestId, CancellationToken ct = default) =>
        throw new NotSupportedException(
            "Покупка за FL Coins требует серверной проверки (Cloud Functions), которая сейчас отключена. Используйте оплату картой или криптой.");

    public Task<CaseOpenResult> OpenCaseAsync(AuthSession session, string caseId, string requestId, CancellationToken ct = default) =>
        throw new NotSupportedException(
            "Открытие кейсов требует серверной проверки (Cloud Functions), которая сейчас отключена.");

    public async Task WatchBalanceAsync(AuthSession session, Action<int> onChanged, CancellationToken ct = default)
    {
        EnsureSignedIn(session);
        using var request = new HttpRequestMessage(HttpMethod.Get, RtdbUrl($"wallets/{session.FirebaseUid}", session));
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
                    onChanged((await GetSnapshotAsync(session, ct)).Coins);
                else if (eventName is "cancel" or "auth_revoked")
                    throw new HttpRequestException("Подписка на баланс закрыта; требуется переподключение.");
                eventName = "";
                eventData.Clear();
                continue;
            }

            if (line.StartsWith("event:", StringComparison.Ordinal)) eventName = line[6..].Trim();
            else if (line.StartsWith("data:", StringComparison.Ordinal))
            {
                if (eventData.Length > 0) eventData.Append('\n');
                eventData.Append(line[5..].TrimStart());
            }
        }
    }

    private static JsonElement GetObject(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var value) ? value : default;
    private static string? ReadString(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString() : null;
    private static int ReadInt32(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var property) && property.TryGetInt32(out var value) ? value : 0;
    private static long ReadInt64(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var property) && property.TryGetInt64(out var value) ? value : 0;
    private static int? ReadNullableInt32(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var property) && property.TryGetInt32(out var value) ? value : null;
    private static long? ReadNullableInt64(JsonElement root, string name) =>
        root.ValueKind == JsonValueKind.Object && root.TryGetProperty(name, out var property) && property.TryGetInt64(out var value) ? value : null;

    /// <summary>Firebase ID-токен для RTDB REST передаётся только как ?auth= (Bearer-заголовок даёт 401).</summary>
    private string RtdbUrl(string path, AuthSession session)
    {
        var safePath = string.Join('/', path.Split('/').Select(Uri.EscapeDataString));
        return $"{GetDatabaseUrl()}/{safePath}.json?auth={Uri.EscapeDataString(session.FirebaseIdToken ?? "")}";
    }

    private string GetDatabaseUrl()
    {
        if (string.IsNullOrWhiteSpace(_options.FirebaseDatabaseUrl) ||
            !Uri.TryCreate(_options.FirebaseDatabaseUrl, UriKind.Absolute, out var databaseUri) || databaseUri.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Не задан HTTPS FirebaseDatabaseUrl.");
        return _options.FirebaseDatabaseUrl.TrimEnd('/');
    }

    private static void EnsureSignedIn(AuthSession session)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseUid) || string.IsNullOrWhiteSpace(session.FirebaseIdToken))
            throw new InvalidOperationException("Для кошелька нужен вход через Microsoft (нет Firebase-сессии).");
    }
}
