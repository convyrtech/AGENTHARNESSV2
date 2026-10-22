Собрал готовую одностраничную страницу: услуги с ценами, галерея, отзывы и форма записи, которая отправляет заявку прямо в WhatsApp мастера (без сервера — можно открыть файл и пользоваться).

```html
<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Анна Соколова — маникюр, запись онлайн</title>
<style>
  *{box-sizing:border-box}
  :root{
    --bg:#fbf8f6; --card:#fff; --ink:#2b2724; --muted:#8a7f79;
    --accent:#b9797a; --accent-dk:#9d5f61; --line:#ece2dd; --r:18px;
  }
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--bg);color:var(--ink);line-height:1.55;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    -webkit-font-smoothing:antialiased}
  h1,h2,h3{font-family:Georgia,"Times New Roman