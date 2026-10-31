using System.Text.Json;
using System.Text.Json.Serialization;

namespace Launcher.Core.Models;

public sealed class VersionManifest
{
    [JsonPropertyName("latest")] public LatestInfo Latest { get; set; } = new();
    [JsonPropertyName("versions")] public List<VersionEntry> Versions { get; set; } = new();
}
public sealed class LatestInfo
{
    [JsonPropertyName("release")] public string Release { get; set; } = "";
    [JsonPropertyName("snapshot")] public string Snapshot { get; set; } = "";
}
public sealed class VersionEntry
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "";   // release | snapshot | old_beta | old_alpha
    [JsonPropertyName("url")] public string Url { get; set; } = "";
    [JsonPropertyName("sha1")] public string Sha1 { get; set; } = "";
    [JsonPropertyName("releaseTime")] public DateTimeOffset ReleaseTime { get; set; }
    [JsonIgnore] public string ReleaseDate => ReleaseTime.ToString("dd.MM.yyyy");
    public override string ToString() => $"{Id} ({Type})";
}

public sealed class VersionDetails
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("type")] public string Type { get; set; } = "";
    [JsonPropertyName("mainClass")] public string MainClass { get; set; } = "";
    [JsonPropertyName("minecraftArguments")] public string? MinecraftArguments { get; set; }
    [JsonPropertyName("arguments")] public ArgumentsSection? Arguments { get; set; }
    [JsonPropertyName("assets")] public string Assets { get; set; } = "legacy";
    [JsonPropertyName("assetIndex")] public AssetIndexInfo? AssetIndex { get; set; }
    [JsonPropertyName("downloads")] public DownloadsSection? Downloads { get; set; }
    [JsonPropertyName("libraries")] public List<Library> Libraries { get; set; } = new();
    [JsonPropertyName("javaVersion")] public JavaVersionInfo? JavaVersion { get; set; }
    [JsonPropertyName("inheritsFrom")] public string? InheritsFrom { get; set; }
}
public sealed class ArgumentsSection
{
    [JsonPropertyName("game")] public List<JsonElement> Game { get; set; } = new();
    [JsonPropertyName("jvm")] public List<JsonElement> Jvm { get; set; } = new();
}
public sealed class JavaVersionInfo
{
    [JsonPropertyName("component")] public string Component { get; set; } = "";
    [JsonPropertyName("majorVersion")] public int MajorVersion { get; set; }
}
public sealed class AssetIndexInfo
{
    [JsonPropertyName("id")] public string Id { get; set; } = "";
    [JsonPropertyName("sha1")] public string Sha1 { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
    [JsonPropertyName("url")] public string Url { get; set; } = "";
}
public sealed class DownloadsSection
{
    [JsonPropertyName("client")] public ArtifactInfo? Client { get; set; }
}
public sealed class Library
{
    [JsonPropertyName("name")] public string Name { get; set; } = "";
    [JsonPropertyName("downloads")] public LibraryDownloads? Downloads { get; set; }
    [JsonPropertyName("natives")] public Dictionary<string, string>? Natives { get; set; }
    [JsonPropertyName("rules")] public List<Rule>? Rules { get; set; }
}
public sealed class LibraryDownloads
{
    [JsonPropertyName("artifact")] public ArtifactInfo? Artifact { get; set; }
    [JsonPropertyName("classifiers")] public Dictionary<string, ArtifactInfo>? Classifiers { get; set; }
}
public sealed class ArtifactInfo
{
    [JsonPropertyName("path")] public string Path { get; set; } = "";
    [JsonPropertyName("sha1")] public string Sha1 { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
    [JsonPropertyName("url")] public string Url { get; set; } = "";
}
public sealed class Rule
{
    [JsonPropertyName("action")] public string Action { get; set; } = "allow";
    [JsonPropertyName("os")] public RuleOs? Os { get; set; }
    [JsonPropertyName("features")] public Dictionary<string, bool>? Features { get; set; }
}
public sealed class RuleOs
{
    [JsonPropertyName("name")] public string? Name { get; set; }
    [JsonPropertyName("arch")] public string? Arch { get; set; }
    [JsonPropertyName("version")] public string? Version { get; set; }
}
public sealed class AssetIndex
{
    [JsonPropertyName("objects")] public Dictionary<string, AssetObject> Objects { get; set; } = new();
    [JsonPropertyName("virtual")] public bool Virtual { get; set; }
}
public sealed class AssetObject
{
    [JsonPropertyName("hash")] public string Hash { get; set; } = "";
    [JsonPropertyName("size")] public long Size { get; set; }
}

public sealed record LibraryFile(string Path, string Url, string Sha1, long Size, bool Extract);
public sealed record DownloadItem(string Url, string Path, string? Sha1, long Size);
public readonly record struct InstallProgress(string Stage, double Fraction);
public sealed record VersionFilter(ISet<string> Types, string? Search = null, bool NewestFirst = true);
