using System.Diagnostics;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Launcher.Core;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;

namespace Launcher.Services;

public sealed partial class LaunchService : ILaunchService
{
    public const string LauncherName = "FLauncher";
    public const string LauncherVersion = "1.0.0";

    private readonly IVersionService _versions;
    private readonly LauncherPaths _paths;
    private readonly ILogger<LaunchService> _log;
    private Process? _proc;

    public event Action<string>? LogReceived;
    public bool IsRunning => _proc is { HasExited: false };

    public LaunchService(IVersionService versions, LauncherPaths paths, ILogger<LaunchService> log)
    { _versions = versions; _paths = paths; _log = log; }

    public async Task<int> LaunchAsync(VersionDetails d, LaunchContext ctx, CancellationToken ct = default)
    {
        if (IsRunning) throw new InvalidOperationException("Игра уже запущена.");

        var natives = Path.Combine(_paths.Versions, d.Id, "natives-" + Guid.NewGuid().ToString("N")[..8]);
        Directory.CreateDirectory(natives);
        Directory.CreateDirectory(_paths.Game);
        ExtractNatives(d, natives);

        var psi = new ProcessStartInfo(ctx.Java.JavaExe)
        {
            WorkingDirectory = _paths.Game,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var a in BuildArguments(d, ctx, natives)) psi.ArgumentList.Add(a);

        _log.LogInformation("Запуск {Version} через {Java}", d.Id, ctx.Java.JavaExe);
        var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
        p.OutputDataReceived += (_, e) => { if (e.Data is not null) LogReceived?.Invoke(e.Data); };
        p.ErrorDataReceived += (_, e) => { if (e.Data is not null) LogReceived?.Invoke(e.Data); };
        p.Start();
        p.BeginOutputReadLine();
        p.BeginErrorReadLine();
        _proc = p;

        try
        {
            await p.WaitForExitAsync(ct);
            return p.ExitCode;
        }
        catch (OperationCanceledException) { Stop(); throw; }
        finally { TryDelete(natives); _proc = null; }
    }

    public void Stop()
    {
        try { if (IsRunning) _proc!.Kill(entireProcessTree: true); }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось остановить процесс"); }
    }

    public List<string> BuildArguments(VersionDetails d, LaunchContext ctx, string nativesDir)
    {
        var libs = _versions.ResolveLibraries(d).Where(l => !l.Extract)
            .Select(l => Path.Combine(_paths.Libraries, l.Path.Replace('/', Path.DirectorySeparatorChar)))
            .Distinct().ToList();
        libs.Add(_versions.ClientJarPath(d));
        var classpath = string.Join(Path.PathSeparator, libs);

        var vars = new Dictionary<string, string>
        {
            ["auth_player_name"] = ctx.Session.Username,
            ["version_name"] = d.Id,
            ["game_directory"] = _paths.Game,
            ["assets_root"] = _paths.Assets,
            ["assets_index_name"] = d.Assets,
            ["game_assets"] = Path.Combine(_paths.Assets, "virtual", d.AssetIndex?.Id ?? d.Assets),
            ["auth_uuid"] = ctx.Session.Uuid,
            ["auth_access_token"] = ctx.Session.AccessToken,
            ["auth_session"] = ctx.Session.AccessToken,
            ["clientid"] = "", ["auth_xuid"] = "",
            ["user_type"] = ctx.Session.UserType,
            ["user_properties"] = "{}",
            ["version_type"] = d.Type,
            ["natives_directory"] = nativesDir,
            ["launcher_name"] = LauncherName,
            ["launcher_version"] = LauncherVersion,
            ["classpath"] = classpath,
            ["classpath_separator"] = Path.PathSeparator.ToString(),
            ["library_directory"] = _paths.Libraries
        };

        var args = new List<string> { $"-Xms{ctx.XmsMb}M", $"-Xmx{ctx.XmxMb}M" };
        if (!string.IsNullOrWhiteSpace(ctx.ExtraJvmArgs))
            args.AddRange(ctx.ExtraJvmArgs.Split(' ', StringSplitOptions.RemoveEmptyEntries));

        if (d.Arguments is not null) // формат 1.13+
        {
            args.AddRange(d.Arguments.Jvm.SelectMany(ExpandArg));
        }
        else // legacy: JVM-аргументов в JSON нет
        {
            args.Add("-Djava.library.path=${natives_directory}");
            args.Add("-cp"); args.Add("${classpath}");
        }

        args.Add(d.MainClass);

        if (d.Arguments is not null) args.AddRange(d.Arguments.Game.SelectMany(ExpandArg));
        else if (d.MinecraftArguments is not null)
            args.AddRange(d.MinecraftArguments.Split(' ', StringSplitOptions.RemoveEmptyEntries));

        if (ctx.Server is not null)
        {
            var (host, port) = SplitAddress(ctx.Server.Address);
            bool quickPlay = d.Arguments?.Game.Any(e => e.ToString().Contains("quickPlayMultiplayer")) == true;
            if (quickPlay) { args.Add("--quickPlayMultiplayer"); args.Add(port == 25565 ? host : $"{host}:{port}"); }
            else { args.Add("--server"); args.Add(host); args.Add("--port"); args.Add(port.ToString()); }
        }

        return args.Select(a => Substitute(a, vars)).ToList();
    }

    private static IEnumerable<string> ExpandArg(JsonElement e)
    {
        if (e.ValueKind == JsonValueKind.String) { yield return e.GetString()!; yield break; }
        if (e.ValueKind != JsonValueKind.Object) yield break;

        var rules = e.TryGetProperty("rules", out var r) ? r.Deserialize<List<Rule>>() : null;
        if (!RuleEvaluator.IsAllowed(rules)) yield break;
        var v = e.GetProperty("value");
        if (v.ValueKind == JsonValueKind.String) yield return v.GetString()!;
        else foreach (var x in v.EnumerateArray()) yield return x.GetString()!;
    }

    private static string Substitute(string s, Dictionary<string, string> vars) =>
        VarRegex().Replace(s, m => vars.TryGetValue(m.Groups[1].Value, out var v) ? v : m.Value);

    [GeneratedRegex(@"\$\{(\w+)\}")] private static partial Regex VarRegex();

    private static (string host, int port) SplitAddress(string addr)
    {
        var i = addr.LastIndexOf(':');
        return i > 0 && int.TryParse(addr[(i + 1)..], out var p) ? (addr[..i], p) : (addr, 25565);
    }

    private void ExtractNatives(VersionDetails d, string dir)
    {
        foreach (var lib in _versions.ResolveLibraries(d).Where(l => l.Extract))
        {
            var jar = Path.Combine(_paths.Libraries, lib.Path.Replace('/', Path.DirectorySeparatorChar));
            using var zip = ZipFile.OpenRead(jar);
            foreach (var entry in zip.Entries)
            {
                if (entry.FullName.StartsWith("META-INF", StringComparison.OrdinalIgnoreCase) || entry.Name.Length == 0) continue;
                entry.ExtractToFile(Path.Combine(dir, entry.Name), true);
            }
        }
    }

    private static void TryDelete(string dir) { try { Directory.Delete(dir, true); } catch { } }

    /// <summary>UUID оффлайн-игрока как в ванили: MD5("OfflinePlayer:" + name) с version=3.</summary>
    public static string OfflineUuid(string name)
    {
        var h = MD5.HashData(Encoding.UTF8.GetBytes("OfflinePlayer:" + name));
        h[6] = (byte)((h[6] & 0x0f) | 0x30);
        h[8] = (byte)((h[8] & 0x3f) | 0x80);
        return new Guid(h, bigEndian: true).ToString("N");
    }
}
