"""Red Horizon kit: original machines, ruins and a working factory for the Red Horizon world.

Run headless:  blender -b --factory-startup --python assets/blender/scripts/red_horizon_kit.py -- [--no-preview] [--only machines|ruins|factory]

Every design here is original (no franchise machines). Machines are rigid-segment rigs: each part is
bound to one bone (float attribute `_BONE`), and a `<name>.rig.json` sidecar lists the bones
(parent, pivot) and the hydraulic pistons (two anchors on two bones). The game poses the bones on
the CPU (gait, IK, optical sensors) and skins the instanced meshes on the GPU.

Outputs (assets/blender/exports/red_horizon/):
  sentinel.glb, sentinel_lod.glb, sentinel.rig.json   humanoid machine, three sensor heads
  colossus.glb, colossus.rig.json                     hexapod giant walker
  drone.glb, drone.rig.json                           recon drone with ducted fans and a sensor turret
  ruins.glb                                           ruined towers, broken highway, lattice mast, wrecks, debris
  factory.glb                                         assembly hall, chimneys, robot arm parts, gantry, fans

Blender is Z-up and the machines face +Y here; glTF is Y-up, so a point (x, y, z) here is
(x, z, -y) in game and the machines face -Z there. Rig files are written in game coordinates.
"""
import json
import math
import os
import random
import sys

import bpy
import bmesh
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, args, ensure_dir, render_preview, reset_scene, save_blend, write_metadata  # noqa: E402

OUT = os.path.join(ROOT, "assets", "blender", "exports", "red_horizon")
SRC = os.path.join(ROOT, "assets", "blender", "source", "environments")
PREV = os.path.join(ROOT, "assets", "blender", "previews")

# ------------------------------------------------------------------ materials

MATS = {
    # name: (preview colour, metallic, roughness, emission)
    "rhArmour": ((0.09, 0.095, 0.1), 0.8, 0.42, None),
    "rhFrame": ((0.035, 0.035, 0.04), 0.9, 0.5, None),
    "rhJoint": ((0.32, 0.31, 0.3), 1.0, 0.3, None),
    "rhPiston": ((0.75, 0.75, 0.76), 1.0, 0.12, None),
    "rhCable": ((0.02, 0.02, 0.02), 0.0, 0.7, None),
    "rhGlass": ((0.01, 0.01, 0.012), 0.2, 0.08, None),
    "rhLens": ((0.3, 0.02, 0.01), 0.0, 0.2, (1.0, 0.05, 0.02)),
    "rhLamp": ((0.3, 0.03, 0.02), 0.0, 0.4, (1.0, 0.1, 0.04)),
    "rhSearch": ((0.9, 0.85, 0.75), 0.0, 0.2, (1.0, 0.92, 0.8)),
    "rhRotor": ((0.05, 0.05, 0.05), 0.6, 0.5, None),
    # Ruins and factory.
    "rhConcrete": ((0.42, 0.41, 0.4), 0.0, 0.9, None),
    "rhConcreteDark": ((0.2, 0.19, 0.19), 0.0, 0.92, None),
    "rhRebar": ((0.2, 0.1, 0.06), 0.7, 0.7, None),
    "rhRust": ((0.3, 0.13, 0.06), 0.6, 0.75, None),
    "rhSteel": ((0.12, 0.12, 0.13), 0.85, 0.5, None),
    "rhBurnt": ((0.03, 0.025, 0.022), 0.2, 0.9, None),
    "rhWindow": ((0.02, 0.02, 0.025), 0.3, 0.1, None),
    "rhAsphalt": ((0.06, 0.06, 0.06), 0.0, 0.9, None),
    "rhPaint": ((0.25, 0.08, 0.04), 0.5, 0.55, None),
    "rhHot": ((0.4, 0.1, 0.02), 0.0, 0.5, (1.0, 0.45, 0.12)),
    "rhInterior": ((0.4, 0.3, 0.2), 0.0, 0.6, (1.0, 0.62, 0.32)),
    "rhWarning": ((0.3, 0.02, 0.01), 0.0, 0.4, (1.0, 0.06, 0.02)),
    "rhWreck": ((0.16, 0.07, 0.04), 0.3, 0.85, None),
}


def mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    col, metal, rough, emi = MATS[name]
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Metallic"].default_value = metal
    b.inputs["Roughness"].default_value = rough
    if emi:
        b.inputs["Emission Color"].default_value = (*emi, 1)
        b.inputs["Emission Strength"].default_value = 4.0
    return m


# ------------------------------------------------------------------ geometry helpers


def T(x=0.0, y=0.0, z=0.0):
    return Matrix.Translation(Vector((x, y, z)))


def R(rx=0.0, ry=0.0, rz=0.0):
    """Euler rotation in degrees (XYZ)."""
    return (Matrix.Rotation(math.radians(rz), 4, "Z") @ Matrix.Rotation(math.radians(ry), 4, "Y") @ Matrix.Rotation(math.radians(rx), 4, "X"))


def S(x=1.0, y=1.0, z=1.0):
    m = Matrix.Identity(4)
    m[0][0], m[1][1], m[2][2] = x, y, z
    return m


def aim(p0, p1):
    """Matrix placing +Z along p0 -> p1 with origin at p0; returns (matrix, length)."""
    a = Vector(p0)
    b = Vector(p1)
    d = b - a
    length = d.length
    q = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return T(*a) @ q.to_matrix().to_4x4(), length


def bm_box(bm, sx, sy, sz, m):
    bmesh.ops.create_cube(bm, size=1.0, matrix=m @ S(sx, sy, sz))


