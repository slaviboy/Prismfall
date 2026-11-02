"""Prismfall block library generator.

Builds five original block designs, each exactly 1 x 1 x 1 unit (the game rescales to its
cell size), saves the editable source and exports one GLB per variant.

Usage (repo root):
  blender -b --factory-startup --python assets/blender/scripts/blocks.py -- [--no-preview]
"""
import math
import os
import sys

import bpy
import bmesh

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_GLB = os.path.join(common.ROOT, "assets", "blender", "exports", "blocks")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "blocks", "block_library.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "blocks.png")
OUT_META = os.path.join(OUT_GLB, "blocks.meta.json")

HALF = 0.5


def base_cube(name: str):
    mesh = bpy.data.meshes.new(name)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bm.to_mesh(mesh)
    bm.free()
    return obj


def bevel(obj, width: float, segments: int, profile: float = 0.5) -> None:
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.profile = profile
    mod.limit_method = "NONE"
    mod.harden_normals = False
    common.apply_modifiers(obj)


def front_faces(bm):
    """Faces whose normal points along +Y (Blender front, exported as +Z after Y-up conversion)."""
    return [f for f in bm.faces if f.normal.y < -0.99 or f.normal.y > 0.99 or abs(f.normal.z) > 0.99 or abs(f.normal.x) > 0.99]


def inset_all_faces(obj, thickness: float, depth: float) -> None:
    bm = common.bm_from_object(obj)
    flat = [f for f in bm.faces if max(abs(f.normal.x), abs(f.normal.y), abs(f.normal.z)) > 0.999]
    bmesh.ops.inset_individual(bm, faces=flat, thickness=thickness, depth=depth, use_even_offset=True)
    common.bm_to_object(bm, obj)


def soft(name: str):
    """Soft: generously rounded edges, like a polished pebble of glass."""
    obj = base_cube(name)
    bevel(obj, 0.12, 5)
    return obj


def chamfer_inset(name: str):
    """Chamfer + inset: crisp 45° chamfers and a recessed panel on every face."""
    obj = base_cube(name)
    bevel(obj, 0.07, 1)
    inset_all_faces(obj, 0.08, -0.025)
    return obj


def faceted(name: str):
    """Faceted: a cut-gem face — each flat face rises to a shallow pyramid."""
    obj = base_cube(name)
    bevel(obj, 0.06, 2)
    bm = common.bm_from_object(obj)
    flat = [f for f in bm.faces if max(abs(f.normal.x), abs(f.normal.y), abs(f.normal.z)) > 0.999 and f.calc_area() > 0.3]
    result = bmesh.ops.poke(bm, faces=flat, offset=0.07, use_relative_offset=False)
    del result
    common.bm_to_object(bm, obj)
    return obj


def pillow(name: str):
    """Pillow: subtly inflated faces with rounded edges."""
    obj = base_cube(name)
    mod = obj.modifiers.new("subd", "SUBSURF")
    mod.levels = 3
    mod.render_levels = 3
    common.apply_modifiers(obj)
    # Push vertices toward a superellipsoid: flat-ish faces with soft bulge.
    for v in obj.data.vertices:
        co = v.co
        m = max(abs(co.x), abs(co.y), abs(co.z)) or 1.0
        n = co.normalized()
        target = co / m * HALF
        v.co = target.lerp(n * HALF * 1.05, 0.22)
    return obj


def framed(name: str):
    """Framed: a bevelled outer frame around a deeper inset core (reads as a lit glass window)."""
    obj = base_cube(name)
    bevel(obj, 0.05, 3)
    inset_all_faces(obj, 0.12, -0.085)
    bm = common.bm_from_object(obj)
    bmesh.ops.bevel(bm, geom=[e for e in bm.edges if e.calc_face_angle(0) > math.radians(60)], offset=0.008, segments=1, affect="EDGES", profile=0.5)
    common.bm_to_object(bm, obj)
    return obj


VARIANTS = {
    "soft": soft,
    "chamfer": chamfer_inset,
    "faceted": faceted,
    "pillow": pillow,
    "framed": framed,
}


def main() -> None:
    options = common.args()
    common.reset_scene()
    material = common.make_material("prismBlock", color=(0.3, 0.6, 1.0), metallic=0.05, roughness=0.2)
    objects = {}
    meta = {"generator": "assets/blender/scripts/blocks.py", "unit": "1 cell = 1 m", "variants": {}}
    for i, (key, build) in enumerate(VARIANTS.items()):
        obj = build(f"block_{key}")
        obj.data.materials.append(material)
        common.shade_smooth_by_angle(obj, 40)
        common.smart_uv(obj)
        objects[key] = obj
        dims = [round(d, 4) for d in obj.dimensions]
        meta["variants"][key] = {"file": f"{key}.glb", "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons), "dimensions": dims}
        obj.location = (0, 0, 0)
        common.export_glb([obj], os.path.join(OUT_GLB, f"{key}.glb"))
        obj.location = ((i - 2) * 1.4, 0, 0)
    common.write_metadata(OUT_META, meta)
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        common.render_preview(OUT_PREVIEW, camera_location=(1.8, -9.5, 3.4), target=(0, 0, 0), lens=48)
    print("BLOCKS_OK", ", ".join(f"{k}:{v['triangles']}" for k, v in meta["variants"].items()))


main()
