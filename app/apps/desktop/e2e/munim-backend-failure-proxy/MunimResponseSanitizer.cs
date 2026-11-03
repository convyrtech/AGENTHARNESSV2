using System.Text.Json;
using System.Text.RegularExpressions;

internal readonly record struct SanitizedToolResponse(string Json, string ReasonCode, bool IsError);

internal static class MunimResponseSanitizer
{
    internal static SanitizedToolResponse Sanitize(
        JsonElement root,
        int requestId,
        int fixturePid,
        string fixtureTitle,
        string callName)
    {
        if (root.ValueKind != JsonValueKind.Object)
            return Error(requestId, "response_not_object", "Unrecognized Munim response; filtered.");
        if (!root.TryGetProperty("result", out var result))
            return Error(requestId, "result_missing", "Unrecognized Munim response; filtered.");
        if (result.ValueKind != JsonValueKind.Object)
            return Error(requestId, "result_not_object", "Unrecognized Munim response; filtered.");
        if (result.TryGetProperty("isError", out var backendError))
        {
            if (backendError.ValueKind == JsonValueKind.True)
                return Error(requestId, "backend_tool_error", "Munim reported a tool error; details filtered.");
            if (backendError.ValueKind != JsonValueKind.False)
                return Error(requestId, "backend_error_flag_invalid", "Munim response error flag was invalid; details filtered.");
        }
        if (!result.TryGetProperty("content", out var content) || content.ValueKind != JsonValueKind.Array)
            return Error(requestId, "content_not_array", "Unrecognized Munim response; filtered.");

        var texts = content.EnumerateArray()
            .Where(x => x.ValueKind == JsonValueKind.Object && x.TryGetProperty("type", out var typeValue) && typeValue.ValueKind == JsonValueKind.String && typeValue.GetString() == "text")
            .Where(x => x.TryGetProperty("text", out var textValue) && textValue.ValueKind == JsonValueKind.String)
            .Select(x => x.GetProperty("text").GetString() ?? "")
            .ToArray();
        if (texts.Length != 1)
            return Error(requestId, "text_part_count", "Unrecognized Munim response; filtered.");

        var text = texts[0];
        if (callName == "list_apps")
        {
            var rows = text.Split('\n').Where(row => Regex.IsMatch(row, $@"(?:^|\s)pid={fixturePid}(?:\s|$)")).ToArray();
            if (rows.Length != 1)
                return Error(requestId, "fixture_pid_row_count", "Fixture PID not uniquely present; other windows filtered.");
            if (!Regex.IsMatch(rows[0], @"(?:^|\s)windows=1(?:\s|$)"))
                return Error(requestId, "fixture_window_count", "Fixture PID not uniquely present; other windows filtered.");
            return Success(requestId, "list_apps_sanitized", $"{fixtureTitle} [fixture] pid={fixturePid} windows=1");
        }

        if (callName == "get_app_state")
        {
            if (!Regex.IsMatch(text, $@"^\s*{fixturePid}\s*\(pid\s+{fixturePid}\)", RegexOptions.IgnoreCase))
                return Error(requestId, "state_pid_header_mismatch", "Munim state did not match the isolated fixture; filtered.");
            var lines = text.Split('\n').Select(x => x.TrimEnd('\r')).ToArray();
            var statusLines = lines.Where(x =>
                x.Contains("Ready", StringComparison.OrdinalIgnoreCase) ||
                x.Contains("Isolated action started", StringComparison.OrdinalIgnoreCase)).ToArray();
            if (statusLines.Length == 0)
                return Error(requestId, "state_status_missing", "Munim state did not match the isolated fixture; filtered.");
            if (statusLines.Length != 1)
                return Error(requestId, "state_status_multiple_rows", "Munim state did not match the isolated fixture; filtered.");
            var status = ParseStatus(statusLines[0]);
            if (status is null)
                return Error(requestId, "state_status_shape_invalid", "Munim state did not match the isolated fixture; filtered.");
            var actionLines = lines.Where(x => x.Contains("Start isolated test action", StringComparison.Ordinal)).ToArray();
            if (actionLines.Length != 1)
                return Error(requestId, "state_action_line_count", "Munim state did not match the isolated fixture; filtered.");
            var actionId = ParseAction(actionLines[0]);
            if (actionId is null && IsTokenizedActionRow(actionLines[0]))
                return Error(requestId, "state_action_tokenized_backend_id_unsupported", "Munim action identifier format is unsupported; details filtered.");
            if (actionId is null)
                return Error(requestId, "state_action_line_count", "Munim state did not match the isolated fixture; filtered.");
            return Success(requestId, "get_app_state_sanitized", $"{fixturePid} (pid {fixturePid})\n{status}\n[{actionId}] Button \"Start isolated test action\"");
        }

        return Error(requestId, "unsupported_tool", "Munim result did not match the owned fixture; filtered.");
    }

