"""Prismfall, The Last Frontier: an original 1870s American-type (4-4-0) wood-burning steam train.

Builds, in Blender 5.x headless:
  loco         the locomotive (boiler, wagon-top firebox, balloon stack, box headlight, brass domes and bell,
               wooden cab, bar frames, 16-spoke 1.60 m drivers, two-axle leading truck, slatted pilot)
  tender       horseshoe-tank tender with a cordwood load on two arch-bar trucks
  car_box      outside-braced boxcar        car_stock    slatted stock car
  car_coach    clerestory passenger coach   car_caboose  cupola caboose
  water_tower  stave tank with iron hoops on a timber trestle, conical roof, spout
  telegraph_pole  weathered pole, crossarm, four glass insulators

None of it copies a preserved locomotive or a film prop; proportions follow general 1870s American practice.

Usage (from the repo root):
  blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/frontier_train.py -- \
      [--no-preview] [--quick] [--no-export] [--views loco34,side,gear,headlight,train,tower] \
      [--samples 128] [--scale 1.0]
  --quick      skip the Cycles AO bake (COLOR_0 = grime only; for fast look-development renders)
  --no-export  skip the GLB, metadata and .blend (look-development only)

Frames. Every vehicle is a top-level empty at the world origin. Its local frame has the origin on the track centre
line at rail-top height, midway between the vehicle's coupler faces; +Y is forward (the locomotive's smokebox end),
+Z is up and +X is the right-hand side when facing forward. Side "R" is +X, side "L" is -X (the fireman's side).
The glTF export is Y-up: Blender (x, y, z) becomes glTF (x, z, -y).

Animated parts are empties with the mesh as a child named <name>_mesh, so that glTF-Transform's quantisation
(which folds a scale/offset into each mesh node) never moves an animated pivot:
  <vehicle>_wheel_N / loco_drive_N / loco_truck_N   origin on the axle centre, axle along local X
  loco_siderod_L/R    origin at the front driver's crank pin; translates only
  loco_mainrod_L/R    origin at the big end on the rear (driven) crank pin; lies along the cylinder axis at rest
  loco_crosshead_L/R  origin at the wrist pin; slides along Y
At rest every crank pin is at front dead centre (directly ahead of its axle, at axle height) on both sides; the game
applies the 90 degree quartering. No triangle of a wheel set crosses x = 0, so a wheel set can be split by side.

Materials (16) are Poly Haven CC0 photo textures scaled to their real-world size (source.json dimensionsMm), wired
as glTF-standard Principled BSDF: Base Color = texture x factor x COLOR_0, ARM green -> Roughness (x factor),
ARM blue -> Metallic, OpenGL normal map. COLOR_0 is a Cycles ambient-occlusion bake (face corners, byte colour
attribute "AO") multiplied by grime low down and soot around the stack; no lighting is baked.
"""
import json
import math
import os
import random
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bmesh  # noqa: E402
import bpy  # noqa: E402
from mathutils import Matrix, Vector  # noqa: E402

import common  # noqa: E402

ROOT = common.ROOT
PH = os.path.join(ROOT, "assets", "external", "polyhaven")
FONT_DIR = os.path.join(ROOT, "assets", "external", "fonts")
EXPORT = os.path.join(ROOT, "assets", "blender", "exports", "frontier_train", "train.glb")
BLEND = os.path.join(ROOT, "assets", "blender", "source", "environments", "last_frontier_train.blend")
META = os.path.join(ROOT, "content", "stages", "last-frontier", "models", "train.meta.json")
PREVIEW_DIR = os.path.join(ROOT, "assets", "blender", "previews")
TAU = math.tau
ARGV = common.args()


def opt(name, default=None):
    if name not in ARGV:
        return default
    i = ARGV.index(name)
    if i + 1 < len(ARGV) and not ARGV[i + 1].startswith("--"):
        return ARGV[i + 1]
    return True


RNG_UV = random.Random(1871)

# ---------------------------------------------------------------------------------------------- materials
# tex: Poly Haven id; color: base colour factor (linear); rough: roughness factor on ARM green; normal: map strength.
# Untextured: color, metal, roughc (constant roughness). raw_uv: UVs are 0..1 per pane / lens instead of metres.
MAT_DEFS = {
    "boilerGreen": dict(tex="green_metal_rust", color=(0.56, 0.72, 0.60), rough=0.85, normal=0.7),
    "blackIron": dict(tex="rust_coarse_01", color=(0.15, 0.19, 0.25), rough=1.0, normal=0.8),
    "brass": dict(color=(0.78, 0.55, 0.22), metal=1.0, roughc=0.26),
    "steel": dict(color=(0.56, 0.56, 0.58), metal=1.0, roughc=0.32),
    "redPaint": dict(tex="rusty_painted_metal", color=(0.92, 0.70, 0.66), rough=0.9, normal=0.6),
    "woodVarnish": dict(tex="wood_shutter", color=(0.70, 0.55, 0.46), rough=0.62, normal=0.7),
    "roofCanvas": dict(tex="brown_leather", color=(0.22, 0.30, 0.52), rough=1.0, normal=0.6),
    "glass": dict(color=(0.030, 0.036, 0.042), metal=0.0, roughc=0.05, raw_uv=True),
    "lampGlow": dict(color=(0.80, 0.78, 0.72), metal=1.0, roughc=0.14, raw_uv=True),
    "boxcarRed": dict(tex="weathered_brown_planks", color=(1.0, 0.50, 0.40), rough=1.0, normal=0.8),
    "coachPaint": dict(tex="distressed_painted_planks", color=(0.94, 0.68, 0.30), rough=0.9, normal=0.6),
    "weatheredWood": dict(tex="weathered_planks", color=(1.0, 0.97, 0.94), rough=1.0, normal=0.9),
    "greyWood": dict(tex="brown_planks_09", color=(0.86, 0.83, 0.79), rough=1.0, normal=0.9),
    "bark": dict(tex="bark_brown_02", color=(0.80, 0.74, 0.66), rough=1.0, normal=1.0),
    "whitePaint": dict(color=(0.74, 0.72, 0.66), metal=0.0, roughc=0.75),
    "insulator": dict(color=(0.28, 0.56, 0.52), metal=0.0, roughc=0.08),
}
MAT_ORDER = list(MAT_DEFS)
MATS = {}
MAT_SIZE = {}


def tex_path(tid, kind):
    return os.path.join(PH, tid, f"{tid}_{kind}_1k.jpg")


def tex_size(tid):
    with open(os.path.join(PH, tid, "source.json"), encoding="utf-8") as fh:
        return json.load(fh)["dimensionsMm"][0] / 1000.0


def load_image(path, colour):
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return img


def mix_multiply(nt, a, b=None, const=None):
    node = nt.nodes.new("ShaderNodeMix")
    node.data_type = "RGBA"
    node.blend_type = "MULTIPLY"
    node.inputs["Factor"].default_value = 1.0
    sa = next(s for s in node.inputs if s.identifier == "A_Color")
    sb = next(s for s in node.inputs if s.identifier == "B_Color")
    nt.links.new(a, sa)
    if b is not None:
        nt.links.new(b, sb)
    else:
        sb.default_value = (*const, 1.0)
    return next(s for s in node.outputs if s.identifier == "Result_Color")


def build_materials():
    for name, d in MAT_DEFS.items():
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        nt = mat.node_tree
        bsdf = nt.nodes["Principled BSDF"]
        attr = nt.nodes.new("ShaderNodeVertexColor")
        attr.layer_name = "AO"
        if d.get("tex"):
            tid = d["tex"]
            MAT_SIZE[name] = tex_size(tid)
            img = nt.nodes.new("ShaderNodeTexImage")
            img.image = load_image(tex_path(tid, "diffuse"), True)
            arm = nt.nodes.new("ShaderNodeTexImage")
            arm.image = load_image(tex_path(tid, "arm"), False)
            nor = nt.nodes.new("ShaderNodeTexImage")
            nor.image = load_image(tex_path(tid, "nor_gl"), False)
            shaded = mix_multiply(nt, img.outputs["Color"], attr.outputs["Color"])
            nt.links.new(mix_multiply(nt, shaded, const=d["color"]), bsdf.inputs["Base Color"])
            sep = nt.nodes.new("ShaderNodeSeparateColor")
            nt.links.new(arm.outputs["Color"], sep.inputs["Color"])
            mul = nt.nodes.new("ShaderNodeMath")
            mul.operation = "MULTIPLY"
            nt.links.new(sep.outputs["Green"], mul.inputs[0])
            mul.inputs[1].default_value = d["rough"]
            nt.links.new(mul.outputs[0], bsdf.inputs["Roughness"])
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
            nm = nt.nodes.new("ShaderNodeNormalMap")
            nm.inputs["Strength"].default_value = d["normal"]
            nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
            nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        elif d.get("raw_uv"):
            # A 4x4 white base-colour texture keeps the per-pane / per-lens 0..1 UVs through glTF-Transform's prune.
            MAT_SIZE[name] = 1.0
            img = nt.nodes.new("ShaderNodeTexImage")
            img.image = white_image()
            shaded = mix_multiply(nt, img.outputs["Color"], attr.outputs["Color"])
            nt.links.new(mix_multiply(nt, shaded, const=d["color"]), bsdf.inputs["Base Color"])
            bsdf.inputs["Metallic"].default_value = d["metal"]
            bsdf.inputs["Roughness"].default_value = d["roughc"]
        else:
            MAT_SIZE[name] = 1.0
            nt.links.new(mix_multiply(nt, attr.outputs["Color"], const=d["color"]), bsdf.inputs["Base Color"])
            bsdf.inputs["Metallic"].default_value = d["metal"]
            bsdf.inputs["Roughness"].default_value = d["roughc"]
        MATS[name] = mat


def white_image():
    img = bpy.data.images.get("uvWhite")
    if img is None:
        img = bpy.data.images.new("uvWhite", 4, 4, alpha=False)
        # Not quite uniform: glTF-Transform's prune folds single-colour textures into the factor and drops the UVs.
        px = []
        for k in range(16):
            v = 1.0 if (k + k // 4) % 2 == 0 else 0.98
            px += [v, v, v, 1.0]
        img.pixels.foreach_set(px)
        img.pack()
    return img


# ---------------------------------------------------------------------------------------------- geometry
def frame(origin, z_axis, x_hint):
    """Matrix whose local axes are x_hint (orthogonalised), z_axis and their cross product, at origin."""
    z = Vector(z_axis).normalized()
    x = Vector(x_hint)
    x = (x - z * x.dot(z)).normalized()
    y = z.cross(x)
    o = origin
    return Matrix(((x.x, y.x, z.x, o[0]), (x.y, y.y, z.y, o[1]), (x.z, y.z, z.z, o[2]), (0.0, 0.0, 0.0, 1.0)))


IDENT = Matrix.Identity(4)
MIRROR_X = Matrix.Scale(-1.0, 4, (1.0, 0.0, 0.0))


def T(x, y, z):
    return Matrix.Translation((x, y, z))


def side(s):
    return MIRROR_X if s < 0 else IDENT


def AXY(x, y, z):
    """Lathe frame: axis +Y at (x, y, z) with the profile height measured from that point; seam underneath."""
    return frame((x, y, z), (0, 1, 0), (0, 0, -1))


def AXX(x, y, z):
    return frame((x, y, z), (1, 0, 0), (0, 0, -1))


def AXZ(x, y, z):
    return frame((x, y, z), (0, 0, 1), (1, 0, 0))


def PXZ(y_front):
    """Prism frame: outline in (x, z), extruded from y_front towards -Y by the prism's z range."""
    return frame((0, y_front, 0), (0, -1, 0), (1, 0, 0))


def PYZ(x0=0.0):
    """Prism frame: outline in (y, z), extruded along +X from x0."""
    return frame((x0, 0, 0), (1, 0, 0), (0, 1, 0))


class Geo:
    """Face soup in metres; UVs are metres too and are divided by each material's texture size on build."""

    def __init__(self):
        self.v = []
        self.f = []
        self.uv = []
        self.m = []

    def add(self, verts, faces, uvs, mat, M=None, uvoff=True):
        base = len(self.v)
        M = IDENT if M is None else M
        flip = M.to_3x3().determinant() < 0
        for p in verts:
            self.v.append(M @ Vector(p))
        mats = mat if isinstance(mat, (list, tuple)) else None
        if uvoff is True:
            ou, ov = RNG_UV.random() * 6.0, RNG_UV.random() * 6.0
        elif uvoff:
            ou, ov = uvoff
        else:
            ou = ov = 0.0
        for i, f in enumerate(faces):
            m = mats[i] if mats else mat
            if m is None:
                continue
            fu = uvs[i]
            if flip:
                f = tuple(reversed(f))
                fu = list(reversed(fu))
            self.f.append(tuple(base + k for k in f))
            raw = MAT_DEFS[m].get("raw_uv")
            self.uv.append([(u, v) if raw else (u + ou, v + ov) for (u, v) in fu])
            self.m.append(m)
        return base

    def tris(self):
        return sum(len(f) - 2 for f in self.f)


def ccw(poly):
    area = sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))
    return list(poly) if area > 0 else list(reversed(poly))


def box(g, mat, size, M=None, center=(0.0, 0.0, 0.0), div=None, uvrot=False, uvoff=True, skip=()):
    """Box of size (sx, sy, sz) centred at `center` (local); each face is a grid with cells no longer than div."""
    sx, sy, sz = size
    cx, cy, cz = center
    x0, x1, y0, y1, z0, z1 = cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2, cz - sz / 2, cz + sz / 2
    spec = (
        ("+x", (x1, y0, z0), (0, sy, 0), (0, 0, sz), (1, 2)),
        ("-x", (x0, y1, z0), (0, -sy, 0), (0, 0, sz), (1, 2)),
        ("+y", (x1, y1, z0), (-sx, 0, 0), (0, 0, sz), (0, 2)),
        ("-y", (x0, y0, z0), (sx, 0, 0), (0, 0, sz), (0, 2)),
        ("+z", (x0, y0, z1), (sx, 0, 0), (0, sy, 0), (0, 1)),
        ("-z", (x0, y1, z0), (sx, 0, 0), (0, -sy, 0), (0, 1)),
    )
    verts, faces, uvs = [], [], []
    for key, o, eu, ev, ax in spec:
        if key in skip:
            continue
        o, eu, ev = Vector(o), Vector(eu), Vector(ev)
        nu = max(1, math.ceil(eu.length / div - 1e-6)) if div else 1
        nv = max(1, math.ceil(ev.length / div - 1e-6)) if div else 1
        base = len(verts)
        for a in range(nv + 1):
            for b in range(nu + 1):
                verts.append(o + eu * (b / nu) + ev * (a / nv))
        for a in range(nv):
            for b in range(nu):
                i0 = base + a * (nu + 1) + b
                q = (i0, i0 + 1, i0 + nu + 2, i0 + nu + 1)
                uv = [(verts[k][ax[0]], verts[k][ax[1]]) for k in q]
                if uvrot:
                    uv = [(v, u) for u, v in uv]
                faces.append(q)
                uvs.append(uv)
    g.add(verts, faces, uvs, mat, M, uvoff)


def bm_collect(bm, uvrot=False):
    bm.normal_update()
    bm.verts.index_update()
    verts = [v.co.copy() for v in bm.verts]
    faces, uvs = [], []
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        pa = (1, 2) if ax == 0 else ((0, 2) if ax == 1 else (0, 1))
        idx = [v.index for v in f.verts]
        uv = [(verts[i][pa[0]], verts[i][pa[1]]) for i in idx]
        if uvrot:
            uv = [(v, u) for u, v in uv]
        faces.append(idx)
        uvs.append(uv)
    return verts, faces, uvs


def bbox(g, mat, size, M=None, center=(0.0, 0.0, 0.0), r=0.01, segs=1, uvrot=False, uvoff=True):
    """Box with bevelled edges (chamfered with segs=1, rounded with 2+)."""
    r = min(r, min(size) * 0.45)
    if r <= 1e-5:
        return box(g, mat, size, M, center, uvrot=uvrot, uvoff=uvoff)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * size[0] + center[0], v.co.y * size[1] + center[1], v.co.z * size[2] + center[2]))
    bmesh.ops.bevel(bm, geom=list(bm.edges), offset=r, segments=segs, profile=0.5, affect="EDGES", clamp_overlap=True)
    verts, faces, uvs = bm_collect(bm, uvrot)
    bm.free()
    g.add(verts, faces, uvs, mat, M, uvoff)


def bar(g, mat, a, b, w, h, up=(0, 0, 1), r=0.0, extend=0.0):
    """Rectangular bar from a to b: width w across (perpendicular to `up`), height h along `up`."""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    if L < 1e-6:
        return
    upv = Vector(up)
    if abs(d.normalized().dot(upv.normalized())) > 0.98:
        upv = Vector((0, 1, 0)) if abs(d.normalized().y) < 0.9 else Vector((1, 0, 0))
    M = frame((a + b) / 2, d, upv)  # local x = up (orthogonalised), local z = along the bar
    size = (h, w, L + extend)
    if r > 0:
        bbox(g, mat, size, M, r=r)
    else:
        box(g, mat, size, M)


def bar_path(g, mat, pts, w, h, up=(0, 0, 1), r=0.0):
    for i in range(len(pts) - 1):
        bar(g, mat, pts[i], pts[i + 1], w, h, up, r, extend=min(w, h) * 0.6)


def lathe(g, mat, prof, M=None, segs=24, a0=0.0, a1=TAU, mats=None, uvrot=False, uvoff=True):
    """Surface of revolution about local +Z; prof = [(r, z)] counter-clockwise in the (r, z) plane
    (the outside lies to the right of the direction of travel). r = 0 makes a pole."""
    closed = abs(a1 - a0 - TAU) < 1e-9
    ncol = segs if closed else segs + 1
    rref = max(p[0] for p in prof)
    verts, starts = [], []
    for r, z in prof:
        if r <= 1e-7:
            starts.append((len(verts), True))
            verts.append((0.0, 0.0, z))
        else:
            starts.append((len(verts), False))
            for j in range(ncol):
                a = a0 + (a1 - a0) * j / segs
                verts.append((r * math.cos(a), r * math.sin(a), z))
    vacc = [0.0]
    for i in range(1, len(prof)):
        vacc.append(vacc[-1] + math.hypot(prof[i][0] - prof[i - 1][0], prof[i][1] - prof[i - 1][1]))
    arc = rref * (a1 - a0)
    faces, uvs, fm = [], [], []
    for i in range(len(prof) - 1):
        m = mats[i] if mats else mat
        (s0, p0), (s1, p1) = starts[i], starts[i + 1]
        if (p0 and p1) or m is None:
            continue
        v0, v1 = vacc[i], vacc[i + 1]
        for j in range(segs):
            jn = (j + 1) % ncol if closed else j + 1
            u0, u1 = arc * j / segs, arc * (j + 1) / segs
            if p0:
                f, uv = (s0, s1 + jn, s1 + j), [((u0 + u1) / 2, v0), (u1, v1), (u0, v1)]
            elif p1:
                f, uv = (s0 + j, s0 + jn, s1), [(u0, v0), (u1, v0), ((u0 + u1) / 2, v1)]
            else:
                f, uv = (s0 + j, s0 + jn, s1 + jn, s1 + j), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
            if uvrot:
                uv = [(b, a) for a, b in uv]
            faces.append(f)
            uvs.append(uv)
            fm.append(m)
    return g.add(verts, faces, uvs, fm, M, uvoff)


def loft(g, mat, rings, closed=True, uvoff=True, uvrot=False):
    """Skins equal-length point rings (listed in order); faces (i,j),(i,j+1),(i+1,j+1),(i+1,j)."""
    n = len(rings[0])
    verts = [Vector(p) for ring in rings for p in ring]
    faces, uvs = [], []
    vacc = [0.0]
    for i in range(1, len(rings)):
        c0 = sum((Vector(p) for p in rings[i - 1]), Vector()) / n
        c1 = sum((Vector(p) for p in rings[i]), Vector()) / n
        vacc.append(vacc[-1] + max((c1 - c0).length, 1e-4))
    uacc = [0.0]
    for j in range(1, n + 1):
        uacc.append(uacc[-1] + (Vector(rings[0][j % n]) - Vector(rings[0][j - 1])).length)
    for i in range(len(rings) - 1):
        for j in range(n if closed else n - 1):
            jn = (j + 1) % n
            faces.append((i * n + j, i * n + jn, (i + 1) * n + jn, (i + 1) * n + j))
            uv = [(uacc[j], vacc[i]), (uacc[j + 1], vacc[i]), (uacc[j + 1], vacc[i + 1]), (uacc[j], vacc[i + 1])]
            if uvrot:
                uv = [(b, a) for a, b in uv]
            uvs.append(uv)
    g.add(verts, faces, uvs, mat, None, uvoff)


def tube(g, mat, pts, r, M=None, segs=8, cap0=False, cap1=False, radii=None, rot=0.0, uvoff=True):
    """Sweeps a circle (or an n-gon) along a polyline using parallel-transport frames."""
    P = [Vector(p) for p in pts]
    n = len(P)
    tangents = []
    for i in range(n):
        if i == 0:
            t = P[1] - P[0]
        elif i == n - 1:
            t = P[-1] - P[-2]
        else:
            t = (P[i + 1] - P[i]).normalized() + (P[i] - P[i - 1]).normalized()
        tangents.append(t.normalized())
    up = Vector((0, 0, 1)) if abs(tangents[0].z) < 0.95 else Vector((1, 0, 0))
    normals = [(up - tangents[0] * up.dot(tangents[0])).normalized()]
    for i in range(1, n):
        q = tangents[i - 1].rotation_difference(tangents[i])
        v = q @ normals[-1]
        normals.append((v - tangents[i] * v.dot(tangents[i])).normalized())
    verts = []
    for i in range(n):
        B = tangents[i].cross(normals[i])
        rr = radii[i] if radii else r
        for j in range(segs):
            a = rot + TAU * j / segs
            verts.append(P[i] + rr * (math.cos(a) * normals[i] + math.sin(a) * B))
    L = [0.0]
    for i in range(1, n):
        L.append(L[-1] + (P[i] - P[i - 1]).length)
    circ = TAU * r
    faces, uvs = [], []
    for i in range(n - 1):
        for j in range(segs):
            jn = (j + 1) % segs
            faces.append((i * segs + j, i * segs + jn, (i + 1) * segs + jn, (i + 1) * segs + j))
            u0, u1 = circ * j / segs, circ * (j + 1) / segs
            uvs.append([(u0, L[i]), (u1, L[i]), (u1, L[i + 1]), (u0, L[i + 1])])
    for cap, i, rev in ((cap0, 0, True), (cap1, n - 1, False)):
        if not cap:
            continue
        c = len(verts)
        verts.append(P[i].copy())
        for j in range(segs):
            jn = (j + 1) % segs
            a, b = i * segs + j, i * segs + jn
            faces.append((c, b, a) if rev else (c, a, b))
            uvs.append([(0.0, 0.0), (r * math.cos(TAU * j / segs), r * math.sin(TAU * j / segs)), (r * math.cos(TAU * jn / segs), r * math.sin(TAU * jn / segs))])
    g.add(verts, faces, uvs, mat, M, uvoff)


