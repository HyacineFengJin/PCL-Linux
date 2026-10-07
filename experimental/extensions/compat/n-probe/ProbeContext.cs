using System.Globalization;
using System.Text.Json;
using PCL.N.Plugin;

namespace PclRh.NCompatibilityProbe;

// A real implementation of public SDK interfaces. Plugin objects and callbacks
// remain inside .NET; only bounded text descriptors leave this process. This
// deliberately advertises no runtime patching, raw UI, credentials or game IO.
internal sealed class ProbeContext : IPluginContext, IPluginServiceProvider,
    IPluginCapabilityProvider, IPluginLifetime, IPluginLogger, IPluginDispatcher,
    IPluginCommandService, IPluginLocalizedSettingsPageCapability, IAsyncDisposable
{
    private readonly HashSet<string> _grants;
    private readonly CancellationTokenSource _stopping = new();
    private readonly Dictionary<string, PluginCommandDescriptor> _commands = [];
    private readonly Dictionary<string, object> _pages = [];
    private readonly Dictionary<string, string> _translations;
    private readonly List<object> _tracked = [];
    private readonly List<object> _logs = [];
    private readonly string _culture;
    private readonly ProbeNotifications _notifications;
    private bool _disposed;

    public ProbeContext(PluginDescriptor plugin, IEnumerable<string> grants, string culture, string locales, string sessionId)
    {
        Plugin = plugin;
        _grants = grants.ToHashSet(StringComparer.Ordinal);
        if (_grants.Except(["pcl.commands", "pcl.settings-pages", "pcl.notifications"]).Any())
            throw new NotSupportedException("Unsupported probe grant.");
        _notifications = new ProbeNotifications(() => RequireGrant("pcl.notifications"), sessionId);
        _culture = culture is "zh-CN" or "en-US" ? culture : throw new NotSupportedException("Unsupported probe locale.");
        _translations = JsonSerializer.Deserialize<Dictionary<string, string>>(
            File.ReadAllText(Path.Combine(locales, culture + ".json"))) ?? [];
        Directories = PluginDirectorySet.CreateUnder("/fixture-data/" + plugin.Id.Value);
    }

    public PluginDescriptor Plugin { get; }
    public PluginApiVersion ApiVersion => new(0, 2);
    public IPluginServiceProvider Services => this;
    public IPluginCapabilityProvider Capabilities => this;
    public IPluginLifetime Lifetime => this;
    public IPluginLogger Logger => this;
    public IPluginDispatcher Dispatcher => this;
    public PluginDirectorySet Directories { get; }
    public CancellationToken Stopping => _stopping.Token;
    PluginServiceId IPluginService.Id => PluginServiceIds.Commands;
    PluginApiVersion IPluginService.Version => ApiVersion;
    string IPluginCapability.Id => "pcl.settings-pages";
    PluginApiVersion IPluginCapability.Version => ApiVersion;

    public bool TryGet<TService>(out TService? service) where TService : class, IPluginService
    {
        service = null;
        if (!_disposed && !Stopping.IsCancellationRequested)
        {
            if (typeof(TService) == typeof(IPluginCommandService) && _grants.Contains("pcl.commands")) service = this as TService;
            if (typeof(TService) == typeof(IPluginNotificationService) && _grants.Contains("pcl.notifications")) service = _notifications as TService;
        }
        return service is not null;
    }
    public TService Require<TService>() where TService : class, IPluginService => TryGet<TService>(out var service) ? service! :
        throw new NotSupportedException("Service is unavailable or permission was denied.");
    public bool Supports(PluginServiceId serviceId, PluginApiVersionRange range) => !_disposed && !Stopping.IsCancellationRequested &&
        ((serviceId == PluginServiceIds.Commands && _grants.Contains("pcl.commands")) ||
        (serviceId == PluginServiceIds.Notifications && _grants.Contains("pcl.notifications"))) && range.Contains(ApiVersion);
    bool IPluginCapabilityProvider.TryGet<TCapability>(out TCapability? capability) where TCapability : class
    {
        capability = !_disposed && !Stopping.IsCancellationRequested && typeof(TCapability) == typeof(IPluginLocalizedSettingsPageCapability) && _grants.Contains("pcl.settings-pages") ? this as TCapability : null;
        return capability is not null;
    }

    private void RequireGrant(string grant)
    {
        if (_disposed || !_grants.Contains(grant)) throw new InvalidOperationException("Permission is unavailable.");
        Stopping.ThrowIfCancellationRequested();
    }
    private static string Text(string value, int limit = 2000)
    {
        if (value.Length > limit || value.Any(c => char.IsControl(c) && c != '\n')) throw new InvalidOperationException("Plugin text exceeds the descriptor contract.");
        return value;
    }
    public IPluginRegistration Register(PluginCommandDescriptor descriptor)
    {
        RequireGrant("pcl.commands");
        Text(descriptor.Id, 128);
        Text(descriptor.Title);
        if (descriptor.Description is not null) Text(descriptor.Description);
        if (_commands.Count >= 32 || !_commands.TryAdd(descriptor.Id, descriptor)) throw new InvalidOperationException("Duplicate or excessive command registrations.");
        return new Registration(descriptor.Id, () => _commands.Remove(descriptor.Id));
    }
    public IPluginRegistration Register(PluginLocalizedSettingsPageDescriptor descriptor)
    {
        RequireGrant("pcl.settings-pages");
        string Localize(PclLocalizedString text) => Text(text.Key is not null && _translations.TryGetValue(text.Key, out string? value) ?
            string.Format(CultureInfo.GetCultureInfo(_culture), value, text.Arguments.ToArray()) : text.Fallback);
        if (_pages.Count >= 16 || descriptor.Hints.Count > 32) throw new InvalidOperationException("Excessive page registrations.");
        var page = new { id = Text(descriptor.Id, 128), title = Localize(descriptor.Title), heading = Localize(descriptor.Heading),
            description = Localize(descriptor.Description), hints = descriptor.Hints.Select(h => new { text = Localize(h.Text), kind = h.Kind.ToString() }).ToArray() };
        if (!_pages.TryAdd(descriptor.Id, page)) throw new InvalidOperationException("Duplicate page registration.");
        return new Registration(descriptor.Id, () => _pages.Remove(descriptor.Id));
    }
    public async Task InvokeAsync(string id, CancellationToken cancellationToken = default)
    {
        RequireGrant("pcl.commands");
        cancellationToken.ThrowIfCancellationRequested();
        if (!_commands.TryGetValue(id, out var command)) throw new InvalidOperationException("Command is not registered.");
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(Stopping, cancellationToken);
        await command.ExecuteAsync(linked.Token);
    }
    public object Snapshot() => new { pluginId = Plugin.Id.Value, culture = _culture,
        commands = _commands.Values.Select(c => new { id = c.Id, title = Text(c.Title), description = c.Description is null ? null : Text(c.Description) }).ToArray(),
        settingsPages = _pages.Values.ToArray(), logs = _logs.ToArray(), stopping = Stopping.IsCancellationRequested };
    public object DrainNotifications() => _notifications.Drain();

    private void TrackOwned(object registration)
    {
        RequireRunning();
        if (_tracked.Count >= 128) throw new InvalidOperationException("Too many tracked registrations.");
        _tracked.Add(registration);
    }
    public void Track(IPluginRegistration registration) => TrackOwned(registration);
    public void Track(IDisposable disposable) => TrackOwned(disposable);
    public void Track(IAsyncDisposable disposable) => TrackOwned(disposable);
    public void Cancel()
    {
        // A plugin's throwing cancellation callback cannot bypass owner cleanup.
        try { _stopping.Cancel(); }
        catch (AggregateException) { LogError("Plugin cancellation callback failed."); }
    }
    public async ValueTask DisposeAsync()
    {
        if (_disposed) return;
        _disposed = true; Cancel();
        try
        {
            foreach (var item in _tracked.AsEnumerable().Reverse())
            {
                try
                {
                    if (item is IAsyncDisposable asyncDisposable) await asyncDisposable.DisposeAsync();
                    else if (item is IDisposable disposable) disposable.Dispose();
                }
                catch { LogError("Registration cleanup failed."); }
            }
        }
        finally
        {
            // Owner registries are cleared even if a plugin forgot Lifetime.Track.
            _commands.Clear(); _pages.Clear(); _notifications.Clear(); _tracked.Clear(); _grants.Clear();
        }
    }
    private void Log(string level, string message)
    {
        if (_logs.Count < 64) _logs.Add(new { level, message = Text(message) });
    }
    public void Trace(string message) => Log("trace", message);
    public void Debug(string message) => Log("debug", message);
    public void Info(string message) => Log("info", message);
    public void Warn(string message) => Log("warning", message);
    public void LogError(string message, Exception? exception = null) => Log("error", message);
    public void Post(Action action) { RequireRunning(); action(); }
    public Task InvokeAsync(Action action, CancellationToken cancellationToken = default) { RequireRunning(); cancellationToken.ThrowIfCancellationRequested(); action(); return Task.CompletedTask; }
    public Task<T> InvokeAsync<T>(Func<T> action, CancellationToken cancellationToken = default) { RequireRunning(); cancellationToken.ThrowIfCancellationRequested(); return Task.FromResult(action()); }
    private void RequireRunning() { if (_disposed) throw new InvalidOperationException("Plugin is stopped."); Stopping.ThrowIfCancellationRequested(); }

    private sealed class Registration(string id, Action remove) : IPluginRegistration
    {
        public string Id => id;
        public bool IsActive { get; private set; } = true;
        public ValueTask DisposeAsync() { if (IsActive) { IsActive = false; remove(); } return ValueTask.CompletedTask; }
    }
}
