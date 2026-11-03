"""Tone-maps a linear HDR crop to match a reference LDR grade (Poly Haven's tonemapped JPG).

Luminance quantiles of the HDR (downscaled to the reference's resolution) are matched to the
reference's in log space, giving one monotonic curve that is applied to each channel of the
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
    # One curve for all three channels (fitted on luminance), like a film curve: neutral tones
    # stay neutral. Per-channel curves diverge near white and leave coloured fringes in fog.
    qs = np.linspace(0.0, 1.0, 2049)
    eps = 1e-6
    lum = lambda a: 0.2126 * a[:, :, 0] + 0.7152 * a[:, :, 1] + 0.0722 * a[:, :, 2]
    # Quantiles of the full-resolution crop itself (subsampled): its value spread is wider than
    # the downscaled copy's, and fitting on the copy pushed fine highlights (fog) to white.
    del small
    src_q = np.quantile(np.log(np.maximum(lum(full[::3, ::3]).ravel(), eps)), qs)
    ref_q = np.quantile(lum(ref).ravel(), qs)
    src_q = np.maximum.accumulate(src_q + np.arange(len(src_q)) * 1e-9)
    out = np.empty((h, w, 3), dtype=np.uint8)
    for c in range(3):
        mapped = np.interp(np.log(np.maximum(full[:, :, c], eps)), src_q, ref_q)
        out[:, :, c] = np.clip(mapped * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out.tofile(out_path)
    print(f'matched {w}x{h}')


if __name__ == '__main__':
    main()