def fillet(pts, rad, steps=4):
    """Rounds the interior corners of a polyline (quadratic Bezier corners)."""
    P = [Vector(p) for p in pts]
    out = [P[0]]
    for i in range(1, len(P) - 1):
        a, b, c = P[i - 1], P[i], P[i + 1]
        d1, d2 = a - b, c - b
        l1, l2 = d1.length, d2.length
        d1.normalize()
        d2.normalize()
        ang = d1.angle(d2)
        if ang > math.pi - 1e-3:
            out.append(b)
            continue
        t = min(rad / max(math.tan(ang / 2), 1e-3), l1 * 0.45, l2 * 0.45)
        p1, p2 = b + d1 * t, b + d2 * t
        for k in range(steps + 1):
            s = k / steps
            out.append((1 - s) ** 2 * p1 + 2 * (1 - s) * s * b + s * s * p2)
    out.append(P[-1])
    return out


def prism(g, mat, poly, z0, z1, M=None, uvrot=False, side_mat=None, caps=(True, True), div=None, rows=1, uvoff=True, cap_mat=None):
    """Extrudes a simple polygon (local XY, made counter-clockwise) from z0 to z1 along local Z."""
    poly = ccw(poly)
    pts = []
    for i in range(len(poly)):
        a, b = Vector(poly[i]), Vector(poly[(i + 1) % len(poly)])
        k = max(1, math.ceil((b - a).length / div - 1e-6)) if div else 1
        for s in range(k):
            pts.append(a.lerp(b, s / k))
    n = len(pts)
    cm = cap_mat or mat
    sm = side_mat or mat
    verts, faces, uvs, fm = [], [], [], []

    def uvp(u, v):
        return (v, u) if uvrot else (u, v)

    if caps[1]:
        base = len(verts)
        verts += [(p.x, p.y, z1) for p in pts]
        faces.append(tuple(range(base, base + n)))
        uvs.append([uvp(p.x, p.y) for p in pts])
        fm.append(cm)
    if caps[0]:
        base = len(verts)
        verts += [(p.x, p.y, z0) for p in pts]
        faces.append(tuple(range(base + n - 1, base - 1, -1)))
        uvs.append([uvp(pts[i].x, pts[i].y) for i in range(n - 1, -1, -1)])
        fm.append(cm)
    perim = [0.0]
    for i in range(n):
        perim.append(perim[-1] + (pts[(i + 1) % n] - pts[i]).length)
    base = len(verts)
    for k in range(rows + 1):
        z = z0 + (z1 - z0) * k / rows
        verts += [(p.x, p.y, z) for p in pts]
    for k in range(rows):
        za, zb = z0 + (z1 - z0) * k / rows, z0 + (z1 - z0) * (k + 1) / rows
        for i in range(n):
            j = (i + 1) % n
            a0, a1 = base + k * n + i, base + k * n + j
            faces.append((a0, a1, a1 + n, a0 + n))
            uvs.append([uvp(perim[i], za), uvp(perim[i + 1], za), uvp(perim[i + 1], zb), uvp(perim[i], zb)])
            fm.append(sm)
    g.add(verts, faces, uvs, fm, M, uvoff)


def quad(g, mat, a, b, c, d, uv=((0, 0), (1, 0), (1, 1), (0, 1))):
    """Single quad a-b-c-d (counter-clockwise seen from the front); used for glass panes with 0..1 UVs."""
    g.add([a, b, c, d], [(0, 1, 2, 3)], [list(uv)], mat, None, uvoff=False)


def pane_x(g, x, y0, y1, z0, z1, s):
    """Glass pane in the plane x, facing +X (s=1) or -X (s=-1)."""
    if s > 0:
        quad(g, "glass", (x, y0, z0), (x, y1, z0), (x, y1, z1), (x, y0, z1))
    else:
        quad(g, "glass", (x, y1, z0), (x, y0, z0), (x, y0, z1), (x, y1, z1))


def pane_y(g, y, x0, x1, z0, z1, s):
    """Glass pane in the plane y, facing +Y (s=1) or -Y (s=-1)."""
    if s > 0:
        quad(g, "glass", (x1, y, z0), (x0, y, z0), (x0, y, z1), (x1, y, z1))
    else:
        quad(g, "glass", (x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1))


def rivet(g, mat, p, n, r=0.011):
    n = Vector(n)
    hint = Vector((0, 0, 1)) if abs(n.z) < 0.9 else Vector((1, 0, 0))
    lathe(g, mat, [(r, -0.003), (r * 0.78, r * 0.48), (0.0, r * 0.72)], frame(p, n, hint), segs=5, uvoff=False)


FONT_FILES = {
    "oldstd": "oldstandardtt/OldStandard-Bold.ttf",
    "alfa": "alfaslabone/AlfaSlabOne-Regular.ttf",
    "rye": "rye/Rye-Regular.ttf",
    "ultra": "ultra/Ultra-Regular.ttf",
}
FONTS = {}


def text(g, mat, body, fnt, height, M, width=None, depth=0.0, spacing=1.0):
    """Glyph mesh in the local XY plane facing +Z, centred on the origin. height = bounding height of the string."""
    if fnt not in FONTS:
        FONTS[fnt] = bpy.data.fonts.load(os.path.join(FONT_DIR, FONT_FILES[fnt]), check_existing=True)
    cu = bpy.data.curves.new("txt", "FONT")
    cu.body = body
    cu.font = FONTS[fnt]
    cu.size = 1.0
    cu.extrude = depth
    cu.align_x = "CENTER"
    cu.align_y = "CENTER"
    cu.resolution_u = 2
    cu.space_character = spacing
    ob = bpy.data.objects.new("txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    vs = [v.co.copy() for v in me.vertices]
    xs, ys = [v.x for v in vs], [v.y for v in vs]
    w0, h0 = max(xs) - min(xs), max(ys) - min(ys)
    s = height / h0
    if width and w0 * s > width:
        s = width / w0
    cx, cy = (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2
    verts = [((v.x - cx) * s, (v.y - cy) * s, v.z * s) for v in vs]
    faces = [tuple(p.vertices) for p in me.polygons]
    if depth == 0.0 and me.polygons and me.polygons[0].normal.z < 0:
        faces = [tuple(reversed(f)) for f in faces]
    uvs = [[(verts[i][0], verts[i][1]) for i in f] for f in faces]
    g.add(verts, faces, uvs, mat, M, uvoff=False)
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    bpy.data.meshes.remove(me)
    return w0 * s


def text_on_side(g, mat, body, fnt, height, x, y, z, s, width=None, depth=0.0):
    """Lettering on a vehicle side (plane x, facing s*X), reading left to right as seen from outside."""
    M = frame((x, y, z), (s, 0, 0), (0, s, 0))
    return text(g, mat, body, fnt, height, M, width, depth)


# ---------------------------------------------------------------------------------------------- mesh objects
def mark_sharp(me, deg):
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    thr = math.radians(deg)
    for e in bm.edges:
        lf = e.link_faces
        if len(lf) == 2:
            n0, n1 = lf[0].normal, lf[1].normal
            e.smooth = n0.length > 1e-8 and n1.length > 1e-8 and n0.angle(n1) < thr
        else:
            e.smooth = True
    bm.to_mesh(me)
    bm.free()


def mesh_object(name, g, parent=None, location=(0.0, 0.0, 0.0), sharp_deg=48.0):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in g.v], [], [list(f) for f in g.f])
    order = sorted(set(g.m), key=MAT_ORDER.index)
    for m in order:
        me.materials.append(MATS[m])
    idx = {m: i for i, m in enumerate(order)}
    me.polygons.foreach_set("material_index", [idx[m] for m in g.m])
    uv = me.uv_layers.new(name="UVMap")
    flat = []
    for fu, m in zip(g.uv, g.m):
        s = MAT_SIZE[m]
        for a, b in fu:
            flat.extend((a / s, b / s))
    uv.data.foreach_set("uv", flat)
    me.polygons.foreach_set("use_smooth", [True] * len(me.polygons))
    me.validate(clean_customdata=False)
    mark_sharp(me, sharp_deg)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = location
    mod = ob.modifiers.new("weighted", "WEIGHTED_NORMAL")
    mod.mode = "FACE_AREA"
    mod.weight = 50
    mod.keep_sharp = True
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = ob
    ob.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)
    ob.select_set(False)
    return ob


def empty(name, location=(0.0, 0.0, 0.0), parent=None, size=0.4):
    ob = bpy.data.objects.new(name, None)
    ob.empty_display_type = "PLAIN_AXES"
    ob.empty_display_size = size
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = location
    return ob


def part(name, g, pivot, parent):
    """Animated part: empty `name` at pivot (vehicle frame) with the mesh child `<name>_mesh` at identity.
    g is built in the part's local frame (pivot at the origin)."""
    e = empty(name, pivot, parent, 0.3)
    mesh_object(name + "_mesh", g, e)
    return e


# ---------------------------------------------------------------------------------------------- running gear
AX_LATHE = AXX(0, 0, 0)  # wheel lathes: local Z = axle (+X), profile height = x position


def tyre(g, R, xi, w, Ms, segs, paint="blackIron"):
    xo = xi + w
    bore = R - (0.07 if R > 0.6 else 0.05)
    prof = [(bore, xi), (R + 0.012, xi), (R + 0.027, xi + 0.006), (R + 0.030, xi + 0.016), (R + 0.024, xi + 0.026),
            (R + 0.008, xi + 0.034), (R + 0.002, xi + 0.042), (R - 0.004, xo - 0.008), (R - 0.012, xo), (bore, xo)]
    mats = [paint, paint, "steel", "steel", "steel", "steel", "steel", "steel", paint]
    lathe(g, None, prof, Ms @ AX_LATHE, segs, mats=mats)
    return bore


def spoke(g, mat, phi, r0, r1, w0, w1, d0, d1, xc, Ms, sides=8):
    e = Vector((0, math.cos(phi), math.sin(phi)))
    t = Vector((0, -math.sin(phi), math.cos(phi)))
    ax = Vector((1, 0, 0))
    rings = [(r0 - 0.03, w0 * 1.5, d0 * 1.15), (r0 + 0.035, w0, d0), (r1 - 0.035, w1, d1), (r1 + 0.03, w1 * 1.6, d1 * 1.12)]
    verts = []
    for r, w, d in rings:
        c = Vector((xc, 0, 0)) + e * r
        for j in range(sides):
            a = TAU * j / sides
            verts.append(c + t * (w / 2 * math.cos(a)) + ax * (d / 2 * math.sin(a)))
    faces, uvs = [], []
    for i in range(len(rings) - 1):
        for j in range(sides):
            jn = (j + 1) % sides
            faces.append((i * sides + j, i * sides + jn, (i + 1) * sides + jn, (i + 1) * sides + j))
            uvs.append([(j * 0.03, rings[i][0]), ((j + 1) * 0.03, rings[i][0]), ((j + 1) * 0.03, rings[i + 1][0]), (j * 0.03, rings[i + 1][0])])
    g.add(verts, faces, uvs, mat, Ms)


