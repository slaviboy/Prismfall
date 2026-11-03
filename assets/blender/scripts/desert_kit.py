"""Moving Sands environment kit: original desert formations and ancient ruins.

Coordinates: Blender Z-up; the glTF export turns Blender +Y (depth) into three -Z. Every object's
origin sits at its base (z = 0) at its world (x, y) placement; the game snaps each top-level object
onto the procedural dunes (gltfScene snapToGround), so nothing floats whatever the terrain does.

Materials map to in-game presets by name: sandstone*, paleStone, darkStone -> stone; glyphGlow ->
emissive gold that breathes with the music.

Usage: blender -b --factory-startup --python assets/blender/scripts/desert_kit.py -- [--no-preview]
"""
import math
import os
import random
import sys

import bpy
from mathutils import Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "desert")
OUT_GLB = os.path.join(OUT_DIR, "desert.glb")
OUT_META = os.path.join(OUT_DIR, "desert.meta.json")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "environments", "moving_sands.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "moving_sands.png")

MATS = {}


def setup_materials():
    MATS["sandstone"] = common.make_material("sandstone", color=(0.78, 0.5, 0.31), roughness=0.9)
    MATS["sandstoneRed"] = common.make_material("sandstoneRed", color=(0.62, 0.32, 0.2), roughness=0.9)
    MATS["paleStone"] = common.make_material("paleStone", color=(0.85, 0.7, 0.52), roughness=0.85)
    MATS["darkStone"] = common.make_material("darkStone", color=(0.42, 0.28, 0.2), roughness=0.9)
    MATS["glyphGlow"] = common.make_material("glyphGlow", color=(1.0, 0.72, 0.32), roughness=0.4, emission=(1.0, 0.7, 0.3), emission_strength=3.0)


def mesh_object(name, verts, faces, material):
    me = bpy.data.meshes.new(name)
    me.from_pydata(verts, [], faces)
    me.validate()
    me.update()
    obj = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(MATS[material])
    return obj


def lathe(name, rings, segments, radius_fn, material, cap=True, phase=0.0):
    """Mesh from rings: rings = list of z heights; radius_fn(theta, z, k) -> radius (or (rx, ry))."""
    verts = []
    for k, z in enumerate(rings):
        for i in range(segments):
            t = phase + i / segments * math.tau
            r = radius_fn(t, z, k)
            rx, ry = (r, r) if not isinstance(r, tuple) else r
            verts.append((math.cos(t) * rx, math.sin(t) * ry, z))
    faces = []
    for k in range(len(rings) - 1):
        for i in range(segments):
            a = k * segments + i
            b = k * segments + (i + 1) % segments
            faces.append((a, b, b + segments, a + segments))
    if cap:
        top = len(verts)
        verts.append((0, 0, rings[-1]))
        base = (len(rings) - 1) * segments
        for i in range(segments):
            faces.append((base + i, base + (i + 1) % segments, top))
    return mesh_object(name, verts, faces, material)


def displace(obj, strength, size, kind="CLOUDS", subdiv=1):
    if subdiv:
        m = obj.modifiers.new("subdiv", "SUBSURF")
        m.levels = subdiv
        m.subdivision_type = "SIMPLE"
    tex = bpy.data.textures.new(f"{obj.name}_tex", kind)
    if kind == "CLOUDS":
        tex.noise_scale = size
        tex.noise_depth = 3
    else:
        tex.noise_scale = size
    d = obj.modifiers.new("displace", "DISPLACE")
    d.texture = tex
    d.strength = strength
    d.mid_level = 0.5
    d.texture_coords = "GLOBAL"
    common.apply_modifiers(obj)


def place(obj, x, y, z=0.0, rot_z=0.0, scale=1.0):
    obj.location = (x, y, z)
    obj.rotation_euler = (0, 0, math.radians(rot_z))
    obj.scale = (scale, scale, scale)
    return obj


def finish(obj, ao=1.0, smooth=40):
    common.shade_smooth_by_angle(obj, smooth)
    common.bake_dirty_vertex_ao(obj, ao)
    return obj


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    return obj


