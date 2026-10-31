using System.Text.Json;
using Launcher.Core;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Services;
using Launcher.Shared;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Moq;
using Xunit;

namespace Launcher.Tests;

public class JavaServiceTests
{
    private static JavaService Make() => new(Mock.Of<IDownloadService>(), new LauncherPaths(Path.GetTempPath() + "fl-test"),
        Options.Create(new LauncherOptions()), NullLogger<JavaService>.Instance);

    [Theory]
    [InlineData("1.8.0_392", 8)]
    [InlineData("17.0.10", 17)]
    [InlineData("21", 21)]
    [InlineData("21.0.2+13", 21)]
    public void ParseMajor_Works(string v, int expected) => Assert.Equal(expected, JavaService.ParseMajor(v));

    [Fact] public void Required_NoJavaVersion_IsJava8() => Assert.Equal(8, Make().GetRequiredMajor(new VersionDetails()));

    [Theory]
    [InlineData(17)] [InlineData(21)]
    public void Required_ReadsMajorVersion(int m) =>
        Assert.Equal(m, Make().GetRequiredMajor(new VersionDetails { JavaVersion = new JavaVersionInfo { MajorVersion = m } }));

    [Fact]
    public async Task CheckAsync_UnknownMajor_NotFound()
    {
        var r = await Make().CheckAsync(99);
        Assert.Equal(JavaState.NotFound, r.State);
        Assert.Contains("не найдена", r.Message);
    }
}

public class RuleEvaluatorTests
{
    [Fact] public void NoRules_Allowed() => Assert.True(RuleEvaluator.IsAllowed(null));

    [Fact]
    public void OsxOnlyRule_Disallowed() =>
        Assert.False(RuleEvaluator.IsAllowed(new List<Rule> { new() { Action = "allow", Os = new RuleOs { Name = "osx" } } }));

    [Fact]
    public void AllowThenDisallowWindows_Disallowed() =>
        Assert.False(RuleEvaluator.IsAllowed(new List<Rule>
        {
            new() { Action = "allow" },
            new() { Action = "disallow", Os = new RuleOs { Name = "windows" } }
        }));
}

public class VersionServiceTests
{
    private static VersionService Make() => new(Mock.Of<IDownloadService>(), new LauncherPaths(Path.GetTempPath() + "fl-test"),
        Options.Create(new LauncherOptions()), NullLogger<VersionService>.Instance);

    private static List<VersionEntry> Sample() => new()
    {
        new() { Id = "1.21.4", Type = "release",  ReleaseTime = new DateTimeOffset(2024, 12, 3, 0, 0, 0, TimeSpan.Zero) },
        new() { Id = "24w44a", Type = "snapshot", ReleaseTime = new DateTimeOffset(2024, 10, 30, 0, 0, 0, TimeSpan.Zero) },
        new() { Id = "b1.7.3", Type = "old_beta", ReleaseTime = new DateTimeOffset(2011, 7, 8, 0, 0, 0, TimeSpan.Zero) },
        new() { Id = "1.20.1", Type = "release",  ReleaseTime = new DateTimeOffset(2023, 6, 12, 0, 0, 0, TimeSpan.Zero) },
    };

    [Fact]
    public void Filter_ByType_And_SortsNewestFirst()
    {
        var r = Make().Filter(Sample(), new VersionFilter(new HashSet<string> { "release" }));
        Assert.Equal(new[] { "1.21.4", "1.20.1" }, r.Select(v => v.Id));
    }

    [Fact]
    public void Filter_Search_IsCaseInsensitive()
    {
        var r = Make().Filter(Sample(), new VersionFilter(new HashSet<string>(), "24W"));
        Assert.Single(r);
    }

    [Fact]
    public void ResolveLibraries_SkipsDisallowed_AndMarksNatives()
    {
        var d = new VersionDetails();
        d.Libraries.Add(new Library { Name = "a", Downloads = new() { Artifact = new() { Path = "a.jar", Url = "u" } } });
        d.Libraries.Add(new Library
        {
            Name = "mac", Downloads = new() { Artifact = new() { Path = "mac.jar", Url = "u" } },
            Rules = new() { new() { Action = "allow", Os = new() { Name = "osx" } } }
        });
        d.Libraries.Add(new Library
        {
            Name = "lwjgl", Natives = new() { ["windows"] = "natives-windows" },
            Downloads = new() { Classifiers = new() { ["natives-windows"] = new() { Path = "n.jar", Url = "u" } } }
        });
        var libs = Make().ResolveLibraries(d);
        Assert.Equal(2, libs.Count);
        Assert.Contains(libs, l => l.Path == "n.jar" && l.Extract);
    }
}

