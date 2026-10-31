namespace Launcher.Core.Models;

public sealed record ShopItem(
    string Id,
    string Name,
    string Description,
    string Type,
    decimal PriceUah,
    decimal PriceUsdt,
    string? IconUrl,
    bool Enabled,
    bool DynamicPrice,
    int SalesCount,
    string Rarity = "common",
    string Category = "other",
    int SortOrder = 0,
    bool Giftable = true,
    bool Limited = false,
    int? Stock = null,
    long? AvailableFrom = null,
    long? AvailableUntil = null,
    decimal? PriceCoins = null,
    string? IconOpenUrl = null)
{
    public bool IsAvailableNow => Enabled && Stock != 0 &&
        (AvailableFrom is null || AvailableFrom <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()) &&
        (AvailableUntil is null || AvailableUntil > DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
}

public sealed record ShopOrderResult(string OrderId, string ReceiptCode, decimal Amount, string Currency, string BotLink);