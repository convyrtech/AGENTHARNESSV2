using System.Diagnostics;
using System.Text.Json;

var target = Environment.GetEnvironmentVariable("MUNIM_PROXY_TARGET");
var logPath = Environment.GetEnvironmentVariable("MUNIM_PROXY_LOG");
if (string.IsNullOrWhiteSpace(target) || string.IsNullOrWhiteSpace(logPath))
{
    Console.Error.WriteLine("MUNIM_PROXY_TARGET and MUNIM_PROXY_LOG are required");
    return 2;
}

var pending = new Dictionary<string, string>();
var gate = new object();
void Log(object entry)
{
    lock (gate) File.AppendAllText(logPath, JsonSerializer.Serialize(entry) + Environment.NewLine);
}
Log(new { direction = "proxy-start" });

var process = new Process
{
    StartInfo = new ProcessStartInfo(target)
    {
        UseShellExecute = false,
        RedirectStandardInput = true,
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        CreateNoWindow = true,
    },
    EnableRaisingEvents = true,
};
process.Start();

var stdout = Task.Run(async () =>
{
    while (await process.StandardOutput.ReadLineAsync() is { } line)
    {
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            var id = root.TryGetProperty("id", out var idValue) ? idValue.ToString() : null;
            string? method = null;
            var hasError = root.TryGetProperty("error", out _);
            if (id is not null)
            {
                lock (gate) pending.Remove(id, out method);
                Log(new { direction = "from-munim", id, method, hasError });
            }
            else if (root.TryGetProperty("method", out var methodValue))
            {
                method = methodValue.GetString();
                Log(new { direction = "from-munim", method });
            }
        }
        catch { Log(new { direction = "from-munim", malformedJson = true }); }
        await Console.Out.WriteLineAsync(line);
        await Console.Out.FlushAsync();
    }
});

var stderr = Task.Run(async () =>
{
    while (await process.StandardError.ReadLineAsync() is { } line)
        Log(new { direction = "munim-stderr", line = line.Length > 400 ? line[..400] : line });
});

try
{
    while (await Console.In.ReadLineAsync() is { } line)
    {
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            var id = root.TryGetProperty("id", out var idValue) ? idValue.ToString() : null;
            var method = root.TryGetProperty("method", out var methodValue) ? methodValue.GetString() : null;
            string? name = null;
            string? requestId = null;
            if (method == "tools/call" && root.TryGetProperty("params", out var parameters) && parameters.TryGetProperty("name", out var nameValue))
                name = nameValue.GetString();
            if (method == "notifications/cancelled" && root.TryGetProperty("params", out var cancellation) && cancellation.TryGetProperty("requestId", out var requestIdValue))
                requestId = requestIdValue.ToString();
            if (id is not null && method is not null)
                lock (gate) pending[id] = method;
        }
        catch { Log(new { direction = "to-munim", malformedJson = true }); }
        await process.StandardInput.WriteLineAsync(line);
        await process.StandardInput.FlushAsync();
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            var id = root.TryGetProperty("id", out var idValue) ? idValue.ToString() : null;
            var method = root.TryGetProperty("method", out var methodValue) ? methodValue.GetString() : null;
            string? name = null;
            string? requestId = null;
            if (method == "tools/call" && root.TryGetProperty("params", out var parameters) && parameters.TryGetProperty("name", out var nameValue))
                name = nameValue.GetString();
            if (method == "notifications/cancelled" && root.TryGetProperty("params", out var cancellation) && cancellation.TryGetProperty("requestId", out var requestIdValue))
                requestId = requestIdValue.ToString();
            Log(new { direction = "forwarded-to-munim", id, method, name, requestId });
        }
        catch { Log(new { direction = "forwarded-to-munim", malformedJson = true }); }
    }
}
catch (IOException) { }
finally
{
    try { process.StandardInput.Close(); } catch { }
    var exitTask = process.WaitForExitAsync();
    await Task.WhenAny(stdout, exitTask, Task.Delay(TimeSpan.FromSeconds(10)));
    var forcedKill = !process.HasExited;
    if (forcedKill)
    {
        Log(new { direction = "munim-stdout-closed", processExited = false });
        try { process.Kill(entireProcessTree: true); } catch { }
        await exitTask;
    }
    Log(new { direction = "munim-exit", exitCode = process.ExitCode, forcedKill });
    await Task.WhenAll(stdout, stderr);
}
return process.HasExited ? process.ExitCode : 0;
