---
name: canvas-game
description: "Игра в браузере на canvas: змейка, арканоид, тетрис, кликер. Один HTML, игровой цикл на requestAnimationFrame, управление клавишами и пальцем, счёт, рестарт."
---

# Игра на canvas

Start from `game.html` next to this file: a working loop with keyboard and touch input, score and restart. Change
the rules, keep the skeleton.

## Rules of the skeleton

- One `index.html` with inline `<script>` (or `./game.js` via plain `<script src>`), no build tool, no
  `type="module"`: it must open by double click.
- Game loop on `requestAnimationFrame`; move by elapsed time (`dt`) or a fixed step, never by frame count — frame
  rate differs between screens.
- State in one object; `update(dt)` changes it, `draw()` only paints it. Restart = recreate the state.
- Canvas sized to the window (`resize` handler) and sharp on HiDPI: canvas pixels × `devicePixelRatio`,
  `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`.
- Input: arrow keys / WASD **and** Pointer Events (tap, swipe) so it works on a phone. `preventDefault` on the
  arrow keys so the page does not scroll.
- Pause when the tab is hidden (`visibilitychange`). Best score in `localStorage`.
- All texts in Russian: «Счёт», «Рекорд», «Игра окончена — нажмите пробел или коснитесь экрана».

## Check

The app opens the page in a real browser at the end of your turn and tells you about errors; do not install
jsdom, puppeteer or browsers yourself. Read your loop once more for the rules you cannot see in a screenshot: the
game starts, reacts to keys and taps, the score grows, game over and restart work, at 390 px it fits without
scrolling.

## Sources

- Canvas tutorial: https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial
- requestAnimationFrame: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame
- 2D breakout game step by step: https://developer.mozilla.org/en-US/docs/Games/Tutorials/2D_breakout_game_pure_JavaScript
- Pointer events: https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events
