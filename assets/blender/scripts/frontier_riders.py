"""Riders for The Last Frontier: a cowboy (and a gunslinger) posed seated in the saddle of the
rigged Sketchfab horse and attached to its back bone, so each rider moves with the horse's walk and
gallop exactly. Run headless:

  blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/frontier_riders.py

Inputs (CC BY 4.0, see assets/external/sketchfab/<name>/source.json):
  assets/external/sketchfab/horse-saddled/gltf/scene.gltf  "Horse" by Henry S
  assets/external/sketchfab/cowboy/gltf/scene.gltf         "Western Cowboy (Rigged)" by human being
  assets/external/sketchfab/gunslinger/gltf/scene.gltf     "Gunslinger" by archiebattley
Outputs: assets/blender/exports/frontier_riders/horse-rider-{a,b}.glb (optimised into
content/stages/last-frontier/models/ by the caller), the .blend in assets/blender/source/environments/
and previews in assets/blender/previews/.

The rider's pose is solved by aiming each limb bone at a target direction (a seated riding posture:
thighs forward and apart over the barrel, shins down, arms bent forward to the reins), applied to
the mesh, and the posed mesh is parented to the horse's saddle-spine bone. Only the clips the world
uses are kept (walk, gallop, idles, eat). Deterministic.
"""
import math
import os
import sys

import bpy
import mathutils

sys.path.insert(0, os.path.dirname(__file__))
from common import ROOT, args, ensure_dir, reset_scene, save_blend  # noqa: E402

V = mathutils.Vector
EXPORTS = os.path.join(ROOT, "assets/blender/exports/frontier_riders")
PREVIEWS = os.path.join(ROOT, "assets/blender/previews")
KEEP_CLIPS = ("Walk", "Gallop", "1 Ilde", "2 Ilde", "6 Eat")
SADDLE_BONE = "BN_Spine_02_04_04"


def import_gltf(path):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    # Blender's importer adds an icosphere as the bone display shape; it is not part of the model.
    for o in [o for o in bpy.data.objects if o not in before and o.name.startswith("Icosphere")]:
        bpy.data.objects.remove(o, do_unlink=True)
    return [o for o in bpy.data.objects if o not in before]


def world_box(objs):
    dg = bpy.context.evaluated_depsgraph_get()
    mn = V((1e9, 1e9, 1e9))
    mx = V((-1e9, -1e9, -1e9))
    pts = []
    for o in objs:
        e = o.evaluated_get(dg)
        m = e.to_mesh()
        for v in m.vertices:
            w = e.matrix_world @ v.co
            pts.append(w)
            mn = V(map(min, mn, w))
            mx = V(map(max, mx, w))
        e.to_mesh_clear()
    return mn, mx, pts


def find_bone(arm, key):
    for b in arm.pose.bones:
        n = b.name.split(":")[-1]
        if n.rsplit("_", 1)[0] == key or n == key:
            return b
    return None


def aim(arm, key, direction):
    """Turns a pose bone so its Y axis (along the bone) points along `direction` (armature space)."""
    pb = find_bone(arm, key)
    if pb is None:
        print("WARN missing bone", key)
        return
    bpy.context.view_layer.update()
    m = pb.matrix.copy()
    cur = m.to_3x3() @ V((0, 1, 0))
    d = V(direction).normalized()
    rot = cur.normalized().rotation_difference(d).to_matrix().to_4x4()
    head = m.translation.copy()
    new = mathutils.Matrix.Translation(head) @ rot @ mathutils.Matrix.Translation(-head) @ m
    pb.matrix = new
    bpy.context.view_layer.update()


def seat_rider(rider_objs, rider_arm, seat, height_units, lean):
    """Scales the rider to `height_units`, poses him seated and moves his pelvis onto `seat`."""
    meshes = [o for o in rider_objs if o.type == "MESH"]
    mn, mx, _ = world_box(meshes)
    root = rider_arm
    while root.parent is not None:
        root = root.parent
    k = height_units / (mx.z - mn.z)
    root.scale = root.scale * k
    bpy.context.view_layer.update()
    # The armature-space frame of the rider: he faces −Y, up is +Z (glTF import of a +Z-forward figure).
    inv = rider_arm.matrix_world.to_3x3().inverted()

    def arm_dir(x, y, z):
        return inv @ V((x, y, z))

    for side, sx in (("Left", 1), ("Right", -1)):
        # A figure facing −Y has its left side at +X.
        aim(rider_arm, f"{side}UpLeg", arm_dir(0.36 * sx, -0.78, -0.52))
        aim(rider_arm, f"{side}Leg", arm_dir(0.1 * sx, 0.22, -1.0))
        aim(rider_arm, f"{side}Foot", arm_dir(0.05 * sx, -1.0, -0.25))
        aim(rider_arm, f"{side}Arm", arm_dir(0.3 * sx, -0.3, -0.9))
        aim(rider_arm, f"{side}ForeArm", arm_dir(-0.18 * sx, -0.92, -0.32))
        aim(rider_arm, f"{side}Hand", arm_dir(-0.1 * sx, -1.0, -0.2))
    for key in ("Spine", "Spine1", "Spine2"):
        aim(rider_arm, key, arm_dir(0, -lean, 1.0))
    aim(rider_arm, "Neck", arm_dir(0, -0.12, 1.0))
    aim(rider_arm, "Head", arm_dir(0, -0.05, 1.0))
    # Bake the pose into the meshes and drop the rider's armature.
    baked = []
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        for mod in list(o.modifiers):
            if mod.type == "ARMATURE":
                bpy.ops.object.modifier_apply(modifier=mod.name)
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
        o.vertex_groups.clear()
        baked.append(o)
    # Pelvis onto the seat: the lowest point of the seated hips sits on the seat surface.
    mn, mx, pts = world_box(baked)
    centre = V(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, 0))
    # Seat contact: the lowest vertices within the middle of the figure (the buttocks).
    mid = [p for p in pts if abs(p.x - centre.x) < (mx.x - mn.x) * 0.12 and p.z < mn.z + (mx.z - mn.z) * 0.6]
    contact_z = min(p.z for p in mid) if mid else mn.z
    bottom_y = sum(p.y for p in mid if p.z < contact_z + height_units * 0.04) / max(1, len([p for p in mid if p.z < contact_z + height_units * 0.04]))
    offset = V((seat.x - centre.x, seat.y - bottom_y, seat.z - contact_z))
    for o in baked:
        o.location += offset
    for o in [o for o in rider_objs if o.type != "MESH" and o.name in bpy.data.objects]:
        bpy.data.objects.remove(o, do_unlink=True)
    bpy.context.view_layer.update()
    return baked


