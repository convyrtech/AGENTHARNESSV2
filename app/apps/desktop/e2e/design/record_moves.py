"""Record the step-1 owner card for the «Дизайн» e2e: real moves.py candidates (sheet + three mp4), the event built
the way run.py builds it.

Runs run.py init and harness/moves.py candidates with the real tools on a patched design-pipeline copy, writes the
step-1 owner message (the stage note in stages.json asks for the sheet and three videos in one message) and turns it
into the `owner` event with run.py's own code (file paths it shows, options_of). Writes recorded-moves.jsonl (one
turn, workspace paths as "{WS}") and copies the sheet and videos into fixtures/design/landing/.

  python3 record_moves.py --python <venv python with pillow/numpy/playwright/imageio-ffmpeg> --pipeline <patched copy>
"""
import argparse, importlib.util, json, os, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
HARNESS = HERE.parents[4] / "playbooks" / "site" / "harness"
FIX = HERE / "fixtures" / "design" / "landing"

ap = argparse.ArgumentParser()
ap.add_argument("--python", default=sys.executable)
ap.add_argument("--pipeline", required=True)
a = ap.parse_args()

spec = importlib.util.spec_from_file_location("harness_run", HARNESS / "run.py")
R = importlib.util.module_from_spec(spec)
spec.loader.exec_module(R)

with tempfile.TemporaryDirectory(prefix="record-moves-") as tmp:
    ws = Path(tmp) / "сайт"
    env = {**os.environ, "PYTHONUTF8": "1", "HARNESS_STATE_DIR": str(Path(tmp) / "state")}
    mats = Path(tmp) / "materials"
    mats.mkdir()
    shutil.copyfile(HERE / "fixtures" / "logo.png", mats / "logo.png")
    subprocess.run([a.python, str(HARNESS / "run.py"), "init", str(ws), "--page", "landing", "--pipeline", a.pipeline,
                    "--materials", str(mats)], env=env, check=True, capture_output=True)
    page = ws / "design" / "landing"
    (page / "01-cands").mkdir(exist_ok=True)
    (page / "01-cands" / "words.json").write_text(json.dumps(
        {"num": "180 ₽", "step1": "Закажите", "step2": "Мы обжарим", "step3": "Заберите", "limitLabel": "чашек за утро",
         "limit": "1 240", "stamp": "ГОТОВО", "sloganRise": "с утра"}, ensure_ascii=False), encoding="utf-8")
    r = subprocess.run([a.python, "-I", str(ws / "harness" / "moves.py"), "candidates", "--page", "design/landing"],
                       cwd=ws, env=env, capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        sys.exit(r.stdout[-800:] + r.stderr[-800:])
    # what the step-1 session sends (stages.json «1» note: sheet + three videos, one message, a recommendation)
    final = "\n".join([
        f"{R.TO_OWNER}",
        "Три варианта движения в ваших цветах: design/landing/01-candidates.png",
        "Видео: design/landing/01-cands/A.mp4 design/landing/01-cands/B.mp4 design/landing/01-cands/C.mp4",
        "A. Кольцо и счётчик (рекомендую)",
        "B. Выдача с печатью",
        "C. Тропа к кнопке",
    ])
    text = final.split(R.TO_OWNER, 1)[1].strip()
    shown = [str((ws / x).resolve()) for x in R.re.findall(r"[\w./\\-]+\.(?:png|jpe?g|mp4|webm|html)", text)
             if (ws / x).exists()]
    event = {"ev": "owner", "text": text, "files": shown, "options": R.options_of(text)}
    assert len(shown) == 4, shown
    root = str(ws.resolve())
    rec = [{"turn": 1, "say": "сделай лендинг для кофейни «Зерно»", "files": [],
            "event": {"ev": "stage", "gate": "1", "title": "Кандидаты движения", "model": "a6p/kimi-k3.1-pro",
                      "attempt": 1}},
           {"turn": 1, "say": "сделай лендинг для кофейни «Зерно»", "files": [],
            "event": {"ev": "tool", "name": "bash",
                      "brief": "python3 -I harness/moves.py candidates --page design/landing"}},
           {"turn": 1, "say": "сделай лендинг для кофейни «Зерно»", "files": [],
            "event": json.loads(json.dumps(event, ensure_ascii=False).replace(root.replace("\\", "\\\\"), "{WS}"))}]
    (HERE / "recorded-moves.jsonl").write_text("".join(json.dumps(x, ensure_ascii=False) + "\n" for x in rec),
                                               encoding="utf-8")
    (FIX / "01-cands").mkdir(parents=True, exist_ok=True)
    from PIL import Image                                     # the sheet is flat colour: 256 colours keep it small
    Image.open(page / "01-candidates.png").convert("RGB").quantize(256).save(FIX / "01-candidates.png", optimize=True)
    for k in "ABC":
        shutil.copyfile(page / "01-cands" / f"{k}.mp4", FIX / "01-cands" / f"{k}.mp4")
    print("recorded-moves.jsonl:", ", ".join(f"{p.name} {p.stat().st_size // 1024} KB" for p in
                                             [FIX / "01-candidates.png", *sorted((FIX / "01-cands").glob("*.mp4"))]))