def bm_cyl(bm, r1, r2, depth, segs, m, caps=True):
    """Cylinder/cone along local Z, centred at the origin of m."""
    bmesh.ops.create_cone(bm, cap_ends=caps, cap_tris=False, segments=segs, radius1=r1, radius2=r2, depth=depth, matrix=m)


def bm_sphere(bm, r, m, u=12, v=8):
    bmesh.ops.create_uvsphere(bm, u_segments=u, v_segments=v, radius=r, matrix=m)


def bm_prism(bm, pts, thickness, m):
    """Extrudes a 2D outline (in local XY) by thickness along local Z (centred)."""
    h = thickness / 2
    lo = [bm.verts.new(m @ Vector((x, y, -h))) for x, y in pts]
    hi = [bm.verts.new(m @ Vector((x, y, h))) for x, y in pts]
    n = len(pts)
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))


def bm_shell(bm, r_in, r_out, a0, a1, z0, z1, segs, m):
    """Partial cylindrical shell around local Z (angles in degrees, 0 = +Y forward)."""
    ring = []
    for i in range(segs + 1):
        a = math.radians(a0 + (a1 - a0) * i / segs)
        s, c = math.sin(a), math.cos(a)
        ring.append([bm.verts.new(m @ Vector((s * r, c * r, z))) for r, z in ((r_in, z0), (r_out, z0), (r_out, z1), (r_in, z1))])
    for i in range(segs):
        a, b = ring[i], ring[i + 1]
        for k in range(4):
            k2 = (k + 1) % 4
            bm.faces.new((a[k], b[k], b[k2], a[k2]))
    bm.faces.new(list(reversed(ring[0])))
    bm.faces.new(ring[-1])


def bm_cap(bm, r_in, r_out, lat_max, segs_lat, segs_lon, m):
    """Spherical shell from the pole (+Z) down to `lat_max` degrees (domes, pauldrons, caps)."""
    outer, inner = [], []
    for i in range(1, segs_lat + 1):
        th = math.radians(lat_max * i / segs_lat)
        ro, ri = [], []
        for j in range(segs_lon):
            ph = 2 * math.pi * j / segs_lon
            d = Vector((math.sin(th) * math.cos(ph), math.sin(th) * math.sin(ph), math.cos(th)))
            ro.append(bm.verts.new(m @ (d * r_out)))
            ri.append(bm.verts.new(m @ (d * r_in)))
        outer.append(ro)
        inner.append(ri)
    po = bm.verts.new(m @ Vector((0, 0, r_out)))
    pi = bm.verts.new(m @ Vector((0, 0, r_in)))
    n = segs_lon
    for j in range(n):
        j2 = (j + 1) % n
        bm.faces.new((po, outer[0][j], outer[0][j2]))
        bm.faces.new((pi, inner[0][j2], inner[0][j]))
        for i in range(segs_lat - 1):
            bm.faces.new((outer[i][j], outer[i + 1][j], outer[i + 1][j2], outer[i][j2]))
            bm.faces.new((inner[i][j], inner[i][j2], inner[i + 1][j2], inner[i + 1][j]))
        bm.faces.new((outer[-1][j], inner[-1][j], inner[-1][j2], outer[-1][j2]))


def bm_tube(bm, points, r, segs=6, closed_caps=True):
    """A tube swept along a polyline with parallel-transported frames (cables, hoses)."""
    pts = [Vector(p) for p in points]
    rings = []
    prev_n = None
    for i, p in enumerate(pts):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        if prev_n is None:
            up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            n = t.cross(up).normalized()
        else:
            n = (prev_n - t * prev_n.dot(t)).normalized()
        b = t.cross(n)
        prev_n = n
        rings.append([bm.verts.new(p + (n * math.cos(2 * math.pi * k / segs) + b * math.sin(2 * math.pi * k / segs)) * r) for k in range(segs)])
    for i in range(len(rings) - 1):
        for k in range(segs):
            k2 = (k + 1) % segs
            bm.faces.new((rings[i][k], rings[i][k2], rings[i + 1][k2], rings[i + 1][k]))
    if closed_caps:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])


def bm_strut(bm, p0, p1, w, d=None):
    m, length = aim(p0, p1)
    bm_box(bm, w, d if d is not None else w, length, m @ T(0, 0, length / 2))


def bm_ibeam(bm, p0, p1, h, w, t, roll=0.0):
    m, length = aim(p0, p1)
    m = m @ R(0, 0, roll)
    bm_box(bm, w, t, length, m @ T(0, h / 2 - t / 2, length / 2))
    bm_box(bm, w, t, length, m @ T(0, -h / 2 + t / 2, length / 2))
    bm_box(bm, t * 0.8, h, length, m @ T(0, 0, length / 2))


def bm_loft(bm, sections, sides=8, m=None, round_k=0.3):
    """Lofts rings along local Y: sections are (y, half width, half height, z centre); each ring is a
    rounded box section (a superellipse). Capped at both ends."""
    m = m or Matrix.Identity(4)
    e = 2.0 / (1.0 - round_k * 0.9)
    rings = []
    for y, hw, hh, zc in sections:
        ring = []
        for j in range(sides):
            a = 2 * math.pi * (j + 0.5) / sides
            c, s_ = math.cos(a), math.sin(a)
            ex = 1.0 / max(1e-6, (abs(c) ** e + abs(s_) ** e) ** (1.0 / e))
            ring.append(bm.verts.new(m @ Vector((c * ex * hw, y, zc + s_ * ex * hh))))
        rings.append(ring)
    for i in range(len(rings) - 1):
        for j in range(sides):
            j2 = (j + 1) % sides
            bm.faces.new((rings[i][j], rings[i][j2], rings[i + 1][j2], rings[i + 1][j]))
    bm.faces.new(rings[0])
    bm.faces.new(list(reversed(rings[-1])))


