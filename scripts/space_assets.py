"""Prepares real space imagery for the sky and planet components (numpy + Pillow, development only).

  python scripts/space_assets.py sky <in.tif> <out.webp> --center AZ,EL --roll DEG [--width 6000] [--open 7]
      An all-sky panorama in galactic coordinates (galactic centre at the image centre, longitude
      increasing to the left, such as ESO's eso0932a): point stars are removed with a grey-scale
      opening (the shader draws crisp stars at screen resolution instead), then the sky is turned
      so the galactic centre sits at azimuth AZ / elevation EL (degrees; azimuth 0 = towards the
      board, positive to the right) with the band rolled by ROLL degrees, and written as a world
      equirectangular panorama with the board direction at u = 0.5 (sky `offset` 0.5).

  python scripts/space_assets.py planet <in.jpg> <out.webp> [--width 4096]
      A cylindrical planet map whose polar caps are flat filler (such as Cassini's PIA07782):
      the caps are replaced by a smooth continuation of the last imaged latitudes, converging to
      one colour at each pole.
"""

import argparse

import numpy as np
from numpy.lib.stride_tricks import sliding_window_view
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def load(path):
    return np.asarray(Image.open(path).convert('RGB'), dtype=np.float32) / 255.0


def save(arr, path, quality):
    img = Image.fromarray(np.clip(arr * 255.0 + 0.5, 0, 255).astype(np.uint8))
    img.save(path, quality=quality, method=6)
    print(f'{path}: {img.width}x{img.height}')


