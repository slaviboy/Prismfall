"""Makes an external glTF model (for example a Poly Haven photoscan) real-time ready (Blender 5.x, headless).

    blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/import_external.py -- \
        --input <model.gltf|.glb> --output <out.glb> [--target-tris 10000] [--max-texture 1024] \
        [--name <object name>] [--alpha auto|opaque|mask|keep] [--alpha-map KEY=<image>]... [--ao auto|none] \
        [--split] [--no-preview]

Steps: import (vertices merged so UV seams stay connected), drop extra LOD meshes, join every mesh into one
object (--split keeps each top-level mesh as its own object <name>_<suffix>, for sets of separate rocks, and
shares the triangle budget by their original triangle counts), apply transforms, collapse-decimate to the target triangle count (UVs are interpolated), clear custom
normals and shade smooth, put the origin at the bottom centre of the bounding box, fix alpha modes, wire
ambient occlusion from packed ARM textures (--ao auto), shrink
textures to --max-texture, export a GLB with embedded textures, then render a four-view contact sheet
(<out>.preview.png) and write a report (<out>.report.json). Prints IMPORT_OK with the triangle count and the
bounding box in metres. With --split every object sits at the origin (like the flora kit, so scatter items
can name them) and the preview shows one three-quarter view per object.

Alpha (--alpha auto): Poly Haven glTFs mark cut-out foliage MASK or BLEND but use JPEG base colour textures,
which carry no alpha; the cut-out is a separate Alpha map (fetch-polyhaven.ts downloads it as alphaMaps). For
a material whose alpha input is driven by a texture without a real alpha channel:
  - with a matching --alpha-map (key "Alpha" matches every material; "leaf_alpha" matches a material whose
    base colour image name contains "leaf"), that map is wired in as an alpha-tested MASK (cutoff 0.5), and
    the exporter packs it into the base colour texture's alpha channel;
  - without one, the material is made opaque (Poly Haven's solid quiver tree leaves are BLEND with JPEGs).
A real alpha channel in the base colour texture is kept and exported as MASK, so foliage cards are alpha-tested
rather than sorted.
"""
import argparse
import math
import os
import re
import sys

import bpy
import numpy as np
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # Do not rewrite the committed __pycache__ when importing common.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

PREVIEW_PREFIX = "Preview_"


def parse_args():
    p = argparse.ArgumentParser(prog="import_external.py")
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--target-tris", type=int, default=10000)
    p.add_argument("--max-texture", type=int, default=1024)
    p.add_argument("--name", default=None)
    p.add_argument("--alpha", choices=("auto", "opaque", "mask", "keep"), default="auto")
    p.add_argument("--alpha-map", action="append", default=[], metavar="KEY=PATH")
    p.add_argument("--ao", choices=("auto", "none"), default="auto")
    p.add_argument("--split", action="store_true")
    p.add_argument("--no-preview", action="store_true")
    return p.parse_args(common.args())


def triangle_count(obj) -> int:
    return sum(len(poly.vertices) - 2 for poly in obj.data.polygons)