class Part:
    """One rigid part: built in a bmesh, bevelled, smoothed, bound to a bone."""

    def __init__(self, kit, name, material, bone):
        self.kit, self.name, self.material, self.bone = kit, name, material, bone
        self.bm = bmesh.new()

    def done(self, bevel=0.0, segs=1, sharp=40.0):
        bm = self.bm
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        if bevel > 0 and self.kit.lod == 0:
            edges = [e for e in bm.edges if e.is_manifold and e.calc_face_angle(0) > math.radians(30)]
            if edges:
                bmesh.ops.bevel(bm, geom=edges, offset=bevel, segments=segs, profile=0.5, affect="EDGES", clamp_overlap=True)
        for f in bm.faces:
            f.smooth = True
        for e in bm.edges:
            e.smooth = not (e.is_manifold and e.calc_face_angle(0) > math.radians(sharp))
        me = bpy.data.meshes.new(self.name)
        bm.to_mesh(me)
        bm.free()
        ob = bpy.data.objects.new(self.name, me)
        self.kit.coll.objects.link(ob)
        me.materials.append(mat(self.material))
        attr = me.attributes.new(name="_BONE", type="FLOAT", domain="POINT")
        for d in attr.data:
            d.value = float(self.bone)
        self.kit.objects.append(ob)
        return ob


class Kit:
    def __init__(self, name, lod=0):
        self.name = name
        self.lod = lod
        self.coll = bpy.data.collections.new(name + ("_lod" if lod else ""))
        bpy.context.scene.collection.children.link(self.coll)
        self.objects = []
        self.bones = []  # dicts: name, id, parent, pivot (blender coords)
        self.pistons = []

    def seg(self, n):
        return max(6, n // 2) if self.lod else n

    def part(self, name, material, bone):
        return Part(self, name, material, bone)

    def bone(self, name, parent, pivot):
        bid = len(self.bones)
        self.bones.append({"name": name, "id": bid, "parent": parent, "pivot": list(pivot)})
        return bid

    def bone_id(self, name):
        return next(b["id"] for b in self.bones if b["name"] == name)

    def piston(self, name, bone_a, a, bone_b, b, r_barrel, r_rod, material="rhPiston"):
        """A hydraulic ram: the barrel hangs from `a` on bone_a, the rod from `b` on bone_b; the game
        aims both at each other every frame, so the rod slides in the barrel as the joint moves."""
        self.pistons.append({"name": name, "boneA": bone_a, "a": list(a), "boneB": bone_b, "b": list(b)})
        k = len(self.pistons) - 1
        av, bv = Vector(a), Vector(b)
        length = (bv - av).length
        barrel_id = 100 + 2 * k
        rod_id = 101 + 2 * k
        m, _ = aim(av, bv)
        p = self.part(f"{name}_barrel", "rhFrame", barrel_id)
        bm_cyl(p.bm, r_barrel, r_barrel, length * 0.58, self.seg(12), m @ T(0, 0, length * 0.29))
        bm_cyl(p.bm, r_barrel * 1.25, r_barrel * 1.25, length * 0.05, self.seg(12), m @ T(0, 0, length * 0.56))
        bm_box(p.bm, r_barrel * 2.6, r_barrel * 1.2, r_barrel * 2.2, m @ T(0, 0, 0))
        p.done(bevel=r_barrel * 0.15)
        m2, _ = aim(bv, av)
        p = self.part(f"{name}_rod", material, rod_id)
        bm_cyl(p.bm, r_rod, r_rod, length * 0.62, self.seg(10), m2 @ T(0, 0, length * 0.31))
        p.done()
        p = self.part(f"{name}_eye", "rhJoint", rod_id)
        bm_box(p.bm, r_barrel * 2.2, r_barrel * 1.1, r_barrel * 2.0, m2)
        p.done(bevel=r_barrel * 0.12)

    def scale_bones(self, ids, center, factor):
        """Scales every part bound to `ids` about `center`, with those bones' pivots and anchors."""
        c = Vector(center)
        m = T(*c) @ S(factor, factor, factor) @ T(*(-c))
        for ob in self.objects:
            bone = int(round(ob.data.attributes["_BONE"].data[0].value))
            if bone in ids:
                ob.data.transform(m)
        for b in self.bones:
            if b["id"] in ids:
                b["pivot"] = list(m @ Vector(b["pivot"]))
        for pst in self.pistons:
            if pst["boneB"] in ids:
                pst["b"] = list(m @ Vector(pst["b"]))

    def join(self, export_name, extra=None):
        bpy.ops.object.select_all(action="DESELECT")
        for ob in self.objects:
            ob.select_set(True)
        bpy.context.view_layer.objects.active = self.objects[0]
        bpy.ops.object.join()
        ob = bpy.context.view_layer.objects.active
        ob.name = export_name
        self.joined = ob
        return ob


def export_static(objects, path):
    bpy.ops.object.select_all(action="DESELECT")
    for ob in objects:
        ob.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    ensure_dir(os.path.dirname(path))
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True, export_texcoords=False, export_normals=True, export_materials="EXPORT", export_yup=True)
    return sum(len(p.vertices) - 2 for ob in objects for p in ob.data.polygons)


def to_game(p):
    return [round(p[0], 5), round(p[2], 5), round(-p[1], 5)]


