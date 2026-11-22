"""Renders the round, animated app icon (assets/icon.png, an APNG) used by the Unraid template.

It is the animated avatar cut to a perfect circle centred on the emblem, so the rings sit concentric with
the icon's edge, with a smooth (supersampled) transparent edge. Browsers play APNG; anything that doesn't
shows the first frame.

Run:  python3 assets/src/make_icon.py [--size 128] [--fps 15] [--seconds 6]
Needs rsvg-convert and Pillow.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_banner import avatar_svg  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument('--size', type=int, default=128)
ap.add_argument('--fps', type=int, default=15)
ap.add_argument('--seconds', type=float, default=6)
ap.add_argument('--out', default=str(ASSETS / 'icon.png'))
args = ap.parse_args()

size = args.size
# Circle mask drawn 8x larger, then scaled down: an evenly anti-aliased edge all the way round.
big = size * 8
mask = Image.new('L', (big, big), 0)
ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
mask = mask.resize((size, size), Image.LANCZOS)

frames = []
count = round(args.fps * args.seconds)
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    svg = tmp / 'f.svg'
    png = tmp / 'f.png'
    for n in range(count):
        svg.write_text(avatar_svg(n / count))  # the emblem is centred at (256, 256) of the 512 canvas
        subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), str(svg), '-o', str(png)], check=True)
        frame = Image.open(png).convert('RGBA')
        frame.putalpha(mask)
        frames.append(frame)

frames[0].save(
    args.out,
    format='PNG',
    save_all=True,
    append_images=frames[1:],
    duration=round(1000 / args.fps),
    loop=0,
    disposal=1,  # clear each frame: the transparent corners stay transparent
    blend=0,
    optimize=True,
)
print(f'wrote {args.out} ({Path(args.out).stat().st_size / 1048576:.2f} MB, {count} frames, {size}px)')