def box(name, size, location, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(MATS[material])
    return obj


# --- Formations ---------------------------------------------------------------------------


def mesa(name, radius, height, seed):
    rng = random.Random(seed)
    off = Vector((rng.random() * 50, rng.random() * 50, 0))
    rings = [-6, 0, height * 0.12, height * 0.3, height * 0.34, height * 0.62, height * 0.66, height * 0.94, height]

    def r(t, z, k):
        lobes = noise.noise(Vector((math.cos(t) * 1.3, math.sin(t) * 1.3, 0)) + off) * 0.22
        fine = noise.noise(Vector((math.cos(t) * 5, math.sin(t) * 5, z * 0.08)) + off) * 0.05
        # Talus apron at the foot, then stacked cliff bands with small ledges.
        taper = [1.45, 1.32, 1.12, 1.04, 0.98, 0.94, 0.9, 0.88, 0.86][k]
        return radius * taper * (1 + lobes + fine)

    obj = lathe(name, rings, 72, r, "sandstoneRed")
    displace(obj, radius * 0.05, radius * 0.25)
    return finish(obj, 1.2, 50)


def hoodoo(name, height, seed):
    rng = random.Random(seed)
    off = Vector((rng.random() * 30, rng.random() * 30, 0))
    profile = [3.4, 2.7, 2.1, 1.9, 2.3, 1.8, 1.25, 2.9, 3.0, 2.2]
    rings = [height * (i / (len(profile) - 1)) - 1.5 for i in range(len(profile))]

    def r(t, z, k):
        n = noise.noise(Vector((math.cos(t) * 1.6, math.sin(t) * 1.6, z * 0.15)) + off) * 0.2
        return profile[k] * (height / 18) * (1 + n)

    body = lathe(name, rings, 28, r, "sandstone")
    displace(body, 0.35, 1.6)
    return finish(body, 1.2, 50)


def arch(name):
    bpy.ops.mesh.primitive_torus_add(major_radius=17, minor_radius=4.2, major_segments=64, minor_segments=16, location=(0, 0, 0), rotation=(math.pi / 2, 0, 0))
    ring = bpy.context.view_layer.objects.active
    ring.name = name
    ring.scale = (1, 1.15, 1)
    bpy.ops.object.transform_apply(scale=True, rotation=True)
    me = ring.data
    # Keep the upper arc plus a little below the springline (it disappears into the sand).
    import bmesh

    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -3.0], context="VERTS")
    bm.to_mesh(me)
    bm.free()
    ring.data.materials.append(MATS["sandstone"])
    legs = []
    for side in (-1, 1):
        leg = lathe(f"{name}_leg{side}", [-6, 0, 6], 20, lambda t, z, k: [6.5, 5.6, 4.6][k], "sandstone")
        leg.location = (side * 17, 0, 0)
        bpy.ops.object.select_all(action="DESELECT")
        leg.select_set(True)
        bpy.context.view_layer.objects.active = leg
        bpy.ops.object.transform_apply(location=True)
        legs.append(leg)
    obj = join([ring, *legs], name)
    obj.location = (0, 0, 0)
    displace(obj, 1.1, 3.0)
    return finish(obj, 1.3, 50)


# --- Ruins --------------------------------------------------------------------------------


def column(name, height, broken, seed, radius=0.9):
    rng = random.Random(seed)
    rings = [0, 0.15 * height, 0.5 * height, 0.85 * height, height]

    def r(t, z, k):
        flute = 0.05 * math.cos(t * 20)
        taper = 1 - 0.12 * z / max(1, height)
        return radius * taper * (1 + flute)

    shaft = lathe(name, rings, 40, r, "paleStone", cap=True)
    if broken:
        # Jagged break: lift and drop top-ring vertices.
        top = shaft.data.vertices
        for v in top:
            if v.co.z >= height - 1e-3:
                v.co.z = height - rng.random() * 1.6
    parts = [shaft]
    parts.append(box(f"{name}_base", (radius * 2.6, radius * 2.6, 0.7), (0, 0, -0.3), "paleStone"))
    if not broken:
        parts.append(box(f"{name}_cap", (radius * 2.8, radius * 2.8, 0.6), (0, 0, height + 0.3), "paleStone"))
    return join(parts, name)