    internal static int RunOfflineContractTests()
    {
        Assert("list_apps_sanitized", false, 42, "list_apps",
            new { result = new { content = new[] { new { type = "text", text = "FOREIGN_WINDOW_SENTINEL [other] pid=99 windows=1\nPRSLOY Backend Failure Fixture [fixture] pid=42 windows=1" } } } },
            "PRSLOY Backend Failure Fixture [fixture] pid=42 windows=1");
        Assert("fixture_pid_row_count", true, 42, "list_apps",
            new { result = new { content = new[] { new { type = "text", text = "Other [app] pid=99 windows=1" } } } });
        Assert("fixture_window_count", true, 42, "list_apps",
            new { result = new { content = new[] { new { type = "text", text = "Fixture [app] pid=42 windows=2" } } } });
        Assert("get_app_state_sanitized", false, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nFOREIGN_WINDOW_SENTINEL\nmunim_v1.12345678-abcd-4abc-8abc-1234567890ab.2 Text \"Ready\"\n[e1] Button \"Start isolated test action\"" } } } },
            "42 (pid 42)\nReady\n[e1] Button \"Start isolated test action\"");
        Assert("backend_tool_error", true, 42, "get_app_state",
            new { result = new { isError = true, content = new[] { new { type = "text", text = "42 (pid 42)\nReady\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("backend_error_flag_invalid", true, 42, "get_app_state",
            new { result = new { isError = "false", content = new[] { new { type = "text", text = "42 (pid 42)\nReady\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("state_action_tokenized_backend_id_unsupported", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nReady\nmunim_v1.12345678-abcd-4abc-8abc-1234567890ab.1 Button \"Start isolated test action\"" } } } });
        Assert("state_pid_header_mismatch", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "99 (pid 99)\nReady\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("state_status_missing", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("state_status_shape_invalid", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nReady OTHER_PRIVATE_DATA\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("state_status_multiple_rows", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nReady\nIsolated action started\n[e1] Button \"Start isolated test action\"" } } } });
        Assert("state_action_line_count", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nReady" } } } });
        Assert("state_action_line_count", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "42 (pid 42)\nReady\n[e1] Button \"Start isolated test action\" OTHER_PRIVATE_DATA" } } } });
        Assert("text_part_count", true, 42, "get_app_state",
            new { result = new { content = new[] { new { type = "text", text = "one" }, new { type = "text", text = "two" } } } });
        Assert("response_not_object", true, 42, "get_app_state", new[] { "malformed" });
        Assert("result_not_object", true, 42, "get_app_state", new { result = "malformed" });

        Console.WriteLine("Munim response sanitizer offline contract passed (16 cases).");
        return 0;
    }

    private static void Assert(
        string expectedReason,
        bool expectedError,
        int pid,
        string callName,
        object response,
        string? expectedSanitizedText = null)
    {
        using var document = JsonDocument.Parse(JsonSerializer.Serialize(response));
        var actual = Sanitize(document.RootElement, 1, pid, "PRSLOY Backend Failure Fixture", callName);
        if (actual.ReasonCode != expectedReason || actual.IsError != expectedError)
            throw new InvalidOperationException("Munim response sanitizer contract mismatch.");
        using var output = JsonDocument.Parse(actual.Json);
        var text = output.RootElement.GetProperty("result").GetProperty("content")[0].GetProperty("text").GetString();
        if ((expectedSanitizedText is not null && text != expectedSanitizedText) || actual.Json.Contains("FOREIGN_WINDOW_SENTINEL", StringComparison.Ordinal))
            throw new InvalidOperationException("Munim response sanitizer leaked or changed isolated output.");
    }

    private static string? ParseStatus(string line)
    {
        var match = Regex.Match(line,
            @"^\s*(?:(?:munim_v1\.[0-9a-f-]{36}\.\d+|\[e\d+\])\s+Text\s+)?""(?<status>Ready|Isolated action started)""\s*$|^\s*(?<plain>Ready|Isolated action started)\s*$",
            RegexOptions.IgnoreCase);
        if (!match.Success) return null;
        return match.Groups["status"].Success ? match.Groups["status"].Value : match.Groups["plain"].Value;
    }

    private static string? ParseAction(string line)
    {
        var match = Regex.Match(line,
            @"^\s*(?:-\s*)?\[(?<legacy>e\d+)\]\s+Button\s+""Start isolated test action""\s*$");
        if (!match.Success) return null;
        return match.Groups["legacy"].Value;
    }

    private static bool IsTokenizedActionRow(string line) => Regex.IsMatch(line,
        @"^\s*(?:-\s*)?munim_v1\.[0-9a-f-]{36}\.\d+\s+Button\s+""Start isolated test action""\s*$");

    private static SanitizedToolResponse Success(int id, string reason, string text) =>
        new(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, result = new { content = new[] { new { type = "text", text } } } }), reason, false);

    private static SanitizedToolResponse Error(int id, string reason, string text) =>
        new(JsonSerializer.Serialize(new { jsonrpc = "2.0", id, result = new { content = new[] { new { type = "text", text } }, isError = true } }), reason, true);
}
