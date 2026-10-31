using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using Microsoft.Win32;

namespace Launcher.UI.ViewModels;

/// <summary>Пиксельный редактор скина 64×64 с предпросмотром спереди/сзади. Источник истины — массив BGRA.</summary>
public partial class SkinEditorViewModel : ObservableObject
{
    private const int S = 64;
    private readonly byte[] _px = new byte[S * S * 4];
    private readonly byte[] _prev = new byte[40 * 32 * 4];
    private readonly Stack<byte[]> _undo = new();

    public WriteableBitmap Canvas { get; } = new(S, S, 96, 96, PixelFormats.Bgra32, null);
    public WriteableBitmap Preview { get; } = new(40, 32, 96, 96, PixelFormats.Bgra32, null);

    public ObservableCollection<SolidColorBrush> Palette { get; } = new(
        new[] { "#000000", "#FFFFFF", "#7F7F7F", "#3A3A3A", "#E8903A", "#C87028", "#F6ECDC", "#2FBF5A", "#1E8C42", "#57F287", "#39FF14", "#7CFFCB",
                "#3B82F6", "#1E3A8A", "#8B5CF6", "#EC4899", "#EF4444", "#B91C1C", "#FACC15", "#92400E", "#5B3A29", "#D2B48C", "#FDE2C8", "#0B3D2E" }
        .Select(h => new SolidColorBrush((Color)ColorConverter.ConvertFromString(h))));

    [ObservableProperty] private string _tool = "Pencil";          // Pencil | Eraser | Fill | Picker
    [ObservableProperty] private Color _currentColor = Color.FromRgb(0x2F, 0xBF, 0x5A);
    [ObservableProperty] private string _hex = "#2FBF5A";
    [ObservableProperty] private bool _slim;
    [ObservableProperty] private string _status = "";

    public SkinEditorViewModel() => LoadDefault();

    partial void OnCurrentColorChanged(Color value) => Hex = $"#{value.R:X2}{value.G:X2}{value.B:X2}";

    [RelayCommand] private void SetTool(string t) => Tool = t;
    [RelayCommand] private void PickPalette(SolidColorBrush b) { CurrentColor = b.Color; Tool = Tool == "Eraser" ? "Pencil" : Tool; }

    [RelayCommand]
    private void ApplyHex()
    {
        try { CurrentColor = (Color)ColorConverter.ConvertFromString(Hex.StartsWith('#') ? Hex : "#" + Hex); }
        catch { Status = "Неверный цвет. Пример: #2FBF5A"; }
    }