def spoked_wheel(g, s, R, xc, n_spokes, hub_r, axle_r, segs, tyre_w, pin_end=None, counterweight=False, paint="redPaint"):
    """A spoked wheel on side s with its tread centre plane at |x| = xc. Crank pin (if any) at +Y (front dead centre)."""
    Ms = side(s)
    xi = xc - tyre_w / 2 - 0.005
    bore = tyre(g, R, xi, tyre_w, Ms, segs)
    rim_t = 0.07 if R > 0.6 else 0.045
    rin = bore - rim_t
    hw = 0.05 if R > 0.6 else 0.04
    lathe(g, paint, [(bore + 0.002, xc + hw), (rin + 0.015, xc + hw), (rin, xc + hw - 0.012), (rin, xc - hw + 0.012),
                     (rin + 0.015, xc - hw), (bore + 0.002, xc - hw)], Ms @ AX_LATHE, segs)
    hub = [(axle_r + 0.004, xc - 0.11), (hub_r, xc - 0.105), (hub_r + 0.012, xc - 0.085), (hub_r + 0.012, xc + 0.065),
           (hub_r - 0.012, xc + 0.092), (axle_r + 0.045, xc + 0.104), (axle_r + 0.018, xc + 0.11),
           (axle_r + 0.018, xc + 0.124), (axle_r - 0.008, xc + 0.134), (0.0, xc + 0.137)]
    lathe(g, None, hub, Ms @ AX_LATHE, max(16, segs // 2), mats=[paint] * 6 + ["steel"] * 3)
    w0, w1 = (0.072, 0.048) if R > 0.6 else (0.05, 0.036)
    d0, d1 = (0.085, 0.058) if R > 0.6 else (0.06, 0.044)
    for k in range(n_spokes):
        spoke(g, paint, TAU * k / n_spokes, hub_r + 0.005, rin, w0, w1, d0, d1, xc, Ms)
    if counterweight:
        beta = math.radians(62)
        pts = []
        n = 16
        for k in range(n + 1):
            phi = math.pi - beta + 2 * beta * k / n
            pts.append((rin * math.cos(phi), rin * math.sin(phi)))
        for k in range(n - 1, 0, -1):
            phi = math.pi - beta + 2 * beta * k / n
            u = (phi - math.pi) / beta
            r = rin - 0.30 * (1 - u * u) ** 0.55
            pts.append((r * math.cos(phi), r * math.sin(phi)))
        prism(g, paint, pts, xc - 0.048, xc + 0.048, Ms @ PYZ(0.0))
    if pin_end is not None:
        # crank boss, merged with the spoke at phi = 0
        lathe(g, paint, [(0.105, xc - 0.045), (0.118, xc - 0.033), (0.118, xc + 0.082), (0.104, xc + 0.098), (0.0, xc + 0.1)],
              Ms @ AXX(0, CRANK, 0), 28)
        pin = [(0.058, xc + 0.095), (0.058, pin_end - 0.018), (0.075, pin_end - 0.016), (0.075, pin_end - 0.004),
               (0.062, pin_end), (0.0, pin_end + 0.002)]
        lathe(g, "steel", pin, Ms @ AXX(0, CRANK, 0), 20)


def axle(g, r, half, mat="steel"):
    for s in (1, -1):
        lathe(g, mat, [(r, 0.0), (r, half)], side(s) @ AX_LATHE, 16)


def plate_wheel(g, s, R, segs):
    """Cast-iron plate (disc) wheel for tender and car trucks, tread centre near |x| = 0.75."""
    Ms = side(s)
    xi, xo = 0.685, 0.815
    prof = [(0.09, 0.640), (0.14, 0.645), (0.25, 0.722), (R - 0.08, 0.700), (R - 0.068, xi), (R + 0.012, xi),
            (R + 0.028, xi + 0.008), (R + 0.024, xi + 0.026), (R + 0.004, xi + 0.038), (R - 0.008, xo - 0.004),
            (R - 0.016, xo), (R - 0.065, xo - 0.008), (R - 0.11, 0.756), (0.17, 0.745), (0.13, 0.835), (0.0, 0.85)]
    mats = ["blackIron"] * 5 + ["steel"] * 5 + ["blackIron"] * 5
    lathe(g, None, prof, Ms @ AX_LATHE, segs, mats=mats)


def car_wheelset(R=0.42, journal=1.04):
    g = Geo()
    for s in (1, -1):
        plate_wheel(g, s, R, 20)
        lathe(g, "steel", [(0.082, 0.0), (0.082, 0.86), (0.06, 0.87), (0.06, journal), (0.05, journal + 0.01), (0.0, journal + 0.012)],
              side(s) @ AX_LATHE, 14)
    return g


# ---------------------------------------------------------------------------------------------- locomotive layout
R_D = 0.80          # driver tread radius (63 in drivers)
R_T = 0.38          # leading-truck wheel tread radius (30 in)
R_C = 0.42          # tender and car wheels (33 in)
CRANK = 0.305       # crank radius: half of the 24 in stroke
Y_D1, Y_D2 = 0.0, -2.60
Z_AX = R_D
CYL_X = 0.98        # cylinder axis, crosshead and main rod plane
SIDE_X = 0.905      # side (coupling) rod plane
Y_YOKE = 0.84
Y_X0 = Y_D1 + 1.66  # crosshead wrist pin at front dead centre
Y_CYL = Y_X0 + 0.71
TRUCK_WB = 1.80
Y_T1, Y_T2 = Y_CYL + TRUCK_WB / 2, Y_CYL - TRUCK_WB / 2
L_MAIN = Y_X0 - (Y_D2 + CRANK)
L_SIDE = Y_D1 - Y_D2
BZ = 2.30           # boiler centre line
R_BAR = 0.60        # barrel jacket radius
R_SB = 0.665        # smokebox radius
Y_SB0, Y_SB1 = 1.98, 3.30
FB_R, FB_CZ = 0.70, 2.40   # wagon-top firebox: round top radius and centre height
Y_CONE0, Y_CONE1 = 0.30, -0.20
Y_BH = -2.50        # backhead
RB_Z = 1.40         # running board top
CAB_Y0, CAB_Y1 = -2.30, -4.25
CAB_FLOOR = 1.45
CAB_X = 1.25
EAVE_Z, ROOF_Z = 3.98, 4.30
Y_STACK = 2.40
Y_DOME, Y_SAND, Y_BELL = -0.78, 0.95, 1.50
Y_BEAM = 3.82       # front buffer beam (back face)
LOCO_FRONT_CPL = 4.25
LOCO_REAR_CPL = -4.72
PILOT_NOSE = 5.10
CPL_Z = 0.86        # coupler (drawhead) centre height for every vehicle
HL_Y0, HL_Y1, HL_Z0, HL_Z1, HL_X = 2.95, 3.69, 3.07, 3.83, 0.34
HL_RO = 0.29        # headlight front opening / reflector mouth radius
LENS = dict(y=3.695, z=3.45, r=0.25)
CAB_WIN_Z = (2.42, 3.62)
DOME_TOP = 3.85


def boiler_r_cz(y):
    if y >= Y_SB0:
        return R_SB, BZ
    if y >= Y_CONE0:
        return R_BAR, BZ
    if y >= Y_CONE1:
        t = (Y_CONE0 - y) / (Y_CONE0 - Y_CONE1)
        r = R_BAR + t * (FB_R - R_BAR)
        return r, BZ - R_BAR + r
    return FB_R, FB_CZ


def boiler_top(x, y):
    r, cz = boiler_r_cz(y)
    return cz + math.sqrt(max(r * r - x * x, 0.0))


def conform(g, start, z_lo, z_hi, surf, sink=0.012):
    """Remaps the vertices added since `start` with z below z_hi so that z_lo lands on surf(x, y) - sink."""
    for i in range(start, len(g.v)):
        p = g.v[i]
        if p.z < z_hi:
            zs = surf(p.x, p.y) - sink
            t = max((p.z - z_lo) / (z_hi - z_lo), 0.0)
            p.z = zs + t * (z_hi - zs)


def driver_set(rear):
    g = Geo()
    for s in (1, -1):
        spoked_wheel(g, s, R_D, 0.75, 16, 0.20, 0.095, 56, 0.14, pin_end=1.03 if rear else 0.955, counterweight=True)
    axle(g, 0.095, 0.645)
    return g


def truck_set():
    g = Geo()
    for s in (1, -1):
        spoked_wheel(g, s, R_T, 0.745, 10, 0.115, 0.065, 32, 0.13)
    axle(g, 0.065, 0.64)
    return g


def rod_outline(L, ra, rb, ha, hb, n=10):
    """Counter-clockwise rod outline in (a, b): boss radius ra at a = 0, rb at a = L, shank half-heights ha, hb."""
    ta, tb = math.asin(ha / ra), math.asin(hb / rb)
    pts = []
    for k in range(n + 1):
        th = -math.pi + tb + (TAU - 2 * tb) * k / n
        pts.append((L + rb * math.cos(th), rb * math.sin(th)))
    for k in range(n + 1):
        th = ta + (TAU - 2 * ta) * k / n
        pts.append((ra * math.cos(th), ra * math.sin(th)))
    return pts


def oil_cup(g, at):
    lathe(g, "steel", [(0.026, -0.01), (0.026, 0.035), (0.03, 0.04), (0.03, 0.055), (0.012, 0.062), (0.0, 0.066)],
          T(*at), 12)


def siderod(s):
    """Coupling rod in its own frame: origin at the front crank pin, extending to -Y; plane at local x = 0."""
    g = Geo()
    M = frame((0, 0, 0), (1, 0, 0), (0, -1, 0))
    prism(g, "steel", rod_outline(L_SIDE, 0.095, 0.095, 0.046, 0.046, 12), -0.03, 0.03, M)
    # raised flute borders on the outer face
    for dz in (0.032, -0.032):
        box(g, "steel", (0.008, L_SIDE - 0.26, 0.012), center=(s * 0.033, -L_SIDE / 2, dz))
    for y in (0.0, -L_SIDE):
        oil_cup(g, (0, y, 0.09))
        lathe(g, "brass", [(0.064, -0.003), (0.074, 0.0), (0.074, 0.006), (0.064, 0.008)], frame((s * 0.03, y, 0), (s, 0, 0), (0, 0, 1)), 20)
    return g


def mainrod(s):
    """Main (connecting) rod: origin at the big end (rear crank pin), small end at +L_MAIN along +Y."""
    g = Geo()
    M = frame((0, 0, 0), (1, 0, 0), (0, 1, 0))
    prism(g, "steel", rod_outline(L_MAIN, 0.11, 0.075, 0.06, 0.042, 12), -0.03, 0.03, M)
    # big-end strap, gib and key
    bbox(g, "steel", (0.075, 0.30, 0.235), center=(0, 0.02, 0), r=0.02, segs=2)
    bbox(g, "steel", (0.08, 0.035, 0.30), center=(0, 0.19, 0), r=0.006)
    bbox(g, "steel", (0.07, 0.14, 0.03), center=(0, 0.06, 0.13), r=0.006)
    oil_cup(g, (0, 0.02, 0.118))
    oil_cup(g, (0, L_MAIN, 0.074))
    lathe(g, "brass", [(0.064, -0.003), (0.076, 0.0), (0.076, 0.006), (0.064, 0.008)], frame((s * 0.0375, 0, 0), (s, 0, 0), (0, 0, 1)), 20)
    return g


def crosshead(s):
    """Crosshead, slippers, wrist pin and piston rod: origin at the wrist pin."""
    g = Geo()
    bbox(g, "steel", (0.17, 0.30, 0.17), r=0.015, segs=2)
    for dz in (0.096, -0.096):
        bbox(g, "steel", (0.10, 0.34, 0.026), center=(0, 0, dz), r=0.004)
    lathe(g, "steel", [(0.0, -0.10), (0.045, -0.10), (0.045, 0.10), (0.0, 0.10)], AXX(0, 0, 0), 16)
    for sx in (1, -1):
        lathe(g, "steel", [(0.05, 0.0), (0.05, 0.022), (0.0, 0.024)], frame((sx * 0.085, 0, 0), (sx, 0, 0), (0, 0, 1)), 6)
    # piston rod into the cylinder gland, with its nut on the crosshead
    lathe(g, "steel", [(0.07, 0.15), (0.07, 0.20), (0.045, 0.205), (0.045, 1.05), (0.0, 1.05)], AXY(0, 0, 0), 16)
    return g


# ---------------------------------------------------------------------------------------------- locomotive body
def loco_frames(g):
    for s in (1, -1):
        Ms = side(s)
        x = 0.55
        yr_ = CAB_Y1 - 0.12
        bbox(g, "blackIron", (0.10, Y_BEAM - yr_, 0.12), Ms, center=(x, (Y_BEAM + yr_) / 2, 1.08), r=0.012)
        for yd in (Y_D1, Y_D2):
            for dy in (0.17, -0.17):
                bbox(g, "blackIron", (0.10, 0.07, 0.46), Ms, center=(x, yd + dy, 0.80), r=0.01)
            bbox(g, "blackIron", (0.11, 0.44, 0.06), Ms, center=(x, yd, 0.565), r=0.01)
            bbox(g, "blackIron", (0.15, 0.26, 0.26), Ms, center=(0.545, yd, 0.81), r=0.02)
            # spring saddle, cambered leaf spring with buckle and hangers
            box(g, "blackIron", (0.08, 0.10, 0.08), Ms, center=(x, yd, 1.18))
            L0, t, camber = 0.95, 0.013, 0.035
            k = 4 * camber / (L0 * L0)
            ztop = 1.335
            for i in range(7):
                L = L0 - i * 0.09
                zc = ztop - i * t
                bottom = [(-L / 2 + L * j / 10, zc - k * (-L / 2 + L * j / 10) ** 2 - t / 2) for j in range(11)]
                top = [(L / 2 - L * j / 10, zc - k * (L / 2 - L * j / 10) ** 2 + t / 2) for j in range(11)]
                prism(g, "blackIron", [(yd + a, b) for a, b in bottom + top], x - 0.05, x + 0.05, Ms @ PYZ(0.0))
            bbox(g, "blackIron", (0.12, 0.11, 0.13), Ms, center=(x, yd, ztop - 0.04), r=0.01)
            for e in (1, -1):
                ye = yd + e * (L0 / 2 - 0.02)
                ze = ztop - k * (L0 / 2) ** 2
                tube(g, "blackIron", [(x, ye, ze + 0.01), (x, ye, 1.12)], 0.016, Ms, segs=6)
        # lower rail, front rail to the saddle, rear extension under the cab
        bbox(g, "blackIron", (0.10, Y_D1 - Y_D2 - 0.42, 0.08), Ms, center=(x, (Y_D1 + Y_D2) / 2, 0.66), r=0.01)
        bbox(g, "blackIron", (0.10, Y_CYL - 0.45 - Y_D1 - 0.2, 0.10), Ms, center=(x, (Y_CYL - 0.45 + Y_D1 + 0.2) / 2, 0.92), r=0.01)
        bbox(g, "blackIron", (0.10, Y_D2 - 0.2 - CAB_Y1, 0.10), Ms, center=(x, (Y_D2 - 0.2 + CAB_Y1) / 2, 0.88), r=0.01)
        # equalising beam between the driver springs, with its fulcrum on the frame
        bar(g, "blackIron", Ms @ Vector((x, Y_D1 - 0.46, 1.24)), Ms @ Vector((x, Y_D2 + 0.46, 1.24)), 0.05, 0.07)
        box(g, "blackIron", (0.06, 0.10, 0.12), Ms, center=(x, (Y_D1 + Y_D2) / 2, 1.18))
    for y, z0, z1 in ((3.70, 0.98, 1.14), (Y_D2 - 0.40, 0.82, 1.10), (CAB_Y1 + 0.02, 0.84, 1.10)):
        box(g, "blackIron", (1.0, 0.10, z1 - z0), center=(0, y, (z0 + z1) / 2))


def loco_cylinders(g, meta):
    cocks = []
    for s in (1, -1):
        Ms = side(s)
        prof = [(0.05, -0.52), (0.085, -0.52), (0.092, -0.505), (0.092, -0.43), (0.235, -0.425), (0.25, -0.41),
                (0.272, -0.405), (0.272, -0.36), (0.262, -0.355), (0.262, -0.12), (0.262, 0.12), (0.262, 0.355),
                (0.272, 0.36), (0.272, 0.405), (0.25, 0.41), (0.235, 0.43), (0.19, 0.448), (0.10, 0.458), (0.0, 0.46)]
        mats = ["steel"] * 5 + ["brass"] * 3 + ["boilerGreen"] * 3 + ["brass"] * 3 + ["steel"] * 4
        lathe(g, None, prof, Ms @ AXY(CYL_X, Y_CYL, Z_AX), 32, mats=mats)
        for k in range(10):
            a = TAU * k / 10
            p = Vector((CYL_X + 0.22 * math.cos(a), Y_CYL + 0.43, Z_AX + 0.22 * math.sin(a)))
            rivet(g, "steel", Ms @ p, (0, 1, 0), 0.016)
            q = Vector((CYL_X + 0.20 * math.cos(a), Y_CYL - 0.427, Z_AX + 0.20 * math.sin(a)))
            rivet(g, "steel", Ms @ q, (0, -1, 0), 0.014)
        # steam chest, cover and valve-stem gland
        bbox(g, "boilerGreen", (0.34, 0.66, 0.26), Ms, center=(CYL_X, Y_CYL, 1.17), r=0.02, segs=2)
        bbox(g, "steel", (0.38, 0.70, 0.035), Ms, center=(CYL_X, Y_CYL, 1.318), r=0.01)
        for e in (1, -1):
            box(g, "brass", (0.345, 0.035, 0.03), Ms, center=(CYL_X, Y_CYL + e * 0.26, 1.06))
        lathe(g, "steel", [(0.022, -0.47), (0.048, -0.47), (0.052, -0.44), (0.052, -0.33)], Ms @ AXY(CYL_X, Y_CYL, 1.17), 14)
        tube(g, "steel", [(CYL_X, Y_CYL - 0.47, 1.17), (CYL_X, Y_CYL - 0.80, 1.17)], 0.02, Ms, 8)
        bbox(g, "blackIron", (0.30, 0.10, 0.10), Ms, center=(0.80, Y_CYL - 0.82, 1.17), r=0.01)
        # drain cocks under each end
        for e in (1, -1):
            y = Y_CYL + e * 0.30
            lathe(g, "brass", [(0.0, Z_AX - 0.33), (0.024, Z_AX - 0.33), (0.028, Z_AX - 0.31), (0.028, Z_AX - 0.27),
                               (0.034, Z_AX - 0.255)], Ms @ AXZ(CYL_X, y, 0), 10)
            tip = Vector((CYL_X + 0.05, y + e * 0.035, Z_AX - 0.39))
            tube(g, "blackIron", [(CYL_X, y, Z_AX - 0.315), (CYL_X + 0.025, y + e * 0.02, Z_AX - 0.36), tip], 0.011, Ms, 6)
            cocks.append([round(s * tip.x, 4), round(tip.y, 4), round(tip.z, 4)])
        tube(g, "steel", [(CYL_X - 0.04, Y_CYL - 0.30, Z_AX - 0.30), (CYL_X - 0.04, Y_CYL + 0.30, Z_AX - 0.30)], 0.009, Ms, 6)
    meta["cylinder_cocks"] = cocks
    # saddle
    pts = [(-0.46, 0.64), (0.46, 0.64)]
    for k in range(1, 7):
        a = -math.pi / 2 + (math.pi / 2) * k / 6
        pts.append((0.46 + 0.26 * math.cos(a), 0.90 + 0.26 * math.sin(a)))
    pts += [(0.72, 1.05), (0.72, 1.28), (0.56, 1.34)]
    for k in range(17):
        x = 0.56 - 1.12 * k / 16
        pts.append((x, BZ - math.sqrt(R_SB ** 2 - x * x) + 0.02))
    pts += [(-0.56, 1.34), (-0.72, 1.28), (-0.72, 1.05)]
    for k in range(0, 6):
        a = 0.0 - (math.pi / 2) * k / 6
        pts.append((-0.46 - 0.26 * math.cos(a), 0.90 + 0.26 * math.sin(a)))
    prism(g, "blackIron", pts, 0.0, 0.76, PXZ(Y_CYL + 0.38), div=0.3)


def loco_guides(g):
    yf, yb = Y_CYL - 0.50, Y_YOKE
    for s in (1, -1):
        Ms = side(s)
        for dz in (0.135, -0.135):
            bbox(g, "steel", (0.09, yf - yb + 0.04, 0.05), Ms, center=(CYL_X, (yf + yb) / 2, Z_AX + dz), r=0.008)
            for y in (yf - 0.03, yb + 0.03):
                rivet(g, "steel", Ms @ Vector((CYL_X, y, Z_AX + dz + (0.025 if dz > 0 else -0.025))), (0, 0, 1 if dz > 0 else -1), 0.014)
        yk = Y_YOKE - 0.04
        bbox(g, "blackIron", (0.52, 0.05, 0.10), Ms, center=(0.82, yk, 1.0), r=0.01)
        bbox(g, "blackIron", (0.52, 0.05, 0.10), Ms, center=(0.82, yk, 0.61), r=0.01)
        bbox(g, "blackIron", (0.06, 0.05, 0.49), Ms, center=(1.055, yk, 0.805), r=0.01)
        bbox(g, "blackIron", (0.10, 0.05, 0.49), Ms, center=(0.61, yk, 0.805), r=0.01)


def loco_truck_frame(g):
    for s in (1, -1):
        Ms = side(s)
        x = 0.52
        bbox(g, "blackIron", (0.07, 2.36, 0.09), Ms, center=(x, Y_CYL, 0.475), r=0.01)
        bbox(g, "blackIron", (0.07, 2.36, 0.06), Ms, center=(x, Y_CYL, 0.27), r=0.01)
        for ya in (Y_T1, Y_T2):
            bbox(g, "blackIron", (0.13, 0.26, 0.30), Ms, center=(x, ya, 0.38), r=0.015)
            for j in range(5):
                L = 0.62 - j * 0.1
                box(g, "blackIron", (0.08, L, 0.012), Ms, center=(x, ya, 0.53 + j * 0.013))
        for y in (Y_CYL + 0.25, Y_CYL - 0.25):
            bbox(g, "blackIron", (0.07, 0.06, 0.24), Ms, center=(x, y, 0.38), r=0.008)
    bbox(g, "blackIron", (1.16, 0.30, 0.12), center=(0, Y_CYL, 0.56), r=0.015)
    lathe(g, "blackIron", [(0.20, 0.56), (0.20, 0.64), (0.0, 0.64)], T(0, Y_CYL, 0), 20)
    for y in (Y_CYL + 1.13, Y_CYL - 1.13):
        bbox(g, "blackIron", (1.1, 0.08, 0.10), center=(0, y, 0.40), r=0.01)


def d_ring(y, off=0.0, n=56, z_bot=RB_Z):
    """Firebox wrapper cross-section at y (round top, straight sides), ordered like the boiler lathe rings."""
    r, w, cz = FB_R + off, FB_R + off, FB_CZ
    zb = z_bot - off
    pts = []
    # bottom centre -> left corner -> up the left side -> over the top -> down the right side -> bottom centre
    path = [(0.0, zb), (-w, zb), (-w, cz)]
    for k in range(1, 24):
        a = math.pi - math.pi * k / 24
        path.append((r * math.cos(a), cz + r * math.sin(a)))
    path += [(w, cz), (w, zb), (0.0, zb)]
    L = [0.0]
    for i in range(1, len(path)):
        L.append(L[-1] + math.dist(path[i], path[i - 1]))
    total = L[-1]
    for k in range(n):
        d = total * k / n
        i = max(j for j in range(len(L)) if L[j] <= d + 1e-9)
        i = min(i, len(path) - 2)
        t = (d - L[i]) / max(L[i + 1] - L[i], 1e-9)
        x = path[i][0] + t * (path[i + 1][0] - path[i][0])
        z = path[i][1] + t * (path[i + 1][1] - path[i][1])
        pts.append((x, y, z))
    return pts


def circle_ring(y, r, cz, n=56):
    return [(-r * math.sin(TAU * k / n), y, cz - r * math.cos(TAU * k / n)) for k in range(n)]


def loco_boiler(g):
    # barrel, eccentric conical (wagon-top) course and firebox wrapper
    lathe(g, "boilerGreen", [(R_BAR, Y_CONE0 + (Y_SB0 - Y_CONE0) * k / 6) for k in range(7)], AXY(0, 0, BZ), 56)
    rings = []
    for k in range(5):
        y = Y_CONE1 + (Y_CONE0 - Y_CONE1) * k / 4
        r, cz = boiler_r_cz(y - 1e-6 if k == 4 else y)
        rings.append(circle_ring(y, r, cz))
    loft(g, "boilerGreen", rings)
    loft(g, "boilerGreen", [d_ring(Y_BH + (Y_CONE1 - Y_BH) * k / 7) for k in range(8)])
    # throat plate below the conical course, and the backhead
    for s in (1, -1):
        half = [(0.0, RB_Z), (0.0, FB_CZ - FB_R)]
        for k in range(1, 13):
            a = -math.pi / 2 - (math.pi / 2) * k / 12
            half.append((FB_R * math.cos(a), FB_CZ + FB_R * math.sin(a)))
        half.append((-FB_R, RB_Z))
        prism(g, "boilerGreen", [(s * x, z) for x, z in half], 0.0, 0.02, PXZ(Y_CONE1 + 0.01))
    back = [(p[0], p[2]) for p in d_ring(0.0, 0.0, 56)]
    prism(g, "blackIron", back, 0.0, 0.03, PXZ(Y_BH + 0.01))
    # lower firebox between the frames and the ash pan
    box(g, "blackIron", (0.96, -0.50 - Y_D2, 0.64), center=(0, Y_D2 / 2, 1.08), div=0.5)
    prism(g, "blackIron", [(-0.44, 0.78), (-0.30, 0.56), (0.30, 0.56), (0.44, 0.78)], 0.0, -0.60 - Y_D2, PXZ(-0.30))
    # brass bands
    for y in (1.64, Y_CONE0 + 0.02):
        lathe(g, "brass", [(R_BAR - 0.003, y - 0.024), (R_BAR + 0.007, y - 0.02), (R_BAR + 0.008, y + 0.02), (R_BAR - 0.003, y + 0.024)], AXY(0, 0, BZ), 56)
    yb = Y_CONE1 - 0.035
    loft(g, "brass", [circle_ring(yb - 0.024, FB_R - 0.003, FB_CZ), circle_ring(yb - 0.02, FB_R + 0.008, FB_CZ),
                      circle_ring(yb + 0.02, FB_R + 0.008, FB_CZ), circle_ring(yb + 0.024, FB_R - 0.003, FB_CZ)])
    for y in (-1.45, Y_BH + 0.035):
        loft(g, "brass", [d_ring(y - 0.024, -0.003), d_ring(y - 0.02, 0.008), d_ring(y + 0.02, 0.008), d_ring(y + 0.024, -0.003)])
    # smokebox and its door
    sb = [(R_BAR - 0.01, Y_SB0), (R_SB, Y_SB0)] + [(R_SB, Y_SB0 + (Y_SB1 - 0.02 - Y_SB0) * k / 5) for k in range(1, 6)]
    sb += [(R_SB + 0.02, Y_SB1 - 0.01), (R_SB + 0.025, Y_SB1 + 0.04), (0.572, Y_SB1 + 0.045)]
    lathe(g, "blackIron", sb, AXY(0, 0, BZ), 56)
    door = [(0.578, Y_SB1 + 0.035), (0.578, Y_SB1 + 0.06), (0.55, Y_SB1 + 0.075), (0.45, Y_SB1 + 0.095),
            (0.30, Y_SB1 + 0.11), (0.15, Y_SB1 + 0.117), (0.0, Y_SB1 + 0.12)]
    lathe(g, "blackIron", door, AXY(0, 0, BZ), 48)
    for k in range(30):
        a = TAU * (k + 0.5) / 30
        rivet(g, "blackIron", (0.625 * math.cos(a), Y_SB1 + 0.045, BZ + 0.625 * math.sin(a)), (0, 1, 0), 0.012)
        rivet(g, "blackIron", (R_SB * math.cos(a), Y_SB0 + 0.045, BZ + R_SB * math.sin(a)), (math.cos(a), 0, math.sin(a)), 0.012)


def door_y(r):
    pts = [(0.0, 0.12), (0.15, 0.117), (0.30, 0.11), (0.45, 0.095), (0.55, 0.075), (0.578, 0.06)]
    for (r0, y0), (r1, y1) in zip(pts, pts[1:]):
        if r <= r1:
            return Y_SB1 + y0 + (y1 - y0) * (r - r0) / (r1 - r0)
    return Y_SB1 + 0.06


def loco_smokebox_front(g, number):
    for dz in (0.22, -0.22):
        pts = []
        for k in range(13):
            x = -0.40 + 1.0 * k / 12
            r = math.hypot(x, dz)
            y = door_y(min(r, 0.578)) + 0.012 if r < 0.578 else Y_SB1 + 0.072
            pts.append((x, y, BZ + dz))
        pts.append((0.645, Y_SB1 + 0.072, BZ + dz))
        tube(g, "blackIron", pts, 0.02, segs=4, rot=math.pi / 4)
        lathe(g, "blackIron", [(0.0, -0.05), (0.03, -0.05), (0.03, 0.05), (0.0, 0.05)], AXZ(0.655, Y_SB1 + 0.07, BZ + dz), 10)
        box(g, "blackIron", (0.06, 0.05, 0.05), center=(0.66, Y_SB1 + 0.04, BZ + dz + 0.065))
    # number plate with brass rim and raised numerals
    yp = door_y(0.0) - 0.004
    lathe(g, None, [(0.162, -0.01), (0.172, 0.0), (0.172, 0.012), (0.162, 0.018), (0.150, 0.016), (0.0, 0.016)],
          AXY(0, yp, BZ), 36, mats=["brass", "brass", "brass", "brass", "blackIron"])
    text(g, "brass", number, "alfa", 0.13, frame((0, yp + 0.0215, BZ), (0, 1, 0), (-1, 0, 0)), depth=0.004)
    # dart handle below
    lathe(g, "steel", [(0.035, 0.0), (0.035, 0.05), (0.0, 0.05)], AXY(0, door_y(0.12) - 0.01, BZ - 0.36), 12)
    bbox(g, "brass", (0.26, 0.03, 0.03), center=(0, door_y(0.12) + 0.05, BZ - 0.36), r=0.01, segs=2)


def loco_stack(g):
    prof = [(0.34, 2.86), (0.31, 2.93), (0.27, 2.99), (0.24, 3.04), (0.228, 3.08), (0.205, 3.10), (0.20, 3.17),
            (0.214, 3.18), (0.214, 3.24), (0.20, 3.25), (0.20, 3.36)]
    for k in range(1, 15):
        t = k / 14
        prof.append((0.20 + 0.385 * (3 * t * t - 2 * t * t * t) ** 0.9, 3.36 + 0.80 * t))
    prof += [(0.596, 4.18), (0.596, 4.235), (0.585, 4.245), (0.585, 4.395), (0.60, 4.405), (0.60, 4.44), (0.575, 4.452),
             (0.50, 4.49), (0.36, 4.548), (0.19, 4.59), (0.0, 4.605)]
    mats = ["blackIron"] * 6 + ["brass"] * 3 + ["blackIron"] * (len(prof) - 10)
    start = len(g.v)
    lathe(g, None, prof, T(0, Y_STACK, 0), 40, mats=mats)
    conform(g, start, 2.86, 3.04, boiler_top)


def loco_domes(g, meta):
    # steam dome (polished brass) on the wagon top
    prof = [(0.54, 2.95), (0.50, 3.02), (0.45, 3.08), (0.40, 3.14), (0.375, 3.22), (0.368, 3.30), (0.368, 3.52),
            (0.378, 3.54), (0.385, 3.57), (0.378, 3.60), (0.365, 3.62), (0.33, 3.70), (0.27, 3.77), (0.18, 3.82),
            (0.08, 3.845), (0.0, DOME_TOP)]
    start = len(g.v)
    lathe(g, "brass", prof, T(0, Y_DOME, 0), 48)
    conform(g, start, 2.95, 3.22, boiler_top)
    # lever safety valve with spring balance
    lathe(g, "brass", [(0.07, 3.83), (0.07, 3.88), (0.055, 3.90), (0.055, 3.965), (0.075, 3.975), (0.075, 3.995), (0.0, 4.0)], T(0, Y_DOME, 0), 16)
    bbox(g, "steel", (0.035, 0.62, 0.045), center=(0, Y_DOME - 0.20, 4.02), r=0.008)
    lathe(g, "steel", [(0.02, 3.80), (0.02, 4.04), (0.0, 4.045)], T(0, Y_DOME + 0.09, 0), 8)
    lathe(g, "brass", [(0.0, 3.62), (0.03, 3.62), (0.034, 3.64), (0.034, 3.92), (0.024, 3.94), (0.012, 4.0), (0.0, 4.0)], T(0, Y_DOME - 0.49, 0), 12)
    bbox(g, "brass", (0.05, 0.16, 0.04), center=(0, Y_DOME - 0.43, 3.60), r=0.008)
    meta["safety_valve"] = [0.0, Y_DOME, 4.02]
    # whistle on the dome top, with its lever and pull rod to the cab
    yw = Y_DOME + 0.22
    lathe(g, "brass", [(0.05, 3.78), (0.05, 3.86), (0.04, 3.88), (0.024, 3.89), (0.024, 3.95), (0.055, 3.955),
                       (0.05, 3.97), (0.05, 4.15), (0.042, 4.175), (0.02, 4.19), (0.012, 4.21), (0.0, 4.215)], T(0, yw, 0), 20)
    bbox(g, "steel", (0.02, 0.22, 0.02), center=(0, yw - 0.10, 3.91), r=0.004)
    tube(g, "steel", [(0, yw - 0.21, 3.91), (0.12, -1.30, 3.86), (0.20, CAB_Y0 + 0.02, 3.78)], 0.007, segs=5)
    meta["whistle"] = [0.0, yw, 4.215]
    # sand dome (painted, brass lid) and sand pipes to the front drivers
    sp = [(0.40, 2.74), (0.36, 2.82), (0.31, 2.88), (0.285, 2.95), (0.28, 3.02), (0.28, 3.18), (0.28, 3.35), (0.29, 3.37),
          (0.296, 3.40), (0.27, 3.42), (0.25, 3.47), (0.20, 3.52), (0.12, 3.555), (0.0, 3.565)]
    start = len(g.v)
    lathe(g, None, sp, T(0, Y_SAND, 0), 40, mats=["boilerGreen"] * 6 + ["brass"] * 7)
    conform(g, start, 2.74, 3.0, boiler_top)
    lathe(g, "brass", [(0.03, 3.555), (0.03, 3.60), (0.05, 3.61), (0.05, 3.63), (0.0, 3.635)], T(0, Y_SAND, 0), 12)
    for s in (1, -1):
        pts = fillet([(0.22, Y_SAND, 2.95), (0.46, Y_SAND, 2.80), (0.66, Y_SAND, 2.40), (0.74, Y_SAND, 1.80),
                      (0.75, Y_SAND, 1.20), (0.75, Y_SAND - 0.02, 0.50), (0.75, 0.55, 0.11)], 0.12, 3)
        tube(g, "blackIron", pts, 0.021, side(s), 8)


def loco_bell(g):
    yb = Y_BELL
    z0 = 3.03
    prof = [(0.0, z0 + 0.22), (0.10, z0 + 0.20), (0.15, z0 + 0.12), (0.172, z0 + 0.03), (0.18, z0), (0.195, z0 - 0.005),
            (0.20, z0 + 0.012), (0.19, z0 + 0.04), (0.165, z0 + 0.10), (0.145, z0 + 0.18), (0.13, z0 + 0.26),
            (0.12, z0 + 0.29), (0.09, z0 + 0.32), (0.05, z0 + 0.336), (0.0, z0 + 0.34)]
    lathe(g, "brass", prof, T(0, yb, 0), 32)
    for s in (1, -1):
        start = len(g.v)
        lathe(g, "brass", [(0.07, 2.84), (0.05, 2.90), (0.026, 2.95), (0.022, 3.0), (0.022, 3.36), (0.0, 3.365)], T(s * 0.245, yb, 0), 12)
        conform(g, start, 2.84, 2.95, boiler_top)
        lathe(g, "brass", [(0.0, -0.025), (0.038, -0.025), (0.038, 0.025), (0.0, 0.025)], AXX(s * 0.245, yb, 3.39), 12)
    tube(g, "brass", fillet([(-0.245, yb, 3.39), (-0.10, yb, 3.375), (0.10, yb, 3.375), (0.245, yb, 3.39)], 0.05, 3), 0.018, segs=8)
    bbox(g, "brass", (0.10, 0.06, 0.06), center=(0, yb, z0 + 0.35), r=0.01)
    tube(g, "brass", [(0.27, yb, 3.39), (0.29, yb - 0.12, 3.34), (0.29, yb - 0.17, 3.26)], 0.012, segs=6)
    # bell cord back to the cab
    tube(g, "roofCanvas", [(0.29, yb - 0.17, 3.26), (0.35, 0.40, 3.20), (0.38, -0.8, 3.30), (0.40, CAB_Y0 + 0.02, 3.70)], 0.006, segs=5)


def loco_headlight(g, number):
    lens = Geo()
    yc = (HL_Y0 + HL_Y1) / 2
    zc = LENS["z"]
    box(g, "woodVarnish", (2 * HL_X + 0.12, HL_Y1 - HL_Y0 + 0.08, 0.045), center=(0, yc, HL_Z0 - 0.0225))
    for s in (1, -1):
        start = len(g.v)
        bbox(g, "blackIron", (0.05, Y_SB1 + 0.02 - (HL_Y0 - 0.02), 0.22), center=(s * 0.24, (Y_SB1 + 0.02 + HL_Y0 - 0.02) / 2, 2.92), r=0.008)
        conform(g, start, 2.81, 2.99, boiler_top, sink=0.03)
        bar(g, "blackIron", (s * 0.24, HL_Y1 + 0.02, HL_Z0 - 0.04), (s * 0.30, Y_SB1 + 0.05, BZ + 0.50), 0.04, 0.03, up=(0, 1, 0))
    t = 0.03
    zc_ = (HL_Z0 + HL_Z1) / 2
    for s in (1, -1):
        bbox(g, "woodVarnish", (t, HL_Y1 - HL_Y0, HL_Z1 - HL_Z0), center=(s * (HL_X - t / 2), yc, zc_), r=0.01, segs=2)
    bbox(g, "woodVarnish", (2 * HL_X, HL_Y1 - HL_Y0, t), center=(0, yc, HL_Z1 - t / 2), r=0.01, segs=2)
    bbox(g, "woodVarnish", (2 * HL_X, HL_Y1 - HL_Y0, t), center=(0, yc, HL_Z0 + t / 2), r=0.01, segs=2)
    bbox(g, "woodVarnish", (2 * HL_X, t, HL_Z1 - HL_Z0), center=(0, HL_Y0 + t / 2, zc_), r=0.01, segs=2)
    # brass corner trim and panel moulding on the sides
    for s in (1, -1):
        for y in (HL_Y1 - 0.01, HL_Y0 + 0.01):
            box(g, "brass", (0.02, 0.02, HL_Z1 - HL_Z0 - 0.02), center=(s * (HL_X - 0.002), y, (HL_Z0 + HL_Z1) / 2))
        x = s * (HL_X + 0.003)
        y0, y1, z0, z1 = HL_Y0 + 0.07, HL_Y1 - 0.07, HL_Z0 + 0.07, HL_Z1 - 0.07
        for a, b in (((x, y0, z0), (x, y1, z0)), ((x, y1, z0), (x, y1, z1)), ((x, y1, z1), (x, y0, z1)), ((x, y0, z1), (x, y0, z0))):
            bar(g, "brass", a, b, 0.012, 0.008, up=(s, 0, 0))
        text_on_side(g, "brass", number, "alfa", 0.24, s * (HL_X + 0.006), yc, zc, s)
    # front plate with the round opening, bezel, parabolic reflector and lens
    for s in (1, -1):
        half = [(0.0, HL_Z1 - 0.01)]
        for k in range(17):
            a = math.pi / 2 + math.pi * k / 16
            half.append((HL_RO * math.cos(a), zc + HL_RO * math.sin(a)))
        half += [(0.0, HL_Z0 + 0.01), (-HL_X + 0.005, HL_Z0 + 0.01), (-HL_X + 0.005, HL_Z1 - 0.01)]
        prism(g, "woodVarnish", [(s * x, z) for x, z in half], 0.0, 0.03, PXZ(HL_Y1 + 0.03))
    ro = HL_RO
    lathe(g, "brass", [(ro + 0.04, HL_Y1 + 0.03), (ro + 0.04, HL_Y1 + 0.04), (ro + 0.03, HL_Y1 + 0.05), (ro, HL_Y1 + 0.047), (ro - 0.004, HL_Y1 + 0.03)], AXY(0, 0, zc), 40)
    lathe(g, "brass", [(ro, HL_Y1 + 0.03), (ro - 0.035, HL_Y1 - 0.04), (ro - 0.09, HL_Y1 - 0.11), (ro - 0.17, HL_Y1 - 0.165), (0.05, HL_Y1 - 0.19), (0.0, HL_Y1 - 0.195)], AXY(0, 0, zc), 40)
    lathe(lens, "lampGlow", [(LENS["r"], 0.0), (0.21, -0.022), (0.16, -0.045), (0.10, -0.062), (0.045, -0.071), (0.0, -0.073)], AXY(0, 0, 0), 40)
    for i, f in enumerate(lens.f):
        lens.uv[i] = [(0.5 + lens.v[k].x / (2 * LENS["r"]), 0.5 + lens.v[k].z / (2 * LENS["r"])) for k in f]
    # gabled sheet-iron roof, gable boards, lamp chimney and finial
    ew, rh = HL_X + 0.07, 0.16
    for s in (1, -1):
        d = Vector((s * ew, 0, -rh)).normalized()
        n = Vector((s * rh, 0, ew)).normalized()
        c = Vector((s * ew / 2, yc, HL_Z1 + rh / 2)) + n * 0.013
        bbox(g, "blackIron", (math.hypot(ew, rh) + 0.03, HL_Y1 - HL_Y0 + 0.12, 0.025), frame(c, n, d), r=0.006)
    for y in (HL_Y0 + 0.01, HL_Y1 - 0.01):
        prism(g, "woodVarnish", [(-(HL_X + 0.01), HL_Z1 - 0.01), (HL_X + 0.01, HL_Z1 - 0.01), (0.0, HL_Z1 + rh - 0.005)], 0.0, 0.02, PXZ(y + 0.01))
    lathe(g, "blackIron", [(0.06, HL_Z1 + 0.08), (0.06, HL_Z1 + 0.30), (0.11, HL_Z1 + 0.31), (0.0, HL_Z1 + 0.38)], T(0, HL_Y0 + 0.22, 0), 16)
    lathe(g, "brass", [(0.0, HL_Z1 + 0.14), (0.03, HL_Z1 + 0.16), (0.03, HL_Z1 + 0.19), (0.0, HL_Z1 + 0.24)], T(0, HL_Y1 + 0.04, 0), 10)
    return lens


def loco_running_boards(g):
    for s in (1, -1):
        Ms = side(s)
        y1, y0 = Y_SB1 + 0.02, CAB_Y0
        box(g, "weatheredWood", (0.29, y1 - y0, 0.04), Ms, center=(1.035, (y1 + y0) / 2, RB_Z - 0.02), div=0.7)
        for a, b in ((Y_D1 + 0.66, y1), (Y_D2 + 0.66, Y_D1 - 0.66)):
            x0 = 0.62 if a > Y_CONE1 else 0.70
            box(g, "weatheredWood", (0.89 - x0, b - a, 0.04), Ms, center=((0.89 + x0) / 2, (a + b) / 2, RB_Z - 0.02), div=0.7)
        box(g, "blackIron", (0.012, y1 - y0, 0.07), Ms, center=(1.186, (y1 + y0) / 2, RB_Z - 0.027))
        for y in (2.95, 1.80, 1.05, -1.20):
            box(g, "blackIron", (0.06, 0.05, 0.30), Ms, center=(0.62, y, RB_Z - 0.19))
            bar(g, "blackIron", Ms @ Vector((0.62, y, RB_Z - 0.32)), Ms @ Vector((1.10, y, RB_Z - 0.05)), 0.04, 0.012, up=(0, 1, 0))
    # front deck and buffer beam
    box(g, "blackIron", (2.30, Y_BEAM - Y_SB1 + 0.05, 0.04), center=(0, (Y_BEAM + Y_SB1 - 0.05) / 2, 1.14))
    bbox(g, "redPaint", (2.44, 0.18, 0.36), center=(0, Y_BEAM + 0.09, 0.98), r=0.012)
    box(g, "blackIron", (2.44, 0.19, 0.012), center=(0, Y_BEAM + 0.09, 1.166))
    for s in (1, -1):
        Ms = side(s)
        for x in (1.06, 1.20):
            bar(g, "blackIron", Ms @ Vector((x, Y_BEAM + 0.14, 0.82)), Ms @ Vector((x, Y_BEAM + 0.20, 0.42)), 0.03, 0.012, up=(0, 1, 0))
        box(g, "blackIron", (0.20, 0.16, 0.02), Ms, center=(1.13, Y_BEAM + 0.20, 0.42))
        lathe(g, "brass", [(0.03, 1.17), (0.02, 1.19), (0.016, 1.40), (0.025, 1.42), (0.0, 1.45)], T(s * 1.0, Y_BEAM + 0.09, 0), 10)


def loco_splashers(g):
    r = 0.875
    phi0 = math.asin((RB_Z - 0.045 - Z_AX) / r)
    for yd in (Y_D1, Y_D2):
        for s in (1, -1):
            Ms = side(s)
            lathe(g, "boilerGreen", [(r, 0.63), (r, 0.89)], Ms @ frame((0, yd, Z_AX), (1, 0, 0), (0, 1, 0)), 22, a0=phi0, a1=math.pi - phi0)
            seg = [(yd + r * math.cos(phi0 + (math.pi - 2 * phi0) * k / 22), Z_AX + r * math.sin(phi0 + (math.pi - 2 * phi0) * k / 22)) for k in range(23)]
            for x0 in (0.625, 0.886):
                prism(g, "boilerGreen", seg, x0, x0 + 0.008, Ms @ PYZ(0.0))
            arc = [(0.896, yd + (r + 0.004) * math.cos(phi0 + (math.pi - 2 * phi0) * k / 22), Z_AX + (r + 0.004) * math.sin(phi0 + (math.pi - 2 * phi0) * k / 22)) for k in range(23)]
            tube(g, "brass", arc, 0.012, Ms, 6)


def loco_handrails(g):
    z, xr = 2.66, 0.72
    ys = [-1.95, -1.25, -0.30, 0.55, 1.20, 2.05, 2.95]
    for s in (1, -1):
        Ms = side(s)
        tube(g, "brass", fillet([(xr, CAB_Y0 + 0.02, z), (xr, 3.12, z), (xr - 0.08, 3.22, z)], 0.06, 3), 0.016, Ms, 8)
        for y in ys:
            r, cz = boiler_r_cz(y)
            if y < Y_CONE1:
                xs = math.sqrt(max(FB_R ** 2 - (z - FB_CZ) ** 2, 0.0))
            else:
                xs = math.sqrt(max(r * r - (z - cz) ** 2, 0.0))
            tube(g, "brass", [(xs - 0.01, y, z), (xr, y, z)], 0.011, Ms, 6)
            lathe(g, "brass", [(0.0, -0.028), (0.02, -0.022), (0.028, 0.0), (0.02, 0.022), (0.0, 0.028)], Ms @ AXX(xr, y, z), 10)
            lathe(g, "brass", [(0.032, -0.004), (0.032, 0.012), (0.0, 0.014)], Ms @ AXX(xs - 0.01, y, z), 10)


def loco_pipes(g):
    for s in (1, -1):
        Ms = side(s)
        pts = fillet([(0.78, CAB_Y0 - 0.03, 1.73), (0.78, -0.45, 1.73), (0.66, 0.10, 1.95), (0.60, 0.52, 2.14)], 0.12, 4)
        tube(g, "blackIron", pts, 0.024, Ms, 8)
        lathe(g, "brass", [(0.0, 0.0), (0.046, 0.0), (0.046, 0.10), (0.03, 0.11), (0.0, 0.112)], Ms @ AXX(0.56, 0.55, 2.15), 14)
        lathe(g, "brass", [(0.032, 2.15), (0.032, 2.24), (0.04, 2.245), (0.04, 2.27), (0.0, 2.275)], Ms @ T(0.62, 0.55, 0), 12)
        # injector under the cab
        lathe(g, "brass", [(0.0, -0.18), (0.04, -0.17), (0.05, -0.10), (0.05, 0.10), (0.04, 0.17), (0.0, 0.18)], Ms @ AXY(0.84, CAB_Y1 + 0.55, 1.25), 14)
    # reach rod from the reverse lever to the lifting arm (right-hand side)
    tube(g, "steel", fillet([(1.0, CAB_Y0 - 0.32, 1.86), (0.94, CAB_Y0 + 0.02, 1.75), (0.94, -0.75, 1.75), (0.94, -0.32, 1.52), (0.94, -0.22, 1.47)], 0.1, 3), 0.017, segs=8)
    bbox(g, "blackIron", (0.08, 0.10, 0.08), center=(0.94, -0.21, 1.44), r=0.01)


def arch_head(a, b, zsp, rise, n=8):
    """Points (y, z) of a segmental arch from y = b to y = a (b < a) springing at zsp."""
    w = a - b
    R = (w * w / 4 + rise * rise) / (2 * rise)
    yc, zc = (a + b) / 2, zsp + rise - R
    half = math.asin(w / 2 / R)
    return [(yc + R * math.sin(-half + 2 * half * k / n), zc + R * math.cos(-half + 2 * half * k / n)) for k in range(n + 1)]


def arched_window(g, mat, Ms, s, xw0, xw1, a, b, zs, zt, rise=0.11, sash=True, n=8):
    """Window opening (y from b to a, sill zs, head zt) in a wall spanning x xw0..xw1 (side +X, mirrored by Ms):
    arched head (spandrel), sash with meeting rail, and two glass panes (quads; the arch hides the upper corners)."""
    xm = (xw0 + xw1) / 2
    zsp = zt - rise - 0.02
    arch = arch_head(a, b, zsp, rise, n)
    prism(g, mat, [(b, zsp)] + arch[1:-1] + [(a, zsp), (a, zt), (b, zt)], xw0, xw1, Ms @ PYZ(0.0))
    if not sash:
        pane_x(g, s * xm, b + 0.005, a - 0.005, zs + 0.005, zt - 0.01, s)
        return
    band = [(y, z - 0.035) for y, z in arch]
    prism(g, mat, arch + list(reversed(band)), xm - 0.018, xm + 0.018, Ms @ PYZ(0.0))
    zmr = zs + (zsp - zs) * 0.55
    for z0, z1 in ((zs, zs + 0.035), (zmr - 0.017, zmr + 0.017)):
        box(g, mat, (0.036, a - b, z1 - z0), Ms, center=(xm, (a + b) / 2, (z0 + z1) / 2))
    for y in (a - 0.017, b + 0.017):
        box(g, mat, (0.036, 0.034, zsp + 0.01 - zs), Ms, center=(xm, y, (zs + zsp + 0.01) / 2))
    pane_x(g, s * xm, b + 0.034, a - 0.034, zs + 0.035, zmr - 0.017, s)
    pane_x(g, s * xm, b + 0.034, a - 0.034, zmr + 0.017, zt - 0.012, s)


def panel_moulding(g, mat, Ms, x, y0, y1, z0, z1, w=0.035, t=0.016):
    for a, b in (((x, y0, z0), (x, y1, z0)), ((x, y1, z0), (x, y1, z1)), ((x, y1, z1), (x, y0, z1)), ((x, y0, z1), (x, y0, z0))):
        bar(g, mat, Ms @ Vector(a), Ms @ Vector(b), w, t, up=(1, 0, 0))


def loco_cab(g, number):
    x1, x0 = CAB_X, CAB_X - 0.05
    xm = (x0 + x1) / 2
    yf, yfi, yr = CAB_Y0, CAB_Y0 - 0.05, CAB_Y1
    zf, ze = CAB_FLOOR, EAVE_Z
    zs, zt = CAB_WIN_Z
    ymid = (yfi + yr) / 2
    wins = ((yfi - 0.11, ymid + 0.06), (ymid - 0.06, yr + 0.11))
    for s in (1, -1):
        Ms = side(s)
        box(g, "woodVarnish", (0.05, yfi - yr, zs - zf), Ms, center=(xm, (yfi + yr) / 2, (zf + zs) / 2), div=0.5)
        box(g, "woodVarnish", (0.05, yfi - yr, ze - zt), Ms, center=(xm, (yfi + yr) / 2, (zt + ze) / 2), div=0.5)
        for a, b in ((yfi, wins[0][0]), (wins[0][1], wins[1][0]), (wins[1][1], yr)):
            box(g, "woodVarnish", (0.05, a - b, zt - zs), Ms, center=(xm, (a + b) / 2, (zs + zt) / 2))
        for a, b in wins:
            arched_window(g, "woodVarnish", Ms, s, x0, x1, a, b, zs, zt)
        bbox(g, "woodVarnish", (0.10, yfi - yr + 0.04, 0.05), Ms, center=(x1 - 0.01, (yfi + yr) / 2, zs - 0.012), r=0.01)
        bbox(g, "woodVarnish", (0.10, yfi - yr + 0.04, 0.07), Ms, center=(x1 - 0.01, (yfi + yr) / 2, ze - 0.035), r=0.012)
        bbox(g, "woodVarnish", (0.075, yfi - yr + 0.02, 0.035), Ms, center=(x1 + 0.004, (yfi + yr) / 2, zt + 0.03), r=0.008)
        for y in (yfi - 0.03, yr + 0.03):
            bbox(g, "woodVarnish", (0.07, 0.07, ze - zf), Ms, center=(x1 - 0.01, y, (zf + ze) / 2), r=0.012)
        y0m, y1m, z0m, z1m = yr + 0.14, yfi - 0.14, zf + 0.11, zs - 0.12
        panel_moulding(g, "woodVarnish", Ms, x1 + 0.008, y0m, y1m, z0m, z1m)
        panel_moulding(g, "brass", Ms, x1 + 0.006, y0m + 0.06, y1m - 0.06, z0m + 0.06, z1m - 0.06, w=0.012, t=0.006)
        text_on_side(g, "brass", number, "alfa", 0.42, s * (x1 + 0.005), (y0m + y1m) / 2, (z0m + z1m) / 2 + 0.01, s)
        tube(g, "brass", [(x1 + 0.005, yr + 0.05, 1.62), (x1 + 0.06, yr + 0.05, 1.66), (x1 + 0.06, yr + 0.05, 3.10), (x1 + 0.005, yr + 0.05, 3.14)], 0.014, Ms, 8)
        for x in (1.08, 1.27):
            bar(g, "blackIron", Ms @ Vector((x, yr + 0.08, CAB_FLOOR - 0.04)), Ms @ Vector((x, yr + 0.08, 0.52)), 0.035, 0.014, up=(1, 0, 0))
        for zst in (0.98, 0.53):
            box(g, "blackIron", (0.22, 0.20, 0.025), Ms, center=(1.175, yr + 0.08, zst))
        box(g, "blackIron", (0.04, yfi - yr - 0.1, 0.11), Ms, center=(1.205, (yfi + yr) / 2, CAB_FLOOR - 0.06))
    # front wall around the firebox, spectacle windows
    zw0, zw1 = 2.62, 3.38
    xa = math.sqrt(0.71 ** 2 - (zw0 - FB_CZ) ** 2)
    for s in (1, -1):
        low = [(0.71, zf), (x1, zf), (x1, zw0), (xa, zw0)]
        low += [(0.71 * math.cos(a), FB_CZ + 0.71 * math.sin(a)) for a in [math.asin((zw0 - FB_CZ) / 0.71) * (1 - k / 6) for k in range(1, 7)]]
        prism(g, "woodVarnish", [(s * x, z) for x, z in low], 0.0, 0.05, PXZ(yf), div=0.5)
        box(g, "woodVarnish", (0.10, 0.05, zw1 - zw0), center=(s * (x1 - 0.05), yf - 0.025, (zw0 + zw1) / 2))
        for x0_, x1_ in ((0.80, 0.83), (1.12, 1.15)):
            box(g, "woodVarnish", (x1_ - x0_, 0.035, zw1 - zw0), center=(s * (x0_ + x1_) / 2, yf - 0.025, (zw0 + zw1) / 2))
        for z0_, z1_ in ((zw0, zw0 + 0.03), (2.985, 3.015), (zw1 - 0.03, zw1)):
            box(g, "woodVarnish", (0.32, 0.035, z1_ - z0_), center=(s * 0.975, yf - 0.025, (z0_ + z1_) / 2))
        for z0_, z1_ in ((zw0 + 0.03, 2.985), (3.015, zw1 - 0.03)):
            pane_y(g, yf - 0.025, 0.83 if s > 0 else -1.12, 1.12 if s > 0 else -0.83, z0_, z1_, 1)
    mid = [(-0.80, zw0), (-xa, zw0)]
    a0 = math.asin((zw0 - FB_CZ) / 0.71)
    for k in range(1, 24):
        a = (math.pi - a0) - (math.pi - 2 * a0) * k / 24
        mid.append((0.71 * math.cos(a), FB_CZ + 0.71 * math.sin(a)))
    mid += [(xa, zw0), (0.80, zw0), (0.80, zw1), (-0.80, zw1)]
    prism(g, "woodVarnish", mid, 0.0, 0.05, PXZ(yf), div=0.5)
    box(g, "woodVarnish", (2 * x1, 0.05, ze - zw1), center=(0, yf - 0.025, (zw1 + ze) / 2), div=0.5)
    # floor (open over the rear drivers), with the slot behind the splashers
    slot = Y_D2 - math.sqrt(0.83 ** 2 - (zf - 0.04 - Z_AX) ** 2) - 0.02
    yfl = yr - 0.10
    box(g, "weatheredWood", (1.24, yfi - yfl, 0.04), center=(0, (yfi + yfl) / 2, zf - 0.02), div=0.6)
    for s in (1, -1):
        box(g, "weatheredWood", (x1 - 0.90, yfi - yfl, 0.04), side(s), center=((x1 + 0.90) / 2, (yfi + yfl) / 2, zf - 0.02))
        box(g, "weatheredWood", (0.28, slot - yfl, 0.04), side(s), center=(0.76, (slot + yfl) / 2, zf - 0.02))
    # arched roof with overhangs, fascia boards and a ventilator
    hw = 1.37
    Rr = (hw ** 2 + (ROOF_Z - ze) ** 2) / (2 * (ROOF_Z - ze))
    czr = ROOF_Z - Rr
    ha = math.asin(hw / Rr)
    roof = [((Rr + 0.035) * math.cos(math.pi / 2 - ha + 2 * ha * k / 24), czr + (Rr + 0.035) * math.sin(math.pi / 2 - ha + 2 * ha * k / 24)) for k in range(25)]
    roof += [(Rr * math.cos(math.pi / 2 + ha - 2 * ha * k / 24), czr + Rr * math.sin(math.pi / 2 + ha - 2 * ha * k / 24)) for k in range(25)]
    rf, rb = yf + 0.20, yr - 0.32
    prism(g, "roofCanvas", roof, 0.0, rf - rb, PXZ(rf), div=0.6)
    fascia = [((Rr + 0.04) * math.cos(math.pi / 2 - ha + 2 * ha * k / 24), czr + (Rr + 0.04) * math.sin(math.pi / 2 - ha + 2 * ha * k / 24)) for k in range(25)]
    fascia += [((Rr - 0.07) * math.cos(math.pi / 2 + ha - 2 * ha * k / 24), czr + (Rr - 0.07) * math.sin(math.pi / 2 + ha - 2 * ha * k / 24)) for k in range(25)]
    for yfc in (rf + 0.01, rb + 0.03):
        prism(g, "woodVarnish", fascia, 0.0, 0.04, PXZ(yfc))
    for s in (1, -1):
        bbox(g, "woodVarnish", (0.05, rf - rb, 0.09), side(s), center=(hw + 0.01, (rf + rb) / 2, ze - 0.005), r=0.01)
    bbox(g, "roofCanvas", (0.62, 0.72, 0.09), center=(0, ymid, ROOF_Z + 0.06), r=0.015)
    # interior: backhead fittings, throttle, reverse lever, seat boxes
    bbox(g, "blackIron", (0.44, 0.05, 0.34), center=(0, Y_BH - 0.04, 1.86), r=0.01)
    bbox(g, "steel", (0.18, 0.04, 0.03), center=(0.06, Y_BH - 0.08, 1.86), r=0.005)
    for x in (-0.28, 0.28):
        lathe(g, None, [(0.0, -0.06), (0.085, -0.06), (0.085, -0.02), (0.075, 0.0), (0.0, 0.0)], AXY(x, Y_BH - 0.02, 2.88), 20, mats=["whitePaint", "brass", "brass", "brass"])
    lathe(g, "brass", [(0.022, -0.20), (0.022, 0.20)], AXZ(0.45, Y_BH - 0.05, 2.40), 8)
    bar(g, "steel", (0.10, Y_BH - 0.06, 3.0), (0.48, Y_BH - 0.30, 2.86), 0.03, 0.03)
    bbox(g, "steel", (0.03, 0.05, 0.95), center=(1.0, CAB_Y0 - 0.32, CAB_FLOOR + 0.47), r=0.008)
    for s in (1, -1):
        bbox(g, "woodVarnish", (0.40, 0.55, 0.62), side(s), center=(0.98, yr + 0.45, CAB_FLOOR + 0.31), r=0.01)
        bbox(g, "roofCanvas", (0.42, 0.57, 0.07), side(s), center=(0.98, yr + 0.45, CAB_FLOOR + 0.655), r=0.02, segs=2)


def loco_pilot(g):
    yb = Y_BEAM + 0.18
    ztop, zbot = 0.80, 0.10
    half = 1.15
    n = 12
    for s in (1, -1):
        for i in range(n):
            x = s * (0.07 + (half - 0.11) * i / (n - 1))
            top = Vector((x, yb + 0.02, ztop - 0.02))
            bot = Vector((x, PILOT_NOSE - (PILOT_NOSE - yb) * abs(x) / half - 0.03, zbot + 0.035))
            d = bot - top
            M = frame((top + bot) / 2, d, (1, 0, 0))
            bbox(g, "redPaint", (0.038, 0.055, d.length + 0.03), M, r=0.006)
        nose_end = Vector((s * half, yb + 0.03, zbot + 0.035))
        bar(g, "blackIron", (0, PILOT_NOSE, zbot + 0.035), nose_end, 0.07, 0.05, r=0.006)
        bar(g, "redPaint", nose_end, (s * half, yb + 0.03, ztop), 0.07, 0.06, up=(0, 1, 0), r=0.006)
    top = Vector((0, yb + 0.03, ztop))
    bot = Vector((0, PILOT_NOSE, zbot + 0.04))
    bbox(g, "redPaint", (0.08, 0.09, (bot - top).length + 0.04), frame((top + bot) / 2, bot - top, (1, 0, 0)), r=0.01)
    bbox(g, "redPaint", (2.36, 0.07, 0.08), center=(0, yb + 0.035, ztop - 0.01), r=0.01)
    bbox(g, "blackIron", (0.16, 0.14, 0.12), center=(0, PILOT_NOSE - 0.04, zbot + 0.05), r=0.02)
    for s in (1, -1):
        bar(g, "blackIron", (s * 0.5, yb + 0.45, 0.20), (s * 0.45, Y_BEAM + 0.05, 0.86), 0.05, 0.03)


def drawhead(g, y_face, direction, link=False):
    """Link-and-pin drawhead whose face is at y_face, pointing along direction (+1 forward, -1 rear)."""
    d = direction
    L = 0.26
    yc = y_face - d * L / 2
    z = CPL_Z
    for dz in (0.075, -0.075):
        bbox(g, "blackIron", (0.24, L, 0.05), center=(0, yc, z + dz), r=0.012)
    for dx in (0.095, -0.095):
        bbox(g, "blackIron", (0.05, L, 0.20), center=(dx, yc, z), r=0.012)
    box(g, "blackIron", (0.20, 0.04, 0.12), center=(0, y_face - d * (L - 0.03), z))
    for dz in (0.095, -0.095):
        bbox(g, "blackIron", (0.30, 0.05, 0.05), center=(0, y_face - d * 0.025, z + dz), r=0.012, segs=2)
    for dx in (0.125, -0.125):
        bbox(g, "blackIron", (0.05, 0.05, 0.24), center=(dx, y_face - d * 0.025, z), r=0.012, segs=2)
    lathe(g, "steel", [(0.0, z + 0.04), (0.017, z + 0.04), (0.017, z + 0.15), (0.03, z + 0.16), (0.03, z + 0.18), (0.0, z + 0.185)], T(0, y_face - d * 0.08, 0), 8)
    if link:
        ring = []
        for k in range(20):
            a = TAU * k / 20
            ring.append(Vector((0.05 * math.cos(a), y_face - d * 0.08 + d * (0.17 + 0.17 * math.sin(a)), z)))
        ring.append(ring[0])
        tube(g, "steel", ring, 0.014, segs=6)


def loco_rear(g):
    for s in (1, -1):
        Ms = side(s)
        tube(g, "blackIron", fillet([(0.84, CAB_Y1 + 0.38, 1.25), (0.70, CAB_Y1 - 0.05, 1.18), (0.62, LOCO_REAR_CPL - 0.06, 1.16)], 0.1, 3), 0.03, Ms, 8)
        lathe(g, "brass", [(0.0, -0.02), (0.045, -0.02), (0.045, 0.03), (0.0, 0.03)], Ms @ AXY(0.62, LOCO_REAR_CPL - 0.06, 1.16), 10)
    bbox(g, "redPaint", (2.40, 0.15, 0.40), center=(0, CAB_Y1 - 0.175, 1.05), r=0.012)
    box(g, "blackIron", (1.40, 0.50, 0.02), center=(0, CAB_Y1 - 0.35, CAB_FLOOR - 0.03))
    drawhead(g, LOCO_REAR_CPL, -1, link=True)
    drawhead(g, LOCO_FRONT_CPL, 1)


def build_loco(meta):
    root = empty("loco")
    g = Geo()
    number = "14"
    loco_frames(g)
    loco_cylinders(g, meta)
    loco_guides(g)
    loco_truck_frame(g)
    loco_boiler(g)
    loco_smokebox_front(g, number)
    loco_stack(g)
    loco_domes(g, meta)
    loco_bell(g)
    lens = loco_headlight(g, number)
    loco_running_boards(g)
    loco_splashers(g)
    loco_handrails(g)
    loco_pipes(g)
    loco_cab(g, number)
    loco_pilot(g)
    loco_rear(g)
    shift = (LOCO_FRONT_CPL + LOCO_REAR_CPL) / 2
    for v in g.v:
        v.y -= shift
    body = mesh_object("loco_body", g, root)
    mesh_object("loco_headlight_lens", lens, root, (0, LENS["y"] - shift, LENS["z"]))
    parts = [
        ("loco_drive_1", driver_set(False), (0, Y_D1, Z_AX)),
        ("loco_drive_2", driver_set(True), (0, Y_D2, Z_AX)),
        ("loco_truck_1", truck_set(), (0, Y_T1, R_T)),
        ("loco_truck_2", truck_set(), (0, Y_T2, R_T)),
    ]
    for sname, s in (("L", -1), ("R", 1)):
        parts.append((f"loco_siderod_{sname}", siderod(s), (s * SIDE_X, Y_D1 + CRANK, Z_AX)))
        parts.append((f"loco_mainrod_{sname}", mainrod(s), (s * CYL_X, Y_D2 + CRANK, Z_AX)))
        parts.append((f"loco_crosshead_{sname}", crosshead(s), (s * CYL_X, Y_X0, Z_AX)))
    for name, pg, (x, y, z) in parts:
        part(name, pg, (x, y - shift, z), root)
    meta["shift"] = shift

    def sh(p):
        return [round(p[0], 4), round(p[1] - shift, 4), round(p[2], 4)]

    wheels = [{"name": n, "y": round(y - shift, 4), "z": z, "radius": r} for n, y, z, r in
              (("loco_truck_1", Y_T1, R_T, R_T), ("loco_truck_2", Y_T2, R_T, R_T), ("loco_drive_1", Y_D1, Z_AX, R_D), ("loco_drive_2", Y_D2, Z_AX, R_D))]
    car_meta(meta, "loco", LOCO_FRONT_CPL - shift, LOCO_REAR_CPL - shift, wheels,
             {"front_extent_y": round(PILOT_NOSE - shift, 4), "overall_length": round(PILOT_NOSE - LOCO_REAR_CPL, 4)})
    meta["locomotive"] = {
        "sides": {"L": "-X (left-hand side facing forward, fireman's side)", "R": "+X (right-hand side, engineer's side)"},
        "crank_radius": CRANK,
        "cylinders": {"axis_height": Z_AX, "axis_x_abs": CYL_X, "inclination_deg": 0.0, "centre_y": round(Y_CYL - shift, 4),
                      "bore": 0.406, "stroke": 2 * CRANK, "note": "horizontal, on the driving-axle line: the main rod lies on the axis at front dead centre"},
        "main_rod": {"length": round(L_MAIN, 4), "drives": "loco_drive_2", "plane_x_abs": CYL_X,
                     "rest_big_end_y": round(Y_D2 + CRANK - shift, 4), "rest_small_end_y": round(Y_X0 - shift, 4)},
        "side_rod": {"length": round(L_SIDE, 4), "plane_x_abs": SIDE_X, "rest_front_pin_y": round(Y_D1 + CRANK - shift, 4)},
        "crosshead": {"rest_y": round(Y_X0 - shift, 4), "travel": 2 * CRANK, "moves": "between rest_y (front dead centre) and rest_y - travel"},
        "rest_pose": "every crank pin at front dead centre: (0, +crank_radius, 0) from its axle, on both sides",
        "pivots": {n: sh(p) for n, p in (
            ("loco_siderod_L", (-SIDE_X, Y_D1 + CRANK, Z_AX)), ("loco_siderod_R", (SIDE_X, Y_D1 + CRANK, Z_AX)),
            ("loco_mainrod_L", (-CYL_X, Y_D2 + CRANK, Z_AX)), ("loco_mainrod_R", (CYL_X, Y_D2 + CRANK, Z_AX)),
            ("loco_crosshead_L", (-CYL_X, Y_X0, Z_AX)), ("loco_crosshead_R", (CYL_X, Y_X0, Z_AX)),
            ("loco_drive_1", (0.0, Y_D1, Z_AX)), ("loco_drive_2", (0.0, Y_D2, Z_AX)),
            ("loco_truck_1", (0.0, Y_T1, R_T)), ("loco_truck_2", (0.0, Y_T2, R_T)))},
        "kinematics": ("theta = rotation of a wheel set about its local +X (right-hand rule: +Y turns towards +Z); moving forward a "
                       "distance d gives theta = -d / radius. For a side with phase phi (the game applies the 90 deg quartering), "
                       "pin = axle + r*(0, cos(theta+phi), sin(theta+phi)). Side rod: translate by pin_front - rest_pin_front, no rotation. "
                       "Main rod: big end at the rear pin p; small end y_x = p.y + sqrt(L^2 - (p.z - axis_height)^2); rotate about X by "
                       "atan2(axis_height - p.z, y_x - p.y). Crosshead: y = y_x (translation along Y only)."),
        "stack_top": sh((0.0, Y_STACK, 4.605)),
        "cylinder_cocks": [sh(c) for c in meta.pop("cylinder_cocks")],
        "safety_valve": sh(meta.pop("safety_valve")),
        "whistle": sh(meta.pop("whistle")),
        "bell": sh((0.0, Y_BELL, 3.20)),
        "headlight_lens": {"centre": sh((0.0, LENS["y"], LENS["z"])), "facing": [0, 1, 0], "radius": LENS["r"]},
        "cab_glass": "material glass: 8 side panes and 4 front panes, one quad each",
    }
    return root


# ---------------------------------------------------------------------------------------------- shared car parts
FRAME_Z0, FRAME_Z1 = 0.98, 1.20   # wooden car sills (bottom, top)
ROAD = "COPPER WELLS & RED BUTTE"
ROAD_INIT = "C. W. & R. B."


def coil_spring(g, x, y, z0, z1, r=0.06, turns=3):
    n = turns * 2
    lathe(g, "blackIron", [(r if k % 2 == 0 else r - 0.013, z0 + (z1 - z0) * k / n) for k in range(n + 1)], T(x, y, 0), 7)


def arch_truck(g, yc, wb=1.5, R=R_C, fx=1.02, brake=True):
    """Static diamond (arch-bar) truck frame centred at yc: journal boxes, top and inverted arch bars, tie bar,
    columns, coil-spring nests, wooden bolster, centre plate and brake beams with shoes."""
    zA = R
    ya, yb = yc - wb / 2, yc + wb / 2
    e = 0.17
    for s in (1, -1):
        Ms = side(s)
        for y in (ya, yb):
            bbox(g, "blackIron", (0.17, 0.25, 0.25), Ms, center=(fx, y, zA + 0.02), r=0.02)
            bbox(g, "blackIron", (0.185, 0.21, 0.03), Ms, center=(fx + 0.005, y, zA + 0.15), r=0.008)
            box(g, "blackIron", (0.03, 0.06, 0.05), Ms, center=(fx + 0.095, y, zA + 0.10))
            for dy in (-0.15, 0.15):
                tube(g, "blackIron", [(fx, y + dy, zA - 0.14), (fx, y + dy, zA + 0.215)], 0.013, Ms, 4)
        top = [(fx, ya - e, zA + 0.185), (fx, ya + 0.14, zA + 0.185), (fx, yc - 0.33, zA + 0.335), (fx, yc + 0.33, zA + 0.335), (fx, yb - 0.14, zA + 0.185), (fx, yb + e, zA + 0.185)]
        inv = [(fx, ya - e + 0.03, zA + 0.16), (fx, ya + 0.14, zA + 0.16), (fx, yc - 0.33, zA - 0.075), (fx, yc + 0.33, zA - 0.075), (fx, yb - 0.14, zA + 0.16), (fx, yb + e - 0.03, zA + 0.16)]
        bar_path(g, "blackIron", [Ms @ Vector(p) for p in top], 0.10, 0.025)
        bar_path(g, "blackIron", [Ms @ Vector(p) for p in inv], 0.10, 0.022)
        bar(g, "blackIron", Ms @ Vector((fx, ya - e, zA - 0.12)), Ms @ Vector((fx, yb + e, zA - 0.12)), 0.10, 0.022)
        for y in (yc - 0.31, yc + 0.31):
            bbox(g, "blackIron", (0.11, 0.06, 0.40), Ms, center=(fx, y, zA + 0.13), r=0.01)
        for dy in (-0.10, 0.10):
            coil_spring(g, s * fx, yc + dy, zA - 0.06, zA + 0.07)
    bbox(g, "weatheredWood", (2.30, 0.26, 0.18), center=(0, yc, zA + 0.16), r=0.015)
    box(g, "blackIron", (2.20, 0.30, 0.03), center=(0, yc, zA - 0.075))
    lathe(g, "blackIron", [(0.17, zA + 0.25), (0.17, zA + 0.30), (0.0, zA + 0.30)], T(0, yc, 0), 16)
    for s in (1, -1):
        box(g, "blackIron", (0.14, 0.12, 0.04), side(s), center=(0.78, yc, zA + 0.27))
    if brake:
        for y, d in ((ya, 1), (yb, -1)):
            ybb = y + d * (R + 0.075)
            bar(g, "blackIron", (-0.84, ybb, zA - 0.02), (0.84, ybb, zA - 0.02), 0.08, 0.06)
            for s in (1, -1):
                Ms = side(s)
                arc_pts = []
                for k in range(6):
                    a = -0.30 + 0.60 * k / 5
                    arc_pts.append((y + d * (R + 0.012) * math.cos(a), zA + (R + 0.012) * math.sin(a)))
                for k in range(5, -1, -1):
                    a = -0.30 + 0.60 * k / 5
                    arc_pts.append((y + d * (R + 0.06) * math.cos(a), zA + (R + 0.06) * math.sin(a)))
                prism(g, "blackIron", arc_pts, 0.70, 0.80, Ms @ PYZ(0.0))
                bar(g, "blackIron", Ms @ Vector((0.75, ybb, zA - 0.02)), Ms @ Vector((0.75, y + d * (R + 0.05), zA)), 0.07, 0.05)
                bar(g, "blackIron", Ms @ Vector((0.86, ybb, zA - 0.02)), Ms @ Vector((0.86, yc - d * 0.12, zA + 0.12)), 0.03, 0.015)


def car_underframe(g, ends, W2, trucks, sill_mat="boxcarRed"):
    """Sills, end sills, body bolsters, needle beams, queen posts and truss rods of a wooden car;
    `ends` = end-sill outer face (half length), W2 = half width at the side-sill outer face."""
    z0, z1 = FRAME_Z0, FRAME_Z1
    for s in (1, -1):
        Ms = side(s)
        box(g, sill_mat, (0.10, 2 * ends - 0.2, z1 - z0), Ms, center=(W2 - 0.05, 0, (z0 + z1) / 2), div=0.8)
        box(g, sill_mat, (0.10, 2 * ends - 0.3, 0.16), Ms, center=(0.66, 0, z1 - 0.08))
        box(g, sill_mat, (0.12, 2 * ends - 0.3, 0.20), Ms, center=(0.20, 0, z1 - 0.10))
    for e in (1, -1):
        bbox(g, sill_mat, (2 * W2 + 0.04, 0.12, 0.30), center=(0, e * (ends - 0.06), z1 - 0.15), r=0.012)
    for ty in trucks:
        box(g, "blackIron", (2 * W2 - 0.06, 0.24, 0.24), center=(0, ty, 0.86))
        lathe(g, "blackIron", [(0.19, 0.72), (0.19, 0.74), (0.0, 0.74)], T(0, ty, 0), 16)
    for ny in (1.30, -1.30):
        box(g, sill_mat, (2 * W2 - 0.06, 0.10, 0.10), center=(0, ny, 0.93))
        for x in (0.42, -0.42, 1.02, -1.02):
            box(g, "blackIron", (0.06, 0.07, 0.28), center=(x, ny, 0.74))
    for x in (0.42, -0.42, 1.02, -1.02):
        tube(g, "blackIron", [(x, -(ends - 0.32), 1.06), (x, -1.30, 0.60), (x, 1.30, 0.60), (x, ends - 0.32, 1.06)], 0.016, segs=6)
        lathe(g, "blackIron", [(0.016, -0.16), (0.032, -0.13), (0.032, 0.13), (0.016, 0.16)], AXY(x, 0, 0.60), 6)
        for e in (1, -1):
            box(g, "blackIron", (0.06, 0.03, 0.06), center=(x, e * (ends - 0.005), 1.06))


def stirrup(g, x, y, ztop, s, w=0.26, h=0.40):
    tube(g, "blackIron", fillet([(x, y - w / 2, ztop), (x, y - w / 2, ztop - h), (x, y + w / 2, ztop - h), (x, y + w / 2, ztop)], 0.03, 2), 0.013, side(s), 6)


def grab_side(g, x, y, z, s, w=0.42, out=0.07, vertical=False):
    if vertical:
        pts = [(x, y, z - w / 2), (x + out, y, z - w / 2), (x + out, y, z + w / 2), (x, y, z + w / 2)]
    else:
        pts = [(x, y - w / 2, z), (x + out, y - w / 2, z), (x + out, y + w / 2, z), (x, y + w / 2, z)]
    tube(g, "blackIron", fillet(pts, 0.022, 2), 0.011, side(s), 5)


def grab_end(g, x, y, z, e, w=0.42, out=0.07, vertical=False):
    if vertical:
        pts = [(x, y, z - w / 2), (x, y + e * out, z - w / 2), (x, y + e * out, z + w / 2), (x, y, z + w / 2)]
    else:
        pts = [(x - w / 2, y, z), (x - w / 2, y + e * out, z), (x + w / 2, y + e * out, z), (x + w / 2, y, z)]
    tube(g, "blackIron", fillet(pts, 0.022, 2), 0.011, None, 5)


def brake_wheel(g, c, r=0.21, staff_bottom=None):
    cx, cy, cz = c
    tube(g, "blackIron", [(cx + r * math.cos(TAU * k / 20), cy + r * math.sin(TAU * k / 20), cz) for k in range(21)], 0.013, None, 6)
    lathe(g, "blackIron", [(0.0, cz - 0.03), (0.035, cz - 0.03), (0.035, cz + 0.03), (0.0, cz + 0.035)], T(cx, cy, 0), 8)
    for k in range(4):
        a = TAU * k / 4 + 0.4
        tube(g, "blackIron", [(cx + 0.03 * math.cos(a), cy + 0.03 * math.sin(a), cz), (cx + r * math.cos(a), cy + r * math.sin(a), cz)], 0.009, None, 5)
    if staff_bottom is not None:
        tube(g, "blackIron", [(cx, cy, staff_bottom), (cx, cy, cz + 0.05)], 0.017, None, 6)


def gable_roof(g, mat, W, L2, ze, zr, t=0.04, overhang=0.08):
    """Two roof slabs from the ridge (zr) to the eaves (ze at x = +-W), overhanging by `overhang`."""
    ew = W + overhang
    rh = (zr - ze) * ew / W
    for s in (1, -1):
        d = Vector((s * ew, 0, -rh)).normalized()
        n = Vector((s * rh, 0, ew)).normalized()
        c = Vector((s * ew / 2, 0, zr - rh / 2)) + n * (t / 2)
        box(g, mat, (math.hypot(ew, rh) + 0.01, 2 * L2, t), frame(c, n, d), div=0.9)
    return rh


def wheelsets(prefix, root, ys, R=R_C, shift=0.0):
    out = []
    for i, y in enumerate(ys):
        name = f"{prefix}_wheel_{i + 1}"
        part(name, car_wheelset(R), (0, y - shift, R), root)
        out.append({"name": name, "y": round(y - shift, 4), "z": R, "radius": R})
    return out


def car_meta(meta, name, front, rear, wheels, extra=None):
    d = {"length_over_couplers": round(front - rear, 4), "front_coupler_y": round(front, 4), "rear_coupler_y": round(rear, 4),
         "coupler_height": CPL_Z, "wheelsets": wheels}
    if extra:
        d.update(extra)
    meta.setdefault("vehicles", {})[name] = d


# ---------------------------------------------------------------------------------------------- tender
TND_CPL = 3.75


def log_piece(g, rng, c, L, r, yaw, pitch, split):
    n = 7
    pts = []
    if split:
        for k in range(n):
            a = math.pi * k / (n - 1)
            rr = r * rng.uniform(0.92, 1.06)
            pts.append((rr * math.cos(a), rr * math.sin(a) - r * 0.32))
    else:
        for k in range(n):
            a = TAU * k / n
            rr = r * rng.uniform(0.86, 1.08)
            pts.append((rr * math.cos(a), rr * math.sin(a)))
    roll = rng.uniform(0, TAU)
    pts = [(x * math.cos(roll) - y * math.sin(roll), x * math.sin(roll) + y * math.cos(roll)) for x, y in pts]
    axis = Vector((math.cos(yaw) * math.cos(pitch), math.sin(yaw) * math.cos(pitch), math.sin(pitch)))
    prism(g, "bark", pts, -L / 2, L / 2, frame(c, axis, (0, 0, 1)), side_mat="bark", cap_mat="weatheredWood")


def smoothstep(a, b, x):
    t = max(0.0, min(1.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def cordwood(g, y0, y1, z0, z_tank, ztop, x_bunker, x_out, y_over):
    """Split and round 4 ft cordwood: one log across inside the bunker, two end to end above the tank top."""
    rng = random.Random(1872)
    z = z0
    layer = 0
    while z + 0.07 < max(ztop(y0 + k * 0.1) for k in range(int((y1 - y0) / 0.1) + 1)):
        zc = z + 0.07
        y = y0 + 0.07 + (0.06 if layer % 2 else 0.0)
        while y < y1 - 0.06:
            r = rng.uniform(0.055, 0.085)
            if zc + r <= ztop(y) + 0.02:
                inside = zc + r * 0.5 < z_tank or y > y_over
                if inside:
                    L = rng.uniform(1.14, 1.30)
                    xc = rng.uniform(-0.04, 0.04)
                    if abs(xc) + L / 2 > x_bunker + 0.04:
                        L = 2 * (x_bunker + 0.04 - abs(xc))
                    log_piece(g, rng, (xc, y, zc + rng.uniform(-0.01, 0.015)), L, r, rng.uniform(-0.06, 0.06), rng.uniform(-0.03, 0.03), rng.random() < 0.4)
                else:
                    for sx in (-1, 1):
                        L = rng.uniform(1.08, 1.22)
                        xc = sx * (L / 2 + rng.uniform(0.0, 0.05))
                        if abs(xc) + L / 2 > x_out:
                            xc = sx * (x_out - L / 2)
                        log_piece(g, rng, (xc, y + rng.uniform(-0.02, 0.02), zc + rng.uniform(-0.015, 0.03)), L, r, rng.uniform(-0.09, 0.09), rng.uniform(-0.06, 0.06), rng.random() < 0.4)
            y += 2 * r * rng.uniform(0.94, 1.05)
        z += 0.125
        layer += 1


def flare(g, mat, path, z, out=0.13, up=0.15, t=0.008):
    """Outward-flaring coping plate along an open plan path (counter-clockwise around the tank), with a rolled bead."""
    P = [Vector((p[0], p[1], 0)) for p in path]
    N = []
    for i in range(len(P)):
        d = (P[min(i + 1, len(P) - 1)] - P[max(i - 1, 0)]).normalized()
        N.append(Vector((d.y, -d.x, 0)))
    A = [Vector((p.x, p.y, z)) for p in P]
    B = [Vector((p.x, p.y, z)) + n * out + Vector((0, 0, up)) for p, n in zip(P, N)]
    pn = [((b - a).cross(Vector((0, 0, 1)).cross(n))).normalized() for a, b, n in zip(A, B, N)]
    verts, faces, uvs = [], [], []
    L = 0.0
    for i in range(len(P) - 1):
        seg = (P[i + 1] - P[i]).length
        for side_ in (0, 1):
            o0 = -pn[i] * t * side_
            o1 = -pn[i + 1] * t * side_
            q = [A[i] + o0, A[i + 1] + o1, B[i + 1] + o1, B[i] + o0]
            base = len(verts)
            verts += q
            faces.append((base + 3, base + 2, base + 1, base) if side_ == 0 else (base, base + 1, base + 2, base + 3))
            uv = [(L, 0.0), (L + seg, 0.0), (L + seg, 0.2), (L, 0.2)]
            uvs.append(list(reversed(uv)) if side_ == 0 else uv)
        L += seg
    g.add(verts, faces, uvs, mat, None)
    tube(g, mat, B, 0.02, segs=6)


def build_tender(meta):
    root = empty("tender")
    g = Geo()
    hl, W, zd = 3.55, 1.30, 1.40
    zt1 = 2.46
    trucks = (2.20, -2.20)
    for s in (1, -1):
        Ms = side(s)
        box(g, "weatheredWood", (0.12, 2 * hl - 0.2, 0.30), Ms, center=(W - 0.06, 0, zd - 0.19), div=0.8)
        box(g, "weatheredWood", (0.12, 2 * hl - 0.3, 0.22), Ms, center=(0.45, 0, zd - 0.15))
    for e in (1, -1):
        bbox(g, "redPaint", (2 * W + 0.06, 0.14, 0.40), center=(0, e * (hl - 0.07), zd - 0.24), r=0.015)
    box(g, "weatheredWood", (2 * W, 2 * hl - 0.28, 0.04), center=(0, 0, zd - 0.02), div=0.8)
    for ty in trucks:
        box(g, "blackIron", (2 * W - 0.10, 0.24, 0.32), center=(0, ty, 0.90))
        lathe(g, "blackIron", [(0.19, 0.72), (0.19, 0.74), (0.0, 0.74)], T(0, ty, 0), 16)
    # horseshoe tank with rounded rear corners
    rc = 0.30
    outline = [(-W, 3.05), (-W, -3.45 + rc)]
    outline += [(-W + rc + rc * math.cos(math.pi + 0.5 * math.pi * k / 6), -3.45 + rc + rc * math.sin(math.pi + 0.5 * math.pi * k / 6)) for k in range(1, 6)]
    outline += [(-W + rc, -3.45), (W - rc, -3.45)]
    outline += [(W - rc + rc * math.cos(1.5 * math.pi + 0.5 * math.pi * k / 6), -3.45 + rc + rc * math.sin(1.5 * math.pi + 0.5 * math.pi * k / 6)) for k in range(1, 6)]
    outline += [(W, -3.45 + rc), (W, 3.05), (0.72, 3.05), (0.72, 0.30), (-0.72, 0.30), (-0.72, 3.05)]
    prism(g, "boilerGreen", outline, zd, zt1, div=0.6, rows=3)
    flare(g, "boilerGreen", outline[:-4], zt1)
    # bunker floor (hidden under the wood) and the cordwood load, side racks and back board
    box(g, "blackIron", (1.44, 2.75, 0.04), center=(0, 1.675, 2.20))
    ztop = lambda y: 2.90 + 0.09 * math.sin(math.pi * min(max((y - 0.33) / 2.1, 0.0), 1.0)) - 0.42 * smoothstep(2.30, 3.00, y) - 0.10 * smoothstep(0.75, 0.35, y)
    cordwood(g, 0.33, 3.02, 2.22, zt1, ztop, 0.70, 1.22, 2.42)
    for s in (1, -1):
        Ms = side(s)
        for y in (0.40, 1.08, 1.76, 2.42):
            bbox(g, "weatheredWood", (0.075, 0.075, 0.66), Ms, center=(1.255, y, zt1 + 0.30), r=0.01, uvrot=True)
        bbox(g, "weatheredWood", (0.04, 2.14, 0.11), Ms, center=(1.30, 1.41, zt1 + 0.58), r=0.008)
        bar(g, "blackIron", Ms @ Vector((1.29, 0.40, zt1 + 0.02)), Ms @ Vector((1.29, 2.42, zt1 + 0.02)), 0.05, 0.012, up=(0, 0, 1))
    for z in (2.62, 2.86):
        bbox(g, "weatheredWood", (2.50, 0.04, 0.16), center=(0, 0.285, z), r=0.008)
    # tool boxes on the tank arms, brake wheel, tank valves and feed hoses, water hatch
    for s in (1, -1):
        bbox(g, "woodVarnish", (0.50, 0.40, 0.30), side(s), center=(1.0, 2.80, zt1 + 0.15), r=0.012)
        box(g, "blackIron", (0.52, 0.03, 0.03), side(s), center=(1.0, 2.80, zt1 + 0.305))
    brake_wheel(g, (1.0, 3.32, 2.62), 0.20, zd)
    for s in (1, -1):
        Ms = side(s)
        lathe(g, "brass", [(0.0, -0.06), (0.05, -0.06), (0.05, 0.06), (0.0, 0.06)], Ms @ AXY(0.95, 3.10, 1.55), 10)
        tube(g, "steel", [(0.95, 3.12, 1.60), (0.95, 3.12, 2.52)], 0.012, Ms, 6)
        bar(g, "steel", Ms @ Vector((0.85, 3.12, 2.52)), Ms @ Vector((1.05, 3.12, 2.52)), 0.025, 0.025)
        tube(g, "roofCanvas", fillet([(0.95, 3.14, 1.52), (0.92, 3.42, 1.28), (0.70, 3.62, 1.18), (0.62, TND_CPL + 0.06, 1.16)], 0.12, 3), 0.035, Ms, 8)
    yh = -2.30
    lathe(g, "blackIron", [(0.30, zt1 - 0.01), (0.30, zt1 + 0.10), (0.32, zt1 + 0.11), (0.32, zt1 + 0.13), (0.28, zt1 + 0.135)], T(0, yh, 0), 24)
    lathe(g, "blackIron", [(0.34, zt1 + 0.13), (0.34, zt1 + 0.155), (0.24, zt1 + 0.185), (0.0, zt1 + 0.20)], T(0, yh, 0), 24)
    bbox(g, "blackIron", (0.16, 0.06, 0.06), center=(0, yh + 0.33, zt1 + 0.15), r=0.01)
    tube(g, "blackIron", [(-0.08, yh - 0.30, zt1 + 0.17), (-0.08, yh - 0.40, zt1 + 0.18), (0.08, yh - 0.40, zt1 + 0.18), (0.08, yh - 0.30, zt1 + 0.17)], 0.01, segs=5)
    # rivets, gold lettering and lining
    for s in (1, -1):
        Ms = side(s)
        y = -3.10
        while y < 3.0:
            for z in (zd + 0.05, zt1 - 0.05):
                rivet(g, "boilerGreen", Ms @ Vector((W, y, z)), (s, 0, 0), 0.011)
            y += 0.20
        text_on_side(g, "brass", ROAD + " R.R.", "oldstd", 0.17, s * (W + 0.004), -0.20, 1.97, s, width=5.0)
        x = W + 0.003
        ya0, ya1, za0, za1 = -3.12, 2.88, zd + 0.13, zt1 - 0.13
        for a, b in (((x, ya0, za0), (x, ya1, za0)), ((x, ya1, za0), (x, ya1, za1)), ((x, ya1, za1), (x, ya0, za1)), ((x, ya0, za1), (x, ya0, za0))):
            bar(g, "brass", Ms @ Vector(a), Ms @ Vector(b), 0.014, 0.006, up=(1, 0, 0))
    for x in [-0.96 + 0.192 * k for k in range(11)]:
        for z in (zd + 0.05, zt1 - 0.05):
            rivet(g, "boilerGreen", (x, -3.45, z), (0, -1, 0), 0.011)
    # steps, grab irons, rear ladder, couplers
    for s in (1, -1):
        for e in (1, -1):
            stirrup(g, W - 0.04, e * (hl - 0.30), zd - 0.33, s)
        grab_end(g, s * 1.10, -3.45, 2.05, -1, w=0.55, vertical=True)
        grab_end(g, s * 1.10, 3.05, 2.05, 1, w=0.55, vertical=True)
    for z in (1.62, 1.92, 2.22):
        grab_end(g, 0.0, -3.45, z, -1, w=0.40)
    drawhead(g, TND_CPL, 1)
    drawhead(g, -TND_CPL, -1, link=True)
    for ty in trucks:
        arch_truck(g, ty)
    mesh_object("tender_body", g, root)
    wheels = wheelsets("tender", root, [2.95, 1.45, -1.45, -2.95])
    car_meta(meta, "tender", TND_CPL, -TND_CPL, wheels, {"water_hatch": [0.0, yh, round(zt1 + 0.20, 3)]})
    return root


# ---------------------------------------------------------------------------------------------- freight cars
def freight_car(name, number, slatted, meta):
    root = empty(name)
    g = Geo()
    L2, W2, ends, cpl = 4.35, 1.33, 4.45, 4.70
    zb, ze, zr = FRAME_Z1, 3.28, 3.44
    trucks = (3.10, -3.10)
    car_underframe(g, ends, W2, trucks)
    box(g, "weatheredWood", (2 * W2 - 0.06, 2 * L2, 0.04), center=(0, 0, zb + 0.02), div=1.0)
    xf = W2 + 0.025
    posts = [L2 - 0.05, 3.25, 2.15, 1.02]
    panels = [(1.02, 2.15), (2.15, 3.25), (3.25, L2 - 0.05)]
    for s in (1, -1):
        Ms = side(s)
        if slatted:
            for e in (1, -1):
                for ya, yb in [(0.93, 1.02)] + panels:
                    z = zb + 0.06
                    while z + 0.10 < ze - 0.12:
                        box(g, "boxcarRed", (0.03, yb - ya, 0.10), Ms, center=(W2 - 0.015, e * (ya + yb) / 2, z + 0.05))
                        z += 0.175
        else:
            box(g, "boxcarRed", (0.03, 2 * L2, ze - zb), Ms, center=(W2 - 0.015, 0, (zb + ze) / 2), div=0.6, uvrot=True)
        for e in (1, -1):
            for y in posts:
                bbox(g, "boxcarRed", (0.05, 0.10, ze - zb), Ms, center=(xf, e * y, (zb + ze) / 2), r=0.008, uvrot=True)
            for ya, yb in panels:
                bar(g, "boxcarRed", Ms @ Vector((xf, e * (ya + 0.05), ze - 0.14)), Ms @ Vector((xf, e * (yb - 0.05), zb + 0.12)), 0.09, 0.045, up=(1, 0, 0))
            bbox(g, "boxcarRed", (0.04, L2 - 1.10, 0.20), Ms, center=(W2 + 0.07, e * (L2 + 1.10) / 2, 2.75), r=0.008)
        bbox(g, "boxcarRed", (0.05, 2 * L2, 0.12), Ms, center=(xf, 0, ze - 0.06), r=0.008)
        bbox(g, "boxcarRed", (0.05, 2 * L2, 0.10), Ms, center=(xf, 0, zb + 0.05), r=0.008)
        # sliding door with battens, track, guide, handle and hasp
        xd = W2 + 0.075
        if slatted:
            z = zb + 0.10
            while z + 0.10 < 3.02:
                box(g, "boxcarRed", (0.03, 1.86, 0.10), Ms, center=(xd, 0, z + 0.05))
                z += 0.175
            for y in (-0.88, 0.0, 0.88):
                box(g, "boxcarRed", (0.035, 0.10, 3.04 - zb - 0.06), Ms, center=(xd + 0.03, y, (zb + 0.06 + 3.04) / 2), uvrot=True)
        else:
            box(g, "boxcarRed", (0.035, 1.86, 3.04 - zb - 0.06), Ms, center=(xd, 0, (zb + 0.06 + 3.04) / 2), div=0.6, uvrot=True)
            for z in (zb + 0.16, 2.12, 2.94):
                box(g, "boxcarRed", (0.03, 1.86, 0.10), Ms, center=(xd + 0.03, 0, z))
            bar(g, "boxcarRed", Ms @ Vector((xd + 0.03, -0.86, zb + 0.20)), Ms @ Vector((xd + 0.03, 0.86, 2.90)), 0.09, 0.03, up=(1, 0, 0))
        bar(g, "blackIron", Ms @ Vector((xd + 0.01, -1.02, zb + 0.03)), Ms @ Vector((xd + 0.01, 2.80, zb + 0.03)), 0.06, 0.06)
        bar(g, "blackIron", Ms @ Vector((xd - 0.01, -1.02, 3.08)), Ms @ Vector((xd - 0.01, 2.80, 3.08)), 0.06, 0.08)
        grab_side(g, xd + 0.05, -0.80, 2.00, s, w=0.40, out=0.06, vertical=True)
        box(g, "blackIron", (0.03, 0.12, 0.05), Ms, center=(xd + 0.03, 0.96, 1.95))
        # lettering on the letter boards
        text_on_side(g, "whitePaint", ROAD_INIT, "oldstd", 0.13, s * (W2 + 0.094), -s * (L2 + 1.10) / 2, 2.75, s, width=2.6)
        text_on_side(g, "whitePaint", number, "oldstd", 0.15, s * (W2 + 0.094), s * (L2 + 1.10) / 2, 2.75, s, width=2.0)
        # corner stirrups and a grab-iron ladder at the brake end corner on this side
        for e in (1, -1):
            stirrup(g, W2 - 0.04, e * (ends - 0.32), FRAME_Z0 + 0.02, s)
        yl = -s * (L2 - 0.22)
        for z in (1.45, 1.85, 2.25, 2.65, 3.05):
            grab_side(g, xf + 0.025, yl, z, s, w=0.40)
    for e in (1, -1):
        gab = [(-W2, zb), (W2, zb), (W2, ze), (0.0, zr), (-W2, ze)]
        prism(g, "boxcarRed", gab, 0.0, 0.03, PXZ(e * L2 + (0.03 if e > 0 else 0.0)), uvrot=True, div=0.6)
        for x in (-W2 + 0.04, -0.45, 0.45, W2 - 0.04):
            bbox(g, "boxcarRed", (0.10, 0.05, ze - zb), center=(x, e * (L2 + 0.025), (zb + ze) / 2), r=0.008, uvrot=True)
        bbox(g, "boxcarRed", (2 * W2, 0.05, 0.10), center=(0, e * (L2 + 0.025), zb + 0.05), r=0.008)
        bbox(g, "boxcarRed", (2 * W2, 0.05, 0.10), center=(0, e * (L2 + 0.025), ze - 0.05), r=0.008)
        drawhead(g, e * cpl, e, link=(e < 0))
        for x in (-0.95, 0.95):
            grab_end(g, x, e * (L2 + 0.05), 1.55, e, w=0.40)
    for z in (1.45, 1.85, 2.25, 2.65, 3.05):
        grab_end(g, -0.80, -(L2 + 0.05), z, -1, w=0.38)
    # roof, fascia, running board and brake wheel (B end, -Y)
    rh = gable_roof(g, "boxcarRed", W2, L2 + 0.08, ze, zr)
    if slatted:
        gable_roof(g, "boxcarRed", W2 - 0.03, L2 - 0.01, ze - 0.045, zr - 0.045, t=0.01, overhang=0.0)
    for s in (1, -1):
        box(g, "boxcarRed", (0.03, 2 * L2 + 0.18, 0.10), side(s), center=(W2 + 0.095, 0, ze - 0.06))
    box(g, "greyWood", (0.50, 2 * L2 + 0.22, 0.04), center=(0, 0, zr + 0.07))
    for y in [-(L2) + 0.4 + k * ((2 * L2 - 0.8) / 7) for k in range(8)]:
        box(g, "greyWood", (0.55, 0.08, 0.06), center=(0, y, zr + 0.02))
    brake_wheel(g, (0.30, -(L2 + 0.09), zr + 0.22), 0.21, 1.00)
    box(g, "blackIron", (0.06, 0.08, 0.06), center=(0.30, -(L2 + 0.05), zr - 0.10))
    for ty in trucks:
        arch_truck(g, ty)
    mesh_object(name + "_body", g, root)
    wheels = wheelsets(name, root, [3.85, 2.35, -2.35, -3.85])
    car_meta(meta, name, cpl, -cpl, wheels)
    return root


def build_boxcar(meta):
    return freight_car("car_box", "No. 1206", False, meta)


def build_stockcar(meta):
    return freight_car("car_stock", "No. 418", True, meta)


# ---------------------------------------------------------------------------------------------- platform cars
def platform(g, y_body, y_end, W, e, railing_gap=0.42, steps=True, brake=True):
    """End platform from the body end (y_body) to the end sill (y_end), direction e, with railings, steps and brake."""
    zf = FRAME_Z1 + 0.04
    ya, yb = min(y_body, y_end), max(y_body, y_end)
    box(g, "weatheredWood", (2 * W - 0.10, yb - ya, 0.04), center=(0, (ya + yb) / 2, zf - 0.02), div=0.8)
    yr = y_end - e * 0.06
    zt = zf + 1.0
    for s in (1, -1):
        pts = [(s * railing_gap, yr, zf), (s * railing_gap, yr, zt), (s * (W - 0.10), yr, zt), (s * (W - 0.10), yr, zf)]
        tube(g, "blackIron", fillet(pts, 0.05, 2), 0.017, None, 6)
        tube(g, "blackIron", [(s * railing_gap, yr, zf + 0.5), (s * (W - 0.10), yr, zf + 0.5)], 0.012, None, 6)
        for k in range(1, 5):
            x = s * (railing_gap + (W - 0.10 - railing_gap) * k / 5)
            tube(g, "blackIron", [(x, yr, zf), (x, yr, zt)], 0.009, None, 5)
        tube(g, "blackIron", fillet([(s * (W - 0.10), yr, zt), (s * (W - 0.05), y_body + e * 0.22, zt), (s * (W - 0.03), y_body + e * 0.18, zf + 0.12)], 0.08, 3), 0.015, None, 6)
        if steps:
            ym = (ya + yb) / 2
            for k, z in enumerate((zf - 0.30, zf - 0.58, zf - 0.86)):
                box(g, "weatheredWood", (0.30, 0.46, 0.035), side(s), center=(W - 0.16 + 0.05 * k, ym, z))
            for dy in (-0.25, 0.25):
                bar(g, "blackIron", side(s) @ Vector((W - 0.16, ym + dy, zf - 0.02)), side(s) @ Vector((W - 0.04, ym + dy, zf - 0.90)), 0.04, 0.012, up=(0, 1, 0))
    if brake:
        brake_wheel(g, (0.82, yr - e * 0.12, zt + 0.12), 0.20, zf)


def build_coach(meta):
    root = empty("car_coach")
    g = Geo()
    L2, W2, ends, cpl = 6.90, 1.47, 7.55, 7.80
    zb, zbelt, zt_w, ze = FRAME_Z1, 2.06, 2.92, 3.30
    trucks = (5.55, -5.55)
    car_underframe(g, ends, W2, trucks, sill_mat="coachPaint")
    box(g, "weatheredWood", (2 * W2 - 0.06, 2 * L2, 0.04), center=(0, 0, zb + 0.02), div=1.2)
    n_win, pitch, ww = 13, 0.98, 0.56
    ys = [(k - (n_win - 1) / 2) * pitch for k in range(n_win)]
    x0, x1 = W2 - 0.03, W2
    for s in (1, -1):
        Ms = side(s)
        box(g, "coachPaint", (0.03, 2 * L2, zbelt - zb), Ms, center=(W2 - 0.015, 0, (zb + zbelt) / 2), div=0.6)
        box(g, "coachPaint", (0.03, 2 * L2, ze - zt_w), Ms, center=(W2 - 0.015, 0, (zt_w + ze) / 2), div=0.6)
        edges = [L2] + [v for y in reversed(ys) for v in (y + ww / 2, y - ww / 2)] + [-L2]
        for i in range(0, len(edges), 2):
            a, b = edges[i], edges[i + 1]
            box(g, "coachPaint", (0.03, a - b, zt_w - zbelt), Ms, center=(W2 - 0.015, (a + b) / 2, (zbelt + zt_w) / 2))
        for y in ys:
            arched_window(g, "woodVarnish", Ms, s, x0, x1, y + ww / 2, y - ww / 2, zbelt, zt_w, rise=0.09, n=6)
        bbox(g, "coachPaint", (0.07, 2 * L2 + 0.02, 0.06), Ms, center=(W2 + 0.01, 0, zbelt - 0.01), r=0.01)
        bbox(g, "coachPaint", (0.05, 2 * L2 + 0.02, 0.05), Ms, center=(W2 + 0.01, 0, zt_w + 0.01), r=0.01)
        bbox(g, "coachPaint", (0.10, 2 * L2 + 0.06, 0.07), Ms, center=(W2 + 0.02, 0, ze - 0.02), r=0.012)
        for k in range(7):
            yc = (k - 3) * 1.96
            panel_moulding(g, "coachPaint", Ms, W2 + 0.006, yc - 0.85, yc + 0.85, zb + 0.14, zbelt - 0.12, w=0.03, t=0.012)
        text_on_side(g, "brass", ROAD, "oldstd", 0.19, s * (W2 + 0.005), 0.0, (zt_w + ze) / 2 + 0.01, s, width=7.5)
        for e in (1, -1):
            text_on_side(g, "brass", "No. 3", "oldstd", 0.13, s * (W2 + 0.005), e * (L2 - 0.55) * s, (zt_w + ze) / 2 + 0.01, s, width=0.7)
    # lower roof (curved deck), clerestory with deck lights, upper roof and duck-bill hoods
    def lower_z(x):
        u = max(0.0, (abs(x) - 0.72) / 0.82)
        return 3.66 - 0.36 * u ** 1.6
    xs = [-(0.72 + 0.82 * (1 - k / 10)) for k in range(11)]
    prof = [(x, lower_z(x) + 0.04) for x in xs] + [(-x, lower_z(-x) + 0.04) for x in reversed(xs)]
    for side_pts in (prof[:11], prof[11:]):
        pts = side_pts + [(x, z - 0.04) for x, z in reversed(side_pts)]
        prism(g, "roofCanvas", pts, 0.0, 2 * (ends - 0.02), PXZ(ends - 0.02), div=0.5)
    for s in (1, -1):
        Ms = side(s)
        box(g, "coachPaint", (0.03, 2 * L2, 0.34), Ms, center=(0.715, 0, 3.80), div=0.8)
        for y in ys:
            for dz in (-0.105, 0.105):
                box(g, "woodVarnish", (0.02, 0.36, 0.03), Ms, center=(0.74, y, 3.80 + dz))
            for dy in (-0.165, 0.165):
                box(g, "woodVarnish", (0.02, 0.03, 0.24), Ms, center=(0.74, y + dy, 3.80))
            pane_x(g, s * 0.7305, y - 0.15, y + 0.15, 3.71, 3.89, s)
    Ru, hu = 0.86, 0.18
    Rr = (Ru ** 2 + hu ** 2) / (2 * hu)
    czr = 3.98 + hu - Rr
    ha = math.asin(Ru / Rr)
    up = [((Rr + 0.035) * math.cos(math.pi / 2 - ha + 2 * ha * k / 16), czr + (Rr + 0.035) * math.sin(math.pi / 2 - ha + 2 * ha * k / 16)) for k in range(17)]
    up += [(Rr * math.cos(math.pi / 2 + ha - 2 * ha * k / 16), czr + Rr * math.sin(math.pi / 2 + ha - 2 * ha * k / 16)) for k in range(17)]
    prism(g, "roofCanvas", up, 0.0, 2 * L2, PXZ(L2), div=0.7)
    for e in (1, -1):
        secA, secB = [], []
        n = 16
        for k in range(n + 1):
            a = math.pi / 2 + ha - 2 * ha * k / n
            secA.append(((Rr + 0.035) * math.cos(a), e * L2, czr + (Rr + 0.035) * math.sin(a)))
            xb = -1.02 + 2.04 * k / n
            secB.append((xb, e * (ends - 0.02), lower_z(xb) + 0.06 + 0.10 * (1 - (xb / 1.02) ** 2)))
        secA = [(-0.735, e * L2, 3.62)] + secA + [(0.735, e * L2, 3.62)]
        secB = [(-1.06, e * (ends - 0.02), lower_z(-1.06) + 0.01)] + secB + [(1.06, e * (ends - 0.02), lower_z(1.06) + 0.01)]
        rings = [secA, secB] if e > 0 else [secB, secA]
        loft(g, "roofCanvas", rings, closed=False)
    lathe(g, "blackIron", [(0.075, 3.30), (0.075, 4.35), (0.13, 4.36), (0.13, 4.42), (0.0, 4.46)], T(1.0, 5.6, 0), 12)
    # body ends with door and windows, platforms, couplers
    for e in (1, -1):
        y = e * L2
        prism(g, "coachPaint", [(-W2, zb), (W2, zb), (W2, ze), (-W2, ze)], 0.0, 0.03, PXZ(y + (0.03 if e > 0 else 0.0)), uvrot=False, div=0.6)
        yd = y + e * 0.035
        bbox(g, "woodVarnish", (0.80, 0.03, 2.02), center=(0, yd, zb + 0.04 + 1.01), r=0.01)
        pane_y(g, yd + e * 0.017, -0.26, 0.26, 2.10, 2.75, e)
        for sx in (-1, 1):
            box(g, "woodVarnish", (0.50, 0.03, 0.72), center=(sx * 0.92, yd, 2.47))
            pane_y(g, yd + e * 0.017, sx * 0.92 - 0.21, sx * 0.92 + 0.21, 2.14, 2.80, e)
        platform(g, y, e * ends, W2, e)
        drawhead(g, e * cpl, e, link=(e < 0))
    for ty in trucks:
        arch_truck(g, ty, wb=1.70)
    mesh_object("car_coach_body", g, root)
    wheels = wheelsets("car_coach", root, [6.40, 4.70, -4.70, -6.40])
    car_meta(meta, "car_coach", cpl, -cpl, wheels)
    return root


def build_caboose(meta):
    root = empty("car_caboose")
    g = Geo()
    L2, W2, ends, cpl = 3.10, 1.33, 3.95, 4.20
    zb, ze, zr = FRAME_Z1, 3.24, 3.38
    trucks = (2.40, -2.40)
    car_underframe(g, ends, W2, trucks)
    box(g, "weatheredWood", (2 * W2 - 0.06, 2 * L2, 0.04), center=(0, 0, zb + 0.02))
    xf = W2 + 0.02
    win = [(2.05, 1.40), (-1.40, -2.05)]
    zs, zt = 2.18, 2.98
    for s in (1, -1):
        Ms = side(s)
        box(g, "boxcarRed", (0.03, 2 * L2, zs - zb), Ms, center=(W2 - 0.015, 0, (zb + zs) / 2), div=0.6, uvrot=True)
        box(g, "boxcarRed", (0.03, 2 * L2, ze - zt), Ms, center=(W2 - 0.015, 0, (zt + ze) / 2), div=0.6, uvrot=True)
        for a, b in ((L2, win[0][0]), (win[0][1], win[1][0]), (win[1][1], -L2)):
            box(g, "boxcarRed", (0.03, a - b, zt - zs), Ms, center=(W2 - 0.015, (a + b) / 2, (zs + zt) / 2), div=0.6, uvrot=True)
        for a, b in win:
            arched_window(g, "woodVarnish", Ms, s, W2 - 0.03, W2, a, b, zs, zt, rise=0.07)
            bbox(g, "boxcarRed", (0.06, a - b + 0.10, 0.05), Ms, center=(W2 + 0.01, (a + b) / 2, zs - 0.02), r=0.008)
        for y in (L2 - 0.05, 0.62, -0.62, -(L2 - 0.05)):
            bbox(g, "boxcarRed", (0.04, 0.10, ze - zb), Ms, center=(xf, y, (zb + ze) / 2), r=0.008, uvrot=True)
        bbox(g, "boxcarRed", (0.04, 2 * L2, 0.10), Ms, center=(xf, 0, zb + 0.05), r=0.008)
        bbox(g, "boxcarRed", (0.04, 2 * L2, 0.12), Ms, center=(xf, 0, ze - 0.06), r=0.008)
        text_on_side(g, "whitePaint", ROAD_INIT, "oldstd", 0.14, s * (W2 + 0.004), 0.0, 2.80, s, width=1.10)
        text_on_side(g, "whitePaint", "No. 9", "oldstd", 0.16, s * (W2 + 0.004), 0.0, 2.45, s, width=1.0)
    # roof, cupola, running boards, smokejack
    gable_roof(g, "boxcarRed", W2, L2 + 0.30, ze, zr)
    for s in (1, -1):
        box(g, "boxcarRed", (0.03, 2 * L2 + 0.60, 0.10), side(s), center=(W2 + 0.095, 0, ze - 0.06))
    cw, cl, cz0, cz1 = 0.80, 0.80, 3.30, 4.02
    for s in (1, -1):
        Ms = side(s)
        box(g, "boxcarRed", (0.03, 2 * cl, 0.15), Ms, center=(cw - 0.015, 0, cz0 + 0.075), uvrot=True)
        box(g, "boxcarRed", (0.03, 2 * cl, cz1 - 3.86), Ms, center=(cw - 0.015, 0, (3.86 + cz1) / 2), uvrot=True)
        for a, b in ((cl, 0.44), (0.05, -0.05), (-0.44, -cl)):
            box(g, "boxcarRed", (0.03, a - b, 3.86 - 3.45), Ms, center=(cw - 0.015, (a + b) / 2, (3.45 + 3.86) / 2), uvrot=True)
        for a, b in ((0.44, 0.05), (-0.05, -0.44)):
            arched_window(g, "woodVarnish", Ms, s, cw - 0.03, cw, a, b, 3.45, 3.86, rise=0.05, sash=False)
    for e in (1, -1):
        y = e * cl
        prism(g, "boxcarRed", [(-cw, cz0), (cw, cz0), (cw, cz1), (-cw, cz1)], 0.0, 0.03, PXZ(y + (0.03 if e > 0 else 0.0)), uvrot=True)
        box(g, "woodVarnish", (0.62, 0.03, 0.44), center=(0, y + e * 0.03, 3.66))
        pane_y(g, y + e * 0.047, -0.28, 0.28, 3.47, 3.85, e)
    gable_roof(g, "boxcarRed", cw, cl + 0.15, cz1, cz1 + 0.12, overhang=0.10)
    for e in (1, -1):
        box(g, "greyWood", (0.46, L2 + 0.20 - cl, 0.04), center=(0, e * (L2 + 0.20 + cl) / 2, zr + 0.07))
    lathe(g, "blackIron", [(0.06, 3.28), (0.06, 3.98), (0.12, 3.99), (0.12, 4.05), (0.0, 4.10)], T(-0.62, -1.70, 0), 12)
    # end walls with doors and windows, ladders to the roof, platforms, marker lamp brackets, couplers
    for e in (1, -1):
        y = e * L2
        gab = [(-W2, zb), (W2, zb), (W2, ze), (0.0, zr), (-W2, ze)]
        prism(g, "boxcarRed", gab, 0.0, 0.03, PXZ(y + (0.03 if e > 0 else 0.0)), uvrot=True, div=0.6)
        yd = y + e * 0.035
        bbox(g, "woodVarnish", (0.78, 0.03, 2.0), center=(0, yd, zb + 0.04 + 1.0), r=0.01)
        pane_y(g, yd + e * 0.017, -0.25, 0.25, 2.15, 2.75, e)
        box(g, "woodVarnish", (0.46, 0.03, 0.60), center=(-0.85, yd, 2.47))
        pane_y(g, yd + e * 0.017, -1.04, -0.66, 2.20, 2.74, e)
        for z in [1.40 + 0.33 * k for k in range(6)]:
            grab_end(g, 0.90, y + e * 0.03, z, e, w=0.36, out=0.08)
        platform(g, y, e * ends, W2, e)
        for sx in (-1, 1):
            box(g, "blackIron", (0.14, 0.14, 0.20), center=(sx * (W2 - 0.05), e * (L2 + 0.10), 3.0))
        drawhead(g, e * cpl, e, link=(e < 0))
    for ty in trucks:
        arch_truck(g, ty)
    mesh_object("car_caboose_body", g, root)
    wheels = wheelsets("car_caboose", root, [3.15, 1.65, -1.65, -3.15])
    car_meta(meta, "car_caboose", cpl, -cpl, wheels, {"marker_lamps": [[sx * (W2 - 0.05), -(L2 + 0.10), 3.0] for sx in (-1, 1)]})
    return root


# ---------------------------------------------------------------------------------------------- water tower, telegraph pole
def build_water_tower(meta):
    root = empty("water_tower")
    g = Geo()
    Rt, zb, zt = 2.95, 5.65, 9.85
    # footings, battered trestle posts, girts and cross braces
    posts = []
    for k in range(8):
        a = TAU * k / 8 + TAU / 16
        b, t = Vector((2.52 * math.cos(a), 2.52 * math.sin(a), 0.30)), Vector((2.30 * math.cos(a), 2.30 * math.sin(a), 5.0))
        posts.append((b, t))
        box(g, "greyWood", (0.62, 0.62, 0.30), T(b.x, b.y, 0.15) @ Matrix.Rotation(a, 4, "Z"))
        bar(g, "greyWood", b, t, 0.30, 0.30, up=(math.cos(a), math.sin(a), 0), r=0.01)
    box(g, "greyWood", (0.62, 0.62, 0.30), center=(0, 0, 0.15))
    box(g, "greyWood", (0.30, 0.30, 4.70), center=(0, 0, 2.65), uvrot=True)

    def on_post(i, z):
        b, t = posts[i % 8]
        return b.lerp(t, (z - b.z) / (t.z - b.z))

    for i in range(8):
        am = TAU * (i + 1) / 8
        rad = (math.cos(am), math.sin(am), 0)
        for z in (0.55, 2.75, 4.85):
            bar(g, "greyWood", on_post(i, z) + Vector(rad) * 0.16, on_post(i + 1, z) + Vector(rad) * 0.16, 0.10, 0.20, r=0.006)
        for z0, z1 in ((0.65, 2.65), (2.85, 4.75)):
            bar(g, "greyWood", on_post(i, z0) + Vector(rad) * 0.24, on_post(i + 1, z1) + Vector(rad) * 0.24, 0.18, 0.05, up=rad)
            bar(g, "greyWood", on_post(i, z1) + Vector(rad) * 0.29, on_post(i + 1, z0) + Vector(rad) * 0.29, 0.18, 0.05, up=rad)
    # cap beams, joists and the round deck
    for x in (-1.6, 0.0, 1.6):
        box(g, "greyWood", (0.30, 5.6, 0.34), center=(x, 0, 5.17))
    for k in range(-4, 5):
        box(g, "greyWood", (5.9, 0.14, 0.24), center=(0, k * 0.62, 5.46))
    xk = -3.25
    while xk < 3.25:
        half = math.sqrt(max(3.30 ** 2 - (xk + 0.125) ** 2, 0.04))
        box(g, "weatheredWood", (0.24, 2 * half, 0.05), center=(xk + 0.125, 0, 5.62))
        xk += 0.25
    # stave tank, iron hoops with lugs
    n = 72
    for k in range(n):
        a = TAU * (k + 0.5) / n
        w = 2 * Rt * math.sin(math.pi / n) - 0.004
        M = frame((Rt * math.cos(a) * math.cos(math.pi / n) - 0.04 * math.cos(a), Rt * math.sin(a) * math.cos(math.pi / n) - 0.04 * math.sin(a), (zb + zt) / 2 + 0.03),
                  (0, 0, 1), (math.sin(a), -math.cos(a), 0))
        box(g, "weatheredWood", (w, 0.08, zt - zb + 0.06), M, div=0.7, skip=("-y", "-z", "+z"))
    hoops = [0.18, 0.52, 0.88, 1.27, 1.70, 2.17, 2.70, 3.30, 3.95]
    for i, h in enumerate(hoops):
        z = zb + h
        tube(g, "blackIron", [(Rt + 0.008) * Vector((math.cos(TAU * k / 40), math.sin(TAU * k / 40), 0)) + Vector((0, 0, z)) for k in range(41)], 0.013, segs=4)
        for d in (0.0, math.pi):
            a = d + 0.7 * i
            bbox(g, "blackIron", (0.05, 0.16, 0.06), frame((Rt + 0.03) * Vector((math.cos(a), math.sin(a), 0)) + Vector((0, 0, z)), (0, 0, 1), (math.cos(a), math.sin(a), 0)), r=0.008)
    # conical board roof, soffit, finial, hatch
    Rr, apex = 3.30, zt + 3.30 * math.tan(math.radians(32))
    prof = [(Rt - 0.05, zt - 0.02), (Rr, zt - 0.02), (Rr, zt + 0.05)] + [(Rr * (1 - k / 6), zt + 0.05 + (apex - zt - 0.05) * k / 6) for k in range(1, 6)] + [(0.0, apex)]
    lathe(g, "weatheredWood", prof, None, 48)
    lathe(g, "blackIron", [(0.0, apex - 0.05), (0.07, apex - 0.02), (0.05, apex + 0.25), (0.11, apex + 0.32), (0.11, apex + 0.40), (0.0, apex + 0.47)], None, 12)
    nh = Vector((0, -math.sin(math.radians(32)), math.cos(math.radians(32))))
    zs_ = zt + 0.05 + (apex - zt - 0.05) * (1 - 1.95 / Rr)
    bbox(g, "weatheredWood", (0.62, 0.70, 0.16), frame(Vector((0, -1.95, zs_)) + nh * 0.05, nh, (1, 0, 0)), r=0.01)
    # spout (raised at rest), hinge, counterweight chain and valve rope, on the +X side
    piv = Vector((Rt + 0.18, 0.0, zb + 0.55))
    box(g, "blackIron", (0.30, 0.46, 0.46), center=(Rt + 0.05, 0, zb + 0.55))
    pitch = math.radians(62)
    d = Vector((math.cos(pitch), 0, math.sin(pitch)))
    Ls = 3.6
    Ms = frame(piv + d * (Ls / 2), d, (0, 1, 0))
    box(g, "greyWood", (0.36, 0.36, Ls), Ms, div=0.9)
    for k in range(6):
        box(g, "blackIron", (0.38, 0.38, 0.05), frame(piv + d * (0.3 + k * 0.62), d, (0, 1, 0)))
    tip = piv + d * Ls
    tube(g, "blackIron", [tip, Vector((Rt + 0.30, 0, zt + 0.15))], 0.01, segs=4)
    box(g, "blackIron", (0.20, 0.20, 0.30), center=(Rt + 0.25, 0.25, zt - 0.9))
    tube(g, "blackIron", [(Rt + 0.30, 0, zt + 0.15), (Rt + 0.25, 0.25, zt - 0.75)], 0.008, segs=4)
    tube(g, "roofCanvas", [tip + Vector((0, 0.15, -0.1)), Vector((tip.x + 0.4, 0.2, 2.4)), Vector((tip.x + 0.45, 0.2, 1.2))], 0.008, segs=4)
    # float gauge board with pointer, facing the track (+X)
    a = math.radians(-12)
    gx, gy = (Rt + 0.07) * math.cos(a), (Rt + 0.07) * math.sin(a)
    box(g, "greyWood", (0.04, 0.22, zt - zb - 0.4), frame((gx, gy, (zb + zt) / 2), (0, 0, 1), (math.cos(a), math.sin(a), 0)), uvrot=True)
    box(g, "blackIron", (0.06, 0.34, 0.12), frame((gx + 0.04 * math.cos(a), gy + 0.04 * math.sin(a), zb + 2.9), (0, 0, 1), (math.cos(a), math.sin(a), 0)))
    # wooden ladders: ground to deck, deck to eaves (-Y side)
    for z0, z1, r0, lean in ((0.0, 5.60, 3.10, 0.55), (5.66, zt - 0.05, Rt + 0.10, 0.03)):
        for sx in (-0.24, 0.24):
            bar(g, "greyWood", (sx, -r0 - lean, z0), (sx, -r0, z1), 0.06, 0.10, up=(0, 1, 0))
        z = z0 + 0.30
        while z < z1 - 0.1:
            t = (z - z0) / (z1 - z0)
            yy = -r0 - lean * (1 - t)
            tube(g, "greyWood", [(-0.24, yy, z), (0.24, yy, z)], 0.022, segs=6)
            z += 0.32
    mesh_object("water_tower_body", g, root)
    meta["water_tower"] = {
        "origin": "base centre at ground level; spout on the +X side; place the track centre line along Y at x ~ +4.6",
        "spout_lowering": "rotate the spout about the pivot (axis Y) down from the rest pitch; tip = pivot + length*(cos p, 0, sin p); a tender hatch h above the tower base needs p = asin((h - pivot_z) / length), about -66 deg for h = 2.9",
        "height": round(apex + 0.47, 3), "tank_radius": Rt, "tank_bottom": zb, "tank_top": zt, "footprint_radius": 2.85,
        "spout_pivot": [round(piv.x, 3), 0.0, round(piv.z, 3)], "spout_length": Ls, "spout_rest_pitch_deg": 62,
        "spout_tip_rest": [round(tip.x, 3), 0.0, round(tip.z, 3)],
    }
    return root


def build_pole(meta):
    root = empty("telegraph_pole")
    g = Geo()
    H = 7.6
    rng = random.Random(77)
    rings = []
    n = 12
    for i in range(11):
        t = i / 10
        z = H * t
        r = 0.135 - 0.04 * t
        cx, cy = 0.035 * math.sin(t * math.pi) * 0.8, 0.02 * math.sin(t * 2.2)
        ring = []
        for k in range(n):
            a = TAU * k / n
            rr = r * (1 + 0.035 * math.sin(3 * a + i) + rng.uniform(-0.01, 0.01))
            ring.append((cx + rr * math.sin(a), cy - rr * math.cos(a), z))
        rings.append(ring)
    top = rings[-1]
    loft(g, "greyWood", [[(p[0], p[1], p[2]) for p in r] for r in rings], uvrot=True)
    c = sum((Vector(p) for p in top), Vector()) / n
    g.add([tuple(p) for p in top] + [tuple(c + Vector((0, 0, 0.06)))], [(k, (k + 1) % n, n) for k in range(n)], [[(0, 0), (0.1, 0), (0.05, 0.1)]] * n, "greyWood", None)
    za = H - 0.40
    box(g, "greyWood", (2.40, 0.095, 0.12), center=(0.03, 0.13, za), uvrot=False)
    for sx in (-1, 1):
        bar(g, "blackIron", (sx * 0.62, 0.10, za - 0.06), (0.02, 0.10, za - 0.78), 0.035, 0.006, up=(0, 1, 0))
    lathe(g, "blackIron", [(0.0, -0.02), (0.02, -0.02), (0.02, 0.24), (0.0, 0.24)], AXY(0.03, 0.0, za), 6)
    ins = []
    for x in (-1.05, -0.35, 0.35, 1.05):
        xi = x + 0.03
        lathe(g, "greyWood", [(0.022, za + 0.06), (0.018, za + 0.17), (0.0, za + 0.175)], T(xi, 0.13, 0), 8)
        prof = [(0.0, za + 0.105), (0.045, za + 0.10), (0.05, za + 0.12), (0.036, za + 0.135), (0.036, za + 0.15),
                (0.043, za + 0.158), (0.04, za + 0.19), (0.026, za + 0.21), (0.0, za + 0.215)]
        lathe(g, "insulator", prof, T(xi, 0.13, 0), 12)
        ins.append([round(xi, 3), 0.13, round(za + 0.145, 3)])
    mesh_object("telegraph_pole_body", g, root)
    meta["telegraph_pole"] = {"origin": "base at ground level; crossarm along X, wires run along Y",
                              "height": round(H + 0.06, 3), "crossarm_top": round(za + 0.06, 3), "insulator_wire_points": ins}
    return root


# ---------------------------------------------------------------------------------------------- scene, bake, preview
def use_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "HIP"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "HIP"
        scene.cycles.device = "GPU"
    except Exception as exc:  # CPU fallback
        print("GPU unavailable:", exc)
        scene.cycles.device = "CPU"


def descendants(ob):
    out = [ob]
    for c in ob.children:
        out += descendants(c)
    return out


def grime_factor(z, kind):
    """Darkening multiplied into the AO: road grime low down, soot on the stack and smokebox."""
    lo = 1.0 - 0.28 * max(0.0, min(1.0, (1.25 - z) / 1.0))
    return lo


def finish_colour(ob, ao_ok, soot=None):
    me = ob.data
    attr = me.color_attributes.get("AO")
    if attr is None:
        attr = me.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
    me.color_attributes.active_color = attr
    mw = ob.matrix_world
    loops = me.loops
    vals = [0.0] * (len(attr.data) * 4)
    attr.data.foreach_get("color", vals)
    pos = [mw @ v.co for v in me.vertices]
    out = []
    for li, lp in enumerate(loops):
        ao = vals[li * 4] if ao_ok else 1.0
        ao = 0.22 + 0.78 * max(0.0, min(1.0, ao)) ** 0.85
        p = pos[lp.vertex_index]
        f = ao * grime_factor(p.z, None)
        if soot is not None:
            f *= soot(p)
        f = max(0.05, min(1.0, f))
        out += [f, f, f, 1.0]
    attr.data.foreach_set("color", out)


def loco_soot(shift):
    def fn(p):
        y = p.y + shift
        f = 1.0
        if p.z > 3.5 and abs(y - Y_STACK) < 0.7:
            f *= 1.0 - 0.62 * min(1.0, (p.z - 3.5) / 1.0) ** 1.5
        if y > Y_SB0 - 0.05 and p.z > 1.6 and abs(p.x) < 0.75 and y < Y_SB1 + 0.2:
            f *= 0.86
        return f
    return fn


def bake_ao(jobs, samples):
    """jobs: list of (targets, occluders). Bakes Cycles AO into each target's corner colour attribute 'AO'."""
    scene = bpy.context.scene
    use_gpu(scene)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.bake.target = "VERTEX_COLORS"
    world = bpy.data.worlds.new("bake_world")
    world.light_settings.distance = 0.9
    scene.world = world
    meshes = [o for o in scene.objects if o.type == "MESH"]
    for targets, occluders in jobs:
        vis = set(occluders) | set(targets)
        for o in meshes:
            o.hide_render = o not in vis
        for ob in targets:
            me = ob.data
            attr = me.color_attributes.get("AO") or me.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
            me.color_attributes.active_color = attr
            bpy.ops.object.select_all(action="DESELECT")
            bpy.context.view_layer.objects.active = ob
            ob.select_set(True)
            bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
    for o in meshes:
        o.hide_render = False
    scene.world = None
    bpy.data.worlds.remove(world)


def bake_ground():
    g = Geo()
    box(g, "blackIron", (8.0, 40.0, 0.1), center=(0, 0, -0.23))
    return mesh_object("bake_ground", g)


def make_track_and_ground(y0=-140.0, y1=60.0):
    """Preview-only ground, ballast, ties and rails (not exported)."""
    objs = []
    gmat = bpy.data.materials.new("previewGround")
    gmat.use_nodes = True
    nt = gmat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    for tid, scale, target in (("red_sand", 0.30, gmat),):
        img = nt.nodes.new("ShaderNodeTexImage")
        img.image = load_image(tex_path(tid, "diffuse"), True)
        nor = nt.nodes.new("ShaderNodeTexImage")
        nor.image = load_image(tex_path(tid, "nor_gl"), False)
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (scale, scale, scale)
        nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
        nt.links.new(mp.outputs[0], img.inputs["Vector"])
        nt.links.new(mp.outputs[0], nor.inputs["Vector"])
        nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
        bsdf.inputs["Roughness"].default_value = 0.95
    me = bpy.data.meshes.new("preview_ground")
    S = 400.0
    me.from_pydata([(-S, -S, -0.36), (S, -S, -0.36), (S, S, -0.36), (-S, S, -0.36)], [], [(0, 1, 2, 3)])
    me.materials.append(gmat)
    ob = bpy.data.objects.new("preview_ground", me)
    bpy.context.scene.collection.objects.link(ob)
    objs.append(ob)
    bmat = bpy.data.materials.new("previewBallast")
    bmat.use_nodes = True
    nt = bmat.node_tree
    bsdf = nt.nodes["Principled BSDF"]
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = load_image(tex_path("gravelly_sand", "diffuse"), True)
    nor = nt.nodes.new("ShaderNodeTexImage")
    nor.image = load_image(tex_path("gravelly_sand", "nor_gl"), False)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (0.8, 0.8, 0.8)
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], img.inputs["Vector"])
    nt.links.new(mp.outputs[0], nor.inputs["Vector"])
    nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
    nm = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nor.outputs["Color"], nm.inputs["Color"])
    nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])
    g = Geo()
    prism(g, "blackIron", [(-2.6, -0.361), (2.6, -0.361), (1.55, -0.19), (-1.55, -0.19)], 0.0, y1 - y0, PXZ(y1))
    ob = mesh_object("preview_ballast", g)
    ob.data.materials.clear()
    ob.data.materials.append(bmat)
    objs.append(ob)
    g = Geo()
    y = y0
    rng = random.Random(7)
    while y < y1:
        box(g, "weatheredWood", (2.6, 0.22, 0.15), T(rng.uniform(-0.04, 0.04), y, -0.225) @ Matrix.Rotation(rng.uniform(-0.015, 0.015), 4, "Z"), uvrot=True)
        y += 0.60
    objs.append(mesh_object("preview_ties", g))
    rail = [(-0.065, -0.15), (0.065, -0.15), (0.065, -0.14), (0.012, -0.125), (0.010, -0.045), (0.032, -0.038),
            (0.034, -0.008), (0.028, 0.0), (-0.028, 0.0), (-0.034, -0.008), (-0.032, -0.038), (-0.010, -0.045),
            (-0.012, -0.125), (-0.065, -0.14)]
    g = Geo()
    for s in (1, -1):
        prism(g, "steel", [(x + s * 0.7515, z) for x, z in rail], 0.0, y1 - y0, PXZ(y1))
    objs.append(mesh_object("preview_rails", g))
    return objs


