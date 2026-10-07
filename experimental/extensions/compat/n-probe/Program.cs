// Developer-only ABI probe. The launcher never starts this process or loads a
// foreign assembly. Run through the namespace sandbox in verify-n.mjs; this
// bridge implements command/settings descriptors, not Avalonia or host patches.
using System.Reflection;
using System.Text.Json;
using PCL.N.Plugin;
using PclRh.NCompatibilityProbe;

if (args.Length != 3)
    throw new ArgumentException("Expected plugin assembly, manifest and locale directory.");
var output = Console.Out;
// Third-party Console output must not become a host protocol envelope.
Console.SetOut(TextWriter.Null);
using var manifestDocument = JsonDocument.Parse(await File.ReadAllTextAsync(args[1]));
var manifest = manifestDocument.RootElement;
string entryType = manifest.GetProperty("entryPoint").GetProperty("type").GetString()!;
var descriptor = new PluginDescriptor(new PluginId(manifest.GetProperty("id").GetString()!),
    manifest.GetProperty("name").GetString()!, PluginVersion.Parse(manifest.GetProperty("version").GetString()!));
ProbeContext? context = null;
IPclNPlugin? plugin = null;
string state = "uninitialized";
while (await Console.In.ReadLineAsync() is { } line)
{
    object reply;
    try
    {
        if (line.Length > 65536) throw new InvalidOperationException("Probe request exceeds limit.");
        using var document = JsonDocument.Parse(line);
        var request = document.RootElement;
        string operation = request.GetProperty("operation").GetString()!;
        switch (operation)
        {
            case "initialize":
                if (state != "uninitialized") throw new InvalidOperationException("Probe cannot be initialized twice.");
                var grants = request.GetProperty("grants").EnumerateArray().Select(v => v.GetString()!).ToArray();
                string culture = request.GetProperty("culture").GetString()!;
                context = new ProbeContext(descriptor, grants, culture, args[2]);
                try
                {
                    var assembly = Assembly.LoadFrom(Path.GetFullPath(args[0]));
                    var type = assembly.GetType(entryType, throwOnError: true)!;
                    plugin = Activator.CreateInstance(type) as IPclNPlugin ?? throw new InvalidOperationException("Entry does not implement the public SDK ABI.");
                    await plugin.InitializeAsync(context, context.Stopping);
                    state = "active";
                }
                catch
                {
                    await context.DisposeAsync();
                    state = "failed";
                    throw;
                }
                break;
            case "invoke":
                if (state != "active" || context is null) throw new InvalidOperationException("Plugin is not active.");
                await context.InvokeAsync(request.GetProperty("command").GetString()!);
                break;
            case "snapshot": break;
            case "shutdown":
            case "revoke":
                if (context is null) throw new InvalidOperationException("Plugin has not been initialized.");
                // Revoke stops the entire probe: existing callback handles may
                // not survive a capability change. Cleanup also runs on errors.
                try
                {
                    context.Cancel();
                    if (plugin is not null && state == "active") await plugin.ShutdownAsync(CancellationToken.None);
                }
                finally { await context.DisposeAsync(); state = "stopped"; }
                break;
            default: throw new InvalidOperationException("Unknown probe operation.");
        }
        reply = new { ok = true, result = new { state, sdkAssemblyVersion = typeof(IPclNPlugin).Assembly.GetName().Version?.ToString(),
            projection = context?.Snapshot() } };
    }
    catch (Exception error)
    {
        reply = new { ok = false, error = error is TargetInvocationException ? "Plugin initialization failed." : error.Message[..Math.Min(error.Message.Length, 300)],
            result = new { state, projection = context?.Snapshot() } };
    }
    await output.WriteLineAsync(JsonSerializer.Serialize(reply));
    await output.FlushAsync();
}
if (context is not null)
{
    try { context.Cancel(); if (plugin is not null && state == "active") await plugin.ShutdownAsync(CancellationToken.None); }
    finally { await context.DisposeAsync(); }
}
