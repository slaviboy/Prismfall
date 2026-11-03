"""Red Horizon kit, part three: ruins and the assembly factory (imported by red_horizon_kit.py).

Every top-level object is named; the game instances them by name (towers, highway pieces, the lattice
mast, wrecks, debris) and animates the factory's named parts (robot arm links, gantry, fans).
Objects have their origin at the base centre. Materials are matched by name in the game:
rhConcrete, rhConcreteDark, rhRebar, rhRust, rhSteel, rhBurnt, rhWindow, rhAsphalt, rhPaint,
rhInterior, rhWarning, rhHot.
"""
import math
import random

import bmesh
import bpy
from mathutils import Matrix, Vector

from red_horizon_kit import R, S, T, aim, bm_box, bm_cyl, bm_ibeam, bm_loft, bm_prism, bm_shell, bm_strut, bm_tube, mat


class Obj:
    """A named object assembled from several materials (one bmesh per material)."""

    def __init__(self, coll, name):
        self.coll, self.name = coll, name
        self.parts = {}

    def bm(self, material):
        if material not in self.parts:
            self.parts[material] = bmesh.new()
        return self.parts[material]

    def done(self, sharp=40.0):
        me = bpy.data.meshes.new(self.name)
        bm = bmesh.new()
        names = list(self.parts.keys())
        for mi, name in enumerate(names):
            src = self.parts[name]
            bmesh.ops.remove_doubles(src, verts=src.verts, dist=1e-4)
            tmp = bpy.data.meshes.new("tmp")
            src.to_mesh(tmp)
            src.free()
            for p in tmp.polygons:
                p.material_index = mi
            bm.from_mesh(tmp)
            bpy.data.meshes.remove(tmp)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            e.smooth = not (e.is_manifold and e.calc_face_angle(0) > math.radians(sharp))
        bm.to_mesh(me)
        bm.free()
        for name in names:
            me.materials.append(mat(name))
        ob = bpy.data.objects.new(self.name, me)
        self.coll.objects.link(ob)
        return ob


def chunk(bm, rnd, size, m):
    """An irregular concrete chunk: a box with jittered corners."""
    sx, sy, sz = size
    ret = bmesh.ops.create_cube(bm, size=1.0, matrix=m @ S(sx, sy, sz))
    for v in ret["verts"]:
        v.co += Vector((rnd.uniform(-0.18, 0.18) * sx, rnd.uniform(-0.18, 0.18) * sy, rnd.uniform(-0.22, 0.12) * sz))


def fragment(bm, rnd, size, m):
    """A broken concrete fragment: a block cut by a few random fracture planes (sharp, planar
    breaks like real spalled concrete), lightly roughened and bevelled, merged into `bm`."""
    sx, sy, sz = size
    t = bmesh.new()
    bmesh.ops.create_cube(t, size=1.0, matrix=S(sx, sy, sz))
    for _ in range(rnd.randint(2, 4)):
        nrm = Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-0.6, 1))).normalized()
        ext = abs(nrm.x) * sx / 2 + abs(nrm.y) * sy / 2 + abs(nrm.z) * sz / 2
        co = nrm * ext * rnd.uniform(0.25, 0.7)
        geom = t.verts[:] + t.edges[:] + t.faces[:]
        res = bmesh.ops.bisect_plane(t, geom=geom, plane_co=co, plane_no=nrm, clear_outer=True)
        cut = [e for e in res["geom_cut"] if isinstance(e, bmesh.types.BMEdge)]
        if cut:
            bmesh.ops.holes_fill(t, edges=cut, sides=0)
    bmesh.ops.triangulate(t, faces=[f for f in t.faces if len(f.verts) > 4])
    for v in t.verts:
        v.co += Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))) * 0.025 * max(sx, sy, sz)
    edges = [e for e in t.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(35)]
    if edges:
        try:
            bmesh.ops.bevel(t, geom=edges, offset=0.025 * min(sx, sy, sz), segments=1, profile=0.5, affect="EDGES", clamp_overlap=True)
        except Exception:
            pass
    bmesh.ops.transform(t, matrix=m, verts=t.verts)
    tmp = bpy.data.meshes.new("frag")
    t.to_mesh(tmp)
    t.free()
    bm.from_mesh(tmp)
    bpy.data.meshes.remove(tmp)


def rebar(bm, rnd, base, up, n=3, length=1.2, spread=0.25):
    for _ in range(n):
        p0 = Vector(base) + Vector((rnd.uniform(-spread, spread), rnd.uniform(-spread, spread), 0))
        d = Vector(up).normalized() * length * rnd.uniform(0.5, 1.2)
        bend = Vector((rnd.uniform(-0.5, 0.5), rnd.uniform(-0.5, 0.5), rnd.uniform(-0.2, 0.1))) * length * 0.6
        bm_tube(bm, [p0, p0 + d * 0.55, p0 + d + bend], 0.03, 4)


# ------------------------------------------------------------------ ruined towers


