"""Moving Sands pyramids: original, weathered ancient Egyptian-style stepped-core pyramids and ruins.

Every pyramid is built course by course: each masonry course is a closed footprint loop (a square
whose corners are worn back, with per-block offsets, missing blocks and eroded patches) extruded
into a vertical riser, and the ledge (tread) between two loops is triangulated. Blocks inside a
course come from a tiling texture atlas whose rows line up with the geometric courses, so every
riser shows individual weathered blocks with sand in the joints.

Objects (each origin at its base centre, z = 0 at ground level, placed at its world x, y like the
other Moving Sands kit objects; the game snaps each one onto the dunes):
  pyramid_great   ~230 m base, ~51.8 degree faces, missing apex, stepped core masonry
  pyramid_medium  ~140 m base, heavily eroded, collapsed upper courses, rubble slopes
  pyramid_small   ~60 m base, one face with a ruined casing remnant and a rubble slope
  temple_ruin     weathered mastaba with a colonnade of Egyptian-style columns, partly fallen
  column_drums    fallen column drums
  rubble_pile     heap of broken blocks

Materials (names are the contract with stage.json; use preset "keep" to show the textures):
  pyramidStone  textured limestone: base colour, normal and roughness atlas (WebP); the base colour
                is multiplied by the vertex colours (COLOR_0 = macro weathering x ambient occlusion)
  pyramidSand   sand drifts and aprons (plain colour x vertex colours)

Texture atlas (2048 px, 16 rows of 128 px; 1 row = 1.1 m, the atlas tiles every 17.6 m in u):
  rows 0-11 riser block faces, row 12 rubble, row 13 smooth casing, rows 14-15 ledge tops with sand.

Usage: blender -b --factory-startup --python assets/blender/scripts/pyramids.py -- [--no-preview]
       [--preview=overview,corner,...] (subset of preview renders, for iteration)
"""
import math
import os
import random
import sys
from bisect import bisect_right

import bpy
import numpy as np
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "pyramids")
OUT_GLB = os.path.join(OUT_DIR, "pyramids.glb")
OUT_META = os.path.join(OUT_DIR, "pyramids.meta.json")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "environments", "pyramids.blend")
TEX_DIR = os.path.join(common.ROOT, "assets", "blender", "source", "textures")
PREVIEW_DIR = os.path.join(common.ROOT, "assets", "blender", "previews")

# --- Texture atlas layout ------------------------------------------------------------------

TEX = 2048
ROWS = 16
RH = TEX // ROWS  # pixels per row
ROW_M = 1.1  # metres represented by one row (vertically)
PXM = RH / ROW_M  # pixels per metre
TILE_M = TEX / PXM  # metres per atlas width (u = 1)
RISER_ROWS = list(range(12))
RUBBLE_ROW = 12
CASING_ROW = 13
TREAD_ROWS = [14, 15]
MONO_M = 8.0  # the casing row starts with one jointless 8 m slab (u 0..MONO_U) for column drums
MONO_U = MONO_M / TILE_M

SAND_SRGB = (0.80, 0.60, 0.40)


def _smooth(t):
    return t * t * (3.0 - 2.0 * t)


def lattice_noise(rng, cx, cy, h=TEX, w=TEX):
    """Value noise in 0..1 that tiles with the image (cx, cy lattice cells across it)."""
    lat = rng.random((cy, cx), dtype=np.float32)
    y = (np.arange(h, dtype=np.float32) + 0.5) * (cy / h)
    x = (np.arange(w, dtype=np.float32) + 0.5) * (cx / w)
    y0 = np.floor(y).astype(np.int64)
    x0 = np.floor(x).astype(np.int64)
    fy = _smooth(y - y0)[:, None]
    fx = _smooth(x - x0)[None, :]
    y0 %= cy
    x0 %= cx
    y1 = (y0 + 1) % cy
    x1 = (x0 + 1) % cx
    a = lat[y0][:, x0]
    b = lat[y0][:, x1]
    c = lat[y1][:, x0]
    d = lat[y1][:, x1]
    top = a + (b - a) * fx
    bot = c + (d - c) * fx
    return top + (bot - top) * fy


def fbm(rng, cx, cy, octaves=4, gain=0.5, h=TEX, w=TEX):
    total = np.zeros((h, w), np.float32)
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        total += lattice_noise(rng, cx * 2 ** o, cy * 2 ** o, h, w) * amp
        norm += amp
        amp *= gain
    total /= norm
    # Re-stretch: an fBm sum clusters around 0.5; map roughly back to 0..1.
    return np.clip((total - 0.5) * (1.0 + 0.6 * octaves) + 0.5, 0.0, 1.0)


def box_blur(a, radius):
    """Separable box blur that wraps around the edges (keeps the atlas tiling)."""
    k = 2 * radius + 1
    for axis in (0, 1):
        acc = np.zeros_like(a)
        for o in range(-radius, radius + 1):
            acc += np.roll(a, o, axis=axis)
        a = acc / k
    return a


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def block_layout(rng, min_w, max_w, first_w=0.0):
    """Joint positions (px) for one tiling row of blocks (optionally a fixed-width first block)."""
    first = first_w * PXM
    widths = []
    while first + sum(widths) < TEX:
        widths.append(rng.uniform(min_w, max_w) * PXM)
    widths = np.array(widths, np.float32)
    widths *= (TEX - first) / widths.sum()
    if first:
        widths = np.concatenate([[first], widths]).astype(np.float32)
    return np.concatenate([[0.0], np.cumsum(widths)]).astype(np.float32)