def filt(a, k, axis, fn, wrap):
    pad = [(0, 0)] * a.ndim
    pad[axis] = (k // 2, k // 2)
    padded = np.pad(a, pad, mode='wrap' if wrap else 'edge')
    return fn(sliding_window_view(padded, k, axis=axis), axis=-1)


def opening(a, k):
    """Grey opening (erode then dilate) per channel: removes bright features smaller than k px."""
    out = filt(filt(a, k, 1, np.min, True), k, 0, np.min, False)
    return filt(filt(out, k, 1, np.max, True), k, 0, np.max, False)


def box_blur(a, k):
    return filt(filt(a, k, 1, np.mean, True), k, 0, np.mean, False)


def bilinear(img, x, y):
    """Samples img (H, W, C) at float pixel coords, wrapping x and clamping y."""
    h, w = img.shape[:2]
    x0 = np.floor(x).astype(np.int64)
    y0 = np.clip(np.floor(y).astype(np.int64), 0, h - 1)
    fx = (x - np.floor(x))[..., None]
    fy = (y - np.floor(y))[..., None]
    x1 = (x0 + 1) % w
    x0 %= w
    y1 = np.clip(y0 + 1, 0, h - 1)
    top = img[y0, x0] * (1 - fx) + img[y0, x1] * fx
    bot = img[y1, x0] * (1 - fx) + img[y1, x1] * fx
    return top * (1 - fy) + bot * fy


def sky(args):
    src = load(args.input)
    print(f'source {src.shape[1]}x{src.shape[0]}')
    # Smooth background without stars, used only where a star is detected; everywhere else the
    # photo keeps its full detail (dust lanes, star clouds).
    base = box_blur(box_blur(opening(src, args.open), 5), 5)
    lum = np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    star = (src @ lum - base @ lum) > args.threshold
    mask = filt(filt(star.astype(np.float32), 5, 1, np.max, True), 5, 0, np.max, False)
    mask = box_blur(mask, 5)[..., None]
    glow = src * (1 - mask) + base * mask
    print(f'stars masked: {star.mean() * 100:.1f}% of pixels')
    # A small black point keeps empty space black rather than grey.
    glow = np.clip((glow - args.black) / (1 - args.black), 0, 1)

    az, el = (np.radians(float(v)) for v in args.center.split(','))
    # World frame: x right, y up, -z towards the board.
    c = np.array([np.sin(az) * np.cos(el), np.sin(el), -np.cos(az) * np.cos(el)])
    up = np.array([0.0, 1.0, 0.0])
    gz = up - c * np.dot(up, c)
    gz /= np.linalg.norm(gz)
    roll = np.radians(args.roll)
    # Rodrigues rotation of the galactic pole about the centre direction.
    gz = gz * np.cos(roll) + np.cross(c, gz) * np.sin(roll) + c * np.dot(c, gz) * (1 - np.cos(roll))
    gx = c
    gy = np.cross(gz, gx)

    w = args.width
    h = w // 2
    out = np.empty((h, w, 3), dtype=np.float32)
    sh, sw = glow.shape[:2]
    u = (np.arange(w) + 0.5) / w
    theta = (u - 0.5) * 2 * np.pi
    for j0 in range(0, h, 256):
        rows = np.arange(j0, min(h, j0 + 256))
        e = np.radians(90 - (rows + 0.5) / h * 180)[:, None]
        d = np.stack([np.sin(theta)[None, :] * np.cos(e), np.broadcast_to(np.sin(e), (len(rows), w)), -np.cos(theta)[None, :] * np.cos(e)], axis=-1)
        lx, ly, lz = d @ gx, d @ gy, d @ gz
        lon = np.degrees(np.arctan2(ly, lx))
        lat = np.degrees(np.arcsin(np.clip(lz, -1, 1)))
        out[rows] = bilinear(glow, (0.5 - lon / 360) * sw - 0.5, (0.5 - lat / 180) * sh - 0.5)
    save(out, args.output, args.quality)


def planet(args):
    m = load(args.input)
    h = m.shape[0]
    # Rows that are flat filler: almost no variation along the row.
    spread = m.std(axis=1).mean(axis=1)
    imaged = np.where(spread > 0.004)[0]
    top, bottom = imaged[0] + 3, imaged[-1] - 3
    print(f'imaged rows {top}..{bottom} of {h}')
    band = 24
    for rows, edge, step in ((range(top - 1, -1, -1), top, -1), (range(bottom + 1, h), bottom, 1)):
        ref = m[edge:edge + band] if step < 0 else m[edge - band + 1:edge + 1]
        ref = box_blur(ref.mean(axis=0, keepdims=True).repeat(8, axis=0), 61)[0]
        mean = ref.mean(axis=0)
        for r in rows:
            t = abs(r - edge) / max(1, (edge if step < 0 else h - 1 - edge))
            # Detail fades into the row mean, so the pole itself is one colour (the planet shader adds
            # the polar haze over a realistic latitude range).
            m[r] = ref * (1 - t) + mean * t
    # Soften the seam between the imaged rows and the filled caps.
    for edge in (top, bottom):
        lo, hi = max(0, edge - 6), min(h, edge + 7)
        m[lo:hi] = box_blur(m[lo:hi], 5)
    if args.width and args.width != m.shape[1]:
        img = Image.fromarray(np.clip(m * 255 + 0.5, 0, 255).astype(np.uint8)).resize((args.width, args.width // 2), Image.LANCZOS)
        m = np.asarray(img, dtype=np.float32) / 255.0
    save(m, args.output, args.quality)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sky')
    s.add_argument('input')
    s.add_argument('output')
    s.add_argument('--center', default='20,12')
    s.add_argument('--roll', type=float, default=-28)
    s.add_argument('--width', type=int, default=6000)
    s.add_argument('--open', type=int, default=7)
    s.add_argument('--black', type=float, default=0.02)
    s.add_argument('--threshold', type=float, default=0.05)
    s.add_argument('--quality', type=int, default=90)
    p = sub.add_parser('planet')
    p.add_argument('input')
    p.add_argument('output')
    p.add_argument('--width', type=int, default=4096)
    p.add_argument('--quality', type=int, default=92)
    args = ap.parse_args()
    sky(args) if args.cmd == 'sky' else planet(args)


if __name__ == '__main__':
    main()