def ruined_tower(coll, name, seed, floors, nx, ny, bay, floor_h, damage):
    """A gutted concrete-frame tower: slabs and columns on a grid, spandrel panels and broken glazing
    on the facades, a blast breach through several floors, a ragged collapsed top with column stubs
    and exposed rebar, and optionally an upper section that has slumped sideways. Damage is decided
    once per slab cell, and a cell only survives where something below still carries it."""
    rnd = random.Random(seed)
    o = Obj(coll, name)
    con, dark, glass, steel = o.bm("rhConcrete"), o.bm("rhConcreteDark"), o.bm("rhWindow"), o.bm("rhRebar")
    w, d = nx * bay, ny * bay
    breach_c = Vector((rnd.uniform(-0.3, 0.3) * w, -d * 0.5, floor_h * floors * rnd.uniform(0.35, 0.6)))
    breach_r = damage.get("breach", 0.3) * max(w, floor_h * floors) * 0.5
    top_loss = damage.get("top", 4)
    holes = damage.get("holes", 0.04)
    lean = damage.get("lean", 0.0)
    lean_from = int(floors * damage.get("leanFrom", 0.7))

    def cell_pos(f, i, j):
        return Vector(((i + 0.5) * bay - w / 2, (j + 0.5) * bay - d / 2, f * floor_h))

    alive = [[[True] * ny for _ in range(nx)] for _ in range(floors + 1)]
    for f in range(1, floors + 1):
        for i in range(nx):
            for j in range(ny):
                p = cell_pos(f, i, j)
                ok = (p - breach_c).length >= breach_r * (0.75 + 0.5 * rnd.random())
                if f > floors - top_loss:
                    k = (f - (floors - top_loss)) / top_loss
                    ok = ok and rnd.random() >= 0.2 + 0.7 * k and alive[f - 1][i][j]
                else:
                    ok = ok and rnd.random() >= holes
                    below = alive[f - 1][i][j] or any(alive[f - 1][a][b] for a, b in ((i - 1, j), (i + 1, j), (i, j - 1), (i, j + 1)) if 0 <= a < nx and 0 <= b < ny)
                    ok = ok and below
                alive[f][i][j] = ok

    def lean_m(f):
        if lean and f >= lean_from:
            pivot = Vector((w / 2 * math.copysign(1, lean), 0, lean_from * floor_h))
            return T(*pivot) @ R(0, lean, 0) @ T(*(-pivot))
        return Matrix.Identity(4)

    def cells_at(f, i, j):
        """Slab cells touching grid node (i, j) at floor f."""
        return [alive[f][a][b] for a in (i - 1, i) for b in (j - 1, j) if 0 <= a < nx and 0 <= b < ny]

    for f in range(floors + 1):
        L = lean_m(f)
        z = f * floor_h
        for i in range(nx):
            for j in range(ny):
                c = cell_pos(f, i, j)
                if alive[f][i][j]:
                    m = L @ T(*c)
                    if f > floors - top_loss - 1 and f > 0:
                        chunk(con if rnd.random() < 0.8 else dark, rnd, (bay * 1.002, bay * 1.002, 0.32), m)
                    else:
                        bm_box(con, bay * 1.002, bay * 1.002, 0.32, m)
                elif f > 0 and alive[f - 1][i][j] and rnd.random() < 0.4:
                    rebar(steel, rnd, L @ c, (rnd.uniform(-1, 1), rnd.uniform(-1, 1), -0.6), 3, bay * 0.35, bay * 0.4)
        if f == floors:
            break
        L1 = lean_m(f + 1) if f + 1 == lean_from else L
        for i in range(nx + 1):
            for j in range(ny + 1):
                below = cells_at(f, i, j)
                above = cells_at(f + 1, i, j)
                if not any(below):
                    continue
                x, y = i * bay - w / 2, j * bay - d / 2
                if any(above):
                    h = floor_h
                    stub = False
                elif f >= floors - top_loss - 1 and rnd.random() < 0.6:
                    h = floor_h * rnd.uniform(0.25, 0.8)
                    stub = True
                else:
                    continue
                m = L @ T(x, y, z + h / 2 + 0.16)
                bm_box(con, 0.55, 0.55, h, m)
                if stub:
                    rebar(steel, rnd, L @ Vector((x, y, z + h + 0.16)), (0, 0, 1), 4, 0.9, 0.2)
        # Facades: spandrels and glazing on the outer bays of every floor that is still standing.
        for side in range(4):
            count = nx if side < 2 else ny
            for i in range(count):
                if side < 2:
                    gi, gj = i, (0 if side == 0 else ny - 1)
                    x = (i + 0.5) * bay - w / 2
                    y = -d / 2 if side == 0 else d / 2
                    rot = 0
                else:
                    gi, gj = (0 if side == 2 else nx - 1), i
                    x = -w / 2 if side == 2 else w / 2
                    y = (i + 0.5) * bay - d / 2
                    rot = 90
                if not (alive[f][gi][gj] and f + 1 <= floors and alive[f + 1][gi][gj]):
                    continue
                if rnd.random() < 0.08:
                    continue
                m = L @ T(x, y, z + 0.16 + 0.55) @ R(0, 0, rot)
                bm_box(dark if rnd.random() < 0.3 else con, bay * 0.98, 0.22, 1.1, m)
                if rnd.random() < 0.45:
                    m2 = L @ T(x, y, z + 0.16 + 1.1 + (floor_h - 1.4) / 2) @ R(rnd.uniform(-4, 4), 0, rot)
                    bm_box(glass, bay * rnd.uniform(0.4, 0.9), 0.05, (floor_h - 1.4) * rnd.uniform(0.5, 1.0), m2)
    # Rubble skirt at the foot.
    for _ in range(int(nx * ny * 2.5)):
        a = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(0.4, 0.75) * max(w, d)
        sz = rnd.uniform(1.0, 3.2)
        fragment(dark if rnd.random() < 0.5 else con, rnd, (sz, sz * rnd.uniform(0.6, 1.4), sz * 0.6), T(math.cos(a) * r, math.sin(a) * r, sz * 0.18) @ R(rnd.uniform(-20, 20), rnd.uniform(-20, 20), rnd.uniform(0, 180)))
    return o.done()


# ------------------------------------------------------------------ highway, mast, wrecks, debris