    // ---------- загрузка / сохранение ----------
    public void LoadDefault()
    {
        var uri = new Uri("pack://application:,,,/Assets/default_skin.png");
        var dec = new PngBitmapDecoder(uri, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        FromBitmap(dec.Frames[0]); _undo.Clear(); Status = "Шаблон F Launcher";
    }

    public void LoadPng(byte[] png)
    {
        using var ms = new MemoryStream(png);
        var dec = BitmapDecoder.Create(ms, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        Snapshot(); FromBitmap(dec.Frames[0]);
    }

    private void FromBitmap(BitmapSource src)
    {
        var f = new FormatConvertedBitmap(src, PixelFormats.Bgra32, null, 0);
        int w = f.PixelWidth, h = f.PixelHeight;                 // 64×64 или старый 64×32
        var data = new byte[w * h * 4]; f.CopyPixels(data, w * 4, 0);
        Array.Clear(_px);
        Array.Copy(data, _px, Math.Min(data.Length, _px.Length));
        if (h == 32) CopyLegacyLimbs();
        Refresh();
    }

    // Старые скины 64×32 не содержат левую руку/ногу — зеркалим правые.
    private void CopyLegacyLimbs()
    {
        void Mirror(int sx, int sy, int dx, int dy, int w, int h)
        {
            for (int i = 0; i < w; i++) for (int j = 0; j < h; j++)
                Array.Copy(_px, ((sy + j) * S + sx + (w - 1 - i)) * 4, _px, ((dy + j) * S + dx + i) * 4, 4);
        }
        Mirror(4, 20, 20, 52, 4, 12); Mirror(44, 20, 36, 52, 4, 12);
    }

    public byte[] ToPng()
    {
        var bmp = BitmapSource.Create(S, S, 96, 96, PixelFormats.Bgra32, null, _px, S * 4);
        var enc = new PngBitmapEncoder(); enc.Frames.Add(BitmapFrame.Create(bmp));
        using var ms = new MemoryStream(); enc.Save(ms); return ms.ToArray();
    }

    [RelayCommand]
    private void OpenFile()
    {
        var dlg = new OpenFileDialog { Filter = "Скин PNG|*.png" };
        if (dlg.ShowDialog() == true) { LoadPng(File.ReadAllBytes(dlg.FileName)); Status = "Открыт " + Path.GetFileName(dlg.FileName); }
    }

    [RelayCommand]
    private void SaveFile()
    {
        var dlg = new SaveFileDialog { Filter = "Скин PNG|*.png", FileName = "skin.png" };
        if (dlg.ShowDialog() == true) { File.WriteAllBytes(dlg.FileName, ToPng()); Status = "Сохранено: " + dlg.FileName; }
    }

    [RelayCommand] private void Reset() { Snapshot(); LoadDefault(); }

    [RelayCommand]
    private void Undo()
    {
        if (_undo.Count == 0) return;
        Array.Copy(_undo.Pop(), _px, _px.Length); Refresh();
    }

    // ---------- рисование ----------
    public void BeginStroke() => Snapshot();
    private void Snapshot() { _undo.Push((byte[])_px.Clone()); if (_undo.Count > 40) { var a = _undo.ToArray(); _undo.Clear(); foreach (var x in a.Take(30).Reverse()) _undo.Push(x); } }

    public void Stroke(int x, int y)
    {
        if (x < 0 || y < 0 || x >= S || y >= S) return;
        int i = (y * S + x) * 4;
        switch (Tool)
        {
            case "Pencil": Set(i, CurrentColor, 255); break;
            case "Eraser": Set(i, Colors.Black, 0); break;
            case "Picker": CurrentColor = Color.FromRgb(_px[i + 2], _px[i + 1], _px[i]); Tool = "Pencil"; return;
            case "Fill": Flood(x, y); break;
        }
        Refresh();
    }

    private void Set(int i, Color c, byte a) { _px[i] = c.B; _px[i + 1] = c.G; _px[i + 2] = c.R; _px[i + 3] = a; }

    private void Flood(int sx, int sy)
    {
        int s0 = (sy * S + sx) * 4;
        var target = new[] { _px[s0], _px[s0 + 1], _px[s0 + 2], _px[s0 + 3] };
        if (target[3] == 255 && target[0] == CurrentColor.B && target[1] == CurrentColor.G && target[2] == CurrentColor.R) return;
        var st = new Stack<(int, int)>(); st.Push((sx, sy));
        while (st.Count > 0)
        {
            var (x, y) = st.Pop();
            if (x < 0 || y < 0 || x >= S || y >= S) continue;
            int i = (y * S + x) * 4;
            if (_px[i] != target[0] || _px[i + 1] != target[1] || _px[i + 2] != target[2] || _px[i + 3] != target[3]) continue;
            Set(i, CurrentColor, 255);
            st.Push((x + 1, y)); st.Push((x - 1, y)); st.Push((x, y + 1)); st.Push((x, y - 1));
        }
    }

    // ---------- перерисовка ----------
    private void Refresh()
    {
        Canvas.WritePixels(new Int32Rect(0, 0, S, S), _px, S * 4, 0);
        Array.Clear(_prev);
        // (srcX, srcY, w, h, dstX, dstY): база, затем верхний слой поверх. Спереди слева, сзади справа.
        (int, int, int, int, int, int)[] parts =
        {
            (8,8,8,8,4,0),(40,8,8,8,4,0),(20,20,8,12,4,8),(20,36,8,12,4,8),(44,20,4,12,0,8),(44,36,4,12,0,8),(36,52,4,12,12,8),(52,52,4,12,12,8),
            (4,20,4,12,4,20),(4,36,4,12,4,20),(20,52,4,12,8,20),(4,52,4,12,8,20),
            (24,8,8,8,24,0),(56,8,8,8,24,0),(32,20,8,12,24,8),(32,36,8,12,24,8),(52,20,4,12,32,8),(52,36,4,12,32,8),(44,52,4,12,20,8),(60,52,4,12,20,8),
            (12,20,4,12,24,20),(12,36,4,12,24,20),(28,52,4,12,28,20),(12,52,4,12,28,20)
        };
        foreach (var (sx, sy, w, h, dx, dy) in parts)
            for (int i = 0; i < w; i++) for (int j = 0; j < h; j++)
            {
                int si = ((sy + j) * S + sx + i) * 4;
                if (_px[si + 3] == 0) continue;
                Array.Copy(_px, si, _prev, ((dy + j) * 40 + dx + i) * 4, 4);
            }
        Preview.WritePixels(new Int32Rect(0, 0, 40, 32), _prev, 40 * 4, 0);
    }
}
