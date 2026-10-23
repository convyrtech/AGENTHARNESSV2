"""Frame-by-frame teardown input for one skillry clip: full video, full prompt, N frames with timestamps and one contact
sheet. Usage: etalon_video.py <slug> <out_dir> [frames=12]. The agent then looks at the sheet and frames and writes what
gives the wow, the way design-pipeline step 1 does for a live site."""
import os, re, sys, json, subprocess, urllib.request

slug, out = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 12
os.makedirs(out, exist_ok=True)
UA = {"User-Agent": "Mozilla/5.0"}
base = f"https://media.skillry.dev/opus-5-5/{slug}"
page = urllib.request.urlopen(urllib.request.Request(f"https://skillry.dev/ai-videos/opus-5-5/{slug}", headers=UA),
                              timeout=60).read().decode("utf-8", "ignore")
# the clip's own record comes first on its page
rec = page[page.find('slug:"' + slug + '"'):]
m = re.search(r'prompt:"((?:[^"\\]|\\.)*)"', rec)
prompt = json.loads('"' + re.sub(r"\\x([0-9A-Fa-f]{2})", r"\\u00\1", m.group(1)) + '"') if m else ""
open(os.path.join(out, "prompt.txt"), "w", encoding="utf-8").write(prompt)

video = os.path.join(out, "original.mp4")
with urllib.request.urlopen(urllib.request.Request(base + "/original.mp4", headers=UA), timeout=120) as r, open(video, "wb") as f:
    f.write(r.read())
dur = float(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video]).strip())

frames = []
for i in range(n):
    t = dur * (i + 0.5) / n
    p = os.path.join(out, f"f{i+1:02d}-{t:05.1f}s.png")
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                    "-vf", "scale=960:-2", p], check=True)
    frames.append(p)
cols = 4
rows = (n + cols - 1) // cols
sheet = os.path.join(out, "contact.png")
subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", "0", "-i", video, "-vf",
                f"fps={n}/{dur:.3f},scale=480:-2,drawtext=text='%{{pts\\:hms}}':x=8:y=8:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6,"
                f"tile={cols}x{rows}", "-frames:v", "1", sheet], check=True)
json.dump({"slug": slug, "page": f"https://skillry.dev/ai-videos/opus-5-5/{slug}", "duration": dur,
           "frames": [os.path.basename(p) for p in frames], "sheet": "contact.png", "prompt_chars": len(prompt)},
          open(os.path.join(out, "teardown-input.json"), "w"), ensure_ascii=False, indent=1)
print(f"{slug}: {dur:.1f}s, {n} frames, prompt {len(prompt)} chars -> {out}")