def highway(coll):
    """An elevated six-lane highway: intact spans on hammerhead piers, a span that has broken and
    dropped one end to the ground, Jersey barriers, bent lamp standards."""
    obs = []
    span_len = 32.0
    width = 15.0
    deck_z = 11.0
    o = Obj(coll, "highway_span")
    con, asph, steel = o.bm("rhConcrete"), o.bm("rhAsphalt"), o.bm("rhRust")
    bm_box(con, span_len, width, 1.4, T(0, 0, deck_z - 0.7))
    for j in range(5):
        bm_box(con, span_len, 0.6, 1.2, T(0, -width / 2 + 1.5 + j * 3, deck_z - 2.0))
    bm_box(asph, span_len, width - 1.2, 0.06, T(0, 0, deck_z + 0.03))
    for sd in (1, -1):
        bm_prism(con, [(-0.35, 0), (0.35, 0), (0.2, 0.3), (0.12, 0.9), (-0.12, 0.9), (-0.2, 0.3)], span_len, T(0, sd * (width / 2 - 0.4), deck_z) @ R(0, 90, 0) @ R(0, 0, 90))
    bm_box(con, span_len, 0.5, 0.8, T(0, 0, deck_z + 0.4))
    for x in (-10.0, 6.0):
        m = T(x, width / 2 - 0.3, deck_z)
        bm_cyl(steel, 0.12, 0.09, 9.0, 8, m @ T(0, 0, 4.5))
        bm_box(steel, 0.25, 2.4, 0.2, m @ T(0, -1.1, 9.0) @ R(8, 0, 0))
    obs.append(o.done())
    o = Obj(coll, "highway_pier")
    con = o.bm("rhConcrete")
    bm_box(con, 2.6, 3.2, deck_z - 4.0, T(0, 0, (deck_z - 4.0) / 2))
    bm_prism(con, [(-7.8, 0), (7.8, 0), (7.0, -1.4), (-7.0, -1.4)], 3.0, T(0, 0, deck_z - 4.0) @ R(90, 0, 0) @ T(0, 1.4, 0))
    bm_box(con, 3.6, 4.2, 0.6, T(0, 0, 0.3))
    obs.append(o.done())
    # The broken span: hinged at one pier, the far end on the ground, a ragged torn edge.
    rnd = random.Random(31)
    o = Obj(coll, "highway_broken")
    con, asph, steel, dark = o.bm("rhConcrete"), o.bm("rhAsphalt"), o.bm("rhRebar"), o.bm("rhConcreteDark")
    tilt = math.degrees(math.atan2(deck_z - 1.0, span_len * 0.92))
    m0 = T(0, 0, deck_z) @ R(0, tilt, 0)
    segs = 8
    for i in range(segs):
        x = -i * (span_len / segs) - span_len / segs / 2
        lost = i == segs - 1
        for j in range(4):
            if lost and rnd.random() < 0.5:
                continue
            chunk(con if rnd.random() < 0.8 else dark, rnd, (span_len / segs * 1.01, width / 4 * 1.01, 1.4), m0 @ T(x, -width / 2 + width / 8 + j * width / 4, -0.7) @ R(rnd.uniform(-2, 2), rnd.uniform(-1, 1), 0))
        bm_box(asph, span_len / segs, width - 1.4, 0.06, m0 @ T(x, 0, 0.03))
    for j in range(9):
        rebar(steel, rnd, m0 @ Vector((-span_len * 0.98, -width / 2 + 1 + j * 1.6, -0.6)), (-1, 0, -0.4), 2, 1.6, 0.5)
        rebar(steel, rnd, m0 @ Vector((0.4, -width / 2 + 1 + j * 1.6, -0.4)), (1, 0, 0.2), 2, 1.3, 0.4)
    for sd in (1, -1):
        bm_box(con, span_len * 0.85, 0.5, 0.9, m0 @ T(-span_len * 0.45, sd * (width / 2 - 0.4), 0.45))
    for _ in range(30):
        sz = rnd.uniform(0.6, 2.4)
        fragment(dark if rnd.random() < 0.5 else con, rnd, (sz, sz, sz * 0.6), T(-span_len * rnd.uniform(0.7, 1.15), rnd.uniform(-1, 1) * width * 0.6, sz * 0.2) @ R(0, 0, rnd.uniform(0, 180)))
    obs.append(o.done())
    return obs


def mast(coll):
    """A 54 m lattice communications mast with dish antennas, its top section buckled over."""
    o = Obj(coll, "mast")
    steel, lamp, dish = o.bm("rhRust"), o.bm("rhWarning"), o.bm("rhSteel")
    h = 54.0
    levels = 14
    bend_at = 10

    def width(z):
        return 4.2 - 3.0 * (z / h)

    def bent(v, lvl):
        if lvl >= bend_at:
            z0 = bend_at * h / levels
            return T(0, 0, z0) @ R(28, 0, 8) @ T(0, 0, -z0) @ v
        return v

    corners = ((1, 1), (-1, 1), (-1, -1), (1, -1))
    for lvl in range(levels):
        z0, z1 = lvl * h / levels, (lvl + 1) * h / levels
        w0, w1 = width(z0) / 2, width(z1) / 2
        pts0 = [Vector((cx * w0, cy * w0, z0)) for cx, cy in corners]
        pts1 = [Vector((cx * w1, cy * w1, z1)) for cx, cy in corners]
        for k in range(4):
            a0, a1 = bent(pts0[k], lvl), bent(pts1[k], lvl)
            bm_strut(steel, a0, a1, 0.22)
            b0, b1 = bent(pts0[(k + 1) % 4], lvl), bent(pts1[(k + 1) % 4], lvl)
            bm_strut(steel, a0, b1, 0.09)
            bm_strut(steel, b0, a1, 0.09)
            bm_strut(steel, a1, b1, 0.12)
    for z, a in ((30.0, 30), (37.0, 200), (24.0, 110)):
        m = T(math.cos(math.radians(a)) * 2.0, math.sin(math.radians(a)) * 2.0, z) @ R(0, 0, a - 90) @ R(-80, 0, 0)
        bm_cyl(dish, 1.3, 0.4, 0.7, 16, m)
        bm_cyl(steel, 0.08, 0.08, 1.2, 6, m @ T(0, 0, 0.9))
    for z in (20.0, 38.0):
        bm_box(lamp, 0.35, 0.35, 0.35, T(width(z) / 2, width(z) / 2, z))
    top = bent(Vector((0, 0, h)), levels)
    bm_box(lamp, 0.4, 0.4, 0.4, T(*top))
    return o.done()


def _smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)


