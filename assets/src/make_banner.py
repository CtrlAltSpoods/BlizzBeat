"""Generates assets/banner.svg (rendered to banner.png with rsvg-convert).

Run:  python3 assets/src/make_banner.py && rsvg-convert -w 1600 assets/banner.svg -o assets/banner.png && rsvg-convert -w 512 assets/avatar.svg -o assets/avatar.png
"""
import math
import random
from pathlib import Path

W, H = 1600, 400
random.seed(7)
out = []
add = out.append

add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
add('''<defs>
  <linearGradient id="sky" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#050b1c"/>
    <stop offset="0.55" stop-color="#0a1f3f"/>
    <stop offset="1" stop-color="#0f3561"/>
  </linearGradient>
  <radialGradient id="glow" cx="0.2" cy="0.5" r="0.45">
    <stop offset="0" stop-color="#4fc3ff" stop-opacity="0.38"/>
    <stop offset="0.6" stop-color="#2b7fd6" stop-opacity="0.08"/>
    <stop offset="1" stop-color="#2b7fd6" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glow2" cx="0.88" cy="1" r="0.5">
    <stop offset="0" stop-color="#7b5cff" stop-opacity="0.25"/>
    <stop offset="1" stop-color="#7b5cff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="ice" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/>
    <stop offset="0.55" stop-color="#d9f4ff"/>
    <stop offset="1" stop-color="#7fd6ff"/>
  </linearGradient>
  <linearGradient id="bar" x1="0" y1="1" x2="0" y2="0">
    <stop offset="0" stop-color="#2a6fd8" stop-opacity="0.15"/>
    <stop offset="0.7" stop-color="#4fc3ff" stop-opacity="0.75"/>
    <stop offset="1" stop-color="#e9fbff" stop-opacity="0.95"/>
  </linearGradient>
  <linearGradient id="ridge1" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#16345d"/>
    <stop offset="1" stop-color="#0a1a33"/>
  </linearGradient>
  <linearGradient id="ridge2" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0d2445"/>
    <stop offset="1" stop-color="#06101f"/>
  </linearGradient>
  <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="6"/>
  </filter>
  <filter id="flakeGlow" x="-50%" y="-50%" width="200%" height="200%">
    <feGaussianBlur stdDeviation="10" result="b"/>
    <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>''')

