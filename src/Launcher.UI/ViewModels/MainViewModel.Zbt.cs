using CommunityToolkit.Mvvm.Input;
using Launcher.Core.Models;
using Launcher.Shared;
using Microsoft.Extensions.Logging;

namespace Launcher.UI.ViewModels;

public partial class MainViewModel
{
    private AuthSession? _zbtSession;

    private async Task TryUnlockZbtAsync()
    {
        try
        {
            _zbtSession = await _auth.GetOrCreateFirebaseGuestSessionAsync();
            var identity = _session is null
                ? _zbtSession with { Username = Nickname }
                : _zbtSession with { Username = _session.Username, Uuid = _session.Uuid, Email = _session.Email };
            var access = await _realtimeDatabase.CheckZbtAccessAsync(identity, _settings.InstallId!);
            IsZbtLocked = !access.Ok;
            ZbtMessage = access.Message;
        }
        catch (Exception ex)
        {
            IsZbtLocked = true;
            ZbtMessage = "Could not verify ZBT access. Check your connection and sign in again.";
            _log.LogWarning(ex, "Could not verify ZBT access");
        }
    }

    [RelayCommand]
    private async Task RedeemZbtAsync()
    {
        if (IsZbtBusy || !IsZbtLocked) return;
        if (!ZbtKeyFormat.TryValidate(ZbtKeyInput, out var compact, out var validationError))
        {
            ZbtMessage = validationError;
            return;
        }

        IsZbtBusy = true;
        try
        {
            _zbtSession = await _auth.GetOrCreateFirebaseGuestSessionAsync();
            var preview = await _realtimeDatabase.PreviewZbtKeyAsync(_zbtSession with { Username = Nickname }, compact);
            if (!preview.Ok)
            {
                ZbtMessage = preview.Message;
                return;
            }

            ZbtMessage = preview.Message;
            if (_session is null) await AccountAsync();
            if (_session is null)
            {
                ZbtMessage = "Вход отменён. Ключ проверен, но не активирован.";
                return;
            }

            if (string.IsNullOrWhiteSpace(_session.FirebaseUid) || string.IsNullOrWhiteSpace(_session.FirebaseIdToken))
            {
                var restored = await _auth.TryRestoreAsync();
                if (restored is not null) _session = restored;
            }
            if (string.IsNullOrWhiteSpace(_session.FirebaseUid) || string.IsNullOrWhiteSpace(_session.FirebaseIdToken))
            {
                ZbtMessage = "Вход Microsoft выполнен, но Firebase не создал пользовательскую сессию. Проверьте провайдер Microsoft в Firebase Authentication.";
                return;
            }

            _session = await _auth.RefreshFirebaseTokenAsync(_session);
            var result = await _realtimeDatabase.RedeemZbtKeyAsync(_session, compact, _settings.InstallId!);
            ZbtMessage = result.Message;
            if (!result.Ok) return;

            var access = await _realtimeDatabase.CheckZbtAccessAsync(_session, _settings.InstallId!);
            IsZbtLocked = !access.Ok;
            ZbtMessage = access.Message;
            if (!access.Ok) return;
            ZbtKeyInput = "";
            await StartCloudSessionAsync();
            var manifest = await _versions.GetManifestAsync();
            _allVersions = manifest.Versions;
            ApplyFilter(_wantedVersion ?? manifest.Latest.Release);
            await LoadOnlineAsync();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to redeem ZBT key");
            ZbtMessage = ex.Message;
        }
        finally { IsZbtBusy = false; }
    }
}