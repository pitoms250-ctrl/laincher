using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Win32;

namespace Launcher.Services;

public sealed class JavaService : IJavaService
{
    private readonly IDownloadService _dl;
    private readonly LauncherPaths _paths;
    private readonly LauncherOptions _opt;
    private readonly ILogger<JavaService> _log;
    private readonly SemaphoreSlim _lock = new(1, 1);
    private List<JavaInstall>? _cache;

    public JavaService(IDownloadService dl, LauncherPaths paths, IOptions<LauncherOptions> opt, ILogger<JavaService> log)
    { _dl = dl; _paths = paths; _opt = opt.Value; _log = log; }

    /// <summary>Берём javaVersion.majorVersion из JSON версии; у старых версий (до 1.17) поля нет → Java 8.</summary>
    public int GetRequiredMajor(VersionDetails d) =>
        d.JavaVersion is { MajorVersion: > 0 } jv ? jv.MajorVersion : 8;

    public static int ParseMajor(string version)
    {
        var m = Regex.Match(version.Trim(), @"^(?<a>\d+)(?:\.(?<b>\d+))?");
        if (!m.Success) return 0;
        int a = int.Parse(m.Groups["a"].Value);
        return a == 1 && m.Groups["b"].Success ? int.Parse(m.Groups["b"].Value) : a; // 1.8.0_392 → 8
    }

    public async Task<IReadOnlyList<JavaInstall>> FindInstalledAsync(bool force, CancellationToken ct = default)
    {
        if (!force && _cache is not null) return _cache;
        var homes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase); // home → source

        void Add(string? h, string src) { if (!string.IsNullOrWhiteSpace(h)) homes.TryAdd(h.TrimEnd('\\', '/'), src); }

        if (Directory.Exists(_paths.Runtime))
            foreach (var d in Directory.GetDirectories(_paths.Runtime)) Add(d, "launcher");

        Add(Environment.GetEnvironmentVariable("JAVA_HOME"), "JAVA_HOME");

        var roots = new[] { Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("ProgramFiles(x86)") };
        var vendors = new[] { "Java", "Eclipse Adoptium", "Eclipse Foundation", "Zulu", "Microsoft", "BellSoft", "Amazon Corretto", "Semeru", "AdoptOpenJDK" };
        foreach (var root in roots.Where(r => r is not null))
            foreach (var v in vendors)
            {
                var vd = Path.Combine(root!, v);
                if (Directory.Exists(vd))
                    foreach (var d in Directory.GetDirectories(vd)) Add(d, v);
            }

        if (OperatingSystem.IsWindows())
            foreach (var h in ReadRegistryHomes()) Add(h, "registry");

