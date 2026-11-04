using System.Text.Json;

using var empty = JsonDocument.Parse("{}");
using var state = JsonDocument.Parse("{\"app\":\"42\"}");
using var click = JsonDocument.Parse("{\"app\":\"42\",\"element_id\":\"e1\"}");
using var wrongPid = JsonDocument.Parse("{\"app\":\"43\"}");
using var highLevel = JsonDocument.Parse("{\"pid\":42}");
using var extra = JsonDocument.Parse("{\"app\":\"42\",\"element_id\":\"e1\",\"text\":\"x\"}");
if (!MunimMcpArgumentContract.Accepts("list_apps", empty.RootElement, 42) ||
    !MunimMcpArgumentContract.Accepts("get_app_state", state.RootElement, 42) ||
    !MunimMcpArgumentContract.Accepts("click", click.RootElement, 42) ||
    MunimMcpArgumentContract.Accepts("get_app_state", wrongPid.RootElement, 42) ||
    MunimMcpArgumentContract.Accepts("click", highLevel.RootElement, 42) ||
    MunimMcpArgumentContract.Accepts("click", extra.RootElement, 42) ||
    MunimMcpArgumentContract.Accepts("type_text", click.RootElement, 42))
    throw new InvalidOperationException("Munim raw MCP argument contract probe failed");
Console.WriteLine("Munim raw MCP argument contract passed: app string, exact element_id, exact fixture PID.");
