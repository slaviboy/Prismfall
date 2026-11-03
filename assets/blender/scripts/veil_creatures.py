"""The Veil's creatures: original designs, built and rigged in Blender, animated in game.

- strider.glb: the giant walker. A gaunt, impossibly tall quadruped carried on four stilt legs (long
  shanks, knobbed joints, narrow hooves), the back sloping from a deep, ribbed chest to a narrow
  pelvis, a long neck curving forward and down to a long, eyeless, downward-hanging skull with two
  swept-back horns, and a ridge of thin dorsal quills that sway as it walks.
- hollow.glb: the long-limbed shadow. A gaunt biped nine metres tall, hunched, with a ribbed
  narrow torso, legs that are mostly shin, arms that hang below its knees ending in three long
  fingers, and a crown of branching antlers that make it read as one of the dead trees when it
  stands still.
- ray.glb: the swarm. A fog ray: a flat, diamond-shaped soaring body with a scalloped trailing
  edge, a slight dorsal keel and a long whip tail (no skeleton; the wings ripple in the shader).
- colossus.glb: the unseen giant, only ever glimpsed: a hunched mass on pillar legs with a long,
  low head and a back bristling with stone-like spires, sized to dwarf the forest.

Bodies are skin-modifier hulls over designed skeletons (elliptical cross-sections with muscle,
joint and hoof profiles), subdivided, then given anatomy by displacement in each bone's frame (ribs,
vertebrae, tendons, knuckles, wrinkles), decimated, and weighted to the armature by distance to
each bone segment, blended only along the vertex's own limb chain so limbs never pull on each
other. The armature exports as a glTF skin; bone names are what the stage's animation code uses.

Blender Z-up, the creature faces -Y (glTF +Z), feet at z = 0.

Usage: blender -b --factory-startup --python assets/blender/scripts/veil_creatures.py -- [--no-preview]
"""
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

sys.path.insert(0, os.path.dirname(__file__))
sys.dont_write_bytecode = True
import common  # noqa: E402

OUT_DIR = os.path.join(common.ROOT, "assets", "blender", "exports", "veil")
SRC = os.path.join(common.ROOT, "assets", "blender", "source", "veil_creatures.blend")
PREVIEW_DIR = os.path.join(common.ROOT, "assets", "blender", "previews")


# ----------------------------------------------------------------------------------------------
# Skeleton description.


class Bone:
    def __init__(self, name, parent, head, tail, profile, deform=True, kind="limb", segs=None):
        self.name = name
        self.parent = parent
        self.head = Vector(head)
        self.tail = Vector(tail)
        # profile: list of (t, rx, ry): cross-section radii along the bone (x = side, y = depth).
        self.profile = profile
        self.deform = deform
        self.kind = kind
        self.segs = segs

    def radius_at(self, t):
        p = self.profile
        if t <= p[0][0]:
            return p[0][1], p[0][2]
        for (t0, a0, b0), (t1, a1, b1) in zip(p, p[1:]):
            if t <= t1:
                k = (t - t0) / max(1e-6, t1 - t0)
                k = k * k * (3 - 2 * k)
                return a0 + (a1 - a0) * k, b0 + (b1 - b0) * k
        return p[-1][1], p[-1][2]


class Skeleton:
    def __init__(self):
        self.bones = []
        self.by_name = {}

    def add(self, name, parent, head, tail, profile, **kw):
        b = Bone(name, parent, head, tail, profile, **kw)
        self.bones.append(b)
        self.by_name[name] = b
        return b

    def chain(self, names, parent, points, profiles, **kw):
        """Consecutive bones through `points` (len(names) + 1 points)."""
        prev = parent
        for i, n in enumerate(names):
            self.add(n, prev, points[i], points[i + 1], profiles[i], **kw)
            prev = n
        return prev


def mirror(p):
    return (-p[0], p[1], p[2])


# ----------------------------------------------------------------------------------------------
# Hull: skin modifier over the skeleton graph, then subdivision.


def chains_of(sk):
    """Splits the skeleton into unbranched paths: a path continues into the first child that starts
    at its tail; every other child starts a new path (overlapping hulls, merged by the remesh)."""
    paths = []
    seen = set()
    for b in sk.bones:
        if not b.deform or b.kind in ("none", "finger") or b.name in seen:
            continue
        path = [b]
        seen.add(b.name)
        cur = b
        while True:
            nxt = [c for c in sk.bones if c.parent == cur.name and c.deform and c.kind != "none" and c.name not in seen and (c.head - cur.tail).length < 1e-4]
            if not nxt:
                break
            cur = nxt[0]
            path.append(cur)
            seen.add(cur.name)
        paths.append(path)
    return paths


def skin_path(name, path, step):
    verts = []
    radii = []
    for bi, b in enumerate(path):
        length = (b.tail - b.head).length
        n = b.segs or max(2, int(math.ceil(length / step)))
        for k in range(0 if bi == 0 else 1, n + 1):
            t = k / n
            verts.append(b.head.lerp(b.tail, t))
            radii.append(b.radius_at(t))
    # Extend the first sample back into the parent so the hulls overlap at the joint.
    d0 = (verts[1] - verts[0]).normalized()
    r0 = radii[0]
    verts.insert(0, verts[0] - d0 * max(r0) * 0.9)
    radii.insert(0, (r0[0] * 0.75, r0[1] * 0.75))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata([tuple(v) for v in verts], [(i, i + 1) for i in range(len(verts) - 1)], [])
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    skin = obj.modifiers.new("Skin", "SKIN")
    skin.branch_smoothing = 0.0
    skin.use_smooth_shade = True
    sv = mesh.skin_vertices[0].data
    for i, r in enumerate(radii):
        sv[i].radius = (max(r[0], 0.004), max(r[1], 0.004))
        sv[i].use_root = i == 0
    sub = obj.modifiers.new("Sub", "SUBSURF")
    sub.levels = 1
    common.apply_modifiers(obj)
    return obj


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    return obj


