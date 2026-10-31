using System.Collections.Concurrent;
using System.Collections.ObjectModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Launcher.Core.Abstractions;
using Launcher.Core.Models;
using Launcher.Services;
using Launcher.Shared;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Microsoft.Win32;
using Launcher.UI;
using Launcher.UI.Views;

namespace Launcher.UI.ViewModels;

public partial class MainViewModel : ObservableObject
{
    private readonly IVersionService _versions;
    private readonly IJavaService _java;
    private readonly ILaunchService _launch;
    private readonly IAuthService _auth;
    private readonly IRealtimeDatabaseService _realtimeDatabase;
    private readonly ICloudApiService _cloud;
    private readonly INewsService _news;
    private readonly IServerService _servers;
    private readonly IModService _mods;
    private readonly ISkinService _skins;
    private readonly TextTranslationService _translation;
    private readonly SettingsStore _store;
    private readonly LauncherPaths _paths;
    private readonly ILogger<MainViewModel> _log;
    private readonly UserSettings _settings;
    private readonly ConcurrentQueue<string> _logQueue = new();
    private List<VersionEntry> _allVersions = new();
    private CancellationTokenSource? _cts;
    private string? _wantedVersion;
    private AuthSession? _session;
    private readonly DispatcherTimer _presenceTimer;
    private readonly bool _requireZbt;

    public ObservableCollection<NewsItem> News { get; } = new();
    public ObservableCollection<ServerStatus> Servers { get; } = new();
    public ObservableCollection<string> ModFiles { get; } = new();
    public ObservableCollection<ModHit> ModResults { get; } = new();
    public SkinEditorViewModel SkinEditor { get; } = new();
    public string[] ModLoaders { get; } = { "fabric", "forge", "neoforge", "quilt" };
    public string[] ModSorts { get; } = { "Популярные", "Релевантные", "Новые", "Обновлённые" };

