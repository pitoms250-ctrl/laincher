using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace Launcher.UI;

public sealed class EqualsConverter : IValueConverter
{
    public object Convert(object? v, Type t, object? p, CultureInfo c) => Equals(v?.ToString(), p?.ToString());
    public object ConvertBack(object? v, Type t, object? p, CultureInfo c) => Binding.DoNothing;
}

public sealed class PageVisibilityConverter : IValueConverter
{
    public object Convert(object? v, Type t, object? p, CultureInfo c) =>
        Equals(v?.ToString(), p?.ToString()) ? Visibility.Visible : Visibility.Collapsed;
    public object ConvertBack(object? v, Type t, object? p, CultureInfo c) => Binding.DoNothing;
}

public sealed class BooleanToVisibilityConverter : IValueConverter
{
    public object Convert(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is bool b && b ? Visibility.Visible : Visibility.Collapsed;

    public object ConvertBack(object? value, Type targetType, object? parameter, CultureInfo culture) =>
        value is Visibility v && v == Visibility.Visible;
}