class Atlas:
    """Builds the limestone atlas: sRGB colour, height (m), roughness."""

    def __init__(self, seed=11):
        self.rng = np.random.default_rng(seed)
        self.col = np.zeros((TEX, TEX, 3), np.float32)
        self.height = np.zeros((TEX, TEX), np.float32)
        self.rough = np.zeros((TEX, TEX), np.float32)
        r = self.rng
        # Shared noise fields (whole atlas, tiling).
        self.n_dispx = fbm(r, 64, 64, 4)
        self.n_dispy = fbm(r, 64, 64, 4)
        self.n_ero = fbm(r, 96, 96, 4)
        self.n_fine = fbm(r, 256, 256, 3)
        self.n_mid = fbm(r, 48, 48, 4)
        self.n_low = fbm(r, 12, 12, 4)
        self.n_grain = r.random((TEX, TEX), dtype=np.float32)
        self.n_band = fbm(r, 6, 160, 3)  # horizontal bedding in the limestone
        # Round weathering pits: blurred white noise, keep the brightest few percent.
        blurred = box_blur(r.random((TEX, TEX), dtype=np.float32), 2)
        blurred = box_blur(blurred, 1)
        thr = np.quantile(blurred, 0.95)
        self.pits = smoothstep(thr, thr + 0.02, blurred) * smoothstep(0.35, 0.7, fbm(r, 24, 24, 3))

    def rows(self, r):
        return slice(r * RH, (r + 1) * RH)

    def _blocks(self, r, min_w, max_w, jitter_x=7.0, jitter_y=3.0, first_w=0.0, off=None, gap_scale=1.0):
        """Per-pixel block id and signed distance to the block outline (px) for row r."""
        rng = self.rng
        sl = self.rows(r)
        edges = block_layout(rng, min_w, max_w, first_w)
        n = len(edges) - 1
        off = rng.uniform(0, TEX) if off is None else off
        x = np.arange(TEX, dtype=np.float32)[None, :]
        y = np.arange(RH, dtype=np.float32)[:, None] + 0.5
        dx = (self.n_dispx[sl] - 0.5) * 2 * jitter_x
        dy = (self.n_dispy[sl] - 0.5) * 2 * jitter_y
        xs = (x + off + dx) % TEX
        idx = np.clip(np.searchsorted(edges, xs, side="right") - 1, 0, n - 1)
        left = edges[idx]
        right = edges[idx + 1]
        top_in = rng.uniform(0, 4 * gap_scale, n).astype(np.float32)[idx]
        bot_in = rng.uniform(0, 2 * gap_scale, n).astype(np.float32)[idx]
        yl = y + dy
        self._last_off = off + dx
        self._last_left = left
        self._last_w = right - left
        self._dv = np.minimum(xs - left, right - xs)
        self._dh = np.minimum(yl - bot_in, RH - top_in - yl)
        d = np.minimum(self._dv, self._dh)
        return idx, n, d, yl

    def riser_row(self, r):
        rng = self.rng
        sl = self.rows(r)
        idx, n, d, yl = self._blocks(r, 0.8, 2.3, jitter_x=4.0, jitter_y=1.5)
        palette = np.array([
            (0.80, 0.68, 0.52), (0.86, 0.77, 0.62), (0.82, 0.66, 0.47), (0.77, 0.70, 0.60),
            (0.73, 0.61, 0.47), (0.88, 0.80, 0.66),
        ], np.float32)
        weights = np.array([0.32, 0.2, 0.18, 0.1, 0.12, 0.08])
        pick = rng.choice(len(palette), n, p=weights / weights.sum())
        tone = palette[pick] * rng.uniform(0.95, 1.04, (n, 1)).astype(np.float32)
        rr = rng.uniform(8, 20, n).astype(np.float32)[idx]  # edge rounding radius, px
        depth = rng.uniform(0.06, 0.12, n).astype(np.float32)[idx]  # joint depth, m
        ero_amp = rng.uniform(3, 12, n).astype(np.float32)[idx]
        top_d = RH - yl
        top_boost = 1.0 + 1.5 * (1.0 - smoothstep(0.0, 22.0, top_d))  # the exposed top arris weathers most
        ero = np.maximum(0.0, self.n_ero[sl] - 0.5) * 2.0
        de = d - ero_amp * ero * top_boost
        # Broken corners: a bite out of one corner of some blocks.
        x = np.arange(TEX, dtype=np.float32)[None, :]
        left_d = np.abs(((x + self._last_off) % TEX) - self._last_left)
        corner_r = (rng.uniform(14, 40, n) * (rng.random(n) < 0.3)).astype(np.float32)[idx]
        top_side = (rng.random(n) < 0.7).astype(np.float32)[idx]
        cy = np.where(top_side > 0.5, RH - yl, yl)
        cx = np.minimum(left_d, self._last_w - left_d)
        bite = corner_r - np.sqrt(cx ** 2 + cy ** 2) + 6 * (self.n_ero[sl] - 0.5)
        de = np.minimum(de, np.maximum(-bite, -50.0) + np.where(bite > 0, 0.0, 1e3))
        gap = 1.2
        s = np.clip((de - gap) / rr, 0.0, 1.0)
        prof = 1.0 - (1.0 - s) ** 2
        h = depth * (prof - 1.0)
        h += (0.010 * (self.n_fine[sl] - 0.5) + 0.018 * (self.n_mid[sl] - 0.5)) * prof
        h -= 0.008 * self.pits[sl] * prof
        joint = 1.0 - smoothstep(gap - 0.8, gap + 0.8, de)
        h = h * (1 - joint) + (-depth - 0.02) * joint
        mottle = 0.92 + 0.14 * self.n_mid[sl] + 0.06 * (self.n_fine[sl] - 0.5)
        col = tone[idx] * mottle[..., None]
        col *= (0.95 + 0.08 * self.n_band[sl])[..., None]
        crust = smoothstep(0.6, 0.8, self.n_low[sl])[..., None] * 0.18
        col = col * (1 - crust) + col * np.array([0.82, 0.74, 0.66], np.float32) * crust
        fresh = (smoothstep(0.0, 5.0, d - de) * (1 - joint))[..., None]  # eroded bites show paler stone
        col = col * (1 - 0.35 * fresh) + np.array([0.9, 0.83, 0.71], np.float32) * 0.35 * fresh
        col *= (0.9 + 0.1 * np.clip(yl / (RH * 0.3), 0, 1))[..., None]
        # Vertical joints read weaker than the course lines (as on the real core masonry).
        wv = np.where(self._dv < self._dh, 0.55, 1.0).astype(np.float32)
        col *= (1.0 - wv * 0.36 * (1.0 - prof))[..., None]
        col *= (1 - 0.3 * self.pits[sl] * prof)[..., None]
        dark = np.array(SAND_SRGB, np.float32) * (0.5 + 0.1 * self.n_grain[sl])[..., None]
        jw = (joint * wv)[..., None]
        col = col * (1 - jw) + dark * jw
        col *= (0.97 + 0.06 * self.n_grain[sl])[..., None]
        self.col[sl] = col
        self.height[sl] = h
        self.rough[sl] = 0.86 + 0.06 * self.n_mid[sl] - 0.04 * fresh[..., 0] + 0.06 * joint

    def tread_row(self, r):
        """Ledge tops seen from above: arris at the top of the row, sand toward the back."""
        rng = self.rng
        sl = self.rows(r)
        idx, n, d, yl = self._blocks(r, 0.9, 2.5, jitter_x=8.0, jitter_y=4.0)
        tone = np.array((0.84, 0.72, 0.56), np.float32) * rng.uniform(0.88, 1.05, (n, 1)).astype(np.float32)
        rr = rng.uniform(8, 22, n).astype(np.float32)[idx]
        ero = np.maximum(0.0, self.n_ero[sl] - 0.42) * 2.2
        de = d - 14 * ero
        s = np.clip((de - 2.0) / rr, 0.0, 1.0)
        prof = 1.0 - (1.0 - s) ** 2
        h = 0.07 * (prof - 1.0) + 0.015 * (self.n_fine[sl] - 0.5) * prof
        col = tone[idx] * (0.88 + 0.24 * self.n_mid[sl])[..., None] * (0.66 + 0.34 * prof)[..., None]
        # Sand drifts against the back of the ledge (low y) and in every hollow.
        v = yl / RH
        drift = 1.0 - smoothstep(0.1, 0.42, v + 0.3 * (self.n_mid[sl] - 0.5) + 0.15 * (self.n_low[sl] - 0.5))
        hollow = 1.0 - smoothstep(0.0, 0.3, prof)
        sand_amt = np.clip(np.maximum(drift, hollow * 0.9), 0, 1)
        sand_h = -0.03 + 0.03 * drift + 0.004 * (self.n_fine[sl] - 0.5)
        h = np.where(sand_amt > 0.5, np.maximum(h, sand_h), h)
        sand = np.array(SAND_SRGB, np.float32) * (0.92 + 0.12 * self.n_grain[sl] + 0.08 * self.n_mid[sl])[..., None]
        col = col * (1 - sand_amt[..., None]) + sand * sand_amt[..., None]
        self.col[sl] = col
        self.height[sl] = h
        self.rough[sl] = 0.88 + 0.08 * sand_amt

    def casing_row(self, r):
        """Fine dressed casing: big pale slabs, hairline joints, weathered surface."""
        rng = self.rng
        sl = self.rows(r)
        idx, n, d, yl = self._blocks(r, 1.4, 3.2, jitter_x=1.5, jitter_y=0.8, first_w=MONO_M, off=0.0, gap_scale=0.0)
        tone = np.array((0.87, 0.77, 0.61), np.float32) * rng.uniform(0.94, 1.03, (n, 1)).astype(np.float32)
        de = d - 10 * np.maximum(0.0, self.n_ero[sl] - 0.62) * 3
        s = np.clip((de - 0.8) / 5.0, 0.0, 1.0)
        prof = 1.0 - (1.0 - s) ** 2
        h = 0.02 * (prof - 1.0) + 0.004 * (self.n_fine[sl] - 0.5)
        pits = self.pits[sl] * 0.7
        h -= 0.004 * pits
        col = tone[idx] * (0.9 + 0.16 * self.n_mid[sl])[..., None]
        stain = smoothstep(0.5, 0.8, self.n_low[sl])[..., None] * 0.3
        col = col * (1 - stain) + col * np.array([0.92, 0.78, 0.6], np.float32) * stain
        col *= (1 - 0.25 * pits)[..., None] * (0.82 + 0.18 * prof)[..., None]
        col *= (0.96 + 0.06 * self.n_band[sl])[..., None]
        self.col[sl] = col
        self.height[sl] = h
        self.rough[sl] = 0.7 + 0.08 * self.n_mid[sl] + 0.1 * (1 - prof)

    def rubble_row(self, r):
        """Broken stone chips and small blocks bedded in sand (Voronoi cells)."""
        rng = self.rng
        sl = self.rows(r)
        cell = 38.0
        gx, gy = int(TEX / cell), max(1, int(RH / cell))
        cw, ch = TEX / gx, RH / gy
        pts = rng.random((gy, gx, 2)).astype(np.float32)
        tone = (np.array((0.84, 0.72, 0.56), np.float32) * rng.uniform(0.82, 1.08, (gy, gx, 1))).astype(np.float32)
        hgt = rng.uniform(0.04, 0.16, (gy, gx)).astype(np.float32)
        x = np.arange(TEX, dtype=np.float32)[None, :] + 0.5
        y = np.arange(RH, dtype=np.float32)[:, None] + 0.5
        cxi = np.floor(x / cw).astype(np.int64)
        cyi = np.floor(y / ch).astype(np.int64)
        f1 = np.full((RH, TEX), 1e9, np.float32)
        f2 = np.full((RH, TEX), 1e9, np.float32)
        best = np.zeros((RH, TEX, 2), np.int64)
        for oy in (-1, 0, 1):
            for ox in (-1, 0, 1):
                ny_raw = cyi + oy
                valid = (ny_raw >= 0) & (ny_raw < gy)
                ny = np.clip(ny_raw, 0, gy - 1)
                nx = (cxi + ox) % gx
                px = (nx + pts[ny, nx, 0]) * cw
                py = (ny + pts[ny, nx, 1]) * ch
                ddx = np.abs(x - px)
                ddx = np.minimum(ddx, TEX - ddx)
                dist = np.where(valid, np.sqrt(ddx ** 2 + (y - py) ** 2), 1e9)
                closer = dist < f1
                f2 = np.where(closer, f1, np.minimum(f2, dist))
                f1 = np.where(closer, dist, f1)
                best[..., 0] = np.where(closer, ny, best[..., 0])
                best[..., 1] = np.where(closer, nx, best[..., 1])
        edge = f2 - f1
        stone = smoothstep(1.0, 5.0, edge - 5 * (self.n_ero[sl] - 0.5))
        bh = hgt[best[..., 0], best[..., 1]]
        h = bh * np.sqrt(stone) - 0.1 + 0.01 * (self.n_fine[sl] - 0.5)
        col = tone[best[..., 0], best[..., 1]] * (0.88 + 0.2 * self.n_mid[sl])[..., None] * (0.62 + 0.38 * stone)[..., None]
        sand = np.array(SAND_SRGB, np.float32) * (0.85 + 0.15 * self.n_grain[sl])[..., None]
        cover = (1 - stone)[..., None]
        col = col * (1 - cover) + sand * cover
        self.col[sl] = col
        self.height[sl] = h
        self.rough[sl] = 0.9 + 0.05 * (1 - stone)

    def build(self):
        for r in RISER_ROWS:
            self.riser_row(r)
        self.rubble_row(RUBBLE_ROW)
        self.casing_row(CASING_ROW)
        for r in TREAD_ROWS:
            self.tread_row(r)

    def normal_map(self):
        h = self.height
        px = 1.0 / PXM
        gx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) / (2 * px)
        gy = np.zeros_like(h)
        gy[1:-1] = (h[2:] - h[:-2]) / (2 * px)
        nrm = np.stack([-gx, -gy, np.ones_like(h)], axis=-1)
        nrm /= np.linalg.norm(nrm, axis=-1, keepdims=True)
        return nrm


def _downsample(a):
    return 0.25 * (a[0::2, 0::2] + a[1::2, 0::2] + a[0::2, 1::2] + a[1::2, 1::2])


def save_image(name, rgb, path, non_color=False, quality=92):
    h, w = rgb.shape[:2]
    img = bpy.data.images.get(name) or bpy.data.images.new(name, w, h, alpha=False)
    if non_color:
        img.colorspace_settings.name = "Non-Color"
    px = np.ones((h, w, 4), np.float32)
    px[..., :3] = np.clip(rgb, 0.0, 1.0)
    img.pixels.foreach_set(px.ravel())
    common.ensure_dir(os.path.dirname(path))
    img.filepath_raw = path
    img.file_format = "WEBP"
    img.save(filepath=path, quality=quality)
    img.filepath = path
    return img


def build_textures():
    atlas = Atlas()
    atlas.build()
    nrm = atlas.normal_map()
    nrm_small = _downsample(nrm)
    nrm_small /= np.linalg.norm(nrm_small, axis=-1, keepdims=True)
    images = {
        "color": save_image("pyramidStone_color", atlas.col, os.path.join(TEX_DIR, "pyramids_color.webp"), quality=90),
        "normal": save_image("pyramidStone_normal", nrm_small * 0.5 + 0.5, os.path.join(TEX_DIR, "pyramids_normal.webp"), non_color=True, quality=90),
        "rough": save_image("pyramidStone_rough", np.repeat(_downsample(atlas.rough)[..., None], 3, axis=-1), os.path.join(TEX_DIR, "pyramids_roughness.webp"), non_color=True, quality=85),
    }
    return images


# --- Materials -----------------------------------------------------------------------------

MATS = {}
STONE, SAND = 0, 1


def srgb_to_linear(c):
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c)


def _vertex_multiply(nt, color_socket_or_value, target):
    """Base colour = (texture or constant) x vertex colour: the glTF exporter keeps both."""
    vc = nt.nodes.new("ShaderNodeVertexColor")
    vc.layer_name = "Col"
    mix = nt.nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    mix.blend_type = "MULTIPLY"
    mix.inputs["Factor"].default_value = 1.0
    if isinstance(color_socket_or_value, tuple):
        mix.inputs["A"].default_value = (*color_socket_or_value, 1.0)
    else:
        nt.links.new(color_socket_or_value, mix.inputs["A"])
    nt.links.new(vc.outputs["Color"], mix.inputs["B"])
    nt.links.new(mix.outputs["Result"], target)


