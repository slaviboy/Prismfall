"""Ember Foundry environment kit — an original industrial forge hall behind the playfield.

Coordinates: Blender Z-up. The glTF export converts to three.js Y-up, so Blender +Y (depth)
becomes three -Z (away from the camera). The playfield sits at the origin; everything here is
placed at Blender y > 25 (behind it) and z >= -14 (the forge floor).

Object naming drives in-game animation: gear_* rotate, piston_rod_* stamp on the beat.
Material names map to in-game presets: darkMetal, steel, brass, hotMetal, furnaceGlow, molten.

Usage: blender -b --factory-startup --python assets/blender/scripts/foundry_kit.py -- [--no-preview]
"""
import math
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(__file__))
import common  # noqa: E402

OUT_GLB = os.path.join(common.ROOT, "assets", "blender", "exports", "foundry", "foundry.glb")
OUT_SRC = os.path.join(common.ROOT, "assets", "blender", "source", "environments", "ember_foundry.blend")
OUT_PREVIEW = os.path.join(common.ROOT, "assets", "blender", "previews", "ember_foundry.png")
OUT_META = os.path.join(common.ROOT, "assets", "blender", "exports", "foundry", "foundry.meta.json")

FLOOR_Z = -14.0
MATS = {}


def mat(name):
    return MATS[name]


def active():
    return bpy.context.view_layer.objects.active


