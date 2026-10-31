namespace Launcher.Shared;

/// <summary>IProgress без маршалинга в SynchronizationContext (в отличие от Progress&lt;T&gt;).</summary>
public sealed class SyncProgress<T> : IProgress<T>
{
    private readonly Action<T> _handler;
    public SyncProgress(Action<T> handler) => _handler = handler;
    public void Report(T value) => _handler(value);
}
