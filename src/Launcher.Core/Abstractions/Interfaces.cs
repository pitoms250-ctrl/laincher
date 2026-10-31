using Launcher.Core.Models;

namespace Launcher.Core.Abstractions;

public interface IDownloadService
{
    /// <summary>Скачивает файл с докачкой (.part + Range), проверкой SHA1 и 3 попытками. progress получает прирост в байтах.</summary>
    Task DownloadFileAsync(string url, string destination, string? sha1 = null, IProgress<long>? progress = null, CancellationToken ct = default);
    Task<string> GetStringAsync(string url, CancellationToken ct = default);
    Task<T?> GetJsonAsync<T>(string url, CancellationToken ct = default);
}

public interface IJavaService
{
    int GetRequiredMajor(VersionDetails details);
    Task<IReadOnlyList<JavaInstall>> FindInstalledAsync(bool force, CancellationToken ct = default);
    Task<JavaCheckResult> CheckAsync(int major, CancellationToken ct = default);
    Task<JavaCheckResult> EnsureJavaAsync(int major, IProgress<InstallProgress>? progress, CancellationToken ct = default);
}

public interface IVersionService
{
    Task<VersionManifest> GetManifestAsync(bool force = false, CancellationToken ct = default);
    IReadOnlyList<VersionEntry> Filter(IEnumerable<VersionEntry> all, VersionFilter filter);
    Task<VersionDetails> GetDetailsAsync(VersionEntry entry, CancellationToken ct = default);
    IReadOnlyList<LibraryFile> ResolveLibraries(VersionDetails details);
    Task InstallAsync(VersionDetails details, IProgress<InstallProgress>? progress, CancellationToken ct = default);
    string ClientJarPath(VersionDetails details);
}

public interface ILaunchService
{
    event Action<string>? LogReceived;
    bool IsRunning { get; }
    List<string> BuildArguments(VersionDetails details, LaunchContext ctx, string nativesDir);
    Task<int> LaunchAsync(VersionDetails details, LaunchContext ctx, CancellationToken ct = default);
    void Stop();
}

public interface IAuthService
{
    AuthSession CreateOffline(string nickname);
    Task<DeviceCodeInfo> StartDeviceFlowAsync(CancellationToken ct = default);
    Task<AuthSession> CompleteDeviceFlowAsync(DeviceCodeInfo info, CancellationToken ct = default);
    MicrosoftOAuthRequest CreateMicrosoftOAuthRequest();
    Task<AuthSession> CompleteMicrosoftOAuthAsync(MicrosoftOAuthRequest request, Uri callbackUri, CancellationToken ct = default);
    Task<AuthSession?> TryRestoreAsync(CancellationToken ct = default);
    Task<AuthSession> GetOrCreateFirebaseGuestSessionAsync(CancellationToken ct = default);
    Task<AuthSession> RefreshFirebaseTokenAsync(AuthSession session, CancellationToken ct = default, bool force = false);
    Task SignOutAsync();
}

public interface ICloudApiService
{
    bool IsConfigured { get; }
    Task<ZbtAccessResult> CheckZbtAccessAsync(AuthSession session, string installId, CancellationToken ct = default);
    Task<ZbtAccessResult> RedeemZbtKeyAsync(AuthSession session, string key, string installId, CancellationToken ct = default);
    Task<IReadOnlyList<NewsItem>> GetLauncherNewsAsync(AuthSession session, CancellationToken ct = default);
    Task<bool> SetPlayerContactAsync(AuthSession session, string email, bool consent, CancellationToken ct = default);
    Task<bool> SetDiagnosticsConsentAsync(AuthSession session, bool consent, CancellationToken ct = default);
}

