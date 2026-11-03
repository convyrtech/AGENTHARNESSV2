using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Windows.Forms;

// Test-only MCP relay. It launches the explicitly configured real Munim binary as a direct
// child, retains that Process handle, and never logs backend text, window titles, stderr, or UI.
if (args.Length == 1 && args[0] == "--sanitizer-self-test")
    return MunimResponseSanitizer.RunOfflineContractTests();

var configPath = Path.Combine(AppContext.BaseDirectory, "munim-backend-failure.json");
if (!File.Exists(configPath)) return 2;
using var configDoc = JsonDocument.Parse(File.ReadAllText(configPath));
var config = configDoc.RootElement;
var target = config.GetProperty("target").GetString();
var logPath = config.GetProperty("log").GetString();
var startSentinel = config.GetProperty("startSentinel").GetString();
var endSentinel = config.GetProperty("endSentinel").GetString();
var killPermit = config.GetProperty("killPermit").GetString();
var fixturePid = config.GetProperty("fixturePid").GetInt32();
var fixtureHwnd = config.GetProperty("fixtureHwnd").GetInt64();
var fixtureTitle = config.GetProperty("fixtureTitle").GetString();
var fixtureX = config.GetProperty("fixtureX").GetInt32();
var fixtureY = config.GetProperty("fixtureY").GetInt32();
var fixtureWidth = config.GetProperty("fixtureWidth").GetInt32();
var fixtureHeight = config.GetProperty("fixtureHeight").GetInt32();
if (string.IsNullOrWhiteSpace(target) || !Path.IsPathFullyQualified(target) ||
    string.IsNullOrWhiteSpace(logPath) || string.IsNullOrWhiteSpace(startSentinel) ||
    string.IsNullOrWhiteSpace(endSentinel) || string.IsNullOrWhiteSpace(killPermit) || fixturePid <= 0 || fixtureHwnd <= 0 ||
    string.IsNullOrWhiteSpace(fixtureTitle) || fixtureWidth <= 0 || fixtureHeight <= 0) return 2;

var logGate = new object();
var pendingMethods = new System.Collections.Concurrent.ConcurrentDictionary<int, string>();
var pendingNames = new System.Collections.Concurrent.ConcurrentDictionary<int, string>();
string? childCreationUtcTicks = null;
string? childImagePath = null;
void Log(string kind, int? requestId = null, int? childPid = null, string? reasonCode = null) {
    using var proxyProcess = Process.GetCurrentProcess();
    lock (logGate) File.AppendAllText(logPath!, JsonSerializer.Serialize(new {
        kind, requestId, childPid, reasonCode, proxyPid = proxyProcess.Id,
        proxyCreationUtcTicks = proxyProcess.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture),
        proxyImagePath = Environment.ProcessPath, childCreationUtcTicks, childImagePath,
        realMunimPath = target, utc = DateTimeOffset.UtcNow
    }) + Environment.NewLine);
}
bool ValidateTargetWindow() => TargetWindowCheck.IsCurrent(fixturePid, fixtureHwnd, fixtureTitle!, fixtureX, fixtureY, fixtureWidth, fixtureHeight);
void LogStartupFailure(string reasonCode, int? childPid = null)
{
    Log("proxy-start-failed", childPid: childPid, reasonCode: reasonCode);
    Log("proxy-exit", childPid: childPid);
}

Log("proxy-started");
var child = new Process {
    StartInfo = new ProcessStartInfo(target) {
        UseShellExecute = false, RedirectStandardInput = true, RedirectStandardOutput = true,
        RedirectStandardError = true, CreateNoWindow = true,
    },
    EnableRaisingEvents = true,
};
bool childStarted;
try { childStarted = child.Start(); }
catch {
    LogStartupFailure("real_munim_start_exception");
    child.Dispose();
    return 3;
}
if (!childStarted) {
    LogStartupFailure("real_munim_start_returned_false");
    child.Dispose();
    return 3;
}
var childPid = child.Id;
try { childCreationUtcTicks = child.StartTime.ToUniversalTime().Ticks.ToString(System.Globalization.CultureInfo.InvariantCulture); }
catch { Log("real-munim-image-check-failed", childPid: childPid, reasonCode: "creation_time_read_failed"); }
string? childPath;
try { childPath = child.MainModule?.FileName; }
catch {
    Log("real-munim-image-check-failed", childPid: childPid, reasonCode: "image_read_failed");
    try {
        if (!child.HasExited) child.Kill();
        if (!child.WaitForExit(3_000))
            Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "bounded_exit_timeout");
    } catch { Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "owned_handle_kill_failed"); }
    LogStartupFailure("real_munim_image_read_failed", childPid);
    child.Dispose();
    return 4;
}
childImagePath = Path.GetFullPath(childPath ?? "");
if (!string.Equals(Path.GetFullPath(childPath ?? ""), Path.GetFullPath(target), StringComparison.OrdinalIgnoreCase)) {
    Log("real-munim-image-check-failed", childPid: childPid, reasonCode: "image_path_mismatch");
    try {
        if (!child.HasExited) child.Kill();
        if (!child.WaitForExit(3_000))
            Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "bounded_exit_timeout");
    } catch { Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "owned_handle_kill_failed"); }
    LogStartupFailure("real_munim_image_path_mismatch", childPid);
    child.Dispose();
    return 4;
}
if (childCreationUtcTicks is null || string.IsNullOrEmpty(childImagePath)) {
    try {
        if (!child.HasExited) child.Kill();
        if (!child.WaitForExit(3_000))
            Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "bounded_exit_timeout");
    } catch { Log("startup-child-cleanup-failed", childPid: childPid, reasonCode: "owned_handle_kill_failed"); }
    LogStartupFailure("real_munim_identity_read_failed", childPid);
    child.Dispose();
    return 4;
}
Log("real-munim-child-started", childPid: childPid);

