---
name: explain-project
description: "«Разберись в проекте», «что это за код», «как это запустить»: карта файлов, тип проекта, как запустить, 5 фактов со ссылкой на файл — простыми словами, ничего не меняя."
---

# Разберись в проекте

Read only. Change nothing, install nothing unless the user asks to run it.

## Plan

1. **Map.** List the top level and one level down, skipping `node_modules`, `.git`, `.venv`, `dist`, `build`,
   `__pycache__`. Count files by type.
2. **Type.** Markers: `package.json` (Node: read `scripts`, `dependencies`), `requirements.txt` / `pyproject.toml`
   (Python), `index.html` alone (static site), `Dockerfile`, `.env.example` (settings it needs). Read the README
   if there is one, but trust the code over the README.
3. **Entry point.** Find where it starts: `scripts.start` / `main` in package.json, `if __name__ == "__main__"`,
   `app.run`, `index.html`. Follow it one or two calls deep.
4. **Facts.** Collect 5 concrete facts, each tied to a file (and line if useful): what it does, where data comes
   from and goes to (files, database, API, email), the port, the settings it needs, what is unfinished or broken.
   Never print values from `.env` or keys from the code — say «нужен ключ X», not the key.
5. **How to run.** Write the exact steps you would take (venv / `npm install`, the command). Do not run servers
   or anything that sends messages, payments or emails without asking.

## Answer

6–10 short lines in plain Russian: what the project is in one sentence, the 5 facts, how to start it, what is
missing. No jargon without a short explanation; file names stay as they are.

## Sources

- package.json fields: https://docs.npmjs.com/cli/configuring-npm/package-json
- pyproject.toml: https://packaging.python.org/en/latest/guides/writing-pyproject-toml/