def select_only(objs, active=None) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objs:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def import_objects(path: str, name: str, split: bool, dropped_lods: list) -> list:
    if path.lower().endswith((".gltf", ".glb")):
        bpy.ops.import_scene.gltf(filepath=path, merge_vertices=True)
    else:
        raise SystemExit(f"Unsupported input format: {path}")
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("No mesh in the imported file")
    # Poly Haven files with LODs name them <name>_LOD0, _LOD1, ...: keep the most detailed one only.
    lod = re.compile(r"_LOD(\d+)$", re.IGNORECASE)
    if any(lod.search(o.name) for o in meshes):
        drop = [o for o in meshes if (m := lod.search(o.name)) and int(m.group(1)) > 0]
        dropped_lods.extend(sorted(o.name for o in drop))
        for obj in drop:
            bpy.data.objects.remove(obj, do_unlink=True)
        meshes = [o for o in meshes if o not in drop]
    # Unparent with transforms kept, then remove everything that is not a mesh (empties, cameras, lights).
    for obj in meshes:
        matrix = obj.matrix_world.copy()
        obj.parent = None
        obj.matrix_world = matrix
    for obj in [o for o in bpy.data.objects if o.type != "MESH"]:
        bpy.data.objects.remove(obj, do_unlink=True)
    if split and len(meshes) > 1:
        objs, used = [], set()
        for i, obj in enumerate(sorted(meshes, key=lambda o: o.name)):
            m = re.search(r"_([A-Za-z0-9]+)$", obj.name)
            suffix = m.group(1).lower() if m else chr(ord("a") + i)
            if suffix in used:
                suffix = f"{suffix}{i}"
            used.add(suffix)
            obj.name = obj.data.name = f"{name}_{suffix}"
            objs.append(obj)
    else:
        select_only(meshes)
        if len(meshes) > 1:
            bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        obj.name = obj.data.name = name
        objs = [obj]
    select_only(objs)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return objs


def decimate(obj, target: int) -> int:
    for _ in range(4):
        tris = triangle_count(obj)
        if tris <= target * 1.02:
            break
        mod = obj.modifiers.new("Decimate", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = target / tris
        mod.use_collapse_triangulate = True
        select_only([obj])
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return triangle_count(obj)


def smooth_normals(obj) -> None:
    select_only([obj])
    if obj.data.has_custom_normals:
        bpy.ops.mesh.customdata_custom_splitnormals_clear()
    for poly in obj.data.polygons:
        poly.use_smooth = True
    obj.data.update()


def origin_to_bottom_centre(obj):
    co = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
    obj.data.vertices.foreach_get("co", co)
    co = co.reshape(-1, 3)
    lo, hi = co.min(axis=0), co.max(axis=0)
    offset = Vector((-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]))
    obj.data.transform(Matrix.Translation(offset))
    obj.location = (0, 0, 0)
    obj.data.update()
    return [float(v) for v in hi - lo]


def image_has_alpha(image) -> bool:
    """True when the image really carries transparency (an alpha channel with values below 1)."""
    if image is None or image.channels < 4 or image.alpha_mode == "NONE":
        return False
    count = image.size[0] * image.size[1]
    if count == 0:
        return False
    px = np.empty(count * 4, dtype=np.float32)
    image.pixels.foreach_get(px)
    return float(px[3::4].min()) < 0.99


def upstream_images(socket, seen=None):
    seen = seen if seen is not None else set()
    images = []
    for link in socket.links:
        node = link.from_node
        if node in seen:
            continue
        seen.add(node)
        if node.type == "TEX_IMAGE" and node.image is not None:
            images.append(node.image)
        for inp in node.inputs:
            images.extend(upstream_images(inp, seen))
    return images


