using System.Windows;
using Microsoft.Web.WebView2.Core;

namespace Launcher.UI.Views;

public partial class MicrosoftOAuthWindow : Window
{
    private readonly Uri _authorizationUri;
    private readonly Uri _redirectUri;

    public Uri? CallbackUri { get; private set; }
    public bool RuntimeUnavailable { get; private set; }

    public MicrosoftOAuthWindow(Uri authorizationUri, string redirectUri)
    {
        InitializeComponent();
        _authorizationUri = authorizationUri;
        _redirectUri = new Uri(redirectUri, UriKind.Absolute);
        Loaded += Window_Loaded;
    }

    private async void Window_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await Browser.EnsureCoreWebView2Async();
            Browser.CoreWebView2.NavigationStarting += CoreWebView2_NavigationStarting;
            Browser.Source = _authorizationUri;
        }
        catch (WebView2RuntimeNotFoundException)
        {
            RuntimeUnavailable = true;
            StatusText.Text = "Не найден Microsoft Edge WebView2 Runtime. Установите Evergreen Runtime и повторите вход.";
            Close();
        }
        catch (Exception ex)
        {
            StatusText.Text = "Не удалось открыть окно авторизации: " + ex.Message;
        }
    }

    private void CoreWebView2_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out var callback) ||
            !string.Equals(callback.Scheme, _redirectUri.Scheme, StringComparison.OrdinalIgnoreCase) ||
            !string.Equals(callback.Host, _redirectUri.Host, StringComparison.OrdinalIgnoreCase) ||
            callback.Port != _redirectUri.Port)
            return;

        e.Cancel = true;
        CallbackUri = callback;
        DialogResult = true;
    }

    private void Close_Click(object sender, RoutedEventArgs e) => Close();
}