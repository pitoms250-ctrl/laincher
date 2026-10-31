namespace Launcher.Shared;

public sealed class LauncherOptions
{
    public string GameDirectory { get; set; } = "%APPDATA%\\.fluncher";
    public string ManifestUrl { get; set; } = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    public string ResourcesUrl { get; set; } = "https://resources.download.minecraft.net";
    public string AdoptiumApi { get; set; } = "https://api.adoptium.net";
    public string NewsUrl { get; set; } = "https://launchercontent.mojang.com/news.json";
    public int NewsCacheMinutes { get; set; } = 60;
    public string ServerStatusApi { get; set; } = "https://api.mcstatus.io/v2/status/java";
    public string MicrosoftClientId { get; set; } = "";
    public string FirebaseApiKey { get; set; } = "";
    public string FirebaseDatabaseUrl { get; set; } = "";
    public string FunctionsBaseUrl { get; set; } = "https://europe-west1-furry-launcher.cloudfunctions.net";
    public string TelegramBotUsername { get; set; } = "launcher_Payment_bot";
    public bool RequireZbtKey { get; set; } = false;
    public int MaxParallelDownloads { get; set; } = 8;
    public int DefaultXmxMb { get; set; } = 4096;
    public string UpdateManifestUrl { get; set; } = "";
    public List<string> DefaultServers { get; set; } = new();
}