def colonnade(name):
    rng = random.Random(7)
    pieces = []
    # Stepped platform, mostly buried.
    pieces.append(box(f"{name}_step0", (36, 9, 4), (0, 0, -1.6), "sandstone"))
    pieces.append(box(f"{name}_step1", (33, 7, 1), (0, 0, 0.9), "sandstone"))
    heights = [11, 11, 11, 7.5, 11, 4.2, 9]
    for i, h in enumerate(heights):
        x = -13.5 + i * 4.5
        broken = h < 11
        c = column(f"{name}_col{i}", h, broken, i * 13)
        c.location = (x, 0, 1.4)
        pieces.append(c)
    # Architrave over the first three intact columns.
    pieces.append(box(f"{name}_beam", (10.8, 2.4, 1.6), (-9, 0, 1.4 + 11 + 1.4), "paleStone"))
    pieces.append(box(f"{name}_frieze", (10.8, 2.2, 0.6), (-9, 0, 1.4 + 11 + 2.5), "glyphGlow"))
    pieces.append(box(f"{name}_cornice", (11.4, 2.8, 0.6), (-9, 0, 1.4 + 11 + 3.1), "paleStone"))
    # Fallen drums in the sand.
    for j in range(4):
        bpy.ops.mesh.primitive_cylinder_add(vertices=28, radius=0.85, depth=2.2 + rng.random(), location=(rng.uniform(-14, 14), rng.uniform(5, 9), 0.4), rotation=(math.pi / 2, 0, rng.uniform(0, math.pi)))
        d = bpy.context.view_layer.objects.active
        d.data.materials.append(MATS["paleStone"])
        pieces.append(d)
    for p in pieces:
        bpy.ops.object.select_all(action="DESELECT")
        p.select_set(True)
        bpy.context.view_layer.objects.active = p
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj = join(pieces, name)
    displace(obj, 0.18, 0.8, subdiv=0)
    return finish(obj, 1.4, 35)


def gateway(name):
    pieces = []
    for side in (-1, 1):
        # Tapered pylon with a square section (4-sided lathe rotated 45 degrees).
        pylon = lathe(f"{name}_pylon{side}", [-3, 0, 22], 4, lambda t, z, k: [(6.4, 4.4), (6.0, 4.0), (4.4, 3.0)][k], "sandstone", phase=math.pi / 4)
        pylon.location = (side * 7.5, 0, 0)
        pieces.append(pylon)
        for b in range(3):
            pieces.append(box(f"{name}_band{side}{b}", (4.6 - b * 0.4, 0.25, 0.7), (side * 7.5, -3.1 + b * 0.1, 6 + b * 5.2), "glyphGlow"))
    pieces.append(box(f"{name}_lintel", (22, 5.2, 3.2), (0, 0, 23.2), "sandstone"))
    pieces.append(box(f"{name}_cornice", (24, 6.0, 1.0), (0, 0, 25.3), "darkStone"))
    pieces.append(box(f"{name}_sun", (3.2, 0.3, 1.2), (0, -2.75, 23.2), "glyphGlow"))
    for p in pieces:
        bpy.ops.object.select_all(action="DESELECT")
        p.select_set(True)
        bpy.context.view_layer.objects.active = p
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj = join(pieces, name)
    displace(obj, 0.25, 1.2, subdiv=1)
    return finish(obj, 1.3, 30)


