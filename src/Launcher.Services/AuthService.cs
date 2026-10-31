using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Net;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace Launcher.Services;

/// <summary>Нужно действие пользователя на сайте (создать профиль Xbox, купить игру…). Вход продолжится сам.</summary>
public sealed class AuthActionRequiredException : InvalidOperationException
{
    public string Pill { get; }
    public string Hint { get; }
    public string Url { get; }
    public AuthActionRequiredException(string pill, string hint, string url, Exception? inner = null) : base(hint, inner)
    { Pill = pill; Hint = hint; Url = url; }
}

/// <summary>
/// Microsoft → Xbox Live → XSTS → Minecraft Services (device code flow).
/// Нужен собственный Azure App Registration (public client) и допуск к Minecraft API — см. README.
/// </summary>
public sealed class AuthService : IAuthService
{
    private const string Scope = "XboxLive.signin offline_access openid profile email";
    private const string MsBase = "https://login.microsoftonline.com/consumers/oauth2/v2.0";

    /// <summary>Срабатывает, когда нужно что-то сделать на сайте. Лаунчер откроет страницу сам.</summary>
    public static event Action<AuthActionRequiredException>? ActionRequired;

    private readonly HttpClient _http;
    private readonly ITokenStore _store;
    private readonly IFirebaseGuestTokenStore _guestStore;
    private readonly LauncherOptions _opt;
    private readonly ILogger<AuthService> _log;
    private AuthSession? _firebaseGuestSession;
    private readonly SemaphoreSlim _firebaseGuestSessionLock = new(1, 1);

    public AuthService(HttpClient http, ITokenStore store, IFirebaseGuestTokenStore guestStore,
        IOptions<LauncherOptions> opt, ILogger<AuthService> log)
    { _http = http; _store = store; _guestStore = guestStore; _opt = opt.Value; _log = log; }

    public AuthSession CreateOffline(string nickname)
    {
        nickname = nickname.Trim();
        if (nickname.Length is < 3 or > 16 || !nickname.All(c => char.IsAsciiLetterOrDigit(c) || c == '_'))
            throw new ArgumentException("Ник: 3–16 символов, латиница/цифры/_");
        return new AuthSession(nickname, LaunchService.OfflineUuid(nickname), "0", true);
    }

    public async Task<DeviceCodeInfo> StartDeviceFlowAsync(CancellationToken ct = default)
    {
        RequireClientId();
        var resp = await _http.PostAsync($"{MsBase}/devicecode",
            new FormUrlEncodedContent(new Dictionary<string, string> { ["client_id"] = _opt.MicrosoftClientId, ["scope"] = Scope }), ct);
        resp.EnsureSuccessStatusCode();
        using var j = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
        var r = j.RootElement;
        return new DeviceCodeInfo(r.GetProperty("device_code").GetString()!, r.GetProperty("user_code").GetString()!,
            r.GetProperty("verification_uri").GetString()!, r.GetProperty("expires_in").GetInt32(),
            r.GetProperty("interval").GetInt32(), r.GetProperty("message").GetString()!);
    }