        var result = new List<JavaInstall>();
        foreach (var (home, src) in homes)
        {
            ct.ThrowIfCancellationRequested();
            var inst = await ProbeAsync(home, src, ct);
            if (inst is not null) result.Add(inst);
        }
        _cache = result;
        _log.LogInformation("Найдено Java: {Count} ({List})", result.Count, string.Join(", ", result.Select(r => $"{r.Major}@{r.Source}")));
        return result;
    }

    [System.Runtime.Versioning.SupportedOSPlatform("windows")]
    private static IEnumerable<string> ReadRegistryHomes()
    {
        var found = new List<string>();
        foreach (var view in new[] { RegistryView.Registry64, RegistryView.Registry32 })
        {
            try
            {
                using var hklm = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                foreach (var key in new[] { @"SOFTWARE\JavaSoft\Java Runtime Environment", @"SOFTWARE\JavaSoft\JRE", @"SOFTWARE\JavaSoft\Java Development Kit", @"SOFTWARE\JavaSoft\JDK" })
                {
                    using var k = hklm.OpenSubKey(key);
                    if (k is null) continue;
                    foreach (var sub in k.GetSubKeyNames())
                    {
                        using var s = k.OpenSubKey(sub);
                        if (s?.GetValue("JavaHome") is string jh) found.Add(jh);
                    }
                }
            }
            catch { /* реестр недоступен — не критично */ }
        }
        return found;
    }

    private async Task<JavaInstall?> ProbeAsync(string home, string source, CancellationToken ct)
    {
        var exe = Path.Combine(home, "bin", "java.exe");
        if (!File.Exists(exe)) return null;
        string? ver = null;
        var rel = Path.Combine(home, "release");
        if (File.Exists(rel))
            foreach (var line in File.ReadLines(rel))
            {
                var m = Regex.Match(line, "^JAVA_VERSION=\"(.+)\"");
                if (m.Success) { ver = m.Groups[1].Value; break; }
            }
        ver ??= await RunJavaVersionAsync(exe, ct);
        return ver is null ? null : new JavaInstall(home, exe, ParseMajor(ver), ver, source);
    }

    private static async Task<string?> RunJavaVersionAsync(string exe, CancellationToken ct)
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo(exe, "-version") { RedirectStandardError = true, UseShellExecute = false, CreateNoWindow = true });
            if (p is null) return null;
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(TimeSpan.FromSeconds(5));
            var err = await p.StandardError.ReadToEndAsync(cts.Token);
            var m = Regex.Match(err, "version \"([^\"]+)\"");
            return m.Success ? m.Groups[1].Value : null;
        }
        catch { return null; }
    }

    private static JavaInstall? Pick(IEnumerable<JavaInstall> all, int major) =>
        all.Where(j => j.Major == major).OrderByDescending(j => j.Source == "launcher").FirstOrDefault();

    public async Task<JavaCheckResult> CheckAsync(int major, CancellationToken ct = default)
    {
        var inst = Pick(await FindInstalledAsync(false, ct), major);
        return inst is null ? new(JavaState.NotFound, major, null) : new(JavaState.Found, major, inst);
    }

    /// <summary>Нужная мажорная версия: найти → иначе скачать Temurin JRE в /runtime/java-N. Системную Java не трогаем.</summary>
    public async Task<JavaCheckResult> EnsureJavaAsync(int major, IProgress<InstallProgress>? progress, CancellationToken ct = default)
    {
        await _lock.WaitAsync(ct);
        try
        {
            var check = await CheckAsync(major, ct);
            if (check.State == JavaState.Found) return check;

            _log.LogInformation("Java {Major} не найдена — устанавливаем Temurin JRE", major);
            await InstallTemurinAsync(major, progress, ct);
            var all = await FindInstalledAsync(true, ct);
            var inst = Pick(all, major) ?? throw new InvalidOperationException($"Java {major} установлена, но не определилась.");
            return new(JavaState.Installed, major, inst);
        }
        finally { _lock.Release(); }
    }

    private async Task InstallTemurinAsync(int major, IProgress<InstallProgress>? progress, CancellationToken ct)
    {
        // Adoptium API v3: список последних GA-сборок JRE для Windows x64 + ссылка и SHA-256
        var api = $"{_opt.AdoptiumApi}/v3/assets/latest/{major}/hotspot?architecture=x64&image_type=jre&os=windows";
        using var doc = JsonDocument.Parse(await _dl.GetStringAsync(api, ct));
        var pkg = doc.RootElement[0].GetProperty("binary").GetProperty("package");
        var link = pkg.GetProperty("link").GetString()!;
        var sha256 = pkg.GetProperty("checksum").GetString()!;
        long total = Math.Max(1, pkg.GetProperty("size").GetInt64());

        Directory.CreateDirectory(_paths.Cache);
        var zip = Path.Combine(_paths.Cache, $"temurin-{major}.zip");
        if (File.Exists(zip)) File.Delete(zip);

        long done = 0, last = 0;
        await _dl.DownloadFileAsync(link, zip, null,
            new SyncProgress<long>(n => { done += n; if (Environment.TickCount64 - last < 120) return; last = Environment.TickCount64; progress?.Report(new($"Скачивание Java {major}", Math.Min(1, (double)done / total))); }), ct);

        await using (var fs = File.OpenRead(zip))
        {
            var actual = Convert.ToHexString(await SHA256.HashDataAsync(fs, ct));
            if (!actual.Equals(sha256, StringComparison.OrdinalIgnoreCase))
            {
                fs.Close(); File.Delete(zip);
                throw new InvalidDataException("SHA-256 архива Java не совпал.");
            }
        }

        progress?.Report(new($"Распаковка Java {major}", 1));
        var target = Path.Combine(_paths.Runtime, $"java-{major}");
        var staging = target + ".staging";
        if (Directory.Exists(staging)) Directory.Delete(staging, true);
        await Task.Run(() => ZipFile.ExtractToDirectory(zip, staging), ct);

        var inner = Directory.GetDirectories(staging).Single(); // jdk-17.0.x+y-jre
        if (Directory.Exists(target)) Directory.Delete(target, true);
        Directory.CreateDirectory(_paths.Runtime);
        Directory.Move(inner, target);
        Directory.Delete(staging, true);
        File.Delete(zip);
    }
}