def cube(name, size, location, material, rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = active()
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(mat(material))
    return obj


def cylinder(name, radius, depth, location, material, rotation=(0, 0, 0), vertices=32):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = active()
    obj.name = name
    obj.data.materials.append(mat(material))
    return obj


def join(objects, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.object.join()
    obj = active()
    obj.name = name
    return obj


def bevel(obj, width=0.06, segments=2):
    mod = obj.modifiers.new("bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40)
    common.apply_modifiers(obj)


def set_origin(obj, location):
    """Moves the object origin to `location` (world) without moving geometry (for rotation pivots)."""
    bpy.context.scene.cursor.location = location
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")


def gear(name, radius, thickness, teeth, location):
    """Toothed gear facing the camera (axis along Blender Y), with a hub and lightening holes."""
    x, y, z = location
    parts = [cylinder(name + "_body", radius * 0.86, thickness, (x, y, z), "brass", rotation=(math.pi / 2, 0, 0), vertices=max(48, teeth * 2))]
    for i in range(teeth):
        a = 2 * math.pi * i / teeth
        t = cube(f"{name}_t{i}", (radius * 0.16, thickness * 0.96, radius * 0.24), (x + math.cos(a) * radius * 0.93, y, z + math.sin(a) * radius * 0.93), "brass", rotation=(0, -a + math.pi / 2, 0))
        parts.append(t)
    parts.append(cylinder(name + "_hub", radius * 0.22, thickness * 1.5, (x, y, z), "steel", rotation=(math.pi / 2, 0, 0), vertices=32))
    obj = join(parts, name)
    # Lightening holes (boolean difference) give the gear a machined silhouette.
    holes = []
    for i in range(6):
        a = 2 * math.pi * i / 6
        holes.append(cylinder(f"{name}_hole{i}", radius * 0.17, thickness * 3, (x + math.cos(a) * radius * 0.52, y, z + math.sin(a) * radius * 0.52), "darkMetal", rotation=(math.pi / 2, 0, 0), vertices=24))
    cutter = join(holes, name + "_cutter")
    mod = obj.modifiers.new("holes", "BOOLEAN")
    mod.operation = "DIFFERENCE"
    mod.object = cutter
    mod.solver = "EXACT"
    common.apply_modifiers(obj)
    bpy.data.objects.remove(cutter, do_unlink=True)
    bevel(obj, 0.05, 1)
    set_origin(obj, (x, y, z))
    return obj


def piston(index, x, y):
    housing = cylinder(f"piston_housing_{index:02d}", 1.6, 9, (x, y, 26), "steel", vertices=32)
    cap = cylinder(f"piston_cap_{index:02d}", 2.1, 1.2, (x, y, 31), "darkMetal", vertices=32)
    housing = join([housing, cap], f"piston_housing_{index:02d}")
    bevel(housing, 0.08, 2)
    rod = cylinder(f"piston_rod_{index:02d}", 0.7, 20, (x, y, 12), "steel", vertices=24)
    head = cube(f"piston_head_{index:02d}", (4.2, 4.2, 2.2), (x, y, 1.0), "darkMetal")
    glow = cube(f"piston_heat_{index:02d}", (4.25, 4.25, 0.35), (x, y, -0.1), "hotMetal")
    rod = join([rod, head, glow], f"piston_rod_{index:02d}")
    bevel(rod, 0.06, 1)
    set_origin(rod, (x, y, 12))
    anvil = cube(f"anvil_{index:02d}", (6, 6, 3.6), (x, y, FLOOR_Z + 1.8), "darkMetal")
    hot = cube(f"anvil_hot_{index:02d}", (4.4, 4.4, 0.4), (x, y, FLOOR_Z + 3.7), "hotMetal")
    anvil = join([anvil, hot], f"anvil_{index:02d}")
    bevel(anvil, 0.1, 2)
    return housing, rod, anvil


def chain(name, x, y, top, links):
    parts = []
    for i in range(links):
        bpy.ops.mesh.primitive_torus_add(major_radius=0.9, minor_radius=0.22, major_segments=16, minor_segments=6, location=(x, y, top - i * 1.35), rotation=(0, math.pi / 2, (math.pi / 2) * (i % 2)))
        link = active()
        link.scale = (1, 1, 1.55)
        link.data.materials.append(mat("darkMetal"))
        parts.append(link)
    obj = join(parts, name)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return obj


def pipe_run(name, points, radius, material="brass"):
    """Straight pipe segments with flanges between consecutive points."""
    parts = []
    for (ax, ay, az), (bx, by, bz) in zip(points, points[1:]):
        dx, dy, dz = bx - ax, by - ay, bz - az
        length = math.sqrt(dx * dx + dy * dy + dz * dz)
        mid = ((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2)
        bpy.ops.mesh.primitive_cylinder_add(vertices=20, radius=radius, depth=length, location=mid)
        seg = active()
        seg.rotation_mode = "QUATERNION"
        import mathutils

        seg.rotation_quaternion = mathutils.Vector((dx, dy, dz)).to_track_quat("Z", "Y")
        seg.data.materials.append(mat(material))
        parts.append(seg)
        flange = cylinder(name + "_f", radius * 1.5, radius * 0.6, (bx, by, bz), "steel", vertices=20)
        flange.rotation_mode = "QUATERNION"
        flange.rotation_quaternion = seg.rotation_quaternion
        parts.append(flange)
    obj = join(parts, name)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    return obj


def build():
    MATS["darkMetal"] = common.make_material("darkMetal", (0.05, 0.045, 0.045), metallic=0.9, roughness=0.5)
    MATS["steel"] = common.make_material("steel", (0.25, 0.25, 0.27), metallic=1.0, roughness=0.35)
    MATS["brass"] = common.make_material("brass", (0.45, 0.3, 0.12), metallic=1.0, roughness=0.32)
    MATS["hotMetal"] = common.make_material("hotMetal", (0.2, 0.05, 0.01), roughness=0.5, emission=(1.0, 0.35, 0.08), emission_strength=6)
    MATS["furnaceGlow"] = common.make_material("furnaceGlow", (0.3, 0.1, 0.02), roughness=0.6, emission=(1.0, 0.45, 0.12), emission_strength=12)
    MATS["molten"] = common.make_material("molten", (0.4, 0.15, 0.02), roughness=0.4, emission=(1.0, 0.6, 0.18), emission_strength=16)

    objects = []
    # Floor slabs flanking a central molten channel (the channel itself is the in-game lava layer).
    for side in (-1, 1):
        for row in range(7):
            slab = cube(f"floor_{'L' if side < 0 else 'R'}{row}", (95, 34, 2), (side * 66, 40 + row * 34, FLOOR_Z - 1), "darkMetal")
            bevel(slab, 0.25, 2)
            objects.append(slab)
            edge = cube(f"floor_edge_{'L' if side < 0 else 'R'}{row}", (0.6, 33, 0.5), (side * 18.6, 40 + row * 34, FLOOR_Z + 0.05), "hotMetal")
            objects.append(edge)

    # Back wall with glowing vents and two furnace mouths.
    wall = cube("back_wall", (360, 6, 140), (0, 270, 50), "darkMetal")
    objects.append(wall)
    for i in range(12):
        x = -150 + i * 27.3
        for j in range(3):
            vent = cube(f"vent_{i}_{j}", (14, 1.2, 1.1), (x, 266.5, 18 + j * 22), "hotMetal")
            objects.append(vent)
    for k, x in enumerate((-55, 55)):
        bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=16, depth=8, location=(x, 264, 6), rotation=(math.pi / 2, 0, 0))
        arch = active()
        arch.name = f"furnace_arch_{k}"
        arch.data.materials.append(mat("darkMetal"))
        # A thin glowing sill under each arch suggests the furnace without a flat bright panel.
        sill = cube(f"furnace_sill_{k}", (26, 1.2, 0.8), (x, 258, -9.5), "furnaceGlow")
        objects += [arch, sill]

    # Columns (I-beams) and roof truss.
    for x in (-140, -80, 80, 140):
        for y in (90, 190):
            web = cube(f"column_web_{x}_{y}", (1.6, 1.6, 100), (x, y, 36), "steel")
            fl1 = cube(f"column_fl1_{x}_{y}", (5, 0.8, 100), (x, y - 1.2, 36), "steel")
            fl2 = cube(f"column_fl2_{x}_{y}", (5, 0.8, 100), (x, y + 1.2, 36), "steel")
            objects.append(join([web, fl1, fl2], f"column_{x}_{y}"))
    for y in (90, 140, 190, 240):
        beam = cube(f"truss_{y}", (300, 2.2, 3.2), (0, y, 84), "steel")
        objects.append(beam)
        for i in range(10):
            x = -135 + i * 30
            diag = cube(f"truss_diag_{y}_{i}", (0.8, 0.8, 16), (x, y, 76), "steel", rotation=(0, math.radians(35 if i % 2 else -35), 0))
            objects.append(diag)

    # Giant gears on the back wall (meshing pairs).
    for name, r, t, teeth, loc in (
        ("gear_01", 22, 3.2, 36, (-82, 250, 46)),
        ("gear_02", 12, 3.0, 20, (-49.5, 250, 32)),
        ("gear_03", 28, 3.6, 44, (78, 252, 58)),
        ("gear_04", 10, 2.8, 16, (42.5, 250, 36)),
        ("gear_05", 15, 3.0, 24, (122, 248, 22)),
        ("gear_06", 18, 3.0, 28, (-128, 252, 70)),
    ):
        objects.append(gear(name, r, t, teeth, loc))

    # Stamping pistons over anvils, in a row across the hall.
    for i, x in enumerate((-75, -45, -15, 15, 45, 75)):
        objects += list(piston(i, x, 120))

    # Crucible pouring molten metal into the channel.
    bpy.ops.mesh.primitive_cylinder_add(vertices=40, radius=11, depth=14, location=(-128, 150, 28), rotation=(0, math.radians(28), 0))
    crucible = active()
    crucible.name = "crucible"
    crucible.data.materials.append(mat("darkMetal"))
    bevel(crucible, 0.4, 3)
    lip = cylinder("crucible_glow", 9.6, 1.0, (-125, 150, 34.2), "molten", rotation=(0, math.radians(28), 0), vertices=40)
    stream = cylinder("molten_stream", 1.4, 44, (-115, 150, 10), "molten", vertices=16)
    pool = cylinder("molten_pool", 7, 0.6, (-115, 150, FLOOR_Z + 0.1), "molten", vertices=32)
    objects += [crucible, lip, stream, pool]

    # Pipes along the side walls, catwalk with railings, hanging chains.
    objects.append(pipe_run("pipes_left", [(-170, 60, 10), (-170, 240, 10), (-120, 240, 40), (-120, 262, 40)], 2.2))
    objects.append(pipe_run("pipes_right", [(170, 60, 30), (170, 230, 30), (140, 230, 62), (140, 262, 62)], 2.6))
    objects.append(pipe_run("pipes_high", [(-160, 210, 66), (160, 210, 66)], 1.6, "steel"))
    deck = cube("catwalk_deck", (250, 7, 0.8), (0, 150, 12), "darkMetal")
    rails = [deck]
    for i in range(26):
        x = -124 + i * 10
        rails.append(cylinder(f"rail_post_{i}", 0.25, 5, (x, 147, 14.5), "steel", vertices=10))
    rails.append(cube("rail_top", (250, 0.5, 0.5), (0, 147, 17), "steel"))
    objects.append(join(rails, "catwalk"))
    for k, x in enumerate((-100, 0, 100)):
        objects.append(chain(f"chain_{k}", x, 205, 80, 24))

    for o in objects:
        common.shade_smooth_by_angle(o, 35)
    # Vertex-colour AO on the big structural pieces (cheap, exported as COLOR_0).
    for o in objects:
        if o.name.startswith(("back_wall", "gear_", "column_", "anvil_", "crucible", "floor_L", "floor_R", "catwalk")):
            try:
                common.bake_dirty_vertex_ao(o)
            except Exception as err:  # noqa: BLE001
                print("AO skipped for", o.name, err)
    return objects


def main():
    options = common.args()
    common.reset_scene()
    objects = build()
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objects if o.type == "MESH")
    common.export_glb(objects, OUT_GLB, vertex_colors=True)
    common.write_metadata(OUT_META, {
        "generator": "assets/blender/scripts/foundry_kit.py",
        "objects": len(objects),
        "triangles": tris,
        "animated": {"rotate": "gear_*", "pistons": "piston_rod_*"},
        "materials": list(MATS.keys()),
        "license": "Original work for Prismfall",
    })
    common.save_blend(OUT_SRC)
    if "--no-preview" not in options:
        common.render_preview(OUT_PREVIEW, camera_location=(0, -70, 30), target=(0, 150, 20), lens=24, samples=16)
    print("FOUNDRY_OK", len(objects), "objects", tris, "triangles")


main()
