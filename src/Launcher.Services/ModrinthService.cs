using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Microsoft.Extensions.Logging;

namespace Launcher.Services;

/// <summary>Modrinth API v2 (https://docs.modrinth.com/api/) — открытый, без ключа, с прямыми ссылками на файлы и SHA1.</summary>
public sealed class ModrinthService : IModService
{
    private const string Api = "https://api.modrinth.com/v2";
    private readonly IDownloadService _dl;
    private readonly ILogger<ModrinthService> _log;
    public ModrinthService(IDownloadService dl, ILogger<ModrinthService> log) { _dl = dl; _log = log; }

    public async Task<IReadOnlyList<ModHit>> SearchAsync(string query, string? gameVersion, string? loader,
        string projectType = "mod", string sort = "relevance", CancellationToken ct = default)
    {
        var facets = new List<string> { $"[\"project_type:{projectType}\"]" };
        if (!string.IsNullOrEmpty(gameVersion)) facets.Add($"[\"versions:{gameVersion}\"]");
        if (!string.IsNullOrEmpty(loader)) facets.Add($"[\"categories:{loader}\"]");
        var url = $"{Api}/search?query={Uri.EscapeDataString(query ?? "")}&limit=24&index={sort}&facets={Uri.EscapeDataString("[" + string.Join(",", facets) + "]")}";

        using var doc = JsonDocument.Parse(await _dl.GetStringAsync(url, ct));
        var list = new List<ModHit>();
        foreach (var h in doc.RootElement.GetProperty("hits").EnumerateArray())
        {
            string? Str(string n) => h.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            list.Add(new ModHit(Str("project_id") ?? "", Str("title") ?? "", Str("description") ?? "", Str("author") ?? "",
                h.TryGetProperty("downloads", out var d) ? d.GetInt64() : 0, Str("icon_url")));
        }
        return list;
    }

    public async Task<IReadOnlyList<string>> InstallAsync(string projectId, string? gameVersion, string? loader, string modsDir, CancellationToken ct = default)
    {
        var installed = new List<string>();
        await InstallCoreAsync(projectId, gameVersion, loader, modsDir, installed, new HashSet<string>(), 0, ct);
        return installed;
    }

    private async Task InstallCoreAsync(string projectId, string? gv, string? loader, string dir, List<string> done, HashSet<string> seen, int depth, CancellationToken ct)
    {
        if (!seen.Add(projectId) || depth > 2) return;
        var q = new List<string>();
        if (!string.IsNullOrEmpty(gv)) q.Add("game_versions=" + Uri.EscapeDataString($"[\"{gv}\"]"));
        if (!string.IsNullOrEmpty(loader)) q.Add("loaders=" + Uri.EscapeDataString($"[\"{loader}\"]"));
        var url = $"{Api}/project/{projectId}/version" + (q.Count > 0 ? "?" + string.Join("&", q) : "");

        using var doc = JsonDocument.Parse(await _dl.GetStringAsync(url, ct));
        if (doc.RootElement.GetArrayLength() == 0)
            throw new InvalidOperationException("Нет версии мода для выбранной версии игры и загрузчика.");
        var ver = doc.RootElement[0];

        var files = ver.GetProperty("files");
        var file = files.EnumerateArray().FirstOrDefault(f => f.TryGetProperty("primary", out var p) && p.GetBoolean());
        if (file.ValueKind == JsonValueKind.Undefined) file = files[0];
        var name = file.GetProperty("filename").GetString()!;
        var sha1 = file.GetProperty("hashes").TryGetProperty("sha1", out var h) ? h.GetString() : null;

        await _dl.DownloadFileAsync(file.GetProperty("url").GetString()!, Path.Combine(dir, name), sha1, null, ct);
        done.Add(name);
        _log.LogInformation("Мод скачан: {Name}", name);

        if (ver.TryGetProperty("dependencies", out var deps))
            foreach (var dep in deps.EnumerateArray())
                if (dep.TryGetProperty("dependency_type", out var t) && t.GetString() == "required"
                    && dep.TryGetProperty("project_id", out var pid) && pid.ValueKind == JsonValueKind.String)
                    await InstallCoreAsync(pid.GetString()!, gv, loader, dir, done, seen, depth + 1, ct);
    }
}
