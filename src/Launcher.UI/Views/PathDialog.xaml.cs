using System.IO;
using System.Windows;
using System.Windows.Input;
using Microsoft.Win32;

namespace Launcher.UI.Views;

public sealed record DriveItem(string Root, string Letter, string Title, string FreeText, double UsedFraction, string Badge, string Suggested);

public partial class PathDialog : Window
{
    public string? SelectedPath { get; private set; }

    public PathDialog(string current)
    {
        InitializeComponent();
        var drives = DriveInfo.GetDrives().Where(d => d.DriveType == DriveType.Fixed && d.IsReady).ToList();
        var best = drives.OrderByDescending(d => d.AvailableFreeSpace).FirstOrDefault();
        Drives.ItemsSource = drives.Select(d => new DriveItem(
            d.RootDirectory.FullName, d.Name[..1],
            $"Диск {d.Name.TrimEnd('\\')} {(string.IsNullOrWhiteSpace(d.VolumeLabel) ? "" : "· " + d.VolumeLabel)}",
            $"Свободно {Gb(d.AvailableFreeSpace)} из {Gb(d.TotalSize)}",
            1 - (double)d.AvailableFreeSpace / d.TotalSize,
            d.Name == best?.Name ? "  ★ больше всего места" : "",
            Path.Combine(d.RootDirectory.FullName, "FLauncher"))).ToList();

        var cur = Drives.Items.OfType<DriveItem>().FirstOrDefault(i => current.StartsWith(i.Root, StringComparison.OrdinalIgnoreCase));
        Drives.SelectedItem = cur ?? Drives.Items.OfType<DriveItem>().FirstOrDefault();
    }

    private static string Gb(long b) => $"{b / 1024.0 / 1024 / 1024:0.#} ГБ";
    private void Drag(object s, MouseButtonEventArgs e) { if (e.ChangedButton == MouseButton.Left) DragMove(); }

    private void Drives_SelectionChanged(object s, System.Windows.Controls.SelectionChangedEventArgs e)
    {
        if (Drives.SelectedItem is DriveItem d) { SelectedPath = d.Suggested; PathText.Text = "Папка: " + d.Suggested; }
    }

    private void Browse_Click(object s, RoutedEventArgs e)
    {
        var dlg = new OpenFolderDialog { Title = "Папка для F Launcher" };   // .NET 8
        if (dlg.ShowDialog(this) == true) { SelectedPath = Path.Combine(dlg.FolderName, "FLauncher"); PathText.Text = "Папка: " + SelectedPath; Drives.SelectedItem = null; }
    }

    private void Ok_Click(object s, RoutedEventArgs e) { if (SelectedPath is null) return; DialogResult = true; }
    private void Cancel_Click(object s, RoutedEventArgs e) => DialogResult = false;
}
