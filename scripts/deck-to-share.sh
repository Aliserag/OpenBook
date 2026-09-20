#!/usr/bin/env bash
# deck-to-share.sh — render a fully self-contained copy of docs/pitch/deck.html
# (fonts + screenshots inlined) as docs/pitch/deck.share.html, which is what a
# link-publish or an offline hand-off needs: the artifact publisher uploads the
# single HTML file and nothing it references relatively.
#
# The shots are re-encoded to JPEG at 1800px for the copy; the deck's own PNGs
# stay untouched for the PDF and the printed path.
set -euo pipefail
cd "$(dirname "$0")/.."
SRC="docs/pitch/deck.html"
OUT="docs/pitch/deck.share.html"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

# every shot the deck names, in markup or in the F-key fallback map
SHOTS=$(grep -oE 'shots/[a-z-]+\.png' "$SRC" | sort -u)
for shot in $SHOTS; do
  name=$(basename "$shot" .png)
  sips -Z 1800 -s format jpeg -s formatOptions 72 "docs/pitch/$shot" --out "$TMP/$name.jpg" >/dev/null
done

DECK_SRC="$SRC" DECK_OUT="$OUT" DECK_TMP="$TMP" python3 - <<'PY'
import base64, os, pathlib, re

src_path = pathlib.Path(os.environ["DECK_SRC"])
out_path = pathlib.Path(os.environ["DECK_OUT"])
tmp = pathlib.Path(os.environ["DECK_TMP"])
src = src_path.read_text()

def data_uri(path: pathlib.Path, mime: str) -> str:
    return f"data:{mime};base64," + base64.b64encode(path.read_bytes()).decode()

src, fonts = re.subn(
    r"url\(([\"']?)(fonts/[^)\"']+)\1\)",
    lambda m: f"url({m.group(1)}{data_uri(pathlib.Path('docs/pitch') / m.group(2), 'font/woff2')}{m.group(1)})",
    src,
)

inlined = set()

def shot(m):
    name = pathlib.Path(m.group(2)).stem
    jpg = tmp / f"{name}.jpg"
    if not jpg.exists():
        return m.group(0)
    inlined.add(name)
    return f"{m.group(1)}{data_uri(jpg, 'image/jpeg')}{m.group(1)}"

# markup (src="shots/x.png") and the JS fallback literals ('shots/x.png')
src, nshots = re.subn(r'(src=")(shots/[^"]+)"', lambda m: shot(m) + '"', src)
src, njs = re.subn(r"(['\"])(shots/[^'\"]+)\1", shot, src)

# local assets (webp/gif/png under assets/) are inlined verbatim — no re-encode
MIME = {".webp": "image/webp", ".gif": "image/gif", ".png": "image/png", ".jpg": "image/jpeg"}

def asset(m):
    q, path = m.group(1), m.group(2)
    ext = pathlib.Path(path).suffix.lower()
    mime = MIME.get(ext)
    p = pathlib.Path("docs/pitch") / path
    return f"{q}{data_uri(p, mime)}{q}" if mime and p.exists() else m.group(0)

src, nassets = re.subn(r"(['\"])(assets/[^'\"]+)\1", asset, src)

out_path.write_text(src)
leftover = re.findall(r'(?:src|href)=[\"\']?(?!https?:|#|data:)((?:shots|assets)/[^\"\']*)', src)
print(f"{out_path}: fonts {fonts} · screenshots {nshots}+{njs} ({', '.join(sorted(inlined)) or 'none'}) · assets {nassets}")
if leftover:
    print(f"still relative: {leftover}")
PY