public class LaunchServiceTests
{
    [Fact]
    public void OfflineUuid_IsDeterministicV3()
    {
        var a = LaunchService.OfflineUuid("Steve");
        Assert.Equal(a, LaunchService.OfflineUuid("Steve"));
        Assert.Equal(32, a.Length);
        Assert.Equal('3', a[12]);
    }

    [Fact]
    public void BuildArguments_SubstitutesVariables_Modern()
    {
        var paths = new LauncherPaths(Path.Combine(Path.GetTempPath(), "fl-test"));
        var vs = new Mock<IVersionService>();
        vs.Setup(v => v.ResolveLibraries(It.IsAny<VersionDetails>())).Returns(new[] { new LibraryFile("a/b.jar", "u", "", 0, false) });
        vs.Setup(v => v.ClientJarPath(It.IsAny<VersionDetails>())).Returns("client.jar");
        var svc = new LaunchService(vs.Object, paths, NullLogger<LaunchService>.Instance);

        var d = new VersionDetails { Id = "1.21", MainClass = "net.minecraft.client.main.Main", Assets = "17",
            Arguments = new ArgumentsSection
            {
                Jvm = new() { JsonDocument.Parse("\"-Djava.library.path=${natives_directory}\"").RootElement,
                              JsonDocument.Parse("\"-cp\"").RootElement, JsonDocument.Parse("\"${classpath}\"").RootElement },
                Game = new() { JsonDocument.Parse("\"--username\"").RootElement, JsonDocument.Parse("\"${auth_player_name}\"").RootElement }
            } };
        var ctx = new LaunchContext(new AuthSession("Steve", "u", "0", true), new JavaInstall("h", "java.exe", 21, "21", "t"), 2048, 512);
        var args = svc.BuildArguments(d, ctx, "N");

        Assert.Contains("-Xmx2048M", args);
        Assert.Contains("-Djava.library.path=N", args);
        Assert.Contains("Steve", args);
        Assert.True(args.IndexOf("net.minecraft.client.main.Main") > args.IndexOf("-cp"));
        Assert.DoesNotContain(args, a => a.Contains("${"));
    }
}

public class NewsServiceTests
{
    [Fact]
    public void ParseNews_ReadsEntries_SortedByDateDesc()
    {
        const string json = """
        { "entries": [
          { "title": "Old", "date": "2025-01-01", "text": "t", "readMoreLink": "https://x/1", "newsPageImage": { "url": "https://img/1" } },
          { "title": "New", "date": "2025-05-12", "text": "t2" }
        ] }
        """;
        var r = NewsService.ParseNews(json);
        Assert.Equal(2, r.Count);
        Assert.Equal("New", r[0].Title);
        Assert.Equal("https://img/1", r[1].ImageUrl);
    }

    [Fact] public void ParseNews_NoEntries_Empty() => Assert.Empty(NewsService.ParseNews("{}"));
}

public class ModrinthServiceTests
{
    [Fact]
    public async Task Search_ParsesHits_AndEncodesFacets()
    {
        var dl = new Mock<IDownloadService>();
        string? url = null;
        dl.Setup(d => d.GetStringAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
          .Callback<string, CancellationToken>((u, _) => url = u)
          .ReturnsAsync("{\"hits\":[{\"project_id\":\"AANobbMI\",\"title\":\"Sodium\",\"description\":\"d\",\"author\":\"a\",\"downloads\":123,\"icon_url\":null}]}");
        var svc = new ModrinthService(dl.Object, NullLogger<ModrinthService>.Instance);

        var r = await svc.SearchAsync("sodium", "1.21", "fabric");

        Assert.Single(r);
        Assert.Equal("Sodium", r[0].Title);
        Assert.Null(r[0].IconUrl);
        Assert.Contains("versions%3A1.21", url);
        Assert.Contains("categories%3Afabric", url);
    }

    [Fact]
    public async Task Install_DownloadsPrimaryFile_WithSha1()
    {
        var dl = new Mock<IDownloadService>();
        dl.Setup(d => d.GetStringAsync(It.IsAny<string>(), It.IsAny<CancellationToken>()))
          .ReturnsAsync("[{\"files\":[{\"url\":\"https://cdn/x.jar\",\"filename\":\"x.jar\",\"primary\":true,\"hashes\":{\"sha1\":\"abc\"}}],\"dependencies\":[]}]");
        var svc = new ModrinthService(dl.Object, NullLogger<ModrinthService>.Instance);

        var files = await svc.InstallAsync("P1", "1.21", "fabric", Path.Combine(Path.GetTempPath(), "fl-mods"));

        Assert.Equal(new[] { "x.jar" }, files);
        dl.Verify(d => d.DownloadFileAsync("https://cdn/x.jar", It.Is<string>(p => p.EndsWith("x.jar")), "abc", null, It.IsAny<CancellationToken>()), Times.Once);
    }

    [Fact]
    public async Task Install_NoCompatibleVersion_Throws()
    {
        var dl = new Mock<IDownloadService>();
        dl.Setup(d => d.GetStringAsync(It.IsAny<string>(), It.IsAny<CancellationToken>())).ReturnsAsync("[]");
        var svc = new ModrinthService(dl.Object, NullLogger<ModrinthService>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() => svc.InstallAsync("P1", "1.21", "fabric", "x"));
    }
}

public class RealtimeDatabaseServiceTests
{
    [Fact]
    public async Task IsPlayerBanned_ReadsAuthenticatedUsersBanRecord()
    {
        var handler = new RecordingHandler { ResponseBody = "{\"uid\":\"firebase-uid\",\"bannedAt\":123}" };
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        var isBanned = await service.IsPlayerBannedAsync(session);

        Assert.True(isBanned);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/bans/firebase-uid.json", request.Url);
        Assert.Equal("Bearer firebase-id-token", request.Authorization);
    }