def tube_object(name, pts, radii, sides=7):
    """A tapered tube (quills, horns, antlers, spires) that is joined to the body after the remesh."""
    bm = bmesh.new()
    pts = [Vector(p) for p in pts]
    prev = None
    tangent_ref = None
    for i, p in enumerate(pts):
        t = (pts[min(len(pts) - 1, i + 1)] - pts[max(0, i - 1)]).normalized()
        if tangent_ref is None:
            ref = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
            nrm = (ref - t * ref.dot(t)).normalized()
        else:
            nrm = (tangent_ref - t * tangent_ref.dot(t)).normalized()
        tangent_ref = nrm
        bn = t.cross(nrm)
        r = radii[i][0] if isinstance(radii[i], (tuple, list)) else radii[i]
        ring = [bm.verts.new(p + (nrm * math.cos(a) + bn * math.sin(a)) * r) for a in [2 * math.pi * k / sides for k in range(sides)]]
        if prev:
            for k in range(sides):
                bm.faces.new((prev[k], prev[(k + 1) % sides], ring[(k + 1) % sides], ring[k]))
        else:
            bm.faces.new(list(reversed(ring)))
        prev = ring
    tip = bm.verts.new(pts[-1] + (pts[-1] - pts[-2]).normalized() * 0.02)
    for k in range(sides):
        bm.faces.new((prev[k], prev[(k + 1) % sides], tip))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    for poly in me.polygons:
        poly.use_smooth = True
    return obj


def build_hull(name, sk, step=0.35, voxel=0.03, smooth=6):
    """Union of one skin hull per unbranched chain, voxel-remeshed into a single clean surface with
    soft fillets where limbs meet the body."""
    parts = [skin_path(f"{name}_{i}", path, step) for i, path in enumerate(chains_of(sk))]
    obj = join(parts, name)
    rem = obj.modifiers.new("Remesh", "REMESH")
    rem.mode = "VOXEL"
    rem.voxel_size = voxel
    rem.adaptivity = 0.0
    rem.use_smooth_shade = True
    sm = obj.modifiers.new("Smooth", "SMOOTH")
    sm.factor = 0.5
    sm.iterations = smooth
    common.apply_modifiers(obj)
    return obj


# ----------------------------------------------------------------------------------------------
# Anatomy by displacement in bone frames, weights, armature.


def seg_param(p, a, b):
    ab = b - a
    t = max(0.0, min(1.0, (p - a).dot(ab) / max(1e-9, ab.dot(ab))))
    return t, (p - (a + ab * t)).length


def bone_frame(b):
    """Bone axis, its side (x) and its depth (y-ish) directions."""
    ax = (b.tail - b.head).normalized()
    side = Vector((1, 0, 0))
    if abs(ax.dot(side)) > 0.9:
        side = Vector((0, 0, 1))
    side = (side - ax * side.dot(ax)).normalized()
    depth = ax.cross(side).normalized()
    return ax, side, depth


def nearest_bones(sk, p, kinds=None):
    """(normalised distance, bone, t) for every deforming bone, sorted."""
    out = []
    for b in sk.bones:
        if not b.deform:
            continue
        if kinds and b.kind not in kinds:
            continue
        t, d = seg_param(p, b.head, b.tail)
        rx, ry = b.radius_at(t)
        out.append((d / max(0.02, max(rx, ry)), b, t))
    out.sort(key=lambda x: x[0])
    return out


def displace(obj, sk, rules, seed):
    """rules(bone, t, around, p, n) -> outward displacement (metres), evaluated per vertex."""
    me = obj.data
    me.calc_loop_triangles()
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    moves = []
    for v in bm.verts:
        p = v.co.copy()
        nb = nearest_bones(sk, p)[0]
        b, t = nb[1], nb[2]
        ax, side, depth = bone_frame(b)
        c = b.head.lerp(b.tail, t)
        r = p - c
        r = r - ax * r.dot(ax)
        around = math.atan2(r.dot(depth), r.dot(side))
        moves.append(v.normal * rules(b, t, around, p, v.normal))
    for v, m in zip(bm.verts, moves):
        v.co += m
    bm.to_mesh(me)
    bm.free()
    me.update()


def decimate(obj, target):
    tris = sum(len(p.vertices) - 2 for p in obj.data.polygons)
    if tris <= target:
        return tris
    mod = obj.modifiers.new("Dec", "DECIMATE")
    mod.ratio = target / tris
    mod.use_collapse_triangulate = True
    common.apply_modifiers(obj)
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def chain_of(sk, bone):
    """The bone, its ancestors and descendants: the only bones a vertex may blend between."""
    names = {bone.name}
    p = bone.parent
    while p:
        names.add(p)
        p = sk.by_name[p].parent
    stack = [bone.name]
    while stack:
        cur = stack.pop()
        for b in sk.bones:
            if b.parent == cur and b.name not in names:
                names.add(b.name)
                stack.append(b.name)
    return names