add(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
add(f'<rect width="{W}" height="{H}" fill="url(#glow)"/>')
add(f'<rect width="{W}" height="{H}" fill="url(#glow2)"/>')

# Equalizer bars rising on the right, like a frozen skyline.
bx, bw, gap = 1262, 17, 8
for i in range(13):
    t = i / 12
    h = 70 + 170 * abs(math.sin(i * 0.9 + 0.6)) * (0.55 + 0.45 * math.sin(t * math.pi))
    x = bx + i * (bw + gap)
    add(f'<rect x="{x}" y="{H - h:.1f}" width="{bw}" height="{h:.1f}" rx="4" fill="url(#bar)" opacity="0.55"/>')
    add(f'<rect x="{x}" y="{H - h - 14:.1f}" width="{bw}" height="6" rx="3" fill="#e9fbff" opacity="0.7"/>')


def ridge(points, fill):
    d = f'M0 {H} ' + ' '.join(f'L{x} {y}' for x, y in points) + f' L{W} {H} Z'
    add(f'<path d="{d}" fill="{fill}"/>')


ridge([(0, 330), (120, 290), (210, 318), (330, 262), (430, 300), (560, 250), (690, 305), (820, 275),
       (960, 320), (1090, 285), (1230, 330), (1380, 296), (1500, 322), (1600, 300)], 'url(#ridge1)')
ridge([(0, 372), (150, 345), (300, 368), (470, 336), (640, 370), (800, 348), (980, 376), (1150, 350),
       (1320, 372), (1470, 352), (1600, 366)], 'url(#ridge2)')

# Falling snow.
for _ in range(170):
    x = random.uniform(0, W)
    y = random.uniform(0, H)
    r = random.choice([0.8, 1.1, 1.4, 1.8, 2.4, 3.2])
    o = random.uniform(0.25, 0.85) * (0.6 if r < 1.5 else 1)
    add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#ffffff" opacity="{o:.2f}"/>')
# A few soft, out-of-focus flakes.
for _ in range(14):
    x = random.uniform(0, W)
    y = random.uniform(0, H)
    add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{random.uniform(5, 9):.1f}" fill="#bfe9ff" opacity="0.18" filter="url(#soft)"/>')


def snowflake(cx, cy, R, stroke):
    parts = []
    for k in range(6):
        a = math.radians(k * 60 - 90)
        ex, ey = cx + R * math.cos(a), cy + R * math.sin(a)
        parts.append(f'M{cx:.1f} {cy:.1f} L{ex:.1f} {ey:.1f}')
        for frac, blen in ((0.42, 0.30), (0.68, 0.22)):
            px, py = cx + R * frac * math.cos(a), cy + R * frac * math.sin(a)
            for s in (-1, 1):
                b = a + s * math.radians(45)
                parts.append(f'M{px:.1f} {py:.1f} L{px + R * blen * math.cos(b):.1f} {py + R * blen * math.sin(b):.1f}')
        # small diamond at the tip
        tx, ty = cx + R * 1.06 * math.cos(a), cy + R * 1.06 * math.sin(a)
        parts.append(f'M{tx:.1f} {ty - 0.1:.1f}')
    d = ' '.join(parts)
    return (f'<path d="{d}" fill="none" stroke="{stroke}" stroke-width="13" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="{cx}" cy="{cy}" r="27" fill="{stroke}"/>')


# Emblem: ring + snowflake + a play triangle in the centre.
cx, cy = 205, 190
add(f'<circle cx="{cx}" cy="{cy}" r="118" fill="#0b2446" opacity="0.65"/>')
add(f'<circle cx="{cx}" cy="{cy}" r="118" fill="none" stroke="#7fd6ff" stroke-width="4" opacity="0.55"/>')
add(f'<circle cx="{cx}" cy="{cy}" r="132" fill="none" stroke="#7fd6ff" stroke-width="1.5" opacity="0.25" stroke-dasharray="3 9"/>')
add(f'<g filter="url(#flakeGlow)">{snowflake(cx, cy, 92, "url(#ice)")}</g>')
add(f'<path d="M{cx - 8} {cy - 14} L{cx + 15} {cy} L{cx - 8} {cy + 14} Z" fill="#0b2446"/>')

# Wordmark.
tx = 380
add(f'<text x="{tx}" y="212" font-family="Inter Display, Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="900" '
    f'font-size="148" letter-spacing="4" fill="#4fc3ff" opacity="0.35" filter="url(#soft)">BLIZZBEAT</text>')
add(f'<text x="{tx}" y="212" font-family="Inter Display, Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="900" '
    f'font-size="148" letter-spacing="4" fill="url(#ice)">BLIZZBEAT</text>')

# Waveform underline.
pts = []
for i in range(0, 600, 4):
    env = math.sin(math.pi * i / 600)
    y = 248 + 13 * env * math.sin(i * 0.11) * math.cos(i * 0.023)
    pts.append(f'{tx + 6 + i} {y:.1f}')
add(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#7fd6ff" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>')

add(f'<text x="{tx + 8}" y="300" font-family="Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="600" font-size="25" '
    f'letter-spacing="7" fill="#cfefff" opacity="0.9">TYPE A SONG NAME OR LINK BELOW</text>')

add('</svg>')
Path(__file__).resolve().parent.parent.joinpath('banner.svg').write_text('\n'.join(out))
print('wrote banner.svg')

# ---- Square avatar (512x512) using the same emblem, for the bot's profile picture. ----
defs = out[1]
av = ['<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">', defs,
      '<rect width="512" height="512" fill="url(#sky)"/>',
      '<circle cx="256" cy="256" r="230" fill="#4fc3ff" opacity="0.10" filter="url(#soft)"/>']
random.seed(3)
for _ in range(45):
    av.append(f'<circle cx="{random.uniform(0, 512):.1f}" cy="{random.uniform(0, 512):.1f}" r="{random.choice([1, 1.5, 2, 2.6])}" fill="#fff" opacity="{random.uniform(0.3, 0.8):.2f}"/>')
av.append('<g transform="translate(256 256) scale(1.75) translate(-205 -190)">')
av.append('<circle cx="205" cy="190" r="118" fill="none" stroke="#7fd6ff" stroke-width="4" opacity="0.55"/>')
av.append(f'<g filter="url(#flakeGlow)">{snowflake(205, 190, 92, "url(#ice)")}</g>')
# Eighth note in the centre of the snowflake.
av.append('<g fill="#0b2446">'
          '<ellipse cx="200" cy="199.5" rx="7.6" ry="5.7" transform="rotate(-22 200 199.5)"/>'
          '<rect x="204.6" y="172" width="3.6" height="28" rx="1.2"/>'
          '<path d="M206.4 172 C212 175.5 219.5 179 217.5 191.5 C216.5 185 212.5 182.5 206.4 181.5 Z"/>'
          '</g>')
av.append('</g></svg>')
Path(__file__).resolve().parent.parent.joinpath('avatar.svg').write_text('\n'.join(av))
print('wrote avatar.svg')
