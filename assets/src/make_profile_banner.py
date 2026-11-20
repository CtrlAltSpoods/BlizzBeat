"""Blizzbeat's Discord profile banner (5:2, shown at the top of the bot's profile card).

Writes assets/profile-banner.png (1500x600 still) and assets/profile-banner.gif (animated loop).
The bottom-left corner is left calm because Discord puts the avatar over it.

Run:  python3 assets/src/make_profile_banner.py
Needs rsvg-convert and ffmpeg.
"""
import math
import random
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from make_banner import DEFS  # noqa: E402  (same colours and gradients as the channel banner)

ASSETS = Path(__file__).resolve().parent.parent
W, H = 750, 300  # drawing units; rendered at 2x for the PNG
TAU = 2 * math.pi

random.seed(21)
SNOW = [(random.uniform(0, W), random.uniform(0, H), random.choice([0.6, 0.8, 1.0, 1.3, 1.7, 2.2]),
         random.uniform(0.3, 0.9), random.uniform(0, TAU)) for _ in range(110)]
SOFT = [(random.uniform(0, W), random.uniform(0, H), random.uniform(3, 6), random.uniform(0, TAU)) for _ in range(9)]
BARS = 18
BAR_SPEED = [random.choice((1, 2, 3)) for _ in range(BARS)]
BAR_PHASE = [random.uniform(0, TAU) for _ in range(BARS)]


def profile_svg(t=None):
    anim = t is not None
    t = t or 0.0
    o = []
    add = o.append
    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add(DEFS.replace('cx="0.2" cy="0.5" r="0.45"', 'cx="0.6" cy="0.4" r="0.55"'))
    sx = -300 + 1400 * min(1.0, t / 0.45) if anim else -1000
    add(f'<defs><linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="{sx - 80:.1f}" y1="40" x2="{sx + 80:.1f}" y2="160">'
        '<stop offset="0" stop-color="#9be3ff" stop-opacity="0"/>'
        '<stop offset="0.35" stop-color="#9be3ff" stop-opacity="0.55"/>'
        '<stop offset="0.5" stop-color="#ffffff" stop-opacity="1"/>'
        '<stop offset="0.65" stop-color="#9be3ff" stop-opacity="0.55"/>'
        '<stop offset="1" stop-color="#9be3ff" stop-opacity="0"/></linearGradient></defs>')

    add(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glow)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glow2)"/>')

    # Equalizer skyline across the right half.
    bx, bw, gap = 452, 11, 5
    for i in range(BARS):
        u = i / (BARS - 1)
        h = 40 + 95 * abs(math.sin(i * 0.8 + 0.4)) * (0.5 + 0.5 * math.sin(u * math.pi))
        if anim:
            h *= 0.7 + 0.3 * (0.5 + 0.5 * math.sin(TAU * BAR_SPEED[i] * t + BAR_PHASE[i]))
        x = bx + i * (bw + gap)
        add(f'<rect x="{x}" y="{H - h:.1f}" width="{bw}" height="{h:.1f}" rx="3" fill="url(#bar)" opacity="0.5"/>')
        add(f'<rect x="{x}" y="{H - h - 9:.1f}" width="{bw}" height="4" rx="2" fill="#e9fbff" opacity="0.65"/>')

    def ridge(points, fill):
        d = f'M0 {H} ' + ' '.join(f'L{x} {y}' for x, y in points) + f' L{W} {H} Z'
        add(f'<path d="{d}" fill="{fill}"/>')

    ridge([(0, 250), (70, 226), (140, 244), (220, 212), (300, 236), (380, 205), (470, 240), (560, 222), (650, 250), (750, 232)], 'url(#ridge1)')
    ridge([(0, 280), (110, 262), (230, 279), (360, 258), (490, 281), (620, 264), (750, 278)], 'url(#ridge2)')

    span = H + 16
    for x, y, r, op, ph in SNOW:
        if anim:
            y = (y + 8 + (1 if r < 1.2 else 2) * span * t) % span - 8
            x += 5 * math.sin(TAU * t + ph)
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#ffffff" opacity="{op:.2f}"/>')
    for x, y, r, ph in SOFT:
        if anim:
            y = (y + 8 + span * t) % span - 8
            x += 5 * math.sin(TAU * t + ph)
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#bfe9ff" opacity="0.18" filter="url(#soft)"/>')

    # Wordmark, centred in the upper part (clear of the avatar in the bottom-left).
    cx = 452
    font = ('font-family="Inter Display, Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="900" '
            'font-size="86" letter-spacing="3" text-anchor="middle"')
    add(f'<text x="{cx}" y="118" {font} fill="#4fc3ff" opacity="0.35" filter="url(#soft)">BLIZZBEAT</text>')
    if anim and t < 0.45:
        add(f'<text x="{cx}" y="118" {font} fill="url(#shine)" stroke="url(#shine)" stroke-width="6" filter="url(#soft)">BLIZZBEAT</text>')
    add(f'<text x="{cx}" y="118" {font} fill="url(#ice)">BLIZZBEAT</text>')
    if anim and t < 0.45:
        add(f'<text x="{cx}" y="118" {font} fill="url(#shine)">BLIZZBEAT</text>')

    # Waveform underline.
    pts = []
    width = 440
    for i in range(0, width + 1, 3):
        env = math.sin(math.pi * i / width)
        shift = TAU * 3 * t if anim else 0
        y = 140 + 8 * env * math.sin(i * 0.13 - shift) * math.cos(i * 0.03 + (TAU * t if anim else 0))
        pts.append(f'{cx - width / 2 + i:.1f} {y:.1f}')
    add(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#7fd6ff" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>')

    add(f'<text x="{cx}" y="172" font-family="Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="600" font-size="15" '
        'letter-spacing="5" fill="#cfefff" opacity="0.9" text-anchor="middle">YOUR SERVER\'S MUSIC BOT</text>')
    add('</svg>')
    return '\n'.join(o)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        svg = tmp / 'p.svg'
        svg.write_text(profile_svg())
        subprocess.run(['rsvg-convert', '-w', '1500', str(svg), '-o', str(ASSETS / 'profile-banner.png')], check=True)
        print('wrote profile-banner.png')

        # Animated GIF: Discord profile banners animate as GIF. 6 s loop at 15 fps, 750x300.
        fps, seconds = 15, 6
        frames = fps * seconds
        for n in range(frames):
            svg.write_text(profile_svg(n / frames))
            subprocess.run(['rsvg-convert', '-w', str(W), str(svg), '-o', str(tmp / f'f{n:04d}.png')], check=True)
        gif = ASSETS / 'profile-banner.gif'
        subprocess.run([
            'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-framerate', str(fps), '-i', str(tmp / 'f%04d.png'),
            '-filter_complex',
            '[0:v]split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a',
            '-loop', '0', str(gif),
        ], check=True)
        print(f'wrote profile-banner.gif ({gif.stat().st_size / 1048576:.2f} MB)')


if __name__ == '__main__':
    main()
