"""research/28 §4.4: the judge's contact sheets show settled frames, not the middle of an animation.

Needs DESIGN_PIPELINE (a design-pipeline copy) and BRAND_PYTHON (a Python with Playwright, Chromium and Pillow); the
patch is laid on a copy of the pipeline the way run.py does it.
"""
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

HARNESS = Path(__file__).resolve().parent.parent
PIPE = os.environ.get("DESIGN_PIPELINE", "")
PY = os.environ.get("BRAND_PYTHON", "")

# a black block that fades in over 30 s: mid-animation it is almost white
PAGE = """<!doctype html><meta charset=utf-8><style>
body{margin:0;background:#fff}
#b{width:100vw;height:100vh;background:#000;animation:fade 30s linear both}
@keyframes fade{from{opacity:.05}to{opacity:1}}
</style><div id=b data-signature></div>"""


@unittest.skipUnless(PIPE and PY, "DESIGN_PIPELINE and BRAND_PYTHON")
class SettledFrames(unittest.TestCase):
    def test_contact_sheet_frame_is_the_end_state(self):
        tmp = Path(tempfile.mkdtemp())
        pipe = tmp / "pipeline"
        shutil.copytree(PIPE, pipe, ignore=shutil.ignore_patterns(".git", "__pycache__", "examples"))
        r = subprocess.run(["git", "apply", "-p1", str(HARNESS / "pipeline-fixes.patch")], cwd=pipe,
                           env={**os.environ, "GIT_CEILING_DIRECTORIES": str(tmp)}, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        (tmp / "index.html").write_text(PAGE, encoding="utf-8")
        out = tmp / "gate"
        subprocess.run([PY, "-I", str(pipe / "tools" / "visual_gate.py"), "--url", (tmp / "index.html").as_uri(),
                        "--viewports", "390", "--engine", "chromium", "--frames", "1", "--settle-ms", "300",
                        "--out", str(out)], capture_output=True, text=True, encoding="utf-8", timeout=240)
        sheet = out / "contact-chromium-390.png"
        self.assertTrue(sheet.exists(), list(out.glob("*")))
        probe = ("import sys; from PIL import Image; im = Image.open(sys.argv[1]).convert('L'); w, h = im.size; "
                 "print(sum(im.getpixel((w * i // 10, h // 2)) for i in range(2, 8)) // 6)")
        mid = int(subprocess.run([PY, "-c", probe, str(sheet)], capture_output=True, text=True).stdout.strip())
        # settled: the block is black (the frame shows the end state); a mid-fade frame would be near white
        self.assertLess(mid, 60, f"frame brightness {mid}")


if __name__ == "__main__":
    unittest.main()