var answers = new HashSet<int>();
var answersGate = new object();
var activeClickId = 0;
var clickResultBeforeKill = 0;
var stdout = Task.Run(async () => {
    while (await child.StandardOutput.ReadLineAsync() is { } line) {
        JsonDocument? parsed = null;
        try { parsed = JsonDocument.Parse(line); } catch { continue; }
        using (parsed) {
            var root = parsed.RootElement;
            if (!root.TryGetProperty("id", out var idEl) || !idEl.TryGetInt32(out var id)) continue;
            string? method = null;
            if (pendingMethods.TryRemove(id, out var remembered)) method = remembered;
            if (method == "tools/call" && id == Volatile.Read(ref activeClickId)) {
                Interlocked.Exchange(ref clickResultBeforeKill, 1);
                Log("click-result-before-controlled-kill", id, childPid);
                var firstAnswer = false;
                lock (answersGate) firstAnswer = answers.Add(id);
                if (firstAnswer) {
                    var response = JsonSerializer.Serialize(new { jsonrpc = "2.0", id, error = new { code = -32098, message = "Real Munim returned before the controlled backend failure; this test is inconclusive." } });
                    await Console.Out.WriteLineAsync(response); await Console.Out.FlushAsync();
                }
                continue;
            }
            string outgoing;
            if (method == "tools/call") {
                var callName = pendingNames.TryRemove(id, out var rememberedName) ? rememberedName : "";
                var sanitized = MunimResponseSanitizer.Sanitize(root, id, fixturePid, fixtureTitle!, callName);
                Log(sanitized.IsError ? "tool-result-rejected" : "tool-result-sanitized", id, childPid, sanitized.ReasonCode);
                outgoing = sanitized.Json;
            } else {
                outgoing = line;
            }
            lock (answersGate) answers.Add(id);
            await Console.Out.WriteLineAsync(outgoing); await Console.Out.FlushAsync();
        }
    }
});
// Munim diagnostics may include OS/window details: drain and discard them.
var stderr = Task.Run(async () => { while (await child.StandardError.ReadLineAsync() is not null) { } });

