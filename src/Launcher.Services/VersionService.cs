using System.Text.Json;
using Launcher.Core;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class VersionService : IVersionService
{
    private readonly IDownloadService _dl;
    private readonly LauncherPaths _paths;
    private readonly LauncherOptions _opt;
    private readonly ILogger<VersionService> _log;
    private VersionManifest? _manifest;

    public VersionService(IDownloadService dl, LauncherPaths paths, IOptions<LauncherOptions> opt, ILogger<VersionService> log)
    { _dl = dl; _paths = paths; _opt = opt.Value; _log = log; }

    public async Task<VersionManifest> GetManifestAsync(bool force = false, CancellationToken ct = default)
    {
        if (_manifest is not null && !force) return _manifest;
        var cacheFile = Path.Combine(_paths.Cache, "version_manifest_v2.json");
        try
        {
            var json = await _dl.GetStringAsync(_opt.ManifestUrl, ct);
            Directory.CreateDirectory(_paths.Cache);
            await File.WriteAllTextAsync(cacheFile, json, ct);
            _manifest = JsonSerializer.Deserialize<VersionManifest>(json)!;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && File.Exists(cacheFile))
        {
            _log.LogWarning(ex, "Нет сети — используем кэш манифеста");
            _manifest = JsonSerializer.Deserialize<VersionManifest>(await File.ReadAllTextAsync(cacheFile, ct))!;
        }
        return _manifest!;
    }

    public IReadOnlyList<VersionEntry> Filter(IEnumerable<VersionEntry> all, VersionFilter f)
    {
        var q = all.Where(v => f.Types.Count == 0 || f.Types.Contains(v.Type));
        if (!string.IsNullOrWhiteSpace(f.Search))
            q = q.Where(v => v.Id.Contains(f.Search.Trim(), StringComparison.OrdinalIgnoreCase));
        return (f.NewestFirst ? q.OrderByDescending(v => v.ReleaseTime) : q.OrderBy(v => v.ReleaseTime)).ToList();
    }

    public async Task<VersionDetails> GetDetailsAsync(VersionEntry e, CancellationToken ct = default)
    {
        var path = Path.Combine(_paths.Versions, e.Id, e.Id + ".json");
        await _dl.DownloadFileAsync(e.Url, path, string.IsNullOrEmpty(e.Sha1) ? null : e.Sha1, null, ct);
        var d = JsonSerializer.Deserialize<VersionDetails>(await File.ReadAllTextAsync(path, ct))
                ?? throw new InvalidDataException($"Не удалось разобрать {e.Id}.json");
        if (d.InheritsFrom is not null)
            _log.LogWarning("Версия {Id} наследует {Parent}: профили Forge/Fabric пока не поддерживаются", d.Id, d.InheritsFrom);
        return d;
    }

    public string ClientJarPath(VersionDetails d) => Path.Combine(_paths.Versions, d.Id, d.Id + ".jar");

    public IReadOnlyList<LibraryFile> ResolveLibraries(VersionDetails d)
    {
        var list = new List<LibraryFile>();
        foreach (var lib in d.Libraries)
        {
            if (!RuleEvaluator.IsAllowed(lib.Rules)) continue;
            var dl = lib.Downloads;
            if (dl is null) { _log.LogWarning("Библиотека {Name} без downloads — пропущена", lib.Name); continue; }

            if (dl.Artifact is { Url.Length: > 0 } a)
                list.Add(new LibraryFile(a.Path, a.Url, a.Sha1, a.Size, false));

            // Старый формат natives (до 1.19): classifiers["natives-windows"], не в classpath, а в natives-папку
            if (lib.Natives is not null && lib.Natives.TryGetValue("windows", out var cls) && dl.Classifiers is not null)
            {
                cls = cls.Replace("${arch}", Environment.Is64BitOperatingSystem ? "64" : "32");
                if (dl.Classifiers.TryGetValue(cls, out var n))
                    list.Add(new LibraryFile(n.Path, n.Url, n.Sha1, n.Size, true));
            }
        }
        return list;
    }

    public async Task InstallAsync(VersionDetails d, IProgress<InstallProgress>? progress, CancellationToken ct = default)
    {
        var client = d.Downloads?.Client ?? throw new InvalidDataException("В JSON версии нет downloads.client");
        var idx = d.AssetIndex ?? throw new InvalidDataException("В JSON версии нет assetIndex");

        var items = new List<DownloadItem> { new(client.Url, ClientJarPath(d), client.Sha1, client.Size) };
        foreach (var l in ResolveLibraries(d))
            items.Add(new(l.Url, Path.Combine(_paths.Libraries, l.Path.Replace('/', Path.DirectorySeparatorChar)), l.Sha1, l.Size));

        var idxPath = Path.Combine(_paths.AssetIndexes, idx.Id + ".json");
        await _dl.DownloadFileAsync(idx.Url, idxPath, idx.Sha1, null, ct);
        var index = JsonSerializer.Deserialize<AssetIndex>(await File.ReadAllTextAsync(idxPath, ct))!;
        foreach (var (_, o) in index.Objects)
            items.Add(new($"{_opt.ResourcesUrl}/{o.Hash[..2]}/{o.Hash}", Path.Combine(_paths.AssetObjects, o.Hash[..2], o.Hash), o.Hash, o.Size));

        long total = Math.Max(1, items.Sum(i => i.Size)), done = 0, lastReport = 0;
        progress?.Report(new("Загрузка файлов", 0));

        await Parallel.ForEachAsync(items,
            new ParallelOptions { MaxDegreeOfParallelism = Math.Max(1, _opt.MaxParallelDownloads), CancellationToken = ct },
            async (it, token) =>
            {
                var p = new SyncProgress<long>(n =>
                {
                    var cur = Interlocked.Add(ref done, n);
                    var now = Environment.TickCount64; var prev = Interlocked.Read(ref lastReport);
                    if (now - prev >= 120 && Interlocked.CompareExchange(ref lastReport, now, prev) == prev)
                        progress?.Report(new("Загрузка файлов", Math.Min(1, (double)cur / total)));
                });
                await _dl.DownloadFileAsync(it.Url, it.Path, it.Sha1, p, token);
            });

        if (index.Virtual) // pre-1.7 ассеты: assets/virtual/<id>/<name>
            foreach (var (name, o) in index.Objects)
            {
                var dst = Path.Combine(_paths.Assets, "virtual", idx.Id, name.Replace('/', Path.DirectorySeparatorChar));
                if (File.Exists(dst)) continue;
                Directory.CreateDirectory(Path.GetDirectoryName(dst)!);
                File.Copy(Path.Combine(_paths.AssetObjects, o.Hash[..2], o.Hash), dst);
            }
        progress?.Report(new("Готово", 1));
    }
}
