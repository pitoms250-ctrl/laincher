using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Globalization;
using System.Windows;
using Launcher.Core.Abstractions;
using Launcher.Infrastructure;
using Launcher.Services;
using Launcher.Shared;
using Launcher.UI.ViewModels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Serilog;
using Serilog.Events;

namespace Launcher.UI;

public partial class App : Application
{
    private IHost? _host;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        DispatcherUnhandledException += OnDispatcherUnhandledException;
        var logDir = Path.Combine(Environment.ExpandEnvironmentVariables("%APPDATA%\\.fluncher"), "logs");
        Log.Logger = new LoggerConfiguration()
            .MinimumLevel.Information()
            .MinimumLevel.Override("System.Net.Http.HttpClient", LogEventLevel.Error)
            .WriteTo.Console()
            .WriteTo.File(Path.Combine(logDir, "launcher-.log"), rollingInterval: RollingInterval.Day, retainedFileCountLimit: 14)
            .CreateLogger();

        _host = Host.CreateDefaultBuilder()
            .UseContentRoot(AppContext.BaseDirectory)
            .UseSerilog()
            .ConfigureServices((ctx, s) =>
            {
                s.Configure<LauncherOptions>(ctx.Configuration.GetSection("Launcher"));
                s.AddSingleton(sp => new LauncherPaths(new SettingsStore().Load().GameDirectory ?? sp.GetRequiredService<IOptions<LauncherOptions>>().Value.GameDirectory));

                static void Ua(HttpClient c) => c.DefaultRequestHeaders.UserAgent.Add(new ProductInfoHeaderValue("FLauncher", "1.0"));
                s.AddHttpClient<IDownloadService, DownloadService>(Ua);
                s.AddHttpClient<IAuthService, AuthService>(Ua);
                s.AddHttpClient<IRealtimeDatabaseService, RealtimeDatabaseService>(Ua);
                s.AddHttpClient<ICloudApiService, Launcher.Services.CloudFunctionsService>(Ua);
                s.AddHttpClient<IShopService, Launcher.Services.ShopService>(Ua);
                s.AddHttpClient<IWalletService, Launcher.Services.WalletService>(Ua);
                s.AddHttpClient<ISkinService, SkinService>(Ua);
                s.AddHttpClient<TextTranslationService>();

                s.AddSingleton<ITokenStore, DpapiTokenStore>();
                s.AddSingleton<IFirebaseGuestTokenStore, DpapiFirebaseGuestTokenStore>();
                s.AddSingleton<IJavaService, JavaService>();
                s.AddSingleton<IVersionService, VersionService>();
                s.AddSingleton<ILaunchService, LaunchService>();
                s.AddSingleton<INewsService, NewsService>();
                s.AddSingleton<IServerService, ServerService>();
                s.AddSingleton<IModService, ModrinthService>();

                s.AddSingleton<SettingsStore>();
                s.AddSingleton<MainViewModel>();
                s.AddSingleton<MainWindow>();
            })
            .Build();

        await _host.StartAsync();

        // 1-е окно: знакомство с озвучкой (только при первом запуске; позже — Настройки → «Показать приветствие»)
        ShutdownMode = ShutdownMode.OnExplicitShutdown;
        var store = _host.Services.GetRequiredService<SettingsStore>();
        var st = store.Load();
        if (!st.WelcomeSeen)
        {
            new Views.WelcomeWindow().ShowDialog();
            st = store.Load(); st.WelcomeSeen = true; store.Save(st);
        }

        var w = _host.Services.GetRequiredService<MainWindow>();
        w.DataContext = _host.Services.GetRequiredService<MainViewModel>();
        MainWindow = w;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        w.Show();
    }

    private async void OnDispatcherUnhandledException(object sender, System.Windows.Threading.DispatcherUnhandledExceptionEventArgs e)
    {
        e.Handled = true;
        Log.Error(e.Exception, "Необработанное исключение WPF интерфейса");
        try
        {
            var auth = _host?.Services.GetService<IAuthService>();
            var realtimeDatabase = _host?.Services.GetService<IRealtimeDatabaseService>();
            if (auth is not null && realtimeDatabase is not null)
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                var session = await auth.GetOrCreateFirebaseGuestSessionAsync(timeout.Token);
                var locale = CultureInfo.CurrentUICulture.TwoLetterISOLanguageName switch
                {
                    "ru" => "ru-RU",
                    "uk" => "uk-UA",
                    _ => "en-US",
                };
                await realtimeDatabase.ReportErrorAsync(session, "global", e.Exception.GetType().Name,
                    e.Exception.Message, locale, "1.0.0", stack: e.Exception.ToString(), ct: timeout.Token);
            }
        }
        catch (Exception reportException)
        {
            Log.Warning(reportException, "Не удалось отправить отчёт о необработанной ошибке");
        }

        MessageBox.Show($"Произошла ошибка интерфейса. Отчёт сохранён, если доступна Firebase-связь.\n\n{e.Exception.Message}",
            "F Launcher", MessageBoxButton.OK, MessageBoxImage.Error);
    }

    protected override async void OnExit(ExitEventArgs e)
    {
        if (_host is not null)
        {
            try { await _host.Services.GetRequiredService<MainViewModel>().StopCloudSessionAsync(); }
            catch (Exception ex) { Log.Warning(ex, "Не удалось завершить Firebase Presence"); }
        }
        if (_host is not null) { await _host.StopAsync(); _host.Dispose(); }
        Log.CloseAndFlush();
        base.OnExit(e);
    }
}
