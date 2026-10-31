using System.Security.Cryptography;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Shared;

namespace Launcher.Infrastructure;

/// <summary>Хранит refresh-токен, зашифрованный DPAPI (CurrentUser) — расшифровать может только этот пользователь Windows.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiTokenStore : ITokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("FLauncher.v1");
    private readonly string _file;
    public DpapiTokenStore(LauncherPaths paths) => _file = Path.Combine(paths.Root, "account.bin");

    public async Task SaveAsync(StoredAccount account, CancellationToken ct = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
        var plain = JsonSerializer.SerializeToUtf8Bytes(account);
        var enc = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        await File.WriteAllBytesAsync(_file, enc, ct);
    }

    public async Task<StoredAccount?> LoadAsync(CancellationToken ct = default)
    {
        if (!File.Exists(_file)) return null;
        try
        {
            var enc = await File.ReadAllBytesAsync(_file, ct);
            var plain = ProtectedData.Unprotect(enc, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<StoredAccount>(plain);
        }
        catch (CryptographicException) { return null; }
    }

    public Task ClearAsync() { if (File.Exists(_file)) File.Delete(_file); return Task.CompletedTask; }
}