def export_rigged(kit, path, rig_path=None, meta=None):
    ob = kit.joined
    bpy.ops.object.select_all(action="DESELECT")
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    ensure_dir(os.path.dirname(path))
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=False,
        export_normals=True,
        export_attributes=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    tris = sum(len(p.vertices) - 2 for p in ob.data.polygons)
    if rig_path:
        rig = {
            "name": kit.name,
            "generator": "assets/blender/scripts/red_horizon_kit.py",
            "license": "Original work for Prismfall",
            "forward": "-z",
            "bones": [{"name": b["name"], "id": b["id"], "parent": b["parent"], "pivot": to_game(b["pivot"])} for b in kit.bones],
            "pistons": [{"name": p["name"], "boneA": p["boneA"], "a": to_game(p["a"]), "boneB": p["boneB"], "b": to_game(p["b"]), "barrel": 100 + 2 * i, "rod": 101 + 2 * i} for i, p in enumerate(kit.pistons)],
            "triangles": tris,
        }
        if meta:
            rig.update(meta)
        write_metadata(rig_path, rig)
    return tris


# ------------------------------------------------------------------ the sentinel (humanoid machine)


def sentinel(lod=0):
    """A 2.55 m humanoid machine: exposed vertebral column, caged ribs under overlapping chest plates,
    heat-sink back pack, ball-jointed limbs with hydraulic rams at knees, ankles, elbows and neck,
    three-fingered hands with a thumb. Three interchangeable sensor heads (never a skull):
      A  a forward-raked wedge with a horizontal slit visor holding a segmented sensor bar,
      B  a squat turret with a triangular cluster of three lenses behind an iris ring,
      C  an asymmetric helmet carrying one large lens on a transverse rotating drum.
    """
    k = Kit("sentinel", lod)
    # ---- Skeleton (Blender coords, metres). Sides: L = +x.
    pelvis = k.bone("pelvis", -1, (0, 0, 1.28))
    torso = k.bone("torso", pelvis, (0, -0.02, 1.42))
    heads = [k.bone(f"head{c}", torso, (0, 0.02, 2.2)) for c in "ABC"]
    sensors = [k.bone("sensorA", heads[0], (0, 0.17, 2.35)), k.bone("sensorB", heads[1], (0, 0.12, 2.37)), k.bone("sensorC", heads[2], (0.0, 0.08, 2.40))]
    legs = {}
    arms = {}
    for side, s in (("L", 1), ("R", -1)):
        thigh = k.bone(f"thigh{side}", pelvis, (s * 0.17, 0, 1.24))
        shin = k.bone(f"shin{side}", thigh, (s * 0.185, 0.035, 0.7))
        foot = k.bone(f"foot{side}", shin, (s * 0.19, -0.02, 0.13))
        toe = k.bone(f"toe{side}", foot, (s * 0.19, 0.15, 0.045))
        legs[side] = (thigh, shin, foot, toe)
        upper = k.bone(f"upper{side}", torso, (s * 0.34, -0.03, 2.0))
        fore = k.bone(f"fore{side}", upper, (s * 0.37, -0.05, 1.56))
        hand = k.bone(f"hand{side}", fore, (s * 0.37, 0.0, 1.15))
        fingers = k.bone(f"fingers{side}", hand, (s * 0.37, 0.015, 1.06))
        arms[side] = (upper, fore, hand, fingers)

    # ---- Pelvis.
    p = k.part("pelvis_block", "rhFrame", pelvis)
    bm_prism(p.bm, [(-0.2, -0.06), (0.2, -0.06), (0.17, 0.1), (-0.17, 0.1)], 0.24, T(0, 0, 1.28) @ R(90, 0, 0) @ R(0, 0, 0))
    bm_box(p.bm, 0.18, 0.2, 0.09, T(0, 0, 1.38))
    p.done(bevel=0.012)
    p = k.part("pelvis_armour", "rhArmour", pelvis)
    bm_prism(p.bm, [(-0.13, 0.0), (0.13, 0.0), (0.09, -0.16), (0.0, -0.2), (-0.09, -0.16)], 0.035, T(0, 0.135, 1.3) @ R(90 + 12, 0, 0))
    for s in (1, -1):
        bm_prism(p.bm, [(0, 0.06), (0.11, 0.04), (0.12, -0.14), (0.02, -0.2), (-0.04, -0.08)], 0.03, T(s * 0.235, 0.01, 1.28) @ R(90, 0, 90))
    p.done(bevel=0.008)
    p = k.part("pelvis_joints", "rhJoint", pelvis)
    for s in (1, -1):
        bm_cyl(p.bm, 0.075, 0.075, 0.1, k.seg(16), T(s * 0.15, 0, 1.24) @ R(0, 90, 0))
    bm_cyl(p.bm, 0.1, 0.1, 0.05, k.seg(18), T(0, -0.02, 1.405))
    p.done(bevel=0.008)

    # ---- Torso: spine, ribs, chest plates, back pack, shoulder yoke.
    p = k.part("spine", "rhJoint", torso)
    for i in range(5):
        bm_cyl(p.bm, 0.066 - i * 0.003, 0.066 - i * 0.003, 0.035, k.seg(14), T(0, -0.04, 1.47 + i * 0.058))
    bm_cyl(p.bm, 0.028, 0.028, 0.34, k.seg(10), T(0, -0.04, 1.6))
    p.done(bevel=0.005)
    p = k.part("ribcage", "rhFrame", torso)
    for s in (1, -1):
        # Curved ribs: three per side, from the spine around to the sternum.
        for i, z in enumerate((1.74, 1.83, 1.92)):
            w = 0.2 + i * 0.025
            pts = [(s * 0.03, -0.07, z - 0.02), (s * w * 0.75, -0.08, z), (s * w, 0.0, z + 0.02), (s * w * 0.8, 0.1, z + 0.03), (s * 0.05, 0.13, z + 0.02)]
            bm_tube(p.bm, pts, 0.016, k.seg(6) if not lod else 4)
        bm_strut(p.bm, (s * 0.12, -0.08, 1.66), (s * 0.27, -0.05, 2.0), 0.045, 0.05)
    bm_box(p.bm, 0.08, 0.05, 0.36, T(0, 0.13, 1.86))
    for sd in (1, -1):
        bm_strut(p.bm, (sd * 0.04, 0.1, 2.05), (sd * 0.3, -0.02, 2.04), 0.06, 0.07)
        bm_strut(p.bm, (sd * 0.05, -0.12, 2.06), (sd * 0.3, -0.05, 2.03), 0.05, 0.05)
        bm_cyl(p.bm, 0.06, 0.06, 0.08, k.seg(14), T(sd * 0.29, -0.03, 2.0) @ R(0, 90, 0))
    bm_box(p.bm, 0.3, 0.2, 0.08, T(0, -0.04, 1.69))
    p.done(bevel=0.01)
    p = k.part("chest_armour", "rhArmour", torso)
    for s in (1, -1):
        bm_prism(p.bm, [(0.02, 0.0), (0.24, 0.02), (0.26, -0.12), (0.16, -0.26), (0.03, -0.24)], 0.03, T(s * 0.0, 0.16, 2.02) @ R(90 - 8, 0, -s * 10) @ S(s, 1, 1))
    for i in range(3):
        w = 0.24 - i * 0.025
        bm_prism(p.bm, [(-w / 2, 0), (w / 2, 0), (w / 2 - 0.02, -0.07), (-w / 2 + 0.02, -0.07)], 0.024, T(0, 0.115 - i * 0.004, 1.69 - i * 0.07) @ R(90 + 6, 0, 0))
    bm_box(p.bm, 0.26, 0.17, 0.05, T(0, -0.03, 2.12))
    for sd in (1, -1):
        # Trapezius plates sloping from the collar down to the shoulders.
        bm_prism(p.bm, [(0.0, 0.0), (0.2, -0.05), (0.2, -0.1), (0.0, -0.06)], 0.2, T(sd * 0.1, -0.03, 2.17) @ R(90, 0, 0) @ S(sd, 1, 1))
        # Sternum keel and the upper chest plate.
    bm_prism(p.bm, [(-0.035, 0.0), (0.035, 0.0), (0.02, -0.3), (-0.02, -0.3)], 0.05, T(0, 0.17, 2.05) @ R(90 - 6, 0, 0))
    p.done(bevel=0.007)
    p = k.part("backpack", "rhFrame", torso)
    bm_box(p.bm, 0.34, 0.16, 0.34, T(0, -0.2, 1.86))
    for i in range(7 if not lod else 3):
        x = -0.15 + i * (0.3 / (6 if not lod else 2))
        bm_box(p.bm, 0.012, 0.07, 0.28, T(x, -0.3, 1.86))
    bm_cyl(p.bm, 0.035, 0.035, 0.3, k.seg(10), T(0.13, -0.27, 1.98) @ R(0, 90, 0))
    p.done(bevel=0.008)
    p = k.part("backpack_lamp", "rhLamp", torso)
    bm_box(p.bm, 0.05, 0.012, 0.018, T(-0.11, -0.283, 2.0))
    p.done()
    if not lod:
        p = k.part("hoses", "rhCable", torso)
        for s in (1, -1):
            bm_tube(p.bm, [(s * 0.09, -0.26, 1.72), (s * 0.15, -0.2, 1.62), (s * 0.16, -0.1, 1.55), (s * 0.12, -0.02, 1.48)], 0.014, 6)
            bm_tube(p.bm, [(s * 0.14, -0.22, 2.02), (s * 0.24, -0.12, 2.06), (s * 0.3, -0.06, 2.04)], 0.012, 6)
        p.done()

    # ---- Heads.
    # A: forward-raked wedge with a slit visor.
    hA, hB, hC = heads
    p = k.part("headA_shell", "rhArmour", hA)
    bm_prism(p.bm, [(-0.13, 2.27), (0.15, 2.29), (0.2, 2.345), (0.155, 2.43), (-0.08, 2.455), (-0.16, 2.37)], 0.2, R(90, 0, 90) @ S(1, 1, 1) @ R(0, 0, 0))
    p.done(bevel=0.012, segs=2)
    p = k.part("headA_fins", "rhFrame", hA)
    for s in (1, -1):
        for i in range(3):
            bm_box(p.bm, 0.012, 0.11, 0.022, T(s * 0.105, -0.05, 2.33 + i * 0.035))
    bm_cyl(p.bm, 0.006, 0.004, 0.16, 6, T(-0.05, -0.12, 2.52) @ R(-18, 0, 0))
    p.done()
    p = k.part("headA_slit", "rhGlass", hA)
    bm_box(p.bm, 0.205, 0.05, 0.034, T(0, 0.17, 2.353) @ R(-8, 0, 0))
    p.done(bevel=0.004)
    p = k.part("headA_bar", "rhLens", sensors[0])
    for i in range(7):
        bm_box(p.bm, 0.022, 0.012, 0.016, T(-0.075 + i * 0.025, 0.194, 2.353) @ R(-8, 0, 0))
    p.done()
    # B: squat turret, tri-lens cluster behind an iris ring.
    p = k.part("headB_shell", "rhArmour", hB)
    bm_cyl(p.bm, 0.115, 0.1, 0.24, k.seg(18), T(0, 0.0, 2.36) @ R(-90, 0, 0) @ S(1, 0.85, 1))
    bm_box(p.bm, 0.17, 0.12, 0.12, T(0, -0.13, 2.36))
    for s in (1, -1):
        bm_prism(p.bm, [(0, 0), (0.14, 0.02), (0.15, -0.06), (0.02, -0.09)], 0.02, T(s * 0.118, 0.02, 2.4) @ R(90, 0, 90))
    p.done(bevel=0.008, segs=2)
    p = k.part("headB_face", "rhGlass", hB)
    bm_cyl(p.bm, 0.088, 0.088, 0.02, k.seg(18), T(0, 0.125, 2.36) @ R(-90, 0, 0))
    p.done()
    p = k.part("headB_iris", "rhJoint", sensors[1])
    for (x, z) in ((-0.042, 2.385), (0.042, 2.385), (0.0, 2.315)):
        bm_cyl(p.bm, 0.032, 0.032, 0.03, k.seg(12), T(x, 0.14, z) @ R(-90, 0, 0))
    p.done(bevel=0.003)
    p = k.part("headB_lenses", "rhLens", sensors[1])
    for (x, z) in ((-0.042, 2.385), (0.042, 2.385), (0.0, 2.315)):
        bm_cyl(p.bm, 0.022, 0.018, 0.012, k.seg(12), T(x, 0.16, z) @ R(-90, 0, 0))
    p.done()
    # C: asymmetric helmet with one big lens on a rotating drum.
    p = k.part("headC_shell", "rhArmour", hC)
    bm_prism(p.bm, [(-0.14, 2.26), (0.1, 2.27), (0.13, 2.34), (0.04, 2.37), (-0.12, 2.42), (-0.17, 2.34)], 0.2, R(90, 0, 90))
    bm_box(p.bm, 0.05, 0.16, 0.1, T(-0.115, -0.02, 2.36))
    p.done(bevel=0.012, segs=2)
    p = k.part("headC_drum", "rhJoint", sensors[2])
    bm_cyl(p.bm, 0.062, 0.062, 0.17, k.seg(16), T(0.02, 0.08, 2.40) @ R(0, 90, 0))
    bm_cyl(p.bm, 0.048, 0.044, 0.05, k.seg(14), T(0.035, 0.135, 2.40) @ R(-90, 0, 0))
    p.done(bevel=0.004)
    p = k.part("headC_lens", "rhLens", sensors[2])
    bm_cyl(p.bm, 0.036, 0.03, 0.012, k.seg(16), T(0.035, 0.162, 2.40) @ R(-90, 0, 0))
    p.done()
    for h in heads:
        p = k.part(f"neck_{h}", "rhJoint", h)
        for i in range(3):
            bm_cyl(p.bm, 0.045 - i * 0.004, 0.045 - i * 0.004, 0.03, k.seg(12), T(0, 0.0, 2.17 + i * 0.04))
        p.done(bevel=0.004)

    # ---- Arms.
    for side, s in (("L", 1), ("R", -1)):
        upper, fore, hand, fingers = arms[side]
        p = k.part(f"shoulder{side}", "rhJoint", upper)
        bm_sphere(p.bm, 0.07, T(s * 0.34, -0.03, 2.0), k.seg(14), k.seg(10))
        bm_cyl(p.bm, 0.055, 0.055, 0.11, k.seg(14), T(s * 0.37, -0.05, 1.56) @ R(0, 90, 0))
        p.done()
        p = k.part(f"upperarm{side}", "rhFrame", upper)
        bm_box(p.bm, 0.075, 0.07, 0.36, T(s * 0.36, -0.04, 1.78) @ R(0, 0, 0))
        bm_box(p.bm, 0.03, 0.03, 0.3, T(s * 0.36, -0.09, 1.79))
        p.done(bevel=0.008)
        p = k.part(f"pauldron{side}", "rhArmour", upper)
        bm_cap(p.bm, 0.1, 0.122, 62, k.seg(6), k.seg(16), T(s * 0.35, -0.035, 2.0) @ R(0, s * 38, 0) @ S(1, 1.1, 1))
        bm_cap(p.bm, 0.085, 0.104, 55, k.seg(5), k.seg(14), T(s * 0.38, -0.04, 1.9) @ R(0, s * 62, 0) @ S(1, 1.05, 1))
        p.done(bevel=0.004)
        p = k.part(f"forearm{side}", "rhFrame", fore)
        for dx in (-0.025, 0.025):
            bm_cyl(p.bm, 0.016, 0.016, 0.38, k.seg(8), T(s * 0.37 + dx, -0.03, 1.36))
        p.done()
        p = k.part(f"forearm_armour{side}", "rhArmour", fore)
        bm_prism(p.bm, [(-0.05, 0.0), (0.05, 0.0), (0.045, -0.26), (-0.04, -0.27)], 0.085, T(s * 0.37, 0.0, 1.5) @ R(90, 0, 0) @ R(0, 0, 0))
        p.done(bevel=0.01)
        p = k.part(f"wrist{side}", "rhJoint", hand)
        bm_sphere(p.bm, 0.036, T(s * 0.37, 0.0, 1.15), k.seg(10), k.seg(8))
        p.done()
        p = k.part(f"palm{side}", "rhFrame", hand)
        bm_box(p.bm, 0.04, 0.09, 0.1, T(s * 0.37, 0.01, 1.09))
        p.done(bevel=0.006)
        p = k.part(f"fingers{side}", "rhJoint", fingers)
        for i, y in enumerate((-0.025, 0.005, 0.035)):
            bm_box(p.bm, 0.016, 0.018, 0.05, T(s * 0.37, y, 1.025))
            bm_box(p.bm, 0.014, 0.016, 0.045, T(s * 0.37, y + 0.004, 0.978) @ R(-10, 0, 0))
        bm_box(p.bm, 0.016, 0.018, 0.05, T(s * 0.37 - s * 0.028, 0.045, 1.06) @ R(0, s * 35, 0))
        p.done(bevel=0.003 if not lod else 0)
        k.piston(f"elbow{side}", upper, (s * 0.37, 0.05, 1.94), fore, (s * 0.37, 0.04, 1.44), 0.022, 0.012)

    # ---- Legs.
    for side, s in (("L", 1), ("R", -1)):
        thigh, shin, foot, toe = legs[side]
        p = k.part(f"hip{side}", "rhJoint", thigh)
        bm_sphere(p.bm, 0.075, T(s * 0.17, 0, 1.24), k.seg(14), k.seg(10))
        p.done()
        p = k.part(f"thigh{side}", "rhFrame", thigh)
        bm_strut(p.bm, (s * 0.175, -0.01, 1.2), (s * 0.185, 0.03, 0.74), 0.1, 0.11)
        bm_strut(p.bm, (s * 0.2, -0.07, 1.18), (s * 0.19, -0.04, 0.78), 0.03, 0.03)
        p.done(bevel=0.01)
        p = k.part(f"thigh_armour{side}", "rhArmour", thigh)
        bm_shell(p.bm, 0.075, 0.1, -55, 55, 0.0, 0.36, k.seg(8), T(s * 0.18, 0.02, 0.8) @ R(4, 0, 0))
        bm_shell(p.bm, 0.09, 0.11, 50, 120, 0.05, 0.3, k.seg(5), T(s * 0.18, 0.0, 0.82) @ R(0, 0, s * -10) @ S(s, 1, 1))
        p.done(bevel=0.006)
        p = k.part(f"knee{side}", "rhJoint", shin)
        bm_cyl(p.bm, 0.07, 0.07, 0.14, k.seg(16), T(s * 0.185, 0.035, 0.7) @ R(0, 90, 0))
        p.done(bevel=0.006)
        p = k.part(f"shin{side}", "rhFrame", shin)
        bm_strut(p.bm, (s * 0.185, 0.03, 0.68), (s * 0.19, -0.015, 0.16), 0.08, 0.085)
        for dx in (-0.045, 0.045):
            bm_cyl(p.bm, 0.012, 0.012, 0.46, k.seg(8), T(s * 0.188 + dx, -0.04, 0.42))
        p.done(bevel=0.008)
        p = k.part(f"shin_armour{side}", "rhArmour", shin)
        bm_prism(p.bm, [(-0.06, 0.0), (0.06, 0.0), (0.055, -0.44), (0.0, -0.47), (-0.055, -0.44)], 0.03, T(s * 0.188, 0.085, 0.66) @ R(90 - 5, 0, 0))
        bm_shell(p.bm, 0.06, 0.08, -50, 50, -0.04, 0.05, k.seg(6), T(s * 0.185, 0.06, 0.72) @ R(0, 0, 0))
        p.done(bevel=0.006)
        p = k.part(f"ankle{side}", "rhJoint", foot)
        bm_sphere(p.bm, 0.05, T(s * 0.19, -0.02, 0.13), k.seg(12), k.seg(8))
        p.done()
        p = k.part(f"foot{side}", "rhFrame", foot)
        bm_prism(p.bm, [(-0.1, 0.0), (0.15, 0.0), (0.15, 0.05), (0.05, 0.09), (-0.06, 0.1), (-0.11, 0.06)], 0.13, T(s * 0.19, 0, 0.0) @ R(90, 0, 90) @ S(1, 1, 1))
        p.done(bevel=0.008)
        p = k.part(f"toe{side}", "rhArmour", toe)
        bm_prism(p.bm, [(0.0, 0.0), (0.1, 0.0), (0.1, 0.03), (0.02, 0.055), (0.0, 0.05)], 0.125, T(s * 0.19, 0.15, 0.0) @ R(90, 0, 90))
        p.done(bevel=0.006)
        k.piston(f"knee{side}", thigh, (s * 0.19, 0.11, 1.1), shin, (s * 0.19, 0.115, 0.58), 0.026, 0.014)
        k.piston(f"ankle{side}", shin, (s * 0.19, -0.09, 0.62), foot, (s * 0.19, -0.09, 0.08), 0.022, 0.012)

    # Neck rams (two, behind the neck stack).
    for s in (1, -1):
        k.piston(f"neck{'L' if s > 0 else 'R'}", torso, (s * 0.07, -0.08, 2.1), heads[0], (s * 0.06, -0.06, 2.3), 0.012, 0.007)
    # The sensor heads read better a little larger than first drawn.
    k.scale_bones(set(heads) | set(sensors), (0, 0.02, 2.16), 1.22)
    return k


