"""Shared helpers for Prismfall's Blender asset generators (run headless with Blender 5.x).

Every generator is deterministic: running it again reproduces the same .blend and GLB files.
"""
import json
import math
import os
import sys

import bpy
import bmesh

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def args() -> list[str]:
    return sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0


def ensure_dir(path: str) -> str:
    os.makedirs(path, exist_ok=True)
    return path


def make_material(name: str, color=(0.8, 0.8, 0.8), metallic=0.0, roughness=0.4, emission=None, emission_strength=0.0):
    """Principled material; in-game the name maps to a TSL preset, colours are previews only."""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1.0)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission is not None:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def apply_modifiers(obj) -> None:
    bpy.context.view_layer.objects.active = obj
    for mod in list(obj.modifiers):
        bpy.ops.object.modifier_apply(modifier=mod.name)


def shade_smooth_by_angle(obj, angle_deg: float = 35.0) -> None:
    mesh = obj.data
    for poly in mesh.polygons:
        poly.use_smooth = True
    try:
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    except Exception:  # Older API fallback: keep smooth shading.
        pass


def smart_uv(obj) -> None:
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
    bpy.ops.object.mode_set(mode="OBJECT")


def bake_dirty_vertex_ao(obj, strength: float = 1.0) -> None:
    """Cheap ambient occlusion stored as a vertex colour attribute ("AO"), exported as COLOR_0."""
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    mesh = obj.data
    if "AO" not in mesh.color_attributes:
        mesh.color_attributes.new(name="AO", type="BYTE_COLOR", domain="CORNER")
    mesh.color_attributes.active_color = mesh.color_attributes["AO"]
    bpy.ops.object.mode_set(mode="VERTEX_PAINT")
    try:
        bpy.ops.paint.vertex_color_dirt(blur_strength=1.0, blur_iterations=1, clean_angle=math.pi, dirt_angle=0.0, dirt_only=False, normalize=True)
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")


def export_glb(objects, path: str, *, vertex_colors: bool = False) -> None:
    ensure_dir(os.path.dirname(path))
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="ACTIVE" if vertex_colors else "NONE")
    except TypeError:
        bpy.ops.export_scene.gltf(**kwargs)


def save_blend(path: str) -> None:
    ensure_dir(os.path.dirname(path))
    bpy.ops.wm.save_as_mainfile(filepath=path, compress=True)


def write_metadata(path: str, data: dict) -> None:
    ensure_dir(os.path.dirname(path))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)


def render_preview(path: str, *, resolution=(960, 540), samples: int = 24, camera_location=(3.2, -4.2, 2.6), target=(0, 0, 0), lens: float = 50.0) -> None:
    """Small Cycles (CPU) preview render of the current scene."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("PreviewWorld")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.012, 0.01, 0.03, 1)
    scene.world = world
    cam_data = bpy.data.cameras.new("PreviewCam")
    cam_data.lens = lens
    cam = bpy.data.objects.new("PreviewCam", cam_data)
    scene.collection.objects.link(cam)
    cam.location = camera_location
    direction = [t - c for t, c in zip(target, camera_location)]
    rot = __import__("mathutils").Vector(direction).to_track_quat("-Z", "Y")
    cam.rotation_euler = rot.to_euler()
    scene.camera = cam
    for name, loc, energy, color in (
        ("Key", (3, -3, 5), 900, (1.0, 0.95, 0.9)),
        ("Rim", (-4, 3, 3), 600, (0.5, 0.65, 1.0)),
    ):
        light_data = bpy.data.lights.new(name, "AREA")
        light_data.energy = energy
        light_data.color = color
        light_data.size = 3
        light = bpy.data.objects.new(name, light_data)
        scene.collection.objects.link(light)
        light.location = loc
        light.rotation_euler = __import__("mathutils").Vector([-v for v in loc]).to_track_quat("-Z", "Y").to_euler()
    ensure_dir(os.path.dirname(path))
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    # Remove preview helpers so they never leak into saved sources.
    for obj in [o for o in scene.collection.objects if o.name.startswith(("PreviewCam", "Key", "Rim"))]:
        bpy.data.objects.remove(obj, do_unlink=True)


def bm_from_object(obj):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    return bm


def bm_to_object(bm, obj) -> None:
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
