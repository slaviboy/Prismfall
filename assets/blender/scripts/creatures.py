"""Creature models for Prismfall's living-creature system.

Each creature is a skin-modifier skeleton (organic silhouette from a stick figure with radii),
subdivided and given per-vertex joint attributes (_JA, _JB: primary and secondary joint index,
-1 = none). The rig file (<name>.rig.json) lists each joint's pivot (glTF y-up space), rotation
axis and gait parameters; the game evaluates the rig on the GPU for meshes and surface particles.

Run: blender -b --factory-startup --python assets/blender/scripts/creatures.py
"""
import math
import os
import sys

import bpy
from mathutils import Vector

sys.path.append(os.path.dirname(__file__))
from common import ROOT, args, apply_modifiers, ensure_dir, export_glb, make_material, render_preview, reset_scene, save_blend, write_metadata  # noqa: E402

OUT = os.path.join(ROOT, "assets", "blender", "exports", "creatures")
SRC = os.path.join(ROOT, "assets", "blender", "source")
PREVIEWS = os.path.join(ROOT, "assets", "blender", "previews")


def to_gltf(v):
    """Blender Z-up (x, y, z) -> glTF Y-up (x, z, -y)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def build_skin(name, verts, edges, radii, subdiv=2):
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(verts, edges, [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new("Skin", "SKIN")
    skin.use_smooth_shade = True
    for i, r in enumerate(radii):
        sv = mesh.skin_vertices[0].data[i]
        sv.radius = (r[0], r[1]) if isinstance(r, tuple) else (r, r)
    mesh.skin_vertices[0].data[0].use_root = True
    sub = obj.modifiers.new("Subsurf", "SUBSURF")
    sub.levels = subdiv
    sub.render_levels = subdiv
    apply_modifiers(obj)
    for poly in obj.data.polygons:
        poly.use_smooth = True
    return obj


def build_metaballs(name, capsules, ellipsoids, resolution=0.035, threshold=0.6):
    """Organic body from metaball capsules (a, b, radius) and ellipsoids (centre, radii), meshed."""
    mball = bpy.data.metaballs.new(name + "Meta")
    mball.resolution = resolution
    mball.render_resolution = resolution
    mball.threshold = threshold
    for (a, b, r) in capsules:
        a, b = Vector(a), Vector(b)
        e = mball.elements.new(type="CAPSULE")
        e.co = (a + b) / 2
        e.radius = r
        e.size_x = (b - a).length / 2
        e.rotation = Vector((1, 0, 0)).rotation_difference(b - a)
        e.stiffness = 2.0
    for (c, radii, r) in ellipsoids:
        e = mball.elements.new(type="ELLIPSOID")
        e.co = c
        e.radius = r
        e.size_x, e.size_y, e.size_z = radii
        e.stiffness = 2.0
    meta = bpy.data.objects.new(name + "Meta", mball)
    bpy.context.scene.collection.objects.link(meta)
    bpy.context.view_layer.update()
    bpy.ops.object.select_all(action="DESELECT")
    meta.select_set(True)
    bpy.context.view_layer.objects.active = meta
    bpy.ops.object.convert(target="MESH")
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    for poly in obj.data.polygons:
        poly.use_smooth = True
    # Light smoothing pass for an even surface.
    smooth = obj.modifiers.new("Smooth", "SMOOTH")
    smooth.factor = 0.5
    smooth.iterations = 4
    apply_modifiers(obj)
    return obj


def seg_dist(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.dot(ab))))
    return (p - (a + ab * t)).length


def assign_joints(obj, verts, segments):
    """segments: list of (vi, vj, ja, jb): skeleton edge -> joint indices for vertices nearest it."""
    me = obj.data
    ja = me.attributes.new("_JA", "FLOAT", "POINT")
    jb = me.attributes.new("_JB", "FLOAT", "POINT")
    pts = [Vector(v) for v in verts]
    for v in me.vertices:
        best = None
        for (i, j, a, b) in segments:
            d = seg_dist(v.co, pts[i], pts[j])
            if best is None or d < best[0]:
                best = (d, a, b)
        ja.data[v.index].value = best[1]
        jb.data[v.index].value = best[2]


def camel():
    # Stick figure (metres, facing +Y). Indices are referenced by edges, radii and joints.
    V = [
        (0, -0.70, 1.42),  # 0 hip (root)
        (0, -0.15, 1.50),  # 1 mid back
        (0, 0.40, 1.46),  # 2 withers
        (0, 0.62, 1.30),  # 3 chest
        (0, -0.12, 2.02),  # 4 hump top (dromedary)
        (0, 0.88, 1.20),  # 5 neck base (camels' neck dips low and forward)
        (0, 1.16, 1.28),  # 6 neck lower curve
        (0, 1.30, 1.62),  # 7 neck upper
        (0, 1.40, 1.86),  # 8 poll (back of head)
        (0, 1.74, 1.80),  # 9 muzzle
        (0.20, 0.48, 1.22),  # 10 front-left shoulder joint
        (0.20, 0.52, 0.66),  # 11 front-left knee
        (0.20, 0.50, 0.05),  # 12 front-left pad
        (-0.20, 0.48, 1.22),  # 13 front-right shoulder
        (-0.20, 0.52, 0.66),  # 14 front-right knee
        (-0.20, 0.50, 0.05),  # 15 front-right pad
        (0.20, -0.66, 1.24),  # 16 back-left hip
        (0.20, -0.80, 0.68),  # 17 back-left hock
        (0.20, -0.70, 0.05),  # 18 back-left pad
        (-0.20, -0.66, 1.24),  # 19 back-right hip
        (-0.20, -0.80, 0.68),  # 20 back-right hock
        (-0.20, -0.70, 0.05),  # 21 back-right pad
        (0, -0.84, 1.42),  # 22 tail base (inside the haunch)
        (0, -0.98, 0.98),  # 23 tail tip
        (0.06, 1.40, 1.98),  # 24 left ear
        (-0.06, 1.40, 1.98),  # 25 right ear
        (0, 0.10, 1.70),  # 26 hump front slope
        (0, -0.40, 1.72),  # 27 hump back slope
    ]
    E = [(0, 1), (1, 2), (2, 3), (1, 26), (26, 4), (4, 27), (27, 0), (3, 5), (5, 6), (6, 7), (7, 8), (8, 9),
         (2, 10), (10, 11), (11, 12), (2, 13), (13, 14), (14, 15),
         (0, 16), (16, 17), (17, 18), (0, 19), (19, 20), (20, 21), (0, 22), (22, 23), (8, 24), (8, 25)]
    R = [(0.26, 0.30), (0.25, 0.30), (0.24, 0.30), (0.20, 0.24), (0.16, 0.12), 0.095, 0.085, 0.08, 0.11, 0.065,
         0.10, 0.055, 0.07, 0.10, 0.055, 0.07, 0.12, 0.06, 0.07, 0.12, 0.06, 0.07, 0.045, 0.02, 0.025, 0.025,
         (0.2, 0.2), (0.2, 0.2)]
    # Body volumes: capsules along the skeleton, ellipsoids for torso, hump, chest and head.
    cap = lambda i, j, r: (V[i], V[j], r)  # noqa: E731
    capsules = [
        cap(5, 6, 0.15), cap(6, 7, 0.13), cap(7, 8, 0.115), cap(8, 9, 0.105),
        cap(10, 11, 0.12), cap(11, 12, 0.085), cap(13, 14, 0.12), cap(14, 15, 0.085),
        cap(16, 17, 0.14), cap(17, 18, 0.085), cap(19, 20, 0.14), cap(20, 21, 0.085),
        cap(22, 23, 0.075), cap(8, 24, 0.045), cap(8, 25, 0.045), cap(3, 5, 0.16),
    ]
    ellipsoids = [
        ((0, -0.15, 1.46), (1.0, 2.6, 1.2), 0.34),  # torso
        ((0, -0.12, 1.78), (1.0, 1.7, 1.25), 0.245),  # hump
        ((0, 0.55, 1.30), (1.0, 1.2, 1.3), 0.28),  # chest
        ((0, -0.66, 1.34), (1.1, 1.1, 1.2), 0.26),  # haunches
        ((0, 1.56, 1.83), (0.8, 1.9, 0.9), 0.13),  # head
    ]
    obj = build_metaballs("Camel", capsules, ellipsoids)
    # Joints: 0 neck, 1 FL hip, 2 FL knee, 3 FR hip, 4 FR knee, 5 BL hip, 6 BL hock, 7 BR hip, 8 BR hock, 9 tail.
    joints = [
        {"name": "neck", "pivot": V[3], "axis": (1, 0, 0), "amp": 0.07, "phase": 0.1, "freq": 2, "bias": 0.0, "rectify": 0},
        {"name": "fl_hip", "pivot": V[10], "axis": (1, 0, 0), "amp": 0.40, "phase": 0.0, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fl_knee", "pivot": V[11], "axis": (1, 0, 0), "amp": 0.75, "phase": 0.22, "freq": 1, "bias": 0.0, "rectify": -1},
        {"name": "fr_hip", "pivot": V[13], "axis": (1, 0, 0), "amp": 0.40, "phase": 0.5, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fr_knee", "pivot": V[14], "axis": (1, 0, 0), "amp": 0.75, "phase": 0.72, "freq": 1, "bias": 0.0, "rectify": -1},
        # Camels pace: each side's legs move together.
        {"name": "bl_hip", "pivot": V[16], "axis": (1, 0, 0), "amp": 0.36, "phase": 0.04, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "bl_hock", "pivot": V[17], "axis": (1, 0, 0), "amp": 0.6, "phase": 0.3, "freq": 1, "bias": 0.0, "rectify": 1},
        {"name": "br_hip", "pivot": V[19], "axis": (1, 0, 0), "amp": 0.36, "phase": 0.54, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "br_hock", "pivot": V[20], "axis": (1, 0, 0), "amp": 0.6, "phase": 0.8, "freq": 1, "bias": 0.0, "rectify": 1},
        {"name": "tail", "pivot": V[22], "axis": (0, 0, 1), "amp": 0.25, "phase": 0.0, "freq": 1, "bias": 0.0, "rectify": 0},
    ]
    N = -1
    segments = [
        (0, 1, N, N), (1, 2, N, N), (2, 3, N, N), (1, 26, N, N), (26, 4, N, N), (4, 27, N, N), (27, 0, N, N),
        (3, 5, 0, N), (5, 6, 0, N), (6, 7, 0, N), (7, 8, 0, N), (8, 9, 0, N), (8, 24, 0, N), (8, 25, 0, N),
        (2, 10, N, N), (10, 11, 1, N), (11, 12, 2, 1),
        (2, 13, N, N), (13, 14, 3, N), (14, 15, 4, 3),
        (0, 16, N, N), (16, 17, 5, N), (17, 18, 6, 5),
        (0, 19, N, N), (19, 20, 7, N), (20, 21, 8, 7),
        (0, 22, 9, N), (22, 23, 9, N),
    ]
    assign_joints(obj, V, segments)
    obj.data.materials.append(make_material("CreatureSand", color=(0.85, 0.62, 0.36), roughness=0.8))
    rig = {
        "name": "camel",
        "forward": "-z",
        "height": 2.02,
        "stride": 1.15,
        "bob": 0.035,
        "joints": [
            {
                "name": j["name"],
                "pivot": to_gltf(j["pivot"]),
                "axis": to_gltf(j["axis"]),
                "amp": j["amp"],
                "phase": j["phase"],
                "freq": j["freq"],
                "bias": j["bias"],
                "rectify": j["rectify"],
            }
            for j in joints
        ],
    }
    return obj, rig


def export_creature(obj, rig, name):
    path = os.path.join(OUT, f"{name}.glb")
    ensure_dir(OUT)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
        export_attributes=True,
    )
    write_metadata(os.path.join(OUT, f"{name}.rig.json"), rig)
    print(f"  exported {name}: {len(obj.data.vertices)} vertices")


def main():
    reset_scene()
    obj, rig = camel()
    export_creature(obj, rig, "camel")
    save_blend(os.path.join(SRC, "creatures.blend"))
    if "--no-preview" not in args():
        render_preview(os.path.join(PREVIEWS, "camel.png"), camera_location=(5.5, 0.6, 1.3), target=(0, 0.35, 1.05), lens=50)
    print("CREATURES_OK")


main()
