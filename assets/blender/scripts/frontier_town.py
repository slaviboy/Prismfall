"""The Last Frontier: the frontier town of Copper Wells (stage `last-frontier`).

Builds an original 1870s-1880s frontier street out of real construction: individual lap-siding and
board-and-batten boards with slight irregularity, corner boards, skirt boards, window casings with drip
caps and sills, sashes and muntins, panelled doors, porches with knee braces and rafters, boardwalks of
individual planks on joists, false fronts with cornices and brackets, balconies with balusters,
staircases, stovepipes, chimneys and tin or shake roofs. Signs are raised painted lettering converted from
OFL/Apache fonts (assets/external/fonts). Textures are CC0 Poly Haven scans, UV-mapped at their real-world
size (UV = metres / texture size); single boards take one plank strip of a plank texture so the board
seams in the geometry and the texture agree.

Layout (Blender, Z-up, metres; the game converts to Y-up): town ground at z = -7. Row A ("Front Street")
faces (0.574, -0.819) along P(s) = (-47.0, 46.7) + s (0.819, 0.574); row B is 26 m behind it and row C
about 55 m behind it. Every building is one multi-material mesh `bld_<kind>` whose origin is its front
centre on the facade line at ground level, rotated +35 deg about Z. Animated parts are empties parented to
their building, placed on the pivot with an identity rotation and scale relative to it, each holding its
geometry as the child `<name>_mesh`: `saloon_door_L`/`_R` (hinge = local Z), `windmill_rotor` (axle = local
Y), `windmill_vane` (pivot = local Z), `sign_swing_<n>` (pivot = local X at the top), `lantern_<n>` (pivot
at the hook). The empties keep the pivot transform through glTF-Transform's quantisation, which folds a
dequantising offset and scale into leaf mesh nodes. Props are grouped in `props_<area>`; the corral is
`corral`. Materials the game relies on: `glass` (every window pane, one quad per sash opening, UV 0..1)
and `lampGlow` (lantern glass).

Ambient occlusion is baked with Cycles into a byte colour attribute `AO` (face corners) with a temporary
ground plane, and exported as COLOR_0. No lighting or shadows are baked.

Run: blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/frontier_town.py --
     [--no-preview] [--no-bake] [--no-export] [--only saloon,store] [--shots game,game1920,overview,saloon,...]
     [--samples 128] [--hdr <panorama>] [--ao-report] [--ao-view]
  --only builds a subset (never exported); --shots also takes loc:<kind>/cx/cy/cz/tx/ty/tz[/lens] for a
  detail view in a building's space; --ao-report lists faces that bake almost black; --ao-view renders the
  AO attribute alone. Then optimise the export (see BLENDER_PIPELINE.md section 8, plus --texture-size 1024)
  into content/stages/last-frontier/models/town.glb.
"""
import sys

sys.dont_write_bytecode = True

import json  # noqa: E402
import math  # noqa: E402
import os  # noqa: E402
import random  # noqa: E402
import time  # noqa: E402
import zlib  # noqa: E402
from contextlib import contextmanager  # noqa: E402

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Euler, Matrix, Vector  # noqa: E402
from mathutils import geometry as mgeo  # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ARGS = common.args()


