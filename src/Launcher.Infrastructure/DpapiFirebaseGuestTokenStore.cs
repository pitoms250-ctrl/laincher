using System.Security.Cryptography;
using System.Runtime.Versioning;
using System.Text;
using System.Text.Json;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;

namespace Launcher.Infrastructure;

[SupportedOSPlatform("windows")]
public sealed class DpapiFirebaseGuestTokenStore : IFirebaseGuestTokenStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("FLauncher.FirebaseGuest.v1");
    private static readonly string FilePath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), ".fluncher", "firebase-guest.bin");

    public async Task SaveAsync(StoredFirebaseGuestAccount account, CancellationToken ct = default)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        var plain = JsonSerializer.SerializeToUtf8Bytes(account);
        var encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        await File.WriteAllBytesAsync(FilePath, encrypted, ct);
    }

    public async Task<StoredFirebaseGuestAccount?> LoadAsync(CancellationToken ct = default)
    {
        if (!File.Exists(FilePath)) return null;
        try
        {
            var encrypted = await File.ReadAllBytesAsync(FilePath, ct);
            var plain = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
            return JsonSerializer.Deserialize<StoredFirebaseGuestAccount>(plain);
        }
        catch (Exception ex) when (ex is CryptographicException or JsonException)
        {
            return null;
        }
    }

    public Task ClearAsync()
    {
        if (File.Exists(FilePath)) File.Delete(FilePath);
        return Task.CompletedTask;
    }
}