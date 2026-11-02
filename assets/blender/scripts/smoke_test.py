"""Pipeline smoke test: build a bevelled unit cube and export it as GLB.

Usage: blender -b --factory-startup --python smoke_test.py -- <out.glb>
"""
import sys
import bpy

out = sys.argv[sys.argv.index("--") + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(size=1.0)
cube = bpy.context.active_object
bevel = cube.modifiers.new("bevel", "BEVEL")
bevel.width = 0.08
bevel.segments = 3
bpy.ops.object.modifier_apply(modifier="bevel")
bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False)
print("SMOKE_OK", len(cube.data.vertices), "verts ->", out)