def monolith(name, height, seed):
    rng = random.Random(seed)
    w = height * 0.11
    rings = [-2, 0, height * 0.9, height]

    def r(t, z, k):
        return [(w * 1.15, w * 0.85), (w * 1.1, w * 0.8), (w * 0.8, w * 0.6), (0.05, 0.05)][k]

    stone = lathe(name, rings, 4, r, "darkStone", phase=math.pi / 4)
    parts = [stone]
    for b in range(4):
        z = height * (0.2 + b * 0.17)
        sc = 1 - 0.3 * z / height
        parts.append(box(f"{name}_glyph{b}", (w * 1.25 * sc, w * 0.95 * sc, 0.22), (0, 0, z), "glyphGlow"))
    obj = join(parts, name)
    obj.rotation_euler = (math.radians(rng.uniform(-4, 4)), math.radians(rng.uniform(-4, 4)), 0)
    bpy.ops.object.transform_apply(rotation=True)
    displace(obj, 0.12, 0.6, subdiv=1)
    return finish(obj, 1.0, 30)


def stone_ring(name):
    """A colossal standing ring of carved stone, set so the low sun sits inside it."""
    bpy.ops.mesh.primitive_torus_add(major_radius=26, minor_radius=3.4, major_segments=96, minor_segments=18, location=(0, 0, 21), rotation=(math.pi / 2, 0, 0))
    ring = bpy.context.view_layer.objects.active
    ring.data.materials.append(MATS["sandstone"])
    parts = [ring]
    for i in range(12):
        a = i / 12 * math.tau
        x = math.cos(a) * 26
        z = 21 + math.sin(a) * 26
        parts.append(box(f"{name}_key{i}", (3.4, 9.2, 8.2), (x, 0, z), "darkStone", rotation=(0, -a, 0)))
    bpy.ops.mesh.primitive_torus_add(major_radius=22.4, minor_radius=0.45, major_segments=96, minor_segments=8, location=(0, -0.6, 21), rotation=(math.pi / 2, 0, 0))
    inner = bpy.context.view_layer.objects.active
    inner.data.materials.append(MATS["glyphGlow"])
    parts.append(inner)
    for p in parts:
        bpy.ops.object.select_all(action="DESELECT")
        p.select_set(True)
        bpy.context.view_layer.objects.active = p
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj = join(parts, name)
    displace(obj, 0.35, 1.5, subdiv=0)
    return finish(obj, 1.2, 35)


def build():
    setup_materials()
    objects = []
    objects.append(place(stone_ring("ring_gate"), -95, 285))
    objects.append(place(mesa("mesa_a", 70, 46, 1), -270, 430))
    objects.append(place(mesa("mesa_b", 52, 38, 2), 190, 390))
    objects.append(place(mesa("mesa_c", 90, 58, 3), 360, 540))
    objects.append(place(mesa("mesa_d", 110, 70, 4), -520, 640))
    objects.append(place(arch("arch"), 150, 205, rot_z=-18))
    for i, (x, y, h) in enumerate([(-150, 150, 22), (-168, 163, 15), (-134, 172, 18), (98, 122, 14), (236, 246, 24), (-230, 220, 20)]):
        objects.append(place(hoodoo(f"hoodoo_{i}", h, i + 10), x, y, rot_z=i * 47))
    objects.append(place(colonnade("colonnade"), -62, 96, rot_z=12))
    objects.append(place(gateway("gateway"), 58, 142, rot_z=-10))
    for i, (x, y, h) in enumerate([(-34, 72, 13), (-28, 77, 9), (40, 84, 11)]):
        objects.append(place(monolith(f"monolith_{i}", h, i), x, y, rot_z=i * 23 - 10))
    return objects


def main():
    options = common.args()
    common.reset_scene()
    objects = build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    common.ensure_dir(OUT_DIR)
    common.export_glb(objects, OUT_GLB, vertex_colors=True)
    common.write_metadata(OUT_META, {
        "generator": "assets/blender/scripts/desert_kit.py",
        "objects": len(objects),
        "triangles": tris,
        "placement": "origins at object bases; the game snaps each object to the dunes",
        "materials": list(MATS.keys()),
        "license": "Original work for Prismfall",
    })
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        common.render_preview(OUT_PREVIEW, camera_location=(0, -40, 30), target=(0, 200, 10), lens=22, samples=16)
    print("DESERT_OK", len(objects), "objects", tris, "triangles")


main()
