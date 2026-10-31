using System.Diagnostics;
using System.Net.Sockets;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class ServerService : IServerService
{
    private readonly IDownloadService _dl;
    private readonly LauncherPaths _paths;
    private readonly LauncherOptions _opt;
    private readonly ILogger<ServerService> _log;
    private string CustomFile => Path.Combine(_paths.Root, "servers.json");

    public ServerService(IDownloadService dl, LauncherPaths paths, IOptions<LauncherOptions> opt, ILogger<ServerService> log)
    { _dl = dl; _paths = paths; _opt = opt.Value; _log = log; }

    /// <summary>mcstatus.io делает SRV-резолв и Server List Ping на своей стороне; TCP-пинг мерим сами.</summary>
    public async Task<ServerStatus> GetStatusAsync(string name, string address, CancellationToken ct = default)
    {
        var st = new ServerStatus { Name = name, Address = address };
        try
        {
            using var doc = JsonDocument.Parse(await _dl.GetStringAsync($"{_opt.ServerStatusApi}/{Uri.EscapeDataString(address)}", ct));
            var r = doc.RootElement;
            st.Online = r.GetProperty("online").GetBoolean();
            if (st.Online)
            {
                st.Players = r.GetProperty("players").GetProperty("online").GetInt32();
                st.MaxPlayers = r.GetProperty("players").GetProperty("max").GetInt32();
                st.Version = r.GetProperty("version").GetProperty("name_clean").GetString() ?? "";
                st.Motd = r.GetProperty("motd").GetProperty("clean").GetString() ?? "";
                st.IconDataUrl = r.TryGetProperty("icon", out var ic) && ic.ValueKind == JsonValueKind.String ? ic.GetString() : null;
                st.PingMs = await TcpPingAsync(address, ct);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Статус {Address} недоступен", address);
        }
        return st;
    }

    public async Task<IReadOnlyList<ServerStatus>> GetDefaultsAsync(CancellationToken ct = default)
    {
        var all = _opt.DefaultServers.Select(a => new ServerInfo(a, a)).Concat(LoadCustom());
        return await Task.WhenAll(all.Select(s => GetStatusAsync(s.Name, s.Address, ct)));
    }

    public async Task AddCustomAsync(ServerInfo server, CancellationToken ct = default)
    {
        var list = LoadCustom().Where(s => s.Address != server.Address).Append(server).ToList();
        Directory.CreateDirectory(_paths.Root);
        await File.WriteAllTextAsync(CustomFile, JsonSerializer.Serialize(list), ct);
    }

    private List<ServerInfo> LoadCustom() =>
        File.Exists(CustomFile) ? JsonSerializer.Deserialize<List<ServerInfo>>(File.ReadAllText(CustomFile)) ?? new() : new();

    private static async Task<long> TcpPingAsync(string address, CancellationToken ct)
    {
        var i = address.LastIndexOf(':');
        var host = i > 0 ? address[..i] : address;
        var port = i > 0 && int.TryParse(address[(i + 1)..], out var p) ? p : 25565;
        var sw = Stopwatch.StartNew();
        try
        {
            using var c = new TcpClient();
            using var cts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            cts.CancelAfter(3000);
            await c.ConnectAsync(host, port, cts.Token);
            return sw.ElapsedMilliseconds;
        }
        catch { return -1; }
    }
}
