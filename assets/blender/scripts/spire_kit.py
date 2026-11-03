"""The Warden's Spire: the black citadel, the Warden's ring cage and the ruined land (original work).

Run headless:
  blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/spire_kit.py -- [--no-preview]

Writes three GLBs to assets/blender/exports/spire/ (optimised into content/stages/wardens-spire/models):

- citadel.glb: the citadel, origin at the centre of its base on the plateau, +Y (Blender) = away
  from the viewer. Objects: citadel_base (three battered terraces, buttress piers, outer curtain
  wall and bastions), citadel_towers (secondary towers), citadel_spire (the clustered main spire,
  tier cornices, platforms, flying buttresses), citadel_crown (drum, open lantern of six ribs, top
  ring and needle finial). The Warden's cage sits inside the lantern at WARDEN_Z.
- citadel_lod1.glb: the same silhouette without the small details (low detail settings).
- warden.glb: the cage, every part pivoting at the origin (the cage centre): cage_ring_a/b/c
  (carved stone hoops, voussoir blocks with iron bands), cage_collar (the square aperture housing
  on the beam side, beam along Blender +Y) and cage_shutter_0..3 (the four sliding stone shutters).
- ruins.glb: ruin_tower_a, ruin_tower_b, ruin_wall_a, ruin_wall_b, ruin_bridge (origin at the deck
  centre, deck top at z = 0), ruin_spire, ruin_gate; origins at the base centre.

Material names (the game's TSL materials match them): spireStone, spireMetal, spireGlow,
wardenStone, wardenMetal, ruinStone, ruinGlow.

Deterministic: a fixed seed, so running it again reproduces the same files.
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

ROOT = common.ROOT
EXPORT = os.path.join(ROOT, "assets", "blender", "exports", "spire")
SOURCE = os.path.join(ROOT, "assets", "blender", "source", "environments", "wardens_spire.blend")
PREVIEW = os.path.join(ROOT, "assets", "blender", "previews")
NO_PREVIEW = "--no-preview" in common.args()

# Height of the Warden's cage centre above the plateau (the crown is built around it).
WARDEN_Z = 395.0
TAU = math.pi * 2
# Footprint scale of the fortress terraces, walls and towers around the spire.
FOOT = 0.8

rng = random.Random(3307)


# ----------------------------------------------------------------------------------------------
# Mesh building helpers (one bmesh per object, a material index per face)
# ----------------------------------------------------------------------------------------------

class Builder:
    def __init__(self, name: str, materials: list[str]):
        self.name = name
        self.bm = bmesh.new()
        self.materials = materials

    def mat(self, name: str) -> int:
        return self.materials.index(name)

    def face(self, verts, mat: int):
        try:
            f = self.bm.faces.new(verts)
            f.material_index = mat
            return f
        except ValueError:
            return None

    def finish(self, mats: dict) -> bpy.types.Object:
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=0.001)
        self.bm.normal_update()
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        obj = bpy.data.objects.new(self.name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        for m in self.materials:
            mesh.materials.append(mats[m])
        for poly in mesh.polygons:
            poly.use_smooth = False
        return obj


def ngon(n: int, r: float, rot: float = 0.0, sx: float = 1.0, sy: float = 1.0):
    return [(r * sx * math.cos(rot + TAU * i / n), r * sy * math.sin(rot + TAU * i / n)) for i in range(n)]


def star(n: int, r_out: float, r_in: float, rot: float = 0.0):
    """A 2n-gon alternating outer and inner radii: deep recessed grooves between ridges."""
    pts = []
    for i in range(n * 2):
        r = r_out if i % 2 == 0 else r_in
        a = rot + math.pi * i / n
        pts.append((r * math.cos(a), r * math.sin(a)))
    return pts


def chamfered(pts, cut: float):
    """Cuts every corner of a polygon by `cut` (fraction of the shorter adjacent edge)."""
    out = []
    n = len(pts)
    for i in range(n):
        p = Vector(pts[i])
        a = Vector(pts[i - 1])
        b = Vector(pts[(i + 1) % n])
        out.append(tuple(p.lerp(a, cut)))
        out.append(tuple(p.lerp(b, cut)))
    return out


def prism(b: Builder, prof, z0: float, z1: float, *, c=(0.0, 0.0), s0=1.0, s1=1.0, mat="spireStone", top=True, bottom=False, twist=0.0, offset1=(0.0, 0.0)):
    """Tapered extrusion of a closed CCW profile from z0 (scale s0) to z1 (scale s1)."""
    m = b.mat(mat)
    lo, hi = [], []
    for x, y in prof:
        lo.append(b.bm.verts.new((c[0] + x * s0, c[1] + y * s0, z0)))
        ct, st = math.cos(twist), math.sin(twist)
        xr, yr = x * ct - y * st, x * st + y * ct
        hi.append(b.bm.verts.new((c[0] + offset1[0] + xr * s1, c[1] + offset1[1] + yr * s1, z1)))
    n = len(prof)
    for i in range(n):
        j = (i + 1) % n
        b.face([lo[i], lo[j], hi[j], hi[i]], m)
    if top:
        b.face(hi, m)
    if bottom:
        b.face(list(reversed(lo)), m)
    return lo, hi


def pyramid(b: Builder, prof, z0: float, z1: float, *, c=(0.0, 0.0), s0=1.0, mat="spireStone", apex_offset=(0.0, 0.0)):
    m = b.mat(mat)
    ring = [b.bm.verts.new((c[0] + x * s0, c[1] + y * s0, z0)) for x, y in prof]
    apex = b.bm.verts.new((c[0] + apex_offset[0], c[1] + apex_offset[1], z1))
    n = len(ring)
    for i in range(n):
        b.face([ring[i], ring[(i + 1) % n], apex], m)


def box(b: Builder, center, size, *, rot=0.0, mat="spireStone", taper=1.0, bottom=False):
    """Box (optionally tapering towards its top) rotated about Z."""
    cx, cy, cz = center
    sx, sy, sz = size
    prof = [(-sx / 2, -sy / 2), (sx / 2, -sy / 2), (sx / 2, sy / 2), (-sx / 2, sy / 2)]
    prof = [(x * math.cos(rot) - y * math.sin(rot), x * math.sin(rot) + y * math.cos(rot)) for x, y in prof]
    prism(b, prof, cz - sz / 2, cz + sz / 2, c=(cx, cy), s0=1.0, s1=taper, mat=mat, bottom=bottom)


def beam_between(b: Builder, p0, p1, w: float, d: float, *, mat="spireStone", taper=1.0):
    """A strut of rectangular section (w across, d in the 'up' plane) from p0 to p1."""
    p0, p1 = Vector(p0), Vector(p1)
    axis = (p1 - p0)
    length = axis.length
    if length < 1e-3:
        return
    t = axis / length
    up = Vector((0, 0, 1))
    side = t.cross(up)
    if side.length < 1e-3:
        side = Vector((1, 0, 0))
    side.normalize()
    nrm = side.cross(t).normalized()
    m = b.mat(mat)
    corners = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    lo = [b.bm.verts.new(p0 + side * (sx * w / 2) + nrm * (sy * d / 2)) for sx, sy in corners]
    hi = [b.bm.verts.new(p1 + side * (sx * w / 2 * taper) + nrm * (sy * d / 2 * taper)) for sx, sy in corners]
    for i in range(4):
        j = (i + 1) % 4
        b.face([lo[i], lo[j], hi[j], hi[i]], m)
    b.face(list(reversed(lo)), m)
    b.face(hi, m)


def slits_on_prism(b: Builder, prof, z0, z1, *, c=(0.0, 0.0), s0=1.0, s1=1.0, every=22.0, w=1.8, h=7.0, start=12.0, chance=0.8, mat="spireGlow", skip_inner=0.0, cols=1):
    """Thin glowing slits standing slightly proud of each face of a prism (windows into the fire)."""
    n = len(prof)
    z = z0 + start
    while z < z1 - h:
        k = (z - z0) / (z1 - z0)
        s = s0 + (s1 - s0) * k
        for i in range(n):
            a = Vector(prof[i]) * s
            bb = Vector(prof[(i + 1) % n]) * s
            edge = bb - a
            length = edge.length
            if length < w * 3:
                continue
            mid_r = ((a + bb) / 2).length
            if skip_inner and mid_r < skip_inner * s:
                continue
            normal = Vector((edge.y, -edge.x)).normalized()
            for col in range(cols):
                if rng.random() > chance:
                    continue
                f = (col + 1) / (cols + 1)
                p = a + edge * f + normal * 0.35
                rot = math.atan2(edge.y, edge.x)
                box(b, (c[0] + p.x, c[1] + p.y, z + h / 2), (w, 0.8, h), rot=rot, mat=mat)
        z += every


def battered_terrace(b: Builder, pts, z0, z1, batter, *, mat="spireStone", piers=0.0, pier_size=(7.0, 4.0), slit_rows=0, slit_every=16.0):
    """A terrace with sloping walls (the top polygon shrinks towards the centroid) plus buttress piers."""
    cx = sum(p[0] for p in pts) / len(pts)
    cy = sum(p[1] for p in pts) / len(pts)
    rel = [(x - cx, y - cy) for x, y in pts]
    radius = max(math.hypot(x, y) for x, y in rel)
    s1 = 1.0 - batter * (z1 - z0) / radius
    prism(b, chamfered(rel, 0.06), z0, z1, c=(cx, cy), s0=1.0, s1=s1, mat=mat, bottom=False)
    # Parapet lip.
    prism(b, chamfered(rel, 0.06), z1, z1 + 2.2, c=(cx, cy), s0=s1 * 1.008, s1=s1 * 1.008, mat="spireMetal")
    if piers > 0:
        n = len(rel)
        for i in range(n):
            a = Vector(rel[i])
            bb = Vector(rel[(i + 1) % n])
            edge = bb - a
            length = edge.length
            count = int(length // piers)
            normal = Vector((edge.y, -edge.x)).normalized()
            for k in range(1, count):
                f = k / count
                base = a + edge * f
                top = base * s1
                pw, pd = pier_size
                p0 = Vector((cx + base.x + normal.x * pd * 0.5, cy + base.y + normal.y * pd * 0.5, z0))
                p1 = Vector((cx + top.x + normal.x * pd * 0.2, cy + top.y + normal.y * pd * 0.2, z1 + 6.0))
                beam_between(b, p0, p1, pw, pd, mat=mat, taper=0.7)
                if slit_rows and rng.random() < 0.75:
                    for r in range(slit_rows):
                        zz = z0 + (r + 1) * (z1 - z0) / (slit_rows + 1)
                        ff = (zz - z0) / (z1 - z0)
                        mid = base.lerp(top, ff) + edge.normalized() * (piers * 0.5) - normal * 0.0
                        mid = base.lerp(top, ff) + edge * (0.5 / count)
                        box(b, (cx + mid.x + normal.x * 0.4, cy + mid.y + normal.y * 0.4, zz), (1.6, 0.8, 6.0), rot=math.atan2(edge.y, edge.x), mat="spireGlow")


def tower(b: Builder, c, z0, height, r, *, sides=5, cap="flat", bands=2, slits=True, detail=True, lean=(0.0, 0.0)):
    """A secondary tower: a battered angular prism, cornice bands and a severe crown.

    cap: "flat" (stepped flat roof), "low" (low pyramid), "needle" (a tall thin needle).
    """
    rot = rng.random() * TAU
    prof = chamfered(ngon(sides, r, rot), 0.1)
    taper = 0.8
    z1 = z0 + height
    prism(b, prof, z0, z1, c=c, s0=1.0, s1=taper, mat="spireStone", offset1=lean)
    top_c = (c[0] + lean[0], c[1] + lean[1])
    for i in range(bands):
        zb = z0 + height * (i + 1) / (bands + 1)
        k = (zb - z0) / height
        s = 1.0 + (taper - 1.0) * k
        prism(b, chamfered(ngon(sides, r * 1.06, rot), 0.1), zb, zb + 2.4, c=(c[0] + lean[0] * k, c[1] + lean[1] * k), s0=s, s1=s, mat="spireMetal")
    if slits and detail:
        slits_on_prism(b, prof, z0, z1 - 6.0, c=c, s0=1.0, s1=taper, every=rng.uniform(17.0, 26.0), w=1.3, h=rng.uniform(4.0, 7.0), start=rng.uniform(6.0, 14.0), chance=0.35)
    rt = r * taper
    prism(b, chamfered(ngon(sides, rt * 1.08, rot), 0.1), z1, z1 + 5.0, c=top_c, mat="spireStone")
    if cap == "flat":
        prism(b, chamfered(ngon(sides, rt * 0.8, rot), 0.1), z1 + 5.0, z1 + 9.0, c=top_c, mat="spireMetal")
    elif cap == "low":
        pyramid(b, chamfered(ngon(sides, rt * 1.02, rot), 0.1), z1 + 5.0, z1 + 5.0 + rt * 1.1, c=top_c, mat="spireStone")
    else:
        pyramid(b, ngon(sides, rt * 0.7, rot), z1 + 5.0, z1 + 5.0 + height * 0.55, c=top_c, mat="spireStone")


def fin(b: Builder, ang: float, steps, *, thick: float, detail: bool, drops=(0.42, 0.36, 0.3)):
    """A blade buttress radiating from the core: vertical slabs that step back as they rise."""
    d = Vector((math.cos(ang), math.sin(ang), 0))
    side = Vector((-d.y, d.x, 0))
    for i, (z0, z1, r0, r1) in enumerate(steps):
        # Outer face battered slightly inward; the top of each step slopes down outward.
        t = thick * (1.0 - 0.12 * i)
        corners_lo = [d * r0 + side * (-t / 2), d * r1 + side * (-t / 2), d * r1 + side * (t / 2), d * r0 + side * (t / 2)]
        inset = (r1 - r0) * 0.06
        corners_hi = [d * r0 + side * (-t / 2), d * (r1 - inset) + side * (-t / 2), d * (r1 - inset) + side * (t / 2), d * r0 + side * (t / 2)]
        m = b.mat("spireStone")
        lo = [b.bm.verts.new((p.x, p.y, z0)) for p in corners_lo]
        top_drop = (z1 - z0) * drops[min(i, len(drops) - 1)]
        hi = [b.bm.verts.new((p.x, p.y, z1 - (top_drop if j in (1, 2) else 0.0))) for j, p in enumerate(corners_hi)]
        for k in range(4):
            j = (k + 1) % 4
            b.face([lo[k], lo[j], hi[j], hi[k]], m)
        b.face(hi, m)
        b.face(list(reversed(lo)), m)
        # Iron cap strip along the sloping top.
        mid_hi = (Vector(hi[1].co) + Vector(hi[2].co)) / 2
        mid_in = (Vector(hi[0].co) + Vector(hi[3].co)) / 2
        beam_between(b, mid_in + Vector((0, 0, 0.6)), mid_hi + Vector((0, 0, 0.6)), t * 1.06, 1.4, mat="spireMetal")
        if detail:
            # Glowing slits on the fin's outer face, irregular.
            for z in range(int(z0 + 10), int(z1 - top_drop - 8), int(rng.uniform(19, 31))):
                if rng.random() < 0.45:
                    p = d * (r1 - inset * (z - z0) / (z1 - z0) + 0.35)
                    box(b, (p.x, p.y, z + 3), (0.8, 1.3, rng.uniform(4.0, 7.5)), rot=ang, mat="spireGlow")


def build_citadel(mats, detail: bool, suffix: str):
    objs = []
    stone = ["spireStone", "spireMetal", "spireGlow"]

    # --- Base: three battered terraces with buttress piers, an outer curtain wall with bastions.
    base = Builder("citadel_base" + suffix, stone)
    t1 = [(-150, -150), (40, -178), (230, -150), (300, -40), (285, 120), (150, 190), (-60, 185), (-175, 70)]
    t2 = [(-110, -108), (40, -128), (175, -104), (220, -20), (205, 100), (110, 140), (-50, 135), (-125, 50)]
    t3 = [(-80, -86), (30, -96), (112, -76), (136, 0), (122, 80), (45, 106), (-44, 100), (-90, 32)]
    # The fortress footprint is kept compact so the spire dominates the silhouette.
    t1 = [(x * FOOT, y * FOOT) for x, y in t1]
    t2 = [(x * FOOT, y * FOOT) for x, y in t2]
    battered_terrace(base, t1, 0.0, 38.0, 0.20, piers=34.0 if detail else 0.0, pier_size=(9.0, 6.0), slit_rows=1 if detail else 0)
    battered_terrace(base, t2, 38.0, 70.0, 0.18, piers=30.0 if detail else 0.0, pier_size=(8.0, 5.0), slit_rows=1 if detail else 0)
    battered_terrace(base, t3, 70.0, 96.0, 0.16, piers=0.0)
    # Halls on the terraces: long blocks with low metal roofs.
    halls = [((170, -60, 38), (70, 26, 18), 0.35), ((150, 80, 38), (60, 30, 22), -0.4), ((-90, 60, 38), (50, 24, 16), 0.9), ((-40, -66, 70), (46, 20, 14), -0.15)]
    halls = [((x * FOOT, y * FOOT, z), (sx * FOOT, sy, sz), r) for (x, y, z), (sx, sy, sz), r in halls]
    for (x, y, z), (sx, sy, sz), r in halls:
        box(base, (x, y, z + sz / 2), (sx, sy, sz), rot=r, mat="spireStone")
        box(base, (x, y, z + sz + 3.0), (sx * 1.02, sy * 0.6, 6.0), rot=r, mat="spireMetal", taper=0.25)
        if detail:
            for k in range(-2, 3):
                if rng.random() < 0.45:
                    continue
                ox, oy = math.cos(r) * k * sx / 5.5, math.sin(r) * k * sx / 5.5
                nx, ny = -math.sin(r) * (sy / 2 + 0.4), math.cos(r) * (sy / 2 + 0.4)
                box(base, (x + ox - nx, y + oy - ny, z + sz * 0.55), (1.6, 0.8, sz * 0.45), rot=r, mat="spireGlow")
    # Outer curtain wall: thick walls between heavy flat-topped bastions, a gate on the front.
    wall = [(-260, -120), (-200, -250), (-20, -280), (190, -270), (360, -190), (420, -20), (400, 170), (290, 300)]
    wall = [(x * FOOT, y * FOOT) for x, y in wall]
    for i in range(len(wall) - 1):
        a = Vector((*wall[i], 0))
        bb = Vector((*wall[i + 1], 0))
        d = bb - a
        rot = math.atan2(d.y, d.x)
        mid = (a + bb) / 2
        length = d.length
        if i == 2:
            for sgn in (-1, 1):
                p = mid + d.normalized() * sgn * (length * 0.29)
                box(base, (p.x, p.y, 14.0), (length * 0.42, 10.0, 28.0), rot=rot, mat="spireStone", taper=0.94)
                g = mid + d.normalized() * sgn * 17.0
                prism(base, chamfered(ngon(4, 13.0, rot + math.pi / 4), 0.15), 0.0, 64.0, c=(g.x, g.y), s0=1.0, s1=0.82, mat="spireStone")
                prism(base, chamfered(ngon(4, 11.6, rot + math.pi / 4), 0.15), 64.0, 68.0, c=(g.x, g.y), mat="spireMetal")
            box(base, (mid.x, mid.y, 44.0), (30.0, 11.0, 9.0), rot=rot, mat="spireStone")
        else:
            box(base, (mid.x, mid.y, 13.0), (length + 4.0, 10.0, 26.0), rot=rot, mat="spireStone", taper=0.94)
            box(base, (mid.x, mid.y, 27.0), (length + 4.0, 11.0, 2.4), rot=rot, mat="spireMetal")
            if detail:
                count = max(2, int(length // 30))
                nrm = Vector((d.y, -d.x, 0)).normalized()
                for k in range(1, count):
                    p = a + d * (k / count)
                    beam_between(base, p + nrm * 8.5, p + nrm * 4.5 + Vector((0, 0, 28)), 5.0, 6.0, mat="spireStone", taper=0.8)
                    q = a + d * ((k + 0.5) / count) + nrm * 5.2
                    if rng.random() < 0.35:
                        box(base, (q.x, q.y, 15.0), (1.4, 0.8, 5.0), rot=rot, mat="spireGlow")
    for x, y in wall[1:-1]:
        r = rng.uniform(20, 26)
        h = rng.uniform(46, 64)
        prism(base, chamfered(ngon(5, r, rng.random() * TAU), 0.12), 0.0, h, c=(x, y), s0=1.0, s1=0.8, mat="spireStone")
        prism(base, chamfered(ngon(5, r * 0.84, 0), 0.12), h, h + 3.0, c=(x, y), mat="spireMetal")
        if detail:
            slits_on_prism(base, ngon(5, r), 0.0, h - 6.0, c=(x, y), s0=1.0, s1=0.8, every=19.0, w=1.3, h=5.0, start=9.0, chance=0.3)
    for x, y in (wall[0], wall[-1]):
        prism(base, chamfered(ngon(4, 11.0, 0.3), 0.15), 0.0, 30.0 + rng.uniform(0, 10), c=(x, y), s0=1.0, s1=0.85, mat="spireStone")
    objs.append(base.finish(mats))

    # --- Secondary towers: few, massive and severe.
    tw = Builder("citadel_towers" + suffix, stone)
    towers = [
        ((232, -138), 0, 118, 21, 5, "flat"), ((292, -24), 0, 150, 19, 5, "low"), ((268, 118), 0, 104, 20, 4, "flat"),
        ((-156, -128), 0, 86, 19, 4, "flat"), ((182, -92), 38, 176, 15, 5, "needle"), ((206, 92), 38, 132, 16, 5, "flat"),
        ((-112, 46), 38, 98, 15, 4, "low"),
    ]
    for (x, y), z0, h, r, sides, cap in towers:
        x, y = x * FOOT, y * FOOT
        tower(tw, (x, y), z0, h, r, sides=sides, cap=cap, bands=2 if h < 130 else 3, detail=detail)
    objs.append(tw.finish(mats))

    # --- The main spire: a recessed core held by blade buttresses that step back as they rise.
    sp = Builder("citadel_spire" + suffix, stone)
    core_prof = star(8, 34.0, 26.0, math.pi / 8)
    core_top = 340.0
    s_top = 0.68
    prism(sp, core_prof, 96.0, core_top, s0=1.0, s1=s_top, mat="spireStone")
    if detail:
        slits_on_prism(sp, core_prof, 110.0, core_top - 10.0, s0=0.97, s1=s_top, every=23.0, w=1.8, h=7.5, start=6.0, chance=0.42, skip_inner=29.0)
    for zb in (186.0, 262.0, 318.0):
        s = 1.0 + (s_top - 1.0) * (zb - 96.0) / (core_top - 96.0)
        prism(sp, chamfered(ngon(8, 37.5, math.pi / 8), 0.15), zb, zb + 4.5, s0=s, s1=s, mat="spireMetal")
    fins = []
    for k in range(12):
        major = k % 2 == 0
        ang = math.pi / 12 + TAU * k / 12 + rng.uniform(-0.03, 0.03)
        if major:
            h1 = 212.0 + rng.uniform(-16, 16)
            h2 = 290.0 + rng.uniform(-14, 12)
            h3 = 334.0 + rng.uniform(-10, 4)
            reach = rng.uniform(0.94, 1.1)
            steps = [(96.0, h1, 26.0, 90.0 * reach), (h1 - 4.0, h2, 24.0, 60.0 * reach), (h2 - 4.0, h3, 21.0, 41.0)]
        else:
            h1 = 156.0 + rng.uniform(-14, 18)
            h2 = 238.0 + rng.uniform(-16, 16)
            reach = rng.uniform(0.9, 1.05)
            steps = [(96.0, h1, 26.0, 70.0 * reach), (h1 - 4.0, h2, 24.0, 46.0 * reach)]
        fins.append((ang, steps))
        fin(sp, ang, steps, thick=10.0 if major else 6.5, detail=detail)
    # Two tall needle spires rising from the spire mass ("spires into the clouds").
    for ang, dist, z0, h, r in ((0.9, 62.0, 172.0, 190.0, 11.0), (3.6, 56.0, 246.0, 150.0, 9.0), (2.3, 70.0, 150.0, 170.0, 10.0)):
        c = (math.cos(ang) * dist, math.sin(ang) * dist)
        prism(sp, chamfered(ngon(6, r, ang), 0.12), z0, z0 + h * 0.55, c=c, s0=1.0, s1=0.75, mat="spireStone")
        prism(sp, ngon(12, r * 0.85, 0), z0 + h * 0.55, z0 + h * 0.55 + 2.5, c=c, mat="spireMetal")
        pyramid(sp, ngon(6, r * 0.72, ang), z0 + h * 0.55 + 2.5, z0 + h, c=c, mat="spireStone")
    # Cantilevered platforms with iron struts between the fins.
    if detail:
        for ang, z, w, d in ((0.0, 214.0, 22.0, 16.0), (2.36, 196.0, 20.0, 14.0), (3.93, 282.0, 16.0, 12.0), (5.5, 236.0, 18.0, 13.0)):
            s = 1.0 + (s_top - 1.0) * (z - 96.0) / (core_top - 96.0)
            rr = 30.0 * s + d / 2
            p = (math.cos(ang) * rr, math.sin(ang) * rr)
            box(sp, (p[0], p[1], z), (d, w, 3.0), rot=ang, mat="spireStone")
            box(sp, (p[0], p[1], z + 2.6), (d * 0.98, w * 0.98, 1.2), rot=ang, mat="spireMetal")
            for sgn in (-1, 1):
                q = Vector((p[0], p[1], z - 1.5)) + Vector((-math.sin(ang), math.cos(ang), 0)) * (w * 0.4 * sgn)
                beam_between(sp, q + Vector((math.cos(ang), math.sin(ang), 0)) * (d * 0.45), q - Vector((math.cos(ang), math.sin(ang), 0)) * (d * 0.5) - Vector((0, 0, 18)), 2.0, 2.0, mat="spireMetal")
    objs.append(sp.finish(mats))

    # --- The crown: drum, an open lantern of six blade ribs, the top ring and the needle finial.
    cr = Builder("citadel_crown" + suffix, stone)
    prism(cr, chamfered(ngon(8, 30.0, math.pi / 8), 0.14), core_top, core_top + 14.0, s0=1.0, s1=1.22, mat="spireStone")
    prism(cr, chamfered(ngon(8, 37.5, math.pi / 8), 0.14), core_top + 14.0, core_top + 18.0, mat="spireMetal")
    floor_z = core_top + 18.0
    prism(cr, chamfered(ngon(8, 34.0, math.pi / 8), 0.14), floor_z, floor_z + 3.0, s0=1.0, s1=0.9, mat="spireStone")
    # Cradle: a low plinth with the lower bearing of the cage spindle.
    prism(cr, ngon(12, 12.0, 0), floor_z + 3.0, floor_z + 10.0, s0=1.0, s1=0.6, mat="spireStone")
    ribs = 6
    top_ring_z = WARDEN_Z + 60.0
    for k in range(ribs):
        a = TAU * k / ribs + math.pi / 6
        dirv = Vector((math.cos(a), math.sin(a), 0))
        pts = [
            dirv * 33.0 + Vector((0, 0, floor_z)),
            dirv * 53.0 + Vector((0, 0, WARDEN_Z - 6.0)),
            dirv * 49.0 + Vector((0, 0, WARDEN_Z + 22.0)),
            dirv * 25.0 + Vector((0, 0, top_ring_z)),
        ]
        for i in range(len(pts) - 1):
            # Blade ribs: thin across, deep radially.
            p0, p1 = pts[i], pts[i + 1]
            t = (p1 - p0).normalized()
            side = t.cross(Vector((0, 0, 1)))
            if side.length < 1e-3:
                side = Vector((-dirv.y, dirv.x, 0))
            side.normalize()
            radial = side.cross(t).normalized()
            m = cr.mat("spireStone")
            wv = 5.0 - i * 0.6
            dv = 11.0 - i * 1.6
            cs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
            lo = [cr.bm.verts.new(p0 + side * (sx * wv / 2) + radial * (sy * dv / 2)) for sx, sy in cs]
            hi = [cr.bm.verts.new(p1 + side * (sx * wv / 2 * 0.95) + radial * (sy * dv / 2 * 0.9)) for sx, sy in cs]
            for q in range(4):
                j = (q + 1) % 4
                cr.face([lo[q], lo[j], hi[j], hi[q]], m)
            cr.face(list(reversed(lo)), m)
            cr.face(hi, m)
        if detail:
            for i in (1, 2):
                p = pts[i]
                beam_between(cr, p - dirv * 6.0 - Vector((0, 0, 1.6)), p - dirv * 6.0 + Vector((0, 0, 1.6)), 6.5, 2.0, mat="spireMetal")
    ring_pts = chamfered(ngon(6, 28.0, math.pi / 6), 0.18)
    prism(cr, ring_pts, top_ring_z - 4.0, top_ring_z + 6.0, s0=1.0, s1=0.9, mat="spireStone")
    prism(cr, chamfered(ngon(6, 29.5, math.pi / 6), 0.18), top_ring_z - 5.0, top_ring_z - 3.0, mat="spireMetal")
    # Needle finial.
    prism(cr, chamfered(ngon(6, 15.0, 0), 0.12), top_ring_z + 6.0, top_ring_z + 36.0, s0=1.0, s1=0.62, mat="spireStone")
    for i, z in enumerate((top_ring_z + 20.0, top_ring_z + 36.0)):
        prism(cr, chamfered(ngon(6, 10.5 - i * 1.6, 0), 0.12), z, z + 2.5, mat="spireMetal")
    prism(cr, chamfered(ngon(6, 8.6, 0), 0.12), top_ring_z + 38.5, top_ring_z + 118.0, s0=1.0, s1=0.06, mat="spireStone")
    prism(cr, ngon(8, 3.0, 0), floor_z + 10.0, WARDEN_Z - 42.0, mat="spireMetal")
    prism(cr, ngon(8, 3.0, 0), WARDEN_Z + 42.0, top_ring_z - 4.0, mat="spireMetal")
    if detail:
        slits_on_prism(cr, chamfered(ngon(8, 30.0, math.pi / 8), 0.14), core_top, core_top + 14.0, s0=1.0, s1=1.22, every=30.0, w=2.0, h=5.0, start=4.0, chance=0.7)
    objs.append(cr.finish(mats))
    _ = fins

    if detail:
        for o in objs:
            mod = o.modifiers.new("bevel", "BEVEL")
            mod.width = 0.45
            mod.segments = 1
            mod.limit_method = "ANGLE"
            mod.angle_limit = math.radians(30)
    return objs


# ----------------------------------------------------------------------------------------------
# The Warden's cage
# ----------------------------------------------------------------------------------------------

def hoop(b: Builder, radius: float, w: float, d: float, blocks: int, frame: Matrix, *, gap=0.35, mat="wardenStone", band="wardenMetal", notch=True):
    """A ring of voussoir blocks (w radial x d axial), with an iron band on the outer face."""
    for i in range(blocks):
        a0 = TAU * (i + gap * 0.5 / 1.0 * 0.02) / blocks
        a1 = TAU * (i + 1 - 0.02 * gap) / blocks
        sub = 3
        for s in range(sub):
            t0 = a0 + (a1 - a0) * s / sub
            t1 = a0 + (a1 - a0) * (s + 1) / sub
            corners = []
            for t in (t0, t1):
                for rr, zz in ((radius - w / 2, -d / 2), (radius + w / 2, -d / 2), (radius + w / 2, d / 2), (radius - w / 2, d / 2)):
                    corners.append(frame @ Vector((math.cos(t) * rr, math.sin(t) * rr, zz)))
            v = [b.bm.verts.new(c) for c in corners]
            m = b.mat(mat)
            for k in range(4):
                j = (k + 1) % 4
                b.face([v[k], v[j], v[4 + j], v[4 + k]], m)
            if s == 0:
                b.face(list(reversed(v[0:4])), m)
            if s == sub - 1:
                b.face(v[4:8], m)
        if notch:
            # A carved boss on every block's outer face.
            t = (a0 + a1) / 2
            c = frame @ Vector((math.cos(t) * (radius + w / 2 + 0.6), math.sin(t) * (radius + w / 2 + 0.6), 0))
            nrm = (frame.to_3x3() @ Vector((math.cos(t), math.sin(t), 0))).normalized()
            beam_between(b, c - nrm * 0.8, c + nrm * 1.2, d * 0.45, d * 0.55, mat=mat, taper=0.7)
    # Iron band around the outer face.
    seg = blocks * 3
    for i in range(seg):
        t0 = TAU * i / seg
        t1 = TAU * (i + 1) / seg
        p0 = frame @ Vector((math.cos(t0) * (radius + w / 2 + 0.15), math.sin(t0) * (radius + w / 2 + 0.15), 0))
        p1 = frame @ Vector((math.cos(t1) * (radius + w / 2 + 0.15), math.sin(t1) * (radius + w / 2 + 0.15), 0))
        beam_between(b, p0, p1, 0.6, d * 0.35, mat=band)


def build_warden(mats):
    objs = []
    names = ["wardenStone", "wardenMetal"]
    # Ring A: the largest, a vertical hoop (its axis horizontal, along X). Rings B and C are
    # set at oblique angles so no view ever lines them up concentrically.
    specs = [
        ("cage_ring_a", 40.0, 5.0, 4.2, 22, Matrix.Rotation(math.pi / 2, 4, "Y")),
        ("cage_ring_b", 35.0, 4.4, 3.8, 20, Matrix.Rotation(math.radians(64), 4, "X") @ Matrix.Rotation(math.radians(20), 4, "Y")),
        ("cage_ring_c", 30.0, 4.0, 3.4, 18, Matrix.Rotation(math.radians(-28), 4, "X") @ Matrix.Rotation(math.radians(-58), 4, "Y")),
    ]
    for name, r, w, d, n, frame in specs:
        b = Builder(name, names)
        hoop(b, r, w, d, n, frame)
        # Trunnions: two pivot blocks where the hoop meets its neighbour.
        for sgn in (-1, 1):
            p = frame @ Vector((sgn * (r + w / 2 + 1.0), 0, 0))
            q = frame @ Vector((sgn * (r - w / 2 - 1.5), 0, 0))
            beam_between(b, q, p, d * 1.3, d * 1.3, mat="wardenMetal")
        objs.append(b.finish(mats))
    # The aperture housing on the beam side (+Y): a heavy square collar and four sliding shutters.
    col = Builder("cage_collar", names)
    near, far = 15.0, 22.0
    half_out, half_in = 12.0, 7.5
    for k in range(4):
        rot = Matrix.Rotation(TAU * k / 4, 4, "Y")
        # One side of the frame: a block spanning x in [-half_out, half_out], z in [half_in, half_out].
        c0 = rot @ Vector((0, (near + far) / 2, (half_in + half_out) / 2))
        x_axis = rot @ Vector((1, 0, 0))
        y_axis = Vector((0, 1, 0))
        z_axis = rot @ Vector((0, 0, 1))
        corners = []
        for dy in (-1, 1):
            for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                hx = half_out
                hz = (half_out - half_in) / 2
                corners.append(c0 + x_axis * (dx * hx) + y_axis * (dy * (far - near) / 2) + z_axis * (dz * hz))
        v = [col.bm.verts.new(c) for c in corners]
        m = col.mat("wardenStone")
        for i in range(4):
            j = (i + 1) % 4
            col.face([v[i], v[j], v[4 + j], v[4 + i]], m)
        col.face(list(reversed(v[0:4])), m)
        col.face(v[4:8], m)
        # Struts back to the cage centre (the collar hangs on the inner ring's trunnions).
        beam_between(col, rot @ Vector((half_out - 1.5, near, half_out - 1.5)), rot @ Vector((9.0, 2.0, 9.0)), 1.8, 1.8, mat="wardenMetal")
    # Iron lip at the mouth.
    for k in range(4):
        rot = Matrix.Rotation(TAU * k / 4, 4, "Y")
        beam_between(col, rot @ Vector((-half_out, far + 0.4, half_out)), rot @ Vector((half_out, far + 0.4, half_out)), 1.2, 1.2, mat="wardenMetal")
    objs.append(col.finish(mats))
    for k in range(4):
        sh = Builder(f"cage_shutter_{k}", names)
        rot = Matrix.Rotation(TAU * k / 4, 4, "Y")
        # At rest (open) each shutter sits just inside the frame, flush with the opening's edge.
        c0 = rot @ Vector((0, (near + far) / 2 - 0.5, half_in + 1.6))
        x_axis = rot @ Vector((1, 0, 0))
        z_axis = rot @ Vector((0, 0, 1))
        corners = []
        for dy in (-1, 1):
            for dx, dz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                corners.append(c0 + x_axis * (dx * (half_in - 0.3)) + Vector((0, 1, 0)) * (dy * 2.6) + z_axis * (dz * 1.6))
        v = [sh.bm.verts.new(c) for c in corners]
        m = sh.mat("wardenStone")
        for i in range(4):
            j = (i + 1) % 4
            sh.face([v[i], v[j], v[4 + j], v[4 + i]], m)
        sh.face(list(reversed(v[0:4])), m)
        sh.face(v[4:8], m)
        objs.append(sh.finish(mats))
    for o in objs:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = 0.25
        mod.segments = 1
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
    return objs


# ----------------------------------------------------------------------------------------------
# Ruins of the land
# ----------------------------------------------------------------------------------------------

def jagged_top(b: Builder, prof, z0, z1, c, *, mat="ruinStone", s1=0.9, rough=0.35, seed=0):
    r = random.Random(seed)
    m = b.mat(mat)
    lo = [b.bm.verts.new((c[0] + x, c[1] + y, z0)) for x, y in prof]
    hi = []
    for x, y in prof:
        h = z1 * (1.0 - r.random() * rough) if r.random() < 0.7 else z1 * (1.0 - rough * 1.6 * r.random())
        hi.append(b.bm.verts.new((c[0] + x * s1, c[1] + y * s1, max(z0 + 2.0, h))))
    n = len(prof)
    for i in range(n):
        j = (i + 1) % n
        b.face([lo[i], lo[j], hi[j], hi[i]], m)
    # Thick walls: an inner shell so the broken top reads as a hollow ruin.
    inner = [b.bm.verts.new((c[0] + x * s1 * 0.78, c[1] + y * s1 * 0.78, max(z0 + 2.0, hi[i].co.z - 1.5))) for i, (x, y) in enumerate(prof)]
    for i in range(n):
        j = (i + 1) % n
        b.face([hi[i], hi[j], inner[j], inner[i]], m)
    floor = [b.bm.verts.new((c[0] + x * s1 * 0.78, c[1] + y * s1 * 0.78, z0 + 1.0)) for x, y in prof]
    for i in range(n):
        j = (i + 1) % n
        b.face([inner[i], inner[j], floor[j], floor[i]], m)


def rubble(b: Builder, c, radius, count, seed, *, mat="ruinStone"):
    r = random.Random(seed)
    for _ in range(count):
        a = r.random() * TAU
        d = radius * math.sqrt(r.random())
        s = r.uniform(1.5, 4.5)
        box(b, (c[0] + math.cos(a) * d, c[1] + math.sin(a) * d, s * 0.3), (s, s * r.uniform(0.6, 1.2), s * 0.7), rot=r.random() * TAU, mat=mat, taper=r.uniform(0.6, 1.0))


def arch_span(b: Builder, x0, x1, deck, width, rise, *, mat="ruinStone", segs=9):
    """A semicircular-ish arch of voussoirs between x0 and x1, crown just below the deck."""
    span = x1 - x0
    cx = (x0 + x1) / 2
    r = span / 2
    for i in range(segs):
        t0 = math.pi * i / segs
        t1 = math.pi * (i + 1) / segs
        p0 = Vector((cx - math.cos(t0) * r, 0, deck - rise + math.sin(t0) * rise))
        p1 = Vector((cx - math.cos(t1) * r, 0, deck - rise + math.sin(t1) * rise))
        beam_between(b, p0, p1, width, 3.2, mat=mat)


def build_ruins(mats):
    objs = []
    names = ["ruinStone", "ruinGlow"]
    # Octagonal tower with a broken crown.
    b = Builder("ruin_tower_a", names)
    jagged_top(b, chamfered(ngon(8, 9.0, 0.2), 0.1), 0.0, 48.0, (0, 0), s1=0.86, rough=0.45, seed=11)
    for z in (14.0, 28.0):
        prism(b, ngon(16, 9.6 * (1 - 0.14 * z / 48), 0), z, z + 1.6, mat="ruinStone")
    for k in range(5):
        a = TAU * k / 5 + 0.3
        box(b, (math.cos(a) * 8.3, math.sin(a) * 8.3, 20.0 + k * 3), (1.2, 0.8, 4.0), rot=a + math.pi / 2, mat="ruinGlow")
    rubble(b, (0, 0), 20.0, 22, 12)
    objs.append(b.finish(mats))
    # Square keep with a collapsed side.
    b = Builder("ruin_tower_b", names)
    for k, (h, cut) in enumerate(((34.0, 0.0), (30.0, 0.0), (17.0, 0.4), (33.0, 0.0))):
        a = TAU * k / 4
        c = (math.cos(a) * 6.0, math.sin(a) * 6.0)
        r = random.Random(40 + k)
        prof = [(-1.6, -7.5), (1.6, -7.5), (1.6, 7.5), (-1.6, 7.5)]
        prof = [(x * math.cos(a) - y * math.sin(a), x * math.sin(a) + y * math.cos(a)) for x, y in prof]
        jagged_top(b, prof, 0.0, h, c, s1=0.97, rough=0.35 + cut, seed=40 + k)
        _ = r
    rubble(b, (5, -10), 16.0, 26, 41)
    objs.append(b.finish(mats))
    # Long broken wall with a gap.
    b = Builder("ruin_wall_a", names)
    for k, (x0, x1, h) in enumerate(((-30.0, -6.0, 15.0), (6.0, 18.0, 11.0), (18.0, 32.0, 14.0))):
        prof = [(x0, -2.6), (x1, -2.6), (x1, 2.6), (x0, 2.6)]
        n = 6
        pts = []
        for i in range(n + 1):
            pts.append((x0 + (x1 - x0) * i / n, -2.6))
        for i in range(n, -1, -1):
            pts.append((x0 + (x1 - x0) * i / n, 2.6))
        jagged_top(b, pts, 0.0, h, (0, 0), s1=1.0, rough=0.4, seed=60 + k)
        for i in range(1, int((x1 - x0) // 8) + 1):
            box(b, (x0 + i * 8 - 4, -3.6, h * 0.35), (3.0, 2.4, h * 0.7), mat="ruinStone", taper=0.6)
        _ = prof
    rubble(b, (0, -4), 14.0, 20, 61)
    objs.append(b.finish(mats))
    # L-shaped wall with buttresses.
    b = Builder("ruin_wall_b", names)
    for k, (x0, y0, x1, y1, h) in enumerate(((-20.0, -2.0, 14.0, 2.0, 13.0), (10.0, 2.0, 14.0, 26.0, 10.0))):
        pts = [(x0, y0), (x1, y0), (x1, y1), (x0, y1)]
        jagged_top(b, pts, 0.0, h, (0, 0), s1=1.0, rough=0.5, seed=70 + k)
    rubble(b, (0, 8), 12.0, 14, 71)
    objs.append(b.finish(mats))
    # The broken bridge: two piers and three arches with the middle span fallen.
    b = Builder("ruin_bridge", names)
    deck = 0.0
    width = 9.0
    piers = (-34.0, -12.0, 12.0, 34.0)
    for x in piers:
        prism(b, chamfered([(-3.5, -5.5), (3.5, -5.5), (3.5, 5.5), (-3.5, 5.5)], 0.2), -46.0, deck - 1.0, c=(x, 0), s0=1.25, s1=1.0, mat="ruinStone")
        # Cutwaters.
        pyramid(b, [(-3.5, 0), (0, -6.5), (3.5, 0)], -46.0, deck - 10.0, c=(x, -5.0), mat="ruinStone")
    spans = ((-58.0, -34.0), (-34.0, -12.0), (12.0, 34.0), (34.0, 58.0))
    for x0, x1 in spans:
        arch_span(b, x0, x1, deck - 1.0, width, 10.0)
        box(b, ((x0 + x1) / 2, 0, deck - 1.2), (x1 - x0 + 0.5, width + 1.0, 2.4), mat="ruinStone")
        # Parapets.
        for sgn in (-1, 1):
            box(b, ((x0 + x1) / 2, sgn * (width / 2 + 0.2), deck + 0.8), (x1 - x0, 0.9, 1.8), mat="ruinStone")
    # The broken middle: stubs of the fallen span reaching out from each pier.
    for sgn in (-1, 1):
        x = sgn * 12.0
        beam_between(b, Vector((x, 0, deck - 1.0)), Vector((x - sgn * 7.0, 0, deck - 3.5)), width, 2.4, mat="ruinStone", taper=0.7)
    objs.append(b.finish(mats))
    # A broken spire stump, leaning.
    b = Builder("ruin_spire", names)
    prism(b, star(5, 7.0, 5.4, 0.4), 0.0, 38.0, s0=1.0, s1=0.72, mat="ruinStone", offset1=(3.2, 1.0))
    jagged_top(b, [(x * 0.72, y * 0.72) for x, y in star(5, 7.0, 5.4, 0.4)], 38.0, 46.0, (3.2, 1.0), s1=0.9, rough=0.6, seed=81)
    rubble(b, (6, -4), 12.0, 14, 82)
    objs.append(b.finish(mats))
    # A gate: two towers and a broken lintel.
    b = Builder("ruin_gate", names)
    for sgn in (-1, 1):
        jagged_top(b, chamfered(ngon(4, 7.5, math.pi / 4), 0.15), 0.0, 30.0 + sgn * 4.0, (sgn * 11.0, 0), s1=0.9, rough=0.3, seed=90 + sgn)
    beam_between(b, Vector((-11.0, 0, 21.0)), Vector((2.0, 0, 19.5)), 5.0, 4.0, mat="ruinStone")
    rubble(b, (3, -3), 14.0, 18, 92)
    objs.append(b.finish(mats))
    for o in objs:
        mod = o.modifiers.new("bevel", "BEVEL")
        mod.width = 0.2
        mod.segments = 1
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
    return objs


def make_mats():
    return {
        "spireStone": common.make_material("spireStone", (0.035, 0.032, 0.034), 0.0, 0.8),
        "spireMetal": common.make_material("spireMetal", (0.05, 0.045, 0.04), 0.8, 0.45),
        "spireGlow": common.make_material("spireGlow", (0.2, 0.03, 0.01), 0.0, 0.6, emission=(1.0, 0.18, 0.04), emission_strength=6.0),
        "wardenStone": common.make_material("wardenStone", (0.04, 0.036, 0.036), 0.0, 0.75),
        "wardenMetal": common.make_material("wardenMetal", (0.06, 0.05, 0.045), 0.85, 0.4),
        "ruinStone": common.make_material("ruinStone", (0.05, 0.045, 0.043), 0.0, 0.85),
        "ruinGlow": common.make_material("ruinGlow", (0.2, 0.04, 0.01), 0.0, 0.6, emission=(1.0, 0.25, 0.05), emission_strength=4.0),
    }


def preview(path: str, camera_location, target, lens: float, resolution=(720, 960), samples: int = 24) -> None:
    """Cycles preview at citadel scale (common.render_preview's camera clips at 100 m)."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = resolution
    world = bpy.data.worlds.new("SpirePreviewWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.35, 0.3, 0.32, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1.0
    scene.world = world
    cam_data = bpy.data.cameras.new("SpirePreviewCam")
    cam_data.lens = lens
    cam_data.clip_end = 20000.0
    cam = bpy.data.objects.new("SpirePreviewCam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = camera_location
    cam.rotation_euler = (Vector(target) - Vector(camera_location)).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    sun_data = bpy.data.lights.new("SpirePreviewSun", "SUN")
    sun_data.energy = 3.0
    sun = bpy.data.objects.new("SpirePreviewSun", sun_data)
    scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    common.ensure_dir(os.path.dirname(path))
    bpy.ops.render.render(write_still=True)
    for obj in (cam, sun):
        bpy.data.objects.remove(obj, do_unlink=True)


def tri_count(objs) -> int:
    total = 0
    deps = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        ev = o.evaluated_get(deps)
        mesh = ev.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        ev.to_mesh_clear()
    return total


def main():
    common.reset_scene()
    mats = make_mats()
    citadel = build_citadel(mats, True, "")
    tris = {"citadel": tri_count(citadel)}
    common.export_glb(citadel, os.path.join(EXPORT, "citadel.glb"))
    warden = build_warden(mats)
    for o in warden:
        o.location.z += 0.0
    tris["warden"] = tri_count(warden)
    common.export_glb(warden, os.path.join(EXPORT, "warden.glb"))
    ruins = build_ruins(mats)
    # Lay the ruins out in a row for the .blend and the preview (the game places each one itself).
    for i, o in enumerate(ruins):
        o.location.x = 1200.0 + i * 120.0
    tris["ruins"] = tri_count(ruins)
    bpy.ops.object.select_all(action="DESELECT")
    for o in ruins:
        o.location.x = 0.0
    common.export_glb(ruins, os.path.join(EXPORT, "ruins.glb"))
    for i, o in enumerate(ruins):
        o.location.x = 1200.0 + i * 120.0
    for o in warden:
        o.location.z = WARDEN_Z
    lod = build_citadel(mats, False, "_lod1")
    tris["citadel_lod1"] = tri_count(lod)
    for o in lod:
        o.location.x -= 1200.0
    bpy.ops.object.select_all(action="DESELECT")
    for o in lod:
        o.location.x = 0.0
    common.export_glb(lod, os.path.join(EXPORT, "citadel_lod1.glb"))
    for o in lod:
        o.location.x = -1200.0
    common.write_metadata(
        os.path.join(EXPORT, "spire.meta.json"),
        {
            "generator": "assets/blender/scripts/spire_kit.py",
            "unit": "1 m",
            "wardenHeight": WARDEN_Z,
            "objects": {"citadel": [o.name for o in citadel], "warden": [o.name for o in warden], "ruins": [o.name for o in ruins]},
            "triangles": tris,
            "materials": sorted(mats.keys()),
            "license": "Original work for Prismfall",
        },
    )
    common.save_blend(SOURCE)
    if not NO_PREVIEW:
        for o in lod:
            o.hide_render = True
        for o in ruins:
            o.hide_render = True
        preview(os.path.join(PREVIEW, "wardens_spire.png"), (-700, -1250, 120), (40, 0, 260), 42)
        preview(os.path.join(PREVIEW, "wardens_spire_crown.png"), (-160, -260, 420), (0, 0, WARDEN_Z), 50, resolution=(800, 800))
        for o in lod:
            o.hide_render = False
        for o in ruins:
            o.hide_render = False
    print(f"SPIRE_OK citadel {tris['citadel']} lod1 {tris['citadel_lod1']} warden {tris['warden']} ruins {tris['ruins']} triangles")


main()