# ------------------------------------------------------------------ previews


def keep_bones(ob, drop):
    """Deletes the vertices bound to any bone in `drop` (preview copies showing one head each)."""
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    layer = bm.verts.layers.float.get("_BONE")
    dead = [v for v in bm.verts if int(round(v[layer])) in drop]
    bmesh.ops.delete(bm, geom=dead, context="VERTS")
    bm.to_mesh(ob.data)
    bm.free()


def preview_copies(src, variants, spacing, yaw=(-25, 10, 40)):
    """Copies of a joined machine, one per head variant, side by side; the source is hidden."""
    out = []
    for i, drop in enumerate(variants):
        ob = src.copy()
        ob.data = src.data.copy()
        bpy.context.scene.collection.objects.link(ob)
        keep_bones(ob, drop)
        ob.location = ((i - (len(variants) - 1) / 2) * spacing, 0, 0)
        ob.rotation_euler = (0, 0, math.radians(yaw[i % len(yaw)]))
        out.append(ob)
    src.hide_render = True
    return out


def preview(path, cam, target, lens=50, res=(960, 540)):
    """Cycles preview with a low warm sun and a dim red-brown sky, like the world's light."""
    sun_data = bpy.data.lights.new("PreviewSun", "SUN")
    sun_data.energy = 3.0
    sun_data.color = (1.0, 0.7, 0.5)
    sun = bpy.data.objects.new("PreviewSun", sun_data)
    bpy.context.scene.collection.objects.link(sun)
    sun.rotation_euler = (math.radians(70), 0, math.radians(35))
    render_preview(path, camera_location=cam, target=target, lens=lens, resolution=res, samples=24)
    bpy.data.objects.remove(sun, do_unlink=True)


