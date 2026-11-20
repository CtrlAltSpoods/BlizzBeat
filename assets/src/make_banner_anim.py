"""Renders the animated banner (assets/banner.webp): a seamless loop of the default banner with falling
snow, bouncing equalizer bars, a rippling waveform and a light sweep across the wordmark.

Run:  python3 assets/src/make_banner_anim.py [--width 1200] [--fps 15] [--seconds 6] [--quality 80]
Needs rsvg-convert and ffmpeg (with libwebp). Discord plays animated WebP attachments like GIFs.
"""
import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_banner import banner_svg  # noqa: E402

ASSETS = Path(__file__).resolve().parent.parent

ap = argparse.ArgumentParser()
ap.add_argument('--width', type=int, default=1200)
ap.add_argument('--fps', type=int, default=15)
ap.add_argument('--seconds', type=float, default=6)
ap.add_argument('--quality', type=int, default=80)
ap.add_argument('--out', default=str(ASSETS / 'banner.webp'))
args = ap.parse_args()

frames = round(args.fps * args.seconds)
with tempfile.TemporaryDirectory() as tmp:
    tmp = Path(tmp)
    for n in range(frames):
        svg = tmp / 'frame.svg'
        svg.write_text(banner_svg(n / frames))
        subprocess.run(['rsvg-convert', '-w', str(args.width), str(svg), '-o', str(tmp / f'f{n:04d}.png')], check=True)
        print(f'\rframe {n + 1}/{frames}', end='', flush=True)
    print()
    subprocess.run([
        'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
        '-framerate', str(args.fps), '-i', str(tmp / 'f%04d.png'),
        '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', str(args.quality), '-compression_level', '6',
        '-preset', 'picture', '-loop', '0', '-pix_fmt', 'yuva420p', args.out,
    ], check=True)

size = Path(args.out).stat().st_size
print(f'wrote {args.out} ({size / 1048576:.2f} MB, {frames} frames)')
