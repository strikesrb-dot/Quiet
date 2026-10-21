#!/usr/bin/env python3
"""Rebuild site/ from src/ (no dependencies): python3 scripts/build.py

site/light/index.html and site/neural/index.html are single self-contained pages: src/template.html with the
JavaScript modules inlined. Netlify publishes site/ as it is, so there is no build step on deploy.
The voice model (site/neural/voice-model.onnx) is committed once and left alone by this script."""
import json, os, shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC, OUT = os.path.join(ROOT, "src"), os.path.join(ROOT, "site")
# Pinned: onnxruntime-web 1.21 and later run away in WebKit on iOS / iPadOS 26.2 and kill the tab (onnxruntime#26827).
ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/"
SUB = "Your own voice, a moment late, in your headphones"
PAGES = {
    "light": dict(TITLE="Samt Light", TIER="Light", SUB=SUB, HEAD_EXTRA="", FOOT_EXTRA="", CONFIG={},
                  files=["dsp", "models", "voice-light", "pipeline", "mic", "ui"]),
    "neural": dict(TITLE="Samt Neural", TIER="Neural", SUB=SUB, HEAD_EXTRA=f'<script src="{ORT}ort.wasm.min.js"></script>',
                   FOOT_EXTRA='<p class="foot">Voice model: WeSpeaker ResNet34 trained on VoxCeleb, stored at 8 bits and run on this device with ONNX Runtime Web. The first open downloads about 17 MB.</p>',
                   CONFIG={"ortBase": ORT, "modelUrl": "voice-model.onnx"},
                   files=["dsp", "models", "voice-neural", "pipeline", "mic", "ui"]),
}

def read(*p):
    with open(os.path.join(SRC, *p), encoding="utf-8") as f:
        return f.read()

# Reminders: Qur'an verses (Tanzil Uthmani, NFC) and hadith (sunnah.com), checked before they were added.
# Never edit their Arabic by hand; it is embedded exactly as stored.
REMINDERS = json.dumps(json.loads(read("reminders.json")), ensure_ascii=False)
REMINDERS = REMINDERS.replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")

tpl = read("template.html")
for mode, p in PAGES.items():
    html = tpl
    for k in ("TITLE", "TIER", "SUB", "HEAD_EXTRA", "FOOT_EXTRA"):
        html = html.replace("{{%s}}" % k, p[k])
    html = html.replace("{{MODE_JSON}}", json.dumps(mode)).replace("{{CONFIG_JSON}}", json.dumps(p["CONFIG"]))
    html = html.replace("{{REMINDERS_JSON}}", REMINDERS)
    js = "\n".join(read(n + ".js") for n in p["files"]).replace("</script", "<\\/script")
    html = html.replace("{{SCRIPTS}}", js)
    assert "{{" not in html, f"unfilled placeholder in {mode}"
    os.makedirs(os.path.join(OUT, mode), exist_ok=True)
    with open(os.path.join(OUT, mode, "index.html"), "w", encoding="utf-8") as f:
        f.write(html)
    shutil.copy(os.path.join(SRC, "extra", f"manifest-{mode}.webmanifest"), os.path.join(OUT, mode, "manifest.webmanifest"))
    for icon in ("icon-180.png", "icon-512.png"):
        shutil.copy(os.path.join(SRC, "extra", icon), os.path.join(OUT, mode, icon))
shutil.copy(os.path.join(SRC, "chooser.html"), os.path.join(OUT, "index.html"))
# Amiri and Amiri Quran (SIL OFL 1.1, with OFL.txt), shared by both pages as ../fonts/
shutil.copytree(os.path.join(SRC, "fonts"), os.path.join(OUT, "fonts"), dirs_exist_ok=True)
assert os.path.exists(os.path.join(OUT, "neural", "voice-model.onnx")), "site/neural/voice-model.onnx is missing"
for root, _, files in os.walk(OUT):
    for name in sorted(files):
        path = os.path.join(root, name)
        print(f"{os.path.getsize(path) / 1024:9.1f} KB  {os.path.relpath(path, ROOT)}")
