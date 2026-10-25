// Нажатия, ссылки, клавиатура и axe в проверке страницы «Кода» (research/28 §4 п. 1 и 3): функции уходят в страницу
// исходником (`fn.toString()`), как правила раскладки, — один и тот же код у Python- и Node-Playwright. Каждая
// функция самодостаточна: без импортов и замыканий. Моделей не зовём: эвристика из Interaction-as-a-Judge.

/** Цели для нажатий по порядку: формы, кнопки, якоря на этой странице. Не больше `max`. */
export function probeTargets(max: number): { kind: string; label: string; selector: string }[] {
  const sel = (el: Element): string => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
    const parts: string[] = [];
    let cur: Element | null = el;
    for (let depth = 0; cur && cur !== document.body && depth < 3; depth++) {
      const tag = cur.tagName.toLowerCase();
      const parent: Element | null = cur.parentElement;
      const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(cur) + 1})` : tag);
      if (cur.id && /^[A-Za-z][\w-]*$/.test(cur.id)) {
        parts[0] = `#${cur.id}`;
        break;
      }
      cur = parent;
    }
    return parts.join(" > ");
  };
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
  };
  const label = (el: Element) =>
    (
      (el as HTMLElement).innerText ||
      el.getAttribute("aria-label") ||
      (el as HTMLInputElement).value ||
      el.getAttribute("title") ||
      ""
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
  const out: { kind: string; label: string; selector: string }[] = [];
  for (const f of document.querySelectorAll("form")) {
    const action = f.getAttribute("action") ?? "";
    // Только своя страница: mailto:, Formspree и любой чужой адрес не отправляем.
    if (/^(?:mailto:|https?:\/\/|\/\/)/i.test(action) && !action.startsWith(location.origin))
      continue;
    if (visible(f))
      out.push({
        kind: "form",
        label: label(f.querySelector("[type=submit],button") ?? f) || "форма",
        selector: sel(f),
      });
  }
  for (const b of document.querySelectorAll(
    "button, input[type=button], [role=button], a[href='#'], a[href^='javascript:']",
  )) {
    if ((b as HTMLButtonElement).disabled || !visible(b)) continue;
    // Кнопка отправки внутри формы — это отправка формы (она уже в списке).
    if (
      b.closest("form") &&
      (b.getAttribute("type") ?? "submit") === "submit" &&
      b.tagName === "BUTTON"
    )
      continue;
    out.push({ kind: "button", label: label(b) || "кнопка", selector: sel(b) });
  }
  for (const a of document.querySelectorAll("a[href^='#']")) {
    const href = a.getAttribute("href") ?? "";
    if (href.length < 2 || !visible(a)) continue;
    out.push({ kind: "anchor", label: label(a) || href, selector: sel(a) });
  }
  return out.slice(0, max);
}

/** Нажатие на цель `i` из того же списка: форма — заполнить образцами по типу поля и отправить, иначе click(). */
export function probeAct(arg: { i: number; max: number; list: string }): string {
  const list = (0, eval)(`(${arg.list})`) as typeof probeTargets;
  const t = list(arg.max)[arg.i];
  if (!t) return "";
  const el = document.querySelector(t.selector);
  if (!el) return "";
  if (t.kind === "form") {
    const form = el as HTMLFormElement;
    for (const f of form.querySelectorAll("input, textarea, select")) {
      const input = f as HTMLInputElement;
      const type = (
        input.getAttribute("type") ?? (f.tagName === "TEXTAREA" ? "textarea" : "text")
      ).toLowerCase();
      const name = `${input.name} ${input.id} ${input.placeholder ?? ""}`.toLowerCase();
      if (input.disabled || ["hidden", "submit", "button", "reset", "file"].includes(type))
        continue;
      if (f.tagName === "SELECT") {
        const s = f as HTMLSelectElement;
        if (s.options.length > 1) s.selectedIndex = 1;
      } else if (type === "checkbox" || type === "radio") input.checked = true;
      else
        input.value =
          type === "email"
            ? "test@example.com"
            : type === "tel"
              ? "+79001234567"
              : type === "number" || type === "range"
                ? input.min || "1"
                : type === "date"
                  ? "2026-11-01"
                  : type === "time"
                    ? "12:30"
                    : type === "url"
                      ? "https://example.com"
                      : /name|имя/.test(name)
                        ? "Анна"
                        : "Тест";
      f.dispatchEvent(new Event("input", { bubbles: true }));
      f.dispatchEvent(new Event("change", { bubbles: true }));
    }
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.submit();
  } else (el as HTMLElement).click();
  return JSON.stringify(t);
}

