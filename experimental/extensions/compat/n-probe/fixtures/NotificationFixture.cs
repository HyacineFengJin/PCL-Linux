using PCL.N.Plugin;

namespace PclRh.NProbeFixtures;

// RH-authored ABI fixture, not an upstream plugin/package compatibility test.
// Retain service handles to check that revoke stops callbacks, not only lookup.
public sealed class NotificationFixture : IPclNPlugin
{
    private IPluginContext? _context;
    private IPluginNotificationService? _notifications;
    public ValueTask InitializeAsync(IPluginContext context, CancellationToken cancellationToken)
    {
        _context = context;
        var commands = context.Services.Require<IPluginCommandService>();
        context.Services.TryGet<IPluginNotificationService>(out _notifications);
        if (_notifications is not null && _notifications.Id != PluginServiceIds.Notifications)
            throw new InvalidOperationException("Notification service identity mismatch.");
        if (context.Services.Supports(PluginServiceIds.Notifications, PluginApiVersionRange.Parse(">=0.2 <1.0")) != (_notifications is not null) ||
            context.Services.Supports(PluginServiceIds.Notifications, PluginApiVersionRange.Parse(">=1.0")))
            throw new InvalidOperationException("Notification service version coverage mismatch.");
        context.Lifetime.Track(commands.Register(new PluginCommandDescriptor("probe.notice.send", "Send notice", _ =>
        {
            var service = context.Services.Require<IPluginNotificationService>();
            service.ShowInformation("<b>Fixture information</b> 🧩");
            service.ShowWarning("Fixture warning.");
            return Task.CompletedTask;
        })));
        context.Lifetime.Track(commands.Register(new PluginCommandDescriptor("probe.notice.invalid", "Invalid notice", _ =>
        {
            context.Services.Require<IPluginNotificationService>().ShowWarning("Spoof\u202eidentity");
            return Task.CompletedTask;
        })));
        context.Lifetime.Track(commands.Register(new PluginCommandDescriptor("probe.notice.burst", "Notice burst", _ =>
        {
            var service = context.Services.Require<IPluginNotificationService>();
            for (int i = 0; i < 17; i++) service.ShowInformation("Bounded fixture notice.");
            return Task.CompletedTask;
        })));
        context.Lifetime.Track((IDisposable)cancellationToken.Register(() => throw new InvalidOperationException("Fixture cancellation failure.")));
        context.Lifetime.Track(new ThrowingCleanup());
        return ValueTask.CompletedTask;
    }

    public ValueTask ShutdownAsync(CancellationToken cancellationToken)
    {
        var context = _context!;
        if (context.Services.TryGet<IPluginNotificationService>(out _) ||
            context.Services.Supports(PluginServiceIds.Notifications, PluginApiVersionRange.Parse("*")))
            throw new InvalidOperationException("Stopped service still advertised.");
        if (_notifications is not null)
        {
            try { _notifications.ShowWarning("This must not escape shutdown."); }
            catch (Exception) { context.Logger.Info("Cached notification service denied after stop."); return ValueTask.CompletedTask; }
            throw new InvalidOperationException("Cached service bypassed stopping.");
        }
        return ValueTask.CompletedTask;
    }

    private sealed class ThrowingCleanup : IDisposable
    {
        public void Dispose() => throw new InvalidOperationException("Fixture cleanup failure.");
    }
}

public sealed class FailedNotificationFixture : IPclNPlugin
{
    public ValueTask InitializeAsync(IPluginContext context, CancellationToken cancellationToken)
    {
        context.Services.Require<IPluginNotificationService>().ShowInformation("This must not survive failed initialization.");
        context.Services.Require<IPluginCommandService>().Register(new PluginCommandDescriptor("probe.failed.untracked", "Untracked fixture", _ => Task.CompletedTask));
        throw new InvalidOperationException("Fixture initialization failure.");
    }
    public ValueTask ShutdownAsync(CancellationToken cancellationToken) => ValueTask.CompletedTask;
}
