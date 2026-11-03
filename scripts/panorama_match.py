"""Tone-maps a linear HDR crop to match a reference LDR grade (Poly Haven's tonemapped JPG).

For each channel, quantiles of the HDR (downscaled to the reference's resolution) are matched to
the reference's quantiles in log space, giving a monotonic curve that is then applied to the
full-resolution crop. Inputs and outputs are raw interleaved buffers written by ffmpeg.

Usage: python scripts/panorama_match.py <hdr_full.f32> <w> <h> <hdr_small.f32> <ref_small.rgb24> <sw> <sh> <out.rgb24>
Requires numpy (development tool only; nothing here ships with the game).
"""
import sys

import numpy as np


def main() -> None:
    full_path, w, h, small_path, ref_path, sw, sh, out_path = sys.argv[1:9]
    w, h, sw, sh = int(w), int(h), int(sw), int(sh)
    def planar(path: str, ww: int, hh: int) -> np.ndarray:
        g, b, r = np.fromfile(path, dtype=np.float32).reshape(3, hh, ww)
        return np.stack([r, g, b], axis=-1)

    small = planar(small_path, sw, sh)
    ref = np.fromfile(ref_path, dtype=np.uint8).reshape(sh, sw, 3).astype(np.float32) / 255.0
    full = planar(full_path, w, h)
    qs = np.linspace(0.0, 1.0, 2049)
    out = np.empty((h, w, 3), dtype=np.uint8)
    eps = 1e-6
    for c in range(3):
        src = np.log(np.maximum(small[:, :, c].ravel(), eps))
        src_q = np.quantile(src, qs)
        ref_q = np.quantile(ref[:, :, c].ravel(), qs)
        # Strictly increasing source quantiles for interpolation.
        src_q = np.maximum.accumulate(src_q + np.arange(len(src_q)) * 1e-9)
        ch = np.log(np.maximum(full[:, :, c], eps))
        mapped = np.interp(ch, src_q, ref_q)
        out[:, :, c] = np.clip(mapped * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out.tofile(out_path)
    print(f'matched {w}x{h}')


if __name__ == '__main__':
    main()