def car_shell(coll, name, seed):
    """A burnt-out hatchback (an original generic design). The body skin is one dented, panel-thick
    surface with wheel arches, A, B and C pillars around empty window frames, a buckled hood, a
    crushed corner and a roof sagging from the heat. Inside are the floor pan with embers, burnt
    seat frames and springs, the dashboard beam and a steering wheel. Bare rims stand where the
    tyres burnt away. Origin at the base centre, nose towards +Y."""
    rnd = random.Random(seed)
    o = Obj(coll, name)
    skin, rust, burnt, hot = o.bm("rhWreck"), o.bm("rhRust"), o.bm("rhBurnt"), o.bm("rhHot")
    HL = 2.12
    ARCHES = (1.32, -1.30)
    ARCH_Z, ARCH_R = 0.24, 0.39

    def belt(y):
        """Top of the lower body: the hood at the front, the waist along the cabin, the tail."""
        if y > 1.0:
            return 0.83 - 0.11 * _smooth(1.0, 1.95, y) - 0.2 * _smooth(1.9, HL, y)
        if y < -1.92:
            return 0.85 - 0.28 * _smooth(-1.92, -HL, y)
        return 0.83 + 0.02 * _smooth(0.6, -1.9, y)

    def roof(y):
        b = belt(y)
        if y > 0.42:
            z = 1.25 - (1.25 - 0.835) * min(1.0, (y - 0.42) / 0.62) ** 1.15
        elif y < -1.02:
            z = 1.25 - 0.36 * min(1.0, (-1.02 - y) / 0.9) ** 1.4
        else:
            z = 1.25
        return max(z, b + 0.02)

    def plan(y):
        a = abs(y)
        return 1.0 if a < 1.78 else 1.0 - 0.15 * ((a - 1.78) / (HL - 1.78)) ** 2

    SIDE_F = [0.0, 0.08, 0.2, 0.33, 0.46, 0.6, 0.73, 0.86, 1.0]
    GLASS_S = [0.06, 0.3, 0.55, 0.8, 1.0]

    def half(y):
        """Half cross-section (x >= 0) from under the sill to the roof centre: 19 points."""
        b, zt = belt(y), roof(y)
        g = min(1.0, max(0.0, (zt - b) / 0.42))
        k = plan(y)
        pts = [(0.76 * k, 0.12)]
        for f in SIDE_F:
            pts.append(((0.84 + 0.035 * math.sin(math.pi * f) + 0.015 * f) * k, 0.15 + (b - 0.15) * f))
        xb, xr = 0.855 * k, (0.80 - 0.14 * g) * k
        for s in GLASS_S:
            pts.append((xb - (xb - xr) * s, b + (zt - b) * s))
        crown = 0.045 * g + 0.025 * (1 - g)
        x1 = xr - 0.07 * k
        for x in (x1, x1 * 0.66, x1 * 0.33, 0.0):
            pts.append((x, zt + crown * (1 - (x / xr) ** 2)))
        return pts

    N = 64
    ys = [-HL + 2 * HL * i / (N - 1) for i in range(N)]
    nh = 19
    grid = []
    for y in ys:
        h = half(y)
        ring = [(-x, y, z, j) for j, (x, z) in enumerate(h)] + [(x, y, z, j) for j, (x, z) in reversed(list(enumerate(h[:-1])))]
        grid.append(ring)
    # Dents, the buckled hood, the crushed front corner and the sagging roof.
    dents = [(rnd.uniform(-1.8, 1.6), rnd.choice((-1, 1)), rnd.uniform(0.3, 1.2), rnd.uniform(0.2, 0.45), rnd.uniform(0.015, 0.05)) for _ in range(12)]
    for ring in grid:
        for idx, (x, y, z, j) in enumerate(ring):
            for dy, side, dz, r, depth in dents:
                w = math.exp(-((y - dy) ** 2 + (z - dz) ** 2) / (r * r))
                if j <= 13 and x * side > 0:
                    x -= math.copysign(depth * w, x)
                elif j >= 14:
                    z -= depth * w * 0.6
            if y > 1.0 and j >= 10:
                fold = 1 - min(1.0, (x / 0.86) ** 2)
                z += (0.075 * math.exp(-((y - 1.6) / 0.09) ** 2) + 0.04 * math.exp(-((y - 1.88) / 0.07) ** 2)) * fold * (0.7 + 0.3 * x / 0.86)
            if -1.0 < y < 0.4 and j >= 14:
                z -= 0.075 * max(0.0, 1 - (x / 0.7) ** 2) * math.sin(math.pi * (y + 1.0) / 1.4)
            if y > 1.8:
                y -= 0.1 * _smooth(1.8, HL, y) * (0.5 + 0.5 * x / 0.86)
            ring[idx] = (x + rnd.uniform(-0.005, 0.005), y, z + rnd.uniform(-0.005, 0.005), j)
    verts = [[skin.verts.new((x, y, z)) for x, y, z, _ in ring] for ring in grid]
    nr = len(grid[0])
    faces = []
    for i in range(N - 1):
        ym = (ys[i] + ys[i + 1]) / 2
        band = roof(ym) - belt(ym)
        for k in range(nr - 1):
            fh = k if k < nh - 1 else 2 * (nh - 1) - 1 - k
            zm = (grid[i][k][2] + grid[i][k + 1][2] + grid[i + 1][k][2] + grid[i + 1][k + 1][2]) / 4
            if 10 <= fh <= 12 and band > 0.13 and (-0.08 < ym < 1.02 or -0.93 < ym < -0.27):
                continue  # side windows (B pillar between them, C pillar behind)
            if 15 <= fh and (0.5 < ym < 1.0 or -1.83 < ym < -1.12):
                continue  # windscreen and hatch glass, gone
            if fh <= 8 and any((ym - ay) ** 2 + (zm - ARCH_Z) ** 2 < ARCH_R ** 2 for ay in ARCHES):
                continue  # wheel arches
            faces.append(skin.faces.new((verts[i][k], verts[i][k + 1], verts[i + 1][k + 1], verts[i + 1][k])))
    faces.append(skin.faces.new(verts[0]))
    faces.append(skin.faces.new(list(reversed(verts[-1]))))
    bmesh.ops.recalc_face_normals(skin, faces=faces)
    # Panel thickness: an inner skin offset along the vertex normals (no angle compensation, so
    # creases never blow up), joined to the outer skin along every open edge.
    skin.normal_update()
    inner = {}
    for f in faces:
        for v in f.verts:
            if v not in inner:
                inner[v] = skin.verts.new(v.co - v.normal * 0.028)
    fset = set(faces)
    for f in faces:
        skin.faces.new([inner[v] for v in reversed(f.verts)])
    for f in faces:
        for lp in f.loops:
            if sum(1 for g in lp.edge.link_faces if g in fset) == 1:
                a, b = lp.vert, lp.link_loop_next.vert
                skin.faces.new((b, a, inner[a], inner[b]))
    # Arch lips hide the cut edge of the skin.
    for ay in ARCHES:
        for sx in (-1, 1):
            pts = [(sx * 0.875, ay + math.cos(a) * ARCH_R, ARCH_Z + math.sin(a) * ARCH_R) for a in [math.pi * t / 12 for t in range(13)]]
            bm_tube(skin, pts, 0.022, 5)
    # Floor pan, firewall, dashboard beam.
    bm_box(burnt, 1.6, 3.7, 0.03, T(0, -0.1, 0.2))
    bm_box(burnt, 1.6, 0.05, 0.5, T(0, 1.0, 0.5) @ R(-15, 0, 0))
    bm_box(burnt, 1.45, 0.3, 0.06, T(0.03, 0.8, 0.79) @ R(8, 0, 3))
    bm_tube(rust, [(-0.76, 0.74, 0.69), (0.0, 0.75, 0.67), (0.76, 0.74, 0.7)], 0.025, 6)

    def seat(cx, cy, w, lean):
        z0, d = 0.42, 0.5
        c = [(cx - w / 2, cy - d / 2), (cx + w / 2, cy - d / 2), (cx + w / 2, cy + d / 2), (cx - w / 2, cy + d / 2)]
        bm_tube(rust, [(x, y, z0) for x, y in c + c[:1]], 0.013, 4, False)
        for xx, yy in c:
            bm_strut(rust, (xx, yy, 0.21), (xx, yy, z0), 0.025)
        n = max(3, int(w / 0.14))
        for s in range(n):
            xs = cx - w / 2 + (s + 0.5) * w / n
            bm_tube(rust, [(xs + 0.03 * (-1) ** m, cy - d / 2 + m * d / 8, z0 + 0.01) for m in range(9)], 0.006, 3, False)
        top_y, top_z = cy - d / 2 - 0.55 * math.sin(math.radians(lean)), z0 + 0.55 * math.cos(math.radians(lean))
        bm_tube(rust, [(cx - w / 2, cy - d / 2, z0), (cx - w / 2, top_y, top_z), (cx + w / 2, top_y, top_z), (cx + w / 2, cy - d / 2, z0)], 0.014, 4, False)
        for s in range(n):
            xs = cx - w / 2 + (s + 0.5) * w / n
            bm_tube(rust, [(xs + 0.03 * (-1) ** m, cy - d / 2 + (top_y - cy + d / 2) * m / 8, z0 + (top_z - z0) * m / 8) for m in range(9)], 0.006, 3, False)

    seat(-0.38, 0.1, 0.48, 18 + rnd.uniform(-4, 6))
    seat(0.38, 0.1, 0.48, 34 + rnd.uniform(-4, 6))
    seat(0.0, -0.82, 1.3, 20)
    # Steering wheel and column (left-hand drive).
    c = Vector((-0.38, 0.52, 0.9))
    ex, ey = Vector((1, 0, 0)), Vector((0, 0.8, 0.6))
    ring = [c + (ex * math.cos(a) + ey * math.sin(a)) * 0.18 for a in [2 * math.pi * t / 14 for t in range(15)]]
    bm_tube(rust, [tuple(p) for p in ring], 0.014, 4, False)
    bm_tube(rust, [tuple(c), (-0.38, 0.86, 0.68)], 0.022, 5)
    for a in (0.0, math.pi):
        bm_tube(rust, [tuple(c), tuple(c + (ex * math.cos(a) + ey * math.sin(a)) * 0.18)], 0.01, 3)
    # Embers on the floor: the fire burns inside the shell.
    for _ in range(7):
        sz = rnd.uniform(0.1, 0.24)
        fragment(hot, rnd, (sz, sz * rnd.uniform(0.6, 1.2), sz * 0.35), T(rnd.uniform(-0.6, 0.6), rnd.uniform(-1.2, 0.7), 0.23) @ R(0, 0, rnd.uniform(0, 180)))
    for _ in range(5):
        sz = rnd.uniform(0.12, 0.3)
        fragment(burnt, rnd, (sz, sz, sz * 0.4), T(rnd.uniform(-0.6, 0.6), rnd.uniform(-1.1, 0.3), 0.45) @ R(rnd.uniform(-20, 20), rnd.uniform(-20, 20), rnd.uniform(0, 180)))
    # Bare rims (the tyres burnt away); the body has settled onto them.
    for ay in ARCHES:
        for sx in (-1, 1):
            m = T(sx * 0.76, ay, 0.19) @ R(rnd.uniform(-4, 4), 90, rnd.uniform(-6, 6))
            bm_shell(rust, 0.165, 0.19, 0, 350, -0.09, 0.09, 14, m)
            bm_cyl(rust, 0.165, 0.165, 0.02, 12, m @ T(0, 0, sx * 0.03))
            bm_cyl(rust, 0.055, 0.045, 0.07, 8, m @ T(0, 0, sx * 0.06))
    # Bumper bars: the front one sagging, the rear one fallen to the ground.
    bm_tube(rust, [(-0.8, 2.07, 0.32), (-0.2, 2.15, 0.35), (0.4, 2.12, 0.3), (0.75, 1.98, 0.16)], 0.04, 6)
    bm_tube(rust, [(-0.7, -2.16, 0.06), (0.0, -2.2, 0.1), (0.7, -2.12, 0.26)], 0.04, 6)
    return o.done(sharp=50.0)