    [ObservableProperty] private string _currentPage = "Play";
    [ObservableProperty] private IReadOnlyList<VersionEntry> _versionList = Array.Empty<VersionEntry>();
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(PlayCommand), nameof(InstallOnlyCommand))] private VersionEntry? _selectedVersion;
    [ObservableProperty] private string _versionSearch = "";
    [ObservableProperty] private string _nickname = "Player";
    [ObservableProperty] private string _avatarLetter = "P";
    [ObservableProperty] private string _accountLabel = "Оффлайн-профиль";
    [ObservableProperty] private string _accountActionLabel = "Войти Microsoft";
    [ObservableProperty] private bool _isAuthenticated;
    [ObservableProperty] private bool _shareDiagnostics;
    [ObservableProperty] private string _javaStatus = "Java: не проверена";
    [ObservableProperty] private string _progressText = "";
    [ObservableProperty] private double _progressValue;
    [ObservableProperty] private string _lastLogLine = "";
    [ObservableProperty] private bool _showSnapshots;
    [ObservableProperty] private bool _showOld;
    [ObservableProperty] private int _xmxMb = 4096;
    [ObservableProperty] private string _jvmArgs = "";
    [ObservableProperty] private int _totalPlayers;
    [ObservableProperty] private string _newServerAddress = "";
    [ObservableProperty] private string _skinInput = "";
    [ObservableProperty] private string _settingsMessage = "";
    [ObservableProperty] private string _statsText = "";
    [ObservableProperty] private string _gameFolder = "";
    [ObservableProperty] private bool _isAuthStatusVisible;
    [ObservableProperty] private string _authStatusText = "";
    [ObservableProperty] private string _authCodeText = "";
    [ObservableProperty] private string _authUrl = "";
    // моды
    [ObservableProperty] private string _modQuery = "";
    [ObservableProperty] private string _modLoader = "fabric";
    [ObservableProperty] private int _modSortIndex;
    [ObservableProperty] private bool _modForVersion = true;
    [ObservableProperty] private string _modStatus = "";
    [ObservableProperty] private bool _isModBusy;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(PlayCommand), nameof(InstallOnlyCommand))] private bool _isBusy;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(PlayCommand), nameof(InstallOnlyCommand), nameof(RedeemZbtCommand))] private bool _isZbtLocked = true;
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(RedeemZbtCommand))] private string _zbtKeyInput = "";
    [ObservableProperty] private string _zbtMessage = "Сначала войдите в Microsoft, затем введите ключ ЗБТ.";
    [ObservableProperty] [NotifyCanExecuteChangedFor(nameof(RedeemZbtCommand))] private bool _isZbtBusy;

    public string RamLabel => $"Память: {XmxMb} МБ";
    public string SelectedVersionLabel => SelectedVersion is null ? "—" : SelectedVersion.Id;

    public MainViewModel(IVersionService versions, IJavaService java, ILaunchService launch, IAuthService auth,
        IRealtimeDatabaseService realtimeDatabase, ICloudApiService cloud,
        INewsService news, IServerService servers, IModService mods, ISkinService skins, TextTranslationService translation,
        SettingsStore store, LauncherPaths paths,
        IOptions<LauncherOptions> opt, ILogger<MainViewModel> log)
    {
        (_versions, _java, _launch, _auth, _realtimeDatabase, _cloud, _news, _servers, _mods, _skins, _translation, _store, _paths, _log) =
            (versions, java, launch, auth, realtimeDatabase, cloud, news, servers, mods, skins, translation, store, paths, log);
        _requireZbt = opt.Value.RequireZbtKey;

        _settings = _store.Load();
        Nickname = _settings.Nickname; XmxMb = _settings.XmxMb > 0 ? _settings.XmxMb : opt.Value.DefaultXmxMb;
        JvmArgs = _settings.JvmArgs; ShowSnapshots = _settings.ShowSnapshots; ShowOld = _settings.ShowOld;
        ShareDiagnostics = _settings.ShareDiagnostics;
        _wantedVersion = _settings.LastVersion; ModLoader = _settings.LastModLoader ?? "fabric";
        SkinInput = Nickname; GameFolder = _paths.Root; UpdateStats();
        if (string.IsNullOrWhiteSpace(_settings.InstallId))
        {
            _settings.InstallId = Guid.NewGuid().ToString("N");
            _store.Save(_settings);
        }

        // лог игры обновляем не чаще 4 раз/сек, иначе интерфейс лагает
        _launch.LogReceived += l => _logQueue.Enqueue(l);
        var t = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(250) };
        t.Tick += (_, _) => { string? last = null; while (_logQueue.TryDequeue(out var l)) last = l; if (last is not null) LastLogLine = last; };
        t.Start();
        _presenceTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(60) };
        _presenceTimer.Tick += (_, _) => _ = SetPresenceSafelyAsync(_launch.IsRunning ? "in_game" : "online");

        _ = InitializeAsync();
    }

    // ---------- навигация ----------
    [RelayCommand]
    private void Navigate(string page)
    {
        if (IsZbtLocked) return;
        CurrentPage = page;
        if (page == "Mods") { RefreshMods(); if (ModResults.Count == 0) _ = SearchModsAsync(); }
    }

    private async Task InitializeAsync()
    {
        try
        {
            _session = await _auth.TryRestoreAsync();
            UpdateAccountState();
            if (_requireZbt)
            {
                IsZbtLocked = true;
                if (_session?.FirebaseUid is not null) await TryUnlockZbtAsync();
                else ZbtMessage = _cloud.IsConfigured
                    ? "Сначала войдите в Microsoft, затем введите ключ ЗБТ."
                    : "В appsettings.json укажите FirebaseApiKey и FunctionsBaseUrl, иначе ключ проверить нельзя.";
                if (IsZbtLocked) return;
            }
            else IsZbtLocked = false;

            if (ShareDiagnostics && _session is not null) await StartCloudSessionAsync();
            var manifest = await _versions.GetManifestAsync();
            _allVersions = manifest.Versions;
            ApplyFilter(_wantedVersion ?? manifest.Latest.Release);
            await LoadOnlineAsync();
        }
        catch (Exception ex) { _log.LogError(ex, "Инициализация"); LastLogLine = "Ошибка инициализации: " + ex.Message; }
    }

    private async Task LoadOnlineAsync(bool force = false)
    {
        var news = (await _news.GetNewsAsync(force)).Take(12).ToList();
        var servers = await _servers.GetDefaultsAsync();
        var translatedNews = await Task.WhenAll(news.Select(async item => item with
        {
            Title = await _translation.ToRussianAsync(item.Title),
            Description = await _translation.ToRussianAsync(item.Description)
        }));
        News.Clear(); foreach (var n in translatedNews) News.Add(n);
        Servers.Clear(); foreach (var s in servers) Servers.Add(s);
        TotalPlayers = Servers.Sum(x => x.Players);
    }

    partial void OnXmxMbChanged(int value) => OnPropertyChanged(nameof(RamLabel));
    partial void OnSelectedVersionChanged(VersionEntry? value) => OnPropertyChanged(nameof(SelectedVersionLabel));
    partial void OnNicknameChanged(string value) => AvatarLetter = string.IsNullOrWhiteSpace(value) ? "?" : value[..1].ToUpperInvariant();
    partial void OnShowSnapshotsChanged(bool value) => ApplyFilter();
    partial void OnShowOldChanged(bool value) => ApplyFilter();
    partial void OnVersionSearchChanged(string value) => ApplyFilter();
    partial void OnShareDiagnosticsChanged(bool value)
    {
        _settings.ShareDiagnostics = value;
        _store.Save(_settings);
        if (value && _session is not null) _ = StartCloudSessionAsync();
        else if (!value)
        {
            _presenceTimer.Stop();
            if (_session is not null) _ = SetPresenceSafelyAsync("offline");
        }
    }

    private void ApplyFilter(string? select = null)
    {
        var types = new HashSet<string> { "release" };
        if (ShowSnapshots) types.Add("snapshot");
        if (ShowOld) { types.Add("old_beta"); types.Add("old_alpha"); }
        var prev = select ?? SelectedVersion?.Id;
        var list = _versions.Filter(_allVersions, new VersionFilter(types, VersionSearch));
        VersionList = list;
        SelectedVersion = list.FirstOrDefault(v => v.Id == prev) ?? list.FirstOrDefault();
    }

    // ---------- онлайн / новости ----------
    [RelayCommand]
    private async Task RefreshAsync()
    {
        try { await LoadOnlineAsync(true); }
        catch (Exception ex) { LastLogLine = "Не удалось обновить: " + ex.Message; }
    }

    [RelayCommand]
    private void OpenNews(NewsItem? n)
    {
        if (n?.Url is { Length: > 0 } u) Process.Start(new ProcessStartInfo(u) { UseShellExecute = true });
    }

    [RelayCommand]
    private async Task AccountAsync()
    {
        if (IsBusy) return;
        if (_session is not null)
        {
            _presenceTimer.Stop();
            await _auth.SignOutAsync();
            if (ShareDiagnostics) await SetPresenceSafelyAsync("offline");
            _session = null;
            UpdateAccountState();
            return;
        }

        try
        {
            while (true)
            {
                var info = await _auth.StartDeviceFlowAsync();
                var dlg = Dialogs.ShowMicrosoftAuth(Application.Current.MainWindow, info.VerificationUri, info.UserCode);

                var closed = new TaskCompletionSource();
                dlg.Closed += (_, _) => closed.TrySetResult();

                // если нужно создать профиль Xbox / купить игру — окно само откроет страницу
                Action<AuthActionRequiredException> onAction = a => dlg.NextStep(a.Pill, a.Hint, a.Url);
                AuthService.ActionRequired += onAction;
                try
                {
                    // ждём, пока пользователь войдёт на сайте Microsoft
                    var authTask = _auth.CompleteDeviceFlowAsync(info);
                    _ = authTask.ContinueWith(t => _ = t.Exception, TaskContinuationOptions.OnlyOnFaulted);

                    var first = await Task.WhenAny(authTask, closed.Task);
                    if (first == closed.Task)
                    {
                        // окно закрыли вручную: «Отмена» или «Повторить»
                        if (dlg.RetryRequested) continue;
                        return;
                    }

                    try
                    {
                        _session = await authTask;
                        UpdateAccountState();
                        dlg.SetSuccess("Добро пожаловать в F Launcher", _session.Username);

                        await Task.WhenAny(closed.Task, Task.Delay(1800));
                        if (!closed.Task.IsCompleted) dlg.Close();
                        return;
                    }
                    catch (Exception ex)
                    {
                        _log.LogWarning(ex, "Вход Microsoft не завершён");
                        var real = ex.GetBaseException().Message;
                        if (real.Length > 140) real = real[..140] + "…";
                        dlg.SetStatus(real, true, ex.GetBaseException().GetType().Name);
                        await closed.Task;
                        if (!dlg.RetryRequested) return;
                    }
                }
                finally
                {
                    AuthService.ActionRequired -= onAction;
                }
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Ошибка входа Microsoft");
            AuthStatusText = ex.Message;
            AuthCodeText = "Ошибка";
            AuthUrl = "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize";
            IsAuthStatusVisible = true;
        }
    }

    private void UpdateAccountState()
    {
        IsAuthenticated = _session is not null;
        AccountLabel = _session is null ? "Оффлайн-профиль" : $"Microsoft: {_session.Username}";
        AccountActionLabel = _session is null ? "Войти Microsoft" : "Выйти";
        AvatarLetter = _session?.Username[..1].ToUpperInvariant() ??
            (string.IsNullOrWhiteSpace(Nickname) ? "?" : Nickname[..1].ToUpperInvariant());
    }

    private async Task StartCloudSessionAsync()
    {
        if (!ShareDiagnostics || _session?.FirebaseUid is null) return;
        try
        {
            _session = await _auth.RefreshFirebaseTokenAsync(_session);
            var locale = GetLocale();
            await _realtimeDatabase.RegisterPlayerAsync(_session, _session.Username, locale);
            await _realtimeDatabase.SetPresenceAsync(_session, "online", "1.0.0");
            await _realtimeDatabase.RecordEventAsync(_session, "auth.login_success", "account", locale, "1.0.0");
            _presenceTimer.Start();
        }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось синхронизировать профиль с Firebase"); }
    }

    public async Task StopCloudSessionAsync()
    {
        if (ShareDiagnostics && _session is not null) await SetPresenceSafelyAsync("offline");
    }

    private async Task SetPresenceSafelyAsync(string state)
    {
        if (_session?.FirebaseUid is null) return;
        try
        {
            _session = await _auth.RefreshFirebaseTokenAsync(_session);
            await _realtimeDatabase.SetPresenceAsync(_session, state, "1.0.0");
        }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось обновить статус Firebase Presence"); }
    }

    private async Task RecordEventSafelyAsync(string eventType, string area)
    {
        if (!ShareDiagnostics || _session?.FirebaseUid is null) return;
        try
        {
            _session = await _auth.RefreshFirebaseTokenAsync(_session);
            await _realtimeDatabase.RecordEventAsync(_session, eventType, area, GetLocale(), "1.0.0", SelectedVersion?.Id);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось отправить событие лаунчера"); }
    }

    private async Task ReportErrorSafelyAsync(string area, string title, Exception error)
    {
        if (!ShareDiagnostics || _session?.FirebaseUid is null) return;
        try
        {
            _session = await _auth.RefreshFirebaseTokenAsync(_session);
            await _realtimeDatabase.ReportErrorAsync(_session, area, title, error.Message, GetLocale(), "1.0.0", SelectedVersion?.Id);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Не удалось отправить отчёт об ошибке"); }
    }

    private static string GetLocale() => CultureInfo.CurrentUICulture.TwoLetterISOLanguageName switch
    {
        "ru" => "ru-RU",
        "uk" => "uk-UA",
        _ => "en-US"
    };

    [RelayCommand]
    private async Task AddServerAsync()
    {
        var addr = NewServerAddress.Trim();
        if (addr.Length == 0) return;
        await _servers.AddCustomAsync(new ServerInfo(addr, addr));
        Servers.Add(await _servers.GetStatusAsync(addr, addr));
        NewServerAddress = "";
        TotalPlayers = Servers.Sum(x => x.Players);
    }

    // ---------- версии ----------
    [RelayCommand]
    private void PickVersion(VersionEntry? v) { if (v is null) return; SelectedVersion = v; CurrentPage = "Play"; }

    [RelayCommand]
    private async Task CheckJavaAsync()
    {
        if (SelectedVersion is null) return;
        try
        {
            var d = await _versions.GetDetailsAsync(SelectedVersion);
            JavaStatus = (await _java.CheckAsync(_java.GetRequiredMajor(d))).Message;
        }
        catch (Exception ex) { JavaStatus = "Ошибка проверки: " + ex.Message; }
    }

    // ---------- папка игры: «на C или на D?» ----------
    /// <summary>Перед первой загрузкой спрашиваем, куда ставить игру. false — пользователь отказался.</summary>
    private bool EnsureGameFolder()
    {
        if (_settings.GameDirectory is not null) return true;
        var chosen = Dialogs.AskGameFolder(_paths.Root);
        if (chosen is null) return false;
        ApplyGameFolder(chosen);
        return true;
    }

    private void ApplyGameFolder(string path)
    {
        _paths.SetRoot(path);
        _settings.GameDirectory = path;
        GameFolder = _paths.Root;
        _store.Save(_settings);
    }

    [RelayCommand]
    private void ChangeGameFolder()
    {
        var chosen = Dialogs.AskGameFolder(_paths.Root);
        if (chosen is null) return;
        ApplyGameFolder(chosen);
        SettingsMessage = "Папка изменена. Уже скачанные файлы не переносятся — новые пойдут сюда.";
    }

    [RelayCommand]
    private void OpenGameFolder() { Directory.CreateDirectory(_paths.Root); Process.Start(new ProcessStartInfo(_paths.Root) { UseShellExecute = true }); }

    // ---------- скины ----------
    [RelayCommand]
    private async Task LoadSkinByNickAsync()
    {
        var png = await _skins.DownloadByNickAsync(SkinInput.Trim());
        if (png is null) { SkinEditor.Status = "Скин не найден"; return; }
        SkinEditor.LoadPng(png); SkinEditor.Status = $"Загружен скин {SkinInput}";
    }

    // ---------- моды ----------
    private string ModsDir => Path.Combine(_paths.Game, "mods");

    [RelayCommand]
    private void RefreshMods()
    {
        ModFiles.Clear();
        if (Directory.Exists(ModsDir))
            foreach (var f in Directory.EnumerateFiles(ModsDir, "*.jar").OrderBy(x => x)) ModFiles.Add(Path.GetFileName(f));
    }

    [RelayCommand]
    private async Task SearchModsAsync()
    {
        IsModBusy = true; ModStatus = "Ищем на Modrinth…";
        try
        {
            var sort = ModSortIndex switch { 0 => "downloads", 1 => "relevance", 2 => "newest", _ => "updated" };
            var gv = ModForVersion ? SelectedVersion?.Id : null;
            var res = await _mods.SearchAsync(ModQuery, gv, ModLoader, "mod", sort);
            var translated = await Task.WhenAll(res.Select(async mod => mod with
            {
                Title = await _translation.ToRussianAsync(mod.Title),
                Description = await _translation.ToRussianAsync(mod.Description)
            }));
            ModResults.Clear(); foreach (var r in translated) ModResults.Add(r);
            ModStatus = res.Count == 0 ? "Ничего не найдено — попробуйте другой загрузчик или версию." : $"Найдено: {res.Count}";
        }
        catch (Exception ex) { ModStatus = "Ошибка поиска: " + ex.Message; }
        finally { IsModBusy = false; }
    }

    [RelayCommand]
    private async Task InstallModAsync(ModHit? hit)
    {
        if (hit is null || !EnsureGameFolder()) return;
        IsModBusy = true; ModStatus = $"Скачиваем {hit.Title}…";
        try
        {
            var gv = ModForVersion ? SelectedVersion?.Id : null;
            var files = await _mods.InstallAsync(hit.Id, gv, ModLoader, ModsDir);
            ModStatus = $"Установлено: {string.Join(", ", files)}";
            RefreshMods();
        }
        catch (Exception ex) { ModStatus = "Не удалось: " + ex.Message; }
        finally { IsModBusy = false; }
    }

    [RelayCommand]
    private void AddOwnMod()
    {
        if (!EnsureGameFolder()) return;
        var dlg = new OpenFileDialog { Filter = "Моды (*.jar)|*.jar", Multiselect = true };
        if (dlg.ShowDialog() != true) return;
        Directory.CreateDirectory(ModsDir);
        foreach (var f in dlg.FileNames) File.Copy(f, Path.Combine(ModsDir, Path.GetFileName(f)), true);
        ModStatus = $"Добавлено файлов: {dlg.FileNames.Length}";
        RefreshMods();
    }

    [RelayCommand]
    private void RemoveMod(string? name)
    {
        if (name is null) return;
        try { File.Delete(Path.Combine(ModsDir, name)); } catch (Exception ex) { ModStatus = ex.Message; }
        RefreshMods();
    }

    [RelayCommand]
    private void OpenModsFolder() { Directory.CreateDirectory(ModsDir); Process.Start(new ProcessStartInfo(ModsDir) { UseShellExecute = true }); RefreshMods(); }

    // ---------- настройки ----------
    [RelayCommand]
    private void SaveSettings() { SaveNow(); SettingsMessage = "Сохранено ✓"; }

    [RelayCommand]
    private void ShowWelcome() => Dialogs.ShowWelcome(Application.Current.MainWindow);

    private void SaveNow()
    {
        _settings.Nickname = Nickname; _settings.XmxMb = XmxMb; _settings.JvmArgs = JvmArgs;
        _settings.ShowSnapshots = ShowSnapshots; _settings.ShowOld = ShowOld;
        _settings.LastVersion = SelectedVersion?.Id; _settings.LastModLoader = ModLoader;
        _store.Save(_settings);
    }

    private void UpdateStats()
    {
        var h = (int)(_settings.TotalPlayMinutes / 60); var m = (int)(_settings.TotalPlayMinutes % 60);
        StatsText = _settings.LaunchCount == 0 ? "Вы ещё не запускали игру" : $"Запусков: {_settings.LaunchCount} · в игре: {h} ч {m} мин";
    }

    // ---------- запуск ----------
    private bool CanPlay() => !IsBusy && SelectedVersion is not null;

    [RelayCommand(CanExecute = nameof(CanPlay))]
    private Task PlayAsync() => RunAsync(null, launch: true);

    [RelayCommand(CanExecute = nameof(CanPlay))]
    private Task InstallOnlyAsync() => RunAsync(null, launch: false);

    [RelayCommand]
    private Task ConnectAsync(ServerStatus? s) =>
        s is null || IsBusy ? Task.CompletedTask : RunAsync(new ServerInfo(s.Name, s.Address), launch: true);

    private async Task RunAsync(ServerInfo? server, bool launch)
    {
        if (SelectedVersion is null) return;
        if (!EnsureGameFolder()) return;                       // «куда скачивать: C или D?»
        IsBusy = true;
        _cts = new CancellationTokenSource();
        var ct = _cts.Token;
        var progress = new Progress<InstallProgress>(p => { ProgressValue = p.Fraction; ProgressText = $"{p.Stage}: {p.Fraction:P0}"; });
        try
        {
            SaveNow();
            var details = await _versions.GetDetailsAsync(SelectedVersion, ct);

            int major = _java.GetRequiredMajor(details);       // 1) Java — всегда первой
            JavaStatus = $"Проверка Java {major}…";
            var check = await _java.CheckAsync(major, ct);
            if (check.State == JavaState.NotFound)
            {
                JavaStatus = check.Message + " — устанавливаем…";
                check = await _java.EnsureJavaAsync(major, progress, ct);
            }
            JavaStatus = check.Message;

            await _versions.InstallAsync(details, progress, ct);   // 2) файлы игры
            if (!launch) { ProgressText = "Установлено"; return; }

            var session = _session ?? _auth.CreateOffline(Nickname);     // Microsoft для лицензии, офлайн для локального запуска
            if (server is not null) await RecordEventSafelyAsync("server.connect", "online");
            else await RecordEventSafelyAsync("game.launch", "play");
            if (_session?.FirebaseUid is not null && ShareDiagnostics)
                await SetPresenceSafelyAsync("in_game");
            var ctx = new LaunchContext(session, check.Install!, XmxMb, Math.Min(1024, XmxMb),
                string.IsNullOrWhiteSpace(JvmArgs) ? null : JvmArgs, server);
            ProgressText = "Игра запущена";
            var sw = Stopwatch.StartNew();
            var code = await _launch.LaunchAsync(details, ctx, ct);
            _settings.LaunchCount++; _settings.TotalPlayMinutes += sw.Elapsed.TotalMinutes;
            _store.Save(_settings); UpdateStats();
            ProgressText = $"Игра завершилась (код {code})";
        }
        catch (OperationCanceledException) { ProgressText = "Отменено"; }
        catch (Exception ex)
        {
            _log.LogError(ex, "Ошибка запуска");
            await ReportErrorSafelyAsync("game.launch", "Ошибка запуска игры", ex);
            MessageBox.Show(ex.Message, "Ошибка");
        }
        finally
        {
            if (ShareDiagnostics && _session?.FirebaseUid is not null) await SetPresenceSafelyAsync("online");
            IsBusy = false;
        }
    }

    [RelayCommand]
    private void Stop() { _launch.Stop(); _cts?.Cancel(); }
}