def setup_materials(images):
    mat = bpy.data.materials.new("pyramidStone")
    mat.use_nodes = True
    mat.use_backface_culling = True
    nt = mat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    texs = {}
    for key in ("color", "normal", "rough"):
        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = images[key]
        texs[key] = node
    _vertex_multiply(nt, texs["color"].outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(texs["rough"].outputs["Color"], bsdf.inputs["Roughness"])
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(texs["normal"].outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    bsdf.inputs["Metallic"].default_value = 0.0
    MATS["pyramidStone"] = mat

    sand = bpy.data.materials.new("pyramidSand")
    sand.use_nodes = True
    sand.use_backface_culling = True
    nt = sand.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    _vertex_multiply(nt, srgb_to_linear(SAND_SRGB), bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.95
    bsdf.inputs["Metallic"].default_value = 0.0
    MATS["pyramidSand"] = sand


# --- Mesh building -------------------------------------------------------------------------

TAU = math.tau
N4 = ((1.0, 0.0), (0.0, 1.0), (-1.0, 0.0), (0.0, -1.0))
T4 = ((0.0, 1.0), (-1.0, 0.0), (0.0, -1.0), (1.0, 0.0))
EPS = 0.03  # half-gap between the two vertices of a sharp notch wall


def lerp(a, b, t):
    return a + (b - a) * t


def sstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3.0 - 2.0 * t)


def nz(x, y=0.0, z=0.0):
    """mathutils Perlin noise, roughly -1..1."""
    return noise.noise(Vector((x, y, z)))


def ccw(p, q, r):
    return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])


def poisson(rng, lam):
    limit, k, p = math.exp(-lam), 0, 1.0
    while True:
        p *= rng.random()
        if p <= limit:
            return k
        k += 1


class MeshBuilder:
    """Faces with per-corner UVs and vertex colours; material 0 = stone, 1 = sand."""

    def __init__(self):
        self.verts, self.faces, self.uvs, self.cols, self.mats, self.smooth = [], [], [], [], [], []

    def vert(self, co):
        self.verts.append(co)
        return len(self.verts) - 1

    def face(self, idx, uvs, cols, mat=STONE, smooth=False):
        self.faces.append(tuple(idx))
        self.uvs.extend(uvs)
        self.cols.extend(cols)
        self.mats.append(mat)
        self.smooth.append(smooth)

    def translate(self, start, offset):
        dx, dy, dz = offset
        for i in range(start, len(self.verts)):
            x, y, z = self.verts[i]
            self.verts[i] = (x + dx, y + dy, z + dz)

    def tris(self):
        return sum(len(f) - 2 for f in self.faces)

    def to_object(self, name, location=(0.0, 0.0, 0.0)):
        me = bpy.data.meshes.new(name)
        me.from_pydata(self.verts, [], self.faces)
        uv = me.uv_layers.new(name="UVMap")
        uv.data.foreach_set("uv", np.asarray(self.uvs, np.float32).ravel())
        attr = me.color_attributes.new("Col", "BYTE_COLOR", "CORNER")
        cols = np.ones((len(self.cols), 4), np.float32)
        cols[:, :3] = np.clip(np.asarray(self.cols, np.float32), 0.0, 1.0)
        attr.data.foreach_set("color", cols.ravel())
        me.color_attributes.active_color = attr
        me.materials.append(MATS["pyramidStone"])
        me.materials.append(MATS["pyramidSand"])
        me.polygons.foreach_set("material_index", np.asarray(self.mats, np.int32))
        me.polygons.foreach_set("use_smooth", np.asarray(self.smooth, bool))
        me.validate(clean_customdata=False)
        me.update()
        obj = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = location
        return obj


def side_of(theta, ax, ay):
    c, s = math.cos(theta), math.sin(theta)
    if abs(c) * ay >= abs(s) * ax:
        return 0 if c >= 0 else 2
    return 1 if s >= 0 else 3


def rect_hit(theta, ax, ay):
    """(side, tangential coordinate s, cos of the angle to the side normal) for the ray at theta."""
    side = side_of(theta, ax, ay)
    c, s = math.cos(theta), math.sin(theta)
    nx, ny = N4[side]
    tx, ty = T4[side]
    cphi = max(1e-6, c * nx + s * ny)
    t = (ax if side % 2 == 0 else ay) / cphi
    return side, t * (c * tx + s * ty), cphi


def rr_radius(theta, ax, ay, radii):
    """Distance from the centre to a rounded rectangle (corner radius per quadrant) along theta."""
    c_, s_ = math.cos(theta), math.sin(theta)
    dx, dy = abs(c_), abs(s_)
    q = (0 if c_ >= 0 else 1) if s_ >= 0 else (2 if c_ < 0 else 3)
    rad = min(radii[q], ax * 0.95, ay * 0.95)
    ix, iy = ax - rad, ay - rad
    if dx > 1e-12:
        t = ax / dx
        if t * dy <= iy + 1e-9:
            return t
    if dy > 1e-12:
        t = ay / dy
        if t * dx <= ix + 1e-9:
            return t
    b = dx * ix + dy * iy
    return b + math.sqrt(max(0.0, b * b - (ix * ix + iy * iy) + rad * rad))


class Loop:
    """A star-shaped course footprint: vertices sorted by angle."""

    def __init__(self, th, r, fresh):
        self.th, self.r, self.fresh = th, r, fresh
        self.n = len(th)
        self.pts = [(ri * math.cos(t), ri * math.sin(t)) for t, ri in zip(th, r)]

    def radius_at(self, theta):
        i = bisect_right(self.th, theta) - 1
        if i < 0:
            i = self.n - 1
        j = (i + 1) % self.n
        px, py = self.pts[i]
        qx, qy = self.pts[j]
        dx, dy = math.cos(theta), math.sin(theta)
        ex, ey = qx - px, qy - py
        den = dx * ey - dy * ex
        if abs(den) < 1e-12:
            return min(self.r[i], self.r[j])
        return (px * ey - py * ex) / den


def _next_angle(loop, i):
    return loop.th[i + 1] if i + 1 < loop.n else loop.th[0] + TAU


def zipper(outer, inner):
    """Triangulates the ledge between two nested loops; corners are (is_outer, index)."""
    n, m = outer.n, inner.n
    i = j = 0
    tris = []
    while i < n or j < m:
        o0, o1 = outer.pts[i % n], outer.pts[(i + 1) % n]
        i0, i1 = inner.pts[j % m], inner.pts[(j + 1) % m]
        ok_o = i < n and ccw(o0, o1, i0) > 1e-10
        ok_i = j < m and ccw(o0, i1, i0) > 1e-10
        if ok_o and ok_i:
            adv_outer = _next_angle(outer, i) <= _next_angle(inner, j)
        elif ok_o or ok_i:
            adv_outer = ok_o
        else:
            adv_outer = j >= m or (i < n and _next_angle(outer, i) <= _next_angle(inner, j))
        if adv_outer:
            if ok_o:
                tris.append(((True, i % n), (True, (i + 1) % n), (False, j % m)))
            i += 1
        else:
            if ok_i:
                tris.append(((True, i % n), (False, (j + 1) % m), (False, j % m)))
            j += 1
    return tris


# --- Stepped masonry -----------------------------------------------------------------------