public interface IRealtimeDatabaseService
{
    Task<bool?> GetZbtEnabledAsync(CancellationToken ct = default);
    Task WatchZbtEnabledAsync(Action<bool?> onChanged, CancellationToken ct = default);
    Task<ZbtAccessResult> PreviewZbtKeyAsync(AuthSession session, string key, CancellationToken ct = default);
    Task<ZbtAccessResult> CheckZbtAccessAsync(AuthSession session, string installId, CancellationToken ct = default);
    Task<ZbtAccessResult> RedeemZbtKeyAsync(AuthSession session, string key, string installId, CancellationToken ct = default);
    Task RegisterPlayerAsync(AuthSession session, string nickname, string locale, int launchCount = 0,
        double totalPlayMinutes = 0, string? lastVersion = null, CancellationToken ct = default);
    Task<bool> IsPlayerBannedAsync(AuthSession session, CancellationToken ct = default);
    Task SetPresenceAsync(AuthSession session, string state, string launcherVersion, string? gameVersion = null, CancellationToken ct = default);
    Task RecordEventAsync(AuthSession session, string eventType, string area, string locale, string launcherVersion,
        string? gameVersion = null, CancellationToken ct = default);
    Task ReportErrorAsync(AuthSession session, string area, string title, string description, string locale,
        string launcherVersion, string? gameVersion = null, string? stack = null, CancellationToken ct = default);
}

public interface IShopService
{
    Task<IReadOnlyList<ShopItem>> GetItemsAsync(AuthSession session, CancellationToken ct = default);
    Task WatchItemsAsync(AuthSession session, Action<IReadOnlyList<ShopItem>> onChanged, CancellationToken ct = default);
    Task<ShopOrderResult> CreateOrderAsync(AuthSession session, string itemId, string paymentMethod, string? tag = null, CancellationToken ct = default);
    Task<string> GetOrderStatusAsync(AuthSession session, string orderId, CancellationToken ct = default);
}

public interface IWalletService
{
    Task<WalletSnapshot> GetSnapshotAsync(AuthSession session, CancellationToken ct = default);
    Task<WalletPurchaseResult> PurchaseWithCoinsAsync(AuthSession session, string itemId, string requestId, CancellationToken ct = default);
    Task<CaseOpenResult> OpenCaseAsync(AuthSession session, string caseId, string requestId, CancellationToken ct = default);
    Task WatchBalanceAsync(AuthSession session, Action<int> onChanged, CancellationToken ct = default);
}

public interface ITokenStore
{
    Task SaveAsync(StoredAccount account, CancellationToken ct = default);
    Task<StoredAccount?> LoadAsync(CancellationToken ct = default);
    Task ClearAsync();
}

public interface IFirebaseGuestTokenStore
{
    Task SaveAsync(StoredFirebaseGuestAccount account, CancellationToken ct = default);
    Task<StoredFirebaseGuestAccount?> LoadAsync(CancellationToken ct = default);
    Task ClearAsync();
}

public interface INewsService { Task<IReadOnlyList<NewsItem>> GetNewsAsync(bool force = false, CancellationToken ct = default); }

public interface IServerService
{
    Task<ServerStatus> GetStatusAsync(string name, string address, CancellationToken ct = default);
    Task<IReadOnlyList<ServerStatus>> GetDefaultsAsync(CancellationToken ct = default);
    Task AddCustomAsync(ServerInfo server, CancellationToken ct = default);
}

public interface IModService
{
    Task<IReadOnlyList<ModHit>> SearchAsync(string query, string? gameVersion, string? loader, string projectType = "mod", string sort = "relevance", CancellationToken ct = default);
    /// <summary>Скачивает последнюю подходящую версию мода (и обязательные зависимости) в папку mods. Возвращает имена файлов.</summary>
    Task<IReadOnlyList<string>> InstallAsync(string projectId, string? gameVersion, string? loader, string modsDir, CancellationToken ct = default);
}

public interface ISkinService
{
    Task<byte[]?> DownloadByNickAsync(string nickname, CancellationToken ct = default);
    Task UploadAsync(AuthSession session, byte[] png, bool slim, CancellationToken ct = default);
}