def build(rider_name, out_name, lean):
    reset_scene()
    horse = import_gltf(os.path.join(ROOT, "assets/external/sketchfab/horse-saddled/gltf/scene.gltf"))
    harm = next(o for o in horse if o.type == "ARMATURE")
    hmeshes = [o for o in horse if o.type == "MESH"]
    # Rest the horse in its walk's first frame (the pose the rider is fitted to).
    if harm.animation_data is None:
        harm.animation_data_create()
    walk = next(a for a in bpy.data.actions if a.name.endswith("|Walk"))
    harm.animation_data.action = walk
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.update()
    body = [o for o in hmeshes if any(m and m.name == "Horse" for m in o.data.materials)]
    saddle = [o for o in hmeshes if any(m and m.name == "Saddle" for m in o.data.materials)]
    bmn, bmx, _ = world_box(body)
    smn, smx, spts = world_box(saddle)
    horse_h = bmx.z - bmn.z
    # The seat: saddle points near the centre line, in the middle of the saddle's length (not the horn or cantle).
    big = max(saddle, key=lambda o: len(o.data.vertices))
    _, _, bigpts = world_box([big])
    ys = sorted(p.y for p in bigpts)
    y0, y1 = ys[int(len(ys) * 0.2)], ys[int(len(ys) * 0.8)]
    cx = sum(p.x for p in bigpts) / len(bigpts)
    seat_pts = [p for p in bigpts if abs(p.x - cx) < horse_h * 0.02 and y0 + (y1 - y0) * 0.3 < p.y < y0 + (y1 - y0) * 0.7]
    seat_z = sorted(p.z for p in seat_pts)[int(len(seat_pts) * 0.85)] if seat_pts else smx.z
    seat_y = sum(p.y for p in seat_pts) / max(1, len(seat_pts)) if seat_pts else (smn.y + smx.y) / 2
    seat = V((cx, seat_y + horse_h * 0.01, seat_z))
    print("HORSE height", round(horse_h, 3), "seat", tuple(round(v, 3) for v in seat))

    rider = import_gltf(os.path.join(ROOT, f"assets/external/sketchfab/{rider_name}/gltf/scene.gltf"))
    rarm = next(o for o in rider if o.type == "ARMATURE")
    # A horse 2.2 m to the top of its head carries a 1.78 m rider.
    baked = seat_rider(rider, rarm, seat, horse_h * (1.78 / 2.2), lean)
    # Parent the posed rider to the saddle bone (keeping where he sits).
    for o in baked:
        mw = o.matrix_world.copy()
        o.parent = harm
        o.parent_type = "BONE"
        o.parent_bone = SADDLE_BONE
        o.matrix_world = mw
        o.name = f"rider_{rider_name}_{o.name}"
    bpy.context.view_layer.update()
    # Keep only the clips the world uses.
    for a in list(bpy.data.actions):
        if not any(a.name.endswith("|" + k) for k in KEEP_CLIPS):
            bpy.data.actions.remove(a)
    harm.animation_data.action = None
    # Real-world units: scale the whole model so the horse stands 2.2 m to the top of its head.
    top = harm
    while top.parent is not None:
        top = top.parent
    top.scale = top.scale * (2.2 / horse_h)
    bpy.context.view_layer.update()

    ensure_dir(EXPORTS)
    out = os.path.join(EXPORTS, f"{out_name}.glb")
    bpy.ops.object.select_all(action="DESELECT")
    for o in bpy.data.objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
        export_animations=True,
        export_animation_mode="ACTIONS",
        export_skins=True,
    )
    save_blend(os.path.join(ROOT, f"assets/blender/source/environments/last_frontier_{out_name}.blend"))
    if "--no-preview" not in args():
        preview(out_name)
    print(f"RIDER_OK {out_name} -> {out}")


def preview(name):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_x, scene.render.resolution_y = 900, 700
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    scene.collection.objects.link(cam)
    cam_data.lens = 50
    for tag, loc in (("side", (5.0, 0.3, 1.4)), ("front", (2.6, -4.0, 1.6))):
        cam.location = loc
        cam.rotation_euler = (V((0, 0, 1.15)) - V(loc)).to_track_quat("-Z", "Y").to_euler()
        scene.camera = cam
        scene.render.filepath = os.path.join(PREVIEWS, f"last_frontier_{name}_{tag}.png")
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)


build("cowboy", "horse-rider-a", 0.1)
build("gunslinger", "horse-rider-b", 0.14)
