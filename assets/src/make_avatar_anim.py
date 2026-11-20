"""Renders the animated bot avatar (assets/avatar.gif): a seamless loop of the avatar with the snowflake
slowly turning, the note bobbing, the glow pulsing, a dotted orbit and falling snow.

Run:  python3 assets/src/make_avatar_anim.py [--size 384] [--fps 15] [--seconds 6]
Needs rsvg-convert and ffmpeg. Discord animates avatars as GIF.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_banner import avatar_svg  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument('--size', type=int, default=384)
ap.add_argument('--fps', type=int, default=15)
ap.add_argument('--seconds', type=float, default=6)
ap.add_argument('--out', default=str(ASSETS / 'avatar.gif'))
args = ap.parse_args()

frames = round(args.fps * args.seconds)
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    svg = tmp / 'frame.svg'
    for n in range(frames):
        svg.write_text(avatar_svg(n / frames))
        subprocess.run(['rsvg-convert', '-w', str(args.size), str(svg), '-o', str(tmp / f'f{n:04d}.png')], check=True)
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', str(args.fps), '-i', str(tmp / 'f%04d.png'),
        '-filter_complex', '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle',
        '-loop', '0', args.out,
    ], check=True)

print(f'wrote {args.out} ({Path(args.out).stat().st_size / 1048576:.2f} MB, {frames} frames)')