class Stepped:
    """A stepped masonry mass (pyramid core, mastaba) built course by course.

    ax0, ay0: half sizes of the ideal outline at z = 0; slope: face angle (the outer arris of every
    course lies on the ideal face plane); top_z: where the remaining masonry stops.
    """

    MARGIN = 0.14  # narrowest ledge left between two courses

    def __init__(self, ax0, ay0, slope_deg, top_z, seed, h_bottom, h_top, *, corner=(1.5, 5.0), notch_rate=1.0,
                 sp_mid=6.0, sp_corner=1.2, corner_zone=7.0, undulate=0.2, jitter=0.05, craters=(), damage=None,
                 bottom=-2.0, ragged=(4.0, 2.0), shade_low=24.0, notch_depth=(0.25, 0.85), deep_notch=0.15,
                 fixed_notches=(), margin=0.14, corner_notch=(0.45, 0.8, 3.8), corner_jitter=0.8, cluster=0.5):
        self.MARGIN = margin
        self.corner_notch = corner_notch
        self.corner_jitter = corner_jitter
        self.cluster = cluster
        self.ax0, self.ay0 = ax0, ay0
        self.tan = math.tan(math.radians(slope_deg))
        self.top_z = top_z
        self.seed = seed
        self.rng = random.Random(seed)
        self.corner = corner
        self.notch_rate = notch_rate
        self.sp_mid, self.sp_corner, self.corner_zone = sp_mid, sp_corner, corner_zone
        self.undulate, self.jitter = undulate, jitter
        self.craters = list(craters)
        self.damage = damage
        self.ragged = ragged
        self.shade_low = shade_low
        self.notch_depth = notch_depth
        self.deep_notch = deep_notch
        self.fixed_notches = list(fixed_notches)  # (side, s1, s2, depth, z_max)
        self.th0 = math.atan2(-ay0, ax0)
        self.courses = self._courses(h_bottom, h_top, bottom)
        self.specs = [self._spec(k, z0, z1) for k, (z0, z1) in enumerate(self.courses)]
        self.loops = []
        below = None
        for spec in self.specs:
            loop = self._loop(spec, below)
            mean_r = sum(loop.r) / loop.n
            if below is not None and mean_r < max(2.5, 0.3 * min(spec["ax"], spec["ay"]) + 1.5):
                break  # what is left of the summit is too small to stand as a course
            below = loop
            self.loops.append(loop)
        self.specs = self.specs[:len(self.loops)]
        self.courses = self.courses[:len(self.loops)]

    # Courses ------------------------------------------------------------------------------

    def _courses(self, h_bottom, h_top, bottom):
        rng = self.rng
        zs, z = [], 0.0
        while True:
            h = lerp(h_bottom, h_top, min(1.0, z / self.top_z)) * rng.uniform(0.88, 1.12)
            if rng.random() < 0.04:
                h *= 1.35  # an occasional thick course
            if z + h > self.top_z + 0.3 * h:
                break
            z += h
            zs.append(z)
        out, prev = [], bottom
        for z1 in zs:
            out.append((prev, z1))
            prev = z1
        return out

    def _spec(self, k, z0, z1):
        rng = self.rng
        ax = self.ax0 - z1 / self.tan
        ay = self.ay0 - z1 / self.tan
        zf = z1 / self.top_z
        radii = []
        for q in range(4):
            base = lerp(self.corner[0], self.corner[1], 0.5 + 0.5 * nz(k * 0.09, q * 7.31, self.seed * 0.37))
            if rng.random() < 0.1:
                base *= rng.uniform(1.4, 2.2)  # a deeper bite out of the worn corner
            base += rng.gauss(0.0, self.corner_jitter)
            radii.append(min(max(0.2, base), 0.42 * min(ax, ay)))
        notches = []
        for side in range(4):
            half = ay if side % 2 == 0 else ax
            lam = self.notch_rate * (2 * half / 45.0) * (1.4 - 0.8 * zf) * 2.5
            for _ in range(poisson(rng, lam)):
                w = rng.uniform(1.0, 5.5)
                sc = rng.uniform(-half + 1.5, half - 1.5)
                # Damage clusters in patches instead of an even sprinkle of holes.
                patch = sstep(0.0, 0.6, 0.5 + 0.5 * nz(sc / 26.0 + side * 11.7, z1 / 14.0, self.seed * 0.71) + self.cluster - 0.5)
                if rng.random() > patch * 0.45:
                    continue
                if rng.random() < self.deep_notch:
                    depth = rng.uniform(1.0, 1.8)
                else:
                    depth = rng.uniform(*self.notch_depth)
                notches.append((side, sc - w / 2, sc + w / 2, depth))
        # Damage zones (quarried / collapsed patches): many missing blocks of varied depth.
        for sd, sc, zc, rs, rzc, depth in self.craters:
            dz = (z1 - zc) / rzc
            if abs(dz) >= 1.0:
                continue
            span = rs * 1.35
            pos = sc - span + rng.uniform(-1.0, 1.0)
            while pos < sc + span:
                w = rng.uniform(1.5, 5.5)
                q = 1.0 - ((pos + w / 2 - sc) / rs) ** 2 - dz * dz
                # Noise breaks the outline so a zone never reads as a neat ellipse of holes.
                qn = q + 0.55 * nz((pos + w / 2) * 0.09 + sd * 5.3, z1 * 0.11, self.seed * 0.13)
                if qn > 0.05 and rng.random() < 0.75:
                    notches.append((sd, pos, pos + w, 0.3 + depth * min(1.0, qn) ** 0.5 * rng.uniform(0.3, 1.0)))
                pos += w + rng.uniform(0.0, 1.4)
        # Missing corner blocks: the worn hips are broken back unevenly, course by course.
        p_corner, w_lo, w_hi = self.corner_notch
        for q in range(4):
            if rng.random() < p_corner:
                side_a, side_b = q, (q + 1) % 4
                half_a = ay if side_a % 2 == 0 else ax
                half_b = ay if side_b % 2 == 0 else ax
                wa, wb = rng.uniform(w_lo, w_hi), rng.uniform(w_lo, w_hi)
                notches.append((side_a, half_a - wa, half_a + 9.0, wb))
                notches.append((side_b, -half_b - 9.0, -half_b + wb, wa))
        for side, s1, s2, depth, zmax in self.fixed_notches:
            if z0 < zmax:
                notches.append((side, s1, s2, depth))
        u0, acc = [], 0.0
        for side in range(4):
            u0.append(acc)
            acc += 2 * (ay if side % 2 == 0 else ax)
        rows = RISER_ROWS
        return {
            "k": k, "z0": z0, "z1": z1, "ax": ax, "ay": ay, "radii": radii, "notches": notches,
            "row": rows[(k * 5 + rng.randrange(len(rows))) % len(rows)],
            "trow": rng.choice(TREAD_ROWS), "uoff": rng.uniform(0.0, TILE_M), "u0": u0,
            "tone": rng.uniform(0.95, 1.02),
        }

    def norm(self, t):
        return self.th0 + ((t - self.th0) % TAU)

    def _inset(self, spec, side, s, theta):
        z, seed = spec["z1"], self.seed
        v = self.undulate * nz(s / 32.0 + side * 17.3, z / 18.0, seed * 1.7)
        v += self.jitter * 1.8 * nz(theta * 157.0, z * 1.31, seed * 0.29)
        fresh = 0.0
        deepest = 0.0
        for sd, s1, s2, depth in spec["notches"]:
            if sd == side and s1 < s < s2:
                deepest = max(deepest, depth)
        if deepest:
            v += deepest
            fresh = min(1.0, deepest / 0.6)
        if self.damage is not None:
            ax, ay = spec["ax"], spec["ay"]
            nx, ny = N4[side]
            tx, ty = T4[side]
            dd = (ax if side % 2 == 0 else ay)
            d = self.damage(nx * dd + tx * s, ny * dd + ty * s, z, theta)
            if d > 0:
                v += d
                fresh = max(fresh, min(1.0, d / 1.2))
        band, amp = self.ragged
        if z > self.top_z - band:
            f = (z - (self.top_z - band)) / band
            v += f * amp * (0.6 + 0.8 * (0.5 + 0.5 * nz(math.cos(theta) * 2.3, math.sin(theta) * 2.3, z * 0.4 + seed)))
        return v, fresh

    def _nominal(self, spec, theta):
        ax, ay = spec["ax"], spec["ay"]
        side, s, cphi = rect_hit(theta, ax, ay)
        r0 = rr_radius(theta, ax, ay, spec["radii"])
        ins, fresh = self._inset(spec, side, s, theta)
        return r0 - ins / max(0.7, cphi), fresh

    def _thetas(self, spec):
        rng = self.rng
        ax, ay = spec["ax"], spec["ay"]
        out = []
        for side in range(4):
            half = ay if side % 2 == 0 else ax
            dist = ax if side % 2 == 0 else ay
            pos, s = [], -half
            while s < half - 1e-6:
                pos.append(s)
                sp = lerp(self.sp_corner, self.sp_mid, sstep(0.0, self.corner_zone, half - abs(s)))
                s += sp * rng.uniform(0.75, 1.25)
            for sd, s1, s2, _ in spec["notches"]:
                if sd == side:
                    pos.extend(e for e in (s1 - EPS, s1 + EPS, s2 - EPS, s2 + EPS) if -half < e < half)
            nx, ny = N4[side]
            tx, ty = T4[side]
            out.extend(math.atan2(ny * dist + ty * p, nx * dist + tx * p) for p in pos)
        return out

    def _loop(self, spec, below):
        ths = [self.norm(t) for t in self._thetas(spec)]
        if below is not None:
            # Copy the angles of the course below wherever this one would overhang it, so cut-backs
            # (missing blocks, worn corners) carry up with crisp walls.
            for t in below.th:
                if self._nominal(spec, t)[0] > below.radius_at(t) - self.MARGIN:
                    ths.append(t)
        ths.sort()
        clean = []
        for t in ths:
            if not clean or t - clean[-1] > 1e-7:
                clean.append(t)
        rs, fr = [], []
        for t in clean:
            r, f = self._nominal(spec, t)
            if below is not None:
                rb = below.radius_at(t) - self.MARGIN
                if r > rb:
                    f = max(f, min(1.0, (r - rb) / 0.8))
                    r = rb
            rs.append(max(0.4, r))
            fr.append(f)
        return Loop(clean, rs, fr)

    # Output -------------------------------------------------------------------------------

    @staticmethod
    def shade_fn(seed, low_m):
        dummy = Stepped.__new__(Stepped)
        dummy.seed, dummy.shade_low = seed, low_m
        return dummy.shade

    def shade(self, x, y, z, fresh, ao, tone=1.0):
        seed = self.seed
        b = 0.86 + 0.1 * nz(x / 70.0, y / 70.0, z / 30.0 + seed) + 0.05 * nz(x / 16.0, y / 16.0, z / 7.0 + seed * 2.0)
        b += 0.035 * nz(x / 5.0, y / 5.0, z / 2.5 + seed * 3.0)
        low = sstep(0.0, self.shade_low, z)
        b *= (0.82 + 0.18 * low) * tone
        b = lerp(b, 1.0, 0.7 * fresh) * ao
        return (b, b * (0.965 + 0.035 * low), b * (0.9 + 0.1 * low))

    def emit(self, mb, cap=True):
        rings = []
        for spec, loop in zip(self.specs, self.loops):
            bot = [mb.vert((x, y, spec["z0"])) for x, y in loop.pts]
            top = [mb.vert((x, y, spec["z1"])) for x, y in loop.pts]
            rings.append((bot, top))
        for k, (spec, loop) in enumerate(zip(self.specs, self.loops)):
            self._riser(mb, spec, loop, *rings[k])
            if k + 1 < len(self.loops):
                self._tread(mb, spec, loop, self.loops[k + 1], rings[k][1], rings[k + 1][0])
            elif cap:
                self._cap(mb, spec, loop, rings[k][1])

    def _riser(self, mb, spec, loop, bot, top):
        z0, z1 = spec["z0"], spec["z1"]
        zb = max(z0, 0.0) if spec["k"] == 0 else z0
        row, uoff, u0s, tone = spec["row"], spec["uoff"], spec["u0"], spec["tone"]
        ax, ay = spec["ax"], spec["ay"]

        def v_of(z):
            return (row + 0.004 + 0.992 * (z - zb) / (z1 - zb)) / ROWS

        v0, v1 = v_of(z0), v_of(z1)
        n = loop.n
        for i in range(n):
            j = (i + 1) % n
            px, py = loop.pts[i]
            qx, qy = loop.pts[j]
            el = math.hypot(qx - px, qy - py)
            if el < 1e-4:
                continue
            side = side_of(math.atan2(py + qy, px + qx), ax, ay)
            tx, ty = T4[side]
            ua = (px * tx + py * ty + u0s[side] + uoff) / TILE_M
            ub = ua + el / TILE_M
            fi, fj = loop.fresh[i], loop.fresh[j]
            mb.face(
                (bot[i], bot[j], top[j], top[i]),
                ((ua, v0), (ub, v0), (ub, v1), (ua, v1)),
                (self.shade(px, py, z0, fi, 0.7, tone), self.shade(qx, qy, z0, fj, 0.7, tone),
                 self.shade(qx, qy, z1, fj, 1.0, tone), self.shade(px, py, z1, fi, 1.0, tone)),
            )

    def _tread(self, mb, spec, outer, inner, ring_o, ring_i):
        z1 = spec["z1"]
        trow, uoff, u0s, tone = spec["trow"], spec["uoff"], spec["u0"], spec["tone"]
        ax, ay = spec["ax"], spec["ay"]
        depth = [min(1.05, max(0.03, outer.radius_at(t) - r)) for t, r in zip(inner.th, inner.r)]
        for tri in zipper(outer, inner):
            pts = [outer.pts[ix] if o else inner.pts[ix] for o, ix in tri]
            side = side_of(math.atan2(sum(p[1] for p in pts), sum(p[0] for p in pts)), ax, ay)
            tx, ty = T4[side]
            idx, uvs, cols = [], [], []
            for (o, ix), (x, y) in zip(tri, pts):
                u = (x * tx + y * ty + u0s[side] + uoff) / TILE_M
                if o:
                    idx.append(ring_o[ix])
                    uvs.append((u, (trow + 0.996) / ROWS))
                    cols.append(self.shade(x, y, z1, outer.fresh[ix], 1.0, tone))
                else:
                    idx.append(ring_i[ix])
                    uvs.append((u, (trow + 0.996 - 0.992 * depth[ix] / ROW_M) / ROWS))
                    cols.append(self.shade(x, y, z1, inner.fresh[ix], 0.72, tone))
            mb.face(idx, uvs, cols)

    def _cap(self, mb, spec, loop, ring):
        z1 = spec["z1"]
        c = mb.vert((0.0, 0.0, z1))
        for i in range(loop.n):
            j = (i + 1) % loop.n
            pts = (loop.pts[i], loop.pts[j], (0.0, 0.0))
            uvs = [(0.3 + x / TILE_M, 6.0 / ROWS + 0.6 * y / TILE_M) for x, y in pts]
            cols = [self.shade(x, y, z1, 0.3, 0.9) for x, y in pts]
            mb.face((ring[i], ring[j], c), uvs, cols)


