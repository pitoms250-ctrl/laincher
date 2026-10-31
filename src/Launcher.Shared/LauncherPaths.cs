namespace Launcher.Shared;

public sealed class LauncherPaths
{
    public LauncherPaths(string root) => Root = Environment.ExpandEnvironmentVariables(root);
    public string Root { get; private set; }
    public void SetRoot(string root) => Root = Environment.ExpandEnvironmentVariables(root);
    public string Versions => Path.Combine(Root, "versions");
    public string Libraries => Path.Combine(Root, "libraries");
    public string Assets => Path.Combine(Root, "assets");
    public string AssetIndexes => Path.Combine(Assets, "indexes");
    public string AssetObjects => Path.Combine(Assets, "objects");
    public string Runtime => Path.Combine(Root, "runtime");
    public string Cache => Path.Combine(Root, "cache");
    public string Game => Path.Combine(Root, "game");
    public string Logs => Path.Combine(Root, "logs");
}