def car(coll, name, seed, kind):
    """A burnt-out vehicle (original generic shapes): a hatchback, a box van or a bus."""
    rnd = random.Random(seed)
    o = Obj(coll, name)
    burnt, rust, dark, glass = o.bm("rhBurnt"), o.bm("rhRust"), o.bm("rhConcreteDark"), o.bm("rhWindow")
    if kind == "car":
        L, W = 4.3, 1.8
        bm_loft(burnt, [(-2.15, 0.85, 0.32, 0.55), (-1.9, 0.9, 0.38, 0.6), (1.6, 0.9, 0.36, 0.58), (2.15, 0.85, 0.25, 0.5)], 8)
        bm_loft(rust, [(-1.7, 0.75, 0.04, 0.96), (-1.4, 0.78, 0.25, 1.15), (0.5, 0.78, 0.25, 1.15), (1.1, 0.75, 0.04, 0.96)], 8)
        wheels = [(-1.35, 0.8), (1.35, 0.8), (-1.35, -0.8), (1.35, -0.8)]
        wr = 0.32
    elif kind == "van":
        L, W = 6.2, 2.2
        bm_box(burnt, 2.0, 2.1, 1.7, T(0, 2.0, 1.25))
        bm_box(rust, 2.1, 4.0, 2.3, T(0, -1.0, 1.55))
        bm_box(glass, 1.9, 0.08, 0.6, T(0, 3.02, 1.7) @ R(-12, 0, 0))
        wheels = [(2.0, 1.0), (-2.2, 1.0), (2.0, -1.0), (-2.2, -1.0)]
        wr = 0.42
    else:
        L, W = 11.5, 2.5
        bm_box(burnt, 2.5, 11.5, 2.6, T(0, 0, 1.75))
        for i in range(8):
            bm_box(glass, 2.56, 1.0, 0.9, T(0, -4.6 + i * 1.3, 2.35)) if rnd.random() < 0.4 else None
        bm_box(rust, 2.3, 11.0, 0.12, T(0, 0, 3.1))
        wheels = [(3.8, 1.15), (-3.6, 1.15), (3.8, -1.15), (-3.6, -1.15)]
        wr = 0.5
    for wy, wx in wheels:
        if rnd.random() < 0.75:
            bm_cyl(dark, wr, wr, 0.25, 10, T(wx, wy, wr * 0.8) @ R(0, 90, 0))
    ob = o.done()
    ob.rotation_euler = (0, 0, 0)
    return ob


