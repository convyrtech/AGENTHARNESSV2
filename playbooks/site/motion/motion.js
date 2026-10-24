/* motion.js — словарь приёмов движения (playbooks/site/motion/VOCAB.md), без библиотек.
 *
 * Каждый приём: кадр = функция одного числа p от 0 до 1. Поэтому один и тот же приём
 *   - проигрывается один раз при появлении на экране (data-trigger="inview", по умолчанию),
 *   - проигрывается после загрузки (data-trigger="load"; прерывается только прокруткой),
 *   - ведётся прокруткой внутри сцены-режиссёра (data-at="0.2-0.6" внутри [data-move="director"]),
 *   - замирает в любой точке для снимков и видео: ?t=0.4 в адресе или Motion.seek(0.4).
 * При prefers-reduced-motion и в ?t=1 всё стоит в финальном состоянии. Без JS разметка уже финальная:
 * компоненты сами прячут то, что должно появиться, только после запуска.
 * Анимируем только transform, opacity, stroke-dashoffset, clip-path.
 *
 * Разметка:  <div data-move="ringHead" data-opts='{"dur":1100}' data-signature="ring">…</div>
 * Запуск:    <script src="motion.js"></script>  — сам вызывает Motion.auto() после DOMContentLoaded.
 */
(function () {
  "use strict";

  // ───────── утилиты ─────────
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, u) => a + (b - a) * u;
  const win = (p, a, b) => clamp((p - a) / ((b - a) || 1));            // доля p внутри окна [a, b]
  const smooth = (a, b, p) => { const u = win(p, a, b); return u * u * (3 - 2 * u); };
  const SVG = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}, parent) => {
    const e = document.createElementNS(SVG, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;

  function bezier(x1, y1, x2, y2) {                                     // кривая CSS cubic-bezier как функция
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t;
    const dsx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0; if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 6; i++) { const d = dsx(t); if (Math.abs(d) < 1e-6) break; t -= (sx(t) - x) / d; }
      t = clamp(t);
      return sy(t);
    };
  }
  const EASES = {
    linear: (x) => x,
    out3: (x) => 1 - Math.pow(1 - x, 3),
    out4: (x) => 1 - Math.pow(1 - x, 4),
    inOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2),
  };
  function parseEase(s) {
    if (!s) return null;
    s = String(s).trim();
    if (EASES[s]) return EASES[s];
    const m = s.match(/cubic-bezier\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/);
    return m ? bezier(+m[1], +m[2], +m[3], +m[4]) : null;
  }
  // кривая бренда: --m-ease на элементе или выше; по умолчанию (.22,1,.36,1)
  const brandEase = (el) => parseEase(getComputedStyle(el).getPropertyValue("--m-ease")) || bezier(0.22, 1, 0.36, 1);

  // ───────── режимы ─────────
  const Q = new URLSearchParams(location.search);
  const REDUCED = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);
  const CAPTURE = Q.has("t");
  const CAPTURE_T = CAPTURE ? clamp(parseFloat(Q.get("t")) || 0) : 1;

  const instances = [];       // все смонтированные приёмы
  const directors = [];       // сцены, ведомые прокруткой
  const loops = [];           // бесконечные движения (пауза вне экрана)

  // ───────── проигрыватель: p идёт 0 → 1 за dur мс ─────────
  function play(inst, dur, delay = 0) {
    if (inst.playing) return inst.playing;
    let start = null, raf = 0, done = false, resolve;
    const finished = new Promise((r) => (resolve = r));
    const step = (now) => {
      if (start === null) start = now + delay;
      const p = clamp((now - start) / dur);
      if (now >= start) inst.render(p);
      if (p < 1) raf = requestAnimationFrame(step);
      else { done = true; inst.render(1); inst.playing = null; resolve(); }
    };
    raf = requestAnimationFrame(step);
    inst.playing = {
      finished,
      finish() { if (done) return; cancelAnimationFrame(raf); done = true; inst.render(1); inst.playing = null; resolve(); },
    };
    return inst.playing;
  }

  // ───────── регистр приёмов ─────────
  const MOVES = {};
  function define(name, factory) { MOVES[name] = factory; }

  function mount(el, name, opts = {}) {
    const factory = MOVES[name];
    if (!factory) { console.warn("motion.js: нет приёма", name); return null; }
    const ease = parseEase(opts.ease) || brandEase(el);
    const inst = factory(el, opts, ease);
    inst.el = el; inst.name = name;
    inst.dur = opts.dur || inst.dur || 900;
    el.classList.add("m-move", "m-" + name);
    instances.push(inst);
    return inst;
  }

  // ═════════ 1. Кольцо с головкой ═════════
  // Тонкое кольцо дорисовывается вокруг содержимого, линию ведёт точка акцентного цвета.
  define("ringHead", (el, o, ease) => {
    const pad = o.pad ?? 10;                 // отступ кольца от содержимого, px
    const start = (o.start ?? -90) * Math.PI / 180, dir = o.dir === -1 ? -1 : 1;
    // Круг вокруг почти квадратного содержимого; вокруг широкого (число, слово) — эллипс, как обвели ручкой.
    // Геометрия в px (viewBox = размер кольца), поэтому линия и точка одной толщины при любом размере.
    const svg = svgEl("svg", { class: "m-ring-svg", "aria-hidden": "true" });
    const ring = svgEl("path", { pathLength: 1, class: "m-ring-line" }, svg);
    const head = o.head === false ? null : svgEl("circle", { class: "m-ring-head" }, svg);
    el.appendChild(svg);
    let G = { cx: 50, cy: 50, rx: 48, ry: 48 };
    const layout = () => {
      const box = el.getBoundingClientRect();
      let w = box.width + 2 * pad, h = box.height + 2 * pad;
      const shape = o.shape || "auto";
      if (shape === "circle" || (shape === "auto" && w / h < 1.35 && h / w < 1.35)) w = h = Math.max(w, h);
      else { w *= 1.08; h *= 1.18; }             // эллипс с запасом, чтобы не резать углы текста
      const sw = parseFloat(getComputedStyle(el).getPropertyValue("--m-stroke")) || 1.5;
      const hr = o.headR ?? 3.5;
      const m = Math.max(sw, hr) + 1;
      Object.assign(svg.style, { width: w + "px", height: h + "px", left: (box.width - w) / 2 + "px", top: (box.height - h) / 2 + "px" });
      svg.setAttribute("viewBox", `0 0 ${r3(w)} ${r3(h)}`);
      G = { cx: w / 2, cy: h / 2, rx: w / 2 - m, ry: h / 2 - m };
      // эллипс двумя дугами, начиная с точки на угле start; dir задаёт направление обхода
      const x0 = G.cx + G.rx * Math.cos(start), y0 = G.cy + G.ry * Math.sin(start);
      const x1 = 2 * G.cx - x0, y1 = 2 * G.cy - y0, sweep = dir > 0 ? 1 : 0;
      const A = `A ${r3(G.rx)} ${r3(G.ry)} 0 0 ${sweep}`;
      ring.setAttribute("d", `M ${r3(x0)} ${r3(y0)} ${A} ${r3(x1)} ${r3(y1)} ${A} ${r3(x0)} ${r3(y0)}`);
      ring.setAttribute("stroke-width", sw);
      G.L = ring.getTotalLength();
      if (head) head.setAttribute("r", hr);
      if (last != null) inst.render(last);
    };
    let last = null;
    const inst = {
      dur: 1100,
      render(p) {
        last = p;
        const e = ease(p);
        ring.style.strokeDashoffset = r3(1 - e);
        if (head && G.L) {                       // точка ровно на конце нарисованной дуги
          const pt = ring.getPointAtLength(e * G.L);
          head.setAttribute("cx", r3(pt.x)); head.setAttribute("cy", r3(pt.y));
          head.style.opacity = p <= 0 ? 0 : 1;
        }
      },
    };
    layout();
    if (window.ResizeObserver) new ResizeObserver(layout).observe(el);
    return inst;
  });

  // ═════════ 6. Рельс шагов ═════════
  // <ol data-move="stepsRail"><li>…</li>…</ol>: шаг заливается, галочка дорисовывается, связка тянется к следующему.
  define("stepsRail", (el, o, ease) => {
    const items = Array.from(el.children);
    const n = items.length;
    const parts = items.map((li, i) => {
      li.classList.add("m-step");
      const node = document.createElement("span");
      node.className = "m-step-node"; node.setAttribute("aria-hidden", "true");
      const s = svgEl("svg", { viewBox: "0 0 24 24" }, null);
      const ring = svgEl("circle", { cx: 12, cy: 12, r: 10.5, class: "m-step-ring", pathLength: 1 }, s);
      const fill = svgEl("circle", { cx: 12, cy: 12, r: 10.5, class: "m-step-fill" }, s);
      const tick = svgEl("path", { d: "M7.2 12.4 L10.6 15.6 L16.8 8.8", class: "m-step-tick", pathLength: 1 }, s);
      node.appendChild(s);
      li.insertBefore(node, li.firstChild);
      let link = null;
      if (i < n - 1) { link = document.createElement("span"); link.className = "m-step-link"; link.setAttribute("aria-hidden", "true"); li.appendChild(link); }
      return { li, ring, fill, tick, link };
    });
    return {
      dur: o.dur || 600 * n,
      render(p) {
        parts.forEach((q, i) => {
          const a = i / n, b = (i + 1) / n;
          const u = win(p, a, b);               // доля этого шага
          const fillU = win(u, 0, 0.18), tickU = ease(win(u, 0.12, 0.5)), linkU = ease(win(u, 0.45, 1));
          q.ring.style.strokeDashoffset = r3(1 - ease(win(u, 0, 0.3)));
          q.fill.style.opacity = r3(fillU);
          q.fill.style.transform = `scale(${r3(lerp(0.6, 1, fillU))})`;
          q.tick.style.strokeDashoffset = r3(1 - tickU);
          q.li.classList.toggle("is-done", u >= 0.12);
          if (q.link) q.link.style.transform = `scale(${r3(linkU)})`;
        });
      },
    };
  });

  // ═════════ 13. Число с торможением (одометр) ═════════
  // Итоговое число уже стоит в тексте элемента. Колонки цифр «доезжают» к нему от близкого значения и тормозят.
  define("odometer", (el, o, ease) => {
    const text = el.textContent.trim();
    el.setAttribute("aria-label", text);
    const m = text.match(/-?[\d\s ]*[.,]?\d+/);
    if (!m) return { dur: 0, render() {} };
    const raw = m[0];
    const sep = raw.includes(",") ? "," : raw.includes(".") ? "." : "";
    const dec = sep ? raw.split(sep)[1].length : 0;
    const to = Math.round(parseFloat(raw.replace(/[\s ]/g, "").replace(",", ".")) * Math.pow(10, dec));
    const from = o.from != null ? Math.round(o.from * Math.pow(10, dec)) : Math.round(to * (o.fromShare ?? 0.86));
    const curve = o.ease ? ease : EASES.out4;   // сильное торможение по умолчанию
    // разметка: каждая цифра — окно с колонкой 0…9,0; остальные знаки как есть
    const pre = text.slice(0, m.index), post = text.slice(m.index + raw.length);
    el.textContent = "";
    el.classList.add("m-odo");
    const vis = document.createElement("span"); vis.className = "m-odo-vis"; vis.setAttribute("aria-hidden", "true");
    const cols = [];
    const add = (t) => { const s = document.createElement("span"); s.className = "m-odo-sym"; s.textContent = t; vis.appendChild(s); };
    if (pre) add(pre);
    const digits = raw.replace(/[^\d]/g, "").length;
    let placeFromRight = digits - 1;
    for (const ch of raw) {
      if (/\d/.test(ch)) {
        const w = document.createElement("span"); w.className = "m-odo-win";
        const c = document.createElement("span"); c.className = "m-odo-col";
        c.innerHTML = Array.from({ length: 11 }, (_, k) => `<span>${k % 10}</span>`).join("");
        w.appendChild(c); vis.appendChild(w);
        cols.push({ c, place: placeFromRight-- });
      } else add(ch);
    }
    if (post) add(post);
    el.appendChild(vis);
    const pos = (v, k) => {                    // положение колонки разряда k для значения v (непрерывный перенос)
      const p10 = Math.pow(10, k);
      const lower = v % p10, digit = Math.floor(v / p10) % 10;
      const carry = k === 0 ? v - Math.floor(v) : Math.max(0, lower - (p10 - 1));
      return digit + carry;                    // 0…10: десятая позиция колонки — снова «0»
    };
    return {
      dur: 900,
      render(p) {
        const v = lerp(from, to, curve(p));
        for (const { c, place } of cols) {
          const y = p >= 1 ? Math.floor(to / Math.pow(10, place)) % 10 : pos(v, place);
          c.style.transform = `translateY(${r3(-y / 11 * 100)}%)`;
        }
      },
    };
  });

  // ═════════ 14. Печать-штамп ═════════
  define("stamp", (el, o) => {
    const rot = o.rotate ?? -3;
    const outQ = EASES.out3;
    return {
      dur: 320,
      render(p) {
        // удар за первые 25% (≈80 мс): масштаб 1.25 → 0.97, потом доводка к 1 и к углу rot
        const hit = win(p, 0, 0.25), settle = outQ(win(p, 0.25, 1));
        const s = p < 0.25 ? lerp(1.25, 0.97, hit * hit) : lerp(0.97, 1, settle);
        const a = p < 0.25 ? lerp(rot - 2, rot - 1, hit) : lerp(rot - 1, rot, settle);
        el.style.opacity = r3(clamp(hit * 2));
        el.style.transform = `rotate(${r3(a)}deg) scale(${r3(s)})`;
      },
    };
  });

  // ═════════ 12. Выезд из-под кромки ═════════
  // <div data-move="slotLift"><div data-lift>карточка</div></div> — кромка неподвижна, карточка выезжает и тормозит.
  define("slotLift", (el, o, ease) => {
    const card = el.querySelector("[data-lift]") || el.firstElementChild;
    const from = o.from ?? 100;               // % своей высоты вниз
    return {
      dur: 900,
      render(p) {
        const e = ease(p);
        card.style.transform = `translateY(${r3((1 - e) * from)}%) scale(${r3(lerp(o.scale ?? 0.97, 1, e))})`;
      },
    };
  });

  // ═════════ 5. Тропа с точкой ═════════
  // Внутри элемента — <svg><path data-trail d="…"/></svg> и узлы [data-node] с data-at="0.3" (доля пути).
  define("trailDot", (el, o, ease) => {
    const path = el.querySelector("path[data-trail]");
    if (!path) return { dur: 0, render() {} };
    path.setAttribute("pathLength", 1);
    path.classList.add("m-trail-line");
    const svg = path.ownerSVGElement;
    const dot = svgEl("circle", { r: o.dotR ?? 4, class: "m-trail-dot" }, svg);
    const arrow = o.arrow === false ? null : svgEl("path", { class: "m-trail-arrow", d: "M-7 -5 L0 0 L-7 5" }, svg);
    const L = path.getTotalLength();
    const nodes = Array.from(el.querySelectorAll("[data-node]")).map((n, i, all) => ({ n, at: parseFloat(n.dataset.at ?? (i + 1) / (all.length + 1)) }));
    for (const { n, at } of nodes) {          // узел внутри SVG ставим на его долю пути, если место не задано руками
      if (n instanceof SVGGraphicsElement && !n.hasAttribute("transform")) {
        const pt = path.getPointAtLength(at * L);
        n.setAttribute("transform", `translate(${r3(pt.x)} ${r3(pt.y)})`);
      }
    }
    const curve = o.linear ? EASES.linear : ease;
    return {
      dur: o.dur || 2400,
      render(p) {
        const e = curve(p);
        path.style.strokeDashoffset = r3(1 - e);
        const pt = path.getPointAtLength(e * L);
        dot.setAttribute("cx", r3(pt.x)); dot.setAttribute("cy", r3(pt.y));
        dot.style.opacity = p <= 0 || p >= 1 ? 0 : 1;
        for (const { n, at } of nodes) n.classList.toggle("is-lit", e >= at - 0.002);
        if (arrow) {
          const a = path.getPointAtLength(Math.max(0, L - 2)), b = path.getPointAtLength(L);
          const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
          arrow.setAttribute("transform", `translate(${r3(b.x)} ${r3(b.y)}) rotate(${r3(ang)})`);
          arrow.style.opacity = r3(win(e, 0.96, 1));
        }
      },
    };
  });

  // ═════════ 2. Предмет-шторка ═════════
  // Слой [data-shutter-to] (следующая глава, свой фон) раскрывается кругом из точки x,y (в % элемента).
  define("shutter", (el, o, ease) => {
    const layer = el.querySelector("[data-shutter-to]") || el;
    const x = o.x ?? 50, y = o.y ?? 50;
    return {
      dur: 400,
      render(p) {
        const e = ease(p);
        const r = e * 150;                      // 150% хватает до любого угла
        layer.style.clipPath = p >= 1 ? "none" : `circle(${r3(r)}% at ${x}% ${y}%)`;
        layer.style.visibility = p <= 0 ? "hidden" : "visible";
      },
    };
  });

  // ═════════ 8. Одна фигура — все состояния ═════════
  // Кнопка: подложка-пилюля сжимается в круг, внутри дорисовывается галочка, подпись уходит и возвращается.
  // Размер кнопки в вёрстке не меняется (анимируем transform подложки). Motion.get(el).run() по клику.
  define("morph", (el, o, ease) => {
    el.classList.add("m-morph");
    const label = document.createElement("span"); label.className = "m-morph-label";
    while (el.firstChild) label.appendChild(el.firstChild);
    const pill = document.createElement("span"); pill.className = "m-morph-pill"; pill.setAttribute("aria-hidden", "true");
    const s = svgEl("svg", { class: "m-morph-tick", viewBox: "0 0 24 24", "aria-hidden": "true" });
    const tick = svgEl("path", { d: "M6.5 12.5 L10.2 16 L17.5 8.5", pathLength: 1 }, s);
    el.append(pill, label, s);
    const inst = {
      dur: 700,
      render(p) {                              // p: 0 — кнопка, 1 — круг с галочкой
        // пилюля сужается обрезкой с круглыми краями: в конце ровный круг диаметром в высоту кнопки
        const r = el.getBoundingClientRect();
        const side = Math.max(0, (r.width - r.height) / 2);
        const shape = ease(win(p, 0, 0.55));
        pill.style.clipPath = p <= 0 ? "none" : `inset(0px ${r3(side * shape)}px round 999px)`;
        label.style.opacity = r3(1 - win(p, 0, 0.3));
        tick.style.strokeDashoffset = r3(1 - ease(win(p, 0.5, 1)));
        s.style.opacity = r3(win(p, 0.45, 0.6));
      },
      async run(hold = o.hold ?? 1400) {      // туда, пауза, обратно
        if (REDUCED || CAPTURE) return;
        if (inst.busy) return;
        inst.busy = true;
        await play(inst, inst.dur).finished;
        await new Promise((r) => setTimeout(r, hold));
        const back = { render: (q) => inst.render(1 - q) };
        await play(back, inst.dur * 0.7).finished;
        inst.busy = false;
      },
    };
    if (o.on !== "manual") el.addEventListener("click", () => inst.run());
    return inst;
  });

  // ═════════ 10. Каскад точек ═════════
  // Точки [data-dot] появляются по одной; у [data-dot].is-pick — расходящееся кольцо и подпись [data-dot-label].
  define("dotCascade", (el, o, ease) => {
    const dots = Array.from(el.querySelectorAll("[data-dot]"));
    const pick = el.querySelector("[data-dot].is-pick") || dots[o.pick ?? 0];
    const label = el.querySelector("[data-dot-label]");
    let pulse = null;
    if (pick) {
      pulse = document.createElement("span"); pulse.className = "m-dot-pulse"; pulse.setAttribute("aria-hidden", "true");
      pick.appendChild(pulse);
    }
    const n = dots.length || 1;
    const stepShare = Math.min(0.08, 0.7 / n);  // доля одной точки на шкале p
    const inst = {
      dur: o.dur || Math.max(700, n * 30 + 600),
      render(p) {
        dots.forEach((d, i) => {
          const u = ease(win(p, i * stepShare, i * stepShare + 0.3));
          d.style.opacity = r3(u);
          d.style.transform = `scale(${r3(lerp(0.6, 1, u))})`;
        });
        if (label) { const u = ease(win(p, 0.75, 1)); label.style.opacity = r3(u); label.style.transform = `translateY(${r3((1 - u) * 6)}px)`; }
      },
    };
    if (pulse && !REDUCED && !CAPTURE) loops.push({ el, start() {
      if (this.a) { this.a.play(); return; }
      this.a = pulse.animate([{ transform: "scale(1)", opacity: 0.55 }, { transform: "scale(2.2)", opacity: 0 }], { duration: 1600, iterations: Infinity, easing: "cubic-bezier(.22,1,.36,1)" });
    }, stop() { if (this.a) this.a.pause(); } });
    return inst;
  });

  // ═════════ 15. Линия-строка ═════════
  // Пучок линий сводится в базовую линию, одно слово [data-rise] поднимается из-под неё, точка садится в конец.
  // Остальной текст виден сразу; поднимается только одно слово.
  define("lineWord", (el, o, ease) => {
    const word = el.querySelector("[data-rise]");
    const wrap = document.createElement("span"); wrap.className = "m-rise-win";
    if (word) { word.parentNode.insertBefore(wrap, word); wrap.appendChild(word); word.classList.add("m-rise"); }
    const svg = svgEl("svg", { class: "m-lw-svg", viewBox: "0 0 100 20", preserveAspectRatio: "none", "aria-hidden": "true" });
    const k = o.lines ?? 5;
    const lines = Array.from({ length: k }, (_, i) => svgEl("line", { x1: 0, x2: 100, y1: 19, y2: 19, class: "m-lw-line", "vector-effect": "non-scaling-stroke" }, svg));
    el.appendChild(svg);
    const dot = document.createElement("span"); dot.className = "m-lw-dot"; dot.setAttribute("aria-hidden", "true");
    el.appendChild(dot);
    return {
      dur: 900,
      render(p) {
        const conv = ease(win(p, 0, 0.35));
        lines.forEach((ln, i) => {
          const off = (k - 1 - i) * 3.4;       // пучок ниже базовой линии; сводится вверх в одну линию и не задевает слово
          ln.style.transform = `translateY(${r3(off * (1 - conv))}px)`;
          ln.style.opacity = r3(i === k - 1 ? 1 : (1 - conv) * 0.8);
        });
        if (word) word.style.transform = `translateY(${r3((1 - ease(win(p, 0.35, 0.72))) * 105)}%)`;
        const d = ease(win(p, 0.6, 1));
        dot.style.opacity = r3(win(p, 0.6, 0.65));
        dot.style.transform = `translate(${r3(lerp(-30, 0, d))}px, ${r3(-Math.sin(d * Math.PI) * 18)}px)`;
      },
    };
  });

  // ═════════ 4. Режиссёр-t ═════════
  // <section data-move="director" data-opts='{"screens":2.5}'> — сцена закреплена на экране, p = прогресс
  // прокрутки по секции. Дети с data-at="a-b" ведутся окном p; [data-step-at="a"] получают --in 0…1 для CSS.
  define("director", (el, o) => {
    el.classList.add("m-director");
    const screens = o.screens ?? 2;
    el.style.setProperty("--m-screens", screens);
    const kids = [];
    const steps = Array.from(el.querySelectorAll("[data-step-at]")).map((s) => ({ s, at: parseFloat(s.dataset.stepAt) }));
    const inst = {
      dur: 0,
      kids,
      render(p) {
        el.style.setProperty("--p", r3(p));
        for (const k of kids) k.inst.render(win(p, k.a, k.b));
        for (const { s, at } of steps) s.style.setProperty("--in", r3(smooth(at - 0.24, at - 0.02, p)));
      },
      progress() {
        const r = el.getBoundingClientRect();
        const span = r.height - innerHeight;
        return span > 0 ? clamp(-r.top / span) : r.top < 0 ? 1 : 0;
      },
    };
    directors.push(inst);
    return inst;
  });

  // ───────── авто-монтаж по разметке ─────────
  function readOpts(el) { try { return JSON.parse(el.dataset.opts || "{}"); } catch (e) { return {}; } }

  function auto(root = document) {
    const els = Array.from(root.querySelectorAll("[data-move]"));
    // сначала режиссёры, потом остальные (чтобы дети знали своего режиссёра)
    els.sort((a, b) => (a.dataset.move === "director" ? -1 : 0) - (b.dataset.move === "director" ? -1 : 0));
    const made = [];
    for (const el of els) {
      if (el.__motion) continue;
      const inst = mount(el, el.dataset.move, readOpts(el));
      if (!inst) continue;
      el.__motion = inst;
      made.push(inst);
      const dir = el.dataset.move !== "director" && el.closest("[data-move='director']");
      if (dir && el.dataset.at) {
        const [a, b] = el.dataset.at.split("-").map(parseFloat);
        dir.__motion.kids.push({ inst, a, b: b ?? 1 });
        inst.driven = true;
      }
    }
    start(made);
    return made;
  }

  // ───────── запуск: финал, ?t=, интро, прокрутка ─────────
  let scrollBound = false;
  function start(list) {
    if (REDUCED || CAPTURE) {
      const t = REDUCED ? 1 : CAPTURE_T;
      for (const i of list) if (!i.driven) i.render(i.name === "morph" ? 0 : t);   // детей ведёт режиссёр
      return;
    }
    const loadIntros = [];
    for (const inst of list) {
      if (inst.name === "director") { inst.render(inst.progress()); continue; }
      if (inst.driven) continue;
      const trig = inst.el.dataset.trigger || "inview";
      if (trig === "manual" || inst.name === "morph") { inst.render(0); continue; }
      inst.render(0);
      if (trig === "load") loadIntros.push(inst);
      else onceInView(inst.el, () => play(inst, inst.dur, parseFloat(inst.el.dataset.delay || 0)));
    }
    if (loadIntros.length) runLoad(loadIntros);
    if (directors.length && !scrollBound) {
      scrollBound = true;
      let ticking = false;
      const tick = () => {
        ticking = false;
        for (const d of directors) {
          const r = d.el.getBoundingClientRect();
          const near = r.bottom > -innerHeight && r.top < innerHeight * 2;
          const p = d.progress();
          if (near || d.lastP !== p) { if (d.lastP !== p) d.render(p); d.lastP = p; }
        }
      };
      addEventListener("scroll", () => { if (!ticking) { ticking = true; requestAnimationFrame(tick); } }, { passive: true });
      addEventListener("resize", () => requestAnimationFrame(tick));
    }
    for (const l of loops) watchLoop(l);
  }

  function onceInView(el, fn) {
    if (!("IntersectionObserver" in window)) { fn(); return; }
    const io = new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { io.disconnect(); fn(); }
    }, { threshold: 0.25 });
    io.observe(el);
  }

  async function runLoad(list) {
    // интро после декодирования картинок и только при видимой вкладке; прерывает только прокрутка
    const imgs = Array.from(document.images).filter((i) => !i.complete);
    await Promise.all(imgs.map((i) => (i.decode ? i.decode().catch(() => {}) : null)));
    if (document.visibilityState !== "visible") await new Promise((r) => {
      const f = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", f); r(); } };
      document.addEventListener("visibilitychange", f);
    });
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const runs = list.map((i) => play(i, i.dur, parseFloat(i.el.dataset.delay || 0)));
    const stop = () => { if (scrollY > 2) { removeEventListener("scroll", stop); runs.forEach((r) => r.finish()); } };
    addEventListener("scroll", stop, { passive: true });
  }

  function watchLoop(l) {
    if (!("IntersectionObserver" in window)) { l.start(); return; }
    let vis = false;
    const upd = () => (vis && !document.hidden ? l.start() : l.stop());
    new IntersectionObserver((es) => { vis = es[0].isIntersecting; upd(); }).observe(l.el);
    document.addEventListener("visibilitychange", upd);
  }

  // снимки и видео: Motion.seek(t) ставит все приёмы в точку t; кнопки-морфы тоже, если не {interactive:false}
  function seek(t, opts = {}) {
    t = clamp(t);
    for (const i of instances) {
      if (i.playing) i.playing.finish();
      if (i.driven) continue;
      i.render(i.name === "morph" && opts.interactive === false ? 0 : t);
    }
  }

  const api = { auto, mount, define, seek, play, win, smooth, bezier, parseEase,
    get: (el) => el.__motion, list: () => instances.slice(), REDUCED, CAPTURE, CAPTURE_T };
  window.Motion = api;
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => auto());
  else auto();
})();
