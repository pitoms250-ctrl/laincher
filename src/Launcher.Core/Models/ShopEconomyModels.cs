namespace Launcher.Core.Models;

public sealed record OwnedShopItem(string ItemId, string Name, string Type, long AcquiredAt, long? ExpiresAt);
public sealed record CaseInventoryCount(string CaseId, int Count);
public sealed record WalletLedgerEntry(string Id, int Delta, string Reason, string? Reference, int BalanceAfter, long Timestamp);
public sealed record WalletSnapshot(int Coins, long UpdatedAt, IReadOnlyList<OwnedShopItem> Owned,
    IReadOnlyList<CaseInventoryCount> Cases, IReadOnlyDictionary<string, string> Equipped,
    IReadOnlyList<WalletLedgerEntry> Ledger);
public sealed record WalletPurchaseResult(string ItemId, string RequestId, int CoinsRefunded, int Balance);
public sealed record CaseOpenResult(string CaseId, string RequestId, string Kind, string? ItemId, int? Coins,
    bool Duplicate, int CoinsRefunded, int? Balance);