def debris(coll, name, seed, n, radius, beams):
    """A collapse pile: broken slab pieces with rebar, many smaller fractured fragments heaped
    towards the centre, a scree of grit at the rim, and twisted steel sections."""
    rnd = random.Random(seed)
    o = Obj(coll, name)
    con, dark, steel, bar = o.bm("rhConcrete"), o.bm("rhConcreteDark"), o.bm("rhRust"), o.bm("rhRebar")
    # Large slab pieces leaning in the heap.
    for _ in range(max(2, n // 12)):
        a = rnd.uniform(0, 2 * math.pi)
        r = radius * rnd.uniform(0.1, 0.55)
        w = rnd.uniform(2.0, 4.5)
        m = T(math.cos(a) * r, math.sin(a) * r, rnd.uniform(0.3, 1.2)) @ R(rnd.uniform(-30, 30), rnd.uniform(-35, 35), rnd.uniform(0, 180))
        fragment(con if rnd.random() < 0.7 else dark, rnd, (w, w * rnd.uniform(0.5, 0.9), 0.3), m)
        for k in range(4):
            rebar(bar, rnd, m @ Vector((w * 0.45 * (1 if k % 2 else -1), rnd.uniform(-0.3, 0.3) * w, 0)), (1 if k % 2 else -1, rnd.uniform(-0.3, 0.3), rnd.uniform(-0.2, 0.4)), 2, 0.9, 0.15)
    for _ in range(int(n * 2.2)):
        a = rnd.uniform(0, 2 * math.pi)
        r = radius * math.sqrt(rnd.random())
        k = 1 - r / radius
        sz = rnd.uniform(0.25, 1.3) * (0.6 + 0.6 * k)
        z = k * radius * 0.28 * rnd.uniform(0.4, 1.0)
        fragment(dark if rnd.random() < 0.4 else con, rnd, (sz, sz * rnd.uniform(0.6, 1.3), sz * rnd.uniform(0.35, 0.8)), T(math.cos(a) * r, math.sin(a) * r, z) @ R(rnd.uniform(-40, 40), rnd.uniform(-40, 40), rnd.uniform(0, 180)))
    for _ in range(int(n * 1.2)):
        a = rnd.uniform(0, 2 * math.pi)
        r = radius * rnd.uniform(0.75, 1.15)
        sz = rnd.uniform(0.08, 0.3)
        fragment(dark if rnd.random() < 0.5 else con, rnd, (sz, sz, sz * 0.6), T(math.cos(a) * r, math.sin(a) * r, 0.02) @ R(0, 0, rnd.uniform(0, 180)))
    for _ in range(beams):
        a = rnd.uniform(0, 2 * math.pi)
        p0 = Vector((math.cos(a) * radius * 0.5, math.sin(a) * radius * 0.5, rnd.uniform(0, 0.8)))
        p1 = p0 + Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(0.1, 0.5))).normalized() * rnd.uniform(2.5, 5.5)
        bm_ibeam(steel, p0, p1, 0.32, 0.2, 0.035, rnd.uniform(0, 90))
    return o.done()


def shell_building(coll, name, seed, w, d, floors):
    """A burnt-out low-rise shell: exterior walls punched with window openings, floors fallen in."""
    rnd = random.Random(seed)
    o = Obj(coll, name)
    con, burnt, dark = o.bm("rhConcrete"), o.bm("rhBurnt"), o.bm("rhConcreteDark")
    fh = 3.4
    for f in range(floors):
        z = f * fh
        for side in range(4):
            length = w if side < 2 else d
            n = max(2, int(length / 3.2))
            for i in range(n):
                if f == floors - 1 and rnd.random() < 0.4:
                    continue
                seg = length / n
                u = -length / 2 + (i + 0.5) * seg
                if side < 2:
                    pos, rot = (u, (-d / 2 if side == 0 else d / 2)), 0
                else:
                    pos, rot = (((-w / 2) if side == 2 else w / 2), u), 90
                m = T(pos[0], pos[1], z) @ R(0, 0, rot)
                b = burnt if rnd.random() < 0.35 else con
                bm_box(b, seg * 0.3, 0.3, fh, m @ T(-seg * 0.35, 0, fh / 2))
                bm_box(b, seg * 0.3, 0.3, fh, m @ T(seg * 0.35, 0, fh / 2))
                bm_box(b, seg * 0.42, 0.3, 1.0, m @ T(0, 0, 0.5))
                bm_box(b, seg * 0.42, 0.3, 0.5, m @ T(0, 0, fh - 0.25))
        if 0 < f and rnd.random() < 0.6:
            bm_box(dark, w * rnd.uniform(0.3, 0.6), d * rnd.uniform(0.3, 0.7), 0.25, T(rnd.uniform(-0.2, 0.2) * w, rnd.uniform(-0.2, 0.2) * d, z) @ R(rnd.uniform(-6, 6), rnd.uniform(-6, 6), 0))
    return o.done()