    [Fact]
    public async Task IsPlayerBanned_ReturnsFalseWhenNoBanRecordExists()
    {
        var handler = new RecordingHandler();
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        Assert.False(await service.IsPlayerBannedAsync(session));
    }

    [Fact]
    public async Task RegisterPlayer_PatchesAuthenticatedRtdbProfile()
    {
        var handler = new RecordingHandler();
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        await service.RegisterPlayerAsync(session, "Alex", "ru-RU");

        Assert.Equal(4, handler.Requests.Count);
        Assert.Equal(HttpMethod.Get, handler.Requests[0].Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/players/firebase-uid/profile.json", handler.Requests[0].Url);
        var profileRequest = handler.Requests[1];
        Assert.Equal(HttpMethod.Patch, profileRequest.Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/players/firebase-uid/profile.json", profileRequest.Url);
        Assert.Equal("Bearer firebase-id-token", profileRequest.Authorization);
        using var profilePayload = JsonDocument.Parse(profileRequest.Body);
        Assert.Equal("Alex", profilePayload.RootElement.GetProperty("nickname").GetString());
        Assert.Equal("minecraft-id", profilePayload.RootElement.GetProperty("minecraftUuid").GetString());
        Assert.Equal("ru-RU", profilePayload.RootElement.GetProperty("locale").GetString());

        Assert.Equal(HttpMethod.Get, handler.Requests[2].Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/players/firebase-uid.json", handler.Requests[2].Url);
        var request = handler.Requests[3];
        Assert.Equal(HttpMethod.Patch, request.Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/players/firebase-uid.json", request.Url);
        Assert.Equal("Bearer firebase-id-token", request.Authorization);
        using var payload = JsonDocument.Parse(request.Body);
        Assert.Equal("Alex", payload.RootElement.GetProperty("nickname").GetString());
        Assert.Equal("minecraft-id", payload.RootElement.GetProperty("minecraftUuid").GetString());
        Assert.Equal("ru-RU", payload.RootElement.GetProperty("locale").GetString());
    }

    [Fact]
    public async Task PreviewZbtKey_ReadsHashedKeyAndActiveCampaignWithoutWriting()
    {
        const string key = "FL-1234-5678-90AB";
        var compact = "FL1234567890AB";
        var hash = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(compact))).ToLowerInvariant();
        var handler = new QueuedResponseHandler(
            "{\"used\":false,\"status\":\"UNUSED\",\"campaignId\":\"campaign-1\"}",
            "{\"status\":\"ACTIVE\"}");
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        var result = await service.PreviewZbtKeyAsync(session, key);

        Assert.True(result.Ok);
        Assert.Equal("campaign-1", result.CampaignId);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal($"https://example-default-rtdb.firebaseio.com/keys/{hash}.json", handler.Requests[0].Url);
        Assert.Equal("Bearer firebase-id-token", handler.Requests[0].Authorization);
        Assert.All(handler.Requests, request => Assert.Equal(HttpMethod.Get, request.Method));
    }

    [Fact]
    public async Task PreviewZbtKey_RejectsUsedKey()
    {
        var handler = new QueuedResponseHandler("{\"used\":true,\"status\":\"ACTIVATED\"}");
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        var result = await service.PreviewZbtKeyAsync(session, "FL-1234-5678-90AB");

        Assert.False(result.Ok);
        Assert.Contains("уже использован", result.Message, StringComparison.OrdinalIgnoreCase);
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task ReportError_PostsScrubbedReportToAuthenticatedRtdb()
    {
        var handler = new RecordingHandler();
        var service = new RealtimeDatabaseService(new HttpClient(handler),
            Options.Create(new LauncherOptions { FirebaseDatabaseUrl = "https://example-default-rtdb.firebaseio.com" }),
            NullLogger<RealtimeDatabaseService>.Instance);
        var session = new AuthSession("Alex", "minecraft-id", "minecraft-token", false,
            FirebaseUid: "firebase-uid", FirebaseIdToken: "firebase-id-token");

        await service.ReportErrorAsync(session, "game.launch", "Launch failed", "Launch failed", "uk-UA", "1.0.0",
            stack: "Bearer token access_token=secret");

        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://example-default-rtdb.firebaseio.com/errorReports/firebase-uid.json", request.Url);
        Assert.Equal("Bearer firebase-id-token", request.Authorization);
        using var payload = JsonDocument.Parse(request.Body);
        Assert.Equal("Launch failed", payload.RootElement.GetProperty("description").GetString());
        Assert.Contains("<REDACTED>", payload.RootElement.GetProperty("stack").GetString());
        Assert.Equal("uk-UA", payload.RootElement.GetProperty("locale").GetString());
        Assert.Equal(64, payload.RootElement.GetProperty("fingerprint").GetString()!.Length);
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        public List<CapturedRequest> Requests { get; } = new();
        public string ResponseBody { get; init; } = "null";

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!.ToString(),
                request.Headers.Authorization?.ToString(), body));
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new StringContent(ResponseBody) };
        }
    }

