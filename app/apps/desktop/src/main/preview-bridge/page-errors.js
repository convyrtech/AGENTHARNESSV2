/*
 * Page errors for the «Код» preview: script errors, rejected promises, files that did not
 * load and the first console.error calls go to the parent window (the app), which offers
 * «Починить». Runs before the page's own scripts (it is injected right after <head>).
 */
(function () {
  if (window.parent === window || window.__prsloyErrors) return;
  window.__prsloyErrors = true;

  var SOURCE = "prsloy-preview";
  var sent = 0;
  var seen = {};
  var consoleLeft = 5;

  function place(url) {
    if (!url) return "";
    try {
      var parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? parsed.pathname : parsed.href;
    } catch {
      return String(url);
    }
  }

  function report(kind, message, file, line, column) {
    message = String(message || "").trim();
    if (!message || sent >= 20) return;
    var key = kind + "|" + message + "|" + file + "|" + line;
    if (seen[key]) return;
    seen[key] = true;
    sent += 1;
    window.parent.postMessage(
      {
        source: SOURCE,
        type: "error",
        kind: kind,
        message: message.slice(0, 500),
        file: file || "",
        line: line || 0,
        column: column || 0,
        page: location.pathname,
      },
      "*",
    );
  }

  function text(value) {
    // Duck-typed: an Error from another frame or a DOMException is not `instanceof Error`.
    if (value && typeof value === "object" && typeof value.message === "string") {
      return (value.name ? value.name + ": " : "") + value.message;
    }
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  window.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && target !== window && target.tagName) {
        var url = target.currentSrc || target.src || target.href || "";
        report("resource", target.tagName.toLowerCase() + " " + place(url), place(url), 0, 0);
        return;
      }
      // A cross-origin script hides its error: "Script error." with nothing to fix.
      if (!event.filename && /^Script error\.?$/i.test(event.message || "")) return;
      report("script", event.message, place(event.filename), event.lineno, event.colno);
    },
    true,
  );

  window.addEventListener("unhandledrejection", function (event) {
    report("promise", text(event.reason), "", 0, 0);
  });

  var original = console.error;
  console.error = function () {
    if (consoleLeft > 0) {
      consoleLeft -= 1;
      report("console", Array.prototype.map.call(arguments, text).join(" "), "", 0, 0);
    }
    return original.apply(console, arguments);
  };
})();