# --- Sand, rubble, debris, casing ----------------------------------------------------------


class Apron:
    """Sand drifted against the base: rises inside the masonry, tapers out below the dunes."""

    TS = (0.0, 0.04, 0.09, 0.15, 0.22, 0.31, 0.42, 0.55, 0.7, 0.85, 1.0)

    def __init__(self, ax, ay, tan_slope, seed, depth=(2.0, 6.0), spread=(14.0, 34.0), wind=0.6, n=160,
                 inner_round=12.0, outer_round=30.0, lump=0.7):
        self.n, self.seed, self.lump = n, seed, lump
        self.th = [i / n * TAU for i in range(n)]
        self.zin, self.rin, self.rout = [], [], []
        for t in self.th:
            w = 0.5 + 0.5 * math.cos(t - wind)
            zin = lerp(depth[0], depth[1], w) * (1.0 + 0.35 * nz(math.cos(t) * 1.3, math.sin(t) * 1.3, seed * 0.13))
            back = (zin + 1.5) / tan_slope + 1.5
            rin = rr_radius(t, ax - back, ay - back, (inner_round,) * 4)
            sp = lerp(spread[0], spread[1], w) * (1.0 + 0.3 * nz(math.cos(t) * 2.1, math.sin(t) * 2.1, seed * 0.7))
            rout = rr_radius(t, ax + sp, ay + sp, (outer_round,) * 4)
            self.zin.append(zin)
            self.rin.append(rin)
            self.rout.append(rout)

    def _z(self, k, t, theta):
        base = self.zin[k] * (1.0 - t) ** 1.7 - 1.4 * t * t
        return base + self.lump * nz(math.cos(theta) * 9.0, math.sin(theta) * 9.0, t * 3.0 + self.seed) * math.sin(math.pi * t)

    def z_at(self, theta, r):
        f = (theta % TAU) / TAU * self.n
        k0 = int(f) % self.n
        k1 = (k0 + 1) % self.n
        a = f - int(f)
        rin = lerp(self.rin[k0], self.rin[k1], a)
        rout = lerp(self.rout[k0], self.rout[k1], a)
        t = min(1.0, max(0.0, (r - rin) / max(1e-3, rout - rin)))
        return lerp(self._z(k0, t, theta), self._z(k1, t, theta), a)

    def build(self, mb, cap=False):
        grid = []
        for k, theta in enumerate(self.th):
            ring = []
            for t in self.TS:
                r = lerp(self.rin[k], self.rout[k], t)
                z = self._z(k, t, theta)
                ring.append((mb.vert((r * math.cos(theta), r * math.sin(theta), z)), t))
            grid.append(ring)

        def col(theta, t):
            b = (0.9 + 0.08 * nz(math.cos(theta) * 6.0, math.sin(theta) * 6.0, t * 2.0 + self.seed)) * lerp(0.78, 1.0, sstep(0.0, 0.45, t))
            return (b, b, b)

        for k in range(self.n):
            a, b = grid[k], grid[(k + 1) % self.n]
            ta, tb = self.th[k], self.th[(k + 1) % self.n]
            for j in range(len(self.TS) - 1):
                quad = (a[j], a[j + 1], b[j + 1], b[j])
                angs = (ta, ta, tb, tb)
                mb.face([q[0] for q in quad], [(0.0, 0.0)] * 4, [col(an, q[1]) for an, q in zip(angs, quad)], SAND, smooth=True)
        if cap:
            # Free-standing mound: close the inner ring with a gentle dome.
            top = mb.vert((0.0, 0.0, max(self.zin) * 1.1))
            for k in range(self.n):
                k1 = (k + 1) % self.n
                mb.face((grid[k][0][0], grid[k1][0][0], top), [(0.0, 0.0)] * 3,
                        [col(self.th[k], 0.0), col(self.th[k1], 0.0), (0.82, 0.82, 0.82)], SAND, smooth=True)


def rubble_block(mb, center, size, rot, rng, shade, tilt=0.3, uvrow=None, mono=False, bottom=False, jitter=0.16):
    """An irregular broken block (jittered box) with block-face UVs."""
    sx, sy, sz = size
    cosr, sinr = math.cos(rot), math.sin(rot)
    tx_, ty_ = rng.uniform(-tilt, tilt), rng.uniform(-tilt, tilt)
    corners = []
    for dz in (-0.5, 0.5):
        for dx, dy in ((-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)):
            x = (dx + rng.uniform(-jitter, jitter)) * sx
            y = (dy + rng.uniform(-jitter, jitter)) * sy
            z = (dz + rng.uniform(-jitter, jitter) * 0.9) * sz
            z += tx_ * x + ty_ * y
            corners.append((center[0] + x * cosr - y * sinr, center[1] + x * sinr + y * cosr, center[2] + z))
    ids = [mb.vert(c) for c in corners]
    faces = [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7), (4, 5, 6, 7)]
    if bottom:
        faces.append((0, 3, 2, 1))
    lo = center[2] - sz * 0.5
    for f in faces:
        p = [corners[i] for i in f]
        w = math.dist(p[0], p[1])
        if mono:
            u0 = rng.uniform(MONO_U + 0.02, max(MONO_U + 0.03, 1.0 - w / TILE_M - 0.01))
            row = CASING_ROW
        else:
            u0 = rng.random()
            row = uvrow if uvrow is not None else rng.choice(RISER_ROWS)
        u1 = u0 + w / TILE_M
        v0, v1 = (row + 0.04) / ROWS, (row + 0.96) / ROWS
        uvs = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
        cols = [shade(c[0], c[1], c[2], 0.25, lerp(0.55, 1.0, sstep(lo, lo + sz, c[2]))) for c in p]
        mb.face([ids[i] for i in f], uvs, cols)


def scatter_rubble(mb, rng, shade, ground, ax, ay, count, near=7.0, size=(0.6, 2.0), piles=5, pile_blocks=18, pile_height=3.5):
    """Fallen blocks around a base: a scatter thinning outward plus a few heaped piles."""
    for _ in range(count):
        theta = rng.uniform(0.0, TAU)
        r = rr_radius(theta, ax, ay, (6.0,) * 4) + 0.6 + rng.expovariate(1.0 / near)
        x, y = r * math.cos(theta), r * math.sin(theta)
        s = rng.uniform(*size)
        dims = (s * rng.uniform(0.8, 1.4), s * rng.uniform(0.6, 1.0), s * rng.uniform(0.45, 0.8))
        z = ground(theta, r) + dims[2] * rng.uniform(-0.15, 0.25)
        rubble_block(mb, (x, y, z), dims, rng.uniform(0, TAU), rng, shade)
    for _ in range(piles):
        theta = rng.uniform(0.0, TAU)
        r0 = rr_radius(theta, ax, ay, (6.0,) * 4) + rng.uniform(1.0, 6.0)
        cx, cy = r0 * math.cos(theta), r0 * math.sin(theta)
        rad = rng.uniform(4.0, 8.0)
        for _ in range(pile_blocks):
            a = rng.uniform(0, TAU)
            d = rad * math.sqrt(rng.random())
            x, y = cx + d * math.cos(a), cy + d * math.sin(a)
            th = math.atan2(y, x)
            s = rng.uniform(*size)
            dims = (s * rng.uniform(0.8, 1.4), s * rng.uniform(0.6, 1.0), s * rng.uniform(0.45, 0.8))
            z = ground(th, math.hypot(x, y)) + pile_height * (1.0 - d / rad) ** 1.3 * rng.uniform(0.5, 1.0)
            rubble_block(mb, (x, y, z), dims, rng.uniform(0, TAU), rng, shade, tilt=0.5)


class Debris:
    """A talus slope of broken stone against one face (rubble texture, lumpy surface)."""

    def __init__(self, half0, tan_slope, side, s0, s1, apex, reach, seed, ns=None, nw=9):
        self.side, self.s0, self.s1 = side, s0, s1
        self.half0 = half0
        self.ns = ns or max(6, int((s1 - s0) / 3.0))
        self.nw = nw
        self.pts = []
        rng = random.Random(seed)
        nx, ny = N4[side]
        tx, ty = T4[side]
        for i in range(self.ns + 1):
            s = lerp(s0, s1, i / self.ns)
            f = math.sin(math.pi * i / self.ns) ** 0.6
            a = apex * f * (0.85 + 0.3 * (0.5 + 0.5 * nz(s * 0.13, seed)))
            w_in = -(a + 1.0) / tan_slope - 1.5
            w_out = reach * (0.45 + 0.55 * f) * rng.uniform(0.9, 1.1)
            row = []
            for j in range(self.nw + 1):
                t = j / self.nw
                w = lerp(w_in, w_out, t)
                z = a * (1.0 - t) ** 1.2 - 1.0 * t * t + 0.7 * a ** 0.5 * nz(s * 0.35, t * 4.0, seed) * math.sin(math.pi * t)
                row.append((nx * (half0 + w) + tx * s, ny * (half0 + w) + ty * s, z, w))
            self.pts.append(row)

    def z_at(self, s, t):
        fi = min(self.ns - 1e-6, max(0.0, (s - self.s0) / (self.s1 - self.s0) * self.ns))
        fj = min(self.nw - 1e-6, max(0.0, t * self.nw))
        i, j = int(fi), int(fj)
        a, b = fi - i, fj - j
        p = self.pts
        z0 = lerp(p[i][j][2], p[i][j + 1][2], b)
        z1 = lerp(p[i + 1][j][2], p[i + 1][j + 1][2], b)
        w0 = lerp(p[i][j][3], p[i][j + 1][3], b)
        w1 = lerp(p[i + 1][j][3], p[i + 1][j + 1][3], b)
        return lerp(z0, z1, a), lerp(w0, w1, a)

    def build(self, mb, shade, rng, blocks=60, size=(0.5, 1.8)):
        ids = [[mb.vert(q[:3]) for q in row] for row in self.pts]
        lo_v, hi_v = (RUBBLE_ROW + 0.04) / ROWS, (RUBBLE_ROW + 0.96) / ROWS
        for i in range(self.ns):
            sa = lerp(self.s0, self.s1, i / self.ns) / TILE_M
            sb = lerp(self.s0, self.s1, (i + 1) / self.ns) / TILE_M
            for j in range(self.nw):
                q = (self.pts[i][j], self.pts[i][j + 1], self.pts[i + 1][j + 1], self.pts[i + 1][j])
                uvs = ((sa, lo_v), (sa, hi_v), (sb, hi_v), (sb, lo_v))
                cols = [shade(p[0], p[1], p[2], 0.5, lerp(0.8, 1.0, sstep(-6.0, 4.0, p[3]))) for p in q]
                mb.face((ids[i][j], ids[i][j + 1], ids[i + 1][j + 1], ids[i + 1][j]), uvs, cols)
        nx, ny = N4[self.side]
        tx, ty = T4[self.side]
        for _ in range(blocks):
            s = rng.uniform(self.s0 + 2, self.s1 - 2)
            t = rng.uniform(0.15, 0.95)
            z, w = self.z_at(s, t)
            x, y = nx * (self.half0 + w) + tx * s, ny * (self.half0 + w) + ty * s
            sz = rng.uniform(*size)
            dims = (sz * rng.uniform(0.8, 1.4), sz * rng.uniform(0.6, 1.0), sz * rng.uniform(0.45, 0.8))
            rubble_block(mb, (x, y, z + dims[2] * 0.1), dims, rng.uniform(0, TAU), rng, shade, tilt=0.5)


