/*
 * «Выбрать на странице» for the «Код» preview: highlight under the cursor, a click reports
 * the element to the parent window (the app), Esc cancels.
 *
 * Adapted from bolt.diy `public/inspector-script.js` (commit 353b44c).
 * MIT License, Copyright (c) 2024 StackBlitz, Inc. and bolt.diy contributors.
 * Changed by PRSLOY: style and text editing removed; a stable CSS path, an outerHTML excerpt
 * and the page path added; messages carry our `source` tag and Esc cancels.
 */
(function () {
  if (window.parent === window || window.__prsloyInspector) return;
  window.__prsloyInspector = true;

  var SOURCE = "prsloy-preview";
  var HOST = "prsloy-host";
  var active = false;
  var style = null;
  var highlighted = null;
  var escape =
    window.CSS && CSS.escape
      ? function (value) {
          return CSS.escape(value);
        }
      : function (value) {
          return String(value).replace(/[^\w-]/g, "\\$&");
        };

  function post(message) {
    message.source = SOURCE;
    window.parent.postMessage(message, "*");
  }

  function classNameOf(element) {
    var name = element.className;
    if (!name) return "";
    if (typeof name === "string") return name;
    if (name.baseVal !== undefined) return name.baseVal;
    return String(name);
  }

  // bolt.diy createReadableSelector: tag#id.first.three.classes
  function readableSelector(element) {
    var selector = element.tagName.toLowerCase();
    if (element.id) selector += "#" + element.id;
    var classes = classNameOf(element)
      .trim()
      .split(/\s+/)
      .filter(function (c) {
        return c && c.indexOf("prsloy-pick") !== 0;
      })
      .slice(0, 3);
    if (classes.length) selector += "." + classes.join(".");
    return selector;
  }

  // bolt.diy getElementPath, up to five steps from the body.
  function elementPath(element) {
    var path = [];
    var current = element;
    while (current && current !== document.body && current !== document.documentElement) {
      path.unshift(readableSelector(current).replace(/(\.[^.]+).*/, "$1"));
      current = current.parentElement;
      if (path.length >= 5) break;
    }
    return path.join(" > ");
  }

  /** A CSS path that finds exactly this element: nearest id, then :nth-of-type steps. */
  function cssPath(element) {
    var steps = [];
    var current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      var tag = current.tagName.toLowerCase();
      if (current.id && document.querySelectorAll("#" + escape(current.id)).length === 1) {
        steps.unshift("#" + escape(current.id));
        break;
      }
      var step = tag;
      var parent = current.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === current.tagName;
        });
        if (same.length > 1) step += ":nth-of-type(" + (same.indexOf(current) + 1) + ")";
      }
      steps.unshift(step);
      if (tag === "body") break;
      current = parent;
    }
    return steps.join(" > ");
  }

  function excerpt(element) {
    var clone = element.cloneNode(true);
    clone.classList.remove("prsloy-pick-highlight");
    if (!clone.getAttribute("class")) clone.removeAttribute("class");
    var html = clone.outerHTML.replace(/\s+/g, " ");
    return html.length > 300 ? html.slice(0, 300) + "…" : html;
  }

  function info(element) {
    return {
      type: "picked",
      tag: element.tagName.toLowerCase(),
      selector: cssPath(element),
      path: elementPath(element),
      text: (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120),
      html: excerpt(element),
      page: location.pathname,
    };
  }

  function unhighlight() {
    if (highlighted) highlighted.classList.remove("prsloy-pick-highlight");
    highlighted = null;
  }

  function onMove(event) {
    var target = event.target;
    if (!target || target === document.body || target === document.documentElement) return;
    if (target === highlighted) return;
    unhighlight();
    target.classList.add("prsloy-pick-highlight");
    highlighted = target;
  }

  function onClick(event) {
    event.preventDefault();
    event.stopPropagation();
    var target = event.target;
    if (!target || target === document.body || target === document.documentElement) return;
    unhighlight();
    post(info(target));
    setActive(false);
  }

  function onKey(event) {
    if (event.key !== "Escape") return;
    event.preventDefault();
    setActive(false);
    post({ type: "pick-cancel" });
  }

  function swallow(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function setActive(next) {
    if (next === active) return;
    active = next;
    var method = next ? "addEventListener" : "removeEventListener";
    document[method]("mousemove", onMove, true);
    document[method]("click", onClick, true);
    document[method]("mousedown", swallow, true);
    document[method]("submit", swallow, true);
    document[method]("keydown", onKey, true);
    document[method]("mouseleave", unhighlight, true);
    if (next) {
      style = document.createElement("style");
      style.textContent =
        "html.prsloy-pick-active, html.prsloy-pick-active * { cursor: crosshair !important; }" +
        ".prsloy-pick-highlight { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; }";
      document.head.appendChild(style);
      document.documentElement.classList.add("prsloy-pick-active");
    } else {
      unhighlight();
      document.documentElement.classList.remove("prsloy-pick-active");
      if (style) style.remove();
      style = null;
    }
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.source !== HOST) return;
    if (data.type === "pick") setActive(data.active === true);
  });

  post({ type: "ready" });
})();