def principled(mat):
    if not mat or not mat.node_tree:
        return None
    return next((n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def is_alpha_clip(node) -> bool:
    """Math nodes the glTF exporter reads as an alpha clip (Round, 1 - (X < cutoff), X > cutoff)."""
    return node.type == "MATH" and node.operation in ("ROUND", "SUBTRACT", "GREATER_THAN", "LESS_THAN")


def pick_alpha_map(mat, bsdf, alpha_maps: dict):
    """The alpha map for `mat`: the only one given, or the one whose key prefix is in the base colour image name."""
    if not alpha_maps:
        return None
    if len(alpha_maps) == 1:
        return next(iter(alpha_maps.values()))
    names = " ".join(i.name.lower() for i in upstream_images(bsdf.inputs["Base Color"]))
    for key, path in alpha_maps.items():
        prefix = re.sub(r"_?alpha$", "", key.lower())
        if prefix and prefix in names:
            return path
    return None


def wire_alpha_map(mat, bsdf, path: str) -> None:
    """Alpha-tested cut-out from a separate greyscale map: map.R -> Round -> BSDF Alpha (exported as MASK)."""
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    image = bpy.data.images.load(path, check_existing=True)
    image.colorspace_settings.name = "Non-Color"
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    base = next((n for n in nodes if n.type == "TEX_IMAGE" and n.image in upstream_images(bsdf.inputs["Base Color"])), None)
    if base is not None:
        tex.interpolation = base.interpolation
        tex.extension = base.extension
        if base.inputs["Vector"].is_linked:
            links.new(base.inputs["Vector"].links[0].from_socket, tex.inputs["Vector"])
    alpha = bsdf.inputs["Alpha"]
    for link in list(alpha.links):
        links.remove(link)
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(tex.outputs["Color"], split.inputs["Color"])
    clip = nodes.new("ShaderNodeMath")
    clip.operation = "ROUND"
    links.new(split.outputs[0], clip.inputs[0])
    links.new(clip.outputs[0], alpha)


def set_alpha_mask(mat, bsdf, cutoff: float = 0.5) -> None:
    """Alpha-tested: alpha -> (alpha >= cutoff), the node pattern the glTF exporter writes as MASK."""
    alpha = bsdf.inputs["Alpha"]
    src = alpha.links[0].from_socket
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    if is_alpha_clip(src.node):
        return
    node = nodes.new("ShaderNodeMath")
    node.operation = "ROUND" if abs(cutoff - 0.5) < 1e-6 else "GREATER_THAN"
    links.new(src, node.inputs[0])
    if node.operation == "GREATER_THAN":
        node.inputs[1].default_value = cutoff
    links.new(node.outputs[0], alpha)


def unique_materials(objs) -> list:
    mats = []
    for obj in objs:
        for slot in obj.material_slots:
            if slot.material is not None and slot.material not in mats:
                mats.append(slot.material)
    return mats


def fix_alpha(objs, mode: str, changes: dict, alpha_maps: dict) -> dict:
    """Returns the alpha mode per material; records changed materials in `changes` ("BLEND -> OPAQUE")."""
    result = {}
    for mat in unique_materials(objs):
        bsdf = principled(mat)
        if bsdf is None:
            continue
        alpha = bsdf.inputs["Alpha"]
        if not alpha.is_linked:
            result[mat.name] = "OPAQUE" if alpha.default_value >= 0.999 else "BLEND"
            continue
        if mode == "keep":
            result[mat.name] = "keep"
            continue
        before = "MASK" if is_alpha_clip(alpha.links[0].from_node) else "BLEND"
        real = any(image_has_alpha(img) for img in upstream_images(alpha))
        alpha_map = pick_alpha_map(mat, bsdf, alpha_maps) if not real and mode in ("auto", "mask") else None
        if alpha_map:
            wire_alpha_map(mat, bsdf, alpha_map)
            result[mat.name] = "MASK"
            changes[mat.name] = f"{before} (JPEG without alpha) -> MASK from {os.path.basename(alpha_map)}"
            continue
        if mode == "opaque" or (mode == "auto" and not real):
            for link in list(alpha.links):
                mat.node_tree.links.remove(link)
            alpha.default_value = 1.0
            result[mat.name] = "OPAQUE"
        else:
            set_alpha_mask(mat, bsdf)
            result[mat.name] = "MASK"
        if result[mat.name] == "OPAQUE" and hasattr(mat, "surface_render_method"):
            mat.surface_render_method = "DITHERED"
        if result[mat.name] != before:
            reason = " (its base colour texture has no alpha channel and no alpha map was given)" if result[mat.name] == "OPAQUE" and not real else ""
            changes[mat.name] = f"{before} -> {result[mat.name]}{reason}"
    return result


def gltf_output_group():
    """The node group the glTF exporter reads occlusion from (created like the add-on does)."""
    try:
        from io_scene_gltf2.blender.com.material_helpers import create_settings_group, get_gltf_node_name

        name = get_gltf_node_name()
        return bpy.data.node_groups.get(name) or create_settings_group(name)
    except ImportError:
        name = "glTF Material Output"
        group = bpy.data.node_groups.get(name)
        if group is None:
            group = bpy.data.node_groups.new(name, "ShaderNodeTree")
            group.interface.new_socket("Occlusion", socket_type="NodeSocketFloat")
        return group


def add_occlusion_from_arm(objs) -> list:
    """Poly Haven packs AO, roughness and metalness as ARM (= glTF ORM) but its glTFs omit occlusionTexture.
    Feed the red channel of that same image to the glTF output group so the exporter writes occlusion."""
    added = []
    for mat in unique_materials(objs):
        bsdf = principled(mat)
        if bsdf is None or not bsdf.inputs["Roughness"].is_linked:
            continue
        nodes, links = mat.node_tree.nodes, mat.node_tree.links
        if any(n.type == "GROUP" and n.node_tree and n.node_tree.name in ("glTF Material Output", "glTF Settings") for n in nodes):
            continue
        tex = next((n for n in nodes if n.type == "TEX_IMAGE" and n.image and n.image in upstream_images(bsdf.inputs["Roughness"])), None)
        if tex is None:
            continue
        filename = os.path.basename(tex.image.filepath or tex.image.name).lower()
        if not re.search(r"(^|[_\-.])(arm|orm)([_\-.]|$)", filename):
            continue
        split = nodes.new("ShaderNodeSeparateColor")
        links.new(tex.outputs["Color"], split.inputs["Color"])
        group = nodes.new("ShaderNodeGroup")
        group.node_tree = gltf_output_group()
        links.new(split.outputs[0], group.inputs["Occlusion"])
        added.append(mat.name)
    return added


def material_report(objs) -> list:
    report = []
    for mat in unique_materials(objs):
        bsdf = principled(mat)
        textures = {}
        if bsdf is not None:
            for socket in ("Base Color", "Roughness", "Metallic", "Normal", "Alpha"):
                imgs = upstream_images(bsdf.inputs[socket])
                if imgs:
                    textures[socket] = sorted({i.name for i in imgs})
            if mat.node_tree:
                # Occlusion lives in the glTF Settings / glTF Material Output group, not on the BSDF.
                for node in mat.node_tree.nodes:
                    if node.type == "GROUP" and node.node_tree and "gltf" in node.node_tree.name.lower():
                        for inp in node.inputs:
                            imgs = upstream_images(inp)
                            if imgs:
                                textures["Occlusion"] = sorted({i.name for i in imgs})
        report.append({"name": mat.name if mat else None, "textures": textures})
    return report


def resize_textures(max_size: int) -> list:
    out = []
    for image in bpy.data.images:
        if image.type != "IMAGE" or image.size[0] == 0:
            continue
        w, h = image.size
        if max(w, h) > max_size:
            scale = max_size / max(w, h)
            image.scale(max(1, round(w * scale)), max(1, round(h * scale)))
            image.pack()
        out.append({"name": image.name, "size": list(image.size)})
    return out


def export(objs, path: str) -> None:
    common.ensure_dir(os.path.dirname(path))
    select_only(objs)
    kwargs = dict(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_yup=True,
        export_animations=False,
    )
    try:
        bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="NONE")
    except TypeError:
        bpy.ops.export_scene.gltf(**kwargs)


def look_rotation(direction: Vector):
    return direction.to_track_quat("-Z", "Y").to_euler()


def render_contact_sheet(objs, path: str, tile: int = 512, samples: int = 32) -> None:
    """Four views (front, side, back three-quarter, high three-quarter) on neutral grey, sun + sky light.
    A split set gets one three-quarter view per object instead."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = tile
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"

    world = bpy.data.worlds.new(PREVIEW_PREFIX + "Sky")
    if world.node_tree is None:  # Blender 5 worlds always have nodes; older versions need use_nodes.
        world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.62, 0.72, 0.9, 1.0)
    bg.inputs["Strength"].default_value = 0.55
    scene.world = world

    sun_data = bpy.data.lights.new(PREVIEW_PREFIX + "Sun", "SUN")
    sun_data.energy = 2.6
    sun_data.angle = math.radians(2.0)
    sun_data.color = (1.0, 0.96, 0.9)
    sun = bpy.data.objects.new(PREVIEW_PREFIX + "Sun", sun_data)
    scene.collection.objects.link(sun)

    cam_data = bpy.data.cameras.new(PREVIEW_PREFIX + "Cam")
    cam_data.lens = 50
    cam_data.clip_start = 0.01
    cam_data.clip_end = 10000
    cam = bpy.data.objects.new(PREVIEW_PREFIX + "Cam", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam

    # One object: four views. A split set: one three-quarter view per object, rendered alone.
    if len(objs) == 1:
        shots = [(objs, az, el) for az, el in ((0, 8), (90, 8), (215, 22), (35, 60))]
    else:
        shots = [([obj], 35, 25) for obj in objs]
    tiles = []
    tmp_dir = common.ensure_dir(os.path.join(os.path.dirname(path), ".preview_tmp"))
    for index, (visible, azimuth, elevation) in enumerate(shots):
        for obj in objs:
            obj.hide_render = obj not in visible
        clouds = []
        for obj in visible:  # Transforms are applied, so world = local + location.
            co = np.empty(len(obj.data.vertices) * 3, dtype=np.float64)
            obj.data.vertices.foreach_get("co", co)
            clouds.append(co.reshape(-1, 3) + np.array(obj.location))
        pts = np.concatenate(clouds)
        if len(pts) > 6000:
            pts = pts[:: len(pts) // 6000 + 1]
        centre = Vector(((pts.min(axis=0) + pts.max(axis=0)) / 2).tolist())
        flat = [float(v) for v in pts.reshape(-1)]
        az, el = math.radians(azimuth), math.radians(elevation)
        # Camera position direction (from the model towards the camera); azimuth 0 looks from -Y (front).
        to_cam = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
        cam.rotation_euler = look_rotation(-to_cam)
        # Sun from the camera's upper left so every view is lit from the front.
        sun_dir = Matrix.Rotation(math.radians(-40), 3, "Z") @ Vector((to_cam.x, to_cam.y, 0)).normalized()
        sun_dir = (sun_dir + Vector((0, 0, 1.3))).normalized()
        sun.rotation_euler = look_rotation(-sun_dir)
        bpy.context.view_layer.update()
        loc, _scale = cam.camera_fit_coords(bpy.context.evaluated_depsgraph_get(), flat)
        loc = Vector(loc)
        # Step back along the view axis for a small margin around the model.
        cam.location = loc + to_cam * ((loc - centre).length * 0.08)
        tile_path = os.path.join(tmp_dir, f"tile_{index}.png")
        scene.render.filepath = tile_path
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(tile_path)
        px = np.empty(tile * tile * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        os.remove(tile_path)
        tiles.append(px.reshape(tile, tile, 4))
    try:
        os.rmdir(tmp_dir)
    except OSError:
        pass

    for obj in objs:
        obj.hide_render = False
    grey = 0.45
    cols = math.ceil(math.sqrt(len(tiles)))
    rows = math.ceil(len(tiles) / cols)
    sheet = np.full((tile * rows, tile * cols, 4), grey, dtype=np.float32)
    sheet[..., 3] = 1
    # Blender pixel rows run bottom-up, so the first tiles go on the top row.
    for i, px in enumerate(tiles):
        rgb = px[..., :3] * px[..., 3:4] + grey * (1 - px[..., 3:4])
        row = rows - 1 - i // cols
        col = i % cols
        sheet[row * tile : (row + 1) * tile, col * tile : (col + 1) * tile, :3] = rgb
    out = bpy.data.images.new(PREVIEW_PREFIX + "Sheet", tile * cols, tile * rows, alpha=False)
    out.pixels.foreach_set(sheet.reshape(-1))
    out.filepath_raw = path
    out.file_format = "PNG"
    out.save()

    for o in [o for o in bpy.data.objects if o.name.startswith(PREVIEW_PREFIX)]:
        bpy.data.objects.remove(o, do_unlink=True)


def main() -> None:
    a = parse_args()
    src = os.path.abspath(a.input)
    out = os.path.abspath(a.output)
    stem = os.path.splitext(out)[0]
    name = a.name or os.path.splitext(os.path.basename(out))[0]
    common.reset_scene()

    dropped_lods = []
    objs = import_objects(src, name, a.split, dropped_lods)
    source_counts = [triangle_count(o) for o in objs]
    source_tris = sum(source_counts)
    parts = []
    for obj, count in zip(objs, source_counts):
        target = max(64, round(a.target_tris * count / source_tris))
        obj_tris = decimate(obj, target)
        smooth_normals(obj)
        obj_dims = origin_to_bottom_centre(obj)
        parts.append({
            "name": obj.name,
            "sourceTriangles": count,
            "triangles": obj_tris,
            "dimensions": {"width": round(obj_dims[0], 4), "depth": round(obj_dims[1], 4), "height": round(obj_dims[2], 4)},
        })
    tris = sum(p["triangles"] for p in parts)
    # Overall extent: the joined object, or the largest part of a split set (all parts sit at the origin).
    dims = [max(p["dimensions"][k] for p in parts) for k in ("width", "depth", "height")]
    alpha_changes = {}
    alpha_maps = {}
    for item in a.alpha_map:
        key, _, path = item.partition("=")
        alpha_maps[key] = os.path.abspath(path)
    alpha = fix_alpha(objs, a.alpha, alpha_changes, alpha_maps)
    occlusion = add_occlusion_from_arm(objs) if a.ao == "auto" else []
    textures = resize_textures(a.max_texture)
    materials = material_report(objs)
    export(objs, out)

    def repo_path(path: str) -> str:
        """Repo-relative path for the committed report (absolute when outside the repository)."""
        try:
            rel = os.path.relpath(path, common.ROOT)
        except ValueError:  # Another drive on Windows.
            rel = path
        return (path if rel.startswith("..") else rel).replace("\\", "/")

    report = {
        "name": name,
        "input": repo_path(src),
        "output": repo_path(out),
        "droppedLods": dropped_lods,
        "sourceTriangles": source_tris,
        "targetTriangles": a.target_tris,
        "triangles": tris,
        "vertices": sum(len(o.data.vertices) for o in objs),
        "dimensions": {"width": round(dims[0], 4), "depth": round(dims[1], 4), "height": round(dims[2], 4)},
        "objects": parts,
        "origin": "bottom centre of the bounding box" + (" of each object, every object at the origin" if len(objs) > 1 else ""),
        "maxTexture": a.max_texture,
        "alphaModes": alpha,
        "alphaChanges": alpha_changes,
        "occlusionAddedFromArm": occlusion,
        "materials": materials,
        "textures": textures,
    }
    common.write_metadata(stem + ".report.json", report)
    if not a.no_preview:
        render_contact_sheet(objs, stem + ".preview.png")
    for p in parts if len(parts) > 1 else []:
        d = p["dimensions"]
        print(f"  {p['name']}: {p['sourceTriangles']} -> {p['triangles']} triangles, {d['width']:.3f} x {d['depth']:.3f} x {d['height']:.3f} m")
    print(
        f"IMPORT_OK {name} {source_tris} -> {tris} triangles in {len(objs)} object(s), bbox {dims[0]:.3f} x {dims[1]:.3f} x {dims[2]:.3f} m "
        f"(width x depth x height), materials {', '.join(f'{k}={v}' for k, v in alpha.items())}"
    )


main()