def ruins(coll):
    obs = []
    obs.append(ruined_tower(coll, "tower_a", 11, 26, 5, 4, 6.0, 3.6, {"breach": 0.28, "top": 5}))
    obs.append(ruined_tower(coll, "tower_b", 12, 34, 4, 4, 6.5, 3.6, {"breach": 0.22, "top": 7, "holes": 0.06}))
    obs.append(ruined_tower(coll, "tower_c", 13, 20, 6, 4, 6.0, 3.8, {"breach": 0.35, "top": 4, "lean": 9.0, "leanFrom": 0.55}))
    obs.append(ruined_tower(coll, "tower_d", 14, 14, 5, 5, 6.0, 3.6, {"breach": 0.42, "top": 6, "holes": 0.1}))
    obs.append(ruined_tower(coll, "tower_e", 15, 40, 4, 3, 7.0, 3.5, {"breach": 0.18, "top": 9, "lean": -5.0, "leanFrom": 0.8}))
    obs += highway(coll)
    obs.append(mast(coll))
    obs.append(car_shell(coll, "wreck_car", 21))
    obs.append(car(coll, "wreck_van", 22, "van"))
    obs.append(car(coll, "wreck_bus", 23, "bus"))
    obs.append(debris(coll, "debris_a", 41, 40, 7.0, 4))
    obs.append(debris(coll, "debris_b", 42, 24, 4.0, 2))
    obs.append(debris(coll, "debris_c", 43, 70, 11.0, 7))
    obs.append(shell_building(coll, "shell_a", 51, 24, 14, 4))
    obs.append(shell_building(coll, "shell_b", 52, 16, 12, 3))
    return obs


# ------------------------------------------------------------------ factory


