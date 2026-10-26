# PRSLOY 0.1.0-alpha.3 — что нового

## PRSLOY для Linux

Теперь есть версия для Linux. Проверена на Ubuntu 24.04 (компьютеры с обычным процессором Intel или AMD,
x86-64). Скачайте один из двух файлов.

- **Файл .deb — проще всего (Ubuntu, Debian, Linux Mint).** Скачайте `PRSLOY-…-linux-amd64.deb`, откройте
  терминал в папке с файлом и выполните:

  ```
  sudo apt install ./PRSLOY-…-linux-amd64.deb
  ```

  PRSLOY появится в меню программ. Новую версию ставьте так же, новым файлом .deb.

- **Файл AppImage — без установки, обновляется сам.** Скачайте `PRSLOY-…-linux-x86_64.AppImage`. На Ubuntu
  22.04 и новее сначала один раз выполните `sudo apt install libfuse2t64` (на 22.04 — `sudo apt install
  libfuse2`). Потом разрешите запуск и запустите:

  ```
  chmod +x PRSLOY-…-linux-x86_64.AppImage
  ./PRSLOY-…-linux-x86_64.AppImage
  ```

Node и Python программа приносит с собой. Для кнопки «Откатить» и для «Дизайна» нужен git: если его нет,
поставьте командой `sudo apt install git`. Без git агент работает, но откатить ход не получится.
