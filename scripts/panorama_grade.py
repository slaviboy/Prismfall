"""Grades a panorama band or detail crop (WebP/JPG) for a world's mood, in linear light.

Usage: python scripts/panorama_grade.py <in> <out> --elevation LOW,HIGH [--preset ember] [--quality 88]

Presets:
  ember: the storm-lit dusk of The Warden's Spire. The photo's sky becomes a dark red-amber glow
         that is brightest along the horizon and falls to near-black higher up (the storm deck
         covers it there); the land becomes dark, desaturated warm stone.

Development only (numpy and Pillow). The input's rows span elevations HIGH (top) to LOW (bottom).
"""
import argparse

import numpy as np
from PIL import Image, ImageFilter


def srgb_to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


def ember(rgb, elev):
    lum = rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722
    blueish = np.clip((rgb[..., 2] - rgb[..., 0]) * 6 + 0.5, 0, 1)
    # Sky: horizon brightest; mapped to a red-amber ramp by brightness.
    e = elev[:, None]
    up = np.maximum(e + 0.8, 0)
    sky_gain = 0.035 + 0.6 * np.exp(-up / 1.6) + 0.35 * np.exp(-up / 5.0)
    t = np.clip(lum, 0, 1)
    sky = np.stack([t ** 1.3 * 1.0, t ** 1.6 * 0.33, t ** 1.9 * 0.17], -1) * sky_gain[..., None]
    above = smoothstep(-2.0, -0.4, e)[..., None]
    # Land: desaturated warm dark stone; distant haze takes a little red.
    grey = lum[..., None]
    land = (grey * 0.75 + rgb * 0.25) * np.array([0.78, 0.5, 0.44]) * 0.55
    haze = np.exp(-np.abs(e + 1.0) / 1.6)[..., None]
    land = land * (1 - haze * 0.4) + np.stack([t * 0.9, t * 0.32, t * 0.18], -1) * haze * 0.55
    # Sky where the photo is sky: near the horizon a pixel is sky when it is about as bright as
    # the brightest part of its row (the haze), land when clearly darker (a peak, a ridge).
    row_ref = np.percentile(lum, 90, axis=1)[:, None]
    bright = smoothstep(0.55, 0.85, lum / np.maximum(row_ref, 1e-4))
    w = np.clip(above[..., 0] * bright + smoothstep(0.3, 1.2, e), 0, 1)[..., None]
    return land * (1 - w) + sky * w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--elevation", required=True)
    ap.add_argument("--preset", default="ember")
    ap.add_argument("--quality", type=int, default=88)
    a = ap.parse_args()
    lo, hi = (float(v) for v in a.elevation.split(","))
    src = Image.open(a.src).convert("RGB")
    img = np.asarray(src).astype(np.float32) / 255.0
    h = img.shape[0]
    elev = hi - (np.arange(h) + 0.5) / h * (hi - lo)
    # The sky has no detail worth keeping: blur it so the crushed gradient cannot band.
    # A light blur just above the horizon, a heavy one higher up (the source's smooth gradient
    # carries compression steps that the grade would otherwise turn into contours).
    light = np.asarray(src.filter(ImageFilter.GaussianBlur(radius=max(2, h / 300)))).astype(np.float32) / 255.0
    heavy = np.asarray(src.filter(ImageFilter.GaussianBlur(radius=max(8, h / 25)))).astype(np.float32) / 255.0
    near_rows = smoothstep(0.6, 2.0, elev)[:, None, None]
    high_rows = smoothstep(2.0, 5.0, elev)[:, None, None]
    img = img * (1 - near_rows) + light * near_rows
    img = img * (1 - high_rows) + heavy * high_rows
    lin = srgb_to_linear(img)
    out = linear_to_srgb(ember(lin, elev))
    # Triangular dither before quantising (no contour steps in the dark gradient).
    rng = np.random.default_rng(7)
    dither = (rng.random(out.shape) - rng.random(out.shape)) / 255.0
    Image.fromarray(np.clip((out + dither) * 255 + 0.5, 0, 255).astype(np.uint8)).save(a.dst, quality=a.quality, method=6)
    print(f"graded {a.src} -> {a.dst} ({lin.shape[1]}x{h}, elevations {lo}..{hi})")


if __name__ == "__main__":
    main()