def factory(coll):
    """An assembly hall seen through its open front: portal frames, clad walls and roof with missing
    panels, lit interior strip lights, a conveyor line with station gantries, chimneys with warning
    lamps, wall ventilation fans; plus the separately animated parts (robot arm links, an overhead
    gantry with trolley and hook, fan rotors)."""
    obs = []
    rnd = random.Random(71)
    L, D, H = 96.0, 42.0, 24.0
    o = Obj(coll, "factory_hall")
    steel, rust, con, light, dark, warn, paint = (o.bm(n) for n in ("rhSteel", "rhRust", "rhConcrete", "rhInterior", "rhConcreteDark", "rhWarning", "rhPaint"))
    bm_box(con, L + 6, D + 6, 0.6, T(0, 0, 0.3))
    bays = 12
    for i in range(bays + 1):
        x = -L / 2 + i * L / bays
        for y in (-D / 2, D / 2):
            bm_ibeam(steel, (x, y, 0.6), (x, y, H), 1.0, 0.6, 0.12, 90)
        # Roof truss: top and bottom chords and diagonals.
        top = [Vector((x, -D / 2 + D * t, H + 5.0 * (1 - abs(t * 2 - 1)))) for t in (0, 0.25, 0.5, 0.75, 1.0)]
        bot = [Vector((x, -D / 2 + D * t, H)) for t in (0, 0.25, 0.5, 0.75, 1.0)]
        for k in range(4):
            bm_strut(steel, top[k], top[k + 1], 0.45)
            bm_strut(steel, bot[k], bot[k + 1], 0.35)
            bm_strut(steel, bot[k], top[k + 1], 0.2)
            bm_strut(steel, top[k], bot[k], 0.2)
    # Cladding: back wall, roof and side walls; some panels missing or hanging.
    for i in range(bays):
        x = -L / 2 + (i + 0.5) * L / bays
        for j in range(6):
            z = 0.6 + (j + 0.5) * (H - 0.6) / 6
            if rnd.random() < 0.88:
                bm_box(rust if rnd.random() < 0.4 else steel, L / bays * 0.99, 0.12, (H - 0.6) / 6 * 0.98, T(x, D / 2 + 0.4, z) @ R(rnd.uniform(-1.5, 1.5), 0, 0))
        for sd in (-1, 1):
            for j in range(2):
                if rnd.random() < 0.8:
                    t = (j + 0.5) / 2
                    y = sd * D / 2 * (1 - t)
                    zr = H + 5.0 * t
                    bm_box(rust if rnd.random() < 0.5 else steel, L / bays * 0.99, D / 2 / 2 * 1.02, 0.12, T(x, y, zr + 0.3) @ R(sd * math.degrees(math.atan2(5.0, D / 2)), 0, 0))
        # Front fascia above the opening and strip lights along the ceiling.
        bm_box(steel, L / bays * 0.99, 0.3, 4.0, T(x, -D / 2 - 0.3, H - 2.0))
        for y in (-D * 0.3, 0.0, D * 0.3):
            bm_box(light, L / bays * 0.6, 0.5, 0.15, T(x, y, H - 0.4))
    for sd in (-1, 1):
        for j in range(6):
            for k in range(5):
                if rnd.random() < 0.85:
                    bm_box(rust if rnd.random() < 0.4 else steel, 0.12, D / 5 * 0.99, (H - 0.6) / 6 * 0.98, T(sd * (L / 2 + 0.4), -D / 2 + (k + 0.5) * D / 5, 0.6 + (j + 0.5) * (H - 0.6) / 6))
    # Back wall interior glow: lit windows of the upper office gallery.
    for i in range(bays):
        x = -L / 2 + (i + 0.5) * L / bays
        bm_box(light, L / bays * 0.7, 0.1, 1.2, T(x, D / 2 + 0.25, 14.0))
        bm_box(dark, L / bays * 0.98, 3.0, 0.4, T(x, D / 2 - 1.5, 12.8))
    # Conveyor line along the hall with station gantries.
    bm_box(dark, L * 0.86, 3.2, 1.0, T(0, 0, 1.1))
    bm_box(steel, L * 0.86, 0.3, 0.3, T(0, 1.75, 1.6))
    bm_box(steel, L * 0.86, 0.3, 0.3, T(0, -1.75, 1.6))
    for i in range(7):
        x = -L * 0.36 + i * L * 0.12
        for y in (-4.2, 4.2):
            bm_ibeam(paint, (x, y, 0.6), (x, y, 9.0), 0.5, 0.4, 0.06, 90)
        bm_ibeam(paint, (x, -4.4, 9.0), (x, 4.4, 9.0), 0.6, 0.4, 0.06)
        bm_box(warn, 0.3, 0.3, 0.3, T(x, -4.2, 9.4))
    # Crane rails along both long walls.
    for y in (-D / 2 + 1.2, D / 2 - 1.2):
        bm_box(steel, L, 0.8, 0.9, T(0, y, 18.0))
    obs.append(o.done())

    o = Obj(coll, "factory_chimneys")
    con, rust, warn, steel = o.bm("rhConcreteDark"), o.bm("rhRust"), o.bm("rhWarning"), o.bm("rhSteel")
    for x, y, r, h in ((-30.0, D / 2 + 14, 3.0, 64.0), (-12.0, D / 2 + 16, 2.6, 56.0), (22.0, D / 2 + 12, 3.4, 70.0)):
        bm_cyl(con, r, r * 0.72, h, 20, T(x, y, h / 2))
        for k in range(4):
            bm_cyl(rust, r * 0.74 + (1 - k / 4) * r * 0.28 + 0.15, r * 0.74 + (1 - k / 4) * r * 0.28 + 0.15, 0.6, 20, T(x, y, h * (0.2 + k * 0.22)))
        bm_cyl(steel, r * 0.8, r * 0.8, 1.2, 20, T(x, y, h - 0.6))
        for k in range(3):
            a = k * 120
            bm_box(warn, 0.5, 0.5, 0.5, T(x + math.cos(math.radians(a)) * r * 0.78, y + math.sin(math.radians(a)) * r * 0.78, h - 2.0))
    # Tanks and pipework between the chimneys and the hall.
    for x, y, r in ((40.0, D / 2 + 10, 6.0), (54.0, D / 2 + 6, 4.5)):
        bm_cyl(steel, r, r, 14.0, 24, T(x, y, 7.6))
        bm_cyl(rust, r * 0.9, r * 0.5, 2.0, 24, T(x, y, 15.6))
    bm_tube(rust, [(-30.0, D / 2 + 14, 12.0), (-30.0, D / 2 + 4, 12.0), (-12.0, D / 2 + 2, 12.0), (40.0, D / 2 + 2, 12.0)], 0.8, 10)
    bm_tube(rust, [(54.0, D / 2 + 6, 10.0), (54.0, D / 2 + 2, 16.0), (22.0, D / 2 + 2, 16.0), (22.0, D / 2 + 12, 16.0)], 0.6, 10)
    obs.append(o.done())

    # Ventilation fan housings on the side walls (rotors are separate).
    o = Obj(coll, "factory_fan_housing")
    steel, dark = o.bm("rhSteel"), o.bm("rhConcreteDark")
    bm_shell(steel, 3.0, 3.5, 0, 360, -0.8, 0.8, 28, R(90, 0, 0))
    bm_box(dark, 7.6, 0.6, 7.6, T(0, 0.9, 0))
    for a in (0, 45, 90, 135):
        bm_box(steel, 6.2, 0.2, 0.2, T(0, -0.9, 0) @ R(0, a, 0))
    obs.append(o.done())
    o = Obj(coll, "factory_fan_rotor")
    steel = o.bm("rhSteel")
    bm_cyl(steel, 0.6, 0.6, 0.8, 12, R(90, 0, 0))
    for b in range(6):
        bm_box(steel, 2.6, 0.9, 0.08, R(0, b * 60, 0) @ T(1.5, 0, 0) @ R(20, 0, 0))
    obs.append(o.done())

    # Robot arm links (an original six-axis welding arm, about 7 m reach). Each link's origin is its
    # joint; the game chains them: base (fixed) > turret (yaw) > upper (pitch at the shoulder) >
    # fore (pitch at the elbow) > wrist (pitch) with the welding head.
    o = Obj(coll, "arm_base")
    steel, paint = o.bm("rhSteel"), o.bm("rhPaint")
    bm_cyl(steel, 1.3, 1.5, 0.6, 18, T(0, 0, 0.3))
    bm_cyl(paint, 0.9, 1.0, 1.2, 16, T(0, 0, 1.2))
    obs.append(o.done())
    o = Obj(coll, "arm_turret")
    paint, steel = o.bm("rhPaint"), o.bm("rhSteel")
    bm_box(paint, 1.6, 1.8, 1.4, T(0, 0, 0.7))
    bm_cyl(steel, 0.75, 0.75, 2.0, 16, T(0, 0, 1.5) @ R(0, 90, 0))
    obs.append(o.done())
    o = Obj(coll, "arm_upper")
    paint, steel = o.bm("rhPaint"), o.bm("rhSteel")
    bm_box(paint, 0.9, 0.9, 4.2, T(0, 0, 2.1))
    bm_cyl(steel, 0.6, 0.6, 1.4, 14, T(0, 0, 4.2) @ R(0, 90, 0))
    bm_cyl(steel, 0.22, 0.22, 3.0, 8, T(0.55, -0.3, 1.8))
    obs.append(o.done())
    o = Obj(coll, "arm_fore")
    paint, steel = o.bm("rhPaint"), o.bm("rhSteel")
    bm_box(paint, 0.7, 0.75, 3.4, T(0, 0, 1.7))
    bm_cyl(steel, 0.38, 0.38, 1.0, 12, T(0, 0, 3.4) @ R(0, 90, 0))
    obs.append(o.done())
    o = Obj(coll, "arm_wrist")
    steel, hot = o.bm("rhSteel"), o.bm("rhHot")
    bm_box(steel, 0.5, 0.5, 0.7, T(0, 0, 0.35))
    bm_cyl(steel, 0.12, 0.06, 0.8, 8, T(0, 0, 1.1))
    bm_box(hot, 0.08, 0.08, 0.08, T(0, 0, 1.5))
    obs.append(o.done())
    # Overhead gantry crane: bridge (spans the hall), trolley and a hook block with a carried frame.
    o = Obj(coll, "crane_bridge")
    paint, steel, warn = o.bm("rhPaint"), o.bm("rhSteel"), o.bm("rhWarning")
    for x in (-1.2, 1.2):
        bm_box(paint, 0.8, D - 2.4, 1.6, T(x, 0, 0))
    for y in (-D / 2 + 1.2, D / 2 - 1.2):
        bm_box(steel, 3.6, 1.6, 1.0, T(0, y, -0.8))
    bm_box(warn, 0.4, 0.4, 0.4, T(0, D / 2 - 2.0, 1.0))
    obs.append(o.done())
    o = Obj(coll, "crane_trolley")
    steel = o.bm("rhSteel")
    bm_box(steel, 3.4, 2.6, 1.2, T(0, 0, 1.4))
    for x in (-0.4, 0.4):
        bm_cyl(steel, 0.05, 0.05, 6.0, 6, T(x, 0, -2.2))
    obs.append(o.done())
    o = Obj(coll, "crane_hook")
    steel, rust = o.bm("rhSteel"), o.bm("rhRust")
    bm_box(steel, 1.2, 0.8, 0.8, T(0, 0, 0))
    bm_box(rust, 2.6, 1.8, 0.4, T(0, 0, -0.8))
    for x in (-1.0, 1.0):
        bm_strut(rust, (x, 0, -0.8), (x * 0.4, 0, -3.2), 0.18)
    obs.append(o.done())
    return obs
