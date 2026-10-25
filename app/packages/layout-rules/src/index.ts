/**
 * Layout lint rules, run inside the page: `page.evaluate(lintLayout, options)` in the desktop
 * layout lint, `lintLayout.toString()` sent to the browser by the harness's page check. Keep
 * everything the function uses inside it — no imports, no module-level helpers — or the copy
 * that reaches the page breaks (test/self-contained.test.ts holds this).
 *
 * Rules (one violation per offending element):
 *   root-hscroll   the document scrolls sideways
 *   off-window     an element sticks out of the window, with no clipping/scrolling ancestor
 *   text-clipped   text cut by its box or a clipping ancestor without an intended ellipsis,
 *                  line-clamp or `data-clamp`
 *   overlap        two visible interactive elements cover each other
 *   target-size    an interactive element smaller than 24×24 CSS px (inline links in text aside)
 *   small-text     text under 11 CSS px
 *   focus-hidden   keyboard focus changes nothing on the element or 4 ancestors (checkFocus only)
 *   window-min     the window is narrower or lower than the app's minimum
 */

export type LayoutRule =
  | "root-hscroll"
  | "off-window"
  | "text-clipped"
  | "overlap"
  | "target-size"
  | "small-text"
  | "focus-hidden"
  | "window-min";

export type Box = { x: number; y: number; w: number; h: number };

export type LayoutViolation = {
  rule: LayoutRule;
  /** Stable path: nearest data-testid ancestor plus tags (`[data-testid="x"] button:nth-of-type(2)`). */
  selector: string;
  /** Visible text (or label) of the element, for people. */
  text: string;
  detail: string;
  box: Box;
};

export type LintOptions = {
  minWidth: number;
  minHeight: number;
  checkFocus: boolean;
  /** At most this many focusable elements get the focus check. */
  focusLimit?: number;
  /**
   * The page scrolls down (a site, not the app window): content below or above the visible part
   * is not «off-window», only what sticks out sideways is.
   */
  scrollsY?: boolean;
};

