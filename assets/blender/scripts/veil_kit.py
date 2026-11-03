"""The Veil scenery kit: dead trees, ruined wooden structures and the distant stone architecture.

Everything is built from code and textured with photographed Poly Haven PBR sets (CC0) downloaded to
assets/external/polyhaven/<id>/ (bark_willow_02, dark_planks, rough_wood, old_stone_wall):

- trees.glb: dead snags, twisted dead hardwoods, a leaning tree and a broken trunk (near detail), plus
  two low-detail variants for the far forest. Branches grow recursively along gnarled paths with
  parallel-transport tube frames, buttressed root flares, splintered broken tops and snapped limbs.
- ruins.glb: a collapsed plank cabin, a leaning fire-lookout tower on stilts, a sagging boardwalk
  and a broken fence; every board is its own warped, jittered plank with splintered ends.
- monuments.glb: the far architecture revealed when the mist clears: a colossal gate of stacked,
  weathered blocks with a broken lintel, and three leaning stone needles.

Every object sits at the origin with its base at z = 0 (Blender Z-up, exported Y-up). Material names
(bark, planks, beam, stone) are what the stage's shaders look for.

Usage: blender -b --factory-startup --python assets/blender/scripts/veil_kit.py -- [--no-preview]
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
sys.dont_write_bytecode = True
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "veil")
SRC_DIR = os.path.join(common.ROOT, "assets", "blender", "source")
PREVIEW_DIR = os.path.join(common.ROOT, "assets", "blender", "previews")
PH = os.path.join(common.ROOT, "assets", "external", "polyhaven")

MATS = {}


# ----------------------------------------------------------------------------------------------
# Materials: Principled BSDF with photographed maps (base colour, normal, roughness from ARM.g).


def textured_material(name, tex_id, res="2k"):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    base = os.path.join(PH, tex_id, f"{tex_id}_diffuse_{res}.jpg")
    nor = os.path.join(PH, tex_id, f"{tex_id}_nor_gl_{res}.jpg")
    arm = os.path.join(PH, tex_id, f"{tex_id}_arm_{res}.jpg")
    img = nt.nodes.new("ShaderNodeTexImage")
    img.image = bpy.data.images.load(base)
    nt.links.new(img.outputs["Color"], bsdf.inputs["Base Color"])
    nimg = nt.nodes.new("ShaderNodeTexImage")
    nimg.image = bpy.data.images.load(nor)
    nimg.image.colorspace_settings.name = "Non-Color"
    nmap = nt.nodes.new("ShaderNodeNormalMap")
    nt.links.new(nimg.outputs["Color"], nmap.inputs["Color"])
    nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    aimg = nt.nodes.new("ShaderNodeTexImage")
    aimg.image = bpy.data.images.load(arm)
    aimg.image.colorspace_settings.name = "Non-Color"
    sep = nt.nodes.new("ShaderNodeSeparateColor")
    nt.links.new(aimg.outputs["Color"], sep.inputs["Color"])
    nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
    nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    MATS[name] = mat
    return mat


def setup_materials():
    textured_material("bark", "bark_willow_02")
    textured_material("planks", "dark_planks")
    textured_material("beam", "rough_wood")
    textured_material("stone", "old_stone_wall")


# ----------------------------------------------------------------------------------------------
# Mesh building helpers (bmesh, with UVs).


class Builder:
    """Accumulates geometry for one object: vertices, faces with UVs and a material slot per face."""

    def __init__(self, name):
        self.name = name
        self.bm = bmesh.new()
        self.uv = self.bm.loops.layers.uv.new("UVMap")
        self.slots = []

    def slot(self, mat_name):
        if mat_name not in self.slots:
            self.slots.append(mat_name)
        return self.slots.index(mat_name)

    def face(self, verts, uvs, mat):
        try:
            f = self.bm.faces.new(verts)
        except ValueError:
            return None
        f.material_index = self.slot(mat)
        for loop, uv in zip(f.loops, uvs):
            loop[self.uv].uv = uv
        f.smooth = True
        return f

    def finish(self, smooth_angle=40.0):
        mesh = bpy.data.meshes.new(self.name)
        self.bm.normal_update()
        self.bm.to_mesh(mesh)
        self.bm.free()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for m in self.slots:
            obj.data.materials.append(MATS[m])
        common.shade_smooth_by_angle(obj, smooth_angle)
        return obj


def frames(points):
    """Parallel-transport frames along a polyline: (tangent, normal, binormal) per point."""
    n = len(points)
    tangents = []
    for i in range(n):
        a = points[max(0, i - 1)]
        b = points[min(n - 1, i + 1)]
        t = b - a
        tangents.append(t.normalized() if t.length > 1e-8 else Vector((0, 0, 1)))
    t0 = tangents[0]
    ref = Vector((0, 0, 1)) if abs(t0.z) < 0.9 else Vector((1, 0, 0))
    nrm = (ref - t0 * ref.dot(t0)).normalized()
    out = []
    for t in tangents:
        nrm = (nrm - t * nrm.dot(t))
        if nrm.length < 1e-6:
            nrm = t.orthogonal()
        nrm.normalize()
        out.append((t, nrm, t.cross(nrm).normalized()))
    return out


def tube(b, points, radii, sides, mat, *, tile=1.6, cap_start=False, cap_end=True, bark=0.0, seed=0.0, lobes=0, lobe_amp=0.0, jag=0.0, rng=None):
    """A tube along `points` with per-point radii; bark noise roughens the surface, `lobes` adds
    buttress ridges (scaled by lobe_amp per point), `jag` splinters the last ring."""
    fr = frames(points)
    rings = []
    s = 0.0
    r_ref = max(radii[0], 0.02)
    u_rep = max(1, round(2 * math.pi * r_ref / tile))
    for i, (p, (t, nn, bb)) in enumerate(zip(points, fr)):
        if i > 0:
            s += (points[i] - points[i - 1]).length
        ring = []
        for j in range(sides + 1):
            a = 2 * math.pi * (j % sides) / sides
            d = nn * math.cos(a) + bb * math.sin(a)
            r = radii[i]
            if bark > 0:
                q = p * 1.7 + d * 0.6
                r *= 1 + bark * noise.noise(Vector((q.x + seed, q.y, q.z)))
                r *= 1 + bark * 0.5 * noise.noise(Vector((q.x * 4.3, q.y * 4.3 + seed, q.z * 1.2)))
            if lobes and lobe_amp:
                amp = lobe_amp[i] if isinstance(lobe_amp, (list, tuple)) else lobe_amp
                r *= 1 + amp * max(0.0, math.cos(lobes * a + seed)) ** 2
            pos = p + d * r
            if jag and i == len(points) - 1 and rng is not None:
                pos += t * (rng.random() * jag)
            ring.append(b.bm.verts.new(pos))
        rings.append((ring, s))
    for i in range(len(rings) - 1):
        (ra, sa), (rb, sb) = rings[i], rings[i + 1]
        for j in range(sides):
            u0, u1 = j / sides * u_rep, (j + 1) / sides * u_rep
            b.face([ra[j], ra[j + 1], rb[j + 1], rb[j]], [(u0, sa / tile), (u1, sa / tile), (u1, sb / tile), (u0, sb / tile)], mat)
    def cap(ring, center, flip):
        c = b.bm.verts.new(center)
        for j in range(sides):
            vs = [ring[j], ring[j + 1], c]
            uvs = [(0.5 + 0.4 * math.cos(2 * math.pi * j / sides), 0.5 + 0.4 * math.sin(2 * math.pi * j / sides)), (0.5 + 0.4 * math.cos(2 * math.pi * (j + 1) / sides), 0.5 + 0.4 * math.sin(2 * math.pi * (j + 1) / sides)), (0.5, 0.5)]
            if flip:
                vs.reverse()
                uvs.reverse()
            b.face(vs, uvs, mat)
    if cap_end:
        cap(rings[-1][0], points[-1], False)
    if cap_start:
        cap(rings[0][0], points[0], True)


def box(b, center, size, mat, *, rot=None, tile=1.0, bend=0.0, twist=0.0, jag_a=0.0, jag_b=0.0, rng=None, axis=0):
    """A board: box of `size` (x, y, z) along local x (the grain), bent and twisted along its length,
    with optional splintered ends. UVs follow the grain at real-world scale (`tile` metres per repeat)."""
    sx, sy, sz = size
    rot = rot or Matrix.Identity(3)
    nseg = max(1, int(sx / 0.5))
    corners = [(-0.5, -0.5), (0.5, -0.5), (0.5, 0.5), (-0.5, 0.5)]
    sections = []
    for k in range(nseg + 1):
        t = k / nseg
        x = (t - 0.5) * sx
        sag = bend * (1 - (2 * t - 1) ** 2)
        tw = twist * (t - 0.5)
        sec = []
        for ci, (cy, cz) in enumerate(corners):
            y = cy * sy
            z = cz * sz
            yy = y * math.cos(tw) - z * math.sin(tw)
            zz = y * math.sin(tw) + z * math.cos(tw) - sag
            xx = x
            if rng is not None:
                if k == 0 and jag_a:
                    xx += rng.random() * jag_a
                if k == nseg and jag_b:
                    xx -= rng.random() * jag_b
            sec.append(b.bm.verts.new(Vector(center) + rot @ Vector((xx, yy, zz))))
        sections.append((sec, x))
    u0 = rng.random() * 4 if rng else 0.0
    for k in range(nseg):
        (a, xa), (c, xc) = sections[k], sections[k + 1]
        for side in range(4):
            i0, i1 = side, (side + 1) % 4
            w = sy if side % 2 == 0 else sz
            v0 = side * 0.25
            b.face([a[i0], a[i1], c[i1], c[i0]], [(u0 + xa / tile, v0), (u0 + xa / tile, v0 + w / tile), (u0 + xc / tile, v0 + w / tile), (u0 + xc / tile, v0)], mat)
    a = sections[0][0]
    c = sections[-1][0]
    b.face([a[3], a[2], a[1], a[0]], [(0, 0), (sz / tile, 0), (sz / tile, sy / tile), (0, sy / tile)], mat)
    b.face([c[0], c[1], c[2], c[3]], [(0, 0), (sy / tile, 0), (sy / tile, sz / tile), (0, sz / tile)], mat)


def rot_z(a):
    return Matrix.Rotation(a, 3, "Z")


def rot_y(a):
    return Matrix.Rotation(a, 3, "Y")


def rot_x(a):
    return Matrix.Rotation(a, 3, "X")


def beam_between(b, p0, p1, w, h, mat, rng, *, tile=1.2, jag=0.0, bend=0.0):
    """A board or beam from p0 to p1 (its local x axis), w across and h thick."""
    p0 = Vector(p0)
    p1 = Vector(p1)
    d = p1 - p0
    length = d.length
    x = d.normalized()
    ref = Vector((0, 0, 1)) if abs(x.z) < 0.95 else Vector((0, 1, 0))
    y = ref.cross(x).normalized()
    z = x.cross(y).normalized()
    m = Matrix((x, y, z)).transposed()
    box(b, (p0 + p1) * 0.5, (length, w, h), mat, rot=m, tile=tile, jag_a=jag, jag_b=jag, rng=rng, bend=bend)


# ----------------------------------------------------------------------------------------------
# Dead trees.


def gnarled_path(start, direction, length, seg, rng, *, gnarl=0.25, up=0.0, droop=0.0, freq=0.35, seed=0.0):
    pts = [Vector(start)]
    d = Vector(direction).normalized()
    n = max(2, int(length / seg))
    step = length / n
    for k in range(n):
        p = pts[-1]
        q = p * freq
        bendv = Vector((noise.noise(Vector((q.x + seed, q.y, q.z))), noise.noise(Vector((q.x, q.y + seed + 7.1, q.z))), noise.noise(Vector((q.x, q.y, q.z + seed + 3.3)))))
        d = (d + bendv * gnarl + Vector((0, 0, up)) - Vector((0, 0, droop * (k / n)))).normalized()
        pts.append(p + d * step)
    return pts


def branch(b, rng, start, direction, length, radius, level, cfg, seed):
    """Grows one branch and its children (recursive). Thin branches get fewer sides."""
    sides = cfg["sides"][min(level, len(cfg["sides"]) - 1)]
    pts = gnarled_path(start, direction, length, cfg["seg"][min(level, len(cfg["seg"]) - 1)], rng, gnarl=cfg["gnarl"][min(level, 2)], up=cfg["up"][min(level, 2)], droop=cfg["droop"][min(level, 2)], seed=seed)
    broken = level > 0 and rng.random() < cfg["broken"]
    if broken:
        cut = max(2, int(len(pts) * (0.35 + 0.5 * rng.random())))
        pts = pts[:cut]
    n = len(pts)
    tip = radius * (0.55 if broken else cfg["tip"])
    radii = [radius + (tip - radius) * (i / (n - 1)) ** 0.85 for i in range(n)]
    tube(b, pts, radii, sides, "bark", tile=cfg["tile"], cap_end=True, bark=0.12 if level == 0 else 0.07, seed=seed, jag=radius * 1.6 if broken else 0.0, rng=rng)
    if level + 1 >= cfg["levels"] or radius < cfg["min_r"]:
        return
    kids = cfg["children"][level]
    count = rng.randint(kids[0], kids[1])
    for c in range(count):
        t = cfg["start"][level] + (1 - cfg["start"][level]) * (c + rng.random()) / max(1, count)
        idx = min(n - 2, int(t * (n - 1)))
        p = pts[idx]
        tdir = (pts[idx + 1] - pts[idx]).normalized()
        az = rng.random() * 2 * math.pi
        side = tdir.orthogonal().normalized()
        side.rotate(Matrix.Rotation(az, 3, tdir))
        spread = cfg["angle"][level] * (0.7 + 0.6 * rng.random())
        d = (tdir * math.cos(spread) + side * math.sin(spread)).normalized()
        child_len = length * cfg["ratio"][level] * (0.6 + 0.6 * rng.random()) * (1.15 - 0.5 * t)
        child_r = radii[idx] * cfg["rratio"][level] * (0.75 + 0.3 * rng.random())
        branch(b, rng, p - tdir * radii[idx] * 0.3, d, child_len, child_r, level + 1, cfg, seed + 11.3 * (c + 1) + level)


def make_tree(name, seed, cfg):
    rng = random.Random(seed)
    b = Builder(name)
    # Trunk with a buttressed root flare.
    h = cfg["height"]
    lean = Vector((cfg.get("lean", 0.0), cfg.get("lean_y", 0.0), 1.0)).normalized()
    pts = gnarled_path(Vector((0, 0, -0.3)), lean, h, cfg["seg"][0], rng, gnarl=cfg["gnarl"][0], up=cfg["up"][0], droop=0.0, seed=seed * 0.37)
    n = len(pts)
    r0 = cfg["radius"]
    radii = []
    flare = []
    for i, p in enumerate(pts):
        t = i / (n - 1)
        z = max(0.0, p.z)
        r = r0 * (1 - 0.82 * t ** 0.9) * (1 + 0.9 * math.exp(-z / 0.45))
        radii.append(max(r, 0.04))
        flare.append(0.35 * math.exp(-z / 0.6))
    tube(b, pts, radii, cfg["sides"][0], "bark", tile=cfg["tile"], cap_end=True, bark=0.14, seed=seed, lobes=5, lobe_amp=flare, jag=r0 * 2.2 if cfg.get("broken_top") else 0.0, rng=rng)
    # Limbs from the trunk.
    lo, hi = cfg["limbs_at"]
    count = rng.randint(cfg["limbs"][0], cfg["limbs"][1])
    for c in range(count):
        t = lo + (hi - lo) * (c + rng.random()) / max(1, count)
        idx = min(n - 2, int(t * (n - 1)))
        p = pts[idx]
        tdir = (pts[idx + 1] - pts[idx]).normalized()
        az = c * 2.39996 + rng.random() * 0.8
        side = Vector((math.cos(az), math.sin(az), 0.0))
        spread = cfg["angle"][0] * (0.75 + 0.5 * rng.random())
        d = (tdir * math.cos(spread) + side * math.sin(spread)).normalized()
        ln = cfg["limb_len"] * (0.55 + 0.6 * rng.random()) * (1.2 - 0.7 * t if cfg.get("conifer") else 1.0)
        rr = radii[idx] * cfg["rratio"][0] * (0.7 + 0.35 * rng.random())
        branch(b, rng, p - tdir * 0.05, d, ln, rr, 1, cfg, seed * 1.7 + c * 5.1)
    obj = b.finish(55)
    return obj


TREE_BASE = dict(
    sides=[12, 8, 6, 4, 3],
    seg=[0.55, 0.42, 0.3, 0.22, 0.18],
    gnarl=[0.12, 0.3, 0.45],
    up=[0.0, 0.05, 0.08],
    droop=[0.0, 0.0, 0.0],
    tip=0.16,
    tile=1.4,
    levels=5,
    min_r=0.008,
    broken=0.16,
    children=[(2, 4), (3, 4), (2, 4), (2, 3), (0, 0)],
    start=[0.3, 0.3, 0.35, 0.35, 0.4],
    angle=[0.9, 0.72, 0.66, 0.6, 0.6],
    ratio=[0.6, 0.55, 0.52, 0.5, 0.5],
    rratio=[0.55, 0.55, 0.55, 0.6, 0.6],
)


def tree_cfg(**kw):
    c = dict(TREE_BASE)
    c.update(kw)
    return c


SNAG = dict(conifer=True, broken_top=True, angle=[1.5, 0.75, 0.65, 0.6, 0.6], droop=[0.0, 0.45, 0.25], gnarl=[0.05, 0.2, 0.35], levels=4, children=[(0, 0), (1, 3), (1, 2), (0, 0), (0, 0)], broken=0.5, rratio=[0.2, 0.5, 0.55, 0.6, 0.6], ratio=[0.6, 0.45, 0.45, 0.5, 0.5], tip=0.1, start=[0.3, 0.25, 0.3, 0.3, 0.3])

TREES = [
    # Tall dead conifer snags: drooping dead whorls and stubs all the way up, a splintered top.
    ("tree_snag_a", 11, tree_cfg(**SNAG, height=24, radius=0.42, limbs=(44, 54), limbs_at=(0.16, 0.96), limb_len=3.6)),
    ("tree_snag_b", 23, tree_cfg(**{**SNAG, "broken": 0.62}, height=17, radius=0.36, limbs=(30, 38), limbs_at=(0.22, 0.94), limb_len=3.0, lean=0.08)),
    # Twisted dead hardwoods: a short trunk splitting into reaching, gnarled limbs and fine twigs.
    ("tree_twisted_a", 37, tree_cfg(height=7.5, radius=0.55, limbs=(5, 6), limbs_at=(0.55, 1.0), limb_len=7.8, gnarl=[0.18, 0.32, 0.45], up=[0.0, 0.06, 0.05])),
    ("tree_twisted_b", 41, tree_cfg(height=6.0, radius=0.46, limbs=(4, 5), limbs_at=(0.5, 1.0), limb_len=6.8, gnarl=[0.22, 0.36, 0.5], up=[0.0, 0.03, 0.04], lean=0.18)),
    # A leaning dead tree with a few long, broken limbs.
    ("tree_lean", 53, tree_cfg(height=13, radius=0.38, lean=0.42, lean_y=0.1, limbs=(6, 8), limbs_at=(0.4, 0.95), limb_len=4.8, broken=0.35, children=[(0, 0), (2, 3), (1, 3), (1, 2), (0, 0)])),
    # A broken trunk.
    ("tree_broken", 67, tree_cfg(height=5.5, radius=0.5, broken_top=True, limbs=(2, 3), limbs_at=(0.4, 0.8), limb_len=2.4, levels=3, broken=0.8, children=[(0, 0), (0, 2), (0, 0)])),
]

FAR_TREES = [
    ("tree_far_snag", 71, tree_cfg(**{**SNAG, "levels": 2}, height=22, radius=0.4, limbs=(22, 26), limbs_at=(0.2, 0.95), limb_len=3.4, sides=[7, 4, 3], seg=[1.2, 0.9, 0.8])),
    ("tree_far_twisted", 83, tree_cfg(height=7.0, radius=0.5, limbs=(4, 5), limbs_at=(0.55, 1.0), limb_len=7.0, levels=3, sides=[7, 4, 3], seg=[1.0, 0.8, 0.6], children=[(0, 0), (2, 3), (0, 0)], min_r=0.04)),
]


# ----------------------------------------------------------------------------------------------
# Ruined wooden structures.


def make_cabin(rng):
    b = Builder("cabin")
    W, D, H = 5.2, 4.0, 2.6
    lean = rot_y(0.05) @ rot_x(-0.025)

    def at(x, y, z):
        return lean @ Vector((x, y, z))

    # Corner posts and sill beams.
    for x in (-W / 2, W / 2):
        for y in (-D / 2, D / 2):
            hh = H + (0.0 if x < 0 else -0.35 * (y > 0))
            beam_between(b, at(x, y, -0.2), at(x, y, hh), 0.16, 0.16, "beam", rng, jag=0.05)
    for (x0, y0, x1, y1) in ((-W / 2, -D / 2, W / 2, -D / 2), (-W / 2, D / 2, W / 2, D / 2), (-W / 2, -D / 2, -W / 2, D / 2), (W / 2, -D / 2, W / 2, D / 2)):
        beam_between(b, at(x0, y0, 0.05), at(x1, y1, 0.05), 0.18, 0.18, "beam", rng)
    # Horizontal clapboard walls with gaps, missing and broken boards, a door and a window.
    board_h = 0.21
    rows = int(H / board_h)
    walls = [((-W / 2, -D / 2), (W / 2, -D / 2), "front"), ((W / 2, D / 2), (-W / 2, D / 2), "back"), ((-W / 2, D / 2), (-W / 2, -D / 2), "left"), ((W / 2, -D / 2), (W / 2, D / 2), "right")]
    for (a, c, side) in walls:
        a = Vector((a[0], a[1], 0))
        c = Vector((c[0], c[1], 0))
        along = (c - a).normalized()
        out = Vector((along.y, -along.x, 0))
        length = (c - a).length
        for r in range(rows):
            z = 0.2 + r * board_h
            if side == "right" and z > 1.2 and rng.random() < 0.6:
                continue  # the collapsed side wall
            if rng.random() < 0.16:
                continue
            spans = [(0.0, length)]
            if side == "front":
                spans = [(0.0, 1.6), (2.6, 3.3), (4.3, length)] if 0.9 < z < 1.9 else ([(0.0, 1.6), (2.6, length)] if z < 2.1 else [(0.0, length)])
            for (s0, s1) in spans:
                if rng.random() < 0.25:
                    s1 = s0 + (s1 - s0) * (0.35 + 0.5 * rng.random())
                p0 = a + along * (s0 + 0.02) + out * 0.09 + Vector((0, 0, z))
                p1 = a + along * (s1 - 0.02) + out * 0.09 + Vector((0, 0, z + (rng.random() - 0.5) * 0.04))
                beam_between(b, at(*p0), at(*p1), board_h * 0.93, 0.03, "planks", rng, jag=0.08, bend=rng.random() * 0.02, tile=2.0)
    # Door and window frames.
    for (x0, x1, z0, z1) in ((-W / 2 + 1.6, -W / 2 + 2.6, 0.1, 2.1), (-W / 2 + 3.3, -W / 2 + 4.3, 0.95, 1.85)):
        for x in (x0, x1):
            beam_between(b, at(x, -D / 2 - 0.1, z0), at(x, -D / 2 - 0.1, z1), 0.1, 0.08, "beam", rng)
        beam_between(b, at(x0 - 0.05, -D / 2 - 0.1, z1), at(x1 + 0.05, -D / 2 - 0.1, z1), 0.1, 0.08, "beam", rng)
    # A fallen door leaning against the frame.
    for i in range(5):
        x = -W / 2 + 1.7 + i * 0.18
        beam_between(b, at(x, -D / 2 - 0.25 - 0.9, 0.02 + i * 0.002), at(x + 0.05, -D / 2 - 0.25, 1.95), 0.17, 0.03, "planks", rng, jag=0.05, tile=2.0)
    # Roof: rafters, one slope still on, the other collapsed into the cabin, broken ridge.
    ridge_z = H + 1.3
    beam_between(b, at(-W / 2 - 0.3, 0, ridge_z), at(W / 2 - 1.6, 0, ridge_z - 0.25), 0.18, 0.18, "beam", rng, jag=0.2)
    beam_between(b, at(W / 2 - 1.5, 0, ridge_z - 0.35), at(W / 2 + 0.3, 0.6, H - 0.6), 0.18, 0.18, "beam", rng, jag=0.2)
    for i in range(7):
        x = -W / 2 + i * (W / 6)
        beam_between(b, at(x, -D / 2 - 0.4, H - 0.15), at(x, 0, ridge_z - 0.06 * i), 0.1, 0.14, "beam", rng)
        if i < 4:
            beam_between(b, at(x, D / 2 + 0.4, H - 0.15), at(x, 0, ridge_z - 0.06 * i), 0.1, 0.14, "beam", rng)
        else:
            beam_between(b, at(x, D / 2 - 0.2, 0.4 + rng.random() * 0.5), at(x + 0.2, 0.3, ridge_z - 1.2), 0.1, 0.14, "beam", rng, jag=0.15)
    slope = math.atan2(ridge_z - H + 0.15, D / 2 + 0.4)
    for i in range(14):
        if rng.random() < 0.22:
            continue
        y = -D / 2 - 0.4 + (i + 0.5) * ((D / 2 + 0.4) / 14)
        z = H - 0.15 + (y + D / 2 + 0.4) * math.tan(slope) + 0.1
        x1 = W / 2 + 0.3 if rng.random() > 0.3 else W / 2 - rng.random() * 2.5
        beam_between(b, at(-W / 2 - 0.3, y, z), at(x1, y, z - 0.1 * (x1 > 0)), 0.22, 0.03, "planks", rng, jag=0.15, bend=0.04 + rng.random() * 0.06, tile=2.0)
    for i in range(9):
        y = 0.3 + i * 0.25
        z0 = 0.5 + i * 0.18
        beam_between(b, at(-W / 2 + 0.2 + rng.random() * 0.6, y, z0 + 0.8), at(W / 2 - 0.6, y + 0.3, z0 - 0.2), 0.22, 0.03, "planks", rng, jag=0.2, bend=0.1, tile=2.0)
    # Debris planks on the ground.
    for i in range(10):
        a = rng.random() * math.pi
        cx, cy = (rng.random() - 0.5) * 9, (rng.random() - 0.5) * 8
        if abs(cx) < W / 2 + 0.3 and abs(cy) < D / 2 + 0.3:
            cy += 4
        ln = 0.8 + rng.random() * 1.8
        p0 = Vector((cx - math.cos(a) * ln / 2, cy - math.sin(a) * ln / 2, 0.02))
        p1 = Vector((cx + math.cos(a) * ln / 2, cy + math.sin(a) * ln / 2, 0.06 + rng.random() * 0.12))
        beam_between(b, p0, p1, 0.2, 0.03, "planks", rng, jag=0.1, tile=2.0)
    return b.finish(30)


def make_tower(rng):
    b = Builder("tower")
    H = 12.0
    base, top = 2.6, 1.7
    lean = rot_x(0.07) @ rot_y(-0.035)

    def at(x, y, z):
        return lean @ Vector((x, y, z))

    legs = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            p0 = Vector((sx * base, sy * base, -0.4))
            p1 = Vector((sx * top, sy * top, H + 0.2))
            legs.append((p0, p1))
            tube(b, [at(*(p0 + (p1 - p0) * (k / 8))) for k in range(9)], [0.15 - 0.03 * (k / 8) for k in range(9)], 8, "beam", tile=1.2, bark=0.05, seed=sx * 3 + sy)
    def leg_at(i, z):
        p0, p1 = legs[i]
        t = (z + 0.4) / (H + 0.6)
        return p0 + (p1 - p0) * t
    # X bracing on every face, some braces broken.
    faces = [(0, 1), (1, 3), (3, 2), (2, 0)]
    levels = [0.5, 3.4, 6.3, 9.2]
    for (i, j) in faces:
        for li in range(len(levels) - 1):
            z0, z1 = levels[li], levels[li + 1]
            for (pa, pb) in ((leg_at(i, z0), leg_at(j, z1)), (leg_at(j, z0), leg_at(i, z1))):
                if rng.random() < 0.18:
                    pb = pa + (pb - pa) * (0.3 + 0.4 * rng.random())
                beam_between(b, at(*pa), at(*pb), 0.12, 0.05, "beam", rng, jag=0.08)
            beam_between(b, at(*leg_at(i, z1)), at(*leg_at(j, z1)), 0.14, 0.06, "beam", rng)
    # Platform: joists, floor boards with gaps, a broken railing and a half-stripped roof.
    pz = H
    for k in range(5):
        y = -top - 0.4 + k * ((2 * top + 0.8) / 4)
        beam_between(b, at(-top - 0.5, y, pz), at(top + 0.5, y, pz), 0.12, 0.16, "beam", rng)
    for k in range(16):
        if rng.random() < 0.18:
            continue
        x = -top - 0.5 + (k + 0.5) * ((2 * top + 1.0) / 16)
        y1 = top + 0.5 if rng.random() > 0.2 else top - rng.random() * 1.5
        beam_between(b, at(x, -top - 0.5, pz + 0.11), at(x, y1, pz + 0.11), 0.19, 0.03, "planks", rng, jag=0.1, tile=2.0)
    rail_posts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            p = Vector((sx * (top + 0.45), sy * (top + 0.45), pz))
            rail_posts.append(p)
            beam_between(b, at(*p), at(*(p + Vector((0, 0, 2.6)))), 0.1, 0.1, "beam", rng)
    order = [0, 1, 3, 2]
    for k in range(4):
        pa = rail_posts[order[k]]
        pb = rail_posts[order[(k + 1) % 4]]
        for hz in (0.5, 1.0):
            if rng.random() < 0.3:
                pb2 = pa + (pb - pa) * (0.4 + 0.3 * rng.random()) + Vector((0, 0, -0.3))
                beam_between(b, at(*(pa + Vector((0, 0, hz)))), at(*(pb2 + Vector((0, 0, hz)))), 0.1, 0.04, "planks", rng, jag=0.1)
            else:
                beam_between(b, at(*(pa + Vector((0, 0, hz)))), at(*(pb + Vector((0, 0, hz)))), 0.1, 0.04, "planks", rng)
    apex = Vector((0, 0, pz + 3.6))
    for p in rail_posts:
        beam_between(b, at(*(p + Vector((0, 0, 2.6)))), at(*apex), 0.1, 0.12, "beam", rng)
    for k in range(9):
        if rng.random() < 0.45:
            continue
        t = (k + 0.5) / 9
        pa = rail_posts[0] + (rail_posts[1] - rail_posts[0]) * t + Vector((0, 0, 2.6))
        beam_between(b, at(*pa), at(*(apex + (pa - apex) * 0.08)), 0.24, 0.03, "planks", rng, jag=0.1, tile=2.0)
    # A ladder up one face, missing rungs, one rail snapped.
    l0 = Vector((-0.35, -base - 0.1, -0.2))
    for dx in (0.0, 0.7):
        tube(b, [at(*(l0 + Vector((dx, 0.9 * (k / 6), H * (k / 6) * (0.75 if dx > 0 else 1.0))))) for k in range(7)], [0.05] * 7, 6, "beam", tile=1.0)
    for k in range(int(H / 0.35)):
        if rng.random() < 0.3 or k * 0.35 > H * 0.74:
            continue
        z = 0.3 + k * 0.35
        t = z / H
        beam_between(b, at(*(l0 + Vector((0, 0.9 * t, z)))), at(*(l0 + Vector((0.7, 0.9 * t, z)))), 0.06, 0.05, "beam", rng)
    return b.finish(30)


def make_boardwalk(rng):
    b = Builder("boardwalk")
    length = 20.0
    n = int(length / 1.7)
    for k in range(n + 1):
        x = k * 1.7 - 0.3
        sink = 0.25 * math.sin(k * 0.9) + (0.5 if k > n - 3 else 0.0)
        for y in (-0.75, 0.75):
            if rng.random() < 0.12:
                continue
            tube(b, [Vector((x + (rng.random() - 0.5) * 0.1, y, -1.2)), Vector((x, y, 0.45 - sink * 0.5 + rng.random() * 0.2))], [0.11, 0.1], 7, "beam", tile=1.0, bark=0.05, seed=k)
        beam_between(b, (x, -0.85, 0.32 - sink * 0.6), (x, 0.85, 0.3 - sink * 0.6), 0.12, 0.14, "beam", rng)
    for side in (-0.55, 0.55):
        for k in range(n):
            x0, x1 = k * 1.7 - 0.3, (k + 1) * 1.7 - 0.3
            if k > n - 3 and side > 0:
                continue
            s0 = 0.25 * math.sin(k * 0.9) * 0.6
            s1 = 0.25 * math.sin((k + 1) * 0.9) * 0.6 + (0.3 if k + 1 > n - 3 else 0.0)
            beam_between(b, (x0, side, 0.45 - s0), (x1, side, 0.45 - s1), 0.1, 0.16, "beam", rng)
    x = -0.4
    while x < length - 1.5:
        w = 0.2 + rng.random() * 0.04
        if rng.random() > 0.17:
            t = x / length
            sag = 0.25 * math.sin(x / 1.7 * 0.9) * 0.6 + (0.35 if t > 0.85 else 0.0)
            y0 = -0.9 + (0.25 * rng.random() if rng.random() < 0.15 else 0.0)
            y1 = 0.9 - (0.6 * rng.random() if rng.random() < 0.2 else 0.0)
            tilt = (rng.random() - 0.5) * 0.06
            beam_between(b, (x, y0, 0.55 - sag + tilt), (x + (rng.random() - 0.5) * 0.06, y1, 0.55 - sag - tilt), w * 0.9, 0.035, "planks", rng, jag=0.07, tile=2.0)
        x += w + 0.03 + rng.random() * 0.03
    return b.finish(30)


def make_fence(rng):
    b = Builder("fence")
    x = 0.0
    k = 0
    while x < 14:
        lean = (rng.random() - 0.5) * 0.25
        h = 1.3 + rng.random() * 0.3 if rng.random() > 0.2 else 0.5 + rng.random() * 0.4
        top = Vector((x + math.sin(lean) * h, (rng.random() - 0.5) * 0.15, h))
        tube(b, [Vector((x, 0, -0.3)), Vector((x, 0, 0.2)), top], [0.075, 0.07, 0.06], 7, "beam", tile=1.0, bark=0.08, seed=k * 1.3, jag=0.08, rng=rng)
        if k > 0:
            for hz in (0.45, 0.95):
                if rng.random() < 0.3:
                    continue
                beam_between(b, (x - 2.2, 0.08, hz + (rng.random() - 0.5) * 0.1), (x + 0.1, 0.08, hz - (rng.random() * 0.4 if rng.random() < 0.25 else 0)), 0.12, 0.03, "planks", rng, jag=0.08, tile=2.0)
        x += 2.1 + rng.random() * 0.3
        k += 1
    return b.finish(30)


# ----------------------------------------------------------------------------------------------
# The distant architecture: built of weathered blocks, so its scale reads.


def block(b, center, size, rng, mat="stone", tile=3.0, chip=0.12, rot=None):
    """A weathered stone block: a box whose corners are knocked back by random amounts, optionally
    turned (fallen or settled blocks)."""
    sx, sy, sz = size
    cx, cy, cz = center
    rot = rot or Matrix.Identity(3)
    vs = []
    for (ix, iy, iz) in ((0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)):
        jx = (rng.random() - 0.5) * chip * sx
        jy = (rng.random() - 0.5) * chip * sy
        jz = (rng.random() - 0.5) * chip * sz * 0.5
        local = Vector(((ix - 0.5) * sx * (1 - chip * 0.3 * iz) + jx, (iy - 0.5) * sy * (1 - chip * 0.3 * iz) + jy, (iz - 0.5) * sz + jz))
        vs.append(b.bm.verts.new(Vector((cx, cy, cz)) + rot @ local))
    quads = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    for q in quads:
        pts = [vs[i].co for i in q]
        nrm = (pts[1] - pts[0]).cross(pts[2] - pts[0])
        ax = max(range(3), key=lambda i: abs(nrm[i]))
        u_i, v_i = [(1, 2), (0, 2), (0, 1)][ax]
        b.face([vs[i] for i in q], [(p[u_i] / tile, p[v_i] / tile) for p in pts], mat)


def settle(rng, amount):
    """A small random rotation: blocks that have shifted over centuries."""
    return Matrix.Rotation((rng.random() - 0.5) * amount, 3, "X") @ Matrix.Rotation((rng.random() - 0.5) * amount, 3, "Y") @ Matrix.Rotation((rng.random() - 0.5) * amount * 2, 3, "Z")


def pillar(b, rng, cx, cy, width, height, broken_at, lean, chip=0.22):
    """A masonry pillar of irregular courses, tapering, leaning, with missing blocks, broken off at
    `broken_at` (a fraction of `height`) with a ragged top."""
    z = 0.0
    course = 0
    top = height * broken_at
    while z < top:
        hgt = 2.6 + rng.random() * 2.4
        t = z / height
        w = width * (1 - 0.2 * t)
        off = lean * z
        parts = 2 if course % 2 == 0 else 3
        ragged = z > top - 9
        missing = 0
        for k in range(parts):
            if rng.random() < (0.05 + (0.32 if ragged else 0.0) + 0.06 * t):
                missing += 1
                continue
            bw = w / parts
            jitter = (rng.random() - 0.5) * 0.8
            block(b, (cx + off - w / 2 + bw * (k + 0.5) + jitter, cy + (rng.random() - 0.5) * 0.9, z + hgt / 2), (bw * (0.9 + rng.random() * 0.12), w * (0.86 + rng.random() * 0.12), hgt * (0.92 + rng.random() * 0.08)), rng, chip=chip, rot=settle(rng, 0.08 + (0.25 if ragged else 0.0)))
        z += hgt
        course += 1
        if ragged and missing >= 2:
            break
    return z


def rubble(b, rng, cx, cy, spread, count, size):
    for _ in range(count):
        a = rng.random() * 6.283
        r = spread * rng.random() ** 0.7
        s = size * (0.4 + rng.random() * 0.9)
        block(b, (cx + r * 1.4 * __import__("math").cos(a), cy + r * __import__("math").sin(a), s * 0.35), (s * (1 + rng.random()), s * (0.7 + rng.random() * 0.6), s * (0.5 + rng.random() * 0.5)), rng, chip=0.35, rot=settle(rng, 1.2))


def make_gate(rng):
    """A colossal ruined gateway, half fallen: one pillar still standing to a ragged top, leaning;
    its twin snapped off low with its upper courses strewn across the ground; the lintel down,
    one end propped on the fallen courses; a shorter third pillar and a fragment of wall behind,
    and rubble everywhere. Only ever seen through fog."""
    b = Builder("gate")
    gap = 30.0
    pillar(b, rng, -gap / 2 - 4.5, 0.0, 9.5, 82.0, 1.0, 0.02)
    pillar(b, rng, gap / 2 + 4.5, 0.0, 9.0, 82.0, 0.42, -0.015)
    pillar(b, rng, -gap / 2 - 22.0, 20.0, 7.5, 60.0, 0.55, 0.03)
    # A wall fragment between the rear pillar and the standing one.
    for c in range(6):
        z = c * 3.2
        for k in range(4):
            if rng.random() < 0.3 + c * 0.08:
                continue
            block(b, (-gap / 2 - 18.0 + k * 3.6 + (rng.random() - 0.5), 10.0 + (rng.random() - 0.5), z + 1.6), (3.4, 2.8, 3.0), rng, chip=0.28, rot=settle(rng, 0.15))
    # The fallen lintel: three great cracked blocks, one leaning against the standing pillar.
    lean = Matrix.Rotation(0.95, 3, "Y")
    block(b, (-gap / 2 + 8.0, -3.0, 16.0), (26.0, 7.5, 6.0), rng, chip=0.18, rot=lean @ Matrix.Rotation(0.08, 3, "Z"))
    block(b, (gap / 2 + 10.0, -12.0, 3.0), (18.0, 7.0, 6.0), rng, chip=0.25, rot=Matrix.Rotation(0.12, 3, "X") @ Matrix.Rotation(0.6, 3, "Z"))
    block(b, (gap / 2 - 2.0, -20.0, 2.6), (11.0, 6.5, 5.5), rng, chip=0.3, rot=Matrix.Rotation(-0.2, 3, "Y") @ Matrix.Rotation(-0.9, 3, "Z"))
    rubble(b, rng, gap / 2 + 6.0, -8.0, 22.0, 34, 4.0)
    rubble(b, rng, -gap / 2 - 6.0, -4.0, 14.0, 16, 3.2)
    rubble(b, rng, -gap / 2 - 22.0, 18.0, 10.0, 10, 3.0)
    return b.finish(20)


def make_needle(rng, name, height, lean):
    b = Builder(name)
    z = 0.0
    w = height * 0.085
    off = Vector((0, 0, 0))
    while z < height:
        t = z / height
        hgt = w * (0.45 + rng.random() * 0.3)
        ww = w * (1 - 0.75 * t) * (0.9 + rng.random() * 0.2)
        off = Vector((lean * z, lean * 0.3 * z, 0)) + Vector(((rng.random() - 0.5) * ww * 0.15, (rng.random() - 0.5) * ww * 0.15, 0))
        block(b, (off.x, off.y, z + hgt / 2), (ww, ww * (0.85 + rng.random() * 0.3), hgt), rng, chip=0.2)
        z += hgt * 0.97
    return b.finish(20)


# ----------------------------------------------------------------------------------------------


def export(objs, name):
    path = os.path.join(OUT_DIR, f"{name}.glb")
    common.export_glb(objs, path)
    tris = 0
    for o in objs:
        tris += sum(len(p.vertices) - 2 for p in o.data.polygons)
    return path, tris


def preview(path, cam_loc, target):
    """Cycles contact render: an overcast sky and a low sun, so the silhouettes and textures read."""
    import mathutils
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 1600, 700
    world = bpy.data.worlds.get("VeilPreview") or bpy.data.worlds.new("VeilPreview")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.42, 0.45, 0.5, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    cam = bpy.data.objects.get("VeilCam")
    if cam is None:
        cam = bpy.data.objects.new("VeilCam", bpy.data.cameras.new("VeilCam"))
        scene.collection.objects.link(cam)
        sun = bpy.data.objects.new("VeilSun", bpy.data.lights.new("VeilSun", "SUN"))
        sun.data.energy = 3.0
        sun.rotation_euler = (math.radians(55), 0, math.radians(30))
        scene.collection.objects.link(sun)
    cam.data.lens = 35
    cam.data.clip_end = 2000
    cam.location = cam_loc
    cam.rotation_euler = mathutils.Vector([t - c for t, c in zip(target, cam_loc)]).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def main():
    no_preview = "--no-preview" in common.args()
    common.reset_scene()
    setup_materials()
    common.ensure_dir(OUT_DIR)
    summary = {}
    # Trees: near variants side by side for the preview, then moved back to the origin.
    trees = [make_tree(n, s, c) for (n, s, c) in TREES] + [make_tree(n, s, c) for (n, s, c) in FAR_TREES]
    ruins = [make_cabin(random.Random(5)), make_tower(random.Random(7)), make_boardwalk(random.Random(9)), make_fence(random.Random(13))]
    monuments = [make_gate(random.Random(17)), make_needle(random.Random(19), "needle_a", 120, 0.04), make_needle(random.Random(23), "needle_b", 95, -0.06), make_needle(random.Random(29), "needle_c", 140, 0.015)]
    for group, name in ((trees, "trees"), (ruins, "ruins"), (monuments, "monuments")):
        path, tris = export(group, name)
        summary[name] = {"objects": [o.name for o in group], "triangles": tris, "perObject": {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in group}}
    common.save_blend(os.path.join(SRC_DIR, "veil_kit.blend"))
    common.write_metadata(os.path.join(OUT_DIR, "veil_kit.meta.json"), {"generator": "assets/blender/scripts/veil_kit.py", "textures": "Poly Haven (CC0): bark_willow_02, dark_planks, rough_wood, old_stone_wall", "license": "Original work for Prismfall", "assets": summary})
    if not no_preview:
        groups = [(trees, "veil_trees", [i * 10.0 - 35 for i in range(len(trees))], (0, -75, 12), (0, 0, 9)), (ruins, "veil_ruins", [-16, -4, 6, 20], (2, -30, 10), (2, 0, 4)), (monuments, "veil_monuments", [0, 70, 100, -70], (10, -300, 60), (10, 0, 55))]
        everything = trees + ruins + monuments
        for group, name, xs, cam, target in groups:
            for o in everything:
                o.hide_render = o not in group
            for o, x in zip(group, xs):
                o.location.x = x
            preview(os.path.join(PREVIEW_DIR, f"{name}.png"), cam, target)
    print("VEIL_KIT_OK", {k: v["triangles"] for k, v in summary.items()})


main()