def weight(obj, sk, falloff=0.55):
    """Up to four influences per vertex: the nearest bone and its chain neighbours, by distance to
    each segment relative to the bone's radius there (smooth across joints, never across limbs)."""
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in sk.bones if b.deform}
    chains = {b.name: chain_of(sk, b) for b in sk.bones if b.deform}
    for v in obj.data.vertices:
        p = v.co
        ranked = nearest_bones(sk, p)
        best = ranked[0][1]
        allowed = chains[best.name]
        cands = [(d, b) for (d, b, t) in ranked if b.name in allowed][:4]
        d0 = cands[0][0]
        ws = []
        for d, b in cands:
            w = math.exp(-((d - d0) / falloff) ** 2) * (1.0 / (0.25 + d))
            ws.append((w, b))
        total = sum(w for w, _ in ws)
        for w, b in ws:
            w /= total
            if w > 0.02:
                groups[b.name].add([v.index], w, "REPLACE")


def armature(name, sk, mesh_obj):
    arm_data = bpy.data.armatures.new(name + "_rig")
    arm = bpy.data.objects.new(name + "_rig", arm_data)
    bpy.context.scene.collection.objects.link(arm)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for b in sk.bones:
        e = arm_data.edit_bones.new(b.name)
        e.head = b.head
        e.tail = b.tail
        e.use_deform = b.deform
        if b.parent:
            e.parent = eb[b.parent]
            e.use_connect = False
        eb[b.name] = e
    bpy.ops.object.mode_set(mode="OBJECT")
    mesh_obj.parent = arm
    mod = mesh_obj.modifiers.new("Armature", "ARMATURE")
    mod.object = arm
    return arm


def vertex_shade(obj, fn):
    """COLOR_0: per-vertex albedo variation (pale bone at joints and horns, darker hide)."""
    me = obj.data
    if "Col" not in me.color_attributes:
        me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="POINT")
    col = me.color_attributes["Col"]
    me.color_attributes.active_color = col
    for v in me.vertices:
        c = fn(v.co)
        col.data[v.index].color = (c[0], c[1], c[2], 1.0)


def material(name, color):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = 0.7
    attr = nt.nodes.new("ShaderNodeVertexColor")
    attr.layer_name = "Col"
    mul = nt.nodes.new("ShaderNodeMix")
    mul.data_type = "RGBA"
    mul.blend_type = "MULTIPLY"
    mul.inputs["Factor"].default_value = 1.0
    mul.inputs[6].default_value = (*color, 1)
    nt.links.new(attr.outputs["Color"], mul.inputs[7])
    nt.links.new(mul.outputs[2], bsdf.inputs["Base Color"])
    return mat


def export(objs, path):
    common.ensure_dir(os.path.dirname(path))
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_apply=False,
        export_texcoords=False,
        export_normals=True,
        export_materials="EXPORT",
        export_yup=True,
        export_skins=True,
        export_animations=False,
        export_vertex_color="ACTIVE",
        export_all_influences=False,
        export_def_bones=False,
    )


