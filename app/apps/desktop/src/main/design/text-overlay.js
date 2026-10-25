/*
 * «Править» in «Дизайн», text without a model (research/20 §4): a double click on a piece of
 * plain text makes it editable in place; Enter or leaving it keeps the new text, Esc puts the old
 * one back. The new text goes to the app, which writes it into the source only when the place is
 * certain (`text-edit.ts`); the page itself never writes anything.
 *
 * By the idea of Dyad `worker/dyad-visual-editor-client.js` (contentEditable, the text posted on
 * leaving; Apache-2.0); written anew, no code taken.
 *
 * Messages to the parent: {source: "prsloy-design-text", type: "text-edit", file, line, col,
 * before, after} and {source: "prsloy-design-text", type: "text-refused", reason: "nested" | "move"
 * | "unmarked"}. Only pages from the «Править» preview server carry it, next to the inspector.
 */
(function () {
  if (window.parent === window || window.__prsloyTextEdit) return;
  window.__prsloyTextEdit = true;

  var SOURCE = "prsloy-design-text";
  var editing = null;
  var before = "";
  // the inspector picks on the first click of a double click: that pair is a pick, not a text edit
  var pickingAtDown = false;

  function post(message) {
    message.source = SOURCE;
    window.parent.postMessage(message, "*");
  }

  function place(element) {
    var mark = element.getAttribute("data-pl") || "";
    var colAt = mark.lastIndexOf(":");
    var lineAt = mark.lastIndexOf(":", colAt - 1);
    if (lineAt <= 0) return null;
    return {
      file: mark.slice(0, lineAt),
      line: Number(mark.slice(lineAt + 1, colAt)),
      col: Number(mark.slice(colAt + 1)),
    };
  }

  function finish(keep) {
    var element = editing;
    if (!element) return;
    editing = null;
    element.removeEventListener("keydown", onKey, true);
    element.removeEventListener("blur", onBlur, true);
    element.removeAttribute("contenteditable");
    element.style.outline = "";
    var after = element.textContent || "";
    if (!keep || after.trim() === before.trim()) {
      element.textContent = before;
      return;
    }
    var at = place(element);
    if (!at) return;
    post({
      type: "text-edit",
      file: at.file,
      line: at.line,
      col: at.col,
      before: before,
      after: after,
    });
  }

  function onKey(event) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  }

  function onBlur() {
    finish(true);
  }

  window.addEventListener(
    "mousedown",
    function (event) {
      // the second press of a double click comes after the inspector has already stopped picking
      if (event.detail <= 1) {
        pickingAtDown = document.documentElement.classList.contains("prsloy-pick-active");
      }
    },
    true,
  );

  window.addEventListener(
    "dblclick",
    function (event) {
      if (pickingAtDown || editing) return;
      var element = event.target;
      if (!element || element.nodeType !== 1) return;
      if (element === document.body || element === document.documentElement) return;
      event.preventDefault();
      if (element.closest("[data-move]")) return post({ type: "text-refused", reason: "move" });
      if (!element.hasAttribute("data-pl"))
        return post({ type: "text-refused", reason: "unmarked" });
      if (element.children.length > 0 || !(element.textContent || "").trim()) {
        return post({ type: "text-refused", reason: "nested" });
      }
      editing = element;
      before = element.textContent || "";
      element.setAttribute("contenteditable", "plaintext-only");
      element.style.outline = "2px solid #3b82f6";
      element.addEventListener("keydown", onKey, true);
      element.addEventListener("blur", onBlur, true);
      element.focus();
      var range = document.createRange();
      range.selectNodeContents(element);
      var selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
    },
    true,
  );
})();
