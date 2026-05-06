#!/usr/bin/env python3
"""
Generate a Compass app icon (compass rose) at 1024×1024.
Then `iconutil` converts it to .icns. Run once; commit the .icns.
"""
import math
import sys
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(__file__).parent / 'icon.png'
SIZE = 1024
CENTER = SIZE // 2
PADDING = 48  # macOS Big Sur+ icons sit inside a rounded square with breathing room

# Compass brand palette — teal/sky accent on a deep navy gradient
BG_TOP = (15, 17, 23, 255)        # near-black
BG_BOT = (24, 28, 38, 255)        # navy
RING = (88, 196, 220, 255)        # teal
NEEDLE_N = (88, 196, 220, 255)    # teal — north
NEEDLE_S = (200, 210, 220, 255)   # cool gray — south
HUB = (240, 245, 250, 255)        # near-white center

def rounded_rect(draw, bbox, radius, fill):
    """Big-Sur-style rounded square (~22% radius)."""
    x0, y0, x1, y1 = bbox
    draw.rounded_rectangle(bbox, radius=radius, fill=fill)

def vertical_gradient(size, top, bottom):
    """Simple vertical gradient fill."""
    img = Image.new('RGBA', size, top)
    px = img.load()
    h = size[1]
    for y in range(h):
        t = y / (h - 1)
        r = int(top[0] * (1 - t) + bottom[0] * t)
        g = int(top[1] * (1 - t) + bottom[1] * t)
        b = int(top[2] * (1 - t) + bottom[2] * t)
        for x in range(size[0]):
            px[x, y] = (r, g, b, 255)
    return img

def main():
    # Background — rounded square with vertical gradient
    bg = vertical_gradient((SIZE - 2 * PADDING, SIZE - 2 * PADDING), BG_TOP, BG_BOT)
    icon = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

    # Composite the gradient inside a rounded mask so the corners are clean
    mask = Image.new('L', bg.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, bg.size[0], bg.size[1]),
                                            radius=int(bg.size[0] * 0.22), fill=255)
    icon.paste(bg, (PADDING, PADDING), mask)

    draw = ImageDraw.Draw(icon)

    # Outer ring
    ring_r = int(SIZE * 0.36)
    ring_w = int(SIZE * 0.018)
    draw.ellipse(
        (CENTER - ring_r, CENTER - ring_r, CENTER + ring_r, CENTER + ring_r),
        outline=RING, width=ring_w
    )

    # Inner ring (subtle)
    inner_r = int(SIZE * 0.30)
    draw.ellipse(
        (CENTER - inner_r, CENTER - inner_r, CENTER + inner_r, CENTER + inner_r),
        outline=(RING[0], RING[1], RING[2], 90), width=int(SIZE * 0.006)
    )

    # Cardinal tick marks (N E S W)
    tick_outer = ring_r - int(SIZE * 0.012)
    tick_inner = ring_r - int(SIZE * 0.05)
    for angle_deg in (0, 90, 180, 270):
        a = math.radians(angle_deg - 90)  # 0° = north
        x0 = CENTER + math.cos(a) * tick_inner
        y0 = CENTER + math.sin(a) * tick_inner
        x1 = CENTER + math.cos(a) * tick_outer
        y1 = CENTER + math.sin(a) * tick_outer
        draw.line((x0, y0, x1, y1), fill=RING, width=int(SIZE * 0.012))

    # Compass needle — two solid triangles back-to-back
    needle_len = int(SIZE * 0.28)
    needle_half = int(SIZE * 0.05)

    # North half (teal, points up)
    draw.polygon(
        [
            (CENTER, CENTER - needle_len),       # tip
            (CENTER - needle_half, CENTER),       # left base
            (CENTER + needle_half, CENTER)        # right base
        ],
        fill=NEEDLE_N
    )
    # South half (gray, points down)
    draw.polygon(
        [
            (CENTER, CENTER + needle_len),
            (CENTER - needle_half, CENTER),
            (CENTER + needle_half, CENTER)
        ],
        fill=NEEDLE_S
    )

    # Center hub
    hub_r = int(SIZE * 0.026)
    draw.ellipse(
        (CENTER - hub_r, CENTER - hub_r, CENTER + hub_r, CENTER + hub_r),
        fill=HUB
    )

    icon.save(OUT, 'PNG')
    print(f"Wrote {OUT} ({SIZE}×{SIZE})")

if __name__ == '__main__':
    main()
