using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using Launcher.UI.ViewModels;

namespace Launcher.UI.Views;

public partial class SkinsView : UserControl
{
    private bool _drawing;
    public SkinsView() => InitializeComponent();

    private SkinEditorViewModel? Editor => (DataContext as MainViewModel)?.SkinEditor;

    private void Canvas_Down(object s, MouseButtonEventArgs e)
    {
        Editor?.BeginStroke(); _drawing = true; CanvasImage.CaptureMouse(); Paint(e);
    }
    private void Canvas_Move(object s, MouseEventArgs e) { if (_drawing) Paint(e); }
    private void Canvas_Up(object s, MouseButtonEventArgs e) { _drawing = false; CanvasImage.ReleaseMouseCapture(); }

    private void Paint(MouseEventArgs e)
    {
        var p = e.GetPosition(CanvasImage);                    // Image фиксирован 512×512 внутри Viewbox → 8 px на пиксель скина
        Editor?.Stroke((int)(p.X / 8), (int)(p.Y / 8));
    }

    private void TextBox_TextChanged(object sender, TextChangedEventArgs e)
    {

    }
}