def tris_of(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def fbm(p, octaves=3):
    s = 0.0
    a = 0.5
    f = 1.0
    for _ in range(octaves):
        s += a * noise.noise(p * f)
        a *= 0.5
        f *= 2.03
    return s


# ----------------------------------------------------------------------------------------------
# The Strider (shoulder height 10; scaled up in game).


def strider_skeleton():
    sk = Skeleton()
    # Spine from the pelvis forward to the chest; the back slopes up to the shoulders.
    sk.add("root", None, (0, 2.1, 8.0), (0, 2.1, 8.6), [(0, 0.1, 0.1), (1, 0.1, 0.1)], deform=False, kind="none")
    sk.chain(["pelvis", "spine1", "spine2", "chest"], "root", [(0, 2.6, 8.15), (0, 1.5, 8.5), (0, 0.4, 8.95), (0, -0.7, 9.45), (0, -1.55, 9.85)], [
        [(0, 0.42, 0.46), (0.5, 0.58, 0.62), (1, 0.52, 0.6)],
        [(0, 0.5, 0.58), (0.5, 0.44, 0.62), (1, 0.5, 0.75)],
        [(0, 0.5, 0.75), (0.5, 0.66, 1.02), (1, 0.72, 1.12)],
        [(0, 0.72, 1.12), (0.6, 0.66, 1.05), (1, 0.5, 0.72)],
    ], kind="torso")
    sk.chain(["neck1", "neck2", "neck3", "head"], "chest", [(0, -1.55, 9.85), (0, -2.5, 10.55), (0, -3.6, 10.85), (0, -4.55, 10.35), (0, -5.15, 9.45)], [
        [(0, 0.46, 0.5), (1, 0.33, 0.35)],
        [(0, 0.33, 0.35), (1, 0.27, 0.29)],
        [(0, 0.27, 0.29), (1, 0.26, 0.27)],
        [(0, 0.27, 0.28), (0.35, 0.33, 0.35), (1, 0.22, 0.24)],
    ], kind="neck")
    sk.add("snout", "head", (0, -5.15, 9.45), (0, -5.55, 7.9), [(0, 0.2, 0.25), (0.5, 0.13, 0.17), (0.92, 0.07, 0.09), (1, 0.03, 0.03)], kind="head")
    sk.add("snout_tip", "snout", (0, -5.55, 7.9), (0, -5.6, 7.7), [(0, 0.02, 0.02), (1, 0.02, 0.02)], deform=False, kind="none")
    sk.chain(["tail1", "tail2"], "pelvis", [(0, 2.6, 8.15), (0, 3.6, 7.6), (0, 4.3, 6.6)], [[(0, 0.3, 0.32), (1, 0.14, 0.15)], [(0, 0.14, 0.15), (1, 0.03, 0.03)]], kind="tail")
    for side, s in (("L", 1), ("R", -1)):
        sh = (s * 0.72, -0.95, 9.0)
        sk.chain([f"arm_{side}", f"forearm_{side}", f"hand_{side}"], "chest", [sh, (s * 0.86, -0.55, 6.25), (s * 0.82, -1.15, 1.55), (s * 0.84, -1.3, 0.0)], [
            [(0, 0.42, 0.5), (0.4, 0.32, 0.4), (0.92, 0.2, 0.24), (1, 0.24, 0.27)],
            [(0, 0.24, 0.27), (0.08, 0.16, 0.18), (0.5, 0.12, 0.13), (0.94, 0.11, 0.12), (1, 0.17, 0.18)],
            [(0, 0.17, 0.18), (0.2, 0.1, 0.11), (0.85, 0.12, 0.14), (1, 0.27, 0.22)],
        ], kind="limb")
        sk.add(f"hand_{side}_tip", f"hand_{side}", (s * 0.84, -1.3, 0.0), (s * 0.84, -1.6, 0.0), [(0, 0.1, 0.1), (1, 0.1, 0.1)], deform=False, kind="none")
        hp = (s * 0.6, 2.3, 7.95)
        sk.chain([f"thigh_{side}", f"shin_{side}", f"foot_{side}"], "pelvis", [hp, (s * 0.72, 1.35, 5.35), (s * 0.74, 2.45, 2.15), (s * 0.76, 2.25, 0.0)], [
            [(0, 0.48, 0.55), (0.35, 0.42, 0.5), (0.9, 0.2, 0.24), (1, 0.23, 0.26)],
            [(0, 0.23, 0.26), (0.1, 0.15, 0.17), (0.5, 0.12, 0.13), (0.93, 0.12, 0.13), (1, 0.18, 0.19)],
            [(0, 0.18, 0.19), (0.2, 0.1, 0.11), (0.85, 0.12, 0.14), (1, 0.26, 0.21)],
        ], kind="limb")
        sk.add(f"foot_{side}_tip", f"foot_{side}", (s * 0.76, 2.25, 0.0), (s * 0.76, 1.95, 0.0), [(0, 0.1, 0.1), (1, 0.1, 0.1)], deform=False, kind="none")
    return sk


def strider_extras(sk, rng):
    chains = []
    # Dorsal quills: thin, swept back, irregular, longest over the shoulders; a few snapped short.
    spine = [sk.by_name[n] for n in ("pelvis", "spine1", "spine2", "chest", "neck1")]
    for bi, b in enumerate(spine):
        count = (2, 3, 4, 4, 2)[bi]
        for i in range(count):
            t = (i + 0.2 + 0.6 * rng.random()) / count
            base = b.head.lerp(b.tail, t)
            rx, ry = b.radius_at(t)
            top = base + Vector(((rng.random() - 0.5) * 0.15, 0, ry * 0.8))
            x = (bi + t) / 5.0
            length = (0.7 + 2.2 * math.sin(math.pi * min(1.0, x * 1.1)) ** 1.4) * (0.7 + 0.5 * rng.random())
            if rng.random() < 0.2:
                length *= 0.35
            d = Vector(((rng.random() - 0.5) * 0.25, 0.65 + 0.3 * rng.random(), 1.0)).normalized()
            pts = [top - Vector((0, 0, 0.15))]
            radii = [0.055]
            for j in range(1, 6):
                u = j / 5
                d2 = (d + Vector((0, 0.3 * u * u, -0.12 * u))).normalized()
                pts.append(pts[-1] + d2 * (length / 5))
                radii.append(0.05 * (1 - u) ** 1.2 + 0.004)
            chains.append((pts, radii, b.name))
    # Two swept-back horns from the cranium.
    head = sk.by_name["head"]
    crown = head.head.lerp(head.tail, 0.35)
    for s in (1, -1):
        pts = [crown + Vector((s * 0.12, 0.05, 0.22))]
        radii = [(0.09, 0.09)]
        d = Vector((s * 0.35, 0.9, 0.45)).normalized()
        for j in range(1, 7):
            u = j / 6
            d = (d + Vector((s * 0.05, 0.05, -0.18 * u))).normalized()
            pts.append(pts[-1] + d * 0.42)
            radii.append((0.085 * (1 - u) + 0.008, 0.085 * (1 - u) + 0.008))
        chains.append((pts, radii, "head"))
    return chains


def strider_anatomy(b, t, around, p, n):
    d = 0.0
    if b.kind == "torso":
        # Ribs on the chest and flanks, a sunken belly behind them, vertebrae along the top.
        ribs = 0.0
        if b.name in ("spine2", "chest"):
            u = (t + (0 if b.name == "spine2" else 1)) * 7.0
            ribs = (0.5 + 0.5 * math.cos(2 * math.pi * u)) ** 3
            side_mask = max(0.0, 1 - abs(math.sin(around)) * 1.1) ** 0.6 + max(0.0, -math.sin(around)) * 0.5
            d += 0.06 * ribs * side_mask
        dorsal = max(0.0, math.sin(around))
        vert = (0.5 + 0.5 * math.cos(2 * math.pi * t * 4)) ** 4
        d += 0.05 * vert * dorsal ** 8
        if b.name == "spine1":
            d -= 0.05 * max(0.0, -math.sin(around))
    elif b.kind == "limb":
        # Tendons down the back of the shanks and knuckled joints.
        knob = math.exp(-((t - 1) / 0.05) ** 2) + math.exp(-(t / 0.05) ** 2)
        d += 0.03 * knob
        tendon = math.exp(-((around - math.pi * 0.5) / 0.35) ** 2)
        d += 0.012 * tendon * (1 - knob)
    elif b.kind in ("neck",):
        ring = (0.5 + 0.5 * math.cos(2 * math.pi * t * 3)) ** 3
        d += 0.018 * ring
    elif b.kind == "head":
        brow = math.exp(-((t - 0.1) / 0.08) ** 2) * max(0.0, math.cos(around))
        d += 0.03 * brow
    d += 0.012 * fbm(p * 2.2) + 0.006 * noise.noise(p * 9.0)
    return d


# ----------------------------------------------------------------------------------------------
# The Hollow (nine metres tall).


def hollow_skeleton():
    sk = Skeleton()
    sk.add("root", None, (0, 0, 4.5), (0, 0, 4.8), [(0, 0.1, 0.1), (1, 0.1, 0.1)], deform=False, kind="none")
    sk.chain(["pelvis", "spine1", "chest", "neck"], "root", [(0, 0.05, 4.2), (0, 0.0, 5.2), (0, -0.25, 6.05), (0, -0.62, 7.15), (0, -0.98, 7.75)], [
        [(0, 0.3, 0.2), (0.5, 0.33, 0.22), (1, 0.22, 0.17)],
        [(0, 0.22, 0.17), (0.5, 0.19, 0.15), (1, 0.3, 0.24)],
        [(0, 0.3, 0.24), (0.45, 0.42, 0.3), (0.85, 0.44, 0.27), (1, 0.3, 0.2)],
        [(0, 0.16, 0.16), (1, 0.1, 0.11)],
    ], kind="torso")
    sk.add("head", "neck", (0, -0.98, 7.75), (0, -1.2, 8.55), [(0, 0.11, 0.12), (0.3, 0.16, 0.2), (0.7, 0.15, 0.19), (1, 0.08, 0.09)], kind="head")
    sk.add("head_tip", "head", (0, -1.2, 8.55), (0, -1.25, 8.75), [(0, 0.05, 0.05), (1, 0.05, 0.05)], deform=False, kind="none")
    for side, s in (("L", 1), ("R", -1)):
        sk.chain([f"thigh_{side}", f"shin_{side}", f"foot_{side}"], "pelvis", [(s * 0.22, 0.05, 4.45), (s * 0.3, -0.32, 2.45), (s * 0.28, 0.12, 0.32), (s * 0.29, -0.55, 0.04)], [
            [(0, 0.19, 0.2), (0.3, 0.17, 0.18), (0.9, 0.09, 0.1), (1, 0.11, 0.11)],
            [(0, 0.11, 0.11), (0.1, 0.075, 0.08), (0.3, 0.085, 0.1), (0.92, 0.05, 0.055), (1, 0.07, 0.07)],
            [(0, 0.07, 0.07), (0.4, 0.06, 0.04), (1, 0.03, 0.02)],
        ], kind="limb")
        sk.add(f"foot_{side}_tip", f"foot_{side}", (s * 0.29, -0.55, 0.04), (s * 0.29, -0.7, 0.04), [(0, 0.02, 0.02), (1, 0.02, 0.02)], deform=False, kind="none")
        sk.chain([f"clavicle_{side}", f"arm_{side}", f"forearm_{side}", f"hand_{side}"], "chest", [(s * 0.08, -0.55, 7.05), (s * 0.52, -0.62, 7.0), (s * 0.66, -0.5, 5.1), (s * 0.62, -0.68, 2.95), (s * 0.6, -0.74, 2.55)], [
            [(0, 0.1, 0.09), (1, 0.12, 0.11)],
            [(0, 0.12, 0.11), (0.3, 0.1, 0.1), (0.92, 0.05, 0.055), (1, 0.07, 0.07)],
            [(0, 0.07, 0.07), (0.1, 0.05, 0.05), (0.4, 0.06, 0.055), (0.94, 0.035, 0.035), (1, 0.045, 0.04)],
            [(0, 0.05, 0.035), (0.6, 0.06, 0.03), (1, 0.05, 0.03)],
        ], kind="limb")
        # Three long fingers.
        for fi, (dx, dy) in enumerate(((0.06, -0.06), (0.0, 0.0), (-0.06, 0.06))):
            base = Vector((s * 0.6, -0.74, 2.55))
            tip = base + Vector((s * dx * 1.5, dy * 1.5 - 0.1, -0.85 - 0.1 * (fi == 1)))
            mid = base.lerp(tip, 0.5) + Vector((0, -0.08, 0))
            sk.chain([f"finger{fi}_{side}", f"finger{fi}b_{side}"], f"hand_{side}", [base, mid, tip], [[(0, 0.03, 0.025), (0.9, 0.018, 0.016), (1, 0.022, 0.02)], [(0, 0.02, 0.018), (1, 0.004, 0.004)]], kind="finger")
    return sk


def hollow_extras(sk, rng):
    """Antlers: dead branches growing from the crown, forking twice."""
    chains = []
    head = sk.by_name["head"]
    crown = head.head.lerp(head.tail, 0.8)

    def grow(start, d, length, r, depth):
        pts = [start]
        radii = [(r, r)]
        steps = 4
        for j in range(1, steps + 1):
            u = j / steps
            q = pts[-1] * 1.9
            d = (d + Vector((noise.noise(q) * 0.25, noise.noise(q + Vector((3, 1, 2))) * 0.25, 0.06))).normalized()
            pts.append(pts[-1] + d * (length / steps))
            rr = r * (1 - 0.75 * u) + 0.003
            radii.append((rr, rr))
        chains.append((pts, radii, "head"))
        if depth > 0:
            for k in range(2):
                base = pts[2 + k]
                ang = (0.55 + rng.random() * 0.4) * (1 if k == 0 else -1)
                nd = (d + Matrix.Rotation(ang, 3, "Y") @ Vector((0.6, 0, 0)) * (1 if d.x >= 0 else -1)).normalized()
                nd = (nd + Vector((0, (rng.random() - 0.5) * 0.6, 0.2))).normalized()
                grow(base, nd, length * 0.6, r * 0.55, depth - 1)

    for s in (1, -1):
        grow(crown + Vector((s * 0.09, 0.02, 0.05)), Vector((s * 0.6, 0.25, 0.75)).normalized(), 1.5, 0.055, 2)
    # Three long fingers per hand, jointed (they follow the finger bones).
    for b in sk.bones:
        if b.kind == "finger" and not b.name.startswith(("finger0b", "finger1b", "finger2b")):
            nxt = sk.by_name[b.name.replace("finger0_", "finger0b_").replace("finger1_", "finger1b_").replace("finger2_", "finger2b_")]
            pts = [b.head + (b.head - b.tail).normalized() * 0.05] + [b.head.lerp(b.tail, u) for u in (0.33, 0.66, 1.0)] + [nxt.head.lerp(nxt.tail, u) for u in (0.33, 0.66, 1.0)]
            rs = [0.03, 0.028, 0.022, 0.02, 0.016, 0.01, 0.003]
            chains.append((pts, rs, b.name))
    # Bony spurs on the elbows.
    for side, s in (("L", 1), ("R", -1)):
        el = sk.by_name[f"forearm_{side}"].head
        pts = [el + Vector((0, 0.04, 0)), el + Vector((s * 0.04, 0.22, 0.12)), el + Vector((s * 0.06, 0.42, 0.3))]
        chains.append((pts, [(0.035, 0.035), (0.02, 0.02), (0.004, 0.004)], f"arm_{side}"))
    return chains


def hollow_anatomy(b, t, around, p, n):
    d = 0.0
    if b.name == "chest":
        u = t * 6.5
        ribs = (0.5 + 0.5 * math.cos(2 * math.pi * u)) ** 3
        front = max(0.0, -math.sin(around)) + 0.6 * abs(math.cos(around))
        d += 0.02 * ribs * min(1.0, front) * (1 - math.exp(-((t - 1) / 0.12) ** 2))
    if b.kind == "torso":
        dorsal = max(0.0, math.sin(around))
        vert = (0.5 + 0.5 * math.cos(2 * math.pi * t * 5)) ** 4
        d += 0.022 * vert * dorsal ** 10
    if b.kind == "limb":
        knob = math.exp(-((t - 1) / 0.06) ** 2) + math.exp(-(t / 0.06) ** 2)
        d += 0.008 * knob
    d += 0.004 * fbm(p * 5.0) + 0.002 * noise.noise(p * 18.0)
    return d


# ----------------------------------------------------------------------------------------------
# The Colossus (height 30; scaled up in game).


def colossus_skeleton():
    sk = Skeleton()
    sk.add("root", None, (0, 4, 19), (0, 4, 20), [(0, 0.1, 0.1), (1, 0.1, 0.1)], deform=False, kind="none")
    sk.chain(["pelvis", "spine1", "spine2", "chest"], "root", [(0, 7.5, 18.5), (0, 3.5, 23.5), (0, -1.5, 25.5), (0, -6.0, 23.0), (0, -9.0, 19.0)], [
        [(0, 4.0, 4.2), (1, 4.8, 5.2)],
        [(0, 4.8, 5.2), (0.5, 5.6, 6.2), (1, 5.8, 6.3)],
        [(0, 5.8, 6.3), (0.5, 5.6, 6.0), (1, 5.0, 5.4)],
        [(0, 5.0, 5.4), (1, 3.6, 4.0)],
    ], kind="torso")
    sk.chain(["neck1", "head"], "chest", [(0, -9.0, 19.0), (0, -12.5, 15.5), (0, -15.5, 13.0)], [[(0, 2.6, 3.0), (1, 1.8, 2.0)], [(0, 1.8, 2.0), (0.4, 2.0, 2.2), (1, 0.8, 0.9)]], kind="neck")
    sk.add("head_tip", "head", (0, -15.5, 13.0), (0, -16.2, 12.2), [(0, 0.5, 0.5), (1, 0.5, 0.5)], deform=False, kind="none")
    for side, s in (("L", 1), ("R", -1)):
        sk.chain([f"arm_{side}", f"forearm_{side}", f"hand_{side}"], "chest", [(s * 3.6, -6.8, 21.0), (s * 4.6, -7.8, 12.0), (s * 4.4, -6.8, 3.0), (s * 4.5, -7.6, 0.0)], [
            [(0, 3.0, 3.2), (1, 2.0, 2.2)], [(0, 2.0, 2.2), (0.5, 1.6, 1.7), (1, 1.7, 1.8)], [(0, 1.7, 1.8), (1, 2.4, 2.2)]], kind="limb")
        sk.add(f"hand_{side}_tip", f"hand_{side}", (s * 4.5, -7.6, 0.0), (s * 4.5, -9.0, 0.0), [(0, 0.5, 0.5), (1, 0.5, 0.5)], deform=False, kind="none")
        sk.chain([f"thigh_{side}", f"shin_{side}", f"foot_{side}"], "pelvis", [(s * 3.0, 8.0, 19.0), (s * 3.8, 5.5, 10.0), (s * 3.9, 8.0, 2.8), (s * 4.0, 7.2, 0.0)], [
            [(0, 3.4, 3.6), (1, 2.0, 2.2)], [(0, 2.0, 2.2), (0.5, 1.5, 1.6), (1, 1.6, 1.7)], [(0, 1.6, 1.7), (1, 2.2, 2.0)]], kind="limb")
        sk.add(f"foot_{side}_tip", f"foot_{side}", (s * 4.0, 7.2, 0.0), (s * 4.0, 5.8, 0.0), [(0, 0.5, 0.5), (1, 0.5, 0.5)], deform=False, kind="none")
    return sk


def colossus_extras(sk, rng):
    chains = []
    for b in [sk.by_name[n] for n in ("pelvis", "spine1", "spine2", "chest", "neck1")]:
        for i in range(7):
            t = rng.random()
            base = b.head.lerp(b.tail, t)
            rx, ry = b.radius_at(t)
            a = (rng.random() - 0.5) * 1.6
            out = Vector((math.sin(a) * rx * 0.9, 0, math.cos(a) * ry * 0.92))
            start = base + out * 0.9
            length = 3.0 + rng.random() * 6.5
            d = (out.normalized() + Vector(((rng.random() - 0.5) * 0.4, 0.3 + rng.random() * 0.3, 0.6))).normalized()
            pts = [start]
            radii = [(0.8, 0.8)]
            for j in range(1, 4):
                u = j / 3
                pts.append(pts[-1] + d * (length / 3) + Vector(((rng.random() - 0.5) * 0.4, (rng.random() - 0.5) * 0.4, 0)))
                rr = 0.8 * (1 - u) * (0.7 + 0.3 * rng.random()) + 0.06
                radii.append((rr, rr))
            chains.append((pts, radii, b.name))
    return chains


def colossus_anatomy(b, t, around, p, n):
    d = 0.35 * fbm(p * 0.18, 4) + 0.12 * noise.noise(p * 0.9)
    if b.kind == "torso":
        d += 0.4 * max(0.0, math.sin(around)) * (0.5 + 0.5 * noise.noise(p * 0.35))
    return d


# ----------------------------------------------------------------------------------------------
# The fog ray (wingspan 5 m): a parametric surface, no skeleton.


def make_ray():
    bm = bmesh.new()
    span = 2.5
    nu, nv = 28, 14
    rows = []
    for i in range(nu + 1):
        x = -span + 2 * span * i / nu
        ax = abs(x) / span
        # Planform: a diamond with a swept leading edge and a scalloped trailing edge.
        sweep = 0.45 * ax ** 2.2
        lead = -1.12 + 1.02 * ax ** 1.45 + sweep - 0.16 * math.exp(-(x / 0.22) ** 2)
        trail = 0.92 - 0.62 * ax ** 0.9 + sweep + 0.07 * math.sin(ax * math.pi * 6) * ax * (1 - ax) * 3
        ring = []
        for j in range(nv + 1):
            v = j / nv
            y = lead + (trail - lead) * v
            # Thickness: a fleshy body near the centre line, thin membranes out to the tips.
            body = math.exp(-(x / 0.42) ** 2) * (0.22 * math.sin(math.pi * v) ** 0.7)
            th = 0.015 + body + 0.03 * (1 - ax) * math.sin(math.pi * v)
            camber = 0.08 * (1 - ax) * math.sin(math.pi * v) - 0.12 * ax ** 2
            ring.append((x, y, camber, th))
        rows.append(ring)
    top = [[bm.verts.new((x, y, z + th * 0.5)) for (x, y, z, th) in row] for row in rows]
    bot = [[bm.verts.new((x, y, z - th * 0.5)) for (x, y, z, th) in row] for row in rows]
    for i in range(nu):
        for j in range(nv):
            bm.faces.new((top[i][j], top[i + 1][j], top[i + 1][j + 1], top[i][j + 1]))
            bm.faces.new((bot[i][j + 1], bot[i + 1][j + 1], bot[i + 1][j], bot[i][j]))
    for i in range(nu):
        for row_j in (0, nv):
            a, b2, c, d = top[i][row_j], top[i + 1][row_j], bot[i + 1][row_j], bot[i][row_j]
            if row_j == 0:
                bm.faces.new((a, d, c, b2))
            else:
                bm.faces.new((a, b2, c, d))
    for (i, j_range) in ((0, range(nv)), (nu, range(nv))):
        for j in j_range:
            a, b2, c, d = top[i][j], top[i][j + 1], bot[i][j + 1], bot[i][j]
            if i == 0:
                bm.faces.new((a, b2, c, d))
            else:
                bm.faces.new((a, d, c, b2))
    # Whip tail from the trailing centre.
    tail_pts = [Vector((0, 0.85 + 0.35 * k, 0.02 - 0.01 * k)) for k in range(10)]
    prev = None
    for k, c in enumerate(tail_pts):
        r = 0.05 * (1 - k / 10) + 0.006
        ring = [bm.verts.new(c + Vector((math.cos(a) * r, 0, math.sin(a) * r))) for a in [2 * math.pi * q / 6 for q in range(6)]]
        if prev:
            for q in range(6):
                bm.faces.new((prev[q], prev[(q + 1) % 6], ring[(q + 1) % 6], ring[q]))
        prev = ring
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new("ray")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("ray", me)
    bpy.context.scene.collection.objects.link(obj)
    for poly in me.polygons:
        poly.use_smooth = True
    return obj


# ----------------------------------------------------------------------------------------------


def build_creature(name, sk, extras, anatomy, target, shade, color, seed, step, voxel, extra_sides=7):
    hull = build_hull(name, sk, step=step, voxel=voxel)
    displace(hull, sk, anatomy, seed)
    decimate(hull, target)
    tubes = [tube_object(f"{name}_x{i}", pts, rs, extra_sides) for i, (pts, rs, _bone) in enumerate(extras)]
    if tubes:
        hull = join([hull] + tubes, name)
    tris = tris_of(hull)
    vertex_shade(hull, shade)
    hull.data.materials.append(material(name + "_hide", color))
    weight(hull, sk)
    rig = armature(name, sk, hull)
    return hull, rig, tris


def preview(objs, path, cam_loc, target, lens=40):
    import mathutils
    scene = bpy.context.scene
    for o in scene.objects:
        o.hide_render = o not in objs and o.type == "MESH"
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    scene.render.resolution_x, scene.render.resolution_y = 1400, 900
    world = bpy.data.worlds.get("VeilPreview") or bpy.data.worlds.new("VeilPreview")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.5, 0.53, 0.58, 1)
    scene.world = world
    cam = bpy.data.objects.get("VeilCam")
    if cam is None:
        cam = bpy.data.objects.new("VeilCam", bpy.data.cameras.new("VeilCam"))
        scene.collection.objects.link(cam)
        sun = bpy.data.objects.new("VeilSun", bpy.data.lights.new("VeilSun", "SUN"))
        sun.data.energy = 3.5
        sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
        scene.collection.objects.link(sun)
    cam.data.lens = lens
    cam.data.clip_end = 3000
    cam.location = cam_loc
    cam.rotation_euler = mathutils.Vector([t - c for t, c in zip(target, cam_loc)]).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)


