"""Ancient Garden kit: an original five-tier pagoda, a shrine gate, an arched garden bridge and a
shrine hall, in the traditional Japanese-inspired vocabulary (wood, vermilion lacquer, tiled roofs).

Blender Z-up; each object's origin is at its base at its (x, y) placement; the game snaps them to
the hills. Materials: lacquer (vermilion), woodDark, roofTile, plaster, gold, lanternPaper (glow).

Usage: blender -b --factory-startup --python assets/blender/scripts/japan_kit.py -- [--no-preview]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "japan")
OUT_GLB = os.path.join(OUT_DIR, "japan.glb")
OUT_META = os.path.join(OUT_DIR, "japan.meta.json")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "environments", "ancient_garden.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "ancient_garden.png")
MATS = {}


def setup():
    MATS["lacquer"] = common.make_material("lacquer", color=(0.72, 0.12, 0.06), roughness=0.4)
    MATS["woodDark"] = common.make_material("woodDark", color=(0.18, 0.1, 0.06), roughness=0.7)
    MATS["roofTile"] = common.make_material("roofTile", color=(0.12, 0.13, 0.15), roughness=0.6)
    MATS["plaster"] = common.make_material("plaster", color=(0.88, 0.84, 0.76), roughness=0.85)
    MATS["gold"] = common.make_material("gold", color=(0.85, 0.65, 0.25), metallic=0.8, roughness=0.35)
    MATS["lanternPaper"] = common.make_material("lanternPaper", color=(1.0, 0.8, 0.5), roughness=0.6, emission=(1.0, 0.7, 0.35), emission_strength=3)


def active():
    return bpy.context.view_layer.objects.active


def m(o, name):
    o.data.materials.clear()
    o.data.materials.append(MATS[name])
    return o


def box(size, loc, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc, rotation=rot)
    o = active()
    o.scale = size
    return m(o, mat)


def cyl(r, h, loc, mat, rot=(0, 0, 0), verts=12):
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=h, location=loc, rotation=rot)
    return m(active(), mat)


def roof(half, z, rise, overhang, curl, mat="roofTile"):
    """A hipped roof with upturned eaves: a pyramid frustum whose corners lift at the rim."""
    w = half + overhang
    top = half * 0.35
    verts = [(-w, -w, z), (w, -w, z), (w, w, z), (-w, w, z), (-top, -top, z + rise), (top, -top, z + rise), (top, top, z + rise), (-top, top, z + rise)]
    # Corners curl upward; edge midpoints sag for the classic sweep.
    rim = []
    for i in range(4):
        a = verts[i]
        b = verts[(i + 1) % 4]
        rim.append((a[0], a[1], a[2] + curl))
        rim.append(((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, z - curl * 0.15))
    v = rim + verts[4:]
    faces = []
    for i in range(4):
        c0 = i * 2
        mid = i * 2 + 1
        c1 = (i * 2 + 2) % 8
        t0 = 8 + i
        t1 = 8 + (i + 1) % 4
        faces.append((c0, mid, t0))
        faces.append((mid, t1, t0))
        faces.append((mid, c1, t1))
    faces.append((8, 9, 10, 11))
    faces.append(tuple(range(7, -1, -1)))
    me = bpy.data.meshes.new("roof")
    me.from_pydata(v, [], faces)
    me.validate()
    o = bpy.data.objects.new("roof", me)
    bpy.context.collection.objects.link(o)
    return m(o, mat)


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


def finish(o):
    common.shade_smooth_by_angle(o, 25)
    common.bake_dirty_vertex_ao(o)
    return o


def pagoda(name):
    parts = [box((9, 9, 1.2), (0, 0, 0.6), "plaster")]
    z = 1.2
    for tier in range(5):
        half = 3.6 - tier * 0.45
        h = 3.2 - tier * 0.2
        parts.append(box((half * 2, half * 2, h), (0, 0, z + h / 2), "plaster"))
        for sx in (-1, 1):
            for sy in (-1, 1):
                parts.append(cyl(0.22, h, (sx * (half - 0.15), sy * (half - 0.15), z + h / 2), "lacquer"))
        parts.append(box((half * 2.05, half * 2.05, 0.35), (0, 0, z + h - 0.1), "lacquer"))
        parts.append(roof(half, z + h, 1.0, 2.0 - tier * 0.15, 0.9))
        z += h + 0.9
    parts.append(cyl(0.12, 6.5, (0, 0, z + 3.0), "gold"))
    for k in range(6):
        parts.append(cyl(0.45 - k * 0.04, 0.12, (0, 0, z + 1 + k * 0.7), "gold", verts=16))
    return finish(join(parts, name))


def gate(name):
    parts = []
    for side in (-1, 1):
        parts.append(cyl(0.55, 11, (side * 5, 0, 5.5), "lacquer", verts=16))
        parts.append(cyl(0.8, 0.8, (side * 5, 0, 0.4), "woodDark", verts=16))
    parts.append(box((12.5, 0.8, 0.7), (0, 0, 8.3), "lacquer"))
    # Top beam with upswept ends (bent from three segments).
    parts.append(box((10, 1.2, 0.9), (0, 0, 10.6), "woodDark"))
    for side in (-1, 1):
        parts.append(box((3.4, 1.2, 0.9), (side * 6.4, 0, 10.9), "woodDark", (0, side * -0.18, 0)))
    parts.append(box((10.6, 1.0, 0.6), (0, 0, 10.0), "lacquer"))
    parts.append(box((1.0, 0.5, 1.6), (0, 0, 9.2), "woodDark"))
    return finish(join(parts, name))


def bridge(name):
    parts = []
    segs = 14
    length = 22
    for i in range(segs):
        t0 = i / segs
        t1 = (i + 1) / segs
        x0 = (t0 - 0.5) * length
        x1 = (t1 - 0.5) * length
        z0 = math.sin(t0 * math.pi) * 3.2
        z1 = math.sin(t1 * math.pi) * 3.2
        mx, mz = (x0 + x1) / 2, (z0 + z1) / 2 + 0.6
        ang = math.atan2(z1 - z0, x1 - x0)
        parts.append(box((math.hypot(x1 - x0, z1 - z0) + 0.05, 3.4, 0.35), (mx, 0, mz), "woodDark", (0, -ang, 0)))
        for side in (-1, 1):
            parts.append(box((math.hypot(x1 - x0, z1 - z0) + 0.05, 0.2, 0.2), (mx, side * 1.6, mz + 1.1), "lacquer", (0, -ang, 0)))
            parts.append(cyl(0.12, 1.1, (x0, side * 1.6, z0 + 1.15), "lacquer", verts=8))
    for x in (-length / 2, length / 2):
        for side in (-1, 1):
            parts.append(cyl(0.2, 1.8, (x, side * 1.6, 1.3), "lacquer", verts=8))
            parts.append(cyl(0.26, 0.4, (x, side * 1.6, 2.3), "gold", verts=8))
    return finish(join(parts, name))


def hall(name):
    parts = [box((16, 11, 1.4), (0, 0, 0.7), "plaster")]
    for i in range(6):
        for j in (-1, 1):
            parts.append(cyl(0.3, 4.6, (-6.5 + i * 2.6, j * 4.3, 3.7), "lacquer"))
    parts.append(box((13.5, 8.2, 4.2), (0, 0, 3.5), "woodDark"))
    for k in range(4):
        parts.append(box((1.8, 0.1, 2.4), (-4.5 + k * 3, -4.12, 3.2), "lanternPaper"))
    parts.append(roof(7.2, 6.0, 3.4, 2.6, 1.2))
    parts.append(box((6, 2.2, 0.5), (0, -6.5, 0.25), "plaster"))
    return finish(join(parts, name))


def place(o, x, y, rot=0.0):
    o.location = (x, y, 0)
    o.rotation_euler = (0, 0, math.radians(rot))
    return o


def build():
    setup()
    return [
        place(pagoda("pagoda"), 62, 150, -12),
        place(hall("shrine_hall"), -78, 135, 14),
        place(gate("gate"), -34, 74, 10),
        place(bridge("bridge"), 24, 72, -6),
        place(gate("gate_far"), 110, 250, -20),
    ]


def main():
    options = common.args()
    common.reset_scene()
    objects = build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects)
    common.ensure_dir(OUT_DIR)
    common.export_glb(objects, OUT_GLB, vertex_colors=True)
    common.write_metadata(OUT_META, {"generator": "assets/blender/scripts/japan_kit.py", "objects": [o.name for o in objects], "triangles": tris, "materials": list(MATS.keys()), "license": "Original work for Prismfall"})
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        common.render_preview(OUT_PREVIEW, camera_location=(0, -30, 22), target=(10, 150, 10), lens=24, samples=16)
    print("JAPAN_OK", len(objects), "objects", tris, "triangles")


main()