# ------------------------------------------------------------------ main

def main():
    a = args()
    only = a[a.index("--only") + 1] if "--only" in a else None
    reset_scene()
    ensure_dir(OUT)
    report = {}
    if only in (None, "machines"):
        k = sentinel(0)
        k.join("sentinel")
        report["sentinel"] = export_rigged(k, os.path.join(OUT, "sentinel.glb"), os.path.join(OUT, "sentinel.rig.json"), {"height": 2.46, "stride": 0.62})
        kl = sentinel(1)
        kl.join("sentinel_lod")
        report["sentinel_lod"] = export_rigged(kl, os.path.join(OUT, "sentinel_lod.glb"))
        kl.joined.hide_render = True
        kl.joined.location.x = 3
        from red_horizon_machines import colossus, drone

        kd = drone()
        kd.join("drone")
        report["drone"] = export_rigged(kd, os.path.join(OUT, "drone.glb"), os.path.join(OUT, "drone.rig.json"), {"span": 2.1})
        kc = colossus()
        kc.join("colossus")
        report["colossus"] = export_rigged(kc, os.path.join(OUT, "colossus.glb"), os.path.join(OUT, "colossus.rig.json"), {"height": 46.0})
        kd.joined.hide_render = True
        kc.joined.hide_render = True
    statics = {}
    if only in (None, "ruins", "factory"):
        from red_horizon_world import factory, ruins

        for name, fn in (("ruins", ruins), ("factory", factory)):
            if only not in (None, name):
                continue
            coll = bpy.data.collections.new(name)
            bpy.context.scene.collection.children.link(coll)
            obs = fn(coll)
            statics[name] = obs
            report[name] = export_static(obs, os.path.join(OUT, f"{name}.glb"))
            write_metadata(os.path.join(OUT, f"{name}.meta.json"), {
                "generator": "assets/blender/scripts/red_horizon_kit.py",
                "objects": [o.name for o in obs],
                "triangles": {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in obs},
                "materials": sorted({m.name for o in obs for m in o.data.materials}),
                "license": "Original work for Prismfall",
            })
    print("RED_HORIZON_OK", json.dumps(report))
    save_blend(os.path.join(SRC, "red_horizon.blend"))
    if "--no-preview" not in a and only in (None, "machines"):
        sid = {b["name"]: b["id"] for b in k.bones}
        hide = lambda keep: {sid[f"head{c}"] for c in "ABC" if c != keep} | {sid[f"sensor{c}"] for c in "ABC" if c != keep}
        copies = preview_copies(k.joined, [hide("A"), hide("B"), hide("C")], 1.1)
        preview(os.path.join(PREV, "red_horizon_sentinel.png"), (1.2, 6.5, 1.9), (0, 0, 1.25), 40)
        preview(os.path.join(PREV, "red_horizon_sentinel_heads.png"), (0.4, 2.2, 2.5), (0, 0, 2.3), 55)
        for ob in copies:
            bpy.data.objects.remove(ob, do_unlink=True)
        kc.joined.hide_render = False
        preview(os.path.join(PREV, "red_horizon_colossus.png"), (62, 70, 30), (0, 0, 22), 35)
        kc.joined.hide_render = True
        kd.joined.hide_render = False
        preview(os.path.join(PREV, "red_horizon_drone.png"), (2.2, 2.6, 1.2), (0, 0, -0.05), 45)
        kd.joined.hide_render = True
    if "--no-preview" not in a and "ruins" in statics:
        for ob in bpy.context.scene.objects:
            ob.hide_render = True
        x = 0.0
        for ob in statics["ruins"]:
            ob.hide_render = False
            w = max(ob.dimensions.x, 6.0)
            ob.location = (x + w / 2, 0, 0)
            x += w + 6
        preview(os.path.join(PREV, "red_horizon_ruins.png"), (x / 2, -260, 70), (x / 2, 0, 25), 35, (1600, 600))
        for ob in statics["ruins"]:
            ob.location = (0, 0, 0)
            ob.hide_render = True
    if "--no-preview" not in a and "factory" in statics:
        for ob in bpy.context.scene.objects:
            ob.hide_render = True
        for ob in statics["factory"]:
            ob.hide_render = not ob.name.startswith("factory_")
        preview(os.path.join(PREV, "red_horizon_factory.png"), (60, -150, 40), (0, 0, 15), 35, (1280, 640))


if __name__ == "__main__":
    main()