def casing_remnant(mb, rng, shade, half0, tan_slope, side, s_lo, s_hi, z_max, offset=0.7, depth=1.5):
    """Surviving dressed casing on one face: inclined slabs in courses, broken off in a ragged edge."""
    nx, ny = N4[side]
    tx, ty = T4[side]
    s_mid = lerp(s_lo, s_hi, rng.uniform(0.35, 0.6))

    def P(s, z, back=0.0):
        w = half0 - z / tan_slope + offset - back
        return (nx * w + tx * s, ny * w + ty * s, z)

    z = -1.2
    lo_prev, hi_prev = s_lo, s_hi
    cv0, cv1 = (CASING_ROW + 0.02) / ROWS, (CASING_ROW + 0.98) / ROWS
    while z < z_max:
        h = rng.uniform(0.9, 1.15)
        z0, z1 = z, z + h
        z = z1
        frac = max(0.0, z1) / z_max
        lo = max(lo_prev, s_lo + (s_mid - s_lo) * frac ** 1.25 + rng.uniform(-1.8, 1.8))
        hi = min(hi_prev, s_hi - (s_hi - s_mid) * frac ** 1.1 + rng.uniform(-1.8, 1.8))
        if hi - lo < 1.6:
            break
        lo_prev, hi_prev = lo, hi
        cuts = [lo]
        while cuts[-1] < hi - 1.2:
            cuts.append(min(hi, cuts[-1] + rng.uniform(1.4, 3.0)))
        cuts[-1] = hi
        blocks = list(zip(cuts[:-1], cuts[1:]))
        miss = 0.04 + 0.35 * frac ** 2
        present = [rng.random() > miss for _ in blocks]
        for bi, ((b0, b1), keep) in enumerate(zip(blocks, present)):
            if not keep:
                continue
            u0 = rng.uniform(MONO_U + 0.02, 1.0 - (b1 - b0) / TILE_M - 0.01)
            u1 = u0 + (b1 - b0) / TILE_M
            zt = z1 - rng.uniform(0.0, 0.05)
            f = [P(b0, z0), P(b1, z0), P(b1, zt), P(b0, zt)]
            mb.face([mb.vert(p) for p in f], ((u0, cv0), (u1, cv0), (u1, cv1), (u0, cv1)),
                    [shade(p[0], p[1], p[2], 0.5, ao) for p, ao in zip(f, (0.9, 0.9, 1.0, 1.0))])
            # Broken top and exposed ends show rough stone.
            top = [P(b0, zt), P(b1, zt), P(b1, zt, depth), P(b0, zt, depth)]
            row = rng.choice(RISER_ROWS)
            ru0 = rng.random()
            ru1 = ru0 + (b1 - b0) / TILE_M
            mb.face([mb.vert(p) for p in top], ((ru0, (row + 0.98) / ROWS), (ru1, (row + 0.98) / ROWS), (ru1, (row + 0.4) / ROWS), (ru0, (row + 0.4) / ROWS)),
                    [shade(p[0], p[1], p[2], 0.5, 0.95) for p in top])
            ends = []
            if bi == 0 or not present[bi - 1]:
                ends.append((P(b0, z0, depth), P(b0, z0), P(b0, zt), P(b0, zt, depth)))
            if bi == len(blocks) - 1 or not present[bi + 1]:
                ends.append((P(b1, z0), P(b1, z0, depth), P(b1, zt, depth), P(b1, zt)))
            for e in ends:
                ru0 = rng.random()
                ru1 = ru0 + depth / TILE_M
                mb.face([mb.vert(p) for p in e], ((ru0, (row + 0.04) / ROWS), (ru1, (row + 0.04) / ROWS), (ru1, (row + 0.96) / ROWS), (ru0, (row + 0.96) / ROWS)),
                        [shade(p[0], p[1], p[2], 0.4, ao) for p, ao in zip(e, (0.6, 0.6, 0.9, 0.9))])


# --- Supporting pieces ---------------------------------------------------------------------


def ring_prism(mb, shade, xf, z0, z1, r0, r1, sides, rng, jag=0.0, cap=True, u_start=0.04, row=CASING_ROW, rot=0.0):
    """A faceted drum (local z axis), transformed to world by xf(x, y, z); jag breaks the top."""
    circ = TAU * max(r0, r1)
    span = min(MONO_U - 0.06, circ / TILE_M)
    # A broken drum snaps along a slanted, slightly rough plane (not a crown of spikes).
    break_dir = rng.uniform(0.0, TAU)
    tops = [z1 - (jag * (0.5 + 0.5 * math.cos(rot + i / sides * TAU - break_dir)) + rng.uniform(0.0, 0.1 * jag) if jag else 0.0)
            for i in range(sides)]
    bot, top, wb, wt = [], [], [], []
    for i in range(sides):
        a = rot + i / sides * TAU
        pb = xf(r0 * math.cos(a), r0 * math.sin(a), z0)
        pt = xf(r1 * math.cos(a), r1 * math.sin(a), tops[i])
        wb.append(pb)
        wt.append(pt)
        bot.append(mb.vert(pb))
        top.append(mb.vert(pt))
    v0, v1 = (row + 0.03) / ROWS, (row + 0.97) / ROWS
    hgt = max(1e-3, z1 - z0)
    for i in range(sides):
        j = (i + 1) % sides
        ua, ub = u_start + span * i / sides, u_start + span * (i + 1) / sides
        vt_i = v0 + (v1 - v0) * (tops[i] - z0) / hgt
        vt_j = v0 + (v1 - v0) * (tops[j] - z0) / hgt
        mb.face((bot[i], bot[j], top[j], top[i]), ((ua, v0), (ub, v0), (ub, vt_j), (ua, vt_i)),
                (shade(*wb[i], 0.2, 0.62), shade(*wb[j], 0.2, 0.62), shade(*wt[j], 0.2, 1.0), shade(*wt[i], 0.2, 1.0)))
    if cap:
        zc = sum(tops) / sides - (0.06 * jag if jag else 0.0)
        pc = xf(0.0, 0.0, zc)
        c = mb.vert(pc)
        for i in range(sides):
            j = (i + 1) % sides
            pts = (wt[i], wt[j], pc)
            loc = ((r1 * math.cos(rot + i / sides * TAU), r1 * math.sin(rot + i / sides * TAU)),
                   (r1 * math.cos(rot + j / sides * TAU), r1 * math.sin(rot + j / sides * TAU)), (0.0, 0.0))
            uvs = [(u_start + 0.1 + lx / TILE_M, (row + 0.5) / ROWS + ly / TILE_M) for lx, ly in loc]
            mb.face((top[i], top[j], c), uvs, [shade(*p, 0.3, 0.92) for p in pts])


def translate_xf(cx, cy, cz=0.0):
    return lambda x, y, z: (cx + x, cy + y, cz + z)


def column(mb, rng, shade, cx, cy, z0, drums, broken, capital, radius=1.0, sides=16):
    """Egyptian-style faceted column: base disc, stacked drums, bell capital and abacus."""
    ring_prism(mb, shade, translate_xf(cx, cy), z0 - 0.4, z0 + 0.35, 1.4, 1.36, sides, rng, rot=0.1)
    z = z0 + 0.35
    for d in range(drums):
        h = rng.uniform(1.0, 1.25)
        r_a = radius * (1.0 - 0.05 * (z - z0) / 8.0)
        r_b = radius * (1.0 - 0.05 * (z + h - z0) / 8.0)
        ox, oy = rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04)
        last = d == drums - 1
        ring_prism(mb, shade, translate_xf(cx + ox, cy + oy), z, z + h, r_a, r_b, sides, rng,
                   jag=0.7 if (broken and last) else 0.0, rot=rng.uniform(0, TAU), u_start=rng.uniform(0.03, 0.08))
        z += h
    if not capital:
        return z
    # Bell (open papyrus) capital: a flaring lathe.
    r_top = radius * 0.95
    prof = [(0.0, r_top), (0.3, r_top * 1.07), (0.75, r_top * 1.3), (1.15, r_top * 1.5), (1.4, r_top * 1.52)]
    for (za, ra), (zb, rb) in zip(prof[:-1], prof[1:]):
        ring_prism(mb, shade, translate_xf(cx, cy), z + za, z + zb, ra, rb, sides, rng, cap=(zb == prof[-1][0]))
    z += prof[-1][0]
    rubble_block(mb, (cx, cy, z + 0.28), (2.3, 2.3, 0.56), rng.uniform(-0.04, 0.04), rng, shade, tilt=0.0, mono=True, jitter=0.02, bottom=True)
    return z + 0.56


