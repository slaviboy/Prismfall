"""Red Horizon asset preparation (development only; numpy and Pillow).

  python scripts/red_horizon_assets.py textures
      Downloads the Poly Haven (CC0) PBR textures the world uses at 1k into
      assets/external/polyhaven/<id>/ (with source.json) and packs each into two WebP files in
      content/stages/red-horizon/textures/: <name>_albedo.webp (sRGB colour) and <name>_nr.webp
      (R, G = OpenGL normal X and Y, B = roughness).

  python scripts/red_horizon_assets.py grade
      Grades the freight_station panorama band and detail crop (written by fetch-panorama.ts)
      towards a smoke-filled red dusk, and stores a land mask in the alpha channel (1 = land the
      3D world may pass behind: trees, cranes, wagons; 0 = sky and open ground). Also writes
      red_horizon_env.webp, a small full-sphere copy with the same grade for metal reflections.

The grade (one curve for every pixel, so the photo stays coherent):
  - linear light, exposure down to a dusk level;
  - sky pixels: luminance kept, chroma replaced by a smoke ramp (soot brown at the zenith, deep
    red near the horizon, a hot amber where the sun was);
  - land: desaturated to 35 %, then tinted by the same red light;
  - a soft vignette of soot towards the zenith.
"""
import hashlib
import json
import os
import sys
import urllib.request
from datetime import date

import numpy as np
from PIL import Image, ImageFilter

Image.MAX_IMAGE_PIXELS = None
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
STAGE = os.path.join(ROOT, "content", "stages", "red-horizon")
TEX = os.path.join(STAGE, "textures")
EXT = os.path.join(ROOT, "assets", "external", "polyhaven")

TEXTURES = {
    # name in game: (Poly Haven id, what it covers)
    "concrete": ("concrete_layers_02", "ruined towers, highway decks, piers"),
    "rust": ("rusty_metal_04", "wrecks, rusted girders, broken towers"),
    "steel": ("metal_plate_02", "factory cladding, walker hull plates"),
    "armour": ("blue_metal_plate", "machine armour micro detail (normal and roughness; colour regraded to gunmetal)"),
    "asphalt": ("asphalt_02", "the yard's cracked asphalt in the foreground"),
    "burnt": ("burned_ground_01", "scorched earth and ash patches in the foreground"),
}


UA = {"User-Agent": "Prismfall-asset-pipeline/1.0"}


def fetch_json(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        return json.loads(r.read().decode("utf-8"))


def download(url, path, md5):
    if os.path.exists(path) and hashlib.md5(open(path, "rb").read()).hexdigest() == md5:
        return
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA)) as r:
        data = r.read()
    got = hashlib.md5(data).hexdigest()
    if got != md5:
        raise RuntimeError(f"md5 mismatch for {url}: {got} != {md5}")
    with open(path, "wb") as f:
        f.write(data)