try {
    while (await Console.In.ReadLineAsync() is { } line) {
        var forwardClickId = 0;
        JsonDocument? parsed = null;
        try { parsed = JsonDocument.Parse(line); } catch { continue; }
        using (parsed) {
            var root = parsed.RootElement;
            if (!root.TryGetProperty("id", out var idEl) || !idEl.TryGetInt32(out var id)) {
                // Forward protocol notifications; never log params or content.
                await child.StandardInput.WriteLineAsync(line); await child.StandardInput.FlushAsync();
                continue;
            }
            var method = root.TryGetProperty("method", out var methodEl) ? methodEl.GetString() : null;
            if (method == "tools/call") {
                var parameters = root.GetProperty("params");
                var name = parameters.GetProperty("name").GetString();
                var toolArgs = parameters.TryGetProperty("arguments", out var a) ? a : default;
                if (!MunimMcpArgumentContract.Accepts(name ?? "", toolArgs, fixturePid)) { ReplyError(id, "test proxy rejected Munim arguments outside the exact fixture contract"); continue; }
                if (child.HasExited) { Log("request-blocked-after-real-munim-exit", id, childPid); ReplyError(id, "Real Munim child already exited; action not retried."); continue; }
                if (!ValidateTargetWindow()) { Log("live-fixture-preflight-failed", id, childPid); ReplyError(id, "Live fixture HWND/PID/title/bounds or DISPLAY2 validation failed."); continue; }
                Log("live-fixture-preflight-passed", id, childPid);
                Log(name == "click" ? "click-request-accepted" : "fixture-tool-forwarded", id, childPid);
                pendingMethods[id] = method;
                pendingNames[id] = name ?? "";
                if (name == "click") {
                    forwardClickId = id;
                    Interlocked.Exchange(ref activeClickId, id);
                    _ = Task.Run(async () => {
                        var deadline = DateTime.UtcNow.AddSeconds(15);
                        while (DateTime.UtcNow < deadline && !child.HasExited && !File.Exists(startSentinel)) await Task.Delay(40);
                        if (!File.Exists(startSentinel) || child.HasExited) { Log("click-sentinel-or-child-check-failed", id, childPid); return; }
                        Log("fixture-action-started", id, childPid);
                        var permitDeadline = DateTime.UtcNow.AddSeconds(20);
                        while (DateTime.UtcNow < permitDeadline && !child.HasExited && Volatile.Read(ref clickResultBeforeKill) == 0 && !File.Exists(killPermit)) await Task.Delay(40);
                        if (Volatile.Read(ref clickResultBeforeKill) != 0) { Log("early-click-result-makes-test-inconclusive", id, childPid); return; }
                        if (!File.Exists(killPermit) || child.HasExited) { Log("dispatching-checkpoint-or-child-check-failed", id, childPid); return; }
                        if (File.Exists(endSentinel)) { Log("click-ended-before-controlled-failure", id, childPid); return; }
                        if (!ValidateTargetWindow()) { Log("live-fixture-preflight-failed-before-kill", id, childPid); return; }
                        Log("live-fixture-preflight-passed-before-kill", id, childPid);
                        Log("kill-permit-received", id, childPid);
                        try { child.Kill(); } catch { Log("owned-child-kill-failed", id, childPid); return; }
                        await child.WaitForExitAsync();
                        Log("real-munim-child-exited-after-controlled-kill", id, childPid);
                        var shouldReply = false;
                        lock (answersGate) shouldReply = answers.Add(id);
                        if (shouldReply) {
                            var response = JsonSerializer.Serialize(new { jsonrpc = "2.0", id, error = new { code = -32099, message = "Munim exited during the started fixture action; outcome unknown. Do not retry." } });
                            await Console.Out.WriteLineAsync(response); await Console.Out.FlushAsync();
                        }
                    });
                }
            } else {
                if (method is not ("initialize" or "tools/list" or "ping")) { ReplyError(id, "test proxy rejected unsupported MCP method"); continue; }
                pendingMethods[id] = method ?? "";
            }
        }
        if (child.HasExited && Volatile.Read(ref activeClickId) == 0) break;
        if (!child.HasExited) {
            await child.StandardInput.WriteLineAsync(line); await child.StandardInput.FlushAsync();
            if (forwardClickId != 0) Log("click-forwarded-to-real-munim", forwardClickId, childPid);
        }
    }
} catch (IOException) { }
finally {
    try { child.StandardInput.Close(); } catch { }
    if (!child.HasExited) {
        var exitTask = child.WaitForExitAsync();
        var exited = await Task.WhenAny(exitTask, Task.Delay(TimeSpan.FromSeconds(3)));
        if (exited != exitTask) {
            try { child.Kill(); } catch { }
            await child.WaitForExitAsync();
            Log("bounded-cleanup-killed-owned-child", childPid: childPid);
        }
    }
    await Task.WhenAll(stdout, stderr);
    Log("proxy-exit", childPid: childPid);
}
return 0;

void ReplyError(int id, string message) {
    var response = JsonSerializer.Serialize(new { jsonrpc = "2.0", id, error = new { code = -32000, message } });
    Console.Out.WriteLine(response); Console.Out.Flush();
}

internal static class TargetWindowCheck
{
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);

    internal static bool IsCurrent(int pid, long hwndValue, string title, int x, int y, int width, int height)
    {
        var screen = Screen.AllScreens.SingleOrDefault(s => string.Equals(s.DeviceName, @"\\.\DISPLAY2", StringComparison.OrdinalIgnoreCase) && !s.Primary);
        if (screen is null || screen.Bounds.X != 2560 || screen.Bounds.Y != 0 || screen.Bounds.Width != 1920 || screen.Bounds.Height != 1080) return false;
        if (!screen.WorkingArea.Contains(new Rectangle(x, y, width, height))) return false;
        var hwnd = new IntPtr(hwndValue);
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return false;
        _ = GetWindowThreadProcessId(hwnd, out var actualPid);
        if (actualPid != (uint)pid) return false;
        var text = new StringBuilder(512);
        _ = GetWindowText(hwnd, text, text.Capacity);
        if (!string.Equals(text.ToString(), title, StringComparison.Ordinal)) return false;
        if (!GetWindowRect(hwnd, out var rect)) return false;
        return rect.Left == x && rect.Top == y && rect.Right - rect.Left == width && rect.Bottom - rect.Top == height;
    }
}