def build_temple():
    """Weathered mastaba with a portico of columns, half buried in sand."""
    mb = MeshBuilder()
    rng = random.Random(404)

    def collapse(x, y, z, theta):
        return max(0.0, x - 5.0) * 0.5 * sstep(0.5, 4.5, z) + max(0.0, -y - 6.0) * 0.0

    mastaba = Stepped(16.0, 9.0, 80.0, 6.6, 404, 0.8, 0.72, corner=(0.25, 1.1), notch_rate=2.5, sp_mid=2.4,
                      sp_corner=0.6, corner_zone=2.5, undulate=0.06, jitter=0.03, damage=collapse, ragged=(1.6, 0.9),
                      shade_low=4.0, notch_depth=(0.15, 0.5), deep_notch=0.08, bottom=-1.5, margin=0.05,
                      fixed_notches=[(3, -1.3, 1.3, 1.6, 4.4)])
    mastaba.emit(mb)
    shade = mastaba.shade
    # Portico platform in front (towards -y) with six columns, two still carrying their architrave.
    start = len(mb.verts)
    platform = Stepped(17.5, 3.4, 50.0, 1.15, 405, 0.55, 0.55, corner=(0.1, 0.5), notch_rate=1.5, sp_mid=2.5,
                       sp_corner=0.5, corner_zone=1.5, undulate=0.03, jitter=0.02, ragged=(0.1, 0.0), bottom=-0.8,
                       shade_low=2.0, margin=0.05, notch_depth=(0.1, 0.35), deep_notch=0.0)
    platform.emit(mb)
    py = -9.0 - 5.2
    mb.translate(start, (0.0, py, 0.0))
    ztop = platform.courses[-1][1]
    plan = [(9, False, True), (9, False, True), (4, True, False), (7, False, True), (2, True, False), (1, True, False)]
    tops = []
    for i, (drums, broken, cap) in enumerate(plan):
        x = -12.5 + 5.0 * i
        drums_h = drums if not cap else 6
        tops.append(column(mb, rng, shade, x, py, ztop, drums_h, broken, cap))
    beam_z = max(tops[0], tops[1])
    rubble_block(mb, (-10.0, py, beam_z + 0.7), (8.0, 1.9, 1.4), 0.0, rng, shade, tilt=0.0, mono=True, jitter=0.015, bottom=True)
    # Fallen architrave and drums on the platform and in the sand.
    rubble_block(mb, (8.5, py - 4.2, 0.4), (7.2, 1.8, 1.3), 0.35, rng, shade, tilt=0.05, mono=True, jitter=0.03)
    for k in range(4):
        a = rng.uniform(0, TAU)
        cx, cy = 3.0 + 5.0 * k + rng.uniform(-1, 1), py - 5.5 - rng.uniform(0, 4)

        def xf(x, y, z, a=a, cx=cx, cy=cy):
            # Lying drum: local z runs horizontally along angle a.
            ca, sa = math.cos(a), math.sin(a)
            return (cx + z * ca - y * sa, cy + z * sa + y * ca, 0.55 + x)
        ring_prism(mb, shade, xf, -0.55, 0.55, 0.95, 0.95, 16, rng, rot=rng.uniform(0, 1))
    apron = Apron(16.0, 9.0, math.tan(math.radians(80.0)), 41, depth=(0.6, 2.4), spread=(9.0, 18.0), wind=2.4, n=96,
                  inner_round=2.0, outer_round=8.0, lump=0.35)
    apron.build(mb)
    scatter_rubble(mb, rng, shade, apron.z_at, 15.5, 8.5, 70, near=4.0, size=(0.35, 1.2), piles=3, pile_blocks=14, pile_height=1.8)
    return mb


def build_drums():
    """Fallen column drums and a toppled capital half sunk in the sand."""
    mb = MeshBuilder()
    rng = random.Random(505)
    shade = Stepped.shade_fn(505, 3.0)
    for k in range(6):
        a = rng.uniform(0, TAU)
        cx, cy = rng.uniform(-9, 9), rng.uniform(-6, 6)
        r = rng.uniform(0.85, 1.05)
        h = rng.uniform(0.9, 1.3)
        sink = rng.uniform(0.15, 0.45) * r

        def xf(x, y, z, a=a, cx=cx, cy=cy, r=r, sink=sink):
            ca, sa = math.cos(a), math.sin(a)
            return (cx + z * ca - y * sa, cy + z * sa + y * ca, r - sink + x)
        ring_prism(mb, shade, xf, -h / 2, h / 2, r, r, 16, rng, rot=rng.uniform(0, 1), jag=0.25 if k % 3 == 0 else 0.0)
    # Toppled capital lying on its flank.
    a = 0.6
    r_top = 0.95
    prof = [(0.0, r_top), (0.3, r_top * 1.07), (0.75, r_top * 1.3), (1.15, r_top * 1.5), (1.4, r_top * 1.52)]

    def xf_cap(x, y, z):
        ca, sa = math.cos(a), math.sin(a)
        return (4.0 + z * ca - y * sa, -9.0 + z * sa + y * ca, 1.15 + x)
    for (za, ra), (zb, rb) in zip(prof[:-1], prof[1:]):
        ring_prism(mb, shade, xf_cap, za, zb, ra, rb, 16, rng, cap=(zb == prof[-1][0]))
    apron = Apron(7.0, 5.0, 1.0, 51, depth=(0.3, 0.9), spread=(6.0, 10.0), n=48, inner_round=3.0, outer_round=6.0, lump=0.25)
    apron.build(mb, cap=True)
    for _ in range(14):
        s = rng.uniform(0.4, 1.1)
        rubble_block(mb, (rng.uniform(-11, 11), rng.uniform(-11, 9), 0.15 * s), (s * 1.2, s * 0.9, s * 0.6), rng.uniform(0, TAU), rng, shade)
    return mb


def build_rubble_pile():
    """A heap of broken blocks on a low sand mound."""
    mb = MeshBuilder()
    rng = random.Random(606)
    shade = Stepped.shade_fn(606, 3.0)
    apron = Apron(5.0, 4.0, 0.9, 61, depth=(1.5, 2.6), spread=(6.0, 10.0), n=48, inner_round=3.5, outer_round=6.0, lump=0.3)
    apron.build(mb, cap=True)
    for _ in range(85):
        a = rng.uniform(0, TAU)
        d = 7.5 * math.sqrt(rng.random())
        x, y = d * math.cos(a), d * math.sin(a) * 0.8
        s = rng.uniform(0.5, 1.7)
        dims = (s * rng.uniform(0.9, 1.5), s * rng.uniform(0.6, 1.0), s * rng.uniform(0.45, 0.8))
        z = max(apron.z_at(math.atan2(y, x), math.hypot(x, y)), 0.0) + 3.4 * (1.0 - d / 7.5) ** 1.4 * rng.uniform(0.55, 1.0)
        rubble_block(mb, (x, y, z), dims, rng.uniform(0, TAU), rng, shade, tilt=0.5)
    return mb


# --- Pyramids ------------------------------------------------------------------------------


def build_great():
    half, slope = 115.0, 51.84
    tan = math.tan(math.radians(slope))
    craters = [
        # (side, s centre, z centre, half extent along s, half extent along z, depth): quarried scars
        (3, -42.0, 22.0, 26.0, 9.0, 2.6),
        (3, 46.0, 64.0, 17.0, 7.0, 2.2),
        (3, 6.0, 96.0, 11.0, 5.0, 1.6),
        (0, 24.0, 14.0, 26.0, 8.0, 2.8),
        (2, -30.0, 40.0, 18.0, 9.0, 2.6),
        (2, 38.0, 88.0, 11.0, 5.0, 1.6),
        (1, 8.0, 20.0, 10.0, 14.0, 4.5),
        (1, -50.0, 52.0, 14.0, 7.0, 2.2),
    ]
    st = Stepped(half, half, slope, 138.0, 101, 1.6, 0.98, corner=(1.2, 5.5), notch_rate=0.55, sp_mid=9.0,
                 sp_corner=1.4, corner_zone=7.0, undulate=0.22, jitter=0.06, craters=craters, ragged=(6.0, 3.0),
                 shade_low=26.0, notch_depth=(0.15, 0.7), corner_notch=(0.45, 0.8, 3.2))
    mb = MeshBuilder()
    st.emit(mb)
    rng = random.Random(7)
    Debris(half - 1.0, tan, 3, -70.0, -20.0, 5.5, 15.0, 71).build(mb, st.shade, rng, blocks=30, size=(0.7, 2.0))
    Debris(half - 1.0, tan, 2, 10.0, 62.0, 4.5, 13.0, 72).build(mb, st.shade, rng, blocks=24, size=(0.7, 2.0))
    apron = Apron(half, half, tan, 5, depth=(2.0, 6.5), spread=(16.0, 38.0), wind=2.4, n=128)
    apron.build(mb)
    scatter_rubble(mb, rng, st.shade, apron.z_at, half - 1.0, half - 1.0, 150, near=8.0, size=(0.7, 2.1), piles=6,
                   pile_blocks=18, pile_height=4.0)
    return mb


def build_medium():
    half, slope = 70.0, 52.5
    tan = math.tan(math.radians(slope))

    def slump(x, y, z, theta):
        # The upper courses have collapsed unevenly, mostly on the south-east side.
        zc = 50.0 + 9.0 * nz(math.cos(theta) * 1.4, math.sin(theta) * 1.4, 3.3)
        if z <= zc:
            return 0.0
        side = 0.5 + 0.5 * math.cos(theta + 1.1)  # 1 towards the collapsed side
        rough = 0.5 + 0.5 * nz(math.cos(theta) * 4.0, math.sin(theta) * 4.0, z * 0.15 + 9.1)
        return (z - zc) * (0.12 + 0.9 * side * side + 0.35 * rough)

    craters = [
        (3, 18.0, 46.0, 22.0, 14.0, 4.0),
        (0, -14.0, 40.0, 15.0, 11.0, 3.5),
        (2, 20.0, 20.0, 12.0, 9.0, 2.4),
        (1, -25.0, 30.0, 10.0, 12.0, 2.8),
    ]
    st = Stepped(half, half, slope, 76.0, 202, 1.3, 1.0, corner=(2.0, 7.5), notch_rate=1.4, sp_mid=5.5, sp_corner=1.2,
                 corner_zone=7.0, undulate=0.4, jitter=0.09, craters=craters, damage=slump, ragged=(10.0, 5.0),
                 shade_low=20.0, deep_notch=0.25, corner_notch=(0.55, 1.0, 4.5))
    mb = MeshBuilder()
    st.emit(mb)
    rng = random.Random(21)
    Debris(half, tan, 3, -10.0, 60.0, 17.0, 28.0, 22).build(mb, st.shade, rng, blocks=110, size=(0.7, 2.4))
    Debris(half, tan, 0, -45.0, 10.0, 11.0, 20.0, 23).build(mb, st.shade, rng, blocks=60, size=(0.7, 2.2))
    apron = Apron(half, half, tan, 6, depth=(1.5, 5.0), spread=(12.0, 28.0), wind=2.4, n=112, inner_round=10.0,
                  outer_round=24.0)
    apron.build(mb)
    scatter_rubble(mb, rng, st.shade, apron.z_at, half - 1.0, half - 1.0, 190, near=7.0, size=(0.6, 1.9), piles=8,
                   pile_blocks=18, pile_height=3.5)
    return mb


