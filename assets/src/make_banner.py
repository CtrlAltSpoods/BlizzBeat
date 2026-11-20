"""Generates assets/banner.svg (rendered to banner.png with rsvg-convert) and avatar.svg.
banner_svg(t) also draws one frame of the animated banner (see make_banner_anim.py).

Run:  python3 assets/src/make_banner.py && rsvg-convert -w 1600 assets/banner.svg -o assets/banner.png && rsvg-convert -w 512 assets/avatar.svg -o assets/avatar.png
      python3 assets/src/make_banner_anim.py   (animated assets/banner.webp)
"""
import math
import random
from pathlib import Path

W, H = 1600, 400
TAU = 2 * math.pi
random.seed(7)

DEFS = """<defs>
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
</defs>"""

# Scene data, drawn once so every animation frame uses the same flakes.
SNOW = []
for _ in range(170):
    x, y = random.uniform(0, W), random.uniform(0, H)
    r = random.choice([0.8, 1.1, 1.4, 1.8, 2.4, 3.2])
    o = random.uniform(0.25, 0.85) * (0.6 if r < 1.5 else 1)
    SNOW.append((x, y, r, o))
SOFT = []
for _ in range(14):
    x, y = random.uniform(0, W), random.uniform(0, H)
    SOFT.append((x, y, random.uniform(5, 9)))
random.seed(11)
SWAY = [random.uniform(0, TAU) for _ in range(len(SNOW) + len(SOFT))]
BAR_SPEED = [random.choice((1, 2, 3)) for _ in range(13)]
BAR_PHASE = [random.uniform(0, TAU) for _ in range(13)]


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


