namespace Launcher.Core.Models;

public sealed record JavaInstall(string Home, string JavaExe, int Major, string Version, string Source);
public enum JavaState { Found, NotFound, Installed }
public sealed record JavaCheckResult(JavaState State, int Major, JavaInstall? Install)
{
    public string Message => State switch
    {
        JavaState.Found => $"Java {Major} найдена",
        JavaState.Installed => $"Java {Major} установлена",
        _ => $"Java {Major} не найдена"
    };
}

public sealed record AuthSession(string Username, string Uuid, string AccessToken, bool IsOffline, string? RefreshToken = null,
    string? FirebaseUid = null, string? FirebaseIdToken = null, string? FirebaseRefreshToken = null,
    DateTimeOffset? FirebaseIdTokenExpiresAtUtc = null, string? Email = null, bool HasMinecraftLicense = false,
    string? XboxGamertag = null)
{
    public string UserType => IsOffline ? "legacy" : "msa";
}
public sealed record DeviceCodeInfo(string DeviceCode, string UserCode, string VerificationUri, int ExpiresIn, int Interval, string Message);
public sealed record MicrosoftOAuthRequest(Uri AuthorizationUri, string RedirectUri, string State, string CodeVerifier);
public sealed record StoredAccount(string Username, string Uuid, string RefreshToken, string? Email = null);
public sealed record StoredFirebaseGuestAccount(string Uid, string RefreshToken);

public sealed record ServerInfo(string Name, string Address);
public sealed class ServerStatus
{
    public string Name { get; set; } = "";
    public string Address { get; set; } = "";
    public bool Online { get; set; }
    public int Players { get; set; }
    public int MaxPlayers { get; set; }
    public string Version { get; set; } = "";
    public string Motd { get; set; } = "";
    public string? IconDataUrl { get; set; }
    public long PingMs { get; set; }
}
public sealed record NewsItem(string Title, DateTime Date, string? ImageUrl, string Description, string? Url);

public sealed record LaunchContext(AuthSession Session, JavaInstall Java, int XmxMb, int XmsMb, string? ExtraJvmArgs = null, ServerInfo? Server = null);

public sealed record ModHit(string Id, string Title, string Description, string Author, long Downloads, string? IconUrl);