def aim_sun(sun, sky, sun_az, sun_elev):
    az, el = math.radians(sun_az), math.radians(sun_elev)
    to_sun = Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))
    sun.rotation_euler = (-to_sun).to_track_quat("-Z", "Y").to_euler()
    sky.sun_elevation = el
    sky.sun_rotation = math.radians(90.0 - sun_az)


def preview_world(sun_elev=13.0, sun_az=-130.0, strength=1.0):
    """Low golden sun (lamp) and a physical sky without its sun disc. sun_az: compass angle of the sun seen
    from the origin, measured from +Y towards +X (so -130 = behind-left of a camera looking forward)."""
    scene = bpy.context.scene
    world = bpy.data.worlds.new("frontier_sky")
    world.use_nodes = True
    nt = world.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    sky = nt.nodes.new("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_disc = False
    sky.sun_elevation = math.radians(sun_elev)
    sky.sun_rotation = math.radians(-sun_az + 90.0)
    try:
        sky.aerosol_density = 2.0
    except Exception:
        pass
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = float(opt("--sky", 0.05)) * strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(sky.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])
    scene.world = world
    ld = bpy.data.lights.new("preview_sun", "SUN")
    ld.energy = float(opt("--sun", 5.0)) * strength
    ld.angle = math.radians(0.55)
    ld.color = (1.0, 0.72, 0.45)
    sun = bpy.data.objects.new("preview_sun", ld)
    scene.collection.objects.link(sun)
    aim_sun(sun, sky, sun_az, sun_elev)
    return sun, sky


