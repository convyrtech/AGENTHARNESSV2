using System.Text.Json;

public static class MunimMcpArgumentContract
{
    public static bool Accepts(string name, JsonElement arguments, int fixturePid)
    {
        if (arguments.ValueKind != JsonValueKind.Object || fixturePid <= 0) return false;
        var properties = arguments.EnumerateObject().ToArray();
        if (name == "list_apps") return properties.Length == 0;
        if (name == "get_app_state")
            return properties.Length == 1 && properties[0].NameEquals("app") &&
                properties[0].Value.ValueKind == JsonValueKind.String &&
                properties[0].Value.GetString() == fixturePid.ToString();
        if (name == "click")
        {
            if (properties.Length != 2) return false;
            var app = arguments.TryGetProperty("app", out var appValue) && appValue.ValueKind == JsonValueKind.String && appValue.GetString() == fixturePid.ToString();
            var element = arguments.TryGetProperty("element_id", out var elementValue) && elementValue.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(elementValue.GetString());
            return app && element;
        }
        return false;
    }
}
