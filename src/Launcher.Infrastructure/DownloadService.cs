using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Microsoft.Extensions.Logging;

namespace Launcher.Infrastructure;

public sealed class DownloadService : IDownloadService
{
    private readonly HttpClient _http;
    private readonly ILogger<DownloadService> _log;
    public DownloadService(HttpClient http, ILogger<DownloadService> log) { _http = http; _log = log; }

    public async Task DownloadFileAsync(string url, string dest, string? sha1 = null, IProgress<long>? progress = null, CancellationToken ct = default)
    {
        if (File.Exists(dest) && (sha1 is null || await Sha1Equals(dest, sha1, ct)))
        {
            progress?.Report(new FileInfo(dest).Length);
            return;
        }
        Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
        var part = dest + ".part";

        for (int attempt = 1; attempt <= 3; attempt++)
        {
            try
            {
                long existing = File.Exists(part) ? new FileInfo(part).Length : 0;
                using var req = new HttpRequestMessage(HttpMethod.Get, url);
                if (existing > 0) req.Headers.Range = new RangeHeaderValue(existing, null);
                using var resp = await _http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);

                if (resp.StatusCode == HttpStatusCode.RequestedRangeNotSatisfiable) { File.Delete(part); continue; }
                resp.EnsureSuccessStatusCode();

                bool append = existing > 0 && resp.StatusCode == HttpStatusCode.PartialContent;
                if (append) progress?.Report(existing);
                await using (var fs = new FileStream(part, append ? FileMode.Append : FileMode.Create, FileAccess.Write, FileShare.None, 81920, true))
                await using (var s = await resp.Content.ReadAsStreamAsync(ct))
                {
                    var buf = new byte[81920]; int n;
                    while ((n = await s.ReadAsync(buf, ct)) > 0)
                    {
                        await fs.WriteAsync(buf.AsMemory(0, n), ct);
                        progress?.Report(n);
                    }
                }
                if (sha1 is not null && !await Sha1Equals(part, sha1, ct))
                {
                    File.Delete(part);
                    throw new InvalidDataException($"SHA1 mismatch: {url}");
                }
                File.Move(part, dest, true);
                return;
            }
            catch (Exception ex) when (attempt < 3 && ex is not OperationCanceledException)
            {
                _log.LogWarning(ex, "Download failed (attempt {A}) {Url}", attempt, url);
                await Task.Delay(TimeSpan.FromSeconds(attempt * 2), ct);
            }
        }
        throw new IOException($"Не удалось скачать: {url}");
    }

    public Task<string> GetStringAsync(string url, CancellationToken ct = default) => _http.GetStringAsync(url, ct);

    public async Task<T?> GetJsonAsync<T>(string url, CancellationToken ct = default)
    {
        await using var s = await _http.GetStreamAsync(url, ct);
        return await JsonSerializer.DeserializeAsync<T>(s, cancellationToken: ct);
    }

    private static async Task<bool> Sha1Equals(string path, string expected, CancellationToken ct)
    {
        await using var fs = File.OpenRead(path);
        var hash = await SHA1.HashDataAsync(fs, ct);
        return string.Equals(Convert.ToHexString(hash), expected, StringComparison.OrdinalIgnoreCase);
    }
}
