using PCL.N.Plugin;
using System.Text;

namespace PclRh.NCompatibilityProbe;

// A separate service object keeps IPluginService.Id truthful. Cached service
// references always call the owner guard, including after revoke/disposal.
internal sealed class ProbeNotifications(Action requireGrant, string sessionId) : IPluginNotificationService
{
    private readonly List<object> _pending = [];
    private int _sequence;
    private readonly object _gate = new();
    public PluginServiceId Id => PluginServiceIds.Notifications;
    public PluginApiVersion Version => new(0, 2);
    public void ShowInformation(string message) => Show("information", message);
    public void ShowWarning(string message) => Show("warning", message);

    private void Show(string severity, string message)
    {
        requireGrant();
        // Strict UTF-16 validity keeps this transport in agreement with RH's
        // Unicode scalar/control checks, including valid supplementary symbols.
        _ = new UTF8Encoding(false, true).GetByteCount(message);
        if (string.IsNullOrWhiteSpace(message) || message.Trim() != message || message.EnumerateRunes().Count() > 1000 ||
            message.EnumerateRunes().Any(r => Rune.GetUnicodeCategory(r) is System.Globalization.UnicodeCategory.Control or System.Globalization.UnicodeCategory.Format))
            throw new InvalidOperationException("Notification text violates the transport contract.");
        lock (_gate)
        {
            requireGrant();
            if (_pending.Count >= 16 || _sequence >= 64) throw new InvalidOperationException("Notification quota exceeded.");
            _pending.Add(new { sequence = ++_sequence, severity, message });
        }
    }
    public object Drain()
    {
        lock (_gate)
        {
            var batch = new { schemaVersion = 1, sessionId, notices = _pending.ToArray() };
            _pending.Clear();
            return batch;
        }
    }
    public void Clear() { lock (_gate) { _pending.Clear(); } }
}
