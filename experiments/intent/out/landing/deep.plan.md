# План продающей страницы API-агрегатора нейросетей

## 1. Реальная цель
Пользователь хочет не просто красивый сайт, а **машину конверсии**, которая превращает разработчиков и стартапы в платящих клиентов. Решение: снять барьер входа ("один ключ вместо четырёх"), продать экономию ("дешевле на 40%") и статус ("инструмент профи"). Исход — высокий trial-to-paid и сарафан в dev-комьюнити.

## 2. Ходы топ-профессионала
- **Интерактивный калькулятор экономии** в hero-секции: пользователь двигает слайдер запросов/месяц, видит разницу в $$ в реальном времени vs официальные API
- **Live playground прямо на странице**: 4 окна с GPT/Claude/Gemini/DeepSeek отвечают параллельно на один промпт, показывая силу агрегации
- **Social proof через real-time счётчик**: "847 запросов обработано за последний час" + логотипы стартапов-клиентов

## 3. Готовые решения для реюза
- **Фреймворк**: Framer (no-code Awwwards-уровня) или Next.js + Framer Motion + GSAP ScrollTrigger
- **UI паттерны**: Stripe Gradient Mesh backgrounds, Vercel's Dashboard aesthetic, Linear.app motion language
- **Библиотеки анимаций**: Theatre.js для сложных timeline, Lottie для иконок, Spline для 3D-акцентов
- **Persuasion framework**: AIDA (Attention-Interest-Desire-Action) + Jobs-to-be-Done messaging
- **Референсы дизайна**: Resend.com, Railway.app, Clerk.dev — все SaaS для девелоперов с премиум-эстетикой

## 4. Спецификация исполнения

**Структура:**
1. Hero: headline "Все AI-модели. Один ключ. Без переплат" + калькулятор + CTA "Получить API-ключ за 30 секунд"
2. Live Demo Playground (4 колонки моделей)
3. Pricing comparison table (анимированная)
4. Features grid: единый биллинг, rate limits monitoring, fallback между моделями
5. Developer DX: код-сниппеты на 5 языках с syntax highlight
6. Social proof: отзывы + real-time метрики
7. FAQ accordion
8. Footer с документацией

**Стиль:**
- Палитра: deep space navy (#0A0E27) + electric cyan (#00F0FF) + accent coral (#FF6B6B), градиенты с grain texture
- Типографика: Cabinet Grotesk для заголовков, JetBrains Mono для кода, Inter для body
- Motion: micro-interactions на hover (magnetic buttons), parallax scroll, reveal animations с stagger, cursor trail эффект
- Tone of voice: уверенный технический, без sales-bullshit ("в 10 раз быстрее"), конкретные цифры

## 5. Критерии excellence
**Должно быть:**
- Калькулятор показывает экономию в $ за 3 секунды взаимодействия
- CTA-кнопка видна в любой момент скролла (sticky)
- Время загрузки <1.5s, 90+ Lighthouse score
- Код-примеры копируются в один клик
- Playground работает без регистрации (rate-limited demo)

**Избегать:**
- AI-клише: "революция", "unleash", "empower", "game-changer"
- Generic stock 3D-графика (делать custom Spline scenes или вообще без 3D)
- Перегруз анимациями (каждая должна нести функцию, не украшательство)
- Скрытые pricing (всё прозрачно на главной)