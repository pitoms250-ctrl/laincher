using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace Launcher.UI.Views;

/// <summary>Приветствие с озвучкой: слайды переключаются по таймкодам голоса (30 с). Без аудиофайла работает по секундомеру.</summary>
public partial class WelcomeWindow : Window
{
    private sealed record Cue(double At, string Image, string Title, string Spoken, string[] Chips);

    // Таймкоды получены из пауз в озвучке ElevenLabs (ffmpeg silencedetect).
    private static readonly Cue[] Cues =
    {
        new(0.0,  "s1", "Привет! Я — F Launcher",               "Привет! Я — F Launcher, что означает Furry Launcher.", new[] { "Furry Launcher", "Зелёный дизайн" }),
        new(4.4,  "s2", "Многофункциональный лаунчер",          "Я — многофункциональный майнкрафт-лаунчер.", new[] { "Версии", "Серверы", "Скины", "Моды" }),
        new(7.4,  "s3", "Быстрое подключение к серверам",       "Здесь ты можешь быстро и без задержек подключаться к серверам,", new[] { "Онлайн и пинг", "Свои серверы" }),
        new(11.2, "s4", "Одиночная игра в один клик",           "играть в одиночном режиме,", new[] { "Авто-Java", "Выбор диска C/D" }),
        new(12.9, "s5", "Абсолютно все версии Minecraft",       "а самое главное — наш лаунчер поддерживает абсолютно все версии Майнкрафта: от самой первой до самой последней!", new[] { "release", "snapshot", "old_beta", "old_alpha" }),
        new(20.4, "s6", "Скины: поиск и свой редактор",         "У нас можно искать готовые скины или редактировать свой собственный,", new[] { "Пиксельный редактор", "Предпросмотр спереди/сзади", "Загрузка в аккаунт" }),
        new(24.3, "s7", "Готовые сборки и моды из интернета",   "а также скачивать как готовые сборки модов,", new[] { "Modrinth", "Зависимости автоматически" }),
        new(26.9, "s8", "Без каких-либо ограничений",           "так и добавлять свои — без каких-либо ограничений!", new[] { "Свои .jar", "Свои скины" }),
    };

    private const double TotalSeconds = 30.1;
    private readonly BitmapImage[] _images;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromMilliseconds(80) };
    private readonly Stopwatch _clock = new();
    private MediaPlayer? _player;
    private bool _useClock;
    private bool _muted;
    private int _current = -1;

    public WelcomeWindow()
    {
        InitializeComponent();
        _images = Cues.Select(c => { var b = new BitmapImage(new Uri($"pack://application:,,,/Assets/slides/{c.Image}.jpg")); b.Freeze(); return b; }).ToArray();

        var file = Path.Combine(AppContext.BaseDirectory, "Assets", "welcome.mp3");
        if (File.Exists(file))
        {
            _player = new MediaPlayer();
            _player.MediaFailed += (_, _) => _useClock = true;
            _player.Open(new Uri(file));
            _player.Play();
        }
        else _useClock = true;
        _clock.Start();

        _timer.Tick += (_, _) => Tick();
        _timer.Start();
        ShowCue(0);
    }

    private double Position => _useClock || _player is null ? _clock.Elapsed.TotalSeconds : _player.Position.TotalSeconds;

    private void Tick()
    {
        var t = Position;
        Bar.Value = Math.Min(1, t / TotalSeconds);
        int idx = 0;
        for (int i = 0; i < Cues.Length; i++) if (t >= Cues[i].At) idx = i;
        if (idx != _current) ShowCue(idx);
        if (t >= TotalSeconds)
        {
            _timer.Stop();
            StartBtn.Visibility = Visibility.Visible;
            Hint.Text = "Готово! Нажмите «Начать», чтобы перейти в лаунчер";
        }
    }

    private void ShowCue(int idx)
    {
        _current = idx;
        var c = Cues[idx];
        ImgBack.Source = ImgFront.Source ?? _images[idx];
        ImgFront.Source = _images[idx];
        ImgFront.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(450)));
        TitleText.Text = c.Title;
        SpokenText.Text = c.Spoken;
        Chips.ItemsSource = c.Chips;
        TextPanel.BeginAnimation(OpacityProperty, new DoubleAnimation(0, 1, TimeSpan.FromMilliseconds(500)));
    }

    private void Mute_Click(object s, RoutedEventArgs e)
    {
        _muted = !_muted;
        if (_player is not null) _player.IsMuted = _muted;
        MuteBtn.Content = _muted ? "\uE74F" : "\uE767";
    }

    private void Skip_Click(object s, RoutedEventArgs e) => Close();
    private void Drag(object s, MouseButtonEventArgs e) { if (e.ChangedButton == MouseButton.Left) DragMove(); }

    private void Window_Closed(object? s, EventArgs e)
    {
        _timer.Stop();
        _player?.Stop(); _player?.Close();
    }
}