/** Якоря в никуда и ссылки на свои файлы, которых нет (только через сервер: fetch у file:// не работает). */
export async function probeLinks(): Promise<{ selector: string; detail: string }[]> {
  const sel = (el: Element) => {
    const parent = el.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === el.tagName) : [];
    const own = same.length > 1 ? `a:nth-of-type(${same.indexOf(el) + 1})` : "a";
    return parent && parent !== document.body ? `${parent.tagName.toLowerCase()} > ${own}` : own;
  };
  const out: { selector: string; detail: string }[] = [];
  const seen = new Set<string>();
  for (const a of document.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    const text = ((a as HTMLElement).innerText || href).replace(/\s+/g, " ").trim().slice(0, 40);
    if (href.startsWith("#")) {
      const id = decodeURIComponent(href.slice(1));
      if (id && !document.getElementById(id) && !document.getElementsByName(id).length)
        out.push({
          selector: sel(a),
          detail: `ссылка «${text}» ведёт к ${href}, а такого раздела на странице нет`,
        });
      continue;
    }
    if (/^(?:[a-z]+:|\/\/)/i.test(href) || location.protocol === "file:") continue;
    const url = new URL(href, location.href);
    if (url.origin !== location.origin || seen.has(url.pathname)) continue;
    seen.add(url.pathname);
    try {
      // Метка в запросе — драйвер не считает этот 404 ошибкой страницы (LINK_PROBE в page-check.ts).
      const r = await fetch(`${url.origin}${url.pathname}?prsloy-link-check`, {
        cache: "no-store",
      });
      if (r.status >= 400)
        out.push({
          selector: sel(a),
          detail: `ссылка «${text}» ведёт на ${href} — такой страницы нет (${r.status})`,
        });
    } catch {
      // нет ответа — не судим
    }
  }
  return out.slice(0, 10);
}

/** Селектор элемента в фокусе (`body` — фокус вне страницы или на ней самой). */
export function probeFocus(): string {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return "body";
  if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `#${el.id}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let depth = 0; cur && cur !== document.body && depth < 3; depth++) {
    const parent: Element | null = cur.parentElement;
    const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
    parts.unshift(
      same.length > 1
        ? `${cur.tagName.toLowerCase()}:nth-of-type(${same.indexOf(cur) + 1})`
        : cur.tagName.toLowerCase(),
    );
    cur = parent;
  }
  return parts.join(" > ");
}

/** Главные элементы управления (кнопки и поля), до которых должна доходить клавиша Tab: метка → селектор фокуса. */
export function probeMain(): { label: string; selector: string }[] {
  const out: { label: string; selector: string }[] = [];
  for (const el of document.querySelectorAll(
    "button, input:not([type=hidden]), select, textarea, [role=button]",
  )) {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || st.visibility === "hidden" || st.display === "none")
      continue;
    if ((el as HTMLButtonElement).disabled) continue;
    // Тот же вид селектора, что у probeFocus: фокус на элементе даёт ровно эту строку.
    let s: string;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) s = `#${el.id}`;
    else {
      const parts: string[] = [];
      let cur: Element | null = el;
      for (let depth = 0; cur && cur !== document.body && depth < 3; depth++) {
        const parent: Element | null = cur.parentElement;
        const same = parent ? [...parent.children].filter((c) => c.tagName === cur!.tagName) : [];
        parts.unshift(
          same.length > 1
            ? `${cur.tagName.toLowerCase()}:nth-of-type(${same.indexOf(cur) + 1})`
            : cur.tagName.toLowerCase(),
        );
        cur = parent;
      }
      s = parts.join(" > ");
    }
    const label = (
      (el as HTMLElement).innerText ||
      el.getAttribute("aria-label") ||
      (el as HTMLInputElement).placeholder ||
      (el as HTMLInputElement).name ||
      el.tagName.toLowerCase()
    )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 40);
    out.push({ label, selector: s });
  }
  return out.slice(0, 12);
}

/** axe-core в странице: только serious и critical, WCAG A/AA, по 3 элемента на правило. */
export async function probeAxe(): Promise<
  { id: string; impact: string; help: string; nodes: string[] }[]
> {
  const axe = (
    window as unknown as {
      axe?: {
        run: (
          c: unknown,
          o: unknown,
        ) => Promise<{
          violations: {
            id: string;
            impact?: string;
            help: string;
            nodes: { target: unknown[] }[];
          }[];
        }>;
      };
    }
  ).axe;
  if (!axe) return [];
  const r = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    resultTypes: ["violations"],
  });
  return r.violations
    .filter((v) => v.impact === "serious" || v.impact === "critical")
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? "",
      help: v.help,
      nodes: v.nodes.slice(0, 3).map((n) => n.target.map(String).join(" ")),
    }));
}

export interface KeyboardFinding {
  kind: "unreachable" | "trap";
  selector: string;
  detail: string;
}

/**
 * Разбор пути фокуса по Tab (в Node, общий для обоих драйверов): главный элемент не достижим; фокус застрял
 * (последние нажатия ходят по ≤2 элементам и ни разу не выходят из страницы, хотя элементов больше).
 */
export function keyboardFindings(
  path: string[],
  main: { label: string; selector: string }[],
): KeyboardFinding[] {
  const out: KeyboardFinding[] = [];
  const reached = new Set(path);
  const tail = path.slice(-12);
  const distinct = new Set(tail);
  if (
    path.length >= 12 &&
    !distinct.has("body") &&
    distinct.size <= 2 &&
    main.some((m) => !distinct.has(m.selector))
  )
    out.push({
      kind: "trap",
      selector: [...distinct][0] ?? "",
      detail: `фокус застрял: клавиша Tab ходит только по ${[...distinct].join(", ")}`,
    });
  for (const m of main)
    if (!reached.has(m.selector))
      out.push({
        kind: "unreachable",
        selector: m.selector,
        detail: `до «${m.label}» не дойти клавишей Tab`,
      });
  return out.slice(0, 5);
}