def main():
    no_preview = "--no-preview" in common.args()
    only = [a for a in common.args() if not a.startswith("--")]
    common.reset_scene()
    rng = random.Random(3)
    report = {}

    def pale_bone(base, pale, joints):
        def fn(p):
            c = list(base)
            w = 0.0
            for (q, r) in joints:
                w = max(w, math.exp(-((p - Vector(q)).length / r) ** 2))
            n = 0.5 + 0.5 * noise.noise(p * 1.7)
            return [c[i] * (0.85 + 0.3 * n) * (1 - w) + pale[i] * w for i in range(3)]
        return fn

    built = {}
    if not only or "strider" in only:
        sk = strider_skeleton()
        joints = [(b.tail, 0.22) for b in sk.bones if b.kind == "limb"] + [((0, -5.4, 8.6), 0.6)]
        hull, rig, tris = build_creature("strider", sk, strider_extras(sk, rng), strider_anatomy, 24000, pale_bone((0.32, 0.3, 0.29), (0.62, 0.6, 0.56), joints), (0.3, 0.29, 0.28), 1, 0.25, 0.035)
        built["strider"] = (hull, rig, sk)
        report["strider"] = {"triangles": tris, "bones": len(sk.bones), "height": 10.9}
    if not only or "hollow" in only:
        sk = hollow_skeleton()
        joints = [(b.tail, 0.08) for b in sk.bones if b.kind == "limb"]
        hull, rig, tris = build_creature("hollow", sk, hollow_extras(sk, rng), hollow_anatomy, 16000, pale_bone((0.27, 0.26, 0.25), (0.5, 0.48, 0.45), joints), (0.27, 0.26, 0.25), 2, 0.1, 0.018)
        built["hollow"] = (hull, rig, sk)
        report["hollow"] = {"triangles": tris, "bones": len(sk.bones), "height": 9.8}
    if not only or "colossus" in only:
        sk = colossus_skeleton()
        hull, rig, tris = build_creature("colossus", sk, colossus_extras(sk, rng), colossus_anatomy, 20000, pale_bone((0.3, 0.29, 0.28), (0.4, 0.39, 0.37), []), (0.3, 0.29, 0.28), 3, 1.0, 0.16, 8)
        built["colossus"] = (hull, rig, sk)
        report["colossus"] = {"triangles": tris, "bones": len(sk.bones), "height": 32}
    if not only or "ray" in only:
        ray = make_ray()
        ray.data.materials.append(material("ray_hide", (0.3, 0.3, 0.32)))
        vertex_shade(ray, lambda p: (0.8 + 0.2 * noise.noise(p * 3), 0.8 + 0.2 * noise.noise(p * 3), 0.85))
        built["ray"] = (ray, None, None)
        report["ray"] = {"triangles": tris_of(ray), "wingspan": 5.0}
    for name, (hull, rig, sk) in built.items():
        objs = [hull] + ([rig] if rig else [])
        export(objs, os.path.join(OUT_DIR, f"{name}.glb"))
    common.save_blend(SRC)
    common.write_metadata(os.path.join(OUT_DIR, "veil_creatures.meta.json"), {"generator": "assets/blender/scripts/veil_creatures.py", "license": "Original work for Prismfall", "creatures": report})
    if not no_preview:
        if "strider" in built:
            preview([built["strider"][0]], os.path.join(PREVIEW_DIR, "veil_strider.png"), (16, -12, 7), (0, 0, 5.5), 35)
        if "hollow" in built:
            preview([built["hollow"][0]], os.path.join(PREVIEW_DIR, "veil_hollow.png"), (11, -15, 5.5), (0, 0, 4.9), 35)
        if "colossus" in built:
            preview([built["colossus"][0]], os.path.join(PREVIEW_DIR, "veil_colossus.png"), (55, -50, 25), (0, 0, 15), 35)
        if "ray" in built:
            preview([built["ray"][0]], os.path.join(PREVIEW_DIR, "veil_ray.png"), (3.5, -4.5, 3.5), (0, 0.4, 0), 40)
    print("VEIL_CREATURES_OK", report)


main()
