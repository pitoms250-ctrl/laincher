using System.Windows;
using Launcher.UI.Views;

namespace Launcher.UI;

public static class Dialogs
{
    /// <summary>Спрашивает, куда установить игру (диск C/D/… или своя папка). null — отмена.</summary>
    public static string? AskGameFolder(string current)
    {
        var dlg = new PathDialog(current) { Owner = Application.Current.MainWindow };
        return dlg.ShowDialog() == true ? dlg.SelectedPath : null;
    }

    public static MicrosoftAuthDialog ShowMicrosoftAuth(Window? owner, string verificationUri, string userCode)
    {
        var dlg = new MicrosoftAuthDialog(verificationUri, userCode) { Owner = owner };
        dlg.Show();
        return dlg;
    }

    public static void ShowWelcome(Window? owner)
    {
        var w = new WelcomeWindow { Owner = owner };
        w.ShowDialog();
    }
}
