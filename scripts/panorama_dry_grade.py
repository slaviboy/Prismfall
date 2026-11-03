"""Dry-season grade for a panorama band: turns flowering yellow-green field near the horizon into
sun-dried desert ochre, leaving the sky, rock and mountain slopes as photographed.

  python scripts/panorama_dry_grade.py <in.webp> <out.webp> --elevation -6,40 [--top 3.2] [--quality 88]

Pixels below `--top` degrees of elevation whose hue is yellow to green and that are saturated move
to an ochre hue with less saturation and slightly less brightness; the mask is feathered in hue,
saturation and elevation so the mountain foot keeps its own colours. Development only (numpy, Pillow).
"""
import argparse

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None

ap = argparse.ArgumentParser()
ap.add_argument("src")
ap.add_argument("dst")
ap.add_argument("--elevation", default="-6,40")
ap.add_argument("--top", type=float, default=3.2)
ap.add_argument("--quality", type=int, default=88)
a = ap.parse_args()
lo, hi = (float(v) for v in a.elevation.split(","))

img = np.asarray(Image.open(a.src).convert("RGB")).astype(np.float32) / 255.0
h, w, _ = img.shape
r, g, b = img[..., 0], img[..., 1], img[..., 2]
mx = img.max(axis=2)
mn = img.min(axis=2)
d = mx - mn + 1e-6
hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60.0
sat = d / (mx + 1e-6)
val = mx


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


elev = hi - (np.arange(h, dtype=np.float32) + 0.5) / h * (hi - lo)
w_e = (1 - smooth(a.top - 1.2, a.top, elev))[:, None]
w_h = smooth(30, 42, hue) * (1 - smooth(100, 125, hue))
w_s = smooth(0.2, 0.36, sat)
k = w_e * w_h * w_s
# Target: ochre, less saturated, a touch darker (dry grass and gravel in low sun).
th = 30.0
ts = sat * 0.55
tv = val * 0.9
c = tv * ts
x = c * (1 - abs((th / 60.0) % 2 - 1))
m = tv - c
tr, tg, tb = c + m, x + m, m
out = img.copy()
out[..., 0] = r * (1 - k) + tr * k
out[..., 1] = g * (1 - k) + tg * k
out[..., 2] = b * (1 - k) + tb * k
Image.fromarray(np.clip(out * 255 + 0.5, 0, 255).astype(np.uint8)).save(a.dst, "WEBP", quality=a.quality, method=6)
print(f"graded {a.src} -> {a.dst}: {float(k.mean()) * 100:.1f}% of pixels changed (weighted)")
