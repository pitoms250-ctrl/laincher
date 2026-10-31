using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

public sealed class NewsService : INewsService
{
    private readonly IDownloadService _dl;
    private readonly LauncherPaths _paths;
    private readonly LauncherOptions _opt;
    private readonly ILogger<NewsService> _log;

    public NewsService(IDownloadService dl, LauncherPaths paths, IOptions<LauncherOptions> opt, ILogger<NewsService> log)
    { _dl = dl; _paths = paths; _opt = opt.Value; _log = log; }

    public async Task<IReadOnlyList<NewsItem>> GetNewsAsync(bool force = false, CancellationToken ct = default)
    {
        var cache = Path.Combine(_paths.Cache, "news.json");
        bool fresh = File.Exists(cache) && DateTime.UtcNow - File.GetLastWriteTimeUtc(cache) < TimeSpan.FromMinutes(_opt.NewsCacheMinutes);
        if (fresh && !force) return ParseNews(await File.ReadAllTextAsync(cache, ct));
        try
        {
            var json = await _dl.GetStringAsync(_opt.NewsUrl, ct);
            Directory.CreateDirectory(_paths.Cache);
            await File.WriteAllTextAsync(cache, json, ct);
            return ParseNews(json);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            _log.LogWarning(ex, "Новости недоступны, берём кэш");
            return File.Exists(cache) ? ParseNews(await File.ReadAllTextAsync(cache, ct)) : Array.Empty<NewsItem>();
        }
    }

    /// <summary>Формат launchercontent.mojang.com/news.json: { "entries": [ { title, text, date, readMoreLink, newsPageImage:{url} } ] }. Парсим защитно.</summary>
    public static IReadOnlyList<NewsItem> ParseNews(string json)
    {
        using var doc = JsonDocument.Parse(json);
        if (!doc.RootElement.TryGetProperty("entries", out var entries)) return Array.Empty<NewsItem>();
        var list = new List<NewsItem>();
        foreach (var e in entries.EnumerateArray())
        {
            string? Str(JsonElement el, string n) => el.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
            string? Img(string n) { var u = e.TryGetProperty(n, out var o) && o.ValueKind == JsonValueKind.Object ? Str(o, "url") : null; return u is not null && u.StartsWith("/") ? "https://launchercontent.mojang.com" + u : u; }
            DateTime.TryParse(Str(e, "date"), out var date);
            list.Add(new NewsItem(Str(e, "title") ?? "", date, Img("newsPageImage") ?? Img("playPageImage"), Str(e, "text") ?? "", Str(e, "readMoreLink")));
        }
        return list.OrderByDescending(n => n.Date).ToList();
    }
}

public sealed class TextTranslationService
{
    private readonly HttpClient _client;
    private readonly ConcurrentDictionary<string, string> _cache = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _throttle = new(3, 3);

    public TextTranslationService(HttpClient client)
    {
        _client = client;
        _client.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("FLauncher", "1.0"));
    }

    public async Task<string> ToRussianAsync(string? text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text)) return text ?? string.Empty;
        if (_cache.TryGetValue(text, out var cached)) return cached;

        await _throttle.WaitAsync(cancellationToken);
        try
        {
            if (_cache.TryGetValue(text, out cached)) return cached;
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(6));
            var url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=ru&dt=t&q=" + Uri.EscapeDataString(text);
            using var response = await _client.GetAsync(url, timeout.Token);
            response.EnsureSuccessStatusCode();
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(timeout.Token));
            var root = document.RootElement;
            var translated = root.ValueKind == JsonValueKind.Array && root.GetArrayLength() > 0 && root[0].ValueKind == JsonValueKind.Array
                ? string.Concat(root[0].EnumerateArray()
                    .Where(segment => segment.ValueKind == JsonValueKind.Array && segment.GetArrayLength() > 0 && segment[0].ValueKind == JsonValueKind.String)
                    .Select(segment => segment[0].GetString()))
                : string.Empty;
            if (!string.IsNullOrWhiteSpace(translated))
            {
                _cache[text] = translated;
                return translated;
            }
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { }
        catch (HttpRequestException) { }
        catch (JsonException) { }
        finally { _throttle.Release(); }

        return text;
    }
}
