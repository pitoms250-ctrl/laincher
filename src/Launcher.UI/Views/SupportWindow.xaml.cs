using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Input;
using Microsoft.Win32;

namespace Launcher.UI.Views;

public partial class SupportWindow : Window
{
    private const string SupportAddress = "furry.launcher@gmail.com";

    public SupportWindow()
    {
        InitializeComponent();
        WindowsVersion.Text = GetWindowsVersion();
        Memory.Text = GetMemory();
        Processor.Text = GetProcessor();
        Graphics.Text = GetGraphics();
    }

    private void Drag(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton == MouseButton.Left) DragMove();
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();

    private void Send_Click(object sender, RoutedEventArgs e)
    {
        var issue = Issue.Text.Trim();
        if (issue.Length == 0)
        {
            ValidationMessage.Text = "Кратко опишите проблему, чтобы открыть письмо.";
            Issue.Focus();
            return;
        }

        var body = new StringBuilder()
            .AppendLine("Описание проблемы:")
            .AppendLine(issue)
            .AppendLine()
            .AppendLine("Диагностика:")
            .AppendLine($"Windows: {WindowsVersion.Text}")
            .AppendLine($"ОЗУ: {Memory.Text}")
            .AppendLine($"Процессор: {Processor.Text}")
            .AppendLine($"Видеокарта: {Graphics.Text}")
            .ToString();
        var uri = $"mailto:{SupportAddress}?subject={Uri.EscapeDataString("Поддержка F Launcher")}&body={Uri.EscapeDataString(body)}";
        try
        {
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
            Close();
        }
        catch (Exception ex)
        {
            ValidationMessage.Text = $"Не удалось открыть почтовое приложение: {ex.Message}";
        }
    }

    private static string GetWindowsVersion()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
        var product = key?.GetValue("ProductName")?.ToString() ?? "Windows";
        var release = key?.GetValue("DisplayVersion")?.ToString();
        var build = key?.GetValue("CurrentBuildNumber")?.ToString();
        return string.Join(" ", new[] { product, release, build }.Where(part => !string.IsNullOrWhiteSpace(part)));
    }

    private static string GetProcessor()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
        return key?.GetValue("ProcessorNameString")?.ToString()?.Trim() ?? Environment.GetEnvironmentVariable("PROCESSOR_IDENTIFIER") ?? "Не определён";
    }

    private static string GetGraphics()
    {
        const string displayClass = @"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";
        using var key = Registry.LocalMachine.OpenSubKey(displayClass);
        var names = key?.GetSubKeyNames()
            .Where(name => name.Length == 4 && name.All(char.IsDigit))
            .Select(name =>
            {
                using var adapter = key!.OpenSubKey(name);
                return adapter?.GetValue("DriverDesc")?.ToString();
            })
            .Where(name => !string.IsNullOrWhiteSpace(name) && !name.Contains("remote", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return names is { Length: > 0 } ? string.Join(", ", names) : "Не удалось определить";
    }

    private static string GetMemory()
    {
        var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        return GlobalMemoryStatusEx(ref status)
            ? $"{status.TotalPhysicalMemory / 1024d / 1024 / 1024:0.#} ГБ"
            : "Не удалось определить";
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    private struct MemoryStatus
    {
        public uint Length;
        public uint MemoryLoad;
        public ulong TotalPhysicalMemory;
        public ulong AvailablePhysicalMemory;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus buffer);
}