export function lintLayout(options: LintOptions): LayoutViolation[] {
  const out: LayoutViolation[] = [];
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const INTERACTIVE =
    'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"]';

  const boxOf = (r: DOMRect | { left: number; top: number; right: number; bottom: number }) => ({
    x: Math.round(r.left),
    y: Math.round(r.top),
    w: Math.round(r.right - r.left),
    h: Math.round(r.bottom - r.top),
  });

  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = el; node && node !== document.body; node = node.parentElement) {
      const testId = node.getAttribute("data-testid");
      if (testId) {
        parts.unshift(`[data-testid="${testId}"]`);
        break;
      }
      const tag = node.tagName.toLowerCase();
      const parent: Element | null = node.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === node!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      if (parts.length >= 6) break;
    }
    return parts.join(" > ");
  };

  const label = (el: Element): string => {
    const text =
      (el as HTMLElement).innerText?.trim() ||
      el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.getAttribute("placeholder") ||
      "";
    return text.replace(/\s+/g, " ").slice(0, 60);
  };

  const add = (rule: LayoutRule, el: Element, detail: string, box?: Box) =>
    out.push({
      rule,
      selector: cssPath(el),
      text: label(el),
      detail,
      box: box ?? boxOf(el.getBoundingClientRect()),
    });

  const shown = (el: Element): boolean => {
    if (el.closest('[aria-hidden="true"], [hidden], [inert]')) return false;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility !== "visible") return false;
    for (let node: Element | null = el; node; node = node.parentElement) {
      if (Number(getComputedStyle(node).opacity) === 0) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const clipsX = (s: CSSStyleDeclaration) => s.overflowX !== "visible";
  const clipsY = (s: CSSStyleDeclaration) => s.overflowY !== "visible";
  const scrolls = (v: string) => v === "auto" || v === "scroll";
  const intended = (el: Element): boolean => {
    if (el.closest("[data-clamp]")) return true;
    for (let node: Element | null = el; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.textOverflow === "ellipsis") return true;
      if (
        s.getPropertyValue("-webkit-line-clamp") &&
        s.getPropertyValue("-webkit-line-clamp") !== "none"
      )
        return true;
      if (node !== el && (clipsX(s) || clipsY(s))) break;
    }
    return false;
  };

  /** The part of el's box that is not cut away by clipping ancestors or the window. */
  const visibleRect = (el: Element) => {
    const r = el.getBoundingClientRect();
    let { left, top, right, bottom } = r;
    for (let node = el.parentElement; node; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.position === "fixed") break;
      if (!clipsX(s) && !clipsY(s)) continue;
      const p = node.getBoundingClientRect();
      if (clipsX(s)) {
        left = Math.max(left, p.left);
        right = Math.min(right, p.right);
      }
      if (clipsY(s)) {
        top = Math.max(top, p.top);
        bottom = Math.min(bottom, p.bottom);
      }
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, vw);
    bottom = Math.min(bottom, vh);
    return { left, top, right: Math.max(left, right), bottom: Math.max(top, bottom) };
  };

  /** A click on its visible part reaches the element (or a descendant) at the middle or a corner. */
  const onTop = (el: Element): boolean => {
    const v = visibleRect(el);
    if (v.right - v.left < 1 || v.bottom - v.top < 1) return false;
    const inset = Math.min(2, (v.right - v.left) / 4, (v.bottom - v.top) / 4);
    const points = [
      [(v.left + v.right) / 2, (v.top + v.bottom) / 2],
      [v.left + inset, v.top + inset],
      [v.right - inset, v.top + inset],
      [v.left + inset, v.bottom - inset],
      [v.right - inset, v.bottom - inset],
    ];
    return points.some(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return !!hit && (el === hit || el.contains(hit));
    });
  };

  // window-min
  if (window.innerWidth < options.minWidth || window.innerHeight < options.minHeight) {
    add(
      "window-min",
      document.documentElement,
      `окно ${window.innerWidth}×${window.innerHeight}, минимум ${options.minWidth}×${options.minHeight}`,
    );
  }

  // root-hscroll
  const root = document.scrollingElement ?? document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1) {
    add("root-hscroll", root, `scrollWidth ${root.scrollWidth} > ${root.clientWidth}`);
  }

  const all = [...document.body.querySelectorAll("*")].filter(
    (el) => !(el instanceof SVGElement && el.tagName.toLowerCase() !== "svg") && shown(el),
  );

  // off-window: the outermost element that leaves the window without anything clipping it
  const offending = new Set<Element>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    const outX = r.right > vw + 1 || r.left < -1;
    const out_ = outX || (!options.scrollsY && (r.bottom > vh + 1 || r.top < -1));
    if (!out_) continue;
    let clipped = false;
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (clipsX(s) || clipsY(s)) {
        clipped = true;
        break;
      }
      if (s.position === "fixed") break;
    }
    if (clipped) continue;
    if (el.parentElement && offending.has(el.parentElement)) {
      offending.add(el);
      continue;
    }
    offending.add(el);
    add(
      "off-window",
      el,
      `за окном: ${Math.round(r.left)},${Math.round(r.top)}–${Math.round(r.right)},${Math.round(r.bottom)} при окне ${vw}×${vh}`,
    );
  }

  // text-clipped and small-text: elements that hold text themselves
  const textOwners = all.filter((el) =>
    [...el.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim()),
  );
  for (const el of textOwners) {
    const s = getComputedStyle(el);
    const size = parseFloat(s.fontSize);
    if (size < 11) add("small-text", el, `шрифт ${size}px`);
    if (el.matches("input, textarea, select, option, pre, code, pre *, code *, .xterm *")) continue;
    if (el.closest('.xterm, [data-testid="code-preview-frame"], .cm-editor, .monaco-editor'))
      continue;
    // visually hidden text for screen readers (1×1 box, clip): not meant to be seen
    if (el.clientWidth <= 2 || el.clientHeight <= 2) continue;
    if (intended(el)) continue;
    const own =
      (clipsX(s) && !scrolls(s.overflowX) && el.scrollWidth > el.clientWidth + 1) ||
      (clipsY(s) && !scrolls(s.overflowY) && el.scrollHeight > el.clientHeight + 1);
    if (own) {
      add(
        "text-clipped",
        el,
        `текст ${el.scrollWidth}×${el.scrollHeight} в коробке ${el.clientWidth}×${el.clientHeight}`,
      );
      continue;
    }
    // cut by an ancestor that hides overflow (not one that scrolls: scrolled-away text is fine)
    const r = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      const ps = getComputedStyle(node);
      if (scrolls(ps.overflowX) || scrolls(ps.overflowY)) break;
      if (!clipsX(ps) && !clipsY(ps)) continue;
      const p = node.getBoundingClientRect();
      const cutX = clipsX(ps) && (r.left < p.left - 1 || r.right > p.right + 1);
      const cutY = clipsY(ps) && (r.top < p.top - 1 || r.bottom > p.bottom + 1);
      if ((cutX || cutY) && p.width > 1 && p.height > 1) {
        add("text-clipped", el, `текст обрезан родителем ${cssPath(node)}`);
      }
      break;
    }
  }

  // interactive elements: size and overlap
  const interactive = all.filter(
    (el) => el.matches(INTERACTIVE) && getComputedStyle(el).pointerEvents !== "none" && onTop(el),
  );
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if (r.width >= 24 && r.height >= 24) continue;
    // WCAG 2.5.8 exception: a link inside a sentence
    if (el.matches("a") && getComputedStyle(el).display === "inline") continue;
    add("target-size", el, `${Math.round(r.width)}×${Math.round(r.height)} < 24×24`);
  }
  const rects = interactive.map((el) => ({ el, v: visibleRect(el) }));
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!;
      const b = rects[j]!;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.v.right, b.v.right) - Math.max(a.v.left, b.v.left);
      const h = Math.min(a.v.bottom, b.v.bottom) - Math.max(a.v.top, b.v.top);
      if (w < 2 || h < 2) continue;
      add(
        "overlap",
        a.el,
        `перекрывается с ${cssPath(b.el)} «${label(b.el)}» на ${Math.round(w)}×${Math.round(h)}`,
        {
          x: Math.round(Math.max(a.v.left, b.v.left)),
          y: Math.round(Math.max(a.v.top, b.v.top)),
          w: Math.round(w),
          h: Math.round(h),
        },
      );
    }
  }

  // focus-hidden: focus each element as the keyboard would and compare the look
  if (options.checkFocus) {
    const look = (el: Element) => {
      const s = getComputedStyle(el);
      return [
        s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0
          ? `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`
          : "",
        s.boxShadow,
        s.borderColor,
        s.backgroundColor,
        s.color,
        s.textDecorationLine,
      ].join("|");
    };
    const previous = document.activeElement as HTMLElement | null;
    const focusable = interactive
      .filter((el) => !(el as HTMLButtonElement).disabled && (el as HTMLElement).tabIndex >= 0)
      .slice(0, options.focusLimit ?? 40) as HTMLElement[];
    for (const el of focusable) {
      // a ring may sit on a wrapper (focus-within): the element and four ancestors count
      const chain: Element[] = [];
      for (let node: Element | null = el; node && chain.length < 5; node = node.parentElement) {
        chain.push(node);
      }
      const looks = () => chain.map(look).join("\n");
      el.blur();
      const before = looks();
      el.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
      if (document.activeElement !== el) continue;
      const after = looks();
      el.blur();
      if (before === after) add("focus-hidden", el, "фокус с клавиатуры ничего не меняет");
    }
    previous?.focus?.({ preventScroll: true });
  }

  return out;
}
