using System.Net.Http.Headers;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;

namespace Launcher.Services;

public sealed class SkinService : ISkinService
{
    private readonly HttpClient _http;
    public SkinService(HttpClient http) => _http = http;

    /// <summary>PNG скина по нику (minotar.net проксирует скин из Mojang).</summary>
    public async Task<byte[]?> DownloadByNickAsync(string nickname, CancellationToken ct = default)
    {
        try { return await _http.GetByteArrayAsync($"https://minotar.net/skin/{Uri.EscapeDataString(nickname)}", ct); }
        catch (HttpRequestException) { return null; }
    }

    /// <summary>POST api.minecraftservices.com/minecraft/profile/skins (multipart: variant + file). Только для аккаунтов Microsoft.</summary>
    public async Task UploadAsync(AuthSession session, byte[] png, bool slim, CancellationToken ct = default)
    {
        if (session.IsOffline) throw new InvalidOperationException("Загрузка скина доступна только для аккаунта Microsoft.");
        using var form = new MultipartFormDataContent
        {
            { new StringContent(slim ? "slim" : "classic"), "variant" },
            { new ByteArrayContent(png) { Headers = { ContentType = new MediaTypeHeaderValue("image/png") } }, "file", "skin.png" }
        };
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.minecraftservices.com/minecraft/profile/skins") { Content = form };
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session.AccessToken);
        using var resp = await _http.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new HttpRequestException($"Mojang: {(int)resp.StatusCode} {await resp.Content.ReadAsStringAsync(ct)}");
    }
}
