"""Frozen Kingdom kit: an original ice citadel, a crystal arch and rune monoliths.

Blender Z-up; every object's origin is at its base at its (x, y) placement so the game can snap it
onto the snowfield. Materials: iceWall (translucent-looking ice), iceDeep (darker ice), iceGlow
(inner light, emissive cyan), snowCap.

Usage: blender -b --factory-startup --python assets/blender/scripts/ice_kit.py -- [--no-preview]
"""
import math
import os
import random
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "ice")
OUT_GLB = os.path.join(OUT_DIR, "ice.glb")
OUT_META = os.path.join(OUT_DIR, "ice.meta.json")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "environments", "frozen_kingdom.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "frozen_kingdom.png")
MATS = {}


def setup():
    MATS["iceWall"] = common.make_material("iceWall", color=(0.62, 0.82, 0.95), roughness=0.12)
    MATS["iceDeep"] = common.make_material("iceDeep", color=(0.28, 0.5, 0.72), roughness=0.1)
    MATS["iceGlow"] = common.make_material("iceGlow", color=(0.5, 0.95, 1.0), roughness=0.3, emission=(0.4, 0.9, 1.0), emission_strength=3)
    MATS["snowCap"] = common.make_material("snowCap", color=(0.95, 0.97, 1.0), roughness=0.7)


def active():
    return bpy.context.view_layer.objects.active


def with_mat(o, name):
    o.data.materials.clear()
    o.data.materials.append(MATS[name])
    return o


def prism(r, h, loc, verts=6, material="iceWall", taper=1.0, rot=0.0):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=r * taper, depth=h, location=(loc[0], loc[1], loc[2] + h / 2), rotation=(0, 0, rot))
    return with_mat(active(), material)


def spire(r, h, loc, verts=6, material="iceDeep"):
    bpy.ops.mesh.primitive_cone_add(vertices=verts, radius1=r, radius2=0.02, depth=h, location=(loc[0], loc[1], loc[2] + h / 2))
    return with_mat(active(), material)


def box(size, loc, material="iceWall", rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = active()
    o.scale = size
    return with_mat(o, material)


def join(parts, name):
    for o in parts:
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    o = active()
    o.name = name
    return o


def finish(o, smooth=20):
    common.shade_smooth_by_angle(o, smooth)
    common.bake_dirty_vertex_ao(o)
    return o


def tower(x, y, r, h, parts, glow_rows=3):
    parts.append(prism(r, h, (x, y, -4), 6, "iceWall", 0.86))
    parts.append(prism(r * 1.12, 1.2, (x, y, h - 4.6), 6, "snowCap"))
    parts.append(spire(r * 1.05, h * 0.55, (x, y, h - 3.6), 6, "iceDeep"))
    for k in range(glow_rows):
        z = h * (0.25 + k * 0.2) - 4
        for a in range(3):
            ang = a / 3 * math.tau + k * 0.5
            parts.append(box((0.35, 0.12, 1.6), (x + math.cos(ang) * r * 0.9, y + math.sin(ang) * r * 0.9, z), "iceGlow", (0, 0, ang + math.pi / 2)))


def citadel(name):
    parts = []
    tower(0, 0, 4.2, 46, parts, 4)
    for i, (dx, dy, r, h) in enumerate([(-16, 6, 2.8, 30), (16, 5, 2.8, 32), (-9, -10, 2.2, 24), (10, -9, 2.4, 26), (0, 16, 2.6, 28)]):
        tower(dx, dy, r, h, parts, 2)
        # Walls with arched openings linking to the keep.
        mx, my = dx / 2, dy / 2
        length = math.hypot(dx, dy)
        ang = math.atan2(dy, dx)
        parts.append(box((length, 1.4, 9), (mx, my, 0.5), "iceWall", (0, 0, ang)))
        parts.append(box((length * 0.92, 1.8, 0.8), (mx, my, 5.3), "snowCap", (0, 0, ang)))
        parts.append(box((2.2, 1.6, 4.2), (mx, my, -1.4), "iceGlow", (0, 0, ang)))
    return finish(join(parts, name))


def crystal_arch(name):
    parts = []
    for side in (-1, 1):
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=2.4, radius2=0.4, depth=26, location=(side * 7, 0, 10), rotation=(0, side * -0.42, 0))
        parts.append(with_mat(active(), "iceWall"))
        bpy.ops.mesh.primitive_cone_add(vertices=5, radius1=1.2, radius2=0.1, depth=14, location=(side * 9.5, 1.5, 4), rotation=(0.2, side * -0.25, 0))
        parts.append(with_mat(active(), "iceDeep"))
    parts.append(box((3.2, 2, 2.4), (0, 0, 21), "iceGlow"))
    return finish(join(parts, name))


def monolith(name, h, seed):
    rng = random.Random(seed)
    parts = [prism(1.4, h, (0, 0, -1.5), 4, "iceDeep", 0.7, math.pi / 4)]
    for k in range(4):
        z = h * (0.2 + k * 0.17) - 1.5
        parts.append(box((1.9 - k * 0.15, 1.9 - k * 0.15, 0.25), (0, 0, z), "iceGlow", (0, 0, math.pi / 4)))
    o = join(parts, name)
    o.rotation_euler = (math.radians(rng.uniform(-5, 5)), math.radians(rng.uniform(-5, 5)), 0)
    bpy.ops.object.transform_apply(rotation=True)
    return finish(o)


def place(o, x, y, rot=0.0, scale=1.0):
    o.location = (x, y, 0)
    o.rotation_euler = (0, 0, math.radians(rot))
    o.scale = (scale, scale, scale)
    return o


def build():
    setup()
    return [
        place(citadel("citadel"), -95, 260, 8),
        place(crystal_arch("crystal_arch"), 70, 150, -14),
        place(monolith("rune_a", 14, 1), -42, 88, 20),
        place(monolith("rune_b", 10, 2), -33, 95, -10),
        place(monolith("rune_c", 12, 3), 46, 92, 35),
    ]


def main():
    options = common.args()
    common.reset_scene()
    objects = build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects)
    common.ensure_dir(OUT_DIR)
    common.export_glb(objects, OUT_GLB, vertex_colors=True)
    common.write_metadata(OUT_META, {"generator": "assets/blender/scripts/ice_kit.py", "objects": [o.name for o in objects], "triangles": tris, "materials": list(MATS.keys()), "license": "Original work for Prismfall"})
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        common.render_preview(OUT_PREVIEW, camera_location=(0, -40, 30), target=(-20, 200, 15), lens=24, samples=16)
    print("ICE_OK", len(objects), "objects", tris, "triangles")


main()