def _opt(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        if i + 1 < len(ARGS):
            return ARGS[i + 1]
    return default


NO_PREVIEW = "--no-preview" in ARGS
NO_BAKE = "--no-bake" in ARGS
NO_EXPORT = "--no-export" in ARGS
ONLY = set(filter(None, (_opt("--only", "") or "").split(",")))
SHOTS = set(filter(None, (_opt("--shots", "") or "").split(",")))
SAMPLES = int(_opt("--samples", "128"))

ROOT = common.ROOT
PH = os.path.join(ROOT, "assets", "external", "polyhaven")
FONTDIR = os.path.join(ROOT, "assets", "external", "fonts")
EXPORT = os.path.join(ROOT, "assets", "blender", "exports", "frontier", "town.glb")
BLEND = os.path.join(ROOT, "assets", "blender", "source", "environments", "last_frontier_town.blend")
PREVIEWS = os.path.join(ROOT, "assets", "blender", "previews")
CONTENT_META = os.path.join(ROOT, "content", "stages", "last-frontier", "models", "town.meta.json")
HDR = _opt("--hdr", os.path.join(PH, "goegap_road", "goegap_road_16k.hdr"))

GROUND_Z = -7.0
FACING_DEG = 35.0
ROW_DIR = Vector((0.819, 0.574))
ROW_N = Vector((0.574, -0.819))  # facade normal, toward the street
ROW_A = Vector((-47.0, 46.7))
ROW_B = Vector((-61.9, 68.0))
ROW_C = ROW_A - ROW_N * 55.0

# ---------------------------------------------------------------------------------------------- textures

# Plank seams measured from each texture's normal map (fractions across the plank axis). For textures whose
# planks run along U the seams are rows (converted to V); for planks along V they are columns (U).
_ROWS = {
    "weathered_plank_siding": [0.039, 0.105, 0.176, 0.25, 0.322, 0.393, 0.463, 0.541, 0.607, 0.682, 0.748, 0.818, 0.893, 0.967],
    "old_wood_floor": [0.002, 0.035, 0.068, 0.104, 0.137, 0.172, 0.207, 0.242, 0.275, 0.311, 0.344, 0.379, 0.412, 0.447, 0.482,
                       0.514, 0.549, 0.584, 0.617, 0.652, 0.688, 0.723, 0.756, 0.791, 0.826, 0.861, 0.895, 0.932, 0.965],
    "brown_planks_09": [0.061, 0.213, 0.336, 0.484, 0.641, 0.793, 0.916],
    "weathered_brown_planks": [0.039, 0.115, 0.191, 0.27, 0.346, 0.424, 0.5, 0.576, 0.652, 0.73, 0.807, 0.885, 0.963],
}
_COLS = {
    "weathered_planks": [0.061, 0.166, 0.281, 0.393, 0.504, 0.615, 0.729, 0.84, 0.949],
    "distressed_painted_planks": [0.002, 0.072, 0.143, 0.213, 0.287, 0.357, 0.43, 0.5, 0.572, 0.646, 0.717, 0.787, 0.857, 0.93],
    "wood_shutter": [0.148, 0.295, 0.439, 0.555, 0.701, 0.85, 0.996],
}
# id: (resolution, grain axis in UV space: the texture axis that runs along the wood grain / corrugations)
TEXDEF = {
    "weathered_plank_siding": ("2k", "u"),
    "old_wood_floor": ("2k", "u"),
    "weathered_planks": ("1k", "v"),
    "brown_planks_09": ("1k", "u"),
    "weathered_brown_planks": ("1k", "u"),
    "distressed_painted_planks": ("1k", "v"),
    "wood_peeling_paint_weathered": ("1k", "u"),
    "wood_shutter": ("1k", "v"),
    "rusty_corrugated_iron": ("1k", "v"),
    "corrugated_iron": ("1k", "v"),
    "rusty_metal_03": ("1k", "u"),
    "old_sandstone_02": ("2k", "u"),
    "thatch_roof_angled": ("1k", "v"),
}


class Tex:
    def __init__(self, tid):
        res, grain = TEXDEF[tid]
        self.id, self.res, self.grain = tid, res, grain
        with open(os.path.join(PH, tid, "source.json"), encoding="utf-8") as fh:
            src = json.load(fh)
        self.size = float(src["dimensionsMm"][0]) / 1000.0
        self.authors = list((src.get("authors") or {}).keys())
        seams = None
        if tid in _ROWS:
            seams = sorted(1.0 - r for r in _ROWS[tid])
        elif tid in _COLS:
            seams = sorted(_COLS[tid])
        self.strips = []
        if seams:
            for i, a in enumerate(seams):
                b = seams[i + 1] if i + 1 < len(seams) else seams[0] + 1.0
                w = b - a
                if w > 0.03:
                    self.strips.append((a + w * 0.17, b - w * 0.17))

    def path(self, m):
        return os.path.join(PH, self.id, f"{self.id}_{m}_{self.res}.jpg")


# Material name -> (texture id, base colour factor). Painted variants share one texture, tinted by the factor.
MATDEF = {
    "sidingWeathered": ("weathered_plank_siding", None),
    "boardwalk": ("old_wood_floor", None),
    "woodRaw": ("weathered_planks", None),
    "woodPale": ("brown_planks_09", (0.86, 0.80, 0.72)),
    "paintOxblood": ("weathered_brown_planks", (1.0, 0.84, 0.72)),
    "paintWhite": ("distressed_painted_planks", (1.0, 0.98, 0.93)),
    "paintMustard": ("distressed_painted_planks", (1.0, 0.70, 0.30)),
    "paintSage": ("distressed_painted_planks", (0.70, 0.82, 0.62)),
    "paintSlate": ("distressed_painted_planks", (0.56, 0.68, 0.86)),
    "paintDark": ("wood_peeling_paint_weathered", None),
    "woodVarnish": ("wood_shutter", (0.78, 0.66, 0.56)),
    "tinRusty": ("rusty_corrugated_iron", None),
    "tinGalv": ("corrugated_iron", (0.86, 0.86, 0.84)),
    "ironRust": ("rusty_metal_03", (0.62, 0.52, 0.46)),
    "stone": ("old_sandstone_02", None),
    "hay": ("thatch_roof_angled", (1.0, 0.92, 0.70)),
    "glass": (None, None),
    "lampGlow": (None, None),
    "ironBlack": (None, None),
    "water": (None, None),
}
PLAIN = {
    # name: (base colour (linear), metallic, roughness)
    "glass": ((0.018, 0.022, 0.026), 0.0, 0.06),
    "lampGlow": ((0.95, 0.62, 0.30), 0.0, 0.22),
    "ironBlack": ((0.030, 0.028, 0.026), 0.65, 0.58),
    "water": ((0.020, 0.026, 0.022), 0.0, 0.04),
}
TEXOF = {}
MATS = {}


def build_materials():
    images = {}

    def image(path, color):
        if path not in images:
            img = bpy.data.images.load(path, check_existing=True)
            img.colorspace_settings.name = "sRGB" if color else "Non-Color"
            images[path] = img
        return images[path]

    for name, (tid, factor) in MATDEF.items():
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        if tid is None:
            col, metal, rough = PLAIN[name]
            bsdf.inputs["Base Color"].default_value = (*col, 1.0)
            bsdf.inputs["Metallic"].default_value = metal
            bsdf.inputs["Roughness"].default_value = rough
            if name == "glass":
                bsdf.inputs["Specular IOR Level"].default_value = 0.5
                # A 16 x 16 dark tint, a shade lighter toward the top of the pane. It is not a solid colour, so
                # the optimiser keeps it and with it the 0..1 pane UVs the game's window shader relies on.
                img = bpy.data.images.new("glassTint", 16, 16, alpha=False)
                px = []
                for j in range(16):
                    for i in range(16):
                        v = 0.016 + 0.012 * (j / 15.0) + 0.002 * ((i + j) % 2)
                        px += [v * 0.92, v, v * 1.08, 1.0]
                img.pixels[:] = px
                img.pack()
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                tex.interpolation = "Linear"
                nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
            MATS[name] = mat
            continue
        t = TEXOF[name] = Tex(tid)
        diff = nt.nodes.new("ShaderNodeTexImage")
        diff.image = image(t.path("diffuse"), True)
        diff.location = (-700, 300)
        if factor:
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            mix.location = (-300, 300)
            nt.links.new(diff.outputs["Color"], mix.inputs["A"])
            mix.inputs["B"].default_value = (*factor, 1.0)
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        else:
            nt.links.new(diff.outputs["Color"], bsdf.inputs["Base Color"])
        arm = nt.nodes.new("ShaderNodeTexImage")
        arm.image = image(t.path("arm"), False)
        arm.location = (-700, 0)
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        sep.location = (-400, 0)
        nt.links.new(arm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        nor = nt.nodes.new("ShaderNodeTexImage")
        nor.image = image(t.path("nor_gl"), False)
        nor.location = (-700, -300)
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.location = (-300, -300)
        nt.links.new(nor.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
        MATS[name] = mat
    return images


# ------------------------------------------------------------------------------------------ mesh builder

FACES6 = ((0, 0), (0, 1), (1, 0), (1, 1), (2, 0), (2, 1))
FNAME = {(0, 0): "-x", (0, 1): "+x", (1, 0): "-y", (1, 1): "+y", (2, 0): "-z", (2, 1): "+z"}


class MB:
    """Accumulates polygons (positions, per-corner UVs, material slots) in the current transform."""

    def __init__(self, name, seed):
        self.name = name
        self.rng = random.Random(seed)
        self.co, self.polys, self.uvs, self.mi, self.sm = [], [], [], [], []
        self.mats, self._slot = [], {}
        self.stack = [Matrix.Identity(4)]

    @contextmanager
    def at(self, m):
        self.stack.append(self.stack[-1] @ m)
        try:
            yield
        finally:
            self.stack.pop()

    def slot(self, mat):
        if mat not in self._slot:
            self._slot[mat] = len(self.mats)
            self.mats.append(mat)
        return self._slot[mat]

    def verts(self, pts):
        m = self.stack[-1]
        i0 = len(self.co)
        self.co.extend(m @ Vector(p) for p in pts)
        return list(range(i0, len(self.co)))

    def face(self, pts, uvs, mat, smooth=False):
        self.face_i(self.verts(pts), uvs, mat, smooth)

    def face_i(self, idx, uvs, mat, smooth=False):
        self.polys.append(list(idx))
        self.uvs.append([tuple(u) for u in uvs])
        self.mi.append(self.slot(mat))
        self.sm.append(smooth)

    def tris(self):
        return sum(len(p) - 2 for p in self.polys)

    def to_object(self, coll, name=None):
        me = bpy.data.meshes.new(name or self.name)
        me.from_pydata([c[:] for c in self.co], [], self.polys)
        uvl = me.uv_layers.new(name="UVMap")
        flat = [c for poly in self.uvs for uv in poly for c in uv]
        uvl.uv.foreach_set("vector", flat)
        me.polygons.foreach_set("material_index", self.mi)
        me.polygons.foreach_set("use_smooth", self.sm)
        for m in self.mats:
            me.materials.append(MATS[m])
        me.validate(clean_customdata=False)
        me.update()
        ob = bpy.data.objects.new(name or self.name, me)
        coll.objects.link(ob)
        return ob


def mat4(o, ax, ay, az):
    m = Matrix.Identity(4)
    for i in range(3):
        m[i][0], m[i][1], m[i][2], m[i][3] = ax[i], ay[i], az[i], o[i]
    return m


def T(x, y, z):
    return Matrix.Translation((x, y, z))


def RZ(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Z")


def RX(deg):
    return Matrix.Rotation(math.radians(deg), 4, "X")


def RY(deg):
    return Matrix.Rotation(math.radians(deg), 4, "Y")


def _uv(t, fal, fac, lal, lac, wmax, strip, u0, v0):
    """UV of one corner: fal/fac = fractions along/across the grain; lal/lac = face lengths (m)."""
    if t is None:
        return (fal * lal, fac * lac)
    along = u0 + fal * lal / t.size
    if strip:
        lo, hi = strip
        across = lo + fac * (hi - lo) * min(1.0, lac / max(wmax, 1e-6))
    else:
        across = v0 + fac * lac / t.size
    return (along, across) if t.grain == "u" else (across, along)


def obox(b, o, ex, ey, ez, mat, grain=None, skip=(), strip=None, u0=None, v0=None):
    """Oriented box from corner o along edges ex, ey, ez. The texture grain follows edge `grain` (0..2)."""
    o = Vector(o)
    E = [Vector(ex), Vector(ey), Vector(ez)]
    L = [e.length for e in E]
    if grain is None:
        grain = max(range(3), key=lambda k: L[k])
    t = TEXOF.get(mat)
    rng = b.rng
    if u0 is None:
        u0 = rng.random()
    if v0 is None:
        v0 = rng.random()
    if t is not None and strip is None and t.strips:
        strip = rng.choice(t.strips)
    wmax = max(L[k] for k in range(3) if k != grain)
    for a, s in FACES6:
        if FNAME[(a, s)] in skip:
            continue
        bi, ci = [k for k in range(3) if k != a]
        nrm = E[a] if s else -E[a]
        if E[bi].cross(E[ci]).dot(nrm) < 0:
            bi, ci = ci, bi
        base = o + E[a] if s else o
        pts = [base, base + E[bi], base + E[bi] + E[ci], base + E[ci]]
        fr = ((0, 0), (1, 0), (1, 1), (0, 1))
        uvs = []
        for fb, fc in fr:
            if grain == bi:
                uvs.append(_uv(t, fb, fc, L[bi], L[ci], wmax, strip, u0, v0))
            elif grain == ci:
                uvs.append(_uv(t, fc, fb, L[ci], L[bi], wmax, strip, u0, v0))
            else:
                uvs.append(_uv(t, fb, fc, L[bi], L[ci], 1e9, None, u0, v0))
        b.face(pts, uvs, mat)


def box(b, x0, y0, z0, x1, y1, z1, mat, grain=None, skip=(), jitter=0.0, strip=None, u0=None):
    """Axis-aligned box in the current frame; `jitter` (deg) tilts it randomly about its centre."""
    o = Vector((min(x0, x1), min(y0, y1), min(z0, z1)))
    E = [Vector((abs(x1 - x0), 0, 0)), Vector((0, abs(y1 - y0), 0)), Vector((0, 0, abs(z1 - z0)))]
    if jitter:
        r = b.rng
        R = Euler((math.radians(r.uniform(-jitter, jitter)), math.radians(r.uniform(-jitter, jitter)),
                   math.radians(r.uniform(-jitter, jitter)))).to_matrix()
        c = o + (E[0] + E[1] + E[2]) * 0.5
        o = c + R @ (o - c)
        E = [R @ e for e in E]
    if isinstance(grain, str):
        grain = "xyz".index(grain)
    obox(b, o, E[0], E[1], E[2], mat, grain=grain, skip=skip, strip=strip, u0=u0)


def beam(b, p0, p1, w, h, mat, up=(0, 0, 1), skip=(), strip=None):
    """A timber of section w x h from p0 to p1 (centre line); `up` orients the h side."""
    p0, p1 = Vector(p0), Vector(p1)
    d = p1 - p0
    ln = d.length
    if ln < 1e-6:
        return
    dx = d / ln
    upv = Vector(up)
    if abs(dx.dot(upv.normalized())) > 0.98:
        upv = Vector((1, 0, 0)) if abs(dx.x) < 0.9 else Vector((0, 1, 0))
    side = dx.cross(upv).normalized()
    upn = side.cross(dx).normalized()
    o = p0 - side * (w / 2) - upn * (h / 2)
    obox(b, o, d, side * w, upn * h, mat, grain=0, skip=skip, strip=strip)


def quad(b, p0, p1, p2, p3, mat, uvs=None, size=None):
    pts = [Vector(p) for p in (p0, p1, p2, p3)]
    if uvs is None:
        t = TEXOF.get(mat)
        s = t.size if t else 1.0
        ax = (pts[1] - pts[0])
        lx = ax.length
        ax = ax / max(lx, 1e-9)
        nrm = (pts[1] - pts[0]).cross(pts[3] - pts[0])
        ay = nrm.cross(ax).normalized()
        uvs = [((p - pts[0]).dot(ax) / s, (p - pts[0]).dot(ay) / s) for p in pts]
    b.face(pts, uvs, mat)


def planar_uvs(pts, ax, ay, size, off=(0.0, 0.0)):
    return [(Vector(p).dot(ax) / size + off[0], Vector(p).dot(ay) / size + off[1]) for p in pts]


def poly(b, pts, mat, ax=None, ay=None, off=(0.0, 0.0)):
    """A planar polygon (any size, convex) with planar UVs in metres / texture size."""
    pts = [Vector(p) for p in pts]
    t = TEXOF.get(mat)
    s = t.size if t else 1.0
    if ax is None:
        nrm = mgeo.normal(pts)
        ax = (pts[1] - pts[0]).normalized()
        ay = nrm.cross(ax).normalized()
    b.face(pts, planar_uvs(pts, Vector(ax), Vector(ay), s, off), mat)


def cyl(b, p0, p1, r, mat, n=8, r1=None, caps=(True, True), smooth=True, phase=0.0, grain_along=True):
    p0, p1 = Vector(p0), Vector(p1)
    ax = p1 - p0
    ln = ax.length
    d = ax / ln
    up = Vector((0, 0, 1)) if abs(d.z) < 0.9 else Vector((1, 0, 0))
    e1 = d.cross(up).normalized()
    e2 = d.cross(e1)
    r1 = r if r1 is None else r1
    angs = [phase + 2 * math.pi * i / n for i in range(n)]
    ring0 = [p0 + (e1 * math.cos(a) + e2 * math.sin(a)) * r for a in angs]
    ring1 = [p1 + (e1 * math.cos(a) + e2 * math.sin(a)) * r1 for a in angs]
    i0, i1 = b.verts(ring0), b.verts(ring1)
    t = TEXOF.get(mat)
    s = t.size if t else 1.0
    u0 = b.rng.random()
    v0 = b.rng.random()
    circ = 2 * math.pi * max(r, r1) / s
    for i in range(n):
        j = (i + 1) % n
        ua, ub = v0 + circ * i / n, v0 + circ * (i + 1) / n
        va, vb = u0, u0 + ln / s
        if t is not None and t.grain == "u":
            uvs = [(va, ua), (va, ub), (vb, ub), (vb, ua)]
        else:
            uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
        b.face_i([i0[i], i0[j], i1[j], i1[i]], uvs, mat, smooth)
    if caps[0]:
        poly(b, list(reversed(ring0)), mat)
    if caps[1]:
        poly(b, ring1, mat)


def lathe(b, prof, mat, n=16, o=(0, 0, 0), smooth=True, cap_top=True, cap_bot=False, grain_along=True):
    """Revolve a profile [(r, z), ...] (bottom to top) about the local Z axis through o."""
    o = Vector(o)
    t = TEXOF.get(mat)
    s = t.size if t else 1.0
    rings = []
    for r, z in prof:
        rings.append(b.verts([o + Vector((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z)) for i in range(n)]))
    acc = [0.0]
    for k in range(1, len(prof)):
        acc.append(acc[-1] + math.hypot(prof[k][0] - prof[k - 1][0], prof[k][1] - prof[k - 1][1]))
    rmax = max(p[0] for p in prof)
    circ = 2 * math.pi * rmax / s
    u0 = b.rng.random()
    for k in range(len(prof) - 1):
        for i in range(n):
            j = (i + 1) % n
            ua, ub = circ * i / n, circ * (i + 1) / n
            va, vb = u0 + acc[k] / s, u0 + acc[k + 1] / s
            if t is not None and t.grain == "u" and grain_along:
                uvs = [(va, ua), (va, ub), (vb, ub), (vb, ua)]
            else:
                uvs = [(ua, va), (ub, va), (ub, vb), (ua, vb)]
            b.face_i([rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], uvs, mat, smooth)
    if cap_top and prof[-1][0] > 1e-4:
        r, z = prof[-1]
        poly(b, [o + Vector((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z)) for i in range(n)], mat)
    if cap_bot and prof[0][0] > 1e-4:
        r, z = prof[0]
        poly(b, [o + Vector((r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z)) for i in reversed(range(n))], mat)


def prism(b, pts2, o, ax, ay, depth, mat, caps=(True, True), skip_sides=()):
    """Extrude a 2D polygon (CCW in the ax/ay plane) along ax x ay by `depth`."""
    o, ax, ay = Vector(o), Vector(ax), Vector(ay)
    az = ax.cross(ay).normalized()
    t = TEXOF.get(mat)
    s = t.size if t else 1.0
    P0 = [o + ax * x + ay * y for x, y in pts2]
    P1 = [p + az * depth for p in P0]
    n = len(pts2)
    u0 = b.rng.random()
    acc = 0.0
    for i in range(n):
        j = (i + 1) % n
        el = (P0[j] - P0[i]).length
        if i not in skip_sides:
            b.face([P0[i], P0[j], P1[j], P1[i]], [(u0 + acc / s, 0), (u0 + (acc + el) / s, 0), (u0 + (acc + el) / s, depth / s), (u0 + acc / s, depth / s)], mat)
        acc += el
    tris = mgeo.tessellate_polygon([[Vector((x, y, 0)) for x, y in pts2]])
    for tri in tris:
        a, bb, c = tri
        q = [Vector((pts2[k][0], pts2[k][1], 0)) for k in (a, bb, c)]
        ccw = (q[1] - q[0]).cross(q[2] - q[0]).z > 0
        order = (a, bb, c) if ccw else (a, c, bb)
        if caps[1]:
            b.face([P1[k] for k in order], [(pts2[k][0] / s, pts2[k][1] / s) for k in order], mat)
        if caps[0]:
            rev = tuple(reversed(order))
            b.face([P0[k] for k in rev], [(pts2[k][0] / s, pts2[k][1] / s) for k in rev], mat)


# ---------------------------------------------------------------------------------------------- lettering

FONTFILES = {
    "rye": ("rye/Rye-Regular.ttf", "Rye", "SIL Open Font License 1.1"),
    "alfa": ("alfaslabone/AlfaSlabOne-Regular.ttf", "Alfa Slab One", "SIL Open Font License 1.1"),
    "old": ("oldstandardtt/OldStandard-Bold.ttf", "Old Standard TT Bold", "SIL Open Font License 1.1"),
    "ultra": ("ultra/Ultra-Regular.ttf", "Ultra", "Apache License 2.0"),
}
_FONTS = {}
_GLYPHS = {}
FONTS_USED = set()


def glyph_islands(text, font, res=2):
    """Text converted to a mesh: a list of islands (one per glyph part) of front-facing and side polygons.
    Font units: x along, y up, z out of the sign (0 = sign face, 1 = full depth)."""
    key = (text, font, res)
    if key in _GLYPHS:
        return _GLYPHS[key]
    FONTS_USED.add(font)
    if font not in _FONTS:
        _FONTS[font] = bpy.data.fonts.load(os.path.join(FONTDIR, FONTFILES[font][0]))
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = text
    cu.font = _FONTS[font]
    cu.size = 1.0
    cu.extrude = 0.5
    cu.resolution_u = res
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    seen = set()
    islands = []
    for f in bm.faces:
        if f.index in seen:
            continue
        stack, isl = [f], []
        seen.add(f.index)
        while stack:
            g = stack.pop()
            isl.append(g)
            for e in g.edges:
                for h in e.link_faces:
                    if h.index not in seen:
                        seen.add(h.index)
                        stack.append(h)
        polys = []
        for g in isl:
            if g.normal.z < -0.5:
                continue  # back of the letter rests on the board
            polys.append([(v.co.x, v.co.y, v.co.z + 0.5) for v in g.verts])
        if polys:
            islands.append(polys)
    bm.free()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    xs = [p[0] for isl in islands for poly_ in isl for p in poly_]
    ys = [p[1] for isl in islands for poly_ in isl for p in poly_]
    out = (islands, (min(xs), max(xs), min(ys), max(ys)))
    _GLYPHS[key] = out
    return out


def letters(b, text, font, xc, zc, cap, mat, y=0.0, depth=0.008, max_w=None, jitter=1.0, res=2, squash_min=0.8):
    """Raised painted letters on a sign face at y (wall space: outward is -y), centred at (xc, zc)."""
    islands, (x0, x1, y0, y1) = glyph_islands(text, font, res)
    s = cap / max(y1 - y0, 1e-6)
    sx = s
    w = (x1 - x0) * s
    if max_w and w > max_w:
        k = max_w / w
        if k >= squash_min:
            sx = s * k
        else:
            sx = s * squash_min
            s = s * k / squash_min
            sx = s * squash_min
    cx = (x0 + x1) / 2
    cy = (y0 + y1) / 2
    rng = b.rng
    t = TEXOF.get(mat)
    ts = t.size if t else 1.0
    u0, v0 = rng.random(), rng.random()
    for isl in islands:
        pts = [p for poly_ in isl for p in poly_]
        gx = sum(p[0] for p in pts) / len(pts)
        gy = sum(p[1] for p in pts) / len(pts)
        ang = math.radians(rng.uniform(-1.2, 1.2) * jitter)
        dxj, dyj = rng.uniform(-0.012, 0.012) * jitter * cap, rng.uniform(-0.02, 0.02) * jitter * cap
        ca, sa = math.cos(ang), math.sin(ang)
        dep = depth * rng.uniform(0.85, 1.15)
        for poly_ in isl:
            out, uvs = [], []
            for px, py, pz in poly_:
                lx, ly = px - gx, py - gy
                rx, ry = lx * ca - ly * sa + gx, lx * sa + ly * ca + gy
                X = xc + (rx - cx) * sx + dxj
                Z = zc + (ry - cy) * s + dyj
                out.append(Vector((X, y - pz * dep, Z)))
                uvs.append((u0 + X / ts, v0 + Z / ts))
            b.face(out, uvs, mat)


# ------------------------------------------------------------------------------- construction (wall space)
# Wall space: x along the wall (0 at its start), y into the building (outward is -y), z up. The sheathing
# plane is y = 0; lap siding sits at y in [-0.024, 0]; trim stands proud of it.

LAP_TB, LAP_TT = 0.024, 0.008
TRIM_Y0, TRIM_Y1 = -0.048, -0.010


def wall_frame(o, a_dir):
    """Matrix from wall space to building space for a wall starting at o running along a_dir (horizontal)."""
    a = Vector((a_dir[0], a_dir[1], 0)).normalized()
    inward = Vector((-a.y, a.x, 0))  # left of the run direction (z up): walls are walked with the inside on the left
    return mat4(Vector(o), a, inward, Vector((0, 0, 1)))


def _subtract(segs, a0, a1):
    out = []
    for s0, s1 in segs:
        if a1 <= s0 or a0 >= s1:
            out.append((s0, s1))
            continue
        if a0 > s0:
            out.append((s0, a0))
        if a1 < s1:
            out.append((a1, s1))
    return [(s0, s1) for s0, s1 in out if s1 - s0 > 0.02]


def _lumber(rng, s0, s1, lo=2.0, hi=4.8, first=True):
    """Split [s0, s1] into board lengths with staggered butt joints."""
    out = []
    pos = s0
    k = 0
    while pos < s1 - 1e-4:
        ln = rng.uniform(lo, hi)
        if k == 0 and first:
            ln *= rng.uniform(0.25, 1.0)
        e = pos + ln
        if s1 - e < 0.6:
            e = s1
        out.append((pos, min(e, s1)))
        pos = e
        k += 1
    return out


def lap_siding(b, x0, x1, z0, z1, mat, holes=(), exp=0.118, top=None, tilt=0.05, rough=1.0):
    """Lap (clapboard) siding: tilted boards, each with its visible face, butt edge and end cuts.
    holes: (x0, x1, z0, z1) rectangles left open for trim; top(x) -> max z for gable ends."""
    rng = b.rng
    n = max(1, int(round((z1 - z0) / exp)))
    exp = (z1 - z0) / n
    ov = 0.025
    t = TEXOF.get(mat)
    for k in range(n):
        zb = z0 + k * exp
        zt = zb + exp
        xa, xb = x0, x1
        if top is not None:
            # trim the course to where the gable is at least as high as the course top
            lo, hi = x0, x1
            step = 0.05
            xs = [x0 + i * step for i in range(int((x1 - x0) / step) + 1)]
            ok = [x for x in xs if top(x) >= zt - 0.03]
            if not ok:
                continue
            xa, xb = max(lo, ok[0] - 0.02), min(hi, ok[-1] + 0.02)
        segs = [(xa, xb)]
        for hx0, hx1, hz0, hz1 in holes:
            if hz1 <= zb + 0.004 or hz0 >= zt - 0.004:
                continue
            segs = _subtract(segs, hx0, hx1)
        for s0, s1 in segs:
            for a, c in _lumber(rng, s0, s1):
                gap = 0.002 if c < s1 - 1e-4 else 0.0
                c -= gap
                if c - a < 0.03:
                    continue
                L = c - a
                d0 = rng.uniform(-0.0025, 0.0025) * rough
                sl = math.tan(math.radians(rng.uniform(-tilt, tilt))) * L
                tb = LAP_TB * rng.uniform(0.9, 1.1)
                za0, zc0 = zb + d0, zb + d0 + sl
                ztop = zt + ov
                strip = rng.choice(t.strips) if t and t.strips else None
                u0 = rng.random()
                v0 = rng.random()
                front = [(a, -tb, za0), (c, -tb, zc0), (c, -LAP_TT + 0.004, ztop), (a, -LAP_TT + 0.004, ztop)]
                fu = [_uv(t, 0, 0, L, exp, exp, strip, u0, v0), _uv(t, 1, 0, L, exp, exp, strip, u0, v0),
                      _uv(t, 1, 1, L, exp, exp, strip, u0, v0), _uv(t, 0, 1, L, exp, exp, strip, u0, v0)]
                b.face(front, fu, mat)
                butt = [(a, 0.0, za0), (c, 0.0, zc0), (c, -tb, zc0), (a, -tb, za0)]
                bu = [_uv(t, 0, 0, L, 0.02, exp, strip, u0, v0), _uv(t, 1, 0, L, 0.02, exp, strip, u0, v0),
                      _uv(t, 1, 0.2, L, 0.02, exp, strip, u0, v0), _uv(t, 0, 0.2, L, 0.02, exp, strip, u0, v0)]
                b.face(butt, bu, mat)
                endu = [(0, 0), (0.01, 0), (0.01, 0.05), (0, 0.05)]
                b.face([(a, 0.0, za0), (a, -tb, za0), (a, -LAP_TT + 0.004, ztop), (a, 0.0, ztop)], endu, mat)
                b.face([(c, -tb, zc0), (c, 0.0, zc0), (c, 0.0, ztop), (c, -LAP_TT + 0.004, ztop)], endu, mat)


def bb_siding(b, x0, x1, z0, z1, mat, holes=(), bw=(0.24, 0.32), batten=0.065, tilt=0.3, top=None, battens=True, mat_batten=None):
    """Board-and-batten: vertical boards with narrow battens over the joints."""
    rng = b.rng
    x = x0
    joints = []
    mb = mat_batten or mat
    while x < x1 - 0.02:
        w = rng.uniform(*bw)
        if x1 - (x + w) < 0.12:
            w = x1 - x
        xa, xc = x, min(x1, x + w)
        za, zc = z0, z1
        if top is not None:
            zc = min(z1, max(top(xa), top(xc)) + 0.02)
            if zc <= za + 0.05:
                x = xc
                continue
        spans = [(za, zc)]
        for hx0, hx1, hz0, hz1 in holes:
            if hx1 <= xa + 0.01 or hx0 >= xc - 0.01:
                continue
            spans = _subtract(spans, hz0, hz1)
        for s0, s1 in spans:
            box(b, xa + 0.004, -0.022, s0, xc - 0.004, 0.0, s1, mat, grain="z", skip={"+y"}, jitter=tilt * 0.4)
        if xc < x1 - 0.02:
            joints.append(xc)
        x = xc
    if battens:
        for jx in joints:
            za, zc = z0, z1
            if top is not None:
                zc = min(z1, top(jx) + 0.01)
                if zc <= za + 0.05:
                    continue
            spans = [(za, zc)]
            for hx0, hx1, hz0, hz1 in holes:
                if hx1 <= jx - batten or hx0 >= jx + batten:
                    continue
                spans = _subtract(spans, hz0, hz1)
            for s0, s1 in spans:
                box(b, jx - batten / 2, -0.042, s0 + 0.01, jx + batten / 2, -0.02, s1 - 0.01, mb, grain="z", skip={"+y"}, jitter=tilt)


def flush_boards(b, x0, x1, z0, z1, mat, y0=-0.045, y1=-0.022, bh=(0.16, 0.24), vertical=False):
    """Flush boards (sign boards, soffits): horizontal (or vertical) planks with hairline gaps."""
    rng = b.rng
    if vertical:
        x = x0
        while x < x1 - 0.01:
            w = rng.uniform(*bh)
            if x1 - (x + w) < 0.08:
                w = x1 - x
            box(b, x + 0.002, y0, z0, min(x1, x + w) - 0.002, y1, z1, mat, grain="z", skip={"+y"}, jitter=0.15)
            x += w
        return
    z = z0
    while z < z1 - 0.01:
        h = rng.uniform(*bh)
        if z1 - (z + h) < 0.08:
            h = z1 - z
        for a, c in _lumber(rng, x0, x1, 2.5, 5.0):
            box(b, a + 0.002, y0, z + 0.002, c - 0.002, y1, min(z1, z + h) - 0.002, mat, grain="x", skip={"+y"}, jitter=0.08)
        z += h


def trim(b, x0, x1, z0, z1, mat, y0=TRIM_Y0, y1=TRIM_Y1, skip=("+y",), jitter=0.0):
    box(b, x0, y0, z0, x1, y1, z1, mat, skip=skip, jitter=jitter)


def corner_board(b, x, z0, z1, mat, side, w=0.13, wrap=0.0):
    """Vertical corner board at wall end x (side -1 = start, +1 = end); wrap extends it past the corner."""
    if side < 0:
        trim(b, x - wrap, x + w, z0, z1, mat, y0=-0.05, y1=0.0)
    else:
        trim(b, x - w, x + wrap, z0, z1, mat, y0=-0.05, y1=0.0)


def window(b, xc, zs, w, h, trim_mat, sash_mat, lights=(2, 2), casing=0.10, head=0.15, shutters=None, bars=False,
           sash_split=0.5, reveal=0.14, cap=True):
    """Double-hung sash window: casings, head with drip cap, sloped sill and apron, two sashes with
    muntins (lights = panes across, panes up per sash), one glass quad behind (UV 0..1 across the
    opening). Returns the rectangle the siding must leave open."""
    xl, xr = xc - w / 2, xc + w / 2
    zt = zs + h
    # casings
    trim(b, xl - casing, xl, zs, zt, trim_mat)
    trim(b, xr, xr + casing, zs, zt, trim_mat)
    trim(b, xl - casing, xr + casing, zt, zt + head, trim_mat)
    if cap:
        trim(b, xl - casing - 0.025, xr + casing + 0.025, zt + head, zt + head + 0.028, trim_mat, y0=TRIM_Y0 - 0.035, y1=TRIM_Y1, skip=())
        trim(b, xl - casing - 0.012, xr + casing + 0.012, zt + head - 0.02, zt + head, trim_mat, y0=TRIM_Y0 - 0.015, y1=TRIM_Y0, skip=("+y",))
    # sill: sloped, projecting, with an apron below
    sill_d = 0.075
    o = Vector((xl - casing - 0.03, TRIM_Y0 - sill_d + 0.02, zs - 0.045))
    tilt = math.radians(7)
    ey = Vector((0, sill_d + 0.11, (sill_d + 0.11) * math.tan(tilt)))
    obox(b, o, (w + 2 * casing + 0.06, 0, 0), ey, (0, 0, 0.042), trim_mat, grain=0)
    trim(b, xl - casing + 0.015, xr + casing - 0.015, zs - 0.045 - 0.085, zs - 0.045, trim_mat)
    # reveal (jambs, head and stool inside the casing)
    rv = reveal
    poly(b, [(xl, TRIM_Y1, zs), (xl, rv, zs), (xl, rv, zt), (xl, TRIM_Y1, zt)], trim_mat)
    poly(b, [(xr, rv, zs), (xr, TRIM_Y1, zs), (xr, TRIM_Y1, zt), (xr, rv, zt)], trim_mat)
    poly(b, [(xl, TRIM_Y1, zt), (xl, rv, zt), (xr, rv, zt), (xr, TRIM_Y1, zt)], trim_mat)
    poly(b, [(xl, rv, zs), (xl, TRIM_Y1, zs), (xr, TRIM_Y1, zs), (xr, rv, zs)], trim_mat)
    # sashes
    st, rl, brl, mr = 0.048, 0.05, 0.075, 0.032
    zm = zs + h * sash_split
    cols, rows = lights
    for lower in (True, False):
        y0, y1 = (0.018, 0.052) if lower else (0.058, 0.092)
        za, zb = (zs, zm + mr / 2) if lower else (zm - mr / 2, zt)
        bot = brl if lower else mr
        topr = mr if lower else rl
        box(b, xl, y0, za, xl + st, y1, zb, sash_mat, grain="z", skip={"+y"})
        box(b, xr - st, y0, za, xr, y1, zb, sash_mat, grain="z", skip={"+y"})
        box(b, xl + st, y0, za, xr - st, y1, za + bot, sash_mat, grain="x", skip={"+y"})
        box(b, xl + st, y0, zb - topr, xr - st, y1, zb, sash_mat, grain="x", skip={"+y"})
        ia, ib = xl + st, xr - st
        ja, jb = za + bot, zb - topr
        mw = 0.019
        for c in range(1, cols):
            mx = ia + (ib - ia) * c / cols
            box(b, mx - mw / 2, y0 + 0.004, ja, mx + mw / 2, y1 - 0.006, jb, sash_mat, grain="z", skip={"+y"})
        for r in range(1, rows):
            mz = ja + (jb - ja) * r / rows
            box(b, ia, y0 + 0.004, mz - mw / 2, ib, y1 - 0.006, mz + mw / 2, sash_mat, grain="x", skip={"+y"})
    glass_quad(b, xl, xr, zs, zt, 0.098)
    if bars:
        n = max(3, int(w / 0.11))
        for i in range(1, n):
            bx = xl + (xr - xl) * i / n
            cyl(b, (bx, -0.004, zs + 0.01), (bx, -0.004, zt - 0.01), 0.011, "ironBlack", n=6)
        for zz in (zs + 0.12, zt - 0.12):
            box(b, xl - 0.02, -0.012, zz - 0.02, xr + 0.02, 0.0, zz + 0.02, "ironBlack")
    if shutters:
        smat = shutters
        sw = w / 2 + casing * 0.3
        for side in (-1, 1):
            xa = xl - casing - 0.02 - sw if side < 0 else xr + casing + 0.02
            louvred_shutter(b, xa, xa + sw, zs - 0.01, zt + 0.02, smat)
    return (xl - casing + 0.012, xr + casing - 0.012, zs - 0.045 - 0.085 + 0.01, zt + head - 0.012)


def glass_quad(b, x0, x1, z0, z1, y):
    b.face([(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)], [(0, 0), (1, 0), (1, 1), (0, 1)], "glass")


def louvred_shutter(b, x0, x1, z0, z1, mat):
    y0, y1 = -0.075, -0.05
    st = 0.05
    box(b, x0, y0, z0, x0 + st, y1, z1, mat, grain="z", skip={"+y"})
    box(b, x1 - st, y0, z0, x1, y1, z1, mat, grain="z", skip={"+y"})
    box(b, x0 + st, y0, z0, x1 - st, y1, z0 + 0.07, mat, grain="x", skip={"+y"})
    box(b, x0 + st, y0, z1 - 0.06, x1 - st, y1, z1, mat, grain="x", skip={"+y"})
    zm = (z0 + z1) / 2
    box(b, x0 + st, y0, zm - 0.03, x1 - st, y1, zm + 0.03, mat, grain="x", skip={"+y"})
    # slats
    pitch = 0.05
    for lo, hi in ((z0 + 0.07, zm - 0.03), (zm + 0.03, z1 - 0.06)):
        n = max(1, int((hi - lo) / pitch))
        for i in range(n):
            zz = lo + (i + 0.5) * (hi - lo) / n
            o = Vector((x0 + st, y0 + 0.004, zz - 0.022))
            obox(b, o, (x1 - x0 - 2 * st, 0, 0), (0, 0.016, 0.012), (0, -0.006, 0.042), mat, grain=0, skip={"-x", "+x"})
    # back board so the slats are not see-through
    box(b, x0 + st, y1 - 0.004, z0 + 0.07, x1 - st, y1, z1 - 0.06, "paintDark", skip={"+y", "-x", "+x", "-z", "+z"})


def panel_door(b, xl, xr, zf, h, mat, style="4", y_front=0.075, glass_top=False, knob=True, rails=None):
    """Stile-and-rail door leaf between xl and xr from zf, recessed into the opening."""
    y0, y1 = y_front, y_front + 0.045
    w = xr - xl
    st = min(0.12, w * 0.16)
    br, tr, lr = 0.22, 0.12, 0.18
    zl = zf + 0.88
    slab_top = zl + lr if glass_top else zf + h
    box(b, xl, y0 + 0.02, zf, xr, y1, slab_top, mat, grain="z", skip={"+y", "-x", "+x", "-z", "+z"})  # back slab
    box(b, xl, y0, zf, xl + st, y0 + 0.02, zf + h, mat, grain="z", skip={"+y"})
    box(b, xr - st, y0, zf, xr, y0 + 0.02, zf + h, mat, grain="z", skip={"+y"})
    box(b, xl + st, y0, zf, xr - st, y0 + 0.02, zf + br, mat, grain="x", skip={"+y"})
    box(b, xl + st, y0, zf + h - tr, xr - st, y0 + 0.02, zf + h, mat, grain="x", skip={"+y"})
    box(b, xl + st, y0, zl, xr - st, y0 + 0.02, zl + lr, mat, grain="x", skip={"+y"})
    mid = style in ("4", "6") and w > 0.6
    if mid:
        box(b, (xl + xr) / 2 - st * 0.45, y0, zf + br, (xl + xr) / 2 + st * 0.45, y0 + 0.02, zl, mat, grain="z", skip={"+y"})
        if not glass_top:
            box(b, (xl + xr) / 2 - st * 0.45, y0, zl + lr, (xl + xr) / 2 + st * 0.45, y0 + 0.02, zf + h - tr, mat, grain="z", skip={"+y"})
    # raised panel fields
    cols = [(xl + st, (xl + xr) / 2 - st * 0.45), ((xl + xr) / 2 + st * 0.45, xr - st)] if mid else [(xl + st, xr - st)]
    for a, c in cols:
        box(b, a + 0.035, y0 + 0.008, zf + br + 0.035, c - 0.035, y0 + 0.02, zl - 0.035, mat, grain="z", skip={"+y"})
    if glass_top:
        a, c = xl + st, xr - st
        glass_quad(b, a, c, zl + lr, zf + h - tr, y0 + 0.03)
        mw = 0.02
        box(b, (a + c) / 2 - mw / 2, y0 + 0.004, zl + lr, (a + c) / 2 + mw / 2, y0 + 0.024, zf + h - tr, mat, grain="z", skip={"+y"})
        box(b, a, y0 + 0.004, (zl + lr + zf + h - tr) / 2 - mw / 2, c, y0 + 0.024, (zl + lr + zf + h - tr) / 2 + mw / 2, mat, grain="x", skip={"+y"})
    else:
        for a, c in cols:
            box(b, a + 0.035, y0 + 0.008, zl + lr + 0.035, c - 0.035, y0 + 0.02, zf + h - tr - 0.035, mat, grain="z", skip={"+y"})
    if knob:
        kx = xr - 0.075 if rails is None else rails
        cyl(b, (kx, y0, zf + 0.95), (kx, y0 - 0.06, zf + 0.95), 0.026, "ironBlack", n=8)
        box(b, kx - 0.02, y0 - 0.008, zf + 0.85, kx + 0.02, y0, zf + 1.02, "ironBlack")


def door(b, xc, zf, w, h, trim_mat, leaf_mat, transom=0.0, double=False, glass_top=False, casing=0.11, head=0.16, leaf=True, reveal=0.16, casings=True):
    """Door with casings, head and drip cap, threshold, optional transom light. Returns the siding hole."""
    xl, xr = xc - w / 2, xc + w / 2
    zt = zf + h + (transom + 0.05 if transom else 0.0)
    if not casings:
        casing = head = 0.0
    else:
        trim(b, xl - casing, xl, zf, zt, trim_mat)
        trim(b, xr, xr + casing, zf, zt, trim_mat)
        trim(b, xl - casing, xr + casing, zt, zt + head, trim_mat)
        trim(b, xl - casing - 0.025, xr + casing + 0.025, zt + head, zt + head + 0.028, trim_mat, y0=TRIM_Y0 - 0.035, y1=TRIM_Y1, skip=())
    box(b, xl - 0.01, -0.05, zf - 0.03, xr + 0.01, reveal, zf + 0.012, trim_mat, grain="x", skip={"+y", "-z"})
    poly(b, [(xl, TRIM_Y1, zf), (xl, reveal, zf), (xl, reveal, zt), (xl, TRIM_Y1, zt)], trim_mat)
    poly(b, [(xr, reveal, zf), (xr, TRIM_Y1, zf), (xr, TRIM_Y1, zt), (xr, reveal, zt)], trim_mat)
    poly(b, [(xl, TRIM_Y1, zt), (xl, reveal, zt), (xr, reveal, zt), (xr, TRIM_Y1, zt)], trim_mat)
    if transom:
        box(b, xl, 0.02, zf + h, xr, 0.12, zf + h + 0.05, trim_mat, grain="x", skip={"+y"})
        glass_quad(b, xl, xr, zf + h + 0.05, zt, 0.1)
        box(b, xl, 0.06, zf + h + 0.05, xr, 0.09, zf + h + 0.09, leaf_mat, grain="x", skip={"+y"})
        box(b, xl, 0.06, zt - 0.04, xr, 0.09, zt, leaf_mat, grain="x", skip={"+y"})
        if w > 1.0:
            box(b, xc - 0.012, 0.064, zf + h + 0.05, xc + 0.012, 0.088, zt, leaf_mat, grain="z", skip={"+y"})
    if leaf:
        if double:
            panel_door(b, xl, xc - 0.003, zf, h, leaf_mat, glass_top=glass_top, rails=xc - 0.08)
            panel_door(b, xc + 0.003, xr, zf, h, leaf_mat, glass_top=glass_top, rails=xc + 0.08)
        else:
            panel_door(b, xl, xr, zf, h, leaf_mat, glass_top=glass_top)
    return (xl - casing + 0.012, xr + casing - 0.012, zf - 0.2, zt + head - 0.012)


def storefront(b, x0, x1, zf, mat_trim, mat_frame, mat_door, door_w=1.5, h_win=2.25, bulk=0.62, transom=0.45, lights=2):
    """Commercial front: pilasters, panelled bulkheads, display windows (one glass quad per light), a
    transom band and a central pair of glazed doors. Returns the siding hole."""
    pil = 0.2
    xc = (x0 + x1) / 2
    ztop = zf + bulk + 0.06 + h_win + 0.06 + transom + 0.08
    # pilasters with base blocks and caps
    for xa in (x0, x1 - pil):
        trim(b, xa, xa + pil, zf, ztop, mat_trim, y0=-0.07)
        trim(b, xa - 0.015, xa + pil + 0.015, zf, zf + 0.25, mat_trim, y0=-0.085, skip=("+y",))
        trim(b, xa - 0.02, xa + pil + 0.02, ztop - 0.12, ztop, mat_trim, y0=-0.09, skip=("+y",))
    # head band
    trim(b, x0 + pil, x1 - pil, ztop - 0.18, ztop, mat_trim, y0=-0.06)
    dl, dr = xc - door_w / 2, xc + door_w / 2
    for a, c in ((x0 + pil, dl - 0.1), (dr + 0.1, x1 - pil)):
        if c - a < 0.4:
            continue
        # bulkhead: frame + recessed panels
        yb = 0.04
        box(b, a, yb, zf, c, yb + 0.04, zf + bulk, mat_frame, grain="x", skip={"+y"})
        npnl = max(1, int((c - a) / 0.9))
        for i in range(npnl):
            pa = a + (c - a) * i / npnl + 0.07
            pc = a + (c - a) * (i + 1) / npnl - 0.07
            box(b, pa, yb - 0.012, zf + 0.12, pc, yb, zf + bulk - 0.1, mat_frame, grain="x", skip={"+y"})
        for i in range(npnl + 1):
            px = a + (c - a) * i / npnl
            box(b, px - 0.05, yb - 0.025, zf, px + 0.05, yb, zf + bulk, mat_frame, grain="z", skip={"+y"})
        box(b, a, yb - 0.025, zf + bulk - 0.1, c, yb, zf + bulk, mat_frame, grain="x", skip={"+y"})
        # sill
        obox(b, Vector((a - 0.02, yb - 0.09, zf + bulk)), (c - a + 0.04, 0, 0), (0, 0.15, 0.012), (0, 0, 0.05), mat_trim, grain=0)
        # display lights
        zw0, zw1 = zf + bulk + 0.05, zf + bulk + 0.05 + h_win
        fr = 0.065
        box(b, a, 0.02, zw0, a + fr, 0.1, zw1, mat_frame, grain="z", skip={"+y"})
        box(b, c - fr, 0.02, zw0, c, 0.1, zw1, mat_frame, grain="z", skip={"+y"})
        box(b, a, 0.02, zw1 - fr, c, 0.1, zw1, mat_frame, grain="x", skip={"+y"})
        inner = (a + fr, c - fr)
        for i in range(lights):
            ga = inner[0] + (inner[1] - inner[0]) * i / lights
            gc = inner[0] + (inner[1] - inner[0]) * (i + 1) / lights
            glass_quad(b, ga + (0.025 if i else 0), gc - (0.025 if i < lights - 1 else 0), zw0, zw1 - fr, 0.075)
            if i:
                box(b, ga - 0.03, 0.02, zw0, ga + 0.03, 0.1, zw1 - fr, mat_frame, grain="z", skip={"+y"})
        # transom lights
        zt0 = zw1 + 0.03
        zt1 = zt0 + transom
        box(b, a, 0.02, zw1, c, 0.1, zt0, mat_frame, grain="x", skip={"+y"})
        nt = max(2, int((c - a) / 0.55))
        for i in range(nt):
            ga = a + (c - a) * i / nt
            gc = a + (c - a) * (i + 1) / nt
            glass_quad(b, ga + 0.03, gc - 0.03, zt0, zt1, 0.085)
            box(b, ga - 0.03, 0.03, zt0, ga + 0.03, 0.1, zt1, mat_frame, grain="z", skip={"+y"})
        box(b, c - 0.03, 0.03, zt0, c, 0.1, zt1, mat_frame, grain="z", skip={"+y"})
        box(b, a, 0.02, zt1, c, 0.1, zt1 + 0.05, mat_frame, grain="x", skip={"+y"})
        # reveals
        poly(b, [(a, -0.06, zw0), (a, 0.1, zw0), (a, 0.1, zt1), (a, -0.06, zt1)], mat_trim)
        poly(b, [(c, 0.1, zw0), (c, -0.06, zw0), (c, -0.06, zt1), (c, 0.1, zt1)], mat_trim)
    # door posts between the windows and the doors
    for a, c in ((dl - 0.1, dl), (dr, dr + 0.1)):
        trim(b, a, c, zf, ztop - 0.18, mat_trim, y0=-0.06)
    door(b, xc, zf, door_w, bulk + 0.11 + h_win, mat_trim, mat_door, transom=transom, double=True, glass_top=True, casings=False)
    # infill above the door posts up to the head band
    return (x0 + 0.01, x1 - 0.01, zf - 0.3, ztop - 0.01)


def bracket(b, x, z_top, proj, h, mat, width=0.07, y_wall=-0.03, scroll=True):
    """Scroll bracket under a cornice or eave: a profile in the (y, z) plane extruded along x."""
    pts = []
    pts.append((0.0, 0.0))
    n = 7
    # top edge (under the cornice) from the wall out to proj, then down a short nose, then a concave
    # sweep back to the wall at the bottom
    pts.append((-proj, 0.0))
    pts.append((-proj, -0.06))
    for i in range(1, n + 1):
        t = i / n
        yy = -proj + (proj - 0.04) * (1 - math.cos(t * math.pi / 2))
        zz = -0.06 - (h - 0.1) * math.sin(t * math.pi / 2) ** 1.3
        pts.append((yy, zz))
    pts.append((0.0, -h))
    # profile in (y, z) -> polygon CCW about +x
    pts2 = [(-y, z) for y, z in pts]  # mirror so the extrusion runs along +x with CCW orientation
    area = sum(pts2[i][0] * pts2[(i + 1) % len(pts2)][1] - pts2[(i + 1) % len(pts2)][0] * pts2[i][1] for i in range(len(pts2)))
    if area < 0:
        pts2 = list(reversed(pts2))
    # ax = -y (out of the wall), ay = +z; extrusion along ax x ay = (0,-1,0)x(0,0,1) = (-1,0,0)
    prism(b, pts2, (x + width / 2, y_wall, z_top), (0, -1, 0), (0, 0, 1), width, mat)


def cornice(b, x0, x1, z, mat, proj=0.32, brackets=0, bracket_mat=None, frieze=0.34, returns=True):
    """Box cornice at the top z of a false front or wall: frieze, bed moulding, crown, cap."""
    ret = proj if returns else 0.0
    trim(b, x0, x1, z - frieze, z - 0.06, mat, y0=-0.06, y1=-0.01)
    trim(b, x0 - 0.05, x1 + 0.05, z - 0.1, z - 0.02, mat, y0=-0.12, y1=-0.01, skip=())
    obox(b, Vector((x0 - ret * 0.7, -proj * 0.75, z - 0.02)), (x1 - x0 + 1.4 * ret, 0, 0), (0, proj * 0.75 + 0.0, 0), (0, 0, 0.1), mat, grain=0)
    obox(b, Vector((x0 - ret, -proj, z + 0.08)), (x1 - x0 + 2 * ret, 0, 0), (0, proj + 0.01, 0), (0, 0, 0.06), mat, grain=0)
    obox(b, Vector((x0 - ret + 0.02, -proj + 0.02, z + 0.14)), (x1 - x0 + 2 * ret - 0.04, 0, 0), (0, proj - 0.01, 0), (0, 0, 0.035), mat, grain=0)
    if brackets:
        bm = bracket_mat or mat
        for i in range(brackets):
            bx = x0 + 0.06 + (x1 - x0 - 0.12) * (i / max(1, brackets - 1))
            bracket(b, bx, z - 0.02, proj * 0.72, 0.5, bm, y_wall=-0.06)


def railing(b, x0, x1, zf, mat, h=0.98, y=0.0, spacing=0.115, bal=0.038, posts=(), post_w=0.12, cap_mat=None):
    """Porch/balcony railing along x at depth y: bottom rail, square balusters, top rail with cap."""
    cm = cap_mat or mat
    box(b, x0, y - 0.03, zf + 0.07, x1, y + 0.03, zf + 0.13, mat, grain="x")
    box(b, x0, y - 0.035, zf + h - 0.08, x1, y + 0.035, zf + h - 0.03, mat, grain="x")
    box(b, x0, y - 0.055, zf + h - 0.03, x1, y + 0.055, zf + h, cm, grain="x")
    n = max(1, int((x1 - x0) / spacing))
    for i in range(n):
        bx = x0 + (x1 - x0) * (i + 0.5) / n
        if any(abs(bx - px) < post_w * 0.5 + bal for px in posts):
            continue
        box(b, bx - bal / 2, y - bal / 2, zf + 0.13, bx + bal / 2, y + bal / 2, zf + h - 0.08, mat, grain="z", skip={"-z", "+z"}, jitter=0.4)


def stair(b, o, d, width, rise, run, n, mat, tread_mat=None, rail=False, rail_side=1):
    """Open stair from o (bottom, centre of the first nosing) climbing along horizontal d by rise."""
    o = Vector(o)
    d = Vector((d[0], d[1], 0)).normalized()
    s = Vector((-d.y, d.x, 0))
    tm = tread_mat or mat
    rr = rise / n
    rn = run / n
    for side in (-1, 1):
        p0 = o + s * side * (width / 2 - 0.025) + Vector((0, 0, -0.05))
        p1 = p0 + d * run + Vector((0, 0, rise))
        beam(b, p0 + Vector((0, 0, -0.1)), p1 + Vector((0, 0, -0.06)), 0.05, 0.26, mat, up=(0, 0, 1))
    for i in range(n):
        c = o + d * (rn * (i + 0.5)) + Vector((0, 0, rr * (i + 1)))
        orig = c - s * (width / 2) - d * (rn * 0.5 + 0.03) - Vector((0, 0, 0.04))
        obox(b, orig, s * width, d * (rn + 0.03), (0, 0, 0.04), tm, grain=0)
    if rail:
        side = rail_side
        base = o + s * side * (width / 2 - 0.02)
        p0 = base + Vector((0, 0, 0.95))
        p1 = base + d * run + Vector((0, 0, rise + 0.95))
        beam(b, p0, p1, 0.06, 0.06, mat)
        for i in range(0, n + 1, max(1, n // 3)):
            q = base + d * (rn * i) + Vector((0, 0, rr * i))
            beam(b, q, q + Vector((0, 0, 0.95 + rr * 0.5)), 0.08, 0.08, mat)


def stovepipe(b, x, y, z_roof, h, r=0.08, mat="ironRust"):
    cyl(b, (x, y, z_roof - 0.3), (x, y, z_roof + h), r, mat, n=10)
    cyl(b, (x, y, z_roof - 0.02), (x, y, z_roof + 0.12), r * 1.9, "ironRust", n=10, r1=r * 1.15)
    # rain cap on three legs
    top = z_roof + h
    lathe(b, [(r * 2.2, top + 0.1), (r * 0.15, top + 0.2)], mat, n=10, o=(x, y, 0), cap_top=False)
    lathe(b, [(r * 0.15, top + 0.2), (r * 2.2, top + 0.1)], mat, n=10, o=(x, y, 0), cap_top=False)
    for i in range(3):
        a = 2 * math.pi * i / 3
        px, py = x + math.cos(a) * r * 0.9, y + math.sin(a) * r * 0.9
        box(b, px - 0.008, py - 0.008, top - 0.01, px + 0.008, py + 0.008, top + 0.11, mat)


def chimney_stone(b, x0, y0, x1, y1, z0, z1, cap=True):
    """Rubble sandstone chimney with a projecting cap course."""
    box(b, x0, y0, z0, x1, y1, z1, "stone", grain="x")
    if cap:
        box(b, x0 - 0.06, y0 - 0.06, z1, x1 + 0.06, y1 + 0.06, z1 + 0.14, "stone", grain="x")
        box(b, x0 + 0.08, y0 + 0.08, z1 + 0.14, x1 - 0.08, y1 - 0.08, z1 + 0.2, "stone", grain="x")


# ------------------------------------------------------------------------------- larger assemblies (local)
# Building space: x along the facade (right), y into the building (the facade sheathing plane is y = 0),
# z up from the street (ground = 0).


def boardwalk(b, x0, x1, y_front, h, y_back=0.0, steps=(), end_steps=(True, True), mat="boardwalk", frame="woodRaw", gaps=True):
    """Boardwalk of individual planks (running toward the street) on joists, posts and a rim board,
    with steps down to the street at the given x centres (and optionally at both ends)."""
    rng = b.rng
    th = 0.042
    depth = y_back - y_front
    nj = max(2, int(depth / 0.85) + 1)
    for i in range(nj):
        jy = y_front + 0.08 + (depth - 0.16) * i / (nj - 1)
        box(b, x0 + 0.02, jy - 0.035, h - th - 0.19, x1 - 0.02, jy + 0.035, h - th, frame, grain="x", skip={"-z"})
        # sleeper posts under the joists
        npst = max(2, int((x1 - x0) / 1.9) + 1)
        for k in range(npst):
            px = x0 + 0.15 + (x1 - x0 - 0.3) * k / (npst - 1)
            box(b, px - 0.06, jy - 0.06, -0.25, px + 0.06, jy + 0.06, h - th - 0.19, frame, grain="z", skip={"-z"}, jitter=0.8)
    # rim / fascia board along the street edge
    box(b, x0, y_front - 0.035, h - th - 0.24, x1, y_front, h - th + 0.005, frame, grain="x", skip={"+y"})
    x = x0
    while x < x1 - 0.03:
        w = rng.uniform(0.15, 0.25)
        if x1 - (x + w) < 0.1:
            w = x1 - x
        xe = min(x1, x + w)
        gap = rng.uniform(0.004, 0.009) if gaps else 0.0
        yf = y_front - rng.uniform(0.0, 0.03)
        dz = rng.uniform(-0.004, 0.003)
        if rng.random() < 0.18:
            # two boards butted over a joist
            cut = y_front + depth * rng.uniform(0.35, 0.65)
            box(b, x, yf, h - th + dz, xe - gap, cut - 0.003, h + dz, mat, grain="y", skip={"-z"}, jitter=0.3)
            box(b, x, cut + 0.003, h - th + dz * 0.5, xe - gap, y_back, h + dz * 0.5, mat, grain="y", skip={"-z", "+y"}, jitter=0.3)
        else:
            box(b, x, yf, h - th + dz, xe - gap, y_back, h + dz, mat, grain="y", skip={"-z", "+y"}, jitter=0.25)
        x = xe
    for sx in steps:
        step_block(b, sx - 0.8, sx + 0.8, y_front, h, mat, frame, direction=-1)
    if end_steps[0]:
        side_steps(b, x0, y_front, y_back, h, mat, frame, -1)
    if end_steps[1]:
        side_steps(b, x1, y_front, y_back, h, mat, frame, 1)


def step_block(b, xa, xb, y_front, h, mat, frame, direction=-1):
    """Steps down from a boardwalk edge toward the street (-y)."""
    n = max(1, int(round(h / 0.17)))
    rise = h / n
    run = 0.28
    for i in range(1, n + 1):
        zt = h - rise * i
        yb = y_front - run * i
        box(b, xa, yb, zt - 0.04, xb, yb + run + 0.02, zt, mat, grain="x", skip={"-z"}, jitter=0.3)
        box(b, xa + 0.02, yb + 0.03, -0.1, xb - 0.02, yb + run, zt - 0.04, frame, grain="x", skip={"-z"})
    for sx in (xa + 0.05, xb - 0.05):
        p0 = Vector((sx, y_front - run * n - 0.05, -0.05))
        p1 = Vector((sx, y_front, h - 0.06))
        beam(b, p0, p1, 0.05, 0.22, frame)


def side_steps(b, x_edge, y_front, y_back, h, mat, frame, side):
    n = max(1, int(round(h / 0.17)))
    rise = h / n
    run = 0.28
    for i in range(1, n + 1):
        zt = h - rise * i
        xa = x_edge + side * run * (i - 1)
        xb = x_edge + side * run * i
        box(b, min(xa, xb) - 0.01, y_front + 0.02, zt - 0.04, max(xa, xb) + 0.01, y_back - 0.05, zt, mat, grain="y", skip={"-z"}, jitter=0.3)
        box(b, min(xa, xb), y_front + 0.05, -0.1, max(xa, xb), y_back - 0.08, zt - 0.04, frame, grain="y", skip={"-z"})


def shed_porch(b, x0, x1, y_wall, y_post, z_wall, z_front, z_deck, posts, mat_post, mat_frame, roof="tinRusty",
               braces=True, sheath="woodRaw", fascia_mat=None, overhang=0.35, post_w=0.14, ledger=True):
    """Porch roof: posts with base blocks and knee braces, a plate beam, rafters from a wall ledger,
    sheathing boards, a fascia and a tin or shake cover."""
    fm = fascia_mat or mat_frame
    rise = z_wall - z_front
    run = y_wall - y_post
    slope = rise / run
    beam_h = 0.22
    zb_top = z_front
    for px in posts:
        box(b, px - post_w / 2, y_post - post_w / 2, z_deck, px + post_w / 2, y_post + post_w / 2, zb_top - beam_h, mat_post, grain="z", skip={"-z"}, jitter=0.25)
        box(b, px - post_w / 2 - 0.02, y_post - post_w / 2 - 0.02, z_deck, px + post_w / 2 + 0.02, y_post + post_w / 2 + 0.02, z_deck + 0.12, mat_post, skip={"-z"})
        box(b, px - post_w / 2 - 0.015, y_post - post_w / 2 - 0.015, zb_top - beam_h - 0.06, px + post_w / 2 + 0.015, y_post + post_w / 2 + 0.015, zb_top - beam_h, mat_post)
        if braces:
            for sd in (-1, 1):
                if (sd < 0 and px - 0.7 < x0) or (sd > 0 and px + 0.7 > x1):
                    continue
                p0 = Vector((px + sd * post_w / 2, y_post, zb_top - beam_h - 0.62))
                p1 = Vector((px + sd * 0.66, y_post, zb_top - beam_h + 0.02))
                beam(b, p0, p1, 0.09, 0.07, mat_post, up=(0, 1, 0))
    # plate beam
    box(b, x0, y_post - 0.09, zb_top - beam_h, x1, y_post + 0.09, zb_top, mat_frame, grain="x")
    if ledger:
        box(b, x0, y_wall - 0.06, z_wall - 0.22, x1, y_wall - 0.005, z_wall, mat_frame, grain="x", skip={"+y"})
    # rafters: bearing on the plate beam and on the wall ledger
    y_end = y_post - overhang
    nr = max(2, int((x1 - x0) / 0.61) + 1)
    rh = 0.14
    zc = lambda yy: zb_top + rh / 2 + slope * (yy - y_post)  # noqa: E731
    for i in range(nr):
        rx = x0 + 0.03 + (x1 - x0 - 0.06) * i / (nr - 1)
        p0 = Vector((rx, y_wall - 0.06, zc(y_wall - 0.06)))
        p1 = Vector((rx, y_end, zc(y_end)))
        beam(b, p0, p1, 0.05, rh, mat_frame, up=(0, 0, 1))
    # sheathing boards on the rafters (visible from below), running along x
    z_at = lambda yy: zb_top + rh + slope * (yy - y_post)  # noqa: E731
    yy = y_wall - 0.06
    while yy > y_end + 0.01:
        bw = b.rng.uniform(0.16, 0.24)
        ya = max(y_end, yy - bw)
        o = Vector((x0 - 0.02, ya, z_at(ya)))
        ey = Vector((0, yy - ya - 0.004, (yy - ya - 0.004) * slope))
        obox(b, o, (x1 - x0 + 0.04, 0, 0), ey, (0, 0, 0.022), sheath, grain=0)
        yy = ya
    # fascia at the rafter ends
    zf = z_at(y_end)
    box(b, x0 - 0.03, y_end - 0.028, zf - 0.17, x1 + 0.03, y_end, zf + 0.03, fm, grain="x")
    # end rafters / barge boards on the sides
    for xx in (x0 - 0.03, x1 + 0.005):
        p0 = Vector((xx + 0.0125, y_wall - 0.03, z_at(y_wall - 0.03) - 0.08))
        p1 = Vector((xx + 0.0125, y_end - 0.02, zf - 0.08))
        beam(b, p0, p1, 0.025, 0.18, fm, up=(0, 0, 1))
    # cover
    roof_cover(b, x0 - 0.04, x1 + 0.04, y_end - 0.04, y_wall - 0.02, lambda yy: z_at(yy) + 0.025, roof, downslope=-1)


def roof_cover(b, x0, x1, y_lo, y_hi, zfun, mat, downslope=-1, sheet=0.66, lap=0.0, along="y"):
    """Roof covering over the rectangle (x0..x1, y_lo..y_hi) following z = zfun(y) (or zfun(x) when
    along == 'x'). Tin: overlapping sheets with the corrugations down the slope. woodRaw: shake courses."""
    rng = b.rng
    t = TEXOF.get(mat)
    if mat in ("tinRusty", "tinGalv"):
        if along == "y":
            x = x0
            k = 0
            while x < x1 - 0.01:
                xe = min(x1, x + sheet)
                dz = 0.0
                u0 = rng.random()
                pts = [(x, y_lo, zfun(y_lo) + dz), (xe + lap * (xe < x1), y_lo, zfun(y_lo) + dz),
                       (xe + lap * (xe < x1), y_hi, zfun(y_hi) + dz), (x, y_hi, zfun(y_hi) + dz)]
                L = math.hypot(y_hi - y_lo, zfun(y_hi) - zfun(y_lo))
                W = xe - x + lap
                uv = [(u0, 0), (u0 + W / t.size, 0), (u0 + W / t.size, L / t.size), (u0, L / t.size)]
                b.face(pts, uv, mat)
                # sheet edge drip at the low end
                ylow = y_lo if downslope < 0 else y_hi
                zl = zfun(ylow) + dz
                edge = [(x, ylow, zl - 0.012), (xe, ylow, zl - 0.012), (xe, ylow, zl), (x, ylow, zl)]
                if downslope > 0:
                    edge = [edge[1], edge[0], edge[3], edge[2]]
                b.face(edge, [(0, 0), (0.1, 0), (0.1, 0.01), (0, 0.01)], mat)
                x = xe
                k += 1
        else:
            y = y_lo
            k = 0
            while y < y_hi - 0.01:
                ye = min(y_hi, y + sheet)
                dz = 0.0
                u0 = rng.random()
                L = math.hypot(x1 - x0, zfun(x1) - zfun(x0))
                W = ye - y + lap
                yy1 = ye + lap * (ye < y_hi)
                pts = [(x0, y, zfun(x0) + dz), (x1, y, zfun(x1) + dz), (x1, yy1, zfun(x1) + dz), (x0, yy1, zfun(x0) + dz)]
                uv = [(u0, 0), (u0, L / t.size), (u0 + W / t.size, L / t.size), (u0 + W / t.size, 0)]
                nrm = (Vector(pts[1]) - Vector(pts[0])).cross(Vector(pts[3]) - Vector(pts[0]))
                if nrm.z < 0:
                    pts = list(reversed(pts))
                    uv = list(reversed(uv))
                b.face(pts, uv, mat)
                xlow = x0 if zfun(x0) < zfun(x1) else x1
                zl = zfun(xlow) + dz
                edge = [(xlow, y, zl - 0.012), (xlow, ye, zl - 0.012), (xlow, ye, zl), (xlow, y, zl)]
                en = (Vector(edge[1]) - Vector(edge[0])).cross(Vector(edge[3]) - Vector(edge[0]))
                if (en.x > 0) != (xlow > (x0 + x1) / 2):
                    edge = list(reversed(edge))
                b.face(edge, [(0, 0), (0.1, 0), (0.1, 0.01), (0, 0.01)], mat)
                y = ye
                k += 1
        return
    # shake / shingle courses: each course a strip with a visible butt, texture grain down the slope
    expo = 0.22
    if along == "y":
        ylow, yhigh = (y_lo, y_hi) if downslope < 0 else (y_hi, y_lo)
        L = abs(yhigh - ylow)
        n = max(1, int(L / expo))
        for i in range(n):
            ya = ylow + (yhigh - ylow) * i / n
            yb = ylow + (yhigh - ylow) * (i + 1) / n
            th = 0.018
            za, zb = zfun(ya) + th, zfun(yb)
            strip = rng.choice(t.strips) if t.strips else None
            u0 = rng.random()
            sl = math.hypot(yb - ya, zb - za)
            pts = [(x0, ya, za), (x1, ya, za), (x1, yb, zb + 0.004), (x0, yb, zb + 0.004)]
            W = x1 - x0
            uv = [(u0, 0), (u0 + W / t.size, 0), (u0 + W / t.size, sl / t.size), (u0, sl / t.size)]
            nrm = (Vector(pts[1]) - Vector(pts[0])).cross(Vector(pts[3]) - Vector(pts[0]))
            if nrm.z < 0:
                pts = list(reversed(pts))
                uv = list(reversed(uv))
            b.face(pts, uv, mat)
            butt = [(x0, ya, za - th - 0.004), (x1, ya, za - th - 0.004), (x1, ya, za), (x0, ya, za)]
            bn = (Vector(butt[1]) - Vector(butt[0])).cross(Vector(butt[3]) - Vector(butt[0]))
            if (bn.y > 0) != (yhigh < ylow):
                butt = list(reversed(butt))
            b.face(butt, [(u0, 0), (u0 + W / t.size, 0), (u0 + W / t.size, 0.01), (u0, 0.01)], mat)
    else:
        xlow, xhigh = (x0, x1) if zfun(x0) < zfun(x1) else (x1, x0)
        L = abs(xhigh - xlow)
        n = max(1, int(L / expo))
        for i in range(n):
            xa = xlow + (xhigh - xlow) * i / n
            xb = xlow + (xhigh - xlow) * (i + 1) / n
            th = 0.018
            za, zb = zfun(xa) + th, zfun(xb)
            u0 = rng.random()
            sl = math.hypot(xb - xa, zb - za)
            W = y_hi - y_lo
            pts = [(xa, y_lo, za), (xa, y_hi, za), (xb, y_hi, zb + 0.004), (xb, y_lo, zb + 0.004)]
            uv = [(u0, 0), (u0 + W / t.size, 0), (u0 + W / t.size, sl / t.size), (u0, sl / t.size)]
            nrm = (Vector(pts[1]) - Vector(pts[0])).cross(Vector(pts[3]) - Vector(pts[0]))
            if nrm.z < 0:
                pts = list(reversed(pts))
                uv = list(reversed(uv))
            b.face(pts, uv, mat)
            butt = [(xa, y_lo, za - th - 0.004), (xa, y_hi, za - th - 0.004), (xa, y_hi, za), (xa, y_lo, za)]
            bn = (Vector(butt[1]) - Vector(butt[0])).cross(Vector(butt[3]) - Vector(butt[0]))
            if (bn.x > 0) != (xhigh < xlow):
                butt = list(reversed(butt))
            b.face(butt, [(u0, 0), (u0 + W / t.size, 0), (u0 + W / t.size, 0.01), (u0, 0.01)], mat)


def gable_roof_y(b, x0, x1, y0, y1, z_eave, pitch, mat, frame="woodRaw", fascia="woodRaw", ov_side=0.3, ov_end=0.2,
                 tails=True, ridge_mat=None, end_front=True):
    """Gable roof with the ridge along y (front to back): rafter tails along the eaves, fascia boards,
    barge boards on the gables, ridge cap and cover."""
    xc = (x0 + x1) / 2
    hw = (x1 - x0) / 2
    tn = math.tan(math.radians(pitch))
    zr = z_eave + hw * tn
    ya, yb = y0 - (ov_end if end_front else 0.0), y1 + ov_end
    th = 0.16  # rafter depth + sheathing
    for side in (-1, 1):
        xe = xc + side * (hw + ov_side)

        def zf(xx, side=side):
            return z_eave + (hw - abs(xx - xc)) * tn + th

        xa, xb = (xe, xc) if side < 0 else (xc, xe)
        roof_cover(b, xa, xb, ya, yb, zf, mat, along="x")
        # sheathing underside / soffit plane (visible at the eave overhang)
        zo = zf(xe) - 0.03
        zi = zf(xc + side * hw) - 0.03
        p = [(xe, ya, zo - 0.02), (xe, yb, zo - 0.02), (xc + side * hw, yb, zi - 0.02), (xc + side * hw, ya, zi - 0.02)]
        if side > 0:
            p = list(reversed(p))
        poly(b, p, frame)
        # fascia
        zfa = zf(xe) - 0.03
        box(b, xe - 0.012 * side - 0.0125, ya, zfa - 0.19, xe - 0.012 * side + 0.0125, yb, zfa + 0.01, fascia, grain="y")
        if tails:
            n = max(2, int((yb - ya) / 0.61))
            for i in range(n + 1):
                yy = ya + 0.05 + (yb - ya - 0.1) * i / n
                p0 = Vector((xc + side * (hw - 0.05), yy, zf(xc + side * (hw - 0.05)) - 0.1))
                p1 = Vector((xe - side * 0.03, yy, zf(xe - side * 0.03) - 0.1))
                beam(b, p0, p1, 0.05, 0.13, frame)
    # barge boards and gable-end rakes
    for yy, keep in ((ya, end_front), (yb, True)):
        if not keep:
            continue
        for side in (-1, 1):
            xe = xc + side * (hw + ov_side)
            p0 = Vector((xc, yy, zr + th + 0.02))
            p1 = Vector((xe, yy, z_eave - ov_side * tn + th + 0.02))
            beam(b, p0 + Vector((0, 0, -0.1)), p1 + Vector((0, 0, -0.1)), 0.03, 0.22, fascia)
    # ridge cap
    rm = ridge_mat or mat
    for side in (-1, 1):
        p = [(xc, ya, zr + th + 0.03), (xc, yb, zr + th + 0.03), (xc + side * 0.16, yb, zr + th + 0.03 - 0.16 * tn + 0.012),
             (xc + side * 0.16, ya, zr + th + 0.03 - 0.16 * tn + 0.012)]
        if side > 0:
            p = list(reversed(p))
        poly(b, p, rm)
    return zr


def gable_wall_fn(x0, x1, z_eave, pitch):
    xc = (x0 + x1) / 2
    hw = (x1 - x0) / 2
    tn = math.tan(math.radians(pitch))
    return lambda x: z_eave + max(0.0, hw - abs(x - xc)) * tn


def interior_box(b, x0, x1, y0, y1, z0, z1, mat_wall="paintDark", mat_floor="boardwalk"):
    """A dark room behind an open doorway (inward-facing faces only)."""
    poly(b, [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)], mat_floor)
    poly(b, [(x0, y1, z0), (x1, y1, z0), (x1, y1, z1), (x0, y1, z1)], mat_wall)
    poly(b, [(x0, y0, z0), (x0, y1, z0), (x0, y1, z1), (x0, y0, z1)], mat_wall)
    poly(b, [(x1, y1, z0), (x1, y0, z0), (x1, y0, z1), (x1, y1, z1)], mat_wall)
    poly(b, [(x0, y1, z1), (x1, y1, z1), (x1, y0, z1), (x0, y0, z1)], mat_wall)


# ------------------------------------------------------------------------------------------- the town

def row_point(row, s, d=0.0):
    """Ground point on a row line at station s, d metres in front of the facade (toward the street)."""
    base = {"A": ROW_A, "B": ROW_B, "C": ROW_C}[row]
    p = base + ROW_DIR * s + ROW_N * d
    return Vector((p.x, p.y, GROUND_Z))


def row_matrix(row, s, d=0.0, extra_rot=0.0):
    return T(*row_point(row, s, d)) @ RZ(FACING_DEG + extra_rot)


class Building:
    def __init__(self, kind, row, s, seed, d=0.0, rot=0.0):
        self.kind = kind
        self.row = row
        self.name = "bld_" + kind
        self.b = MB(self.name, seed)
        self.matrix = row_matrix(row, s, d, rot)
        self.children = []  # (name, MB, pivot (building space))

    def child(self, name, pivot, seed=None):
        mb = MB(name, seed if seed is not None else zlib.crc32(name.encode()))
        self.children.append((name, mb, Vector(pivot)))
        return mb


# ------------------------------------------------------------------------------------- shared assemblies


def balcony(b, x0, x1, y_wall, y_post, z_deck, z_ground, posts, mat_post, mat_frame, rail_mat, deck_mat="boardwalk",
            fascia_mat=None, side_rails=(True, True), rail_cap=None, post_w=0.15, braces=True, rail=True):
    """Balcony / upper gallery on posts: posts with knee braces, plate beam, joists from a wall ledger,
    deck boards, a rim board and railings with square balusters. Returns the beam's underside z."""
    fm = fascia_mat or mat_frame
    th = 0.042
    j_top = z_deck - th
    j_h = 0.2
    beam_top = j_top - j_h
    beam_bot = beam_top - 0.22
    y_rim = y_post - 0.2
    for px in posts:
        box(b, px - post_w / 2, y_post - post_w / 2, z_ground, px + post_w / 2, y_post + post_w / 2, beam_bot, mat_post, grain="z", skip={"-z"}, jitter=0.2)
        box(b, px - post_w / 2 - 0.025, y_post - post_w / 2 - 0.025, z_ground, px + post_w / 2 + 0.025, y_post + post_w / 2 + 0.025, z_ground + 0.14, mat_post, skip={"-z"})
        box(b, px - post_w / 2 - 0.02, y_post - post_w / 2 - 0.02, beam_bot - 0.07, px + post_w / 2 + 0.02, y_post + post_w / 2 + 0.02, beam_bot, mat_post)
        if braces:
            for sd in (-1, 1):
                if (sd < 0 and px - 0.75 < x0) or (sd > 0 and px + 0.75 > x1):
                    continue
                p0 = Vector((px + sd * post_w / 2, y_post, beam_bot - 0.66))
                p1 = Vector((px + sd * 0.7, y_post, beam_bot + 0.02))
                beam(b, p0, p1, 0.09, 0.075, mat_post, up=(0, 1, 0))
    box(b, x0, y_post - 0.1, beam_bot, x1, y_post + 0.1, beam_top, mat_frame, grain="x")
    box(b, x0, y_wall - 0.06, j_top - j_h, x1, y_wall - 0.005, j_top, mat_frame, grain="x", skip={"+y"})
    nj = max(2, int((x1 - x0) / 0.45) + 1)
    for i in range(nj):
        jx = x0 + 0.03 + (x1 - x0 - 0.06) * i / (nj - 1)
        box(b, jx - 0.025, y_rim + 0.03, j_top - j_h, jx + 0.025, y_wall - 0.06, j_top, mat_frame, grain="y")
    # rim board around the deck edge
    box(b, x0 - 0.03, y_rim - 0.03, j_top - j_h - 0.04, x1 + 0.03, y_rim, z_deck + 0.005, fm, grain="x")
    for xx in (x0 - 0.03, x1):
        box(b, xx, y_rim, j_top - j_h - 0.04, xx + 0.03, y_wall - 0.01, z_deck + 0.005, fm, grain="y", skip={"+y"})
    # deck boards along x
    rng = b.rng
    yy = y_rim
    while yy < y_wall - 0.01:
        w = rng.uniform(0.12, 0.17)
        ye = min(y_wall - 0.005, yy + w)
        for a, c in _lumber(rng, x0 - 0.02, x1 + 0.02, 2.5, 4.8):
            box(b, a + 0.002, yy + 0.003, j_top, c - 0.002, ye - 0.003, z_deck + rng.uniform(-0.003, 0.002), deck_mat, grain="x", skip={"-z"}, jitter=0.2)
        yy = ye
    if rail:
        ry = y_rim + 0.07
        railing(b, x0 + 0.02, x1 - 0.02, z_deck, rail_mat, y=ry, posts=posts, cap_mat=rail_cap)
        for px in list(posts) + [x0 + 0.06, x1 - 0.06]:
            box(b, px - 0.06, ry - 0.06, z_deck, px + 0.06, ry + 0.06, z_deck + 1.06, rail_mat, grain="z")
            box(b, px - 0.075, ry - 0.075, z_deck + 1.06, px + 0.075, ry + 0.075, z_deck + 1.1, rail_mat)
        for xx, keep in ((x0 + 0.06, side_rails[0]), (x1 - 0.06, side_rails[1])):
            if not keep:
                continue
            with b.at(Matrix.Translation((xx, 0, 0)) @ RZ(90)):
                # local x runs along +y of the building (from the rim toward the wall)
                railing(b, ry + 0.06, y_wall - 0.04, z_deck, rail_mat, y=0.0, cap_mat=rail_cap)
    return beam_bot


def build_lantern(mb, drop=0.12):
    """Hanging lantern; origin at the hook, the body hangs below it."""
    cyl(mb, (0, 0, 0.0), (0, 0, -drop), 0.006, "ironBlack", n=6)
    box(mb, -0.035, -0.006, -0.03, 0.035, 0.006, 0.0, "ironBlack")
    z = -drop
    lathe(mb, [(0.11, z - 0.095), (0.10, z - 0.085), (0.03, z - 0.03), (0.012, z)], "ironBlack", n=8, cap_top=False)
    zb, zt = z - 0.095, z - 0.38
    s = 0.085
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        px, py = math.cos(a) * s * 1.41, math.sin(a) * s * 1.41
        box(mb, px - 0.008, py - 0.008, zt, px + 0.008, py + 0.008, zb, "ironBlack")
    for i in range(4):
        a0 = i * math.pi / 2
        c, sn = math.cos(a0), math.sin(a0)
        e = Vector((-sn, c, 0)) * s
        n = Vector((c, sn, 0)) * (s - 0.004)
        p = [n - e + Vector((0, 0, zt)), n + e + Vector((0, 0, zt)), n + e + Vector((0, 0, zb)), n - e + Vector((0, 0, zb))]
        mb.face(p, [(0, 0), (1, 0), (1, 1), (0, 1)], "lampGlow")
    lathe(mb, [(0.03, zt + 0.02), (0.035, zt + 0.12), (0.022, zt + 0.2)], "lampGlow", n=8, cap_top=False)
    box(mb, -0.1, -0.1, zt - 0.03, 0.1, 0.1, zt, "ironBlack")
    lathe(mb, [(0.04, zt - 0.1), (0.075, zt - 0.08), (0.07, zt - 0.03)], "ironBlack", n=8, cap_top=False, cap_bot=False)


def build_hanging_sign(mb, w, h, lines, board="paintDark", letter="paintWhite", chain=0.2, frame=None):
    """Sign hung on two chains; origin on the hinge axis (local X) at the top."""
    fr = frame or board
    for sx in (-w / 2 + 0.1, w / 2 - 0.1):
        cyl(mb, (sx - 0.02, 0, 0.0), (sx + 0.02, 0, 0.0), 0.012, "ironBlack", n=6)
        for k in range(int(chain / 0.05)):
            z0 = -0.012 - k * 0.05
            if k % 2 == 0:
                box(mb, sx - 0.004, -0.012, z0 - 0.05, sx + 0.004, 0.012, z0, "ironBlack")
            else:
                box(mb, sx - 0.012, -0.004, z0 - 0.05, sx + 0.012, 0.004, z0, "ironBlack")
    zt = -chain - 0.012
    zb = zt - h
    box(mb, -w / 2, -0.016, zb, w / 2, 0.016, zt, board, grain="x")
    box(mb, -w / 2 - 0.02, -0.024, zb - 0.02, w / 2 + 0.02, 0.024, zb + 0.02, fr, grain="x")
    box(mb, -w / 2 - 0.02, -0.024, zt - 0.02, w / 2 + 0.02, 0.024, zt + 0.02, fr, grain="x")
    box(mb, -w / 2 - 0.02, -0.024, zb + 0.02, -w / 2 + 0.02, 0.024, zt - 0.02, fr, grain="z")
    box(mb, w / 2 - 0.02, -0.024, zb + 0.02, w / 2 + 0.02, 0.024, zt - 0.02, fr, grain="z")
    n = len(lines)
    for i, (text, font, cap) in enumerate(lines):
        zc = zb + h * (n - i - 0.5) / n
        letters(mb, text, font, 0.0, zc, cap, letter, y=-0.016, depth=0.005, max_w=w - 0.14)
        with mb.at(RZ(180)):
            letters(mb, text, font, 0.0, zc, cap, letter, y=-0.016, depth=0.005, max_w=w - 0.14)


def batwing_leaf(mb, w, h, side, mat):
    """One batwing door leaf; origin on the hinge line (local Z), the leaf extends toward +x * side."""
    s = side
    t = 0.017

    def X(a, c):
        return (min(a * s, c * s), max(a * s, c * s))

    st = 0.06
    a0, a1 = X(0.01, 0.01 + st)
    box(mb, a0, -t, 0.0, a1, t, h, mat, grain="z")
    a0, a1 = X(w - 0.05, w)
    box(mb, a0, -t, 0.0, a1, t, h * 0.66, mat, grain="z")
    a0, a1 = X(0.01 + st, w - 0.05)
    box(mb, a0, -t, 0.0, a1, t, 0.13, mat, grain="x")
    box(mb, a0, -t, h * 0.5 - 0.04, a1, t, h * 0.5 + 0.04, mat, grain="x")
    # louvres in the lower panel
    n = 7
    for i in range(n):
        zz = 0.13 + (h * 0.5 - 0.04 - 0.13) * (i + 0.5) / n
        o = Vector((a0, -t * 0.6, zz - 0.03))
        obox(mb, o, (a1 - a0, 0, 0), (0, t * 1.2, 0.012), (0, -0.01, 0.055), mat, grain=0, skip={"-x", "+x"})
    # scalloped upper panel: its top dips from the hinge stile toward the meeting stile
    pts = []
    k = 9
    for i in range(k + 1):
        u = i / k
        xx = (0.01 + st) + (w - 0.05 - 0.01 - st) * u
        zz = h - 0.02 - (h * 0.34 - 0.02) * math.sin(u * math.pi / 2) ** 1.4
        pts.append((xx, zz))
    poly2 = [(0.01 + st, h * 0.5 + 0.04), (w - 0.05, h * 0.5 + 0.04)] + list(reversed(pts))
    if s < 0:
        poly2 = [(-x, z) for x, z in reversed(poly2)]
    # ax = +x, ay = +z -> extrusion along (1,0,0) x (0,0,1) = (0,-1,0)
    prism(mb, poly2, (0, t * 0.55, 0), (1, 0, 0), (0, 0, 1), t * 1.1, mat)
    for zz in (0.2, h - 0.25):
        hx0, hx1 = (-0.03, 0.0) if s > 0 else (0.0, 0.03)
        box(mb, hx0, -t - 0.004, zz, hx1, t + 0.004, zz + 0.1, "ironBlack")


# ------------------------------------------------------------------------------------------- buildings


def build_saloon():
    """The Gilded Spur: two storeys, painted false front with a bracketed cornice, a balcony on posts
    over the boardwalk, batwing doors, lanterns and a hanging sign."""
    B = Building("saloon", "A", 5.0, 101)
    b = B.b
    W, D = 10.0, 16.0
    x0, x1 = -W / 2, W / 2
    zf, z2, ze, zff = 0.5, 4.42, 7.6, 10.0
    pitch = 22.0
    body, side, trm, sash, dark = "paintOxblood", "sidingWeathered", "paintWhite", "paintWhite", "paintDark"
    # ---- front wall
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = []
        holes.append(door(b, 5.0, zf, 1.7, 2.6, trm, "woodVarnish", transom=0.42, leaf=False, reveal=0.16))
        for xc in (2.15, 7.85):
            holes.append(window(b, xc, zf + 0.78, 1.42, 2.1, trm, sash, lights=(2, 2)))
        holes.append(door(b, 5.0, z2 + 0.03, 1.26, 2.28, trm, "woodVarnish", transom=0.36, double=True, glass_top=True))
        for xc in (2.0, 8.0):
            holes.append(window(b, xc, z2 + 0.72, 0.92, 1.78, trm, sash, lights=(2, 1)))
        holes.append((0.5, W - 0.5, 7.88, 9.47))
        lap_siding(b, 0.2, W - 0.2, 0.68, zff - 0.34, body, holes)
        # base board and drip, belt course at the second floor, corner pilasters
        trim(b, 0.0, W, -0.25, 0.68, trm, y0=-0.04, y1=0.0)
        trim(b, -0.02, W + 0.02, 0.66, 0.7, trm, y0=-0.075, y1=-0.03, skip=())
        trim(b, 0.0, W, z2 - 0.18, z2 + 0.06, trm, y0=-0.05, y1=-0.01)
        for xa in (0.0, W - 0.2):
            trim(b, xa - (0.05 if xa == 0 else 0), xa + 0.2 + (0.05 if xa > 0 else 0), 0.68, zff - 0.34, trm, y0=-0.065, y1=0.0)
        # false-front sign: boards, moulded frame, raised lettering
        flush_boards(b, 0.55, W - 0.55, 7.9, 9.45, dark, y0=-0.05, y1=-0.022)
        for (a, c, z0_, z1_) in ((0.45, W - 0.45, 7.82, 7.92), (0.45, W - 0.45, 9.43, 9.53), (0.45, 0.57, 7.92, 9.43), (W - 0.57, W - 0.45, 7.92, 9.43)):
            trim(b, a, c, z0_, z1_, trm, y0=-0.075, y1=-0.03, skip=())
        # gilt letters on a black board
        letters(b, "GILDED SPUR", "rye", 5.0, 9.02, 0.48, "paintMustard", y=-0.05, depth=0.01, max_w=8.4, res=1)
        letters(b, "SALOON", "alfa", 5.0, 8.3, 0.5, "paintWhite", y=-0.05, depth=0.01, max_w=5.8)
        cornice(b, 0.0, W, zff, trm, proj=0.42, brackets=8, frieze=0.34)
        # central nameplate above the cornice with the date
        lap_siding(b, 3.3, 6.7, zff + 0.18, zff + 0.86, body, exp=0.11)
        trim(b, 3.2, 3.32, zff + 0.18, zff + 0.86, trm, y0=-0.055, y1=0.0)
        trim(b, 6.68, 6.8, zff + 0.18, zff + 0.86, trm, y0=-0.055, y1=0.0)
        trim(b, 3.12, 6.88, zff + 0.86, zff + 0.94, trm, y0=-0.12, y1=0.03, skip=())
        letters(b, "1878", "old", 5.0, zff + 0.52, 0.3, trm, y=-0.024, depth=0.008, max_w=2.4)
    # back of the false front (framing and boards seen from behind) and kickers to the roof
    box(b, x0, 0.0, ze - 0.05, x1, 0.16, zff + 0.15, "woodRaw", grain="x", skip={"-y", "-z"})
    box(b, x0 + 3.2, 0.0, zff + 0.15, x0 + 6.8, 0.12, zff + 0.86, "woodRaw", grain="x", skip={"-y", "-z"})
    tn = math.tan(math.radians(pitch))
    for kx in (-3.2, 0.0, 3.2):
        beam(b, (kx, 0.2, zff - 0.3), (kx, 2.2, ze + (5 - abs(kx)) * tn + 0.2), 0.06, 0.12, "woodRaw")
    # ---- side and rear walls (unpainted weathered siding)
    gf = gable_wall_fn(0.0, W, ze, pitch)
    for o, d, length, wins in (((x1, 0.0, 0), (0, 1), D, [(3.2, zf + 0.9, 0.9, 1.7), (9.0, z2 + 0.75, 0.86, 1.7), (13.0, z2 + 0.75, 0.86, 1.7), (12.0, zf + 0.9, 0.9, 1.7)]),
                               ((x0, D, 0), (0, -1), D, [(4.0, z2 + 0.75, 0.86, 1.7), (8.5, z2 + 0.75, 0.86, 1.7), (11.0, zf + 0.9, 0.9, 1.7)])):
        with b.at(wall_frame(o, d)):
            holes = [window(b, xc, zs, w, h, "woodRaw", "woodRaw", lights=(2, 1)) for xc, zs, w, h in wins]
            lap_siding(b, 0.05, length - 0.12, 0.6, ze - 0.2, side, holes)
            trim(b, 0.0, length, 0.0, 0.62, "woodRaw", y0=-0.035, y1=0.0)
            corner_board(b, length, 0.6, ze - 0.05, "woodRaw", 1)
            trim(b, 0.0, length, ze - 0.24, ze - 0.02, "woodRaw", y0=-0.03, y1=0.0)
    with b.at(wall_frame((x1, D, 0), (-1, 0))):
        holes = [door(b, 3.0, zf, 0.95, 2.1, "woodRaw", "woodRaw"), window(b, 7.0, zf + 0.9, 0.9, 1.6, "woodRaw", "woodRaw", lights=(2, 1)),
                 window(b, 3.0, z2 + 0.75, 0.86, 1.7, "woodRaw", "woodRaw", lights=(2, 1)), window(b, 7.0, z2 + 0.75, 0.86, 1.7, "woodRaw", "woodRaw", lights=(2, 1))]
        lap_siding(b, 0.12, W - 0.12, 0.6, ze + 1.9, side, holes, top=gf)
        trim(b, 0.0, W, 0.0, 0.62, "woodRaw", y0=-0.035, y1=0.0)
        corner_board(b, 0.0, 0.6, ze, "woodRaw", -1, wrap=0.05)
        corner_board(b, W, 0.6, ze, "woodRaw", 1, wrap=0.05)
    gable_roof_y(b, x0, x1, 0.16, D, ze, pitch, "tinRusty", end_front=False)
    for px, py in ((-2.4, 9.0), (2.1, 13.5)):
        stovepipe(b, px, py, ze + (5 - abs(px)) * tn + 0.17, 1.4)
    # ---- boardwalk and balcony
    boardwalk(b, x0 - 0.5, x1 + 0.5, -3.0, 0.45, steps=(0.0,), end_steps=(False, False))
    posts = (-4.85, -2.9, -0.95, 0.95, 2.9, 4.85)
    beam_bot = balcony(b, x0, x1, 0.0, -2.62, z2 + 0.03, 0.45, posts, trm, "woodRaw", trm, fascia_mat=trm)
    # interior behind the batwings: dark room, bar counter, the open inner doors
    interior_box(b, -2.0, 2.0, 0.16, 6.0, zf, 4.1, mat_wall="paintDark")
    box(b, -1.95, 1.4, zf, -1.25, 5.2, zf + 1.12, "woodVarnish", grain="y")
    box(b, -2.0, 1.35, zf + 1.12, -1.15, 5.25, zf + 1.17, "woodVarnish", grain="y")
    for sd in (-1, 1):
        with b.at(T(sd * 0.85, 0.16, 0) @ RZ(-90 * sd)):
            xa, xb = (0.0, 0.84) if sd < 0 else (-0.84, 0.0)
            panel_door(b, xa, xb, zf, 2.58, "woodVarnish", y_front=0.0, glass_top=True, knob=False)
    # ---- animated parts
    for name, hx, sd in (("saloon_door_L", -0.85, 1), ("saloon_door_R", 0.85, -1)):
        mb = B.child(name, (hx, 0.06, zf + 0.42))
        batwing_leaf(mb, 0.82, 1.28, sd, "woodVarnish")
    for i, lx in ((1, -1.42), (2, 1.42)):
        mb = B.child(f"lantern_{i}", (lx, -1.9, beam_bot + 0.18))
        build_lantern(mb, drop=0.34)
    mb = B.child("sign_swing_1", (3.88, -2.62, beam_bot))
    build_hanging_sign(mb, 1.25, 0.42, [("BILLIARDS", "alfa", 0.17)], board="paintDark", letter="paintMustard", chain=0.12)
    return B


# ------------------------------------------------------------------------------------- more construction


def slab_with_holes(b, x0, x1, z0, z1, y0, y1, holes, mat, reveal_mat=None, top=True, sides=True):
    """Solid wall slab (face at y0, back at y1) with rectangular openings and lined reveals."""
    rm = reveal_mat or mat
    xs = sorted(set([x0, x1] + [h[0] for h in holes] + [h[1] for h in holes]))
    X, Z = (1, 0, 0), (0, 0, 1)
    for i in range(len(xs) - 1):
        a, c = xs[i], xs[i + 1]
        spans = [(z0, z1)]
        for hx0, hx1, hz0, hz1 in holes:
            if hx0 <= a + 1e-6 and hx1 >= c - 1e-6:
                spans = _subtract(spans, hz0, hz1)
        for za, zc in spans:
            poly(b, [(a, y0, za), (c, y0, za), (c, y0, zc), (a, y0, zc)], mat, ax=X, ay=Z)
    for hx0, hx1, hz0, hz1 in holes:
        poly(b, [(hx0, y0, hz0), (hx0, y1, hz0), (hx0, y1, hz1), (hx0, y0, hz1)], rm, ax=(0, 1, 0), ay=Z)
        poly(b, [(hx1, y1, hz0), (hx1, y0, hz0), (hx1, y0, hz1), (hx1, y1, hz1)], rm, ax=(0, 1, 0), ay=Z)
        poly(b, [(hx0, y0, hz1), (hx0, y1, hz1), (hx1, y1, hz1), (hx1, y0, hz1)], rm, ax=X, ay=(0, 1, 0))
        if hz0 > z0 + 1e-4:
            poly(b, [(hx0, y1, hz0), (hx0, y0, hz0), (hx1, y0, hz0), (hx1, y1, hz0)], rm, ax=X, ay=(0, 1, 0))
    if top:
        poly(b, [(x0, y1, z1), (x0, y0, z1), (x1, y0, z1), (x1, y1, z1)], mat, ax=X, ay=(0, 1, 0))
    if sides:
        poly(b, [(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], mat, ax=(0, 1, 0), ay=Z)
        poly(b, [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], mat, ax=(0, 1, 0), ay=Z)


def shingle_pyramid(b, cx, cy, z0, half, height, mat, courses=22, top_half=0.03):
    """Four-sided spire / pyramid roof laid in shingle courses (each course a strip with a butt)."""
    for side in range(4):
        with b.at(T(cx, cy, 0) @ RZ(90 * side)):
            for k in range(courses):
                t0, t1 = k / courses, (k + 1) / courses
                h0 = half + (top_half - half) * t0
                h1 = half + (top_half - half) * t1
                za, zb = z0 + height * t0, z0 + height * t1
                out = 0.016
                p = [(-h0 - out, -h0 - out, za), (h0 + out, -h0 - out, za), (h1, -h1, zb + 0.01), (-h1, -h1, zb + 0.01)]
                t = TEXOF.get(mat)
                u0 = b.rng.random()
                sl = math.hypot(h0 - h1, zb - za)
                uv = [(u0, 0), (u0 + 2 * h0 / t.size, 0), (u0 + 2 * h0 / t.size, sl / t.size), (u0, sl / t.size)] if t else None
                if t is not None and t.grain == "u":
                    uv = [(v, u) for u, v in uv]
                b.face(p, uv, mat)
                b.face([(-h0, -h0, za - 0.02), (h0, -h0, za - 0.02), (h0 + out, -h0 - out, za), (-h0 - out, -h0 - out, za)],
                       [(u0, 0), (u0 + 0.3, 0), (u0 + 0.3, 0.01), (u0, 0.01)], mat)


def louvre_opening(b, x0, x1, z0, z1, mat, pitch=0.11):
    """Louvred opening (belfry, gable vent): frame + angled slats in front of a dark back."""
    box(b, x0, -0.05, z0, x0 + 0.06, 0.06, z1, mat, grain="z", skip={"+y"})
    box(b, x1 - 0.06, -0.05, z0, x1, 0.06, z1, mat, grain="z", skip={"+y"})
    n = max(2, int((z1 - z0) / pitch))
    for i in range(n):
        zz = z0 + (z1 - z0) * (i + 0.5) / n
        obox(b, Vector((x0 + 0.06, -0.04, zz - 0.04)), (x1 - x0 - 0.12, 0, 0), (0, 0.09, 0.06), (0, -0.012, 0.016), mat, grain=0, skip={"-x", "+x"})
    poly(b, [(x0, 0.06, z0), (x1, 0.06, z0), (x1, 0.06, z1), (x0, 0.06, z1)], "paintDark")


def gothic_head(b, xc, z_spring, w, rise, mat, casing=0.1):
    """Pointed (Carpenter Gothic) head over a rectangular sash: a pointed board panel with a casing."""
    span = w + 2 * casing
    hw = span / 2
    n = 7
    k = rise / (span * math.sin(math.radians(60)))
    # right half: an arc centred on the left springing point, from the right springing point up to the apex
    right = [(-hw + span * math.cos(math.radians(60) * i / n), span * math.sin(math.radians(60) * i / n) * k) for i in range(n + 1)]
    pts = [(-hw, 0.0), (hw, 0.0)] + right[1:] + [(-x, z) for x, z in reversed(right[1:-1])]
    pts = [(xc + x, z_spring + z) for x, z in pts]
    # ax = +x, ay = +z: extrusion along -y (outward): place so it spans y in [TRIM_Y0, TRIM_Y1]
    prism(b, pts, (0, TRIM_Y1, 0), (1, 0, 0), (0, 0, 1), TRIM_Y1 - TRIM_Y0, mat)


def barber_pole(b, x, y, z0, h, r=0.06):
    """Striped barber pole: diagonal red and white bands on a turned post with a ball finial."""
    n, m = 12, 14
    rings = []
    for j in range(m + 1):
        z = z0 + h * j / m
        rings.append(b.verts([(x + r * math.cos(2 * math.pi * i / n), y + r * math.sin(2 * math.pi * i / n), z) for i in range(n)]))
    for j in range(m):
        for i in range(n):
            k = (i + j * 2) // 3 % 2
            mat = "paintOxblood" if k else "paintWhite"
            b.face_i([rings[j][i], rings[j][(i + 1) % n], rings[j + 1][(i + 1) % n], rings[j + 1][i]],
                     [(i / n, j / m), ((i + 1) / n, j / m), ((i + 1) / n, (j + 1) / m), (i / n, (j + 1) / m)], mat, True)
    lathe(b, [(r * 1.4, z0 + h), (r * 1.5, z0 + h + 0.05), (r * 0.4, z0 + h + 0.09), (r * 1.1, z0 + h + 0.14), (r * 1.0, z0 + h + 0.21), (0.001, z0 + h + 0.25)], "ironBlack", n=10, o=(x, y, 0))
    lathe(b, [(r * 1.5, z0 - 0.06), (r * 1.4, z0)], "ironBlack", n=10, o=(x, y, 0), cap_top=False)


# ------------------------------------------------------------------------------------------------ props


def barrel(b, x, y, z, h=0.88, r=0.29, mat="woodRaw", hoop="ironRust", lid=True, n=14):
    re = r * 0.86
    prof = []
    for i in range(7):
        t = i / 6
        prof.append((re + (r - re) * math.sin(math.pi * t), z + h * t))
    lathe(b, prof, mat, n=n, o=(x, y, 0), cap_top=False)
    rr = lambda t: re + (r - re) * math.sin(math.pi * t)  # noqa: E731
    for t in (0.06, 0.24, 0.76, 0.94):
        zz = z + h * t
        lathe(b, [(rr(t) + 0.006, zz - 0.022), (rr(t) + 0.006, zz + 0.022)], hoop, n=n, o=(x, y, 0), cap_top=False)
    if lid:
        poly(b, [(x + re * 0.97 * math.cos(2 * math.pi * i / n), y + re * 0.97 * math.sin(2 * math.pi * i / n), z + h - 0.025) for i in range(n)], mat)
        lathe(b, [(re, z + h), (re * 0.97, z + h - 0.025)], mat, n=n, o=(x, y, 0), cap_top=False)


def crate(b, x, y, z, w=0.6, d=0.45, h=0.45, mat="woodPale", rot=0.0):
    with b.at(T(x, y, z) @ RZ(rot)):
        box(b, -w / 2 + 0.02, -d / 2 + 0.02, 0.0, w / 2 - 0.02, d / 2 - 0.02, h - 0.01, mat, grain="x", skip={"-z"})
        for sx in (-1, 1):
            for sy in (-1, 1):
                box(b, sx * w / 2 - (0.05 if sx > 0 else 0), sy * d / 2 - (0.05 if sy > 0 else 0), 0.0,
                    sx * w / 2 + (0.0 if sx > 0 else 0.05), sy * d / 2 + (0.0 if sy > 0 else 0.05), h, mat, grain="z", skip={"-z"})
        for zz in (0.0, h - 0.06):
            box(b, -w / 2 + 0.05, -d / 2 - 0.005, zz, w / 2 - 0.05, -d / 2 + 0.02, zz + 0.06, mat, grain="x", skip={"+y"})
            box(b, -w / 2 + 0.05, d / 2 - 0.02, zz, w / 2 - 0.05, d / 2 + 0.005, zz + 0.06, mat, grain="x", skip={"-y"})


def hay_bale(b, x, y, z, rot=0.0, w=0.95, d=0.48, h=0.38):
    with b.at(T(x, y, z) @ RZ(rot)):
        box(b, -w / 2, -d / 2, 0.0, w / 2, d / 2, h, "hay", grain="x", skip={"-z"}, jitter=1.5)
        for sx in (-w * 0.25, w * 0.25):
            box(b, sx - 0.01, -d / 2 - 0.006, 0.0, sx + 0.01, d / 2 + 0.006, h + 0.006, "ironBlack", skip={"-z"})


def wheel(b, r, mat, tyre="ironBlack", spokes=12, width=0.07, hub_r=None):
    """Spoked wagon wheel in its local frame: axle along local Y through the origin."""
    hub_r = hub_r or r * 0.16
    cyl(b, (0, -width * 1.6, 0), (0, width * 1.6, 0), hub_r, mat, n=10)
    cyl(b, (0, -width * 1.75, 0), (0, -width * 1.6, 0), hub_r * 0.75, tyre, n=10)
    n = 16
    felloe_in = r * 0.88
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p0 = Vector((math.cos(a0) * (felloe_in + r) / 2, 0, math.sin(a0) * (felloe_in + r) / 2))
        p1 = Vector((math.cos(a1) * (felloe_in + r) / 2, 0, math.sin(a1) * (felloe_in + r) / 2))
        d = p1 - p0
        ext = d.normalized() * 0.012
        beam(b, p0 - ext, p1 + ext, width, r - felloe_in, mat, up=(p0 + p1).normalized())
    # iron tyre: a flat band around the felloe
    tr = r + 0.008
    ring = []
    for i in range(n):
        a = 2 * math.pi * i / n
        ring.append((math.cos(a), math.sin(a)))
    for i in range(n):
        j = (i + 1) % n
        c0, s0 = ring[i]
        c1, s1 = ring[j]
        b.face([(c0 * tr, -width * 0.55, s0 * tr), (c0 * tr, width * 0.55, s0 * tr), (c1 * tr, width * 0.55, s1 * tr), (c1 * tr, -width * 0.55, s1 * tr)],
               [(0, 0), (0.05, 0), (0.05, 0.05), (0, 0.05)], tyre)
    for i in range(spokes):
        a = 2 * math.pi * (i + 0.5) / spokes
        dirv = Vector((math.cos(a), 0, math.sin(a)))
        beam(b, dirv * hub_r * 0.9, dirv * (felloe_in + 0.01), 0.045, 0.03, mat, up=(0, 1, 0))


def leaning_wheel(b, x, y, r, mat="woodRaw", lean=14.0, rot=0.0):
    """A wheel leaning against a wall behind it (+y)."""
    with b.at(T(x, y, 0) @ RZ(rot) @ RX(-lean) @ T(0, 0, r + 0.005)):
        wheel(b, r, mat)


def trough(b, x, y, z, length=2.4, w=0.62, h=0.5, rot=0.0, mat="woodRaw"):
    with b.at(T(x, y, z) @ RZ(rot)):
        for sx in (-length / 2 + 0.15, length / 2 - 0.15):
            box(b, sx - 0.05, -w / 2 - 0.04, 0.0, sx + 0.05, w / 2 + 0.04, 0.2, mat, grain="y", skip={"-z"})
        box(b, -length / 2, -w / 2, 0.2, length / 2, w / 2, 0.25, mat, grain="x")
        box(b, -length / 2, -w / 2, 0.25, length / 2, -w / 2 + 0.045, 0.2 + h, mat, grain="x")
        box(b, -length / 2, w / 2 - 0.045, 0.25, length / 2, w / 2, 0.2 + h, mat, grain="x")
        box(b, -length / 2, -w / 2 + 0.045, 0.25, -length / 2 + 0.045, w / 2 - 0.045, 0.2 + h, mat, grain="y")
        box(b, length / 2 - 0.045, -w / 2 + 0.045, 0.25, length / 2, w / 2 - 0.045, 0.2 + h, mat, grain="y")
        zw = 0.2 + h - 0.08
        b.face([(-length / 2 + 0.045, -w / 2 + 0.045, zw), (length / 2 - 0.045, -w / 2 + 0.045, zw), (length / 2 - 0.045, w / 2 - 0.045, zw), (-length / 2 + 0.045, w / 2 - 0.045, zw)],
               [(0, 0), (1, 0), (1, 1), (0, 1)], "water")
        for sx in (-length / 2 + 0.3, length / 2 - 0.3):
            box(b, sx - 0.02, -w / 2 - 0.006, 0.25, sx + 0.02, w / 2 + 0.006, 0.2 + h + 0.004, "ironRust")


def hitching_rail(b, x0, x1, y, mat="woodRaw"):
    for px in (x0, x1):
        box(b, px - 0.07, y - 0.07, -0.3, px + 0.07, y + 0.07, 1.0, mat, grain="z", skip={"-z"}, jitter=1.2)
    cyl(b, (x0 - 0.15, y, 0.93), (x1 + 0.15, y, 0.95), 0.055, mat, n=7)
    for px in (x0 + (x1 - x0) * 0.33, x0 + (x1 - x0) * 0.66):
        cyl(b, (px, y - 0.06, 0.9), (px, y + 0.06, 0.9), 0.025, "ironRust", n=6)


def bench(b, x, y, z, length=1.8, rot=0.0, mat="woodRaw"):
    with b.at(T(x, y, z) @ RZ(rot)):
        for sx in (-length / 2 + 0.12, length / 2 - 0.12):
            box(b, sx - 0.03, -0.2, 0.0, sx + 0.03, -0.14, 0.42, mat, grain="z", skip={"-z"})
            box(b, sx - 0.03, 0.14, 0.0, sx + 0.03, 0.2, 0.86, mat, grain="z", skip={"-z"})
            box(b, sx - 0.03, -0.2, 0.36, sx + 0.03, 0.2, 0.42, mat, grain="y")
        for k in range(3):
            box(b, -length / 2, -0.22 + k * 0.135, 0.42, length / 2, -0.22 + k * 0.135 + 0.12, 0.45, mat, grain="x", jitter=0.3)
        for zz in (0.58, 0.74):
            box(b, -length / 2, 0.2, zz, length / 2, 0.225, zz + 0.1, mat, grain="x", jitter=0.3)


def rocking_chair(b, x, y, z, rot=0.0, mat="woodVarnish"):
    with b.at(T(x, y, z) @ RZ(rot)):
        for sx in (-0.24, 0.24):
            pts = []
            n = 10
            for i in range(n + 1):
                t = -1 + 2 * i / n
                yy = t * 0.42
                zz = 0.06 * (t * t)
                pts.append((yy, zz))
            top = [(yy, zz + 0.045) for yy, zz in reversed(pts)]
            prof = pts + top
            # ax = +y, ay = +z -> extrusion along (0,1,0) x (0,0,1) = +x
            prism(b, prof, (sx - 0.015, 0, 0), (0, 1, 0), (0, 0, 1), 0.03, mat)
            box(b, sx - 0.02, -0.22, 0.04, sx + 0.02, -0.18, 0.45, mat, grain="z")
            box(b, sx - 0.02, 0.16, 0.04, sx + 0.02, 0.2, 1.05, mat, grain="z", jitter=2)
            box(b, sx - 0.025, -0.26, 0.63, sx + 0.025, 0.2, 0.66, mat, grain="y")
            box(b, sx - 0.02, -0.24, 0.45, sx + 0.02, -0.2, 0.63, mat, grain="z")
        for k in range(5):
            box(b, -0.26, -0.22 + k * 0.08, 0.43, 0.26, -0.22 + k * 0.08 + 0.06, 0.455, mat, grain="x")
        for k in range(6):
            bx = -0.2 + k * 0.08
            box(b, bx - 0.012, 0.17, 0.46, bx + 0.012, 0.19, 1.0, mat, grain="z")
        box(b, -0.26, 0.16, 0.98, 0.26, 0.2, 1.06, mat, grain="x")
        box(b, -0.26, 0.16, 0.44, 0.26, 0.2, 0.48, mat, grain="x")


def lamp_post(b, x, y, h=3.3, mat="woodRaw"):
    box(b, x - 0.075, y - 0.075, -0.4, x + 0.075, y + 0.075, h, mat, grain="z", skip={"-z"}, jitter=0.6)
    box(b, x - 0.1, y - 0.1, h, x + 0.1, y + 0.1, h + 0.03, mat)
    # lantern head
    zb, zt = h + 0.03, h + 0.48
    s = 0.15
    for i in range(4):
        a = math.pi / 4 + i * math.pi / 2
        px, py = x + math.cos(a) * s * 1.41, y + math.sin(a) * s * 1.41
        box(b, px - 0.012, py - 0.012, zb, px + 0.012, py + 0.012, zt, "ironBlack")
    for i in range(4):
        a0 = i * math.pi / 2
        c, sn = math.cos(a0), math.sin(a0)
        e = Vector((-sn, c, 0)) * s
        nv = Vector((c, sn, 0)) * (s - 0.004)
        o = Vector((x, y, 0))
        p = [o + nv - e + Vector((0, 0, zb)), o + nv + e + Vector((0, 0, zb)), o + nv + e + Vector((0, 0, zt)), o + nv - e + Vector((0, 0, zt))]
        b.face(p, [(0, 0), (1, 0), (1, 1), (0, 1)], "lampGlow")
    lathe(b, [(0.2, zt), (0.21, zt + 0.02), (0.05, zt + 0.16), (0.03, zt + 0.22), (0.045, zt + 0.25), (0.001, zt + 0.3)], "ironBlack", n=8, o=(x, y, 0))
    lathe(b, [(0.05, zb + 0.02), (0.05, zb + 0.2), (0.025, zb + 0.28)], "lampGlow", n=8, o=(x, y, 0), cap_top=False)
    box(b, x - 0.18, y - 0.18, zb - 0.03, x + 0.18, y + 0.18, zb, "ironBlack")
    # ladder arm
    box(b, x - 0.03, y - 0.45, h - 0.55, x + 0.03, y + 0.03, h - 0.5, "ironBlack")


def freight_wagon(b, x, y, rot=0.0):
    """A freight wagon parked without horses: box bed with flared sideboards, running gear, four wheels
    (smaller in front), reach, bolsters, brake and the tongue resting on the ground."""
    with b.at(T(x, y, 0) @ RZ(rot)):
        rf, rr = 0.48, 0.66
        L, Wd = 3.7, 1.12
        xf, xr = 1.25, -1.35
        zbed = 1.02
        gauge = 0.82
        gear, bed = "paintOxblood", "paintSlate"
        for xx, r in ((xf, rf), (xr, rr)):
            beam(b, (xx, -gauge - 0.1, r), (xx, gauge + 0.1, r), 0.11, 0.11, "woodRaw")
            box(b, xx - 0.07, -0.55, r + 0.06, xx + 0.07, 0.55, zbed - 0.02, gear, grain="y")
            for sy in (-1, 1):
                with b.at(T(xx, sy * gauge, r) @ RZ(0)):
                    wheel(b, r, gear, spokes=12 if r > 0.6 else 10)
        beam(b, (xr - 0.4, 0, rr + 0.02), (xf + 0.3, 0, rf + 0.02), 0.08, 0.09, "woodRaw")
        # bed floor and sides (flared boards)
        box(b, -L / 2 - 0.1, -Wd / 2, zbed, L / 2 - 0.1, Wd / 2, zbed + 0.05, "woodRaw", grain="x")
        for sy in (-1, 1):
            for k in range(3):
                z0 = zbed + 0.05 + k * 0.2
                yy = sy * (Wd / 2 + k * 0.035)
                box(b, -L / 2 - 0.1, yy - 0.015, z0, L / 2 - 0.1, yy + 0.015, z0 + 0.19, bed, grain="x", jitter=0.2)
            for sx in (-1.5, -0.5, 0.5, 1.3):
                beam(b, (sx, sy * (Wd / 2 + 0.03), zbed - 0.02), (sx, sy * (Wd / 2 + 0.11), zbed + 0.66), 0.05, 0.02, "ironRust", up=(0, sy, 0))
        for sx in (-L / 2 - 0.1, L / 2 - 0.1):
            box(b, sx - 0.015, -Wd / 2, zbed + 0.05, sx + 0.015, Wd / 2, zbed + 0.6, bed, grain="y")
        # spring seat
        box(b, 0.7, -0.5, zbed + 0.62, 1.05, 0.5, zbed + 0.68, "woodRaw", grain="y")
        box(b, 0.98, -0.5, zbed + 0.68, 1.02, 0.5, zbed + 0.95, "woodRaw", grain="y")
        # brake beam and lever
        beam(b, (xr + 0.4, -Wd / 2 - 0.1, rr + 0.1), (xr + 0.4, Wd / 2 + 0.1, rr + 0.1), 0.07, 0.07, "woodRaw")
        beam(b, (xr + 0.4, Wd / 2 + 0.12, rr + 0.1), (xr + 0.2, Wd / 2 + 0.14, zbed + 1.1), 0.04, 0.04, "ironBlack")
        # tongue resting on the ground
        beam(b, (xf + 0.1, 0, rf - 0.05), (xf + 3.0, 0.25, 0.05), 0.08, 0.08, "woodRaw")
        beam(b, (xf + 2.4, -0.45, 0.1), (xf + 2.4, 0.9, 0.12), 0.06, 0.06, "woodRaw")
        # cargo: a few crates and sacks under a tarp-free load
        crate(b, -0.9, -0.2, zbed + 0.05, 0.7, 0.5, 0.48, rot=4)
        crate(b, -0.2, 0.15, zbed + 0.05, 0.6, 0.5, 0.42, rot=-6)
        barrel(b, -1.45, 0.25, zbed + 0.05, h=0.8, r=0.26)


def hay_feeder(b, x, y, rot=0.0, length=2.4):
    with b.at(T(x, y, 0) @ RZ(rot)):
        for sx in (-length / 2, length / 2):
            for sy in (-1, 1):
                beam(b, (sx, sy * 0.12, -0.2), (sx, sy * 0.55, 1.4), 0.08, 0.08, "woodRaw", up=(1, 0, 0))
            box(b, sx - 0.04, -0.5, 0.55, sx + 0.04, 0.5, 0.63, "woodRaw", grain="y")
        for sy in (-1, 1):
            for k in range(9):
                t = (k + 0.5) / 9
                xx = -length / 2 + length * t
                beam(b, (xx, sy * 0.16, 0.6), (xx, sy * 0.53, 1.36), 0.035, 0.035, "woodRaw", up=(1, 0, 0))
            beam(b, (-length / 2 - 0.1, sy * 0.54, 1.37), (length / 2 + 0.1, sy * 0.54, 1.37), 0.07, 0.07, "woodRaw")
        box(b, -length / 2, -0.15, 0.55, length / 2, 0.15, 0.62, "woodRaw", grain="x")
        # hay heaped in the rack
        pts = [(-0.18, 0.0), (0.18, 0.0), (0.44, 0.62), (0.2, 0.86), (-0.22, 0.88), (-0.45, 0.6)]
        prism(b, [(yy, zz + 0.6) for yy, zz in pts], (-length / 2 + 0.05, 0, 0), (0, 1, 0), (0, 0, 1), length - 0.1, "hay")


def porch_rafter_bottom(z_wall, z_front, y_post, y):
    """Underside of a shed_porch rafter at depth y (for hanging lanterns from it)."""
    return z_front + (z_wall - z_front) / (0.0 - y_post) * (y - y_post) + 0.005


def porch_beam_bottom(z_front_shop):
    """Underside of the porch plate beam of a false_front_shop with the given front wall height."""
    return z_front_shop - 1.05 - 0.22


def side_walls(b, x0, x1, D, z_base, top_front, top_back, mat, trm, left_wins=(), right_wins=(), siding="lap", sash=None, y0=0.0,
               corner=True, rake=True, left_fn=None, right_fn=None):
    """The two side walls from y0 back to D; the wall top runs from top_front to top_back (shed roofs) or
    is level (gable roofs with the ridge front to back). left_fn/right_fn draw extra openings (in wall
    space; the left wall runs from the back to the front) and return their siding holes."""
    sash = sash or trm
    length = D - y0
    for o, d, wins, front_first, fn in (((x1, y0, 0), (0, 1), right_wins, True, right_fn), ((x0, D, 0), (0, -1), left_wins, False, left_fn)):
        with b.at(wall_frame(o, d)):
            if front_first:
                top = lambda x: top_front + (top_back - top_front) * x / length  # noqa: E731
            else:
                top = lambda x: top_back + (top_front - top_back) * x / length  # noqa: E731
            holes = [window(b, xc, zs, w, h, trm, sash, lights=lt) for xc, zs, w, h, lt in wins]
            if fn:
                holes += fn(b)
            zt = max(top_front, top_back)
            sloped = abs(top_front - top_back) > 0.01
            if siding == "lap":
                lap_siding(b, 0.04, length - 0.12, z_base, zt - 0.2, mat, holes, top=(lambda x, t=top: t(x) - 0.2) if sloped else None)
            else:
                bb_siding(b, 0.04, length - 0.04, z_base, zt, mat, holes, top=(lambda x, t=top: t(x)) if sloped else None)
            trim(b, 0.0, length, -0.2, z_base + 0.02, trm, y0=-0.035, y1=0.0)
            if corner:
                corner_board(b, length, z_base, (top(length) if sloped else zt) - 0.02, trm, 1)
            if rake:
                if sloped:
                    p0 = Vector((0.0, -0.03, top(0.0) - 0.13))
                    p1 = Vector((length, -0.03, top(length) - 0.13))
                    beam(b, p0, p1, 0.03, 0.22, trm)
                else:
                    trim(b, 0.0, length, zt - 0.24, zt - 0.02, trm, y0=-0.03, y1=0.0)


def rear_wall(b, x0, x1, D, z_base, z_top, mat, trm, holes_fn=None, gable=None, siding="lap"):
    W = x1 - x0
    with b.at(wall_frame((x1, D, 0), (-1, 0))):
        holes = holes_fn(b) if holes_fn else []
        if siding == "lap":
            lap_siding(b, 0.12, W - 0.12, z_base, z_top if gable is None else z_top + 6, mat, holes, top=gable)
        else:
            bb_siding(b, 0.04, W - 0.04, z_base, z_top if gable is None else z_top + 6, mat, holes, top=gable)
        trim(b, 0.0, W, -0.2, z_base + 0.02, trm, y0=-0.035, y1=0.0)
        zc = z_top if gable is None else z_top
        corner_board(b, 0.0, z_base, zc, trm, -1, wrap=0.05)
        corner_board(b, W, z_base, zc, trm, 1, wrap=0.05)


def shed_roof_back(b, x0, x1, y0, D, z_front, z_back, mat="tinRusty", frame="woodRaw", ov_back=0.35, ov_side=0.25):
    """Main roof sloping from just behind a false front down to the rear eave, with exposed rafter tails."""
    slope = (z_front - z_back) / (D - y0)
    zf = lambda y: z_front - slope * (y - y0) + 0.12  # noqa: E731
    roof_cover(b, x0 - ov_side, x1 + ov_side, y0, D + ov_back, zf, mat, downslope=1)
    box(b, x0 - ov_side, D + ov_back - 0.025, zf(D + ov_back) - 0.2, x1 + ov_side, D + ov_back, zf(D + ov_back) - 0.01, frame, grain="x")
    for xx in (x0 - ov_side, x1 + ov_side - 0.025):
        beam(b, (xx + 0.0125, y0 + 0.1, zf(y0 + 0.1) - 0.1), (xx + 0.0125, D + ov_back, zf(D + ov_back) - 0.1), 0.025, 0.2, frame)
    n = max(2, int((x1 - x0) / 0.61))
    for i in range(n + 1):
        rx = x0 + 0.05 + (x1 - x0 - 0.1) * i / n
        beam(b, (rx, D - 0.05, zf(D - 0.05) - 0.1), (rx, D + ov_back - 0.03, zf(D + ov_back - 0.03) - 0.1), 0.05, 0.13, frame)
    poly(b, [(x0 - ov_side, D, zf(D) - 0.04), (x1 + ov_side, D, zf(D) - 0.04), (x1 + ov_side, D + ov_back, zf(D + ov_back) - 0.04), (x0 - ov_side, D + ov_back, zf(D + ov_back) - 0.04)][::-1], frame)
    return zf


def false_front_back(b, x0, x1, z0, z1, kick_to=None):
    box(b, x0, 0.0, z0, x1, 0.14, z1, "woodRaw", grain="x", skip={"-y", "-z"})
    if kick_to:
        y_k, z_k = kick_to
        for kx in (x0 + (x1 - x0) * 0.25, x0 + (x1 - x0) * 0.75):
            beam(b, (kx, 0.18, z1 - 0.35), (kx, y_k, z_k), 0.05, 0.1, "woodRaw")


def ff_sign(b, x0, x1, z0, z1, board, frame, lines, letter, y=-0.05):
    """A framed sign board on a false front with one or more lines of raised lettering."""
    flush_boards(b, x0, x1, z0, z1, board, y0=y, y1=-0.022)
    fr = 0.09
    for a, c, za, zc in ((x0 - fr, x1 + fr, z0 - fr, z0), (x0 - fr, x1 + fr, z1, z1 + fr), (x0 - fr, x0, z0, z1), (x1, x1 + fr, z0, z1)):
        trim(b, a, c, za, zc, frame, y0=y - 0.028, y1=-0.022, skip=())
    n = len(lines)
    h = z1 - z0
    acc = 0.0
    weights = [ln[3] if len(ln) > 3 else 1.0 for ln in lines]
    tw = sum(weights)
    for i, ln in enumerate(lines):
        text, font, cap = ln[0], ln[1], ln[2]
        lm = ln[4] if len(ln) > 4 else letter
        wgt = weights[i]
        zc = z1 - h * (acc + wgt / 2) / tw
        acc += wgt
        letters(b, text, font, (x0 + x1) / 2, zc, cap, lm, y=y, depth=0.009, max_w=(x1 - x0) - 0.3, res=1 if font == "rye" else 2)
    return n


PALE = {"paintWhite", "woodPale", "paintMustard", "paintSage", "paintSlate"}


def false_front_shop(kind, row, s, seed, W, D, body, trm, sign_lines, door_x, windows, z_front=4.3, z_back=3.4, zff=5.9,
                     porch=True, siding="lap", side_mat="sidingWeathered", sign_board=None, sign_letter=None, boardwalk_kw=None,
                     door_kw=None, porch_posts=None, stove=True, sign_z=None):
    """A one-storey false-front shop with a shed roof falling to the back, optional porch and boardwalk."""
    B = Building(kind, row, s, seed)
    b = B.b
    x0, x1 = -W / 2, W / 2
    zf = 0.5
    sb = sign_board or trm
    sl = sign_letter or ("paintDark" if sb in PALE else "paintWhite")
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [door(b, door_x, zf, **(door_kw or dict(w=0.95, h=2.15, trim_mat=trm, leaf_mat="paintDark", transom=0.34)))]
        for spec in windows:
            xc, zs, w, h = spec[:4]
            kw = spec[4] if len(spec) > 4 else {}
            holes.append(window(b, xc, zs, w, h, trm, trm, **kw))
        sz0, sz1 = sign_z or (z_front + 0.35, zff - 0.45)
        holes.append((0.45, W - 0.45, sz0 + 0.02, sz1 - 0.02))
        if siding == "lap":
            lap_siding(b, 0.15, W - 0.15, 0.62, zff - 0.3, body, holes)
        else:
            bb_siding(b, 0.12, W - 0.12, 0.62, zff - 0.3, body, holes)
        trim(b, 0.0, W, -0.25, 0.62, trm, y0=-0.04, y1=0.0)
        trim(b, -0.04, 0.16, 0.62, zff - 0.3, trm, y0=-0.06, y1=0.0)
        trim(b, W - 0.16, W + 0.04, 0.62, zff - 0.3, trm, y0=-0.06, y1=0.0)
        ff_sign(b, 0.55, W - 0.55, sz0, sz1, sb, trm, sign_lines, sl)
        cornice(b, 0.0, W, zff, trm, proj=0.3, brackets=max(3, int(W / 1.3)), frieze=0.3)
    false_front_back(b, x0, x1, z_front - 0.1, zff + 0.15, kick_to=(1.8, z_front + 0.1))
    side_walls(b, x0, x1, D, 0.6, z_front, z_back, side_mat, "woodRaw", siding=siding if siding != "lap" else "lap", y0=0.0,
               left_wins=[(D * 0.55, zf + 0.9, 0.85, 1.55, (2, 1))], right_wins=[(D * 0.45, zf + 0.9, 0.85, 1.55, (2, 1))])
    rear_wall(b, x0, x1, D, 0.6, z_back, side_mat, "woodRaw",
              holes_fn=lambda bb: [door(bb, W * 0.3, zf, 0.9, 2.05, "woodRaw", "woodRaw"), window(bb, W * 0.72, zf + 0.9, 0.85, 1.5, "woodRaw", "woodRaw", lights=(2, 1))],
              siding=siding)
    zr = shed_roof_back(b, x0, x1, 0.14, D, z_front, z_back)
    if stove:
        px, py = x0 + W * 0.68, D * 0.6
        stovepipe(b, px, py, zr(py) + 0.02, 1.2)
    bw = dict(x0=x0 - 0.5, x1=x1 + 0.5, y_front=-3.0, h=0.46, steps=(), end_steps=(False, False))
    if boardwalk_kw:
        bw.update(boardwalk_kw)
    if bw.pop("enabled", True):
        boardwalk(b, bw.pop("x0"), bw.pop("x1"), bw.pop("y_front"), bw.pop("h"), **bw)
    if porch:
        posts = porch_posts or [x0 + 0.15, 0.0, x1 - 0.15] if W < 7 else (porch_posts or [x0 + 0.15, x0 + W / 3, x1 - W / 3, x1 - 0.15])
        shed_porch(b, x0, x1, 0.0, -2.62, z_front - 0.45, z_front - 1.05, 0.46, posts, trm, "woodRaw", roof="tinRusty", fascia_mat=trm)
    return B


def build_store():
    """Halloran & Sons General Merchandise: storefront with display windows under a porch, a stepped
    false front with two cornices and a framed sign."""
    B = Building("store", "A", -5.0, 202)
    b = B.b
    W, D = 8.0, 14.0
    x0, x1 = -W / 2, W / 2
    zf, ze, zff, zc = 0.5, 4.9, 7.15, 7.75
    pitch = 24.0
    body, trm, side = "paintMustard", "paintDark", "sidingWeathered"
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [storefront(b, 0.22, W - 0.22, zf, trm, trm, "woodVarnish", door_w=1.6, h_win=2.2, bulk=0.62, transom=0.42, lights=2)]
        holes.append((0.62, W - 0.62, 4.98, 6.62))
        top = lambda x: (zc if 2.1 < x < 5.9 else zff) - 0.3  # noqa: E731
        lap_siding(b, 0.18, W - 0.18, 3.95, zc - 0.3, body, holes, top=top)
        lap_siding(b, 0.18, W - 0.18, 0.62, 3.95, body, holes)
        trim(b, 0.0, W, -0.25, 0.62, trm, y0=-0.04, y1=0.0)
        trim(b, -0.04, 0.18, 0.62, zff - 0.3, trm, y0=-0.065, y1=0.0)
        trim(b, W - 0.18, W + 0.04, 0.62, zff - 0.3, trm, y0=-0.065, y1=0.0)
        ff_sign(b, 0.7, W - 0.7, 5.05, 6.55, "paintDark", trm, [("HALLORAN & SONS", "alfa", 0.4, 1.15), ("GENERAL MERCHANDISE", "old", 0.27, 0.85)], "paintWhite")
        cornice(b, 0.0, 2.1, zff, trm, proj=0.3, brackets=2, frieze=0.3)
        cornice(b, 5.9, W, zff, trm, proj=0.3, brackets=2, frieze=0.3)
        cornice(b, 2.1, 5.9, zc, trm, proj=0.34, brackets=3, frieze=0.3)
        letters(b, "1874", "old", 4.0, zc - 0.5, 0.2, "paintWhite", y=-0.024, depth=0.006, max_w=1.2)
    box(b, x0, 0.0, ze - 0.05, x0 + 2.1, 0.14, zff + 0.15, "woodRaw", grain="x", skip={"-y", "-z"})
    box(b, x0 + 5.9, 0.0, ze - 0.05, x1, 0.14, zff + 0.15, "woodRaw", grain="x", skip={"-y", "-z"})
    box(b, x0 + 2.1, 0.0, ze - 0.05, x0 + 5.9, 0.14, zc + 0.15, "woodRaw", grain="x", skip={"-y", "-z"})
    tn = math.tan(math.radians(pitch))
    for kx in (-2.4, 2.4):
        beam(b, (kx, 0.18, zff - 0.3), (kx, 2.0, ze + (4 - abs(kx)) * tn + 0.2), 0.05, 0.1, "woodRaw")
    side_walls(b, x0, x1, D, 0.6, ze, ze, side, "woodRaw", left_wins=[(5.0, zf + 0.9, 0.86, 1.6, (2, 1)), (10.0, zf + 0.9, 0.86, 1.6, (2, 1))],
               right_wins=[(4.0, zf + 0.9, 0.86, 1.6, (2, 1)), (9.5, zf + 0.9, 0.86, 1.6, (2, 1))])
    rear_wall(b, x0, x1, D, 0.6, ze, side, "woodRaw", gable=gable_wall_fn(0.0, W, ze, pitch),
              holes_fn=lambda bb: [door(bb, 2.2, zf, 1.4, 2.3, "woodRaw", "woodRaw", double=True), window(bb, 5.8, zf + 0.9, 0.86, 1.5, "woodRaw", "woodRaw", lights=(2, 1))])
    gable_roof_y(b, x0, x1, 0.14, D, ze, pitch, "tinRusty", end_front=False)
    stovepipe(b, 1.6, 10.0, ze + (4 - 1.6) * tn + 0.17, 1.3)
    boardwalk(b, x0 - 0.5, x1 + 0.5, -3.0, 0.47, steps=(-2.55,), end_steps=(True, False))
    posts = [x0 + 0.15, -1.35, 1.35, x1 - 0.15]
    shed_porch(b, x0, x1, 0.0, -2.62, 4.45, 3.78, 0.47, posts, trm, "woodRaw", roof="tinRusty", fascia_mat=trm)
    mb = B.child("lantern_3", (-0.95, -1.95, porch_rafter_bottom(4.45, 3.78, -2.62, -1.95)))
    build_lantern(mb, drop=0.3)
    mb = B.child("sign_swing_2", (2.6, -2.62, 3.78 - 0.22))
    build_hanging_sign(mb, 1.55, 0.4, [("HARDWARE · GROCERIES", "alfa", 0.13)], board="paintWhite", letter="paintDark", chain=0.1, frame="paintDark")
    return B


def build_sheriff():
    B = false_front_shop("sheriff", "A", 13.75, 303, 5.5, 9.0, "paintSage", "paintWhite",
                         [("SHERIFF'S OFFICE", "alfa", 0.34)], 1.2,
                         [(3.0, 1.35, 0.95, 1.7, dict(lights=(2, 1))), (4.65, 1.85, 0.62, 0.9, dict(lights=(1, 1), bars=True, sash_split=0.5))],
                         z_front=4.35, z_back=3.45, zff=5.95, sign_z=(4.85, 5.5),
                         door_kw=dict(w=0.95, h=2.15, trim_mat="paintWhite", leaf_mat="woodVarnish", transom=0.34),
                         boardwalk_kw=dict(x0=-3.25, x1=2.75, steps=(1.6,), end_steps=(False, False)),
                         porch_posts=[-2.6, 0.0, 2.6])
    b = B.b
    # small "JAIL" board over the barred cell window, and an iron strap door on the cell side
    with b.at(wall_frame((-2.75, 0, 0), (1, 0))):
        ff_sign(b, 4.25, 5.05, 3.0, 3.32, "paintWhite", "paintDark", [("JAIL", "alfa", 0.18)], "paintDark", y=-0.06)
    mb = B.child("lantern_4", (-0.95, -1.9, porch_rafter_bottom(4.35 - 0.45, 4.35 - 1.05, -2.62, -1.9)))
    build_lantern(mb, drop=0.28)
    return B


def build_barber():
    B = false_front_shop("barber", "B", -17.5, 404, 5.0, 10.0, "paintSlate", "paintWhite",
                         [("BARBER", "alfa", 0.34, 1.1, "paintOxblood"), ("HOT BATHS", "old", 0.24, 0.9, "paintDark")], 1.5,
                         [(3.55, 1.3, 1.15, 1.85, dict(lights=(2, 2)))], z_front=4.3, z_back=3.4, zff=6.2, sign_z=(4.78, 5.82),
                         boardwalk_kw=dict(x1=2.5 + 1.7, end_steps=(True, False)), porch_posts=[-2.35, 0.2, 2.35])
    b = B.b
    barber_pole(b, 0.55, -2.45, 0.46, 1.6)
    mb = B.child("sign_swing_3", (-1.25, -2.62, porch_beam_bottom(4.3)))
    build_hanging_sign(mb, 1.2, 0.36, [("SHAVE · 15¢", "old", 0.15)], board="paintWhite", letter="paintOxblood", chain=0.1, frame="paintSlate")
    return B


def build_assay():
    B = false_front_shop("assay", "B", 3.55, 505, 3.9, 8.0, "woodRaw", "paintWhite",
                         [("ASSAYER", "old", 0.32)], 1.0, [(2.75, 1.35, 0.85, 1.6, dict(lights=(2, 1), bars=True))],
                         z_front=3.9, z_back=3.1, zff=5.4, siding="bb", side_mat="woodRaw", porch=False, sign_z=(4.35, 4.95),
                         boardwalk_kw=dict(x0=-1.8, x1=1.95, y_front=-1.6, steps=(1.0,), end_steps=(False, False)))
    b = B.b
    # T-bracket from the wall: an arm with a brace and a crossbar the sign hangs from (parallel to the facade)
    beam(b, (0.9, -0.04, 3.45), (0.9, -1.3, 3.45), 0.07, 0.09, "woodRaw")
    beam(b, (0.9, -0.04, 2.8), (0.9, -0.9, 3.41), 0.05, 0.06, "woodRaw")
    beam(b, (0.3, -1.22, 3.37), (1.5, -1.22, 3.37), 0.06, 0.07, "woodRaw")
    mb = B.child("sign_swing_4", (0.9, -1.22, 3.335))
    build_hanging_sign(mb, 1.0, 0.44, [("ASSAY", "alfa", 0.15), ("OFFICE", "alfa", 0.12)], board="paintDark", letter="paintMustard", chain=0.06, frame="paintDark")
    return B


def build_trading_post():
    return false_front_shop("trading_post", "C", -9.0, 606, 9.0, 11.0, "sidingWeathered", "woodRaw",
                            [("RED BUTTE", "rye", 0.42, 1.1), ("TRADING POST", "alfa", 0.3, 0.9)], 4.5,
                            [(1.7, 1.25, 1.2, 1.8, dict(lights=(2, 2))), (7.3, 1.25, 1.2, 1.8, dict(lights=(2, 2)))],
                            z_front=4.3, z_back=3.3, zff=6.6, sign_board="paintWhite", sign_letter="paintOxblood", sign_z=(4.8, 6.15),
                            door_kw=dict(w=1.5, h=2.3, trim_mat="woodRaw", leaf_mat="woodRaw", double=True, transom=0.3),
                            boardwalk_kw=dict(x0=-4.6, x1=4.6, steps=(0.0,), end_steps=(True, True)))


def build_blacksmith():
    """Blacksmith & farrier: front-gabled timber shed with an open front, a stone forge and chimney,
    anvil on a stump, quench tub, bellows and tool rack inside."""
    B = Building("blacksmith", "A", -14.0, 707)
    b = B.b
    W, D = 8.0, 10.0
    x0, x1 = -W / 2, W / 2
    ze, pitch = 3.7, 30.0
    tn = math.tan(math.radians(pitch))
    zr = ze + W / 2 * tn
    tie = 3.05
    wood = "woodRaw"
    gf = gable_wall_fn(0.0, W, ze, pitch)
    # front: open bays between posts, a tie beam, and a boarded gable with the sign
    posts = [x0 + 0.1, -1.35, 1.35, x1 - 0.1]
    for px in posts:
        box(b, px - 0.1, -0.1, -0.2, px + 0.1, 0.1, tie, wood, grain="z", skip={"-z"}, jitter=0.5)
        for sd in (-1, 1):
            if x0 < px + sd * 0.8 < x1:
                beam(b, (px + sd * 0.1, 0.0, tie - 0.75), (px + sd * 0.8, 0.0, tie + 0.02), 0.1, 0.08, wood, up=(0, 1, 0))
    box(b, x0, -0.11, tie, x1, 0.11, tie + 0.28, wood, grain="x")
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        bb_siding(b, 0.0, W, tie + 0.28, zr + 0.1, wood, top=lambda x: gf(x) + 0.05, holes=[(3.35, 4.65, 4.6, 5.4)])
        louvre_opening(b, 3.4, 4.6, 4.62, 5.38, wood)
        ff_sign(b, 0.55, W - 0.55, tie + 0.42, tie + 1.02, "paintDark", wood, [("BLACKSMITH & FARRIER", "ultra", 0.3)], "paintWhite", y=-0.07)
    # side and rear walls, two-sided boards (seen from inside)
    for o, d, length in (((x1, 0.0, 0), (0, 1), D), ((x0, D, 0), (0, -1), D)):
        with b.at(wall_frame(o, d)):
            holes = [(length * 0.5 - 0.5, length * 0.5 + 0.5, 1.4, 2.2)]
            bb_siding(b, 0.1, length, 0.0, ze, wood, holes=holes)
            box(b, length * 0.5 - 0.5, -0.06, 1.35, length * 0.5 + 0.5, 0.03, 1.4, wood, grain="x")
            for zz in (1.0, 2.2):
                box(b, 0.1, 0.0, zz, length - 0.1, 0.1, zz + 0.12, wood, grain="x", skip={"-y"})
            box(b, 0.0, 0.0, ze - 0.2, length, 0.14, ze, wood, grain="x", skip={"-y"})
            for k in range(1, int(length / 2.0)):
                box(b, k * 2.0 - 0.05, 0.0, 0.0, k * 2.0 + 0.05, 0.1, ze - 0.2, wood, grain="z", skip={"-y"})
    with b.at(wall_frame((x1, D, 0), (-1, 0))):
        bb_siding(b, 0.0, W, 0.0, zr + 0.1, wood, top=lambda x: gf(x) + 0.05, holes=[(5.3, 6.4, 1.4, 2.2)])
        for zz in (1.0, 2.2):
            box(b, 0.1, 0.0, zz, W - 0.1, 0.1, zz + 0.12, wood, grain="x", skip={"-y"})
    gable_roof_y(b, x0, x1, 0.0, D, ze, pitch, "tinRusty", end_front=True, ov_end=0.45)
    # interior: rafters and roof boards seen from below, a tie beam at mid-depth
    for i in range(int(D / 0.8) + 1):
        yy = 0.2 + (D - 0.4) * i / int(D / 0.8)
        for side in (-1, 1):
            beam(b, (side * (W / 2 - 0.05), yy, ze + 0.02), (0.0, yy, zr - 0.05), 0.05, 0.14, wood)
    for side in (-1, 1):
        pts = [(side * W / 2, 0.0, ze + 0.12), (side * W / 2, D, ze + 0.12), (0.0, D, zr + 0.03), (0.0, 0.0, zr + 0.03)]
        if side < 0:
            pts = list(reversed(pts))
        poly(b, pts, wood)
    box(b, x0, D * 0.5 - 0.1, ze - 0.05, x1, D * 0.5 + 0.1, ze + 0.15, wood, grain="x")
    # forge hearth, hood and stone chimney through the roof
    box(b, -3.8, 6.4, 0.0, -2.2, 8.4, 0.82, "stone", grain="x", skip={"-z"})
    box(b, -3.6, 6.65, 0.82, -2.4, 8.15, 0.86, "ironBlack")
    pts = [(-3.75, 6.5), (-2.25, 6.5), (-2.25, 8.3), (-3.75, 8.3)]
    for i in range(4):
        a, c = pts[i], pts[(i + 1) % 4]
        cx, cy = -3.0, 7.95
        q = [(a[0], a[1], 1.7), (c[0], c[1], 1.7), (cx + (c[0] - cx) * 0.35, cy + (c[1] - cy) * 0.35, 2.7), (cx + (a[0] - cx) * 0.35, cy + (a[1] - cy) * 0.35, 2.7)]
        quad(b, *q, "ironRust")
    chimney_stone(b, -3.35, 7.6, -2.65, 8.3, 0.86, zr + 0.6)
    # anvil on its stump, quench tub, bellows, tool rack, horseshoes
    cyl(b, (-1.2, 5.5, 0.0), (-1.2, 5.5, 0.55), 0.26, wood, n=10)
    box(b, -1.38, 5.32, 0.55, -1.02, 5.68, 0.62, "ironBlack")
    box(b, -1.48, 5.38, 0.62, -0.92, 5.62, 0.82, "ironBlack")
    # the horn: ax = +x, ay = +z extrudes along -y
    prism(b, [(0.0, 0.62), (0.32, 0.74), (0.32, 0.82), (0.0, 0.82)], (-0.92, 5.58, 0.0), (1, 0, 0), (0, 0, 1), 0.16, "ironBlack")
    barrel(b, -1.9, 4.2, 0.0, h=0.55, r=0.34, lid=False)
    poly(b, [(-1.9 + 0.29 * math.cos(2 * math.pi * i / 12), 4.2 + 0.29 * math.sin(2 * math.pi * i / 12), 0.45) for i in range(12)], "water")
    prism(b, [(0.0, 1.0), (1.4, 1.1), (1.4, 1.2), (0.0, 1.45)], (-3.95, 5.6, 0.0), (0, 1, 0), (0, 0, 1), 0.55, "paintDark")
    box(b, -4.0, 1.5, 1.5, -3.92, 4.5, 1.56, wood, grain="y")
    for k in range(8):
        ty = 1.7 + k * 0.33
        box(b, -3.96, ty - 0.01, 0.95, -3.93, ty + 0.01, 1.5, "ironBlack")
    for k in range(10):
        a = k * 0.6
        box(b, 1.5 + math.cos(a) * 0.2, 8.6 + math.sin(a) * 0.15, 0.0, 1.6 + math.cos(a) * 0.2, 8.7 + math.sin(a) * 0.15, 0.03 + k * 0.01, "ironRust")
    crate(b, 2.6, 8.8, 0.0, 0.7, 0.5, 0.5)
    barrel(b, 3.3, 8.9, 0.0)
    leaning_wheel(b, 2.8, -0.35, 0.68, mat="paintOxblood", lean=12, rot=0)
    leaning_wheel(b, -2.6, -0.3, 0.6, mat="woodRaw", lean=10, rot=4)
    return B


def build_livery():
    """Livery stable: a gable-front barn with lean-to wings, sliding doors on an iron track (one leaf
    open onto the dark aisle), an open hay-loft door under a hoist beam with pulley and rope."""
    B = Building("livery", "A", -25.5, 808)
    b = B.b
    D = 14.0
    xb0, xb1 = -4.0, 4.0
    ze, pitch = 5.2, 40.0
    tn = math.tan(math.radians(pitch))
    zr = ze + 4.0 * tn
    wood, trm = "woodRaw", "paintWhite"
    gf = gable_wall_fn(0.0, 8.0, ze, pitch)
    with b.at(wall_frame((xb0, 0, 0), (1, 0))):
        holes = [(2.25, 5.75, -0.2, 3.85), (3.25, 4.75, 5.4, 7.05)]
        bb_siding(b, 0.0, 8.0, 0.0, zr + 0.1, wood, holes=holes, top=lambda x: gf(x) + 0.05)
        # door frame, track and two sliding leaves (left one slid open)
        trim(b, 2.1, 2.25, 0.0, 3.95, trm, y0=-0.07, y1=0.0)
        trim(b, 5.75, 5.9, 0.0, 3.95, trm, y0=-0.07, y1=0.0)
        trim(b, 2.1, 5.9, 3.85, 4.0, trm, y0=-0.07, y1=0.0)
        box(b, 0.4, -0.14, 4.02, 7.6, -0.1, 4.1, "ironBlack")
        for (la, lc) in ((0.55, 2.3), (4.0, 5.8)):
            yl0, yl1 = -0.17, -0.12
            for k in range(int((lc - la) / 0.29) + 1):
                xa = la + k * (lc - la) / (int((lc - la) / 0.29) + 1)
                xc = la + (k + 1) * (lc - la) / (int((lc - la) / 0.29) + 1)
                box(b, xa + 0.003, yl0 + 0.02, 0.02, xc - 0.003, yl1 + 0.02, 3.9, wood, grain="z", jitter=0.3)
            for zz in (0.05, 1.85, 3.72):
                box(b, la, yl0 - 0.02, zz, lc, yl0 + 0.02, zz + 0.15, trm, grain="x")
            for za, zb in ((0.2, 1.85), (2.0, 3.72)):
                beam(b, (la + 0.08, yl0 - 0.01, za), (lc - 0.08, yl0 - 0.01, zb), 0.13, 0.04, trm, up=(0, 1, 0))
            for hx in (la + 0.3, lc - 0.3):
                box(b, hx - 0.03, -0.16, 3.9, hx + 0.03, -0.12, 4.1, "ironBlack")
        # loft door, swung open against the gable, with hay inside
        for a, c, za, zc in ((3.1, 3.25, 5.4, 7.15), (4.75, 4.9, 5.4, 7.15), (3.1, 4.9, 7.05, 7.2), (3.1, 4.9, 5.3, 5.42)):
            trim(b, a, c, za, zc, trm, y0=-0.07, y1=0.0, skip=())
        with b.at(T(4.9, -0.06, 0) @ RZ(-100)):
            for k in range(5):
                box(b, 0.02 + k * 0.29, -0.02, 5.45, 0.3 + k * 0.29, 0.02, 7.0, wood, grain="z", jitter=0.4)
            beam(b, (0.1, -0.035, 5.6), (1.35, -0.035, 6.85), 0.12, 0.03, trm, up=(0, 1, 0))
        # hoist beam, pulley, rope and hook
        box(b, 3.85, -1.3, 7.55, 4.15, 0.4, 7.82, wood, grain="y")
        cyl(b, (4.0, -1.1, 7.42), (4.0, -1.1, 7.55), 0.02, "ironBlack", n=6)
        cyl(b, (3.95, -1.1, 7.3), (4.05, -1.1, 7.3), 0.12, "woodRaw", n=10)
        cyl(b, (4.0, -1.22, 7.3), (4.0, -1.22, 4.9), 0.012, "hay", n=5)
        cyl(b, (4.0, -0.98, 7.3), (4.0, -0.98, 6.2), 0.012, "hay", n=5)
        box(b, 3.96, -1.25, 4.72, 4.04, -1.19, 4.9, "ironBlack")
        ff_sign(b, 1.3, 6.7, 4.28, 4.92, "paintOxblood", trm, [("LIVERY STABLE", "alfa", 0.36)], "paintWhite", y=-0.06)
    # hay in the loft and the dark aisle behind the doors
    for k in range(6):
        hay_bale(b, -0.6 + (k % 3) * 0.5, 0.7 + (k // 3) * 0.6, 5.42 + (k // 3) * 0.38, rot=(k * 17) % 9 - 4)
    box(b, -0.9, 0.4, 5.3, 0.9, 2.5, 5.42, wood, grain="x")
    interior_box(b, -1.75, 1.75, 0.15, 13.0, 0.0, 3.85, mat_wall="woodRaw", mat_floor="hay")
    for k in range(4):
        yy = 2.0 + k * 2.6
        box(b, -1.75, yy, 0.0, -1.69, yy + 0.06, 1.5, wood, grain="z")
        box(b, 1.69, yy, 0.0, 1.75, yy + 0.06, 1.5, wood, grain="z")
        box(b, -1.75, yy, 1.4, -1.6, yy + 2.4, 1.5, wood, grain="y")
        box(b, 1.6, yy, 1.4, 1.75, yy + 2.4, 1.5, wood, grain="y")
    # barn sides, lean-to wings, rear
    for o, d in (((xb1, 0.0, 0), (0, 1)), ((xb0, D, 0), (0, -1))):
        with b.at(wall_frame(o, d)):
            bb_siding(b, 0.0, D, 4.3, ze, wood)
            trim(b, 0.0, D, ze - 0.22, ze, trm, y0=-0.045, y1=0.0)
    with b.at(wall_frame((xb1, D, 0), (-1, 0))):
        bb_siding(b, 0.0, 8.0, 0.0, zr + 0.1, wood, top=lambda x: gf(x) + 0.05, holes=[(3.0, 5.0, 0.0, 3.2)])
    gable_roof_y(b, xb0, xb1, 0.0, D, ze, pitch, "woodRaw", end_front=True, ov_end=0.4, ov_side=0.35)
    for side in (-1, 1):
        xw0 = xb1 if side > 0 else xb0 - 2.6
        xw1 = xw0 + 2.6
        z_in, z_out = 4.3, 3.1
        outer = xw1 if side > 0 else xw0
        with b.at(wall_frame((xw0, 0, 0), (1, 0))):
            if side > 0:
                top = lambda x: z_in + (z_out - z_in) * x / 2.6  # noqa: E731
            else:
                top = lambda x: z_out + (z_in - z_out) * x / 2.6  # noqa: E731
            holes = [door(b, 1.3, 0.05, 1.0, 2.15, trm, wood, casing=0.1)]
            bb_siding(b, 0.0, 2.6, 0.0, 4.4, wood, holes=holes, top=lambda x, t=top: t(x))
            if side < 0:
                ff_sign(b, 0.35, 2.25, 2.55, 2.95, "paintWhite", trm, [("FEED & HAY", "alfa", 0.17)], "paintOxblood", y=-0.06)
        with b.at(wall_frame((outer, 0, 0) if side > 0 else (outer, D, 0), (0, 1) if side > 0 else (0, -1))):
            bb_siding(b, 0.0, D, 0.0, z_out, wood, holes=[(D * 0.3 - 0.4, D * 0.3 + 0.4, 1.5, 2.1), (D * 0.7 - 0.4, D * 0.7 + 0.4, 1.5, 2.1)])
        with b.at(wall_frame((xw1, D, 0), (-1, 0))):
            bb_siding(b, 0.0, 2.6, 0.0, 4.4, wood, top=lambda x: (z_in + (z_out - z_in) * (2.6 - x) / 2.6) if side > 0 else (z_out + (z_in - z_out) * (2.6 - x) / 2.6))
        # lean-to roof (falls away from the barn)
        xl, xh = (xw1 + 0.3, xb1) if side > 0 else (xw0 - 0.3, xb0)
        slope = (z_in - z_out) / 2.6
        zfun = lambda x, xh=xh, slope=slope: z_in + 0.12 - slope * abs(x - xh)  # noqa: E731
        roof_cover(b, min(xl, xh), max(xl, xh), -0.25, D + 0.25, zfun, "tinRusty", along="x")
        fx = xl - 0.025 if side > 0 else xl
        box(b, fx, -0.25, zfun(xl) - 0.22, fx + 0.025, D + 0.25, zfun(xl) - 0.01, "woodRaw", grain="y")
    return B


def build_hotel():
    """Copper Wells Hotel: three storeys of painted lap siding, a two-storey gallery across the front
    (balcony deck with balusters, roof on posts), shuttered upper windows, a false front with a
    bracketed cornice and pediment, stone chimneys and an exterior stair on the side."""
    B = Building("hotel", "B", -6.0, 909)
    b = B.b
    W, D = 14.0, 14.0
    x0, x1 = -W / 2, W / 2
    zf, z2, z3, ze, zff = 0.55, 4.15, 7.45, 10.6, 12.55
    pitch = 16.0
    body, trm, shut = "paintWhite", "paintDark", "paintSage"
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [door(b, 7.0, zf, 1.6, 2.45, trm, "woodVarnish", transom=0.5, double=True, glass_top=True)]
        for xc in (1.25, 3.55, 10.45, 12.75):
            holes.append(window(b, xc, zf + 0.8, 1.0, 2.05, trm, trm, lights=(2, 2)))
        for xc in (3.55, 10.45):
            holes.append(door(b, xc, z2 + 0.02, 0.95, 2.2, trm, "woodVarnish", transom=0.3, glass_top=True))
        holes.append(door(b, 7.0, z2 + 0.02, 1.3, 2.2, trm, "woodVarnish", transom=0.3, double=True, glass_top=True))
        for xc in (1.25, 5.5, 8.5, 12.75):
            holes.append(window(b, xc, z2 + 0.7, 0.9, 1.8, trm, trm, lights=(3, 2)))
        for xc in (1.3, 3.6, 5.85, 8.15, 10.4, 12.7):
            holes.append(window(b, xc, z3 + 0.8, 0.85, 1.65, trm, trm, lights=(3, 2), shutters=shut))
        holes.append((0.55, W - 0.55, 10.82, 12.13))
        lap_siding(b, 0.2, W - 0.2, 0.7, zff - 0.3, body, holes)
        trim(b, 0.0, W, -0.25, 0.7, trm, y0=-0.04, y1=0.0)
        for xa in (0.0, W - 0.2):
            trim(b, xa - (0.04 if xa == 0 else 0), xa + 0.2 + (0.04 if xa > 0 else 0), 0.7, zff - 0.3, trm, y0=-0.065, y1=0.0)
        for zz in (z2 - 0.12, z3 - 0.12):
            trim(b, 0.0, W, zz, zz + 0.2, trm, y0=-0.05, y1=-0.01)
        ff_sign(b, 0.6, W - 0.6, 10.88, 12.07, "paintDark", trm, [("COPPER WELLS HOTEL", "old", 0.62)], "paintWhite")
        cornice(b, 0.0, W, zff, trm, proj=0.45, brackets=12, frieze=0.3)
        # pediment over the centre bays
        gpf = lambda x: zff + 0.2 + max(0.0, 2.0 - abs(x - 7.0)) * 0.42  # noqa: E731
        lap_siding(b, 5.0, 9.0, zff + 0.2, zff + 1.05, body, top=gpf, exp=0.11)
        for sd in (-1, 1):
            p0 = Vector((7.0, -0.05, zff + 1.07))
            p1 = Vector((7.0 + sd * 2.25, -0.05, zff + 0.13))
            beam(b, p0, p1, 0.24, 0.12, trm, up=(0, 0, 1))
        letters(b, "1881", "old", 7.0, zff + 0.5, 0.24, trm, y=-0.024, depth=0.006, max_w=1.3)
    box(b, x0, 0.0, ze - 0.05, x1, 0.15, zff + 0.15, "woodRaw", grain="x", skip={"-y", "-z"})
    box(b, x0 + 5.0, 0.0, zff + 0.15, x0 + 9.0, 0.12, zff + 1.0, "woodRaw", grain="x", skip={"-y", "-z"})
    tn = math.tan(math.radians(pitch))
    sw = [(3.0, zf + 0.9, 0.9, 1.75, (2, 2)), (10.0, zf + 0.9, 0.9, 1.75, (2, 2)), (2.5, z2 + 0.75, 0.86, 1.7, (3, 2)), (11.5, z2 + 0.75, 0.86, 1.7, (3, 2)),
          (2.5, z3 + 0.8, 0.82, 1.6, (3, 2)), (7.0, z3 + 0.8, 0.82, 1.6, (3, 2)), (11.5, z3 + 0.8, 0.82, 1.6, (3, 2))]
    lw = [(3.0, zf + 0.9, 0.9, 1.75, (2, 2)), (11.0, zf + 0.9, 0.9, 1.75, (2, 2)), (2.5, z2 + 0.75, 0.86, 1.7, (3, 2)),
          (2.5, z3 + 0.8, 0.82, 1.6, (3, 2)), (7.0, z3 + 0.8, 0.82, 1.6, (3, 2)), (11.5, z3 + 0.8, 0.82, 1.6, (3, 2))]
    # the left wall runs from the back to the front; its side door opens onto the stair landing
    side_walls(b, x0, x1, D, 0.7, ze, ze, body, trm, left_wins=lw, right_wins=sw,
               left_fn=lambda bb: [door(bb, 9.1, z2 + 0.02, 0.9, 2.1, trm, "woodVarnish", transom=0.3)])
    rear_wall(b, x0, x1, D, 0.7, ze, body, trm, gable=gable_wall_fn(0.0, W, ze, pitch),
              holes_fn=lambda bb: [door(bb, 4.0, zf, 0.95, 2.1, trm, "woodRaw")] + [window(bb, xc, zz, 0.86, 1.65, trm, trm, lights=(3, 2)) for xc in (2.0, 7.0, 11.0) for zz in (z2 + 0.75, z3 + 0.8)])
    gable_roof_y(b, x0, x1, 0.15, D, ze, pitch, "tinGalv", end_front=False)
    for cx, cy in ((-3.2, 5.0), (3.2, 10.5)):
        zr = ze + (7.0 - abs(cx)) * tn + 0.17
        chimney_stone(b, cx - 0.35, cy - 0.3, cx + 0.35, cy + 0.3, zr - 0.6, zr + 1.3)
    # two-storey gallery: balcony deck on posts, then posts carrying the gallery roof
    posts = [x0 + 0.15, -4.45, -1.6, 1.6, 4.45, x1 - 0.15]
    beam_bot = balcony(b, x0, x1, 0.0, -2.75, z2 + 0.02, 0.5, posts, trm, "woodRaw", trm, fascia_mat=trm)
    shed_porch(b, x0, x1, 0.0, -2.75, 7.25, 6.78, z2 + 0.02, posts, trm, "woodRaw", roof="tinGalv", fascia_mat=trm, braces=True, post_w=0.13)
    boardwalk(b, x0 - 0.3, x1 + 0.75, -3.25, 0.5, steps=(0.0,), end_steps=(False, False))
    # exterior stair to the side door
    sx = x0 - 0.62
    stair(b, (sx, 11.2, 0.0), (0, -1), 1.0, z2 - 0.02, 5.4, 22, "woodRaw", tread_mat="woodRaw", rail=True, rail_side=-1)
    box(b, sx - 0.55, 3.9, z2 - 0.06, x0 - 0.02, 5.85, z2 + 0.0, "boardwalk", grain="y")
    for py in (3.95, 5.8):
        box(b, sx - 0.55, py - 0.06, -0.2, sx - 0.43, py + 0.06, z2 - 0.06, "woodRaw", grain="z", skip={"-z"})
    with b.at(Matrix.Translation((sx - 0.49, 0, 0)) @ RZ(90)):
        railing(b, 3.95, 5.85, z2, "woodRaw", y=0.0)
    for i, lx in ((5, -1.0), (6, 1.0)):
        mb = B.child(f"lantern_{i}", (lx, -2.1, z2 - 0.042 - 0.2))
        build_lantern(mb, drop=0.3)
    return B


def stone_sashes(b, x0, x1, z0, z1, y, mat, lights=(2, 2)):
    """Sash pair and glass set back inside a stone reveal (no casings)."""
    st = 0.055
    zm = (z0 + z1) / 2
    for lower in (True, False):
        ya, yb = (y, y + 0.035) if lower else (y + 0.04, y + 0.075)
        za, zb = (z0, zm + 0.016) if lower else (zm - 0.016, z1)
        box(b, x0, ya, za, x0 + st, yb, zb, mat, grain="z", skip={"+y"})
        box(b, x1 - st, ya, za, x1, yb, zb, mat, grain="z", skip={"+y"})
        box(b, x0 + st, ya, za, x1 - st, yb, za + (0.075 if lower else 0.032), mat, grain="x", skip={"+y"})
        box(b, x0 + st, ya, zb - (0.032 if lower else 0.05), x1 - st, yb, zb, mat, grain="x", skip={"+y"})
        cols, rows = lights
        for c in range(1, cols):
            mx = x0 + st + (x1 - x0 - 2 * st) * c / cols
            box(b, mx - 0.01, ya + 0.004, za, mx + 0.01, yb - 0.006, zb, mat, grain="z", skip={"+y"})
    glass_quad(b, x0, x1, z0, z1, y + 0.082)


def build_bank():
    """Bank of Copper Wells: a rough-faced sandstone front (plinth, quoins, lintels with keystones,
    belt course, cornice and parapet) on a timber building; barred ground-floor windows."""
    B = Building("bank", "B", 10.0, 1010)
    b = B.b
    W, D = 8.0, 12.0
    x0, x1 = -W / 2, W / 2
    zf, z2, ze, zp = 0.75, 4.6, 8.0, 9.05
    th = 0.32
    sash = "paintDark"
    openings = [(3.25, 4.75, zf, 3.75), (0.85, 2.05, 1.55, 3.7), (5.95, 7.15, 1.55, 3.7),
                (0.9, 1.95, 5.25, 6.95), (3.48, 4.52, 5.25, 6.95), (6.05, 7.1, 5.25, 6.95)]
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        slab_with_holes(b, 0.0, W, -0.2, ze, -th, 0.0, openings, "stone")
        # plinth, belt course, quoins
        box(b, -0.04, -th - 0.06, -0.2, W + 0.04, 0.0, zf - 0.05, "stone", grain="x", skip={"-z", "+y"})
        box(b, -0.05, -th - 0.07, zf - 0.08, W + 0.05, 0.0, zf, "stone", grain="x", skip={"+y"})
        box(b, -0.03, -th - 0.06, z2 - 0.15, W + 0.03, 0.0, z2 + 0.12, "stone", grain="x", skip={"+y"})
        for side in (0, 1):
            for k in range(int((ze - zf) / 0.36)):
                za = zf + k * 0.36
                if z2 - 0.17 < za + 0.33 and za < z2 + 0.14:
                    continue
                wq = 0.48 if k % 2 == 0 else 0.3
                xa, xc = (-0.02, wq) if side == 0 else (W - wq, W + 0.02)
                box(b, xa, -th - 0.035, za + 0.01, xc, -th + 0.01, za + 0.34, "stone", grain="x", skip={"+y"})
        for hx0, hx1, hz0, hz1 in openings:
            if hz1 < ze - 0.3:
                box(b, hx0 - 0.14, -th - 0.05, hz1, hx1 + 0.14, -th + 0.02, hz1 + 0.3, "stone", grain="x", skip={"+y"})
                km = (hx0 + hx1) / 2
                box(b, km - 0.11, -th - 0.08, hz1 - 0.04, km + 0.11, -th + 0.02, hz1 + 0.36, "stone", grain="z", skip={"+y"})
            if hz0 > zf + 0.1:
                box(b, hx0 - 0.08, -th - 0.1, hz0 - 0.12, hx1 + 0.08, -th + 0.02, hz0, "stone", grain="x", skip={"+y"})
        # cornice, parapet with a raised centre block
        for (dy, z0_, z1_) in ((0.06, ze - 0.45, ze - 0.3), (0.13, ze - 0.3, ze - 0.12), (0.22, ze - 0.12, ze)):
            box(b, -0.06 - dy * 0.4, -th - dy, z0_, W + 0.06 + dy * 0.4, 0.0, z1_, "stone", grain="x", skip={"+y"})
        box(b, 0.0, -th + 0.02, ze, W, 0.0, zp - 0.12, "stone", grain="x", skip={"-z"})
        box(b, -0.08, -th - 0.06, zp - 0.12, W + 0.08, 0.08, zp, "stone", grain="x")
        box(b, 2.6, -th + 0.0, zp, 5.4, 0.0, zp + 0.55, "stone", grain="x", skip={"-z"})
        box(b, 2.5, -th - 0.06, zp + 0.55, 5.5, 0.06, zp + 0.66, "stone", grain="x")
        letters(b, "1882", "old", 4.0, zp + 0.28, 0.26, "stone", y=-th, depth=0.012, max_w=2.2)
        # gilt lettering on a dark board set in the parapet
        ff_sign(b, 0.42, W - 0.42, ze + 0.12, zp - 0.24, "paintDark", "paintDark", [("BANK OF COPPER WELLS", "old", 0.36)], "paintMustard", y=-th - 0.01)
        # sashes, bars, door
        for hx0, hx1, hz0, hz1 in openings[1:]:
            stone_sashes(b, hx0, hx1, hz0, hz1, -0.12, sash, lights=(2, 2) if hz0 < z2 else (2, 1))
            box(b, hx0, -0.14, hz0 - 0.015, hx1, 0.0, hz0, "stone", grain="x")
        for hx0, hx1, hz0, hz1 in openings[1:3]:
            n = 6
            for i in range(1, n):
                bx = hx0 + (hx1 - hx0) * i / n
                cyl(b, (bx, -0.2, hz0), (bx, -0.2, hz1), 0.012, "ironBlack", n=6)
            box(b, hx0, -0.21, hz0 + 0.5, hx1, -0.19, hz0 + 0.54, "ironBlack")
            box(b, hx0, -0.21, hz1 - 0.5, hx1, -0.19, hz1 - 0.46, "ironBlack")
        panel_door(b, 3.25, 3.997, zf, 2.5, "woodVarnish", y_front=-0.12, glass_top=True)
        panel_door(b, 4.003, 4.75, zf, 2.5, "woodVarnish", y_front=-0.12, glass_top=True)
        box(b, 3.25, -0.14, zf + 2.5, 4.75, 0.0, zf + 2.58, "woodVarnish", grain="x")
        glass_quad(b, 3.25, 4.75, zf + 2.58, 3.75, -0.06)
        letters(b, "BANK", "old", 4.0, zf + 3.16, 0.2, "paintMustard", y=-0.062, depth=0.004, max_w=1.2)
        # steps up to the door
        for k in range(3):
            box(b, 2.95 - k * 0.12, -th - 0.32 - k * 0.32, zf - 0.25 * (k + 1), 5.05 + k * 0.12, -th, zf - 0.25 * k, "stone", grain="x", skip={"-z"})
    box(b, x0, 0.0, ze - 1.2, x1, 0.12, zp - 0.12, "woodRaw", grain="x", skip={"-y", "-z"})
    side_walls(b, x0, x1, D, 0.75, ze - 0.55, 6.7, "sidingWeathered", "woodRaw",
               left_wins=[(4.0, 1.55, 0.86, 1.7, (2, 2)), (8.0, z2 + 0.7, 0.86, 1.6, (2, 1))],
               right_wins=[(4.5, 1.55, 0.86, 1.7, (2, 2)), (8.5, z2 + 0.7, 0.86, 1.6, (2, 1))])
    rear_wall(b, x0, x1, D, 0.75, 6.7, "sidingWeathered", "woodRaw",
              holes_fn=lambda bb: [door(bb, 2.0, zf, 0.9, 2.05, "woodRaw", "ironRust"), window(bb, 5.5, 1.55, 0.86, 1.6, "woodRaw", "woodRaw", lights=(2, 1), bars=True)])
    zr = shed_roof_back(b, x0, x1, 0.0, D, ze - 0.55, 6.7, mat="tinGalv")
    stovepipe(b, 2.2, 8.0, zr(8.0) + 0.02, 1.1)
    return B


def build_church():
    """A small white board church: front-gabled nave with lancet windows under pointed heads, a square
    tower with a louvred belfry and a shingled spire with a cross."""
    B = Building("church", "B", -25.0, 1111)
    b = B.b
    W, D = 7.0, 13.0
    x0, x1 = -W / 2, W / 2
    zf, ze, pitch = 0.6, 5.4, 48.0
    tn = math.tan(math.radians(pitch))
    zr = ze + 3.5 * tn
    body, trm = "paintWhite", "paintWhite"
    gf = gable_wall_fn(0.0, W, ze, pitch)
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [(2.2, 4.8, 0.0, zr + 0.2)]
        for xc in (1.05, 5.95):
            holes.append(window(b, xc, 2.0, 0.6, 1.5, trm, trm, lights=(1, 2)))
            gothic_head(b, xc, 3.5 + 0.15, 0.6, 0.45, trm)
        lap_siding(b, 0.12, W - 0.12, 0.7, zr + 0.1, body, holes, top=lambda x: gf(x) - 0.08)
        trim(b, 0.0, W, -0.2, 0.72, trm, y0=-0.04, y1=0.0)
        corner_board(b, 0.0, 0.7, ze, trm, -1, wrap=0.05)
        corner_board(b, W, 0.7, ze, trm, 1, wrap=0.05)
    for side in (-1, 1):
        p0 = Vector((0.0, -0.06, zr + 0.12))
        p1 = Vector((side * (3.5 + 0.35), -0.06, ze - 0.35 * tn + 0.12))
        beam(b, p0, p1, 0.04, 0.24, trm)
    lancets = [(xc, 1.5, 0.85, 2.3, (2, 3)) for xc in (2.6, 5.5, 8.4, 11.0)]
    side_walls(b, x0, x1, D, 0.7, ze, ze, body, trm, left_wins=lancets, right_wins=lancets)
    for o, d in (((x1, 0.0, 0), (0, 1)), ((x0, D, 0), (0, -1))):
        with b.at(wall_frame(o, d)):
            for xc in (2.6, 5.5, 8.4, 11.0):
                gothic_head(b, xc, 1.5 + 2.3 + 0.15, 0.85, 0.6, trm)
    rear_wall(b, x0, x1, D, 0.7, ze, body, trm, gable=lambda x: gf(x) - 0.08, holes_fn=lambda bb: [window(bb, 3.5, 2.2, 0.8, 1.8, trm, trm, lights=(2, 2))])
    gable_roof_y(b, x0, x1, 0.0, D, ze, pitch, "woodRaw", fascia=trm, frame=trm, end_front=True, ov_end=0.3, ov_side=0.35, tails=False)
    # tower
    tx0, tx1, ty0, ty1 = -1.3, 1.3, -1.3, 1.3
    zt1, zb1 = 10.0, 12.3
    for o, d, length in (((tx0, ty0, 0), (1, 0), 2.6), ((tx1, ty0, 0), (0, 1), 2.6), ((tx1, ty1, 0), (-1, 0), 2.6), ((tx0, ty1, 0), (0, -1), 2.6)):
        with b.at(wall_frame(o, d)):
            holes = []
            if d == (1, 0):
                holes.append(door(b, 1.3, zf, 1.3, 2.35, trm, "woodVarnish", double=True))
                gothic_head(b, 1.3, zf + 2.35 + 0.16 + 0.03, 1.3, 0.75, trm, casing=0.11)
                holes.append(window(b, 1.3, 5.6, 0.55, 1.4, trm, trm, lights=(1, 2)))
                gothic_head(b, 1.3, 7.0 + 0.15, 0.55, 0.42, trm)
                ff_sign(b, 0.35, 2.25, 7.95, 8.45, "paintDark", trm, [("FIRST CHURCH", "old", 0.15)], "paintWhite", y=-0.06)
            holes.append((0.25, 2.35, zt1 + 0.35, zb1 - 0.3))
            lap_siding(b, 0.1, length - 0.1, 0.7, zb1, body, holes)
            louvre_opening(b, 0.3, 2.3, zt1 + 0.4, zb1 - 0.35, trm)
            trim(b, 0.0, length, zt1 - 0.1, zt1 + 0.12, trm, y0=-0.07, y1=0.0)
            corner_board(b, 0.0, 0.7, zb1, trm, -1, wrap=0.05)
            corner_board(b, length, 0.7, zb1, trm, 1, wrap=0.05)
            trim(b, -0.05, length + 0.05, -0.2, 0.72, trm, y0=-0.04, y1=0.0)
            cornice(b, -0.05, length + 0.05, zb1 + 0.28, trm, proj=0.22, frieze=0.28, returns=False)
    for k in range(3):
        box(b, -1.0 - k * 0.0, ty0 - 0.3 - k * 0.3, zf - 0.2 * (k + 1), 1.0, ty0 - k * 0.3, zf - 0.2 * k, "woodRaw", grain="x", skip={"-z"})
    shingle_pyramid(b, 0.0, 0.0, zb1 + 0.45, 1.58, 5.6, "paintWhite", courses=26, top_half=0.05)
    cyl(b, (0, 0, zb1 + 6.0), (0, 0, zb1 + 6.35), 0.05, "ironBlack", n=8)
    box(b, -0.03, -0.03, zb1 + 6.3, 0.03, 0.03, zb1 + 7.15, "ironBlack")
    box(b, -0.22, -0.03, zb1 + 6.78, 0.22, 0.03, zb1 + 6.84, "ironBlack")
    return B


def build_windpump():
    """Wooden lattice tower with a sail-wheel wind pump, tail vane, pump rod and stock tank."""
    B = Building("windpump", "B", 21.0, 1212)
    b = B.b
    H = 11.6
    hb, ht = 1.65, 0.42
    wood = "woodRaw"
    hf = lambda z: hb + (ht - hb) * z / H  # noqa: E731
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for cx, cy in corners:
        beam(b, (cx * hb, cy * hb, -0.4), (cx * ht, cy * ht, H), 0.13, 0.13, wood, up=(0, 0, 1))
        box(b, cx * hb - 0.25, cy * hb - 0.25, -0.2, cx * hb + 0.25, cy * hb + 0.25, 0.12, "stone", grain="x", skip={"-z"})
    levels = [0.25, 2.3, 4.3, 6.2, 8.0, 9.8, H - 0.1]
    for z in levels:
        h = hf(z)
        for i in range(4):
            ax, ay = corners[i]
            bx, by = corners[(i + 1) % 4]
            beam(b, (ax * h, ay * h, z), (bx * h, by * h, z), 0.07, 0.11, wood)
    for k in range(len(levels) - 1):
        za, zb = levels[k], levels[k + 1]
        ha, hb_ = hf(za), hf(zb)
        for i in range(4):
            ax, ay = corners[i]
            bx, by = corners[(i + 1) % 4]
            beam(b, (ax * ha, ay * ha, za), (bx * hb_, by * hb_, zb), 0.04, 0.07, wood)
            beam(b, (bx * ha, by * ha, za), (ax * hb_, ay * hb_, zb), 0.04, 0.07, wood)
    # ladder on the front-left leg, platform, head casting
    for k in range(int(H / 0.32)):
        z = 0.3 + k * 0.32
        h = hf(z)
        box(b, -h - 0.02, -h - 0.06, z, -h + 0.42, -h - 0.02, z + 0.035, wood, grain="x")
    pd = 0.85
    box(b, -pd, -pd, H, pd, pd, H + 0.05, "boardwalk", grain="x")
    box(b, -0.18, -0.18, H + 0.05, 0.18, 0.18, H + 0.25, "ironBlack")
    cyl(b, (0, 0, H + 0.25), (0, 0, H + 0.4), 0.16, "ironBlack", n=10)
    # pump rod, pump stand, stock tank
    cyl(b, (0, 0, 0.9), (0, 0, H), 0.02, "ironBlack", n=6)
    cyl(b, (0, 0, -0.2), (0, 0, 0.95), 0.07, "ironRust", n=8)
    box(b, -0.1, -0.1, 0.9, 0.1, 0.1, 1.05, "ironBlack")
    beam(b, (0.05, 0, 0.8), (0.6, -0.2, 0.75), 0.05, 0.05, "ironRust")
    lathe(b, [(1.5, 0.0), (1.5, 0.62), (1.42, 0.62), (1.42, 0.08)], wood, n=24, o=(0.9, -2.4, 0), cap_top=False)
    poly(b, [(0.9 + 1.42 * math.cos(2 * math.pi * i / 24), -2.4 + 1.42 * math.sin(2 * math.pi * i / 24), 0.5) for i in range(24)], "water")
    for zz in (0.12, 0.5):
        lathe(b, [(1.51, zz - 0.025), (1.51, zz + 0.025)], "ironRust", n=24, o=(0.9, -2.4, 0), cap_top=False)
    # rotor: sail wheel on an axle along local Y
    hub_z = H + 0.9
    mb = B.child("windmill_rotor", (0.0, -0.75, hub_z))
    cyl(mb, (0, -0.25, 0), (0, 0.6, 0), 0.12, "ironBlack", n=10)
    cyl(mb, (0, -0.32, 0), (0, -0.25, 0), 0.08, "ironBlack", n=10)
    nsail = 18
    r0, r1 = 0.75, 2.3
    for ring_r, w in ((r0, 0.05), (1.5, 0.04), (r1, 0.05)):
        for i in range(nsail):
            a0 = 2 * math.pi * i / nsail
            a1 = 2 * math.pi * (i + 1) / nsail
            beam(mb, (math.cos(a0) * ring_r, 0.02, math.sin(a0) * ring_r), (math.cos(a1) * ring_r, 0.02, math.sin(a1) * ring_r), w, 0.04, wood, up=(0, 1, 0))
    for i in range(nsail):
        a = 2 * math.pi * (i + 0.5) / nsail
        rd = Vector((math.cos(a), 0, math.sin(a)))
        if i % 3 == 0:
            beam(mb, rd * 0.1, rd * r1, 0.035, 0.05, wood, up=(0, 1, 0))
        tang = Vector((-math.sin(a), 0, math.cos(a)))
        pitch_ = math.radians(32)
        across = (tang * math.cos(pitch_) + Vector((0, 1, 0)) * math.sin(pitch_))
        w0, w1 = 0.16, 0.3
        p = [rd * r0 - across * w0 / 2, rd * r0 + across * w0 / 2, rd * r1 + across * w1 / 2, rd * r1 - across * w1 / 2]
        nrm = across.cross(rd)
        off = nrm * 0.008
        q = [v + Vector((0, -0.03, 0)) for v in p]
        mb.face([q[0] + off, q[1] + off, q[2] + off, q[3] + off], [(0, 0), (0, 0.15), (0.6, 0.15), (0.6, 0)], wood)
        mb.face([q[0] - off, q[3] - off, q[2] - off, q[1] - off], [(0, 0), (0.6, 0), (0.6, 0.15), (0, 0.15)], wood)
    # tail vane on a boom; pivot on the tower axis
    mb = B.child("windmill_vane", (0.0, 0.0, H + 0.4))
    box(mb, -0.12, -0.8, 0.0, 0.12, 0.35, 0.3, "ironBlack")
    cyl(mb, (0, -0.8, 0.5), (0, -0.2, 0.5), 0.05, "ironBlack", n=8)
    beam(mb, (0, 0.3, 0.2), (0, 3.0, 0.45), 0.07, 0.1, wood)
    beam(mb, (0, 0.3, 0.05), (0, 2.4, 0.4), 0.04, 0.05, wood)
    beam(mb, (0, 0.3, 0.38), (0, 2.4, 0.5), 0.04, 0.05, wood)
    with mb.at(T(0, 0, 0)):
        for k in range(5):
            z0 = -0.1 + k * 0.22
            box(mb, -0.012, 2.3, z0, 0.012, 3.55, z0 + 0.21, "paintOxblood", grain="y", jitter=0.3)
        box(mb, -0.03, 2.25, -0.12, 0.03, 2.33, 1.05, wood, grain="z")
        box(mb, -0.03, 3.5, -0.12, 0.03, 3.58, 1.05, wood, grain="z")
    return B


def build_watertank():
    """Wooden stave water tank with iron hoops and a conical roof on a braced timber trestle."""
    B = Building("watertank", "B", 17.2, 1313)
    b = B.b
    wood = "woodRaw"
    hs = 1.55
    zt = 6.0
    for cx, cy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        box(b, cx * hs - 0.13, cy * hs - 0.13, -0.3, cx * hs + 0.13, cy * hs + 0.13, zt, wood, grain="z", skip={"-z"}, jitter=0.3)
        box(b, cx * hs - 0.3, cy * hs - 0.3, -0.2, cx * hs + 0.3, cy * hs + 0.3, 0.15, "stone", grain="x", skip={"-z"})
    for z in (0.6, 3.2, zt - 0.3):
        for (ax, ay), (bx, by) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            beam(b, (ax * hs, ay * hs, z), (bx * hs, by * hs, z), 0.08, 0.16, wood)
    for za, zb in ((0.6, 3.2), (3.2, zt - 0.3)):
        for (ax, ay), (bx, by) in (((-1, -1), (1, -1)), ((1, -1), (1, 1)), ((1, 1), (-1, 1)), ((-1, 1), (-1, -1))):
            beam(b, (ax * hs, ay * hs, za), (bx * hs, by * hs, zb), 0.05, 0.1, wood)
            beam(b, (bx * hs, by * hs, za), (ax * hs, ay * hs, zb), 0.05, 0.1, wood)
    for k in range(6):
        y = -hs - 0.2 + k * (2 * hs + 0.4) / 5
        box(b, -hs - 0.2, y - 0.06, zt, hs + 0.2, y + 0.06, zt + 0.22, wood, grain="x")
    box(b, -hs - 0.3, -hs - 0.3, zt + 0.22, hs + 0.3, hs + 0.3, zt + 0.27, "boardwalk", grain="x")
    # staves
    R, z0, z1 = 2.05, zt + 0.27, zt + 3.5
    n = 40
    t = TEXOF["woodRaw"]
    for i in range(n):
        a0, a1 = 2 * math.pi * i / n, 2 * math.pi * (i + 1) / n
        p = [(R * math.cos(a0), R * math.sin(a0), z0), (R * math.cos(a1), R * math.sin(a1), z0), (R * math.cos(a1), R * math.sin(a1), z1), (R * math.cos(a0), R * math.sin(a0), z1)]
        lo, hi = b.rng.choice(t.strips)
        u0 = b.rng.random()
        hgt = (z1 - z0) / t.size
        b.face(p, [(lo, u0), (hi, u0), (hi, u0 + hgt), (lo, u0 + hgt)], wood)
        ri = R - 0.06
        b.face([(R * math.cos(a0), R * math.sin(a0), z1), (R * math.cos(a1), R * math.sin(a1), z1), (ri * math.cos(a1), ri * math.sin(a1), z1), (ri * math.cos(a0), ri * math.sin(a0), z1)],
               [(lo, 0), (hi, 0), (hi, 0.03), (lo, 0.03)], wood)
    for k in range(6):
        zz = z0 + 0.25 + k * (z1 - z0 - 0.4) / 5
        lathe(b, [(R + 0.012, zz - 0.025), (R + 0.012, zz + 0.025)], "ironRust", n=n, cap_top=False)
        box(b, R - 0.02, -0.06, zz - 0.04, R + 0.06, 0.06, zz + 0.04, "ironRust")
    lathe(b, [(R + 0.18, z1 - 0.05), (R + 0.15, z1 + 0.02), (0.25, z1 + 1.15), (0.06, z1 + 1.25)], "woodRaw", n=n, cap_top=True)
    lathe(b, [(0.06, z1 + 1.25), (0.05, z1 + 1.55), (0.001, z1 + 1.6)], "ironBlack", n=8)
    # ladder and outlet pipe
    for k in range(int((z1 - 0.2) / 0.32)):
        z = 0.3 + k * 0.32
        if z < zt:
            box(b, -0.25, -hs - 0.2, z, 0.25, -hs - 0.16, z + 0.035, wood, grain="x")
        else:
            box(b, -0.25, -R - 0.12, z, 0.25, -R - 0.08, z + 0.035, wood, grain="x")
    for sx in (-0.27, 0.27):
        box(b, sx - 0.03, -hs - 0.21, 0.0, sx + 0.03, -hs - 0.15, zt, wood, grain="z")
        box(b, sx - 0.03, -R - 0.13, zt, sx + 0.03, -R - 0.07, z1 + 0.6, wood, grain="z")
    cyl(b, (0.6, 0.6, zt + 0.27), (0.6, 0.6, 0.9), 0.09, "ironRust", n=8)
    beam(b, (0.6, 0.6, 0.95), (0.6, -0.4, 1.4), 0.08, 0.08, "ironRust")
    return B


def build_boarding_house():
    """Two-storey side-gabled boarding house with a long porch (row C)."""
    B = Building("boarding_house", "C", 6.0, 1414)
    b = B.b
    W, D = 10.0, 8.0
    x0, x1 = -W / 2, W / 2
    zf, z2, ze, pitch = 0.5, 3.75, 6.6, 34.0
    body, trm = "sidingWeathered", "paintWhite"
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [door(b, 5.0, zf, 0.95, 2.15, trm, "paintDark", transom=0.32)]
        for xc in (1.4, 3.2, 6.8, 8.6):
            holes.append(window(b, xc, zf + 0.85, 0.9, 1.7, trm, trm, lights=(3, 2)))
        for xc in (1.4, 3.2, 5.0, 6.8, 8.6):
            holes.append(window(b, xc, z2 + 0.7, 0.86, 1.6, trm, trm, lights=(3, 2)))
        lap_siding(b, 0.1, W - 0.1, 0.6, ze - 0.2, body, holes)
        trim(b, 0.0, W, -0.2, 0.62, trm, y0=-0.04, y1=0.0)
        corner_board(b, 0.0, 0.6, ze, trm, -1, wrap=0.05)
        corner_board(b, W, 0.6, ze, trm, 1, wrap=0.05)
        trim(b, 0.0, W, ze - 0.24, ze - 0.02, trm, y0=-0.03, y1=0.0)
    gf = gable_wall_fn(0.0, D, ze, pitch)
    for o, d in (((x1, 0.0, 0), (0, 1)), ((x0, D, 0), (0, -1))):
        with b.at(wall_frame(o, d)):
            holes = [window(b, 4.0, z2 + 0.7, 0.86, 1.6, trm, trm, lights=(3, 2)), window(b, 4.0, zf + 0.85, 0.86, 1.6, trm, trm, lights=(3, 2))]
            lap_siding(b, 0.05, D - 0.05, 0.6, ze + 2.8, body, holes, top=lambda x: gf(x) - 0.1)
            trim(b, 0.0, D, -0.2, 0.62, trm, y0=-0.035, y1=0.0)
    with b.at(wall_frame((x1, D, 0), (-1, 0))):
        holes = [door(b, 7.0, zf, 0.9, 2.05, trm, "woodRaw")] + [window(b, xc, z2 + 0.7, 0.86, 1.6, trm, trm, lights=(3, 2)) for xc in (2.0, 5.0, 8.0)]
        lap_siding(b, 0.1, W - 0.1, 0.6, ze - 0.2, body, holes)
        corner_board(b, 0.0, 0.6, ze, trm, -1, wrap=0.05)
        corner_board(b, W, 0.6, ze, trm, 1, wrap=0.05)
    with b.at(T(0, D / 2, 0) @ RZ(90)):
        gable_roof_y(b, -D / 2, D / 2, -W / 2, W / 2, ze, pitch, "tinRusty", fascia=trm)
    stovepipe(b, -2.5, 5.5, ze + (4.0 - 1.5) * math.tan(math.radians(pitch)) + 0.17, 1.0)
    chimney_stone(b, 1.8, 3.7, 2.4, 4.3, ze + 1.5, ze + 2.9)
    boardwalk(b, x0, x1, -2.4, 0.45, steps=(0.0,), end_steps=(False, False), gaps=True)
    shed_porch(b, x0, x1, 0.0, -2.1, 3.45, 2.95, 0.45, [x0 + 0.15, -1.7, 1.7, x1 - 0.15], trm, "woodRaw", roof="tinRusty", fascia_mat=trm)
    # sign board standing on the porch roof edge
    with b.at(wall_frame((x0, -2.3, 0), (1, 0))):
        ff_sign(b, 3.0, 7.0, 3.14, 3.58, "paintWhite", trm, [("BOARD & ROOMS", "alfa", 0.22)], "paintDark", y=-0.05)
    for sx in (-1.6, 1.6):
        box(b, sx - 0.04, -2.28, 3.0, sx + 0.04, -2.2, 3.6, "woodRaw", grain="z")
    return B


def build_shack(kind, row, s, seed, W=4.2, D=5.0, roof="tinRusty", door_x=None, rot=0.0, d=0.0, window_x=None, stove=True):
    """Small board-and-batten shack or shed with a gable front."""
    B = Building(kind, row, s, seed, d=d, rot=rot)
    b = B.b
    x0, x1 = -W / 2, W / 2
    ze, pitch = 2.7, 30.0
    tn = math.tan(math.radians(pitch))
    gf = gable_wall_fn(0.0, W, ze, pitch)
    wood = "woodRaw"
    with b.at(wall_frame((x0, 0, 0), (1, 0))):
        holes = [door(b, door_x if door_x is not None else W * 0.35, 0.25, 0.85, 1.95, wood, wood)]
        if window_x is not None:
            holes.append(window(b, window_x, 1.1, 0.6, 0.8, wood, wood, lights=(2, 1)))
        bb_siding(b, 0.0, W, 0.0, ze + W / 2 * tn + 0.1, wood, holes=holes, top=lambda x: gf(x) + 0.03)
    for o, dd in (((x1, 0.0, 0), (0, 1)), ((x0, D, 0), (0, -1))):
        with b.at(wall_frame(o, dd)):
            bb_siding(b, 0.0, D, 0.0, ze, wood, holes=[(D * 0.5 - 0.3, D * 0.5 + 0.3, 1.2, 1.8)])
            box(b, D * 0.5 - 0.3, -0.02, 1.2, D * 0.5 + 0.3, 0.02, 1.8, "paintDark", skip={"+y"})
    with b.at(wall_frame((x1, D, 0), (-1, 0))):
        bb_siding(b, 0.0, W, 0.0, ze + W / 2 * tn + 0.1, wood, top=lambda x: gf(x) + 0.03)
    gable_roof_y(b, x0, x1, 0.0, D, ze, pitch, roof, end_front=True, ov_end=0.25)
    if stove:
        stovepipe(b, x0 + W * 0.7, D * 0.65, ze + (W / 2 - W * 0.2) * tn + 0.17, 0.9)
    for k in range(2):
        box(b, -0.5, -0.3 - k * 0.3, 0.25 - 0.12 * (k + 1), 0.5, -k * 0.3, 0.25 - 0.12 * k, wood, grain="x", skip={"-z"})
    return B


def build_outhouse(kind, row, s, seed, d=0.0):
    B = Building(kind, row, s, seed, d=d)
    b = B.b
    wood = "woodRaw"
    for o, dd, ln, top in (((-0.65, 0, 0), (1, 0), 1.3, lambda x: 2.35), ((0.65, 0, 0), (0, 1), 1.3, lambda x: 2.35 - 0.35 * x / 1.3),
                           ((0.65, 1.3, 0), (-1, 0), 1.3, lambda x: 2.0), ((-0.65, 1.3, 0), (0, -1), 1.3, lambda x: 2.0 + 0.35 * x / 1.3)):
        with b.at(wall_frame(o, dd)):
            holes = [(0.25, 1.05, 0.05, 1.95)] if dd == (1, 0) else []
            bb_siding(b, 0.0, ln, 0.0, 2.4, wood, holes=holes, top=top, bw=(0.2, 0.26))
            if dd == (1, 0):
                for k in range(3):
                    box(b, 0.26 + k * 0.265, -0.06, 0.06, 0.26 + (k + 1) * 0.265 - 0.005, -0.035, 1.93, wood, grain="z", jitter=0.4)
                beam(b, (0.3, -0.075, 0.3), (1.0, -0.075, 1.6), 0.1, 0.02, wood, up=(0, 1, 0))
    roof_cover(b, -0.8, 0.8, -0.2, 1.5, lambda y: 2.4 - 0.35 * (y + 0.2) / 1.7 + 0.02, "tinRusty", downslope=1)
    return B


def build_corral():
    """Weathered post-and-rail corral (16 x 11 m, three rails, a braced gate) with a trough and a hay
    feeder inside; the interior is left empty for the game's horses."""
    B = Building("corral", "A", 0.0, 1515)
    # centred near (-27, 18), nudged 0.9 m along the row so its front-right corner stays out of the 20 deg clear zone
    c = Vector((-27.0, 18.0)) - ROW_DIR * 0.9
    B.matrix = T(c.x, c.y, GROUND_Z) @ RZ(FACING_DEG)
    B.name = "corral"
    b = B.b
    L, Wd = 16.0, 11.0
    rng = b.rng
    pts = []
    nl, nw = 7, 5
    for i in range(nl):
        pts.append((-L / 2 + L * i / nl, -Wd / 2))
    for i in range(nw):
        pts.append((L / 2, -Wd / 2 + Wd * i / nw))
    for i in range(nl):
        pts.append((L / 2 - L * i / nl, Wd / 2))
    for i in range(nw):
        pts.append((-L / 2, Wd / 2 - Wd * i / nw))
    gate = (3, 4)  # front segment between posts 3 and 4 is the gate
    tops = []
    for k, (px, py) in enumerate(pts):
        lean = Vector((rng.uniform(-0.04, 0.04), rng.uniform(-0.04, 0.04), 0))
        top = Vector((px, py, rng.uniform(1.5, 1.62))) + lean
        r = 0.1 if k in gate else rng.uniform(0.075, 0.095)
        cyl(b, (px, py, -0.35), top, r, "woodRaw", n=7, caps=(False, True))
        tops.append(top)
    n = len(pts)
    for k in range(n):
        j = (k + 1) % n
        if (k, j) == gate:
            continue
        a, c = Vector(pts[k]), Vector(pts[j])
        d = (c - a).normalized()
        nrm = Vector((-d.y, d.x))
        # rails nailed on the outside face of the posts
        for h in (0.48, 0.95, 1.4):
            o = nrm * -0.12
            z0 = h + rng.uniform(-0.04, 0.04)
            z1 = h + rng.uniform(-0.04, 0.04)
            sag = rng.uniform(0.01, 0.04)
            m = (a + c) / 2
            p0 = Vector((a.x + o.x - d.x * 0.05, a.y + o.y - d.y * 0.05, z0))
            pm = Vector((m.x + o.x, m.y + o.y, (z0 + z1) / 2 - sag))
            p1 = Vector((c.x + o.x + d.x * 0.05, c.y + o.y + d.y * 0.05, z1))
            rr = rng.uniform(0.05, 0.065)
            cyl(b, p0, pm, rr, "woodRaw", n=6, caps=(True, False), r1=rr * 0.97)
            cyl(b, pm, p1, rr * 0.97, "woodRaw", n=6, caps=(False, True), r1=rr * 0.94)
    # gate: framed, braced, hung on the left gate post, closed
    a, c = Vector(pts[gate[0]]), Vector(pts[gate[1]])
    with b.at(T(a.x + 0.13, a.y - 0.13, 0)):
        gl = (c - a).length - 0.26
        for z in (0.35, 0.72, 1.09, 1.42):
            box(b, 0.0, -0.025, z, gl, 0.025, z + 0.13, "woodRaw", grain="x", jitter=0.3)
        for x in (0.0, gl - 0.12):
            box(b, x, -0.035, 0.3, x + 0.12, 0.035, 1.58, "woodRaw", grain="z")
        beam(b, (0.1, -0.045, 0.4), (gl - 0.1, -0.045, 1.5), 0.12, 0.03, "woodRaw", up=(0, 1, 0))
        for z in (0.5, 1.35):
            box(b, -0.06, -0.03, z, 0.25, 0.03, z + 0.05, "ironBlack")
        box(b, gl - 0.05, -0.05, 1.0, gl + 0.15, 0.05, 1.04, "ironBlack")
    trough(b, -L / 2 + 1.4, -1.0, 0.0, length=2.6, rot=90)
    hay_feeder(b, 2.5, Wd / 2 - 1.6, rot=0, length=2.6)
    return B


def build_props_front():
    """Street furniture along Front Street (row A frame: x = station s, -y = toward the street)."""
    B = Building("props_front", "A", 0.0, 1616)
    B.name = "props_front"
    b = B.b
    # hitching rails and water troughs at the edge of the boardwalk
    hitching_rail(b, 1.0, 3.8, -3.75)
    hitching_rail(b, -6.4, -4.4, -3.75)
    hitching_rail(b, 11.8, 13.8, -3.75)
    trough(b, 7.4, -3.95, 0.0, length=2.3)
    trough(b, -2.9, -3.95, 0.0, length=2.0)
    # lamp posts
    for sx in (-0.6, 10.55, -9.9):
        lamp_post(b, sx, -3.35)
    # rain barrels in the alleys and at corners
    barrel(b, -0.55, 1.6, 0.0, h=0.95, r=0.33, lid=False)
    poly(b, [(-0.55 + 0.27 * math.cos(2 * math.pi * i / 14), 1.6 + 0.27 * math.sin(2 * math.pi * i / 14), 0.82) for i in range(14)], "water")
    barrel(b, 10.5, 3.2, 0.0, h=0.95, r=0.33)
    barrel(b, -9.75, 2.0, 0.0, h=0.9, r=0.3)
    # goods on the store's boardwalk
    z = 0.47
    barrel(b, -8.35, -0.55, z)
    barrel(b, -7.75, -0.5, z, h=0.8, r=0.27)
    barrel(b, -8.1, -1.15, z, h=0.86)
    crate(b, -2.1, -0.45, z, 0.62, 0.48, 0.46, rot=3)
    crate(b, -2.05, -0.47, z + 0.46, 0.55, 0.42, 0.4, rot=-5)
    crate(b, -1.45, -0.5, z, 0.6, 0.45, 0.44, rot=8)
    bench(b, -6.2, -0.45, z, length=1.6)
    # sheriff's porch: bench; saloon: a crate by the post
    bench(b, 15.0, -0.42, 0.46, length=1.7)
    crate(b, 9.6, -0.5, 0.45, 0.55, 0.45, 0.45, rot=-10)
    # freight wagon parked in the street, wheels leaning at the smithy
    freight_wagon(b, -12.6, -8.4, rot=-4)
    hay_bale(b, -21.0, -1.2, 0.0, rot=8)
    hay_bale(b, -21.0, -1.2, 0.38, rot=-4)
    hay_bale(b, -20.2, -1.0, 0.0, rot=85)
    return B


def build_props_back():
    """Odds and ends behind Front Street (row B frame)."""
    B = Building("props_back", "B", 0.0, 1717)
    B.name = "props_back"
    b = B.b
    rocking_chair(b, -9.2, -0.9, 0.5, rot=-20)
    bench(b, -2.3, -0.45, 0.5, length=1.8)
    bench(b, -17.0, -0.42, 0.46, length=1.5)
    hitching_rail(b, -10.5, -8.0, -3.95)
    trough(b, -0.3, -4.1, 0.0, length=2.0)
    lamp_post(b, 1.3, -3.6)
    barrel(b, 5.8, 1.5, 0.0, h=0.95, r=0.33)
    barrel(b, -13.6, 2.5, 0.0, h=0.95, r=0.33)
    crate(b, 14.6, 1.0, 0.0, 0.7, 0.5, 0.5, rot=12)
    crate(b, 14.5, 1.5, 0.0, 0.6, 0.45, 0.45, rot=-7)
    # wood pile and chopping block behind the hotel
    for k in range(14):
        zz = (k // 7) * 0.2
        xx = -6.0 + (k % 7) * 0.2 + (k // 7) * 0.1
        cyl(b, (xx, 16.0, zz + 0.1), (xx, 17.0, zz + 0.1), 0.09, "woodRaw", n=6)
    cyl(b, (-3.8, 16.4, 0.0), (-3.8, 16.4, 0.5), 0.25, "woodRaw", n=9)
    return B



BUILDERS = [
    ("livery", build_livery),
    ("blacksmith", build_blacksmith),
    ("store", build_store),
    ("saloon", build_saloon),
    ("sheriff", build_sheriff),
    ("church", build_church),
    ("barber", build_barber),
    ("hotel", build_hotel),
    ("assay", build_assay),
    ("bank", build_bank),
    ("watertank", build_watertank),
    ("windpump", build_windpump),
    ("trading_post", build_trading_post),
    ("boarding_house", build_boarding_house),
    ("shack_1", lambda: build_shack("shack_1", "C", -22.0, 1801, window_x=2.9)),
    ("shack_2", lambda: build_shack("shack_2", "C", 15.5, 1802, W=4.6, D=5.5, roof="woodRaw", window_x=3.3)),
    ("shed_1", lambda: build_shack("shed_1", "C", -2.0, 1803, W=5.0, D=6.0, door_x=2.5, stove=False)),
    ("outhouse", lambda: build_outhouse("outhouse", "C", 20.5, 1804, d=-2.0)),
    ("corral", build_corral),
    ("props_front", build_props_front),
    ("props_back", build_props_back),
]


# ------------------------------------------------------------------------------------------ the pipeline


def setup_gpu(scene):
    scene.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "HIP"
        prefs.refresh_devices()
        ok = False
        for d in prefs.devices:
            d.use = d.type == "HIP"
            ok = ok or d.use
        scene.cycles.device = "GPU" if ok else "CPU"
    except Exception as exc:  # no HIP: CPU
        print("GPU unavailable:", exc)
        scene.cycles.device = "CPU"
    return scene.cycles.device


def ensure_ao_attr(ob):
    m = ob.data
    attr = m.color_attributes.get("AO") or m.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
    m.color_attributes.active_color = attr
    m.color_attributes.render_color_index = list(m.color_attributes).index(attr)
    return attr


def bake_ao(objs, samples=160, distance=4.0):
    scene = bpy.context.scene
    dev = setup_gpu(scene)
    scene.cycles.samples = samples
    world = scene.world or bpy.data.worlds.new("BakeWorld")
    scene.world = world
    world.light_settings.distance = distance
    me = bpy.data.meshes.new("bake_ground")
    s = 400.0
    me.from_pydata([(-s, -s, GROUND_Z), (s, -s, GROUND_Z), (s, s, GROUND_Z), (-s, s, GROUND_Z)], [], [(0, 1, 2, 3)])
    ground = bpy.data.objects.new("bake_ground", me)
    scene.collection.objects.link(ground)
    for ob in objs:
        ensure_ao_attr(ob)
    # Cycles bakes face-corner colours exactly at the corners, so a corner tucked into a neighbouring part
    # (a post in its base block, a board end under a casing) samples black and darkens the whole face.
    # Bake instead on copies whose corners are pulled ~4 cm toward each polygon's centre (same polygon and
    # corner order), then copy the result back.
    copies = []
    for ob in objs:
        src = ob.data
        co = [0.0] * (len(src.vertices) * 3)
        src.vertices.foreach_get("co", co)
        lv = [0] * len(src.loops)
        src.loops.foreach_get("vertex_index", lv)
        new_co, polys = [], []
        for p in src.polygons:
            idx = lv[p.loop_start:p.loop_start + p.loop_total]
            pts = [Vector(co[3 * i:3 * i + 3]) for i in idx]
            c = sum(pts, Vector()) / len(pts)
            base = len(new_co)
            for q in pts:
                d = (c - q).length
                f = min(0.3, 0.04 / d) if d > 1e-6 else 0.0
                new_co.append(q + (c - q) * f)
            polys.append(range(base, base + len(pts)))
        me2 = bpy.data.meshes.new(src.name + "_aobake")
        me2.from_pydata(new_co, [], polys)
        me2.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
        me2.color_attributes.active_color = me2.color_attributes["AO"]
        ob2 = bpy.data.objects.new(ob.name + "_aobake", me2)
        scene.collection.objects.link(ob2)
        ob2.matrix_world = ob.matrix_world
        copies.append((ob, ob2))
        ob.hide_render = True
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    for _, ob2 in copies:
        ob2.select_set(True)
    bpy.context.view_layer.objects.active = copies[0][1]
    t0 = time.time()
    bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    print(f"AO bake ({dev}, {samples} spp) {time.time() - t0:.1f}s")
    for ob, ob2 in copies:
        src = ob2.data.color_attributes["AO"].data
        buf = [0.0] * (len(src) * 4)
        src.foreach_get("color", buf)
        ob.data.color_attributes["AO"].data.foreach_set("color", buf)
        ob.hide_render = False
        m2 = ob2.data
        bpy.data.objects.remove(ob2, do_unlink=True)
        bpy.data.meshes.remove(m2)
    bpy.data.objects.remove(ground, do_unlink=True)
    bpy.data.meshes.remove(me)
    # remap: keep crevices readable but never black (the game multiplies the base colour by it)
    for ob in objs:
        data = ob.data.color_attributes["AO"].data
        n = len(data)
        buf = [0.0] * (n * 4)
        data.foreach_get("color", buf)
        if "--ao-report" in ARGS:
            me = ob.data
            dark = {}
            for poly_ in me.polygons:
                if all(buf[li * 4] < 0.06 for li in poly_.loop_indices) and poly_.area > 0.02:
                    mname = me.materials[poly_.material_index].name
                    dark.setdefault(mname, []).append(ob.matrix_world.inverted() @ (ob.matrix_world @ poly_.center))
            for mname, cs in sorted(dark.items(), key=lambda kv: -len(kv[1]))[:4]:
                c = cs[0]
                print(f"  dark faces {ob.name}/{mname}: {len(cs)} (e.g. local {c.x:.2f}, {c.y:.2f}, {c.z:.2f})")
        for i in range(n):
            a = buf[i * 4]
            v = 0.16 + 0.84 * max(0.0, min(1.0, a))
            buf[i * 4] = buf[i * 4 + 1] = buf[i * 4 + 2] = v
            buf[i * 4 + 3] = 1.0
        data.foreach_set("color", buf)


def no_ao(objs):
    for ob in objs:
        attr = ensure_ao_attr(ob)
        attr.data.foreach_set("color", [1.0] * (len(attr.data) * 4))


def ao_preview_shader():
    """Previews show the baked AO by multiplying it into every material's base colour, as the game does."""
    for mat in MATS.values():
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        link = bsdf.inputs["Base Color"].links
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "AO"
        attr.name = "previewAOattr"
        mul = nt.nodes.new("ShaderNodeMix")
        mul.data_type = "RGBA"
        mul.blend_type = "MULTIPLY"
        mul.inputs["Factor"].default_value = 1.0
        mul.name = "previewAO"
        if link:
            nt.links.new(link[0].from_socket, mul.inputs["A"])
        else:
            mul.inputs["A"].default_value = bsdf.inputs["Base Color"].default_value
        nt.links.new(attr.outputs["Color"], mul.inputs["B"])
        nt.links.new(mul.outputs["Result"], bsdf.inputs["Base Color"])


def remove_ao_preview_shader():
    for mat in MATS.values():
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        mul = nt.nodes.get("previewAO")
        if mul is None:
            continue
        if mul.inputs["A"].links:
            nt.links.new(mul.inputs["A"].links[0].from_socket, bsdf.inputs["Base Color"])
        else:
            for lk in list(bsdf.inputs["Base Color"].links):
                nt.links.remove(lk)
            bsdf.inputs["Base Color"].default_value = mul.inputs["A"].default_value
        nt.nodes.remove(mul)
        nt.nodes.remove(nt.nodes["previewAOattr"])


SUN_DIR = Vector((0.946, -0.307, 0.105)).normalized()


def preview_env():
    """Temporary preview lighting: low warm sun from the game's sun direction, the Goegap Road panorama
    (its sun clamped out, rotated to match) as sky light, and a sandy ground plane."""
    scene = bpy.context.scene
    setup_gpu(scene)
    temps = []
    world = bpy.data.worlds.new("PreviewSky")
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    if os.path.exists(HDR):
        img = bpy.data.images.load(HDR, check_existing=True)
        if img.size[0] > 4096:
            img.scale(4096, 2048)
        env = nt.nodes.new("ShaderNodeTexEnvironment")
        env.image = img
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Rotation"].default_value = (0, 0, math.radians(162.0))
        nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
        clamp = nt.nodes.new("ShaderNodeVectorMath")
        clamp.operation = "MINIMUM"
        clamp.inputs[1].default_value = (12.0, 12.0, 12.0)
        nt.links.new(env.outputs["Color"], clamp.inputs[0])
        nt.links.new(clamp.outputs["Vector"], bg.inputs["Color"])
        bg.inputs["Strength"].default_value = 0.9
    else:
        bg.inputs["Color"].default_value = (0.45, 0.6, 0.85, 1)
        bg.inputs["Strength"].default_value = 0.8
    scene.world = world
    sun_data = bpy.data.lights.new("PreviewSun", "SUN")
    sun_data.energy = 4.2
    sun_data.color = (1.0, 0.80, 0.60)
    sun_data.angle = math.radians(0.6)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    sun.rotation_euler = SUN_DIR.to_track_quat("Z", "Y").to_euler()
    scene.collection.objects.link(sun)
    temps.append(sun)
    gm = bpy.data.materials.new("PreviewGround")
    gm.use_nodes = True
    gnt = gm.node_tree
    gb = gnt.nodes["Principled BSDF"]
    noise = gnt.nodes.new("ShaderNodeTexNoise")
    noise.inputs["Scale"].default_value = 0.35
    noise.inputs["Detail"].default_value = 8.0
    ramp = gnt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].color = (0.30, 0.20, 0.12, 1)
    ramp.color_ramp.elements[1].color = (0.46, 0.33, 0.21, 1)
    gnt.links.new(noise.outputs["Fac"], ramp.inputs["Fac"])
    gnt.links.new(ramp.outputs["Color"], gb.inputs["Base Color"])
    gb.inputs["Roughness"].default_value = 0.95
    bump = gnt.nodes.new("ShaderNodeBump")
    n2 = gnt.nodes.new("ShaderNodeTexNoise")
    n2.inputs["Scale"].default_value = 40.0
    gnt.links.new(n2.outputs["Fac"], bump.inputs["Height"])
    bump.inputs["Strength"].default_value = 0.25
    gnt.links.new(bump.outputs["Normal"], gb.inputs["Normal"])
    me = bpy.data.meshes.new("PreviewGround")
    s = 3000.0
    me.from_pydata([(-s, -s, GROUND_Z), (s, -s, GROUND_Z), (s, s, GROUND_Z), (-s, s, GROUND_Z)], [], [(0, 1, 2, 3)])
    me.materials.append(gm)
    g = bpy.data.objects.new("PreviewGround", me)
    scene.collection.objects.link(g)
    temps.append(g)
    scene.render.film_transparent = False
    scene.cycles.use_denoising = True
    scene.view_settings.view_transform = "AgX"
    try:
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    return temps


def render_shot(path, cam_loc, target, res=(1600, 900), fov_v=None, lens=None, samples=None):
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("ShotCam")
    if fov_v is not None:
        cam_data.sensor_fit = "VERTICAL"
        cam_data.angle_y = math.radians(fov_v)
    else:
        cam_data.lens = lens or 35.0
    cam_data.clip_start = 0.1
    cam_data.clip_end = 5000.0
    cam = bpy.data.objects.new("ShotCam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = Vector(cam_loc)
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.cycles.samples = samples or SAMPLES
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    t0 = time.time()
    bpy.ops.render.render(write_still=True)
    print(f"preview {os.path.relpath(path, ROOT)} {time.time() - t0:.1f}s")
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data)


# close-up shots: kind -> (camera, target, lens) in building space
CLOSEUPS = {
    "saloon": ((-6.5, -17.0, 1.7), (0.3, 0.0, 4.8), 30.0),
    "store": ((-5.0, -14.0, 1.7), (0.0, 0.0, 3.4), 30.0),
    "sheriff": ((-4.0, -11.0, 1.7), (0.0, 0.0, 2.8), 30.0),
    "blacksmith": ((-5.0, -13.0, 1.7), (0.0, 1.0, 2.8), 30.0),
    "livery": ((-7.0, -21.0, 1.7), (0.0, 0.0, 4.8), 30.0),
    "hotel": ((-5.5, -10.0, 1.8), (0.6, 0.0, 6.6), 18.0),
    "bank": ((-3.2, -8.6, 1.7), (0.2, 0.0, 4.6), 18.0),
    "church": ((-5.5, -10.5, 1.7), (0.0, 0.0, 7.5), 18.0),
    "windpump": ((-7.0, -10.5, 2.0), (-2.0, 0.0, 7.5), 20.0),
    "corral": ((-7.0, -15.0, 2.6), (0.0, 0.0, 0.7), 26.0),
    "trading_post": ((-5.0, -13.0, 1.7), (0.0, 0.0, 3.4), 26.0),
    "boarding_house": ((-6.0, -14.0, 1.7), (0.0, 0.0, 3.5), 26.0),
}


def cleanup_preview():
    """Drop the preview world, ground and HDR so the saved .blend only holds the town."""
    scene = bpy.context.scene
    bake_world = bpy.data.worlds.get("BakeWorld")
    for w in list(bpy.data.worlds):
        if w.name.startswith("PreviewSky"):
            if scene.world == w:
                scene.world = bake_world
            bpy.data.worlds.remove(w)
    for m in list(bpy.data.materials):
        if m.name.startswith("PreviewGround"):
            bpy.data.materials.remove(m)
    for me in list(bpy.data.meshes):
        if me.name.startswith("PreviewGround") and me.users == 0:
            bpy.data.meshes.remove(me)
    for img in list(bpy.data.images):
        if img.filepath and img.filepath.lower().endswith(".hdr"):
            bpy.data.images.remove(img)
    for lt in list(bpy.data.lights):
        if lt.users == 0:
            bpy.data.lights.remove(lt)


def export_town(objs, pivots=()):
    """GLB with Y-up, UVs, normals, materials (Poly Haven maps shrunk to 1024 px) and the AO colour
    attribute as COLOR_0."""
    common.ensure_dir(os.path.dirname(EXPORT))
    for img in bpy.data.images:
        if img.source == "FILE" and max(img.size[0], img.size[1]) > 1024:
            img.scale(1024, 1024)
    for ob in objs:
        ensure_ao_attr(ob)
    bpy.ops.object.select_all(action="DESELECT")
    for ob in list(objs) + list(pivots):
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.export_scene.gltf(
        filepath=EXPORT, export_format="GLB", use_selection=True, export_apply=True, export_texcoords=True,
        export_normals=True, export_tangents=False, export_materials="EXPORT", export_yup=True,
        export_vertex_color="ACTIVE", export_all_vertex_colors=False, export_active_vertex_color_when_no_material=True,
        export_image_format="JPEG", export_image_quality=88, export_cameras=False, export_lights=False, export_extras=False)
    print(f"exported {os.path.relpath(EXPORT, ROOT)} ({os.path.getsize(EXPORT) / 1e6:.1f} MB)")


def write_meta(objs, stats, total):
    tex = {}
    for name, (tid, factor) in MATDEF.items():
        if tid:
            t = TEXOF[name]
            tex.setdefault(tid, {"polyhaven": tid, "page": f"https://polyhaven.com/a/{tid}", "authors": t.authors,
                                 "license": "CC0 1.0", "realSizeMetres": round(t.size, 3), "maps": ["diffuse", "nor_gl", "arm"],
                                 "materials": []})["materials"].append(name)
    parents = {ob.name: (ob.parent.name if ob.parent else None) for ob in objs}
    data = {
        "generator": "assets/blender/scripts/frontier_town.py",
        "stage": "last-frontier",
        "town": "Copper Wells",
        "units": "metres; authored Z-up in Blender, exported Y-up; every node at its final world position",
        "groundZ": GROUND_Z,
        "triangles": total,
        "objects": [{"name": n, "triangles": t, "parent": parents.get(n)} for n, t in stats],
        "pivots": [{"name": ob.name, "parent": ob.parent.name, "location": [round(v, 4) for v in ob.matrix_basis.translation]} for ob in objs if ob.type == "EMPTY"],
        "materials": [{"name": n, "texture": tid, "baseColorFactor": list(f) if f else None} for n, (tid, f) in MATDEF.items()],
        "api": {
            "glass": "every window pane; one quad per sash opening, UV 0..1 (u left to right, v bottom to top)",
            "lampGlow": "lantern glass and lamp chimneys (hanging lanterns and street lamps)",
            "animatedParts": "each animated part is a node (empty) named below, child of its bld_<kind>, placed on its pivot with identity rotation and scale; its geometry is the child <name>_mesh. Animate the named node, not the _mesh child (glTF-Transform folds the quantisation offset and scale into the _mesh node).",
            "saloon_door_L/R": "batwing leaves, hinge axis = local Z (Blender; three.js local Y), origin on the hinge",
            "windmill_rotor": "sail wheel, axle = local Y (Blender; three.js local -Z), origin on the hub",
            "windmill_vane": "tail vane, pivot = local Z (Blender; three.js local Y) on the tower axis",
            "sign_swing_<n>": "hanging signs (1-4), pivot = local X at the top hinge",
            "lantern_<n>": "hanging lanterns (1-6), origin at the hook",
            "bld_<kind>": "one multi-material mesh per building, origin on the facade line at ground level, rotated +35 deg about Z (Blender)",
            "COLOR_0": "baked Cycles ambient occlusion (corner domain, ground plane at z = -7 present during the bake)",
        },
        "textures": sorted(tex.values(), key=lambda d: d["polyhaven"]),
        "fonts": [{"name": FONTFILES[k][1], "file": "assets/external/fonts/" + FONTFILES[k][0], "licence": FONTFILES[k][2]} for k in sorted(FONTS_USED)],
        "license": "Original work for Prismfall; textures and scans CC0 Poly Haven",
    }
    common.write_metadata(CONTENT_META, data)


def main():
    t_start = time.time()
    common.reset_scene()
    build_materials()
    scene = bpy.context.scene
    coll = scene.collection
    built = []
    for kind, fn in BUILDERS:
        if ONLY and kind not in ONLY:
            continue
        t0 = time.time()
        B = fn()
        built.append(B)
        print(f"built {kind}: {B.b.tris()} tris (+{sum(mb.tris() for _, mb, _ in B.children)} in parts) {time.time() - t0:.1f}s")
    objs = []
    pivots = []
    stats = []
    for B in built:
        ob = B.b.to_object(coll, B.name)
        ob.matrix_world = B.matrix
        objs.append(ob)
        stats.append((ob.name, B.b.tris()))
        for name, mb, pivot in B.children:
            # The named part is an empty on the pivot (identity rotation and scale relative to the building);
            # its geometry is the child <name>_mesh at identity. glTF-Transform's quantisation folds a
            # dequantising offset and scale into leaf mesh nodes, which would move a mesh node's origin off
            # its hinge; the empty keeps the exact pivot transform in the optimised file.
            piv = bpy.data.objects.new(name, None)
            piv.empty_display_type = "PLAIN_AXES"
            piv.empty_display_size = 0.15
            coll.objects.link(piv)
            piv.parent = ob
            piv.matrix_parent_inverse = Matrix.Identity(4)
            piv.matrix_basis = Matrix.Translation(pivot)
            pivots.append(piv)
            co = mb.to_object(coll, name + "_mesh")
            co.parent = piv
            co.matrix_parent_inverse = Matrix.Identity(4)
            co.matrix_basis = Matrix.Identity(4)
            objs.append(co)
            stats.append((name + "_mesh", mb.tris()))
    bpy.context.view_layer.update()
    total = sum(t for _, t in stats)
    print(f"total {len(objs)} objects {total} triangles")
    worst = -90.0
    for ob in objs:
        mw = ob.matrix_world
        ow = max(math.degrees(math.atan2(w.x, w.y + 30.0)) for w in (mw @ v.co for v in ob.data.vertices))
        if ow > -20.5:
            print(f"  {ob.name}: azimuth reaches {ow:.2f} deg")
        worst = max(worst, ow)
    print(f"max azimuth {worst:.2f} deg (must stay below -20)")
    if NO_BAKE:
        no_ao(objs)
    else:
        bake_ao(objs)
    if not NO_PREVIEW:
        ao_preview_shader()
        temps = preview_env()
        if "--ao-view" in ARGS:
            # diagnostic: show only the baked AO attribute
            ov = bpy.data.materials.new("AOView")
            ov.use_nodes = True
            nt = ov.node_tree
            for nd in list(nt.nodes):
                if nd.type != "OUTPUT_MATERIAL":
                    nt.nodes.remove(nd)
            at = nt.nodes.new("ShaderNodeVertexColor")
            at.layer_name = "AO"
            em = nt.nodes.new("ShaderNodeEmission")
            nt.links.new(at.outputs["Color"], em.inputs["Color"])
            nt.links.new(em.outputs["Emission"], nt.nodes["Material Output"].inputs["Surface"])
            bpy.context.view_layer.material_override = ov
            bpy.context.scene.view_settings.view_transform = "Standard"
            bpy.context.scene.view_settings.look = "None"
        shots = SHOTS or ({"game", "game1920", "overview"} | set(CLOSEUPS))
        if "game" in shots:
            render_shot(os.path.join(PREVIEWS, "last_frontier_town_game.png"), (0, -30, 1), (0, 0, 0), res=(2560, 1080), fov_v=42.0)
        if "game1920" in shots:
            render_shot(os.path.join(PREVIEWS, "last_frontier_town_game_1920.png"), (0, -30, 1), (0, 0, 0), res=(1920, 1080), fov_v=42.0)
        by_name = {ob.name: ob for ob in objs}
        for B in built:
            if B.kind in shots and B.kind in CLOSEUPS:
                cam, tgt, lens = CLOSEUPS[B.kind]
                hidden = []
                if B.row != "A":
                    # isolate: row A (and row B for row C) would shade it completely at this sun height
                    for other in built:
                        if other.row < B.row:
                            for name in [other.name] + [c[0] + "_mesh" for c in other.children]:
                                ob = by_name.get(name)
                                if ob is not None and not ob.hide_render:
                                    ob.hide_render = True
                                    hidden.append(ob)
                render_shot(os.path.join(PREVIEWS, f"last_frontier_town_{B.kind}.png"), B.matrix @ Vector(cam), B.matrix @ Vector(tgt), res=(1600, 900), lens=lens)
                for ob in hidden:
                    ob.hide_render = False
        if "overview" in shots:
            render_shot(os.path.join(PREVIEWS, "last_frontier_town_overview.png"), (-8.0, -2.0, 26.0), (-46.0, 58.0, -4.0), res=(1920, 1080), lens=24.0)
        for extra in sorted(shots):
            if extra.startswith("loc:"):
                # loc:<kind>/cx/cy/cz/tx/ty/tz[/lens] in that building's space
                parts = extra[4:].split("/")
                B = next((x for x in built if x.kind == parts[0]), None)
                if B is not None:
                    v = [float(t) for t in parts[1:]]
                    render_shot(os.path.join(PREVIEWS, f"last_frontier_town_detail_{parts[0]}.png"), B.matrix @ Vector(v[0:3]), B.matrix @ Vector(v[3:6]), res=(1600, 900), lens=v[6] if len(v) > 6 else 50.0)
            if extra.startswith("cam:"):
                vals = [float(v) for v in extra[4:].split("/")]
                render_shot(os.path.join(PREVIEWS, "last_frontier_town_cam.png"), vals[0:3], vals[3:6], res=(1600, 900), lens=vals[6] if len(vals) > 6 else 35.0)
        for ob in temps:
            bpy.data.objects.remove(ob, do_unlink=True)
        remove_ao_preview_shader()
        cleanup_preview()
    if not NO_EXPORT and not ONLY:
        export_town(objs, pivots)
        common.save_blend(BLEND)
        write_meta(objs + pivots, stats, total)
    print(f"FRONTIER_TOWN_OK {len(objs)} objects {total} triangles ({time.time() - t_start:.0f}s)")


if __name__ == "__main__":
    main()