def build_small():
    half, slope = 30.0, 51.5
    tan = math.tan(math.radians(slope))
    craters = [(0, 5.0, 14.0, 8.0, 6.0, 2.0), (1, -8.0, 20.0, 7.0, 6.0, 1.8), (3, 14.0, 22.0, 6.0, 4.0, 1.5)]
    st = Stepped(half, half, slope, 32.0, 303, 0.98, 0.78, corner=(0.8, 3.0), notch_rate=1.6, sp_mid=3.2,
                 sp_corner=0.8, corner_zone=4.0, undulate=0.18, jitter=0.07, craters=craters, ragged=(5.0, 2.2),
                 shade_low=16.0, notch_depth=(0.15, 0.6), corner_notch=(0.5, 0.6, 2.4))
    mb = MeshBuilder()
    st.emit(mb)
    rng = random.Random(31)
    casing_remnant(mb, rng, st.shade, half, tan, 3, -24.0, 21.0, 13.0)
    Debris(half + 0.6, tan, 3, -29.0, 3.0, 6.5, 13.0, 32, nw=6).build(mb, st.shade, rng, blocks=45, size=(0.5, 1.4))
    apron = Apron(half, half, tan, 9, depth=(1.0, 3.0), spread=(8.0, 18.0), wind=2.4, n=96, inner_round=5.0,
                  outer_round=14.0, lump=0.4)
    apron.build(mb)
    scatter_rubble(mb, rng, st.shade, apron.z_at, half - 0.8, half - 0.8, 110, near=5.0, size=(0.45, 1.4), piles=4,
                   pile_blocks=12, pile_height=2.2)
    # Fallen casing slabs in front of the stripped face.
    for _ in range(26):
        x = rng.uniform(-26.0, 22.0)
        y = -half - rng.uniform(2.0, 13.0)
        th = math.atan2(y, x)
        s = rng.uniform(0.8, 1.6)
        dims = (s * rng.uniform(1.2, 1.8), s * rng.uniform(0.8, 1.1), s * rng.uniform(0.5, 0.7))
        rubble_block(mb, (x, y, apron.z_at(th, math.hypot(x, y)) + dims[2] * 0.15), dims, rng.uniform(0, TAU), rng,
                     st.shade, tilt=0.35, mono=True, jitter=0.06)
    return mb


# World placement (x, y), metres; the camera looks along +y from near the origin.
LAYOUT = {
    "pyramid_great": (-40.0, 480.0),
    "pyramid_medium": (235.0, 405.0),
    "pyramid_small": (-235.0, 300.0),
    "temple_ruin": (90.0, 200.0),
    "column_drums": (124.0, 186.0),
    "rubble_pile": (58.0, 178.0),
}

BUILDERS = {
    "pyramid_great": build_great,
    "pyramid_medium": build_medium,
    "pyramid_small": build_small,
    "temple_ruin": build_temple,
    "column_drums": build_drums,
    "rubble_pile": build_rubble_pile,
}


# --- Preview renders -----------------------------------------------------------------------


def _aim(obj, loc, target):
    obj.location = loc
    obj.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()


class Preview:
    """Cycles preview stage: sand ground, gradient sky, low warm sun."""

    def __init__(self):
        scene = bpy.context.scene
        self.scene = scene
        scene.render.engine = "CYCLES"
        scene.cycles.device = "CPU"
        scene.cycles.use_denoising = True
        scene.render.film_transparent = False
        scene.view_settings.view_transform = "AgX"
        try:
            scene.view_settings.look = "AgX - Medium High Contrast"
        except TypeError:
            pass
        world = bpy.data.worlds.new("PreviewSky")
        world.use_nodes = True
        scene.world = world
        nt = world.node_tree
        bg = nt.nodes["Background"]
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        mr = nt.nodes.new("ShaderNodeMapRange")
        mr.inputs["From Min"].default_value = -0.02
        mr.inputs["From Max"].default_value = 0.55
        ramp = nt.nodes.new("ShaderNodeValToRGB")
        els = ramp.color_ramp.elements
        els[0].color = (0.95, 0.6, 0.34, 1.0)
        els[1].color = (0.14, 0.22, 0.46, 1.0)
        mid = els.new(0.22)
        mid.color = (0.62, 0.52, 0.5, 1.0)
        nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
        nt.links.new(sep.outputs["Z"], mr.inputs["Value"])
        nt.links.new(mr.outputs["Result"], ramp.inputs["Fac"])
        nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 0.8
        me = bpy.data.meshes.new("PreviewGround")
        g = 9000.0
        me.from_pydata([(-g, -g, -0.05), (g, -g, -0.05), (g, g, -0.05), (-g, g, -0.05)], [], [(0, 1, 2, 3)])
        ground = bpy.data.objects.new("PreviewGround", me)
        scene.collection.objects.link(ground)
        gm = bpy.data.materials.new("PreviewSand")
        gm.use_nodes = True
        gnt = gm.node_tree
        gb = gnt.nodes["Principled BSDF"]
        gtc = gnt.nodes.new("ShaderNodeTexCoord")
        gnoise = gnt.nodes.new("ShaderNodeTexNoise")
        gnoise.inputs["Scale"].default_value = 0.02
        gramp = gnt.nodes.new("ShaderNodeValToRGB")
        gramp.color_ramp.elements[0].color = (*srgb_to_linear((0.7, 0.5, 0.33)), 1.0)
        gramp.color_ramp.elements[1].color = (*srgb_to_linear((0.84, 0.64, 0.43)), 1.0)
        gnt.links.new(gtc.outputs["Object"], gnoise.inputs["Vector"])
        gnt.links.new(gnoise.outputs["Fac"], gramp.inputs["Fac"])
        gnt.links.new(gramp.outputs["Color"], gb.inputs["Base Color"])
        gb.inputs["Roughness"].default_value = 0.95
        me.materials.append(gm)
        sun_data = bpy.data.lights.new("PreviewSun", "SUN")
        sun_data.energy = 4.2
        sun_data.color = (1.0, 0.8, 0.6)
        sun_data.angle = math.radians(0.6)
        self.sun = bpy.data.objects.new("PreviewSun", sun_data)
        scene.collection.objects.link(self.sun)
        cam_data = bpy.data.cameras.new("PreviewCam")
        cam_data.clip_start = 0.5
        cam_data.clip_end = 20000.0
        self.cam = bpy.data.objects.new("PreviewCam", cam_data)
        scene.collection.objects.link(self.cam)
        scene.camera = self.cam

    def render(self, path, loc, target, lens, sun_az, sun_el, show, res=(1280, 720), samples=40):
        scene = self.scene
        for obj in scene.objects:
            if obj.type == "MESH" and obj.name != "PreviewGround":
                obj.hide_render = obj.name.removesuffix("_mesh") not in show
        self.cam.data.lens = lens
        _aim(self.cam, loc, target)
        a, e = math.radians(sun_az), math.radians(sun_el)
        to_sun = Vector((math.cos(e) * math.cos(a), math.cos(e) * math.sin(a), math.sin(e)))
        self.sun.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
        scene.cycles.samples = samples
        scene.render.resolution_x, scene.render.resolution_y = res
        scene.render.filepath = path
        scene.render.image_settings.file_format = "PNG"
        bpy.ops.render.render(write_still=True)


def _world(name, dx, dy, dz=0.0):
    x, y = LAYOUT[name]
    return (x + dx, y + dy, dz)


def _orbit(name, azimuth, dist, height, target_z):
    x, y = LAYOUT[name]
    a = math.radians(azimuth)
    return (x + dist * math.cos(a), y + dist * math.sin(a), height), (x, y, target_z)


def render_previews(which):
    pv = Preview()
    views = {
        "overview": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_overview.png"), *_orbit("pyramid_great", 236.0, 400.0, 6.0, 52.0), 40.0, -25.0, 12.0, {"pyramid_great"}, res=(1600, 900), samples=48),
        "corner": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_corner.png"), _world("pyramid_great", -165.0, -175.0, 2.5), _world("pyramid_great", -112.0, -108.0, 24.0), 32.0, 150.0, 12.0, {"pyramid_great"}),
        "medium": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_medium.png"), *_orbit("pyramid_medium", 248.0, 260.0, 5.0, 32.0), 40.0, -35.0, 14.0, {"pyramid_medium"}),
        "small": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_small.png"), *_orbit("pyramid_small", 252.0, 112.0, 3.0, 11.0), 38.0, -40.0, 16.0, {"pyramid_small"}),
        "ruins": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_ruins.png"), _world("temple_ruin", -40.0, -68.0, 3.5), _world("temple_ruin", -6.0, -12.0, 3.0), 30.0, 150.0, 15.0, {"temple_ruin", "column_drums", "rubble_pile"}),
        "game": lambda: pv.render(os.path.join(PREVIEW_DIR, "pyramids_game.png"), (0.0, -25.0, 7.0), (0.0, 360.0, 30.0), 22.0, 150.0, 12.0, set(BUILDERS), res=(1600, 900), samples=40),
    }
    for key in which:
        views[key]()


# --- Main ----------------------------------------------------------------------------------


def placed_object(mb, name):
    """Top-level empty at the base centre with the mesh as its child.

    glTF-Transform's quantisation moves each mesh node's origin to its bounding-box centre. Keeping
    the mesh on a child node leaves the top-level origin at the base, which is what gltfScene's
    snapToGround rests on the dunes.
    """
    mesh = mb.to_object(f"{name}_mesh")
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 5.0
    bpy.context.scene.collection.objects.link(root)
    root.location = (*LAYOUT[name], 0.0)
    mesh.parent = root
    return [root, mesh]


def main():
    options = common.args()
    common.reset_scene()
    images = build_textures()
    if "--textures-only" in options:
        print("PYRAMIDS_TEXTURES_OK")
        return
    setup_materials(images)
    only = next((o.split("=", 1)[1].split(",") for o in options if o.startswith("--only=")), None)
    objects, tris = [], {}
    for name, builder in BUILDERS.items():
        if only and name not in only:
            continue
        mb = builder()
        tris[name] = mb.tris()
        objects.extend(placed_object(mb, name))
        print(f"  {name}: {tris[name]} triangles")
    total = sum(tris.values())
    if not only:
        common.ensure_dir(OUT_DIR)
        common.export_glb(objects, OUT_GLB, vertex_colors=True)
        common.write_metadata(OUT_META, {
            "generator": "assets/blender/scripts/pyramids.py",
            "objects": list(tris.keys()),
            "triangles": tris,
            "placement": "each top-level node is an empty at the object's base centre (z = 0 at ground level), placed at world x/z like desert.glb, with the mesh as its child; the game snaps each top-level node to the dunes",
            "materials": {
                "pyramidStone": "textured limestone (base colour x COLOR_0, normal, roughness); use preset 'keep' to show the textures",
                "pyramidSand": "sand drifts (colour x COLOR_0)",
            },
            "textures": {"baseColor": f"{TEX} px", "normal": f"{TEX // 2} px", "roughness": f"{TEX // 2} px"},
            "license": "Original work for Prismfall",
        })
        common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        which = next((o.split("=", 1)[1].split(",") for o in options if o.startswith("--preview=")),
                     ["overview", "corner", "medium", "small", "ruins", "game"])
        render_previews(which)
    print("PYRAMIDS_OK", len(tris), "objects", total, "triangles")


main()
