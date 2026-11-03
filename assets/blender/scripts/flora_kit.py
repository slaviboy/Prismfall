"""Shared flora and prop kit: trees, plants, rocks, crystals and small structures for instancing.

Every object sits at the world origin with its base at z = 0 (Blender Z-up) so the game's scatter
component can place, rotate, scale and sway instances over any terrain. Object names are the keys
stages use (`mesh: "pine"`). Material names map to in-game presets.

Usage: blender -b --factory-startup --python assets/blender/scripts/flora_kit.py -- [--no-preview]
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "flora")
OUT_GLB = os.path.join(OUT_DIR, "flora.glb")
OUT_META = os.path.join(OUT_DIR, "flora.meta.json")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "flora.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "flora.png")

MATS = {}


def setup_materials():
    spec = {
        "bark": ((0.32, 0.2, 0.12), 0.9, None),
        "barkDark": ((0.18, 0.12, 0.09), 0.9, None),
        "needles": ((0.12, 0.3, 0.18), 0.8, None),
        "leaves": ((0.2, 0.45, 0.16), 0.75, None),
        "blossom": ((0.98, 0.7, 0.8), 0.7, None),
        "snow": ((0.95, 0.97, 1.0), 0.6, None),
        "rock": ((0.42, 0.4, 0.38), 0.9, None),
        "crystal": ((0.6, 0.85, 1.0), 0.15, None),
        "glow": ((0.4, 1.0, 0.8), 0.4, (0.4, 1.0, 0.8)),
        "capRed": ((0.75, 0.18, 0.12), 0.6, None),
        "stem": ((0.9, 0.86, 0.78), 0.7, None),
        "kelp": ((0.25, 0.42, 0.12), 0.6, None),
        "coral": ((0.95, 0.45, 0.4), 0.7, None),
        "stone": ((0.6, 0.58, 0.54), 0.85, None),
        "lanternGlow": ((1.0, 0.75, 0.4), 0.5, (1.0, 0.7, 0.35)),
        "ice": ((0.75, 0.9, 1.0), 0.1, None),
    }
    for name, (color, rough, emission) in spec.items():
        MATS[name] = common.make_material(name, color=color, roughness=rough, emission=emission, emission_strength=2.0 if emission else 0.0)


def active():
    return bpy.context.view_layer.objects.active


def apply_all(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def join(objects, name):
    for o in objects:
        apply_all(o)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = active()
    obj.name = name
    obj.location = (0, 0, 0)
    return obj


def mat(obj, name):
    obj.data.materials.clear()
    obj.data.materials.append(MATS[name])
    return obj


def cone(r1, r2, depth, z, verts=10, material="needles"):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r1, radius2=r2, depth=depth, location=(0, 0, z + depth / 2))
    return mat(active(), material)


def cyl(r, depth, loc, rot=(0, 0, 0), verts=8, material="bark"):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=depth, location=loc, rotation=rot)
    return mat(active(), material)


def blob(radius, loc, subdiv=2, material="leaves", jitter=0.25, seed=0, squash=1.0):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=radius, location=loc)
    o = active()
    off = Vector((seed * 3.1, seed * 1.7, seed * 2.3))
    for v in o.data.vertices:
        n = noise.noise(v.co * (1.6 / radius) + off)
        v.co *= 1 + n * jitter
        v.co.z *= squash
    return mat(o, material)


def branch(start, end, r0, r1, material="bark"):
    """Tapered cylinder between two points."""
    s = Vector(start)
    e = Vector(end)
    d = e - s
    bpy.ops.mesh.primitive_cone_add(vertices=7, radius1=r0, radius2=r1, depth=d.length, location=s + d / 2)
    o = active()
    o.rotation_mode = "QUATERNION"
    o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
    return mat(o, material)


def finish(obj, smooth=40, ao=True):
    common.shade_smooth_by_angle(obj, smooth)
    if ao:
        common.bake_dirty_vertex_ao(obj)
    return obj


# --- Trees --------------------------------------------------------------------------------


def pine(name, snow=False, seed=1):
    rng = random.Random(seed)
    parts = [cyl(0.28, 2.4, (0, 0, 1.2), material="bark")]
    tiers = 5
    for i in range(tiers):
        t = i / (tiers - 1)
        r = 2.4 * (1 - t * 0.78)
        z = 1.4 + i * 1.55
        c = cone(r, r * 0.08, 2.6, z, verts=12)
        for v in c.data.vertices:
            v.co.x += (rng.random() - 0.5) * 0.25
            v.co.y += (rng.random() - 0.5) * 0.25
        if snow:
            # Snow caps the upper part of each tier; the needles show below.
            c.data.materials.append(MATS["snow"])
            for poly in c.data.polygons:
                if poly.center.z > z + 2.6 * 0.68 and rng.random() < 0.6:
                    poly.material_index = 1
        parts.append(c)
    obj = join(parts, name)
    return finish(obj, 30)


def cherry(name, seed=2):
    rng = random.Random(seed)
    parts = [branch((0, 0, 0), (0.3, 0.1, 2.6), 0.42, 0.3, "barkDark")]
    tips = []
    for i in range(4):
        a = i / 4 * math.tau + rng.random() * 0.6
        end = (0.3 + math.cos(a) * 2.2, 0.1 + math.sin(a) * 2.2, 3.6 + rng.random() * 1.2)
        parts.append(branch((0.3, 0.1, 2.4), end, 0.22, 0.08, "barkDark"))
        tips.append(end)
    for i, t in enumerate(tips):
        parts.append(blob(1.5 + rng.random() * 0.5, (t[0], t[1], t[2] + 0.4), 2, "blossom", 0.3, seed + i, 0.75))
    parts.append(blob(1.9, (0.3, 0.1, 4.6), 2, "blossom", 0.3, seed + 9, 0.7))
    return finish(join(parts, name), 50)


def giant_tree(name, seed=3):
    rng = random.Random(seed)

    def r(t, z, k):
        flare = [3.2, 2.0, 1.5, 1.35, 1.25, 1.15][k]
        roots = 1 + 0.35 * max(0.0, math.cos(t * 5)) * (1 if k == 0 else 0.3 if k == 1 else 0)
        return flare * roots

    rings = [0, 1.2, 3.5, 7, 10.5, 13]
    verts = []
    seg = 18
    for k, z in enumerate(rings):
        for i in range(seg):
            t = i / seg * math.tau
            rad = r(t, z, k) * (1 + noise.noise(Vector((math.cos(t), math.sin(t), z * 0.2))) * 0.12)
            verts.append((math.cos(t) * rad, math.sin(t) * rad, z))
    faces = []
    for k in range(len(rings) - 1):
        for i in range(seg):
            a = k * seg + i
            b = k * seg + (i + 1) % seg
            faces.append((a, b, b + seg, a + seg))
    me = bpy.data.meshes.new(name + "_trunk")
    me.from_pydata(verts, [], faces)
    trunk = bpy.data.objects.new(name + "_trunk", me)
    bpy.context.collection.objects.link(trunk)
    trunk.data.materials.append(MATS["barkDark"])
    parts = [trunk]
    for i in range(5):
        a = i / 5 * math.tau + rng.random()
        end = (math.cos(a) * 6, math.sin(a) * 6, 15 + rng.random() * 3)
        parts.append(branch((0, 0, 12), end, 0.9, 0.35, "barkDark"))
        parts.append(blob(4 + rng.random() * 1.5, (end[0], end[1], end[2] + 1.5), 2, "leaves", 0.35, seed + i, 0.65))
    parts.append(blob(6, (0, 0, 19), 2, "leaves", 0.35, seed + 11, 0.6))
    return finish(join(parts, name), 45)


def mushroom(name, seed=4, glow=True):
    def r(t, z, k):
        return [0.45, 0.32, 0.3, 0.34][k]

    rings = [0, 0.6, 1.4, 1.8]
    verts = []
    seg = 12
    for k, z in enumerate(rings):
        for i in range(seg):
            t = i / seg * math.tau
            verts.append((math.cos(t) * r(t, z, k), math.sin(t) * r(t, z, k), z))
    faces = [(k * seg + i, k * seg + (i + 1) % seg, (k + 1) * seg + (i + 1) % seg, (k + 1) * seg + i) for k in range(len(rings) - 1) for i in range(seg)]
    me = bpy.data.meshes.new(name + "_stem")
    me.from_pydata(verts, [], faces)
    stem = bpy.data.objects.new(name + "_stem", me)
    bpy.context.collection.objects.link(stem)
    stem.data.materials.append(MATS["stem"])
    bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=1.1, location=(0, 0, 1.7))
    cap = active()
    bm = bmesh.new()
    bm.from_mesh(cap.data)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.05], context="VERTS")
    bm.to_mesh(cap.data)
    bm.free()
    cap.scale = (1, 1, 0.55)
    mat(cap, "glow" if glow else "capRed")
    parts = [stem, cap]
    rng = random.Random(seed)
    for i in range(6):
        a = rng.random() * math.tau
        rr = rng.random() * 0.7
        parts.append(blob(0.12, (math.cos(a) * rr, math.sin(a) * rr, 1.7 + 0.55 * math.sqrt(max(0, 1 - rr * rr)) * 1.0), 1, "stem" if glow else "snow", 0.1, i))
    return finish(join(parts, name), 50)


def kelp(name, seed=5):
    """A tall wavy ribbon (two crossed strips) that sways in the current."""
    rng = random.Random(seed)
    parts = []
    for strip in range(2):
        verts = []
        faces = []
        segs = 18
        h = 18
        for i in range(segs + 1):
            t = i / segs
            z = t * h
            w = 0.5 * (1 - t * 0.6)
            wave = math.sin(t * 6 + seed) * 0.6
            ang = strip * math.pi / 2
            cx, cy = math.cos(ang), math.sin(ang)
            verts.append((-w * cx + wave * cy, -w * cy - wave * cx, z))
            verts.append((w * cx + wave * cy, w * cy - wave * cx, z))
        for i in range(segs):
            a = i * 2
            faces.append((a, a + 1, a + 3, a + 2))
        me = bpy.data.meshes.new(f"{name}_{strip}")
        me.from_pydata(verts, [], faces)
        o = bpy.data.objects.new(f"{name}_{strip}", me)
        bpy.context.collection.objects.link(o)
        o.data.materials.append(MATS["kelp"])
        parts.append(o)
    obj = join(parts, name)
    return finish(obj, 60, ao=False)


def coral_branch(name, seed=6):
    rng = random.Random(seed)
    parts = []

    def grow(p, d, length, r, depth):
        end = Vector(p) + Vector(d).normalized() * length
        parts.append(branch(p, end, r, r * 0.7, "coral"))
        if depth <= 0:
            parts.append(blob(r * 1.2, end, 1, "coral", 0.1, depth))
            return
        for _ in range(2):
            nd = Vector(d) + Vector(((rng.random() - 0.5) * 1.4, (rng.random() - 0.5) * 1.4, 0.4))
            grow(end, nd, length * 0.75, r * 0.7, depth - 1)

    grow((0, 0, 0), (0, 0, 1), 1.4, 0.35, 3)
    return finish(join(parts, name), 50)


def brain_coral(name, seed=7):
    o = blob(1.6, (0, 0, 0.6), 3, "coral", 0.18, seed, 0.6)
    for v in o.data.vertices:
        v.co += v.normal * math.sin(v.co.x * 6 + math.sin(v.co.y * 5) * 2) * 0.06
    o.name = name
    apply_all(o)
    return finish(o, 60)


def rock(name, seed, radius=1.5, squash=0.7, material="rock"):
    o = blob(radius, (0, 0, radius * squash * 0.55), 3, material, 0.35, seed, squash)
    o.name = name
    apply_all(o)
    return finish(o, 35)


def crystal_cluster(name, seed=8, material="crystal"):
    rng = random.Random(seed)
    parts = []
    for i in range(7):
        h = 1.5 + rng.random() * 3.5
        r = 0.25 + rng.random() * 0.3
        tilt = (rng.random() - 0.5) * 0.8
        a = rng.random() * math.tau
        bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=r, depth=h, location=(math.cos(a) * 0.5 * (i > 0), math.sin(a) * 0.5 * (i > 0), h / 2 - 0.2), rotation=(tilt * math.cos(a), tilt * math.sin(a), rng.random()))
        c = active()
        # Point the tip.
        top = max(v.co.z for v in c.data.vertices)
        for v in c.data.vertices:
            if v.co.z >= top - 1e-4:
                v.co.x *= 0.1
                v.co.y *= 0.1
                v.co.z += r * 1.4
        parts.append(mat(c, material))
    return finish(join(parts, name), 20)


def stone_lantern(name):
    parts = [
        cyl(0.7, 0.3, (0, 0, 0.15), verts=6, material="stone"),
        cyl(0.22, 1.4, (0, 0, 1.0), verts=6, material="stone"),
        cyl(0.6, 0.2, (0, 0, 1.8), verts=6, material="stone"),
        cyl(0.4, 0.7, (0, 0, 2.25), verts=6, material="lanternGlow"),
        cone(1.0, 0.15, 0.6, 2.6, verts=6, material="stone"),
        blob(0.18, (0, 0, 3.35), 1, "stone", 0.05),
    ]
    return finish(join(parts, name), 25)


def ice_spire(name, seed=9):
    rng = random.Random(seed)
    parts = []
    for i in range(5):
        h = 6 + rng.random() * 10
        r = 0.8 + rng.random() * 1.2
        a = rng.random() * math.tau
        d = 1.2 * (i > 0)
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=r, radius2=0.05, depth=h, location=(math.cos(a) * d, math.sin(a) * d, h / 2 - 0.5), rotation=((rng.random() - 0.5) * 0.25, (rng.random() - 0.5) * 0.25, rng.random()))
        parts.append(mat(active(), "ice"))
    return finish(join(parts, name), 15)


def iceberg(name, seed=10):
    o = blob(6, (0, 0, 1.5), 3, "ice", 0.35, seed, 0.55)
    for v in o.data.vertices:
        if v.co.z > 3.2:
            v.co.z = 3.2 + (v.co.z - 3.2) * 0.3
    o.name = name
    apply_all(o)
    return finish(o, 25)


def build():
    setup_materials()
    objs = [
        pine("pine", False, 1),
        pine("pine_snow", True, 2),
        cherry("cherry", 3),
        giant_tree("giant_tree", 4),
        mushroom("mushroom_glow", 5, True),
        mushroom("mushroom_red", 6, False),
        kelp("kelp", 7),
        coral_branch("coral_branch", 8),
        brain_coral("coral_brain", 9),
        rock("rock_a", 11, 1.5, 0.7),
        rock("rock_b", 12, 2.2, 0.5),
        rock("asteroid", 13, 2.0, 1.0),
        crystal_cluster("crystal_cluster", 14, "crystal"),
        stone_lantern("stone_lantern"),
        ice_spire("ice_spire", 15),
        iceberg("iceberg", 16),
    ]
    # Lay them out in a row for the preview only; the export keeps each at the origin.
    return objs


def main():
    options = common.args()
    common.reset_scene()
    objects = build()
    tris = {o.name: sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects}
    common.ensure_dir(OUT_DIR)
    for o in objects:
        o.location = (0, 0, 0)
    common.export_glb(objects, OUT_GLB, vertex_colors=True)
    common.write_metadata(OUT_META, {
        "generator": "assets/blender/scripts/flora_kit.py",
        "objects": list(tris.keys()),
        "triangles": tris,
        "materials": list(MATS.keys()),
        "placement": "each object at the origin, base at z=0, for instancing",
        "license": "Original work for Prismfall",
    })
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        for i, o in enumerate(objects):
            o.location = ((i % 8) * 9 - 32, (i // 8) * 14, 0)
        common.render_preview(OUT_PREVIEW, camera_location=(0, -55, 22), target=(0, 6, 5), lens=30, samples=16)
    print("FLORA_OK", len(objects), "objects", sum(tris.values()), "triangles")


main()