def render_view(path, cam_loc, target, lens, samples, scale, res=(1600, 900)):
    scene = bpy.context.scene
    use_gpu(scene)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.render.resolution_x, scene.render.resolution_y = res
    scene.render.resolution_percentage = int(scale * 100)
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 0.0
    cam = scene.camera
    if cam is None:
        cd = bpy.data.cameras.new("preview_cam")
        cam = bpy.data.objects.new("preview_cam", cd)
        scene.collection.objects.link(cam)
        scene.camera = cam
    cam.data.lens = lens
    cam.data.clip_start = 0.05
    cam.data.clip_end = 2000.0
    cam.location = cam_loc
    cam.rotation_euler = (Vector(target) - Vector(cam_loc)).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


# ---------------------------------------------------------------------------------------------- main
def tri_count(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons) if ob.type == "MESH" else 0


BUILDERS = [("loco", build_loco), ("tender", build_tender), ("car_box", build_boxcar), ("car_stock", build_stockcar),
            ("car_coach", build_coach), ("car_caboose", build_caboose), ("water_tower", build_water_tower),
            ("telegraph_pole", build_pole)]
TRAIN = ["loco", "tender", "car_box", "car_stock", "car_coach", "car_caboose"]


def main():
    common.reset_scene()
    build_materials()
    meta = {}
    only = opt("--only")
    only = str(only).split(",") if only else None
    roots = {}
    for name, fn in BUILDERS:
        if only and name not in only:
            continue
        roots[name] = fn(meta)
    quick = bool(opt("--quick"))
    shift = meta.get("shift", 0.0)
    bpy.context.view_layer.update()
    if not quick:
        ground = bake_ground()
        jobs = []
        for name, root in roots.items():
            meshes = [o for o in descendants(root) if o.type == "MESH"]
            bodies = [o for o in meshes if o.parent == root]
            jobs.append((bodies, meshes + [ground]))
            for p in meshes:
                if p not in bodies:
                    jobs.append(([p], [p]))
        bake_ao(jobs, int(opt("--bake-samples", 96)))
        bpy.data.objects.remove(ground)
    bpy.context.view_layer.update()
    for name, root in roots.items():
        for o in descendants(root):
            if o.type == "MESH":
                finish_colour(o, not quick, loco_soot(shift) if name == "loco" and o.parent == root else None)
    objs = list(bpy.context.scene.objects)
    total = sum(tri_count(o) for o in objs)
    tris = {name: sum(tri_count(o) for o in descendants(root)) for name, root in roots.items()}
    print("TRIS", tris, {o.name: tri_count(o) for o in objs if o.type == "MESH"})
    if not opt("--no-export"):
        common.export_glb(objs, EXPORT, vertex_colors=True)
        meta.pop("shift", None)
        out = {
            "generator": "assets/blender/scripts/frontier_train.py",
            "license": "Original work for Prismfall; textures Poly Haven CC0 (see materials)",
            "units": "metres",
            "frame": ("per vehicle: origin on the track centre line at rail top, midway between the coupler faces; Blender +X right "
                      "(side R), +Y forward, +Z up. glTF/three.js: x = X, y = Z, z = -Y (forward is -z)."),
            "hierarchy": ("each vehicle and kit item is a top-level empty at the world origin; static parts are one mesh <name>_body; "
                          "animated parts are empties (pivot) with the mesh child <name>_mesh"),
            "train_order": TRAIN,
        }
        out.update(meta)
        out["materials"] = {k: ({"texture": f"polyhaven/{v['tex']}", "texture_size_m": round(MAT_SIZE[k], 4)} if v.get("tex") else {"flat": True}) for k, v in MAT_DEFS.items()}
        out["triangles"] = {"total": total, **tris, "objects": {o.name: tri_count(o) for o in objs if o.type == "MESH"}}
        common.write_metadata(META, out)
        common.save_blend(BLEND)
    if not opt("--no-preview"):
        # lay the train out along the track, the water tower and a pole beside it
        y = 0.0
        prev = None
        for name in TRAIN:
            if name not in roots:
                continue
            v = meta["vehicles"][name]
            if prev is not None:
                y = y + prev["rear_coupler_y"] - v["front_coupler_y"]
            roots[name].location = (0.0, y, 0.0)
            prev = v
        if "water_tower" in roots:
            roots["water_tower"].location = (float(opt("--tower-x", 7.6)), 26.0, -0.36)
            roots["water_tower"].rotation_euler = (0.0, 0.0, math.pi)
        if "telegraph_pole" in roots:
            roots["telegraph_pole"].location = (-3.8, 9.0, -0.36)
        make_track_and_ground()
        sun, sky = preview_world()
        views = (opt("--views") or "loco34,side,gear,headlight,train,tower").split(",")
        samples = int(opt("--samples", 160))
        scale = float(opt("--scale", 1.0))
        cams = {
            "loco34": ((-8.6, 8.4, 3.0), (0, 0.2, 2.0), 40, -78),
            "side": ((-17.5, -0.2, 2.1), (0, -0.2, 2.1), 50, -115),
            "gear": ((-3.4, 2.6, 1.05), (-0.9, -0.5, 0.85), 30, -100),
            "headlight": ((-1.9, 6.8, 4.1), (0, 3.4 - shift, 3.4), 50, -60),
            "front": ((-2.0, 14.0, 2.4), (0, 0, 2.0), 50, -40),
            "rear34": ((8.0, -9.0, 3.4), (0, -2.5, 2.0), 40, 120),
            "train": ((-20.0, 24.0, 6.5), (0, -18.0, 1.6), 32, -70),
            "tender": ((-8.5, -2.0, 3.6), (0, -9.5, 1.8), 40, -100),
            "cars": ((-11.0, -18.0, 3.2), (0, -28.0, 2.0), 35, -100),
            "coach": ((-10.0, -33.0, 3.0), (0, -45.0, 2.2), 35, -100),
            "tower": ((-9.0, 13.0, 3.2), (7.0, 26.0, 6.2), 30, -60),
            "truck": ((-2.6, -9.0, 0.75), (-0.9, -10.45, 0.45), 35, -100),
            "tenderTop": ((-6.5, -4.5, 6.5), (0, -8.2, 2.4), 40, -100),
            "pole": ((-6.5, 13.5, 4.5), (-3.8, 9.0, 6.6), 50, -60),
        }
        for v in views:
            if v not in cams:
                continue
            loc, tgt, lens, az = cams[v]
            aim_sun(sun, sky, az, 11.0)
            render_view(os.path.join(PREVIEW_DIR, f"last_frontier_train_{v}.png"), loc, tgt, lens, samples, scale)
    print(f"FRONTIER_TRAIN_OK {len(objs)} objects {total} triangles")


main()
