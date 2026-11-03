"""Creature models for Prismfall's living-creature system.

Each creature is built from metaballs (capsules and ellipsoids along a stick figure), converted to
a mesh and given per-vertex joint attributes (_JA, _JB: primary and secondary joint index,
-1 = none). `build_skin` (a skin-modifier alternative) is kept but unused. The rig file (<name>.rig.json) lists each joint's pivot (glTF y-up space), rotation
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
    for ell in ellipsoids:
        c, radii, r = ell[0], ell[1], ell[2]
        e = mball.elements.new(type="ELLIPSOID")
        e.co = c
        e.radius = r
        e.size_x, e.size_y, e.size_z = radii
        if len(ell) > 3:
            # Optional orientation: align the ellipsoid's x axis with a direction (flat fins, flukes).
            e.rotation = Vector((1, 0, 0)).rotation_difference(Vector(ell[3]))
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


def rig_json(name, joints, height, stride, bob, sway=0.025, forward="-z"):
    return {
        "name": name,
        "forward": forward,
        "height": height,
        "stride": stride,
        "bob": bob,
        "sway": sway,
        "joints": [
            {"name": j["name"], "pivot": to_gltf(j["pivot"]), "axis": to_gltf(j["axis"]), "amp": j["amp"], "phase": j["phase"], "freq": j["freq"], "bias": j["bias"], "rectify": j["rectify"]}
            for j in joints
        ],
    }


def deer():
    """A slender deer with antlers (forest, aurora reindeer, ice spirits). Walk gait: LH, LF, RH, RF."""
    V = [
        (0, -0.55, 1.05),  # 0 hip
        (0, -0.1, 1.09),  # 1 mid back
        (0, 0.38, 1.13),  # 2 withers
        (0, 0.55, 0.96),  # 3 chest
        (0, 0.6, 1.22),  # 4 neck base
        (0, 0.82, 1.66),  # 5 poll
        (0, 1.12, 1.56),  # 6 muzzle
        (0.14, 0.44, 0.95), (0.14, 0.47, 0.5), (0.14, 0.45, 0.04),  # 7-9 front left shoulder, knee, hoof
        (-0.14, 0.44, 0.95), (-0.14, 0.47, 0.5), (-0.14, 0.45, 0.04),  # 10-12 front right
        (0.14, -0.5, 0.96), (0.14, -0.63, 0.5), (0.14, -0.55, 0.04),  # 13-15 back left hip, hock, hoof
        (-0.14, -0.5, 0.96), (-0.14, -0.63, 0.5), (-0.14, -0.55, 0.04),  # 16-18 back right
        (0, -0.6, 1.07), (0, -0.76, 0.98),  # 19-20 tail (base inside the haunch)
        (0.09, 0.82, 1.76), (-0.09, 0.82, 1.76),  # 21-22 ears
    ]
    cap = lambda a, b, r: (a, b, r)  # noqa: E731
    capsules = [
        cap(V[4], V[5], 0.085), cap(V[3], V[4], 0.12), cap(V[5], V[6], 0.07),
        cap(V[7], V[8], 0.07), cap(V[8], V[9], 0.04), cap(V[10], V[11], 0.07), cap(V[11], V[12], 0.04),
        cap(V[13], V[14], 0.085), cap(V[14], V[15], 0.04), cap(V[16], V[17], 0.085), cap(V[17], V[18], 0.04),
        cap(V[19], V[20], 0.065), cap(V[5], V[21], 0.04), cap(V[5], V[22], 0.04),
    ]
    # Antlers: a main beam per side with three tines.
    antler_segs = []
    for side in (1, -1):
        base = (side * 0.05, 0.84, 1.74)
        beam1 = (side * 0.2, 0.78, 2.0)
        beam2 = (side * 0.28, 0.66, 2.28)
        tines = [((side * 0.17, 0.8, 1.94), (side * 0.15, 0.98, 2.12)), (beam1, (side * 0.32, 0.86, 2.24)), (beam2, (side * 0.22, 0.74, 2.42))]
        capsules += [cap(base, beam1, 0.05), cap(beam1, beam2, 0.044)] + [cap(a, b, 0.036) for a, b in tines]
        antler_segs += [(base, beam1), (beam1, beam2)] + tines
    ellipsoids = [
        ((0, -0.07, 1.02), (0.9, 2.3, 1.05), 0.27),
        ((0, 0.42, 0.98), (1.0, 1.2, 1.2), 0.22),
        ((0, -0.46, 1.0), (1.05, 1.1, 1.15), 0.21),
        ((0, 0.98, 1.6), (0.75, 1.8, 0.85), 0.11),
    ]
    obj = build_metaballs("Deer", capsules, ellipsoids, resolution=0.022)
    joints = [
        {"name": "neck", "pivot": V[4], "axis": (1, 0, 0), "amp": 0.06, "phase": 0.1, "freq": 2, "bias": 0.0, "rectify": 0},
        {"name": "fl_hip", "pivot": V[7], "axis": (1, 0, 0), "amp": 0.42, "phase": 0.25, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fl_knee", "pivot": V[8], "axis": (1, 0, 0), "amp": 0.8, "phase": 0.47, "freq": 1, "bias": 0.0, "rectify": -1},
        {"name": "fr_hip", "pivot": V[10], "axis": (1, 0, 0), "amp": 0.42, "phase": 0.75, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fr_knee", "pivot": V[11], "axis": (1, 0, 0), "amp": 0.8, "phase": 0.97, "freq": 1, "bias": 0.0, "rectify": -1},
        {"name": "bl_hip", "pivot": V[13], "axis": (1, 0, 0), "amp": 0.38, "phase": 0.0, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "bl_hock", "pivot": V[14], "axis": (1, 0, 0), "amp": 0.65, "phase": 0.26, "freq": 1, "bias": 0.0, "rectify": 1},
        {"name": "br_hip", "pivot": V[16], "axis": (1, 0, 0), "amp": 0.38, "phase": 0.5, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "br_hock", "pivot": V[17], "axis": (1, 0, 0), "amp": 0.65, "phase": 0.76, "freq": 1, "bias": 0.0, "rectify": 1},
        {"name": "tail", "pivot": V[19], "axis": (0, 0, 1), "amp": 0.3, "phase": 0.0, "freq": 2, "bias": 0.0, "rectify": 0},
    ]
    N = -1
    segments = [
        (V[0], V[1], N, N), (V[1], V[2], N, N), (V[2], V[3], N, N), (V[3], V[4], 0, N), (V[4], V[5], 0, N), (V[5], V[6], 0, N),
        (V[5], V[21], 0, N), (V[5], V[22], 0, N),
        (V[7], V[8], 1, N), (V[8], V[9], 2, 1), (V[10], V[11], 3, N), (V[11], V[12], 4, 3),
        (V[13], V[14], 5, N), (V[14], V[15], 6, 5), (V[16], V[17], 7, N), (V[17], V[18], 8, 7),
        (V[0], V[19], 9, N), (V[19], V[20], 9, N),
    ] + [(a, b, 0, N) for a, b in antler_segs]
    assign_joints_segments(obj, segments)
    obj.data.materials.append(make_material("CreatureFur", color=(0.55, 0.4, 0.28), roughness=0.85))
    return obj, rig_json("deer", joints, 2.4, 1.05, 0.03, 0.02)


def whale():
    """A great whale (ocean depths, star whale in space). Undulates its tail; flippers sweep."""
    spine = [(0, 6.5, 0), (0, 3.5, 0.3), (0, 0, 0.4), (0, -3.5, 0.2), (0, -6, 0), (0, -8.2, 0)]
    capsules = [(spine[i], spine[i + 1], r) for i, r in zip(range(5), (1.55, 1.75, 1.6, 1.1, 0.55))]
    ellipsoids = [((0, 4.6, -0.1), (1.0, 1.8, 0.85), 1.7), ((0, 1.5, 0.1), (1.0, 2.2, 0.9), 1.85)]
    flukes = []
    for side in (1, -1):
        # Flat flukes and flippers: wide, thin ellipsoids pointing along the fin.
        ellipsoids.append(((side * 1.15, -8.5, 0), (1.0, 0.45, 0.2), 1.45, (side * 2.4, -0.8, 0)))
        flukes.append(((side * 0.2, -8.2, 0), (side * 2.6, -9.0, 0)))
        ellipsoids.append(((side * 1.9, 2.5, -0.95), (1.0, 0.4, 0.18), 1.45, (side * 2.4, -1.4, -0.6)))
    ellipsoids.append(((0, 2.5, -0.7), (1.0, 2.6, 0.7), 1.5))  # throat and belly
    obj = build_metaballs("Whale", capsules, ellipsoids, resolution=0.085)
    joints = [
        {"name": "tail1", "pivot": spine[2], "axis": (1, 0, 0), "amp": 0.06, "phase": 0.0, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "tail2", "pivot": spine[3], "axis": (1, 0, 0), "amp": 0.12, "phase": 0.12, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fluke", "pivot": spine[4], "axis": (1, 0, 0), "amp": 0.22, "phase": 0.25, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fin_l", "pivot": (1.2, 3.0, -0.8), "axis": (0, 1, 0), "amp": 0.18, "phase": 0.4, "freq": 1, "bias": 0.0, "rectify": 0},
        {"name": "fin_r", "pivot": (-1.2, 3.0, -0.8), "axis": (0, 1, 0), "amp": 0.18, "phase": 0.9, "freq": 1, "bias": 0.0, "rectify": 0},
    ]
    N = -1
    segments = [
        (spine[0], spine[1], N, N), (spine[1], spine[2], N, N), (spine[2], spine[3], 0, N), (spine[3], spine[4], 1, 0), (spine[4], spine[5], 2, 1),
        ((1.2, 3.0, -0.8), (3.6, 1.6, -1.4), 3, N), ((-1.2, 3.0, -0.8), (-3.6, 1.6, -1.4), 4, N),
    ] + [(a, b, 2, 1) for a, b in flukes]
    assign_joints_segments(obj, segments)
    obj.data.materials.append(make_material("CreatureSkin", color=(0.25, 0.32, 0.4), roughness=0.6))
    return obj, rig_json("whale", joints, 3.2, 9.0, 0.0, 0.01)


def assign_joints_segments(obj, segments):
    """segments: (a, b, ja, jb) with explicit endpoints."""
    me = obj.data
    ja = me.attributes.new("_JA", "FLOAT", "POINT")
    jb = me.attributes.new("_JB", "FLOAT", "POINT")
    segs = [(Vector(a), Vector(b), x, y) for a, b, x, y in segments]
    for v in me.vertices:
        best = None
        for (a, b, x, y) in segs:
            d = seg_dist(v.co, a, b)
            if best is None or d < best[0]:
                best = (d, x, y)
        ja.data[v.index].value = best[1]
        jb.data[v.index].value = best[2]


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
    made = []
    for build, name, cam, target in [
        (camel, "camel", (5.5, 0.6, 1.3), (0, 0.35, 1.05)),
        (deer, "deer", (4.5, 0.6, 1.4), (0, 0.3, 1.1)),
        (whale, "whale", (26, -2, 6), (0, -1, 0)),
    ]:
        obj, rig = build()
        export_creature(obj, rig, name)
        made.append((obj, name, cam, target))
    save_blend(os.path.join(SRC, "creatures.blend"))
    if "--no-preview" not in args():
        for obj, name, cam, target in made:
            for other, *_ in made:
                other.hide_render = other is not obj
            render_preview(os.path.join(PREVIEWS, f"{name}.png"), camera_location=cam, target=target, lens=50)
    print("CREATURES_OK")


main()