    private sealed class QueuedResponseHandler(params string[] responses) : HttpMessageHandler
    {
        private readonly Queue<string> _responses = new(responses);
        public List<CapturedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new CapturedRequest(request.Method, request.RequestUri!.ToString(),
                request.Headers.Authorization?.ToString(), body));
            return new HttpResponseMessage(System.Net.HttpStatusCode.OK)
            {
                Content = new StringContent(_responses.Dequeue())
            };
        }
    }

    private sealed record CapturedRequest(HttpMethod Method, string Url, string? Authorization, string Body);
}

public class AuthServiceOAuthTests
{
    [Fact]
    public void CreateMicrosoftOAuthRequest_UsesPkceAndLocalhostRedirect()
    {
        var service = CreateAuthService();

        var request = service.CreateMicrosoftOAuthRequest();

        Assert.Equal("https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize", request.AuthorizationUri.GetLeftPart(UriPartial.Path));
        Assert.Equal("http://localhost", request.RedirectUri);
        Assert.Contains("response_type=code", request.AuthorizationUri.Query);
        Assert.Contains("code_challenge_method=S256", request.AuthorizationUri.Query);
        Assert.Contains("code_challenge=", request.AuthorizationUri.Query);
        Assert.DoesNotContain("client_secret", request.AuthorizationUri.Query, StringComparison.OrdinalIgnoreCase);
        Assert.NotEmpty(request.State);
        Assert.NotEmpty(request.CodeVerifier);
    }

    [Fact]
    public async Task CompleteMicrosoftOAuthAsync_RejectsStateMismatchBeforeNetworkRequest()
    {
        var handler = new FailIfCalledHandler();
        var service = CreateAuthService(handler);
        var request = service.CreateMicrosoftOAuthRequest();
        var callback = new Uri("http://localhost/?code=authorization-code&state=not-the-request-state");

        var exception = await Assert.ThrowsAsync<InvalidOperationException>(
            () => service.CompleteMicrosoftOAuthAsync(request, callback));

        Assert.Contains("state", exception.Message, StringComparison.OrdinalIgnoreCase);
        Assert.False(handler.WasCalled);
    }

    private static AuthService CreateAuthService(HttpMessageHandler? handler = null) => new(
        new HttpClient(handler ?? new FailIfCalledHandler()),
        Mock.Of<ITokenStore>(),
        Mock.Of<IFirebaseGuestTokenStore>(),
        Options.Create(new LauncherOptions { MicrosoftClientId = "test-client-id" }),
        NullLogger<AuthService>.Instance);

    private sealed class FailIfCalledHandler : HttpMessageHandler
    {
        public bool WasCalled { get; private set; }

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            WasCalled = true;
            throw new InvalidOperationException("Unexpected HTTP request in OAuth validation test.");
        }
    }
}
