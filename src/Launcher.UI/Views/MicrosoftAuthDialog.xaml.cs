using System.Diagnostics;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace Launcher.UI.Views;

public partial class MicrosoftAuthDialog : Window
{
    private readonly string _verificationUri;
    private readonly string _userCode;
    private readonly int _totalSeconds;
    private int _secondsLeft;
    private bool _finished;

    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    private readonly DispatcherTimer _copiedTimer = new() { Interval = TimeSpan.FromSeconds(2.5) };

    /// <summary>true, если пользователь нажал «Повторить».</summary>
    public bool RetryRequested { get; private set; }

    public MicrosoftAuthDialog(string verificationUri, string userCode, int expiresInSeconds = 900)
    {
        InitializeComponent();

        _verificationUri = verificationUri;
        _userCode = userCode;
        _totalSeconds = Math.Max(1, expiresInSeconds);
        _secondsLeft = _totalSeconds;

        CodeText.Text = userCode;
        VerificationUriText.Text = DisplayUri(verificationUri);

        _timer.Tick += Timer_Tick;
        _copiedTimer.Tick += (_, _) =>
        {
            _copiedTimer.Stop();
            CopyDone.Visibility = Visibility.Collapsed;
            CopyNormal.Visibility = Visibility.Visible;
            CopyButton.Background = (Brush)FindResource("AccentGrad");
            CopyButton.BorderBrush = Brushes.Transparent;
        };

        Loaded += (_, _) =>
        {
            Play("FlyStory");
            UpdateTimer();
            _timer.Start();
            OpenBrowser(); // сайт открывается сам
        };
        Closed += (_, _) =>
        {
            _timer.Stop();
            _copiedTimer.Stop();
        };
    }

    // ===== Публичное API (как раньше) =====

    public void SetStatus(string text, bool isError = false, string? errorCode = null)
    {
        // можно вызывать из любого потока
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetStatus(text, isError, errorCode));
            return;
        }
        if (_finished) return;

        if (isError)
            ShowError(text, errorCode ?? "AUTH_FAILED");
        else
            StatusPillText.Text = text;
    }

    /// <summary>Следующий шаг входа (профиль Xbox, лицензия…): меняет подсказку и сам открывает страницу.</summary>
    public void NextStep(string pill, string hint, string? url = null)
    {
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => NextStep(pill, hint, url));
            return;
        }
        if (_finished) return;

        _timer.Stop();
        StatusPillText.Text = pill;
        HintText.Text = hint;
        VerificationUriText.Visibility = Visibility.Collapsed;
        CodeText.Opacity = 0.35;
        TimerText.Text = "Ожидание…";
        TimerFill.Visibility = Visibility.Collapsed;
        if (!string.IsNullOrEmpty(url)) OpenUrl(url);
    }

    public void SetSuccess(string text, string? playerName = null)
    {
        // можно вызывать из любого потока
        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(() => SetSuccess(text, playerName));
            return;
        }
        if (_finished) return;
        _finished = true;
        _timer.Stop();
        Stop("FlyStory");

        SuccessSub.Text = text;
        if (!string.IsNullOrWhiteSpace(playerName))
            PlayerName.Text = playerName;

        WaitPage.Visibility = Visibility.Collapsed;
        SuccessPage.Visibility = Visibility.Visible;
        Play("SuccessStory");
    }

    // ===== Внутреннее =====

    private void ShowError(string text, string code)
    {
        _finished = true;
        _timer.Stop();
        Stop("FlyStory");

        ErrorSub.Text = text;
        ErrorCodeText.Text = code;

        // красная тема окна
        RootBorder.BorderBrush = (Brush)FindResource("ErrLine");
        BgStop1.Color = Color.FromRgb(0x1A, 0x0B, 0x0D);
        BgStop2.Color = Color.FromRgb(0x11, 0x07, 0x08);
        GlowStop1.Color = Color.FromArgb(0x47, 0xEF, 0x44, 0x44);
        GlowStop2.Color = Color.FromArgb(0x00, 0xEF, 0x44, 0x44);
        var glyph = new SolidColorBrush(Color.FromRgb(0xB5, 0x85, 0x85));
        MinGlyph.Stroke = glyph;
        CloseGlyph.Stroke = glyph;

        WaitPage.Visibility = Visibility.Collapsed;
        ErrorPage.Visibility = Visibility.Visible;
        Play("ErrorStory");
    }

    private void Timer_Tick(object? sender, EventArgs e)
    {
        _secondsLeft--;
        if (_secondsLeft <= 0)
        {
            ShowError("Код истёк, попробуйте снова", "AUTH_CODE_EXPIRED");
            return;
        }
        UpdateTimer();
    }

    private void UpdateTimer()
    {
        TimerText.Text = $"Код действителен ещё {_secondsLeft / 60}:{_secondsLeft % 60:D2}";
        TimerFill.Width = 400.0 * _secondsLeft / _totalSeconds;
    }

    private void OpenBrowser() => OpenUrl(_verificationUri);

    private void OpenUrl(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
        }
        catch
        {
            StatusPillText.Text = "Откройте ссылку вручную";
        }
    }

    private static string DisplayUri(string uri)
    {
        if (Uri.TryCreate(uri, UriKind.Absolute, out var u))
            return (u.Host + u.AbsolutePath).TrimEnd('/');
        return uri;
    }

    private void Play(string key) => ((Storyboard)Resources[key]).Begin(this, true);

    private void Stop(string key) => ((Storyboard)Resources[key]).Stop(this);

    // ===== Кнопки =====

    private void Copy_Click(object sender, RoutedEventArgs e)
    {
        try { Clipboard.SetText(_userCode); }
        catch { return; }

        CopyNormal.Visibility = Visibility.Collapsed;
        CopyDone.Visibility = Visibility.Visible;
        CopyButton.Background = (Brush)FindResource("AccentSoft");
        CopyButton.BorderBrush = (Brush)FindResource("Accent");

        _copiedTimer.Stop();
        _copiedTimer.Start();
    }

    private void Link_Click(object sender, MouseButtonEventArgs e) => OpenBrowser();

    private void Retry_Click(object sender, RoutedEventArgs e)
    {
        RetryRequested = true;
        Close();
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Minimize_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void Drag(object sender, MouseButtonEventArgs e)
    {
        if (e.LeftButton == MouseButtonState.Pressed)
            DragMove();
    }
}
