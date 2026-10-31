using System.Windows;
using System.Windows.Controls;

namespace Launcher.UI.Views;

public partial class ZbtGateOverlay : UserControl
{
    public ZbtGateOverlay() => InitializeComponent();

    /// <summary>Кнопка «Вставить»: берёт текст из буфера обмена и кладёт в поле (биндинг обновится сам).</summary>
    private void PasteButton_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            if (!Clipboard.ContainsText()) return;
            KeyBox.Text = Clipboard.GetText().Trim();
            KeyBox.CaretIndex = KeyBox.Text.Length;
            KeyBox.Focus();
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            // буфер обмена занят другим приложением — пользователь может нажать Ctrl+V
        }
    }
}