def banner_svg(t=None):
    """The banner. t=None draws the still image; 0 <= t < 1 draws that moment of a seamless loop."""
    anim = t is not None
    t = t or 0.0
    out = []
    add = out.append
    add(f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">')
    add(DEFS)
    if anim:
        # A band of light that sweeps across the wordmark once per loop.
        sx = -500 + 2300 * min(1.0, t / 0.45)
        add(f'<defs><linearGradient id="shine" gradientUnits="userSpaceOnUse" x1="{sx - 140:.1f}" y1="60" x2="{sx + 140:.1f}" y2="260">'
            '<stop offset="0" stop-color="#9be3ff" stop-opacity="0"/>'
            '<stop offset="0.35" stop-color="#9be3ff" stop-opacity="0.55"/>'
            '<stop offset="0.5" stop-color="#ffffff" stop-opacity="1"/>'
            '<stop offset="0.65" stop-color="#9be3ff" stop-opacity="0.55"/>'
            '<stop offset="1" stop-color="#9be3ff" stop-opacity="0"/></linearGradient></defs>')

    add(f'<rect width="{W}" height="{H}" fill="url(#sky)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glow)"/>')
    add(f'<rect width="{W}" height="{H}" fill="url(#glow2)"/>')

    # Equalizer bars rising on the right, like a frozen skyline (they bounce in the animation).
    bx, bw, gap = 1262, 17, 8
    for i in range(13):
        u = i / 12
        h = 70 + 170 * abs(math.sin(i * 0.9 + 0.6)) * (0.55 + 0.45 * math.sin(u * math.pi))
        if anim:
            h *= 0.72 + 0.28 * (0.5 + 0.5 * math.sin(TAU * BAR_SPEED[i] * t + BAR_PHASE[i]))
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

    # Falling snow. Each flake falls a whole number of screen heights per loop, so the loop is seamless.
    span = H + 24

    def fall(x, y, speed, k):
        if not anim:
            return x, y
        y = (y + 12 + speed * span * t) % span - 12
        return x + 7 * math.sin(TAU * t + SWAY[k]), y

    for k, (x, y, r, o) in enumerate(SNOW):
        x, y = fall(x, y, 1 if r < 1.5 else 2, k)
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#ffffff" opacity="{o:.2f}"/>')
    for k, (x, y, r) in enumerate(SOFT):
        x, y = fall(x, y, 1, len(SNOW) + k)
        add(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.1f}" fill="#bfe9ff" opacity="0.18" filter="url(#soft)"/>')

    # Emblem: ring + snowflake + a play triangle in the centre.
    cx, cy = 205, 190
    add(f'<circle cx="{cx}" cy="{cy}" r="118" fill="#0b2446" opacity="0.65"/>')
    pulse = 0.55 + (0.2 * math.sin(TAU * t) if anim else 0)
    add(f'<circle cx="{cx}" cy="{cy}" r="118" fill="none" stroke="#7fd6ff" stroke-width="4" opacity="{pulse:.2f}"/>')
    # Dashes divide the ring evenly (72 of them), so turning it by one dash per loop is seamless.
    dash = 2 * math.pi * 132 / 72
    turn = 360 / 72 * t if anim else 0
    add(f'<circle cx="{cx}" cy="{cy}" r="132" fill="none" stroke="#7fd6ff" stroke-width="1.5" opacity="0.25" '
        f'stroke-dasharray="{dash * 0.25:.3f} {dash * 0.75:.3f}" transform="rotate({turn:.2f} {cx} {cy})"/>')
    add(f'<g filter="url(#flakeGlow)">{snowflake(cx, cy, 92, "url(#ice)")}</g>')
    add(f'<path d="M{cx - 8} {cy - 14} L{cx + 15} {cy} L{cx - 8} {cy + 14} Z" fill="#0b2446"/>')

    # Wordmark.
    tx = 380
    font = 'font-family="Inter Display, Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="900" font-size="148" letter-spacing="4"'
    add(f'<text x="{tx}" y="212" {font} fill="#4fc3ff" opacity="0.35" filter="url(#soft)">BLIZZBEAT</text>')
    if anim and t < 0.45:
        # The sweep: a soft bloom around the letters it passes, then a bright glint on the letters themselves.
        add(f'<text x="{tx}" y="212" {font} fill="url(#shine)" stroke="url(#shine)" stroke-width="10" filter="url(#soft)">BLIZZBEAT</text>')
    add(f'<text x="{tx}" y="212" {font} fill="url(#ice)">BLIZZBEAT</text>')
    if anim and t < 0.45:
        add(f'<text x="{tx}" y="212" {font} fill="url(#shine)">BLIZZBEAT</text>')

    # Waveform underline (it ripples in the animation).
    pts = []
    for i in range(0, 600, 4):
        env = math.sin(math.pi * i / 600)
        if anim:
            y = 248 + 13 * env * math.sin(i * 0.11 - TAU * 3 * t) * math.cos(i * 0.023 + TAU * t)
        else:
            y = 248 + 13 * env * math.sin(i * 0.11) * math.cos(i * 0.023)
        pts.append(f'{tx + 6 + i} {y:.1f}')
    add(f'<polyline points="{" ".join(pts)}" fill="none" stroke="#7fd6ff" stroke-width="3.5" stroke-linecap="round" opacity="0.9"/>')

    add(f'<text x="{tx + 8}" y="300" font-family="Inter, Montserrat, DejaVu Sans, sans-serif" font-weight="600" font-size="25" '
        f'letter-spacing="7" fill="#cfefff" opacity="0.9">TYPE A SONG NAME OR LINK BELOW</text>')
    add('</svg>')
    return '\n'.join(out)


if __name__ == '__main__':
    Path(__file__).resolve().parent.parent.joinpath('banner.svg').write_text(banner_svg())
    print('wrote banner.svg')

# ---- Square avatar (512x512) using the same emblem, for the bot's profile picture. ----
random.seed(3)
AV_SNOW = [(random.uniform(0, 512), random.uniform(0, 512), random.choice([1, 1.5, 2, 2.6]), random.uniform(0.3, 0.8))
           for _ in range(45)]
random.seed(5)
AV_SWAY = [random.uniform(0, TAU) for _ in AV_SNOW]


def avatar_svg(t=None):
    """The avatar. t=None draws the still image; 0 <= t < 1 draws that moment of a seamless loop."""
    anim = t is not None
    t = t or 0.0
    av = ['<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">', DEFS,
          '<rect width="512" height="512" fill="url(#sky)"/>']
    halo = 0.10 + (0.05 * math.sin(TAU * t) if anim else 0)
    av.append(f'<circle cx="256" cy="256" r="230" fill="#4fc3ff" opacity="{halo:.3f}" filter="url(#soft)"/>')
    span = 512 + 12
    for k, (x, y, r, o) in enumerate(AV_SNOW):
        if anim:
            y = (y + 6 + (1 if r < 2 else 2) * span * t) % span - 6
            x += 6 * math.sin(TAU * t + AV_SWAY[k])
        av.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r}" fill="#fff" opacity="{o:.2f}"/>')
    av.append('<g transform="translate(256 256) scale(1.75) translate(-205 -190)">')
    ring = 0.55 + (0.2 * math.sin(TAU * t) if anim else 0)
    av.append(f'<circle cx="205" cy="190" r="118" fill="none" stroke="#7fd6ff" stroke-width="4" opacity="{ring:.2f}"/>')
    if anim:
        # A dotted orbit that turns by one dot per loop (seamless), like the channel banner's ring.
        dash = 2 * math.pi * 128 / 48
        av.append(f'<circle cx="205" cy="190" r="128" fill="none" stroke="#7fd6ff" stroke-width="2" opacity="0.35" '
                  f'stroke-dasharray="{dash * 0.25:.3f} {dash * 0.75:.3f}" transform="rotate({360 / 48 * t:.2f} 205 190)"/>')
    # The snowflake turns a sixth of a circle per loop; it has six arms, so the loop is seamless.
    # Its shading is counter-rotated so the light always comes from the top, as in the still avatar.
    spin = 60 * t if anim else 0
    fill = 'url(#ice)'
    if anim:
        av.append(f'<defs><linearGradient id="iceSpin" gradientUnits="userSpaceOnUse" x1="205" y1="88" x2="205" y2="292" '
                  f'gradientTransform="rotate({-spin:.2f} 205 190)">'
                  '<stop offset="0" stop-color="#ffffff"/><stop offset="0.55" stop-color="#d9f4ff"/>'
                  '<stop offset="1" stop-color="#7fd6ff"/></linearGradient></defs>')
        fill = 'url(#iceSpin)'
    # (Glow outside the rotation: blurring inside a rotated group smears it.)
    av.append(f'<g filter="url(#flakeGlow)"><g transform="rotate({spin:.2f} 205 190)">{snowflake(205, 190, 92, fill)}</g></g>')
    # Eighth note in the centre of the snowflake (stays upright); it bobs gently in the animation.
    bob = 2.2 * math.sin(TAU * 2 * t) if anim else 0
    av.append(f'<g fill="#0b2446" transform="translate(0 {bob:.2f})">'
              '<ellipse cx="200" cy="199.5" rx="7.6" ry="5.7" transform="rotate(-22 200 199.5)"/>'
              '<rect x="204.6" y="172" width="3.6" height="28" rx="1.2"/>'
              '<path d="M206.4 172 C212 175.5 219.5 179 217.5 191.5 C216.5 185 212.5 182.5 206.4 181.5 Z"/>'
              '</g>')
    av.append('</g></svg>')
    return '\n'.join(av)


if __name__ == '__main__':
    Path(__file__).resolve().parent.parent.joinpath('avatar.svg').write_text(avatar_svg())
    print('wrote avatar.svg')