    public async Task<AuthSession> CompleteDeviceFlowAsync(DeviceCodeInfo info, CancellationToken ct = default)
    {
        var interval = Math.Max(1, info.Interval);
        var deadline = DateTime.UtcNow.AddSeconds(info.ExpiresIn);
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(TimeSpan.FromSeconds(interval), ct);
            var resp = await _http.PostAsync($"{MsBase}/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code",
                ["client_id"] = _opt.MicrosoftClientId,
                ["device_code"] = info.DeviceCode
            }), ct);
            using var j = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var r = j.RootElement;
            if (resp.IsSuccessStatusCode)
                return await ExchangeWithRetryAsync(r.GetProperty("access_token").GetString()!, r.GetProperty("refresh_token").GetString()!,
                    r.TryGetProperty("id_token", out var idToken) ? idToken.GetString() : null, null, ct);

            var err = r.GetProperty("error").GetString();
            if (err == "authorization_pending") continue;
            if (err == "slow_down") { interval += 5; continue; }
            throw new InvalidOperationException($"Вход отклонён: {err}");
        }
        throw new TimeoutException("Время действия кода истекло.");
    }

    public MicrosoftOAuthRequest CreateMicrosoftOAuthRequest()
    {
        RequireClientId();
        const string redirectUri = "http://localhost";
        var state = Base64Url(RandomNumberGenerator.GetBytes(32));
        var codeVerifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        var codeChallenge = Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(codeVerifier)));
        var parameters = new Dictionary<string, string>
        {
            ["client_id"] = _opt.MicrosoftClientId,
            ["response_type"] = "code",
            ["redirect_uri"] = redirectUri,
            ["response_mode"] = "query",
            ["scope"] = Scope,
            ["state"] = state,
            ["code_challenge"] = codeChallenge,
            ["code_challenge_method"] = "S256",
            ["prompt"] = "select_account",
        };
        var query = string.Join("&", parameters.Select(pair =>
            $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));
        return new MicrosoftOAuthRequest(new Uri($"{MsBase}/authorize?{query}"), redirectUri, state, codeVerifier);
    }

    public async Task<AuthSession> CompleteMicrosoftOAuthAsync(MicrosoftOAuthRequest request, Uri callbackUri, CancellationToken ct = default)
    {
        if (!Uri.TryCreate(request.RedirectUri, UriKind.Absolute, out var expectedRedirect) ||
            !string.Equals(callbackUri.Scheme, expectedRedirect.Scheme, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(callbackUri.Host, expectedRedirect.Host, StringComparison.OrdinalIgnoreCase) ||
            callbackUri.Port != expectedRedirect.Port)
            throw new InvalidOperationException("Microsoft OAuth вернул неожиданный redirect URI.");

        var callback = ParseQuery(callbackUri.Query);
        if (!callback.TryGetValue("state", out var returnedState) ||
            !CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(returnedState), Encoding.UTF8.GetBytes(request.State)))
            throw new InvalidOperationException("Microsoft OAuth state не совпадает. Запустите вход повторно.");
        if (callback.TryGetValue("error", out var oauthError))
            throw new InvalidOperationException($"Microsoft отклонил вход: {callback.GetValueOrDefault("error_description", oauthError)}");
        if (!callback.TryGetValue("code", out var authorizationCode) || string.IsNullOrWhiteSpace(authorizationCode))
            throw new InvalidOperationException("Microsoft не вернул authorization code.");

        using var response = await _http.PostAsync($"{MsBase}/token", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["client_id"] = _opt.MicrosoftClientId,
            ["code"] = authorizationCode,
            ["redirect_uri"] = request.RedirectUri,
            ["code_verifier"] = request.CodeVerifier,
            ["scope"] = Scope,
        }), ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        using var json = JsonDocument.Parse(string.IsNullOrWhiteSpace(text) ? "{}" : text);
        if (!response.IsSuccessStatusCode)
        {
            var error = json.RootElement.TryGetProperty("error_description", out var description)
                ? description.GetString()
                : json.RootElement.TryGetProperty("error", out var errorCode) ? errorCode.GetString() : null;
            throw new HttpRequestException($"Не удалось обменять Microsoft authorization code (HTTP {(int)response.StatusCode}): {error ?? "unknown_error"}.");
        }

        var root = json.RootElement;
        return await ExchangeWithRetryAsync(
            root.GetProperty("access_token").GetString()!,
            root.GetProperty("refresh_token").GetString()!,
            root.TryGetProperty("id_token", out var idToken) ? idToken.GetString() : null,
            null,
            ct);
    }

    private static Dictionary<string, string> ParseQuery(string query)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var part in query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var split = part.Split('=', 2);
            var key = Uri.UnescapeDataString(split[0].Replace('+', ' '));
            var value = split.Length == 2 ? Uri.UnescapeDataString(split[1].Replace('+', ' ')) : "";
            values[key] = value;
        }
        return values;
    }

    private static string Base64Url(byte[] value) => Convert.ToBase64String(value)
        .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public async Task<AuthSession?> TryRestoreAsync(CancellationToken ct = default)
    {
        var acc = await _store.LoadAsync(ct);
        if (acc is null)
        {
            _log.LogInformation("No saved Microsoft session; launcher starts offline until the user signs in.");
            return null;
        }
        if (string.IsNullOrEmpty(_opt.MicrosoftClientId))
        {
            _log.LogWarning("MicrosoftClientId is not configured; the saved Microsoft session cannot be restored.");
            return null;
        }
        try
        {
            var resp = await _http.PostAsync($"{MsBase}/token", new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token", ["client_id"] = _opt.MicrosoftClientId,
                ["refresh_token"] = acc.RefreshToken, ["scope"] = Scope
            }), ct);
            if (!resp.IsSuccessStatusCode) { await _store.ClearAsync(); return null; }
            using var j = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
            var root = j.RootElement;
            return await ExchangeAsync(root.GetProperty("access_token").GetString()!,
                root.GetProperty("refresh_token").GetString()!,
                root.TryGetProperty("id_token", out var idToken) ? idToken.GetString() : null,
                acc.Email, ct);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось обновить сессию"); return null; }
    }

    public Task SignOutAsync() => _store.ClearAsync();

    public async Task<AuthSession> GetOrCreateFirebaseGuestSessionAsync(CancellationToken ct = default)
    {
        await _firebaseGuestSessionLock.WaitAsync(ct);
        try
        {
            return await GetOrCreateFirebaseGuestSessionCoreAsync(ct);
        }
        finally
        {
            _firebaseGuestSessionLock.Release();
        }
    }

    private async Task<AuthSession> GetOrCreateFirebaseGuestSessionCoreAsync(CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opt.FirebaseApiKey))
            throw new InvalidOperationException("Не задан FirebaseApiKey для RTDB-сесії.");
        if (_firebaseGuestSession?.FirebaseIdTokenExpiresAtUtc is { } cachedExpiry && cachedExpiry > DateTimeOffset.UtcNow.AddMinutes(5))
            return _firebaseGuestSession;

        var stored = await _guestStore.LoadAsync(ct);
        if (stored is not null)
        {
            try
            {
                using var refreshResponse = await _http.PostAsync(
                    $"https://securetoken.googleapis.com/v1/token?key={Uri.EscapeDataString(_opt.FirebaseApiKey)}",
                    new FormUrlEncodedContent(new Dictionary<string, string>
                    {
                        ["grant_type"] = "refresh_token",
                        ["refresh_token"] = stored.RefreshToken,
                    }), ct);
                refreshResponse.EnsureSuccessStatusCode();
                using var refreshed = JsonDocument.Parse(await refreshResponse.Content.ReadAsStringAsync(ct));
                var root = refreshed.RootElement;
                var refreshToken = root.GetProperty("refresh_token").GetString()!;
                await _guestStore.SaveAsync(new StoredFirebaseGuestAccount(
                    root.GetProperty("user_id").GetString()!, refreshToken), ct);
                _firebaseGuestSession = CreateFirebaseGuestSession(root.GetProperty("user_id").GetString()!,
                    root.GetProperty("id_token").GetString()!, refreshToken,
                    int.Parse(root.GetProperty("expires_in").GetString()!, CultureInfo.InvariantCulture));
                return _firebaseGuestSession;
            }
            catch (HttpRequestException ex) when (
                ex.StatusCode is HttpStatusCode.BadRequest or HttpStatusCode.Unauthorized)
            {
                _log.LogInformation(ex, "Збережена Firebase anonymous-сесія недійсна; створюється нова сесія пристрою");
                await _guestStore.ClearAsync();
            }
            catch (Exception ex) when (ex is HttpRequestException or JsonException or KeyNotFoundException or FormatException)
            {
                _log.LogWarning(ex, "Не вдалося відновити Firebase anonymous-сесію; збережений refresh token не видаляється");
                throw new InvalidOperationException(
                    "Не вдалося відновити Firebase-профіль через тимчасову помилку. Перевірте підключення та запустіть лаунчер ще раз.",
                    ex);
            }
        }

        using var signUp = await _http.PostAsJsonAsync(
            $"https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={Uri.EscapeDataString(_opt.FirebaseApiKey)}",
            new { returnSecureToken = true }, ct);
        var signUpText = await signUp.Content.ReadAsStringAsync(ct);
        if (!signUp.IsSuccessStatusCode)
            throw new HttpRequestException($"Firebase anonymous sign-in failed: HTTP {(int)signUp.StatusCode} {signUpText}");

        using var created = JsonDocument.Parse(signUpText);
        var result = created.RootElement;
        var uid = result.GetProperty("localId").GetString()!;
        var idToken = result.GetProperty("idToken").GetString()!;
        var newRefreshToken = result.GetProperty("refreshToken").GetString()!;
        await _guestStore.SaveAsync(new StoredFirebaseGuestAccount(uid, newRefreshToken), ct);
        _firebaseGuestSession = CreateFirebaseGuestSession(uid, idToken, newRefreshToken,
            int.Parse(result.GetProperty("expiresIn").GetString()!, CultureInfo.InvariantCulture));
        return _firebaseGuestSession;
    }

    private static AuthSession CreateFirebaseGuestSession(string uid, string idToken, string refreshToken, int expiresIn) =>
        new("Player", LaunchService.OfflineUuid("Player"), "0", true,
            FirebaseUid: uid,
            FirebaseIdToken: idToken,
            FirebaseRefreshToken: refreshToken,
            FirebaseIdTokenExpiresAtUtc: DateTimeOffset.UtcNow.AddSeconds(expiresIn));

    public async Task<AuthSession> RefreshFirebaseTokenAsync(AuthSession session, CancellationToken ct = default, bool force = false)
    {
        if (string.IsNullOrWhiteSpace(session.FirebaseRefreshToken) || string.IsNullOrWhiteSpace(_opt.FirebaseApiKey))
            throw new InvalidOperationException("Firebase refresh token отсутствует.");
        if (!force && session.FirebaseIdTokenExpiresAtUtc is { } expiry && expiry > DateTimeOffset.UtcNow.AddMinutes(5)) return session;

        using var response = await _http.PostAsync(
            $"https://securetoken.googleapis.com/v1/token?key={Uri.EscapeDataString(_opt.FirebaseApiKey)}",
            new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["grant_type"] = "refresh_token",
                ["refresh_token"] = session.FirebaseRefreshToken
            }), ct);
        var text = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"Firebase token refresh failed: HTTP {(int)response.StatusCode}");

        using var json = JsonDocument.Parse(text);
        var root = json.RootElement;
        var expiresIn = int.Parse(root.GetProperty("expires_in").GetString()!, CultureInfo.InvariantCulture);
        return session with
        {
            FirebaseUid = root.GetProperty("user_id").GetString(),
            FirebaseIdToken = root.GetProperty("id_token").GetString(),
            FirebaseRefreshToken = root.GetProperty("refresh_token").GetString(),
            FirebaseIdTokenExpiresAtUtc = DateTimeOffset.UtcNow.AddSeconds(expiresIn)
        };
    }

    /// <summary>Пока пользователь делает шаг на сайте (до 10 минут), каждые 5 секунд пробуем снова.</summary>
    private async Task<AuthSession> ExchangeWithRetryAsync(string msAccess, string msRefresh, string? msIdToken, string? emailFallback, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow.AddMinutes(10);
        string? lastUrl = null;
        while (true)
        {
            try { return await ExchangeAsync(msAccess, msRefresh, msIdToken, emailFallback, ct); }
            catch (AuthActionRequiredException ex) when (DateTime.UtcNow < deadline)
            {
                if (ex.Url != lastUrl) { lastUrl = ex.Url; ActionRequired?.Invoke(ex); }
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
            }
            catch (AuthActionRequiredException ex) when (ex.InnerException is not null)
            {
                throw ex.InnerException;
            }
        }
    }

    private async Task<AuthSession> ExchangeAsync(string msAccess, string msRefresh, string? msIdToken, string? emailFallback, CancellationToken ct)
    {
        // 1) Xbox Live
        var xbl = await PostJsonAsync("https://user.auth.xboxlive.com/user/authenticate", new
        {
            Properties = new { AuthMethod = "RPS", SiteName = "user.auth.xboxlive.com", RpsTicket = "d=" + msAccess },
            RelyingParty = "http://auth.xboxlive.com", TokenType = "JWT"
        }, ct);
        var xblToken = xbl.GetProperty("Token").GetString()!;
        var xboxClaims = xbl.GetProperty("DisplayClaims").GetProperty("xui")[0];
        var uhs = xboxClaims.GetProperty("uhs").GetString()!;
        var xboxGamertag = xboxClaims.TryGetProperty("gtg", out var gamertagValue) ? gamertagValue.GetString() : null;

        // 2) XSTS
        var xsts = await PostJsonAsync("https://xsts.auth.xboxlive.com/xsts/authorize", new
        {
            Properties = new { SandboxId = "RETAIL", UserTokens = new[] { xblToken } },
            RelyingParty = "rp://api.minecraftservices.com/", TokenType = "JWT"
        }, ct);
        var xstsToken = xsts.GetProperty("Token").GetString()!;

        // 3) Minecraft access token
        var mc = await PostJsonAsync("https://api.minecraftservices.com/authentication/login_with_xbox",
            new { identityToken = $"XBL3.0 x={uhs};{xstsToken}" }, ct);
        var mcToken = mc.GetProperty("access_token").GetString()!;

        // 4) Профиль Minecraft может отсутствовать, но Microsoft-вход остаётся полезен для профиля лаунчера.
        using var req = new HttpRequestMessage(HttpMethod.Get, "https://api.minecraftservices.com/minecraft/profile");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", mcToken);
        using var pr = await _http.SendAsync(req, ct);
        var hasMinecraftLicense = pr.IsSuccessStatusCode;
        string name;
        string id;
        if (hasMinecraftLicense)
        {
            using var prof = JsonDocument.Parse(await pr.Content.ReadAsStringAsync(ct));
            name = prof.RootElement.GetProperty("name").GetString()!;
            id = prof.RootElement.GetProperty("id").GetString()!;
        }
        else if (pr.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            var email = ReadMicrosoftEmail(msIdToken) ?? emailFallback;
            name = ToOfflineName(xboxGamertag ?? email?.Split('@')[0] ?? "Player");
            id = LaunchService.OfflineUuid(name);
        }
        else
        {
            pr.EnsureSuccessStatusCode();
            throw new InvalidOperationException("Не удалось получить профиль Minecraft.");
        }

        var firebase = await TryFirebaseSignInAsync(msIdToken, ct);
        var emailAddress = firebase?.Email ?? ReadMicrosoftEmail(msIdToken) ?? emailFallback;
        await _store.SaveAsync(new StoredAccount(name, id, msRefresh, emailAddress), ct);
        return new AuthSession(name, id, hasMinecraftLicense ? mcToken : "0", !hasMinecraftLicense, msRefresh,
            firebase?.Uid, firebase?.IdToken, firebase?.RefreshToken, firebase?.ExpiresAtUtc, emailAddress, hasMinecraftLicense, xboxGamertag);
    }

    private static string ToOfflineName(string value)
    {
        var name = new string(value.Where(c => char.IsAsciiLetterOrDigit(c) || c == '_').Take(16).ToArray());
        return name.Length >= 3 ? name : "Player";
    }

    private static string? ReadMicrosoftEmail(string? idToken)
    {
        if (string.IsNullOrWhiteSpace(idToken)) return null;
        try
        {
            var parts = idToken.Split('.');
            if (parts.Length < 2) return null;
            var payload = parts[1].Replace('-', '+').Replace('_', '/');
            payload = payload.PadRight(payload.Length + (4 - payload.Length % 4) % 4, '=');
            using var json = JsonDocument.Parse(Convert.FromBase64String(payload));
            var root = json.RootElement;
            foreach (var claim in new[] { "email", "preferred_username", "upn" })
            {
                if (root.TryGetProperty(claim, out var value) && value.GetString() is { Length: > 0 } email) return email;
            }
        }
        catch (Exception ex) when (ex is FormatException or JsonException or InvalidOperationException) { }
        return null;
    }

    private async Task<FirebaseAuthSession?> TryFirebaseSignInAsync(string? microsoftIdToken, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(_opt.FirebaseApiKey) || string.IsNullOrWhiteSpace(microsoftIdToken)) return null;

        try
        {
            _log.LogInformation("Exchanging Microsoft ID token for a Firebase session.");
            var postBody = $"id_token={Uri.EscapeDataString(microsoftIdToken)}&providerId=microsoft.com";
            using var response = await _http.PostAsJsonAsync(
                $"https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key={Uri.EscapeDataString(_opt.FirebaseApiKey)}",
                new { postBody, requestUri = "http://localhost", returnIdpCredential = true, returnSecureToken = true }, ct);
            var text = await response.Content.ReadAsStringAsync(ct);
            if (!response.IsSuccessStatusCode)
                throw new HttpRequestException($"Firebase Auth вернул HTTP {(int)response.StatusCode} ({GetFirebaseErrorCode(text)}).");

            using var json = JsonDocument.Parse(text);
            var root = json.RootElement;
            var firebaseSession = new FirebaseAuthSession(
                root.GetProperty("localId").GetString()!,
                root.GetProperty("idToken").GetString()!,
                root.GetProperty("refreshToken").GetString()!,
                DateTimeOffset.UtcNow.AddSeconds(int.Parse(root.GetProperty("expiresIn").GetString()!, CultureInfo.InvariantCulture)),
                root.TryGetProperty("email", out var email) ? email.GetString() : null);
            _log.LogInformation("Firebase session established for Microsoft sign-in.");
            return firebaseSession;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Firebase-вход не настроен; вход в Minecraft продолжится без облачной синхронизации");
            return null;
        }
    }

    private static string GetFirebaseErrorCode(string responseBody)
    {
        try
        {
            using var json = JsonDocument.Parse(responseBody);
            var message = json.RootElement.GetProperty("error").GetProperty("message").GetString();
            if (string.IsNullOrWhiteSpace(message)) return "unknown_error";
            var delimiter = message.IndexOf(':');
            var code = delimiter < 0 ? message : message[..delimiter];
            return new string(code.Where(character => char.IsAsciiLetterOrDigit(character) || character == '_').Take(64).ToArray());
        }
        catch (Exception ex) when (ex is JsonException or KeyNotFoundException or InvalidOperationException)
        {
            return "unknown_error";
        }
    }

    // имена полей отправляем как написано (Xbox чувствителен к регистру: Properties, RpsTicket…)
    private static readonly JsonSerializerOptions RawJson = new() { PropertyNamingPolicy = null };

    private async Task<JsonElement> PostJsonAsync(string url, object body, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, url) { Content = JsonContent.Create(body, mediaType: null, options: RawJson) };
        req.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        req.Headers.Add("x-xbl-contract-version", "1");
        using var resp = await _http.SendAsync(req, ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
        {
            if (text.Contains("2148916233"))
                throw new AuthActionRequiredException("Создайте профиль Xbox",
                    "Откроется страница Xbox: создайте профиль, вход продолжится сам.", "https://www.xbox.com/");
            if (text.Contains("2148916238"))
                throw new AuthActionRequiredException("Детский аккаунт",
                    "Добавьте аккаунт в семью Microsoft, вход продолжится сам.", "https://account.microsoft.com/family");

            // короткое понятное сообщение вместо сырого JSON
            var msg = text;
            try
            {
                using var ej = JsonDocument.Parse(text);
                if (ej.RootElement.TryGetProperty("errorMessage", out var em) && em.GetString() is { Length: > 0 } t) msg = t;
                else if (ej.RootElement.TryGetProperty("error", out var er) && er.GetString() is { Length: > 0 } t2) msg = t2;
            }
            catch { /* не JSON — оставляем как есть */ }
            var host = new Uri(url).Host;

            if (host.Contains("minecraftservices") && (int)resp.StatusCode == 403)
            {
                if (text.Contains("app registration", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("Приложение Azure не одобрено Mojang. Заявка: aka.ms/AppRegInfo");
                // чаще всего Xbox-профиль ещё не готов: ждём и пробуем снова
                throw new AuthActionRequiredException("Завершите регистрацию Xbox",
                    "Завершите регистрацию на сайте Xbox, вход продолжится сам.", "",
                    new HttpRequestException($"{host}: 403 {msg}"));
            }
            throw new HttpRequestException($"{host}: {(int)resp.StatusCode} {msg}");
        }
        return JsonDocument.Parse(text).RootElement.Clone();
    }

    private void RequireClientId()
    {
        if (string.IsNullOrWhiteSpace(_opt.MicrosoftClientId))
            throw new InvalidOperationException("Укажите Launcher:MicrosoftClientId в appsettings.json (Azure App Registration).");
    }

    private sealed record FirebaseAuthSession(string Uid, string IdToken, string RefreshToken, DateTimeOffset ExpiresAtUtc, string? Email);
}
