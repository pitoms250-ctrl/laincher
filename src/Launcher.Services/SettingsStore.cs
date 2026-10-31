using System.Text.Json;

namespace Launcher.Services;

public sealed class UserSettings
{
    public string Nickname { get; set; } = "Player";
    public int XmxMb { get; set; } = 4096;
    public string JvmArgs { get; set; } = "";
    public bool ShowSnapshots { get; set; }
    public bool ShowOld { get; set; }
    public string? LastVersion { get; set; }
    public string? GameDirectory { get; set; }      // null → ещё не выбирали
    public bool WelcomeSeen { get; set; }
    public bool ShareDiagnostics { get; set; }
    public string ContactEmail { get; set; } = "";
    public bool ContactEmailConsent { get; set; }
    public int LaunchCount { get; set; }
    public double TotalPlayMinutes { get; set; }
    public string? LastModLoader { get; set; }
    public string? InstallId { get; set; }
    public string? ProfilePhotoPath { get; set; }
}

/// <summary>Настройки лежат в фиксированном месте (%APPDATA%\.fluncher), чтобы работали и до выбора папки игры.</summary>
public sealed class SettingsStore
{
    private static readonly string Dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ".fluncher");
    private static readonly string FilePath = Path.Combine(Dir, "settings.json");

    public UserSettings Load()
    {
        try { return File.Exists(FilePath) ? JsonSerializer.Deserialize<UserSettings>(File.ReadAllText(FilePath)) ?? new() : new(); }
        catch { return new(); }
    }

    public void Save(UserSettings s)
    {
        Directory.CreateDirectory(Dir);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(s, new JsonSerializerOptions { WriteIndented = true }));
    }
}