def textures():
    os.makedirs(TEX, exist_ok=True)
    for name, (pid, purpose) in TEXTURES.items():
        files = fetch_json(f"https://api.polyhaven.com/files/{pid}")
        info = fetch_json(f"https://api.polyhaven.com/info/{pid}")
        d = os.path.join(EXT, pid)
        os.makedirs(d, exist_ok=True)
        recs = []
        local = {}
        for key, tag in (("Diffuse", "diff"), ("nor_gl", "nor_gl"), ("Rough", "rough")):
            f = files[key]["1k"]["jpg"]
            path = os.path.join(d, f"{pid}_{tag}_1k.jpg")
            download(f["url"], path, f["md5"])
            recs.append({"path": os.path.basename(path), "url": f["url"], "md5": f["md5"], "size": f["size"]})
            local[tag] = path
        albedo = Image.open(local["diff"]).convert("RGB")
        nor = np.asarray(Image.open(local["nor_gl"]).convert("RGB"), dtype=np.uint8)
        rough = np.asarray(Image.open(local["rough"]).convert("L"), dtype=np.uint8)
        packed = np.dstack([nor[..., 0], nor[..., 1], rough])
        a_path = os.path.join(TEX, f"{name}_albedo.webp")
        n_path = os.path.join(TEX, f"{name}_nr.webp")
        albedo.save(a_path, "WEBP", quality=88, method=6)
        Image.fromarray(packed, "RGB").save(n_path, "WEBP", quality=92, method=6)
        source = {
            "id": pid,
            "kind": "texture",
            "name": info["name"],
            "page": f"https://polyhaven.com/a/{pid}",
            "api": {"info": f"https://api.polyhaven.com/info/{pid}", "files": f"https://api.polyhaven.com/files/{pid}"},
            "authors": info.get("authors", {}),
            "licence": "CC0 1.0",
            "licenceUrl": "https://polyhaven.com/license",
            "files": recs,
            "downloaded": date.today().isoformat(),
            "derived": [
                {"path": f"content/stages/red-horizon/textures/{name}_albedo.webp", "how": f"1k diffuse JPG re-encoded as WebP quality 88 ({purpose})"},
                {"path": f"content/stages/red-horizon/textures/{name}_nr.webp", "how": "1k OpenGL normal (R, G) and roughness (B) packed into one WebP, quality 92 (scripts/red_horizon_assets.py)"},
            ],
        }
        with open(os.path.join(d, "source.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(source, fh, indent=2)
            fh.write("\n")
        print(f"{name}: {pid} by {', '.join(info.get('authors', {}).keys())}")


# ---------------------------------------------------------------- panorama grade

ELEV = (-32.0, 40.0)


def srgb_to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lin_to_srgb(c):
    c = np.clip(c, 0, 1)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def grade_array(rgb8, u0, u1, elev_top=ELEV[1], elev_bottom=ELEV[0]):
    """rgb8: HxWx3 uint8 covering azimuth fractions u0..u1 and elevations elev_bottom..elev_top."""
    h, w, _ = rgb8.shape
    s = rgb8.astype(np.float32) / 255.0
    lin = srgb_to_lin(s)
    lum = lin[..., 0] * 0.2126 + lin[..., 1] * 0.7152 + lin[..., 2] * 0.0722
    elev = np.linspace(elev_top, elev_bottom, h, dtype=np.float32)[:, None] * np.ones((1, w), np.float32)
    u = np.linspace(u0, u1, w, dtype=np.float32)[None, :] * np.ones((h, 1), np.float32)

    # ---- Sky versus land, from the ungraded photo. At this sunset the sky is bright and the yard's
    # trees, poles and cranes are dark silhouettes against it: land is what is much darker than
    # the sky a few degrees above it in the same column. Nothing is land well above the cranes.
    r, g, b = s[..., 0], s[..., 1], s[..., 2]
    rows = (elev[:, 0] > 2.0) & (elev[:, 0] < 12.0)
    ref = np.percentile(lum[rows, :], 75, axis=0)[None, :] if rows.any() else np.full((1, w), lum.max())
    ref = np.asarray(Image.fromarray(np.clip(ref / max(1e-6, ref.max()), 0, 1).astype(np.float32)).resize((w, 1), Image.BILINEAR)) * max(1e-6, ref.max())
    ratio = lum / np.maximum(1e-5, ref)
    sky = smooth(0.32, 0.55, ratio)
    sky = np.where(elev > 14.0, 1.0, sky)
    sky = np.where(elev < -1.2, 0.0, sky)
    m = Image.fromarray((sky * 255).astype(np.uint8), "L").filter(ImageFilter.MedianFilter(3))
    sky = np.asarray(m, dtype=np.float32) / 255.0
    sky_soft = np.asarray(m.filter(ImageFilter.GaussianBlur(1.0)), dtype=np.float32) / 255.0

    # ---- The sun's direction (u ~0.6, just above the horizon) becomes a hot glow in the smoke.
    du = (u - 0.6)
    du = du - np.round(du)
    sun = np.exp(-((du * 360.0) ** 2) / (2 * 14.0 ** 2) - ((elev - 1.5) ** 2) / (2 * 6.0 ** 2))
    near_h = smooth(26.0, 0.0, elev)

    # ---- Sky: keep its luminance structure (clouds), recolour as smoke lit red from below.
    skyL = np.power(np.clip(lum, 0, None), 1.25) * 0.5
    zen = np.array([0.050, 0.030, 0.026], np.float32)  # soot brown
    mid = np.array([0.36, 0.09, 0.045], np.float32)  # smoke lit red
    hot = np.array([1.0, 0.36, 0.10], np.float32)  # amber where the sun burns through
    ramp = zen[None, None, :] * (1 - near_h[..., None]) + mid[None, None, :] * near_h[..., None]
    ramp = ramp * (1 - sun[..., None] * 0.6) + hot[None, None, :] * sun[..., None] * 0.6
    sky_rgb = skyL[..., None] * ramp / 0.18
    # Thicker smoke towards the zenith: compress the cloud contrast up there.
    sky_rgb = sky_rgb * (0.55 + 0.45 * near_h[..., None]) + 0.012 * (1 - near_h[..., None])

    # ---- Land: desaturate, darken to dusk, tint by the red light and lift the sunward rim a touch.
    gray = lum[..., None]
    land = gray + (lin - gray) * 0.35
    land = land * 0.30 * np.array([1.0, 0.62, 0.52], np.float32)[None, None, :]
    land = land * (1 + sun[..., None] * 0.8)

    out = land * (1 - sky_soft[..., None]) + sky_rgb * sky_soft[..., None]
    srgb = lin_to_srgb(out)
    # Land mask for occlusion: everything that is not sky and stands above the yard (the open
    # ground below about -0.7 degrees stays 0 so 3D figures on it are never hidden).
    land_mask = (1 - sky) * smooth(-0.9, -0.5, elev)
    # Erode the land by a pixel or two: edge pixels of trees and cranes show sky colour, and must
    # not occlude 3D behind them (that would draw a bright halo round every silhouette).
    hard = Image.fromarray((np.clip(land_mask, 0, 1) * 255).astype(np.uint8), "L").point(lambda x: 255 if x > 140 else 0)
    hard = hard.filter(ImageFilter.MinFilter(3))
    if w > 7000:
        hard = hard.filter(ImageFilter.MinFilter(3))
    alpha = np.asarray(hard, dtype=np.float32) / 255.0
    return (srgb * 255 + 0.5).astype(np.uint8), (alpha * 255 + 0.5).astype(np.uint8)


def grade():
    band_path = os.path.join(TEX, "freight_station_band.webp")
    detail_path = os.path.join(TEX, "freight_station_detail.webp")
    for path, u0, u1 in ((band_path, 0.0, 1.0), (detail_path, float(sys.argv[2]), float(sys.argv[3]))):
        # The ungraded crops fetch-panorama.ts wrote are copied outside the repository (RH_UNGRADED,
        # default: the system temp folder) so grading can rerun; a graded file (with its alpha
        # mask) is never graded twice: run fetch-panorama.ts again first.
        import tempfile

        keep = os.environ.get("RH_UNGRADED", os.path.join(tempfile.gettempdir(), "red_horizon_ungraded"))
        os.makedirs(keep, exist_ok=True)
        src = os.path.join(keep, os.path.basename(path))
        if not os.path.exists(src):
            if Image.open(path).mode == "RGBA":
                raise SystemExit(f"{path} is already graded; run scripts/fetch-panorama.ts first")
            with open(path, "rb") as a, open(src, "wb") as b:
                b.write(a.read())
        rgb = np.asarray(Image.open(src).convert("RGB"))
        graded, alpha = grade_array(rgb, u0, u1)
        img = Image.fromarray(np.dstack([graded, alpha]), "RGBA")
        img.save(path, "WEBP", quality=90, method=6, exact=True)
        print(path, img.size)
    # Full-sphere environment for reflections: the tonemapped original, graded, with the
    # zenith and nadir filled smoothly.
    tm = Image.open(os.path.join(EXT, "freight_station", "freight_station_tonemapped.jpg")).convert("RGB").resize((1024, 512), Image.LANCZOS)
    arr = np.asarray(tm)
    graded, _ = grade_array(arr, 0.0, 1.0, 90.0, -90.0)
    env = Image.fromarray(graded, "RGB").filter(ImageFilter.GaussianBlur(1.5))
    env.save(os.path.join(TEX, "red_horizon_env.webp"), "WEBP", quality=88, method=6)
    print("env", env.size)


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "textures":
        textures()
    elif cmd == "grade":
        grade()
    else:
        print(__doc__)
