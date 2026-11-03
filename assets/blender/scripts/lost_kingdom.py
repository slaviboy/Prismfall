"""The Lost Kingdom: an original Classic Maya ceremonial centre reclaimed by rainforest (Blender 5.x, headless).

    blender -b --factory-startup --python-exit-code 1 --python assets/blender/scripts/lost_kingdom.py -- \
        [--preview out.png] [--bake] [--samples 64] [--scale 0.5]

Builds every static piece of the world in game coordinates (Blender X = game x, Blender Y = -game z,
Blender Z = game y; the player's eye is at game (0, 1, 30), the plaza floor at y = -13):

- the Great Pyramid (left of the board): nine stepped terraces with Peten-style apron mouldings and
  inset corners, a steep projecting central stairway, a summit platform and temple with a corbel-arched
  doorway, a medial moulding, a sloping upper facade and a two-tier roof comb; eroded block faces,
  missing facing stones, a slumped corner and a broken stair foot with rubble;
- the escarpment (right of the board): a fluted karst limestone cliff with a masonry spillway that the
  waterfall pours from, a stone-lined pool at its foot and a small ruined temple on its rim;
- the North Platform behind the board, with a stair and two small temples, and a row of stelae and drum
  altars in front of it (glyph panels are original, generic cartouche grids, not copies of monuments);
- the plaza floor (lime-plaster remnants, flagstones, leaf litter, moss), fallen blocks and a broken stela;
- a strangler fig whose roots grip the pyramid's upper terraces, and a buttressed ceiba at the left edge.

Materials are the photographed Poly Haven textures (CC0) in assets/external/polyhaven/<id>/, mixed in
the shader with moss (on top faces and in crevices), rain streaks and stucco remnants. Lighting is the
rainforest_trail HDR (the same photograph as the sky) plus a sun dappled by a canopy mask, which the game
shares (textures/canopy_dapple.webp) so plants and animals receive the same sun patches.

--bake writes, per object group, an RGBA texture (RGB albedo, A direct sun) and an RGB texture (sky and
bounced light), then exports assets/blender/exports/lost_kingdom/*.glb with those textures embedded.
"""
import json
import math
import os
import random
import sys

import bpy
import bmesh
import numpy as np
from mathutils import Matrix, Vector, noise
from mathutils.bvhtree import BVHTree

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402

ROOT = common.ROOT
TEX = os.path.join(ROOT, "assets", "external", "polyhaven")
OUT = os.path.join(ROOT, "assets", "blender", "exports", "lost_kingdom")
SRC = os.path.join(ROOT, "assets", "blender", "source", "environments", "lost-kingdom.blend")
HDR = os.path.join(TEX, "rainforest_trail", "rainforest_trail_4k.hdr")

PLAZA = -13.0
EYE = Vector((0.0, -30.0, 1.0))
# The panorama's turn that faces the board (sky panorama `offset`).
PANO_OFFSET = 0.58
# Towards the sun (Blender axes): game azimuth 66.6 deg (the photograph's sun), elevation 52 deg.
# Towards the sun: from behind the player and high, so the faces the player sees (the stair, the
# pyramid flank, the outcrop and the palace) all take sun through the gaps.
SUN_AZ, SUN_EL = 180.0, 52.0
SUN = Vector((math.sin(math.radians(SUN_AZ)) * math.cos(math.radians(SUN_EL)), math.cos(math.radians(SUN_AZ)) * math.cos(math.radians(SUN_EL)), math.sin(math.radians(SUN_EL)))).normalized()
SUN_STRENGTH = 13.0
ENV_STRENGTH = 0.55
# Canopy mask: a horizontal plane at CANOPY_Z covering CANOPY_RECT (x0, y0, x1, y1) in Blender metres.
CANOPY_Z = 42.0
CANOPY_RECT = (-180.0, -120.0, 220.0, 280.0)
CANOPY_RES = 2048

rng = random.Random(1187)


def arg(name, default=None):
    a = common.args()
    if name in a:
        i = a.index(name)
        return a[i + 1] if i + 1 < len(a) and not a[i + 1].startswith("--") else True
    return default


# ---------------------------------------------------------------------------------------------
# Materials
# ---------------------------------------------------------------------------------------------


def tex_path(tid, kind):
    return os.path.join(TEX, tid, f"{tid}_{kind}_2k.jpg")


_images = {}


def image(path, colour=True):
    if path in _images:
        return _images[path]
    img = bpy.data.images.load(path, check_existing=True)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    _images[path] = img
    return img


class NodeBuilder:
    def __init__(self, mat):
        self.mat = mat
        mat.use_nodes = True
        self.nt = mat.node_tree
        for n in list(self.nt.nodes):
            self.nt.nodes.remove(n)
        self.x = -2000

    def node(self, kind, **props):
        n = self.nt.nodes.new(kind)
        n.location = (self.x, rng.uniform(-400, 400))
        self.x += 60
        for k, v in props.items():
            setattr(n, k, v)
        return n

    def link(self, a, b):
        self.nt.links.new(a, b)

    def value(self, v):
        n = self.node("ShaderNodeValue")
        n.outputs[0].default_value = v
        return n.outputs[0]

    def math(self, op, a, b=None, clamp=False):
        n = self.node("ShaderNodeMath", operation=op, use_clamp=clamp)
        for i, v in enumerate((a, b)):
            if v is None:
                continue
            if isinstance(v, (int, float)):
                n.inputs[i].default_value = v
            else:
                self.link(v, n.inputs[i])
        return n.outputs[0]

    def mix(self, fac, a, b, blend="MIX"):
        n = self.node("ShaderNodeMix", data_type="RGBA", blend_type=blend, clamp_factor=True)
        for sock, v in ((n.inputs[0], fac), (n.inputs[6], a), (n.inputs[7], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            elif isinstance(v, tuple):
                sock.default_value = v
            else:
                self.link(v, sock)
        return n.outputs[2]

    def mixf(self, fac, a, b):
        n = self.node("ShaderNodeMix", data_type="FLOAT", clamp_factor=True)
        for sock, v in ((n.inputs[0], fac), (n.inputs[2], a), (n.inputs[3], b)):
            if isinstance(v, (int, float)):
                sock.default_value = v
            else:
                self.link(v, sock)
        return n.outputs[0]

    def map_range(self, v, a, b, c=0.0, d=1.0, smooth=True):
        n = self.node("ShaderNodeMapRange", interpolation_type="SMOOTHSTEP" if smooth else "LINEAR", clamp=True)
        self.link(v, n.inputs["Value"])
        n.inputs["From Min"].default_value = a
        n.inputs["From Max"].default_value = b
        n.inputs["To Min"].default_value = c
        n.inputs["To Max"].default_value = d
        return n.outputs[0]

    def coords(self, scale):
        tc = self.node("ShaderNodeTexCoord")
        mp = self.node("ShaderNodeMapping")
        mp.inputs["Scale"].default_value = (1 / scale, 1 / scale, 1 / scale)
        self.link(tc.outputs["Object"], mp.inputs["Vector"])
        return mp.outputs[0]

    def box(self, path, vec, colour=True, blend=0.3):
        n = self.node("ShaderNodeTexImage", projection="BOX", projection_blend=blend, interpolation="Cubic")
        n.image = image(path, colour)
        self.link(vec, n.inputs["Vector"])
        return n

    def noise(self, vec, scale, detail=4.0, rough=0.55, distort=0.0):
        n = self.node("ShaderNodeTexNoise")
        self.link(vec, n.inputs["Vector"])
        n.inputs["Scale"].default_value = scale
        n.inputs["Detail"].default_value = detail
        n.inputs["Roughness"].default_value = rough
        n.inputs["Distortion"].default_value = distort
        return n

    def attr(self, name):
        n = self.node("ShaderNodeVertexColor", layer_name=name)
        return n.outputs["Color"]

    def geometry(self):
        return self.node("ShaderNodeNewGeometry")

    def ao(self, distance, local=True):
        n = self.node("ShaderNodeAmbientOcclusion", only_local=local, samples=12)
        n.inputs["Distance"].default_value = distance
        return n.outputs["AO"]


def pbr_layer(nb, tid, scale, vec=None):
    """Box-projected photo texture: (colour, height, roughness, ao) outputs at `scale` metres per tile."""
    vec = vec or nb.coords(scale)
    col = nb.box(tex_path(tid, "diffuse"), vec)
    arm = nb.box(tex_path(tid, "arm"), vec, colour=False)
    sep = nb.node("ShaderNodeSeparateColor")
    nb.link(arm.outputs["Color"], sep.inputs["Color"])
    disp_path = tex_path(tid, "disp")
    height = nb.box(disp_path, vec, colour=False).outputs["Color"] if os.path.exists(disp_path) else None
    return {"color": col.outputs["Color"], "ao": sep.outputs[0], "rough": sep.outputs[1], "height": height}


def finish(nb, color, rough, height, bump_strength=0.6, bump_distance=0.04, emission=None):
    bsdf = nb.node("ShaderNodeBsdfPrincipled")
    nb.link(color, bsdf.inputs["Base Color"])
    if isinstance(rough, (int, float)):
        bsdf.inputs["Roughness"].default_value = rough
    else:
        nb.link(rough, bsdf.inputs["Roughness"])
    bsdf.inputs["Specular IOR Level"].default_value = 0.35
    if height is not None:
        bump = nb.node("ShaderNodeBump")
        bump.inputs["Strength"].default_value = bump_strength
        bump.inputs["Distance"].default_value = bump_distance
        nb.link(height, bump.inputs["Height"])
        nb.link(bump.outputs["Normal"], bsdf.inputs["Normal"])
    out = nb.node("ShaderNodeOutputMaterial")
    nb.link(bsdf.outputs["BSDF"], out.inputs["Surface"])
    return bsdf


def moss_mask(nb, strength=1.0, up_bias=0.55):
    """Moss on upward faces and in crevices, broken up by noise; vertex attribute 'moss' adds more."""
    geo = nb.geometry()
    sepn = nb.node("ShaderNodeSeparateXYZ")
    nb.link(geo.outputs["Normal"], sepn.inputs["Vector"])
    up = nb.map_range(sepn.outputs["Z"], up_bias, 0.95)
    cav = nb.math("SUBTRACT", 1.0, nb.ao(0.35))
    cav = nb.map_range(cav, 0.12, 0.6)
    n1 = nb.noise(nb.coords(1.0), 0.45, 6, 0.6, 0.3).outputs["Fac"]
    n2 = nb.noise(nb.coords(1.0), 3.2, 4, 0.6).outputs["Fac"]
    patch = nb.map_range(nb.math("ADD", nb.math("MULTIPLY", n1, 0.75), nb.math("MULTIPLY", n2, 0.25)), 0.42, 0.62)
    painted = nb.node("ShaderNodeSeparateColor")
    nb.link(nb.attr("moss"), painted.inputs["Color"])
    base = nb.math("MAXIMUM", nb.math("MULTIPLY", up, 0.9), nb.math("MULTIPLY", cav, 0.75))
    m = nb.math("MULTIPLY", base, patch)
    m = nb.math("MAXIMUM", m, nb.math("MULTIPLY", painted.outputs[0], nb.map_range(n2, 0.3, 0.55)))
    return nb.math("MULTIPLY", m, strength, clamp=True)


def moss_colour(nb):
    """Photographed leaf-litter moss tinted to living moss, with yellow-green variation."""
    vec = nb.coords(1.6)
    leaves = nb.box(tex_path("forest_leaves_02", "diffuse"), vec).outputs["Color"]
    var = nb.noise(nb.coords(1.0), 1.7, 3).outputs["Fac"]
    green = nb.mix(nb.map_range(var, 0.35, 0.7), (0.075, 0.11, 0.025, 1), (0.16, 0.19, 0.045, 1))
    hsv = nb.node("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = 0.6
    hsv.inputs["Value"].default_value = 1.0
    nb.link(leaves, hsv.inputs["Color"])
    return nb.mix(0.6, hsv.outputs["Color"], green)


def streaks(nb):
    """Rain run-off: long vertical dark streaks on steep faces, strongest under ledges."""
    tc = nb.node("ShaderNodeTexCoord")
    mp = nb.node("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = (2.2, 2.2, 0.12)
    nb.link(tc.outputs["Object"], mp.inputs["Vector"])
    n = nb.noise(mp.outputs[0], 2.0, 5, 0.62).outputs["Fac"]
    geo = nb.geometry()
    sepn = nb.node("ShaderNodeSeparateXYZ")
    nb.link(geo.outputs["Normal"], sepn.inputs["Vector"])
    steep = nb.map_range(nb.math("ABSOLUTE", sepn.outputs["Z"]), 0.55, 0.15)
    return nb.math("MULTIPLY", nb.map_range(n, 0.5, 0.72), steep)


def limestone_material(name, stucco=0.35, moss=1.0, tint=(1.0, 1.0, 1.0)):
    """Cut limestone facing blocks with rubble core where damaged, stucco remnants, moss and streaks."""
    mat = bpy.data.materials.new(name)
    nb = NodeBuilder(mat)
    blocks = pbr_layer(nb, "mossy_sandstone", 1.7)
    rubble = pbr_layer(nb, "castle_wall_varriation", 2.4)
    plaster = pbr_layer(nb, "worn_mossy_plasterwall", 2.2)
    dmg = nb.node("ShaderNodeSeparateColor")
    nb.link(nb.attr("damage"), dmg.inputs["Color"])
    damage = nb.map_range(dmg.outputs[0], 0.2, 0.7)
    # Limestone: the photo's block pattern as detail over a large-scale colour field, from pale
    # cream-grey stone to warm grey, with broad dark patina (lichen and biofilm) on the walls.
    bw = nb.node("ShaderNodeRGBToBW")
    nb.link(blocks["color"], bw.inputs["Color"])
    detail = nb.math("POWER", nb.math("DIVIDE", bw.outputs[0], 0.33), 1.15)
    big = nb.noise(nb.coords(1.0), 0.13, 4, 0.55, 0.4).outputs["Fac"]
    field = nb.mix(nb.map_range(big, 0.35, 0.68), (0.47, 0.44, 0.37, 1), (0.66, 0.64, 0.58, 1))
    pat = nb.noise(nb.coords(1.0), 0.07, 5, 0.6, 0.6).outputs["Fac"]
    pdirt = nb.node("ShaderNodeSeparateColor")
    nb.link(nb.attr("patina"), pdirt.inputs["Color"])
    patina = nb.math("MULTIPLY", nb.map_range(pat, 0.38, 0.62), nb.math("ADD", 0.35, nb.math("MULTIPLY", pdirt.outputs[0], 0.8)), clamp=True)
    field = nb.mix(nb.math("MULTIPLY", patina, 0.78), field, (0.13, 0.135, 0.10, 1))
    dcol = nb.node("ShaderNodeCombineColor")
    for i in range(3):
        nb.link(detail, dcol.inputs[i])
    lime = nb.mix(1.0, field, dcol.outputs["Color"], "MULTIPLY")
    # A trace of the photo's own colour keeps the mineral variation.
    lime = nb.mix(0.18, lime, blocks["color"])
    stone = nb.mix(damage, lime, rubble["color"])
    # Stucco survives in sheltered patches (under mouldings, low on walls), broken up by noise.
    sn = nb.noise(nb.coords(1.0), 0.6, 5, 0.65).outputs["Fac"]
    st = nb.math("MULTIPLY", nb.map_range(sn, 0.58, 0.66), stucco)
    st = nb.math("MULTIPLY", st, nb.math("SUBTRACT", 1.0, damage))
    stone = nb.mix(st, stone, plaster["color"])
    stone = nb.mix(1.0, stone, (*tint, 1.0), "MULTIPLY")
    # Crevice darkening from the photo's AO.
    aoc = nb.node("ShaderNodeCombineColor")
    for i in range(3):
        nb.link(nb.mixf(damage, blocks["ao"], rubble["ao"]), aoc.inputs[i])
    stone = nb.mix(0.85, stone, aoc.outputs["Color"], "MULTIPLY")
    # Biofilm streaks (black-brown) and moss; level surfaces carry soil and leaf litter under the moss.
    stone = nb.mix(nb.math("MULTIPLY", streaks(nb), 0.85), stone, (0.05, 0.05, 0.035, 1))
    geo = nb.geometry()
    sepn = nb.node("ShaderNodeSeparateXYZ")
    nb.link(geo.outputs["Normal"], sepn.inputs["Vector"])
    flat = nb.map_range(sepn.outputs["Z"], 0.8, 0.97)
    soil = nb.box(tex_path("brown_mud_leaves_01", "diffuse"), nb.coords(1.3)).outputs["Color"]
    soil_hsv = nb.node("ShaderNodeHueSaturation")
    soil_hsv.inputs["Value"].default_value = 0.7
    nb.link(soil, soil_hsv.inputs["Color"])
    sn2 = nb.noise(nb.coords(1.0), 0.9, 4, 0.6).outputs["Fac"]
    stone = nb.mix(nb.math("MULTIPLY", flat, nb.map_range(sn2, 0.3, 0.5)), stone, soil_hsv.outputs["Color"])
    mm = moss_mask(nb, moss)
    color = nb.mix(mm, stone, moss_colour(nb))
    height = nb.mixf(damage, blocks["height"], rubble["height"])
    height = nb.mixf(st, height, plaster["height"])
    rough = nb.mixf(mm, nb.mixf(damage, blocks["rough"], rubble["rough"]), 0.95)
    finish(nb, color, rough, height, 0.85, 0.06)
    return mat


def rock_material(name, moss=1.0):
    mat = bpy.data.materials.new(name)
    nb = NodeBuilder(mat)
    a = pbr_layer(nb, "mossy_rock", 3.0)
    b = pbr_layer(nb, "lichen_rock", 2.2)
    n = nb.noise(nb.coords(1.0), 0.08, 3).outputs["Fac"]
    f = nb.map_range(n, 0.42, 0.6)
    hsv = nb.node("ShaderNodeHueSaturation")
    hsv.inputs["Saturation"].default_value = 0.7
    nb.link(nb.mix(f, a["color"], b["color"]), hsv.inputs["Color"])
    col = hsv.outputs["Color"]
    col = nb.mix(nb.math("MULTIPLY", streaks(nb), 0.7), col, (0.05, 0.05, 0.04, 1))
    mm = moss_mask(nb, moss, 0.45)
    col = nb.mix(mm, col, moss_colour(nb))
    finish(nb, col, nb.mixf(f, a["rough"], b["rough"]), nb.mixf(f, a["height"], b["height"]), 0.9, 0.12)
    return mat


def ground_material(name):
    mat = bpy.data.materials.new(name)
    nb = NodeBuilder(mat)
    litter = pbr_layer(nb, "brown_mud_leaves_01", 1.3)
    leaves = pbr_layer(nb, "forest_leaves_02", 3.0)
    flags = pbr_layer(nb, "mossy_stone_wall", 2.0)
    plaster = pbr_layer(nb, "worn_mossy_plasterwall", 2.6)
    n1 = nb.noise(nb.coords(1.0), 0.05, 4, 0.6).outputs["Fac"]
    n2 = nb.noise(nb.coords(1.0), 0.13, 5, 0.6, 0.4).outputs["Fac"]
    paved = nb.node("ShaderNodeSeparateColor")
    nb.link(nb.attr("paving"), paved.inputs["Color"])
    pav = paved.outputs[0]
    col = nb.mix(nb.map_range(n1, 0.45, 0.6), litter["color"], leaves["color"])
    # Rainforest floor: darker and greener than the photographed temperate litter.
    hsv0 = nb.node("ShaderNodeHueSaturation")
    hsv0.inputs["Value"].default_value = 0.42
    hsv0.inputs["Saturation"].default_value = 1.1
    nb.link(col, hsv0.inputs["Color"])
    col = hsv0.outputs["Color"]
    # Paving inside the plaza: plaster floor remnants over flagstones, broken by the litter.
    fl = nb.mix(nb.map_range(n2, 0.5, 0.62), flags["color"], plaster["color"])
    pmask = nb.math("MULTIPLY", pav, nb.map_range(n2, 0.36, 0.5))
    col = nb.mix(pmask, col, fl)
    mm = nb.math("MULTIPLY", moss_mask(nb, 0.95, 0.6), nb.math("SUBTRACT", 1.0, nb.math("MULTIPLY", pmask, 0.4)))
    col = nb.mix(mm, col, moss_colour(nb))
    h = nb.mixf(pmask, nb.mixf(nb.map_range(n1, 0.45, 0.6), litter["height"], leaves["height"] if leaves["height"] else litter["height"]), flags["height"])
    finish(nb, col, nb.mixf(pmask, litter["rough"], flags["rough"]), h, 0.7, 0.05)
    return mat


def bark_material(name, moss=0.7):
    mat = bpy.data.materials.new(name)
    nb = NodeBuilder(mat)
    b = pbr_layer(nb, "japanese_hackberry_bark", 1.4)
    hsv = nb.node("ShaderNodeHueSaturation")
    hsv.inputs["Value"].default_value = 0.85
    nb.link(b["color"], hsv.inputs["Color"])
    mm = moss_mask(nb, moss, 0.2)
    col = nb.mix(mm, hsv.outputs["Color"], moss_colour(nb))
    finish(nb, col, b["rough"], b["height"], 0.9, 0.05)
    return mat


def simple_material(name, color, rough=0.9):
    mat = bpy.data.materials.new(name)
    nb = NodeBuilder(mat)
    finish(nb, (*color, 1.0) if False else nb.mix(0.0, (*color, 1.0), (*color, 1.0)), rough, None)
    return mat


# ---------------------------------------------------------------------------------------------
# Geometry helpers
# ---------------------------------------------------------------------------------------------


def new_object(name, bm, material=None, collection=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name, me)
    (collection or bpy.context.scene.collection).objects.link(obj)
    if material:
        obj.data.materials.append(material)
    return obj


def ensure_attr(me, name, value=0.0):
    if name not in me.color_attributes:
        a = me.color_attributes.new(name=name, type="BYTE_COLOR", domain="POINT")
        for d in a.data:
            d.color = (value, value, value, 1.0)
    return me.color_attributes[name]


def fbm(p, octaves=4, lac=2.0, gain=0.5):
    s, a, f = 0.0, 1.0, 1.0
    for _ in range(octaves):
        s += a * noise.noise(p * f)
        a *= gain
        f *= lac
    return s


def inset_rect(a, b, c):
    """Rectangle with an inward notch at every corner (Maya inset corners), counter-clockwise."""
    return [
        (a, -b + c), (a, b - c), (a - c, b - c), (a - c, b), (-a + c, b), (-a + c, b - c),
        (-a, b - c), (-a, -b + c), (-a + c, -b + c), (-a + c, -b), (a - c, -b), (a - c, -b + c),
    ]


def edge_counts(poly, step):
    n = len(poly)
    return [max(1, int(math.ceil((Vector(poly[(i + 1) % n]) - Vector(poly[i])).length / step))) for i in range(n)]


def resample(poly, counts):
    """Points along a closed polygon, counts[i] segments on edge i, keeping every corner."""
    out = []
    n = len(poly)
    for i in range(n):
        p0, p1 = Vector(poly[i]), Vector(poly[(i + 1) % n])
        k = counts[i]
        for j in range(k):
            out.append(p0.lerp(p1, j / k))
    return out


def outward_normals(pts):
    n = len(pts)
    out = []
    for i in range(n):
        a, b = pts[i - 1], pts[(i + 1) % n]
        t = (b - a).normalized()
        out.append(Vector((t.y, -t.x)))
    return out


# ---------------------------------------------------------------------------------------------
# The Great Pyramid
# ---------------------------------------------------------------------------------------------

PYR = {
    "center": Vector((-52.5, 60.9, PLAZA)),
    "yaw": 56.0,
    "terraces": 9,
    "base": (15.5, 14.5),
    "height": 26.0,
    "top": (6.0, 5.4),
    "notch": 0.7,
}


def terrace_profile(h):
    """(outset, dz) section of a Peten terrace: plinth, battered wall, shadow recess, apron moulding."""
    return [
        (0.00, 0.00), (0.03, 0.2), (-0.05, 0.26), (-0.34, 0.6 * h), (-0.62, 0.63 * h), (-0.64, 0.68 * h),
        (-0.06, 0.71 * h), (-0.14, 0.86 * h), (-0.28, h),
    ]


def build_pyramid(mat, soil_mat):
    """Nine terraces lofted from Peten profiles; returns the terraces, the walkway soil and the cap height."""
    P = PYR
    bm = bmesh.new()
    rings = []
    n_t = P["terraces"]
    h = P["height"] / n_t
    a0, b0 = P["base"]
    a1, b1 = P["top"]
    step = 0.32
    counts = edge_counts(inset_rect(a0, b0, P["notch"]), step)
    prev_top = None
    walkways = []
    for t in range(n_t):
        f = t / n_t
        a = a0 + (a1 - a0) * f
        b = b0 + (b1 - b0) * f
        z0 = PLAZA + t * h
        base_poly = resample(inset_rect(a, b, P["notch"]), counts)
        norms = outward_normals(base_poly)
        level_rings = []
        prof = terrace_profile(h)
        # Densify the battered wall so displacement has vertices to work with.
        dense = []
        for k in range(len(prof) - 1):
            o0, z_0 = prof[k]
            o1, z_1 = prof[k + 1]
            seg = max(1, int(math.ceil(abs(z_1 - z_0) / 0.33)))
            for j in range(seg):
                s_ = j / seg
                dense.append((o0 + (o1 - o0) * s_, z_0 + (z_1 - z_0) * s_))
        dense.append(prof[-1])
        for (o, dz) in dense:
            ring = [bm.verts.new((p.x + nn.x * o, p.y + nn.y * o, z0 + dz)) for p, nn in zip(base_poly, norms)]
            level_rings.append(ring)
        if prev_top is not None:
            rings.append((prev_top, level_rings[0], "walk"))
            walkways.append(([v.co.copy() for v in prev_top], [v.co.copy() for v in level_rings[0]], norms))
        for k in range(len(level_rings) - 1):
            rings.append((level_rings[k], level_rings[k + 1], "wall"))
        prev_top = level_rings[-1]
    cap_z = prev_top[0].co.z
    for r0, r1, kind in rings:
        n = len(r0)
        for i in range(n):
            j = (i + 1) % n
            try:
                bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
            except ValueError:
                pass
    cap = bm.faces.new(prev_top)
    bmesh.ops.triangulate(bm, faces=[cap])
    bm.normal_update()
    obj = new_object("pyramid_terraces", bm, mat)
    # Patina: darkest at the foot of each terrace wall and under the apron mouldings.
    attr = ensure_attr(obj.data, "patina", 0.0)
    for i, v in enumerate(obj.data.vertices):
        dz = ((v.co.z - PLAZA) % h) / h
        val = max(0.0, 1.0 - dz / 0.5) ** 1.5 + 0.8 * math.exp(-((dz - 0.68) / 0.05) ** 2)
        val = min(1.0, val)
        attr.data[i].color = (val, val, val, 1.0)
    # Soil and leaf litter banked against the foot of each wall on the walkways.
    sb = bmesh.new()
    for outer, inner, norms in walkways:
        n = len(outer)
        r_out, r_in = [], []
        for k in range(n):
            q = inner[k]
            dep = 0.25 + 0.45 * max(0.0, noise.noise(q * 0.35) * 0.5 + 0.5)
            r_in.append(sb.verts.new(q + Vector((norms[k].x, norms[k].y, 0)) * 0.05 + Vector((0, 0, dep))))
            o = outer[k]
            r_out.append(sb.verts.new(o.lerp(q, 0.15) + Vector((0, 0, 0.03))))
        for k in range(n):
            j = (k + 1) % n
            try:
                sb.faces.new((r_out[k], r_out[j], r_in[j], r_in[k]))
            except ValueError:
                pass
    soil = new_object("pyramid_soil", sb, soil_mat)
    return obj, soil, cap_z


def build_stair(mat, top_z, width=8.6, riser=0.4, run_angle=55.0):
    """Projecting central stairway on the pyramid's front (-Y local), from the plaza to the summit."""
    P = PYR
    height = top_z - PLAZA
    n = int(round(height / riser))
    riser = height / n
    tread = riser / math.tan(math.radians(run_angle))
    front_top = -P["top"][1] + 0.2
    bm = bmesh.new()
    hw = width / 2
    seg = int(math.ceil(width / 0.3))
    # Each step: a riser leaning back slightly, then a tread; a grid across the width so stones can be chipped.
    y = front_top - n * tread
    z = PLAZA
    profile = [(y, z)]
    for i in range(n):
        z += riser
        profile.append((y + 0.06, z))
        y += tread
        profile.append((y, z))
    r = random.Random(77)
    grid = []
    for ri, (py, pz) in enumerate(profile):
        row = []
        for k in range(seg + 1):
            row.append(bm.verts.new((-hw + width * k / seg, py, pz)))
        grid.append(row)
    # Chipped step noses, broken runs of steps and a few missing stones.
    for i in range(n):
        edge = grid[2 * i + 1]
        broken = r.random() < 0.18
        b_from = r.randint(0, seg)
        b_len = r.randint(3, max(4, seg // 2))
        for k, v in enumerate(edge):
            e = r.random() ** 2 * 0.09
            if broken and b_from <= k <= b_from + b_len:
                e += 0.12 + 0.12 * r.random()
            v.co.z -= e
            v.co.y += e * 0.9
    for rr in range(len(grid) - 1):
        for k in range(seg):
            bm.faces.new((grid[rr][k], grid[rr][k + 1], grid[rr + 1][k + 1], grid[rr + 1][k]))
    # Side walls (alfardas): from the step profile down to the terrace face behind the stair.
    for side in (-1, 1):
        x = side * hw
        top = [grid[rr][0 if side < 0 else seg] for rr in range(len(grid))]
        bottom = []
        b0, b1 = P["base"][1], P["top"][1]
        for (py, pz) in profile:
            zt = PLAZA + height * (b0 + py) / (b0 - b1) if py > -b0 else PLAZA
            bottom.append(bm.verts.new((x, py, min(pz - 0.3, max(PLAZA, zt - 0.8)))))
        for rr in range(len(top) - 1):
            quad = (top[rr], top[rr + 1], bottom[rr + 1], bottom[rr]) if side > 0 else (top[rr], bottom[rr], bottom[rr + 1], top[rr + 1])
            try:
                bm.faces.new(quad)
            except ValueError:
                pass
    bm.normal_update()
    obj = new_object("pyramid_stair", bm, mat)
    me = obj.data
    attr = me.color_attributes.new(name="patina", type="BYTE_COLOR", domain="CORNER")
    for poly in me.polygons:
        riser = abs(poly.normal.z) < 0.6
        for li in poly.loop_indices:
            z = me.vertices[me.loops[li].vertex_index].co.z
            val = (0.95 if riser else 0.05) + 0.3 * max(0.0, 1.0 - (z - PLAZA) / 8.0)
            val = min(1.0, val)
            attr.data[li].color = (val, val, val, 1.0)
    return obj, (front_top, top_z)


def build_fig_trunk(mat, base, lean):
    """The strangler fig's own trunk: rises from its roots on the summit corner into the canopy."""
    bm = bmesh.new()
    path, radii = [], []
    for k in range(40):
        t = k / 39
        z = base.z + t * 34.0
        off = lean * (t ** 1.4) * 9.0 + Vector((math.sin(t * 5.0) * 0.6, math.cos(t * 4.0) * 0.5, 0))
        path.append(Vector((base.x, base.y, z)) + off)
        radii.append(1.7 * (1.0 - 0.4 * t) + 1.6 * math.exp(-t * 9))
    tube_mesh(bm, path, radii, sides=28)
    obj = new_object("fig_trunk", bm, mat)
    subdivide_long_edges(obj, 0.6)
    for v in obj.data.vertices:
        # Fused, fluted stems: deep vertical grooves and lumps, as a strangler fig's lattice of roots.
        a = math.atan2(v.co.y - base.y, v.co.x - base.x)
        groove = 0.35 * abs(math.sin(a * 4.0 + v.co.z * 0.05)) + 0.2 * noise.noise(Vector((a * 2.0, v.co.z * 0.15, 3.0)))
        d = Vector((v.co.x - base.x, v.co.y - base.y, 0))
        if d.length > 1e-6:
            d.normalize()
        v.co += d * (groove - 0.25) + Vector((noise.noise(v.co * 0.5), noise.noise(v.co * 0.5 + Vector((5, 0, 0))), 0)) * 0.25
    return obj


def build_temple(mat, base_z, lintel_mat):
    """Summit temple: platform, walls with a corbel-arched doorway, medial moulding, frieze, roof comb."""
    parts = []
    # Basal platform.
    parts.append(box_obj("temple_platform", (0, 0.4, base_z + 0.5), (5.6, 4.6, 0.5), mat))
    wall_z = base_z + 1.0
    w, d, hw = 4.6, 3.4, 4.2
    body = box_obj("temple_body", (0, 0.6, wall_z + hw / 2), (w, d, hw / 2), mat)
    # Corbel-arched doorway and the room behind it.
    door = corbel_cutter((0, 0.6 - d - 0.5, wall_z), 1.0, 2.4, 1.1, 3.0, depth=3.6)
    room = box_obj("temple_room", (0, 0.9, wall_z + 1.9), (3.4, 1.0, 1.9), None)
    boolean(body, door, "DIFFERENCE")
    boolean(body, room, "DIFFERENCE")
    for o in (door, room):
        bpy.data.objects.remove(o, do_unlink=True)
    parts.append(body)
    # Wooden lintel over the doorway (sapodilla wood in the original builds).
    parts.append(box_obj("temple_lintel", (0, 0.6 - d + 0.15, wall_z + 2.55), (1.25, 0.18, 0.12), lintel_mat))
    # Medial moulding and the inward-sloping upper facade.
    parts.append(box_obj("temple_medial", (0, 0.6, wall_z + hw + 0.2), (w + 0.25, d + 0.25, 0.2), mat))
    frieze = tapered_box("temple_frieze", (0, 0.6, wall_z + hw + 0.4), (w + 0.1, d + 0.1), (w - 0.5, d - 0.5), 2.1, mat)
    parts.append(frieze)
    top = wall_z + hw + 0.4 + 2.1
    # Roof comb: two tiers set towards the rear, with rectangular voids, eroded at one shoulder.
    comb1 = tapered_box("comb_lower", (0, 1.6, top), (3.9, 1.0), (3.4, 0.8), 3.6, mat)
    comb2 = tapered_box("comb_upper", (0, 1.7, top + 3.6), (3.0, 0.75), (2.3, 0.6), 3.0, mat)
    for (cx, cz, sx, sz) in ((-2.1, top + 1.6, 0.55, 0.8), (0.0, top + 1.6, 0.55, 0.8), (2.1, top + 1.6, 0.55, 0.8), (-1.1, top + 5.0, 0.45, 0.7), (1.1, top + 5.0, 0.45, 0.7)):
        void = box_obj("void", (cx, 1.6, cz), (sx, 2.0, sz), None)
        boolean(comb1 if cz < top + 3.6 else comb2, void, "DIFFERENCE")
        bpy.data.objects.remove(void, do_unlink=True)
    bite = rock_blob("bite", (2.7, 1.7, top + 6.4), 1.9, 0.5, None)
    boolean(comb2, bite, "DIFFERENCE")
    boolean(comb1, bite, "DIFFERENCE")
    bpy.data.objects.remove(bite, do_unlink=True)
    parts += [comb1, comb2]
    return parts, top + 6.6


def box_obj(name, center, half, mat):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=2.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * half[0] + center[0], v.co.y * half[1] + center[1], v.co.z * half[2] + center[2]))
    return new_object(name, bm, mat)


def tapered_box(name, base_center, base_half, top_half, height, mat):
    bm = bmesh.new()
    cx, cy, cz = base_center
    vs = []
    for (hx, hy), z in ((base_half, cz), (top_half, cz + height)):
        vs.append([bm.verts.new((cx + sx * hx, cy + sy * hy, z)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    bm.faces.new(vs[0][::-1])
    bm.faces.new(vs[1])
    for i in range(4):
        j = (i + 1) % 4
        bm.faces.new((vs[0][i], vs[0][j], vs[1][j], vs[1][i]))
    return new_object(name, bm, mat)


def corbel_cutter(origin, half_w, jamb_h, vault_top_half, total_h, depth=3.0):
    """Doorway cutter: straight jambs, then stepped corbel courses closing to a capstone."""
    x0, y0, z0 = origin
    pts = [(-half_w, 0), (half_w, 0), (half_w, jamb_h)]
    courses = 4
    for c in range(1, courses + 1):
        hw = half_w - (half_w - 0.18) * c / courses
        z = jamb_h + (total_h - jamb_h) * c / courses
        pts += [(hw + (half_w - 0.18) / courses, z), (hw, z)]
    pts += [(-p[0], p[1]) for p in reversed(pts[2:])]
    bm = bmesh.new()
    front = [bm.verts.new((x0 + x, y0, z0 + z)) for x, z in pts]
    back = [bm.verts.new((x0 + x, y0 + depth, z0 + z)) for x, z in pts]
    bm.faces.new(front[::-1])
    bm.faces.new(back)
    n = len(pts)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    return new_object("door_cutter", bm, None)


def rock_blob(name, center, radius, rough, mat, seed=None, squash=(1, 1, 1), subdiv=3):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=1.0)
    s = rng.random() * 100 if seed is None else seed
    for v in bm.verts:
        p = v.co.copy()
        d = 1.0 + rough * fbm(p * 1.3 + Vector((s, s * 0.7, s * 1.3)), 3)
        # Facets: quantise slightly so blocks read as broken stone, not pebbles.
        v.co = Vector((p.x * d * radius * squash[0] + center[0], p.y * d * radius * squash[1] + center[1], p.z * d * radius * squash[2] + center[2]))
    return new_object(name, bm, mat)


def boolean(target, cutter, op):
    mod = target.modifiers.new("bool", "BOOLEAN")
    mod.operation = op
    mod.solver = "EXACT"
    mod.object = cutter
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.select_all(action="DESELECT")
    target.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def remesh(obj, voxel):
    mod = obj.modifiers.new("remesh", "REMESH")
    mod.mode = "VOXEL"
    mod.voxel_size = voxel
    mod.adaptivity = 0.0
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def decimate(obj, ratio):
    mod = obj.modifiers.new("dec", "DECIMATE")
    mod.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=mod.name)


def transform_obj(obj, center, yaw):
    obj.matrix_world = Matrix.Translation(center) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @ obj.matrix_world
    apply_transform(obj)


def apply_transform(obj):
    me = obj.data
    me.transform(obj.matrix_world)
    obj.matrix_world = Matrix.Identity(4)


def weather(obj, amp=0.05, edge_amp=0.12, scale=1.6, seed=0.0, pits=0.12):
    """Erodes a mesh: fBm along the normals, stronger on convex edges, plus blocky missing facing stones."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.normal_update()
    off = Vector((seed, seed * 1.7, seed * 0.3))
    for v in bm.verts:
        p = v.co
        n = v.normal
        convex = 0.0
        if v.link_faces:
            ns = [f.normal for f in v.link_faces]
            spread = 1.0 - min(1.0, sum(a.dot(b) for a in ns for b in ns) / (len(ns) ** 2))
            convex = min(1.0, spread * 3.0)
        d = fbm(p / scale + off, 4) * (amp + edge_amp * convex)
        # Missing blocks: cells of a blocky grid sink in.
        cell = Vector((math.floor(p.x / 0.55), math.floor(p.y / 0.55), math.floor(p.z / 0.38)))
        h = noise.noise(cell * 0.73 + off)
        if h > 0.48:
            d -= pits * (h - 0.48) / 0.52
        v.co = p + n * d
    bm.to_mesh(me)
    bm.free()


def break_aprons(obj, h, seed=3.0, threshold=0.38, depth=0.55):
    """Runs of fallen apron moulding: the projecting band is gone and the rubble core shows."""
    me = obj.data
    attr = ensure_attr(me, "damage", 0.0)
    for i, v in enumerate(me.vertices):
        dz = ((v.co.z - PLAZA) % h) / h
        if dz < 0.55:
            continue
        a = math.atan2(v.co.y, v.co.x)
        n = noise.noise(Vector((math.cos(a) * 3.0, math.sin(a) * 3.0, math.floor((v.co.z - PLAZA) / h) * 1.7 + seed)))
        if n > threshold:
            k = min(1.0, (n - threshold) / 0.12)
            r = Vector((v.co.x, v.co.y, 0.0))
            if r.length > 1e-6:
                r.normalize()
            v.co -= r * depth * k * (0.7 + 0.3 * noise.noise(v.co * 1.3))
            v.co.z -= 0.15 * k
            c = max(attr.data[i].color[0], 0.85 * k)
            attr.data[i].color = (c, c, c, 1.0)


def subdivide_long_edges(obj, max_len):
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    for _ in range(6):
        long = [e for e in bm.edges if e.calc_length() > max_len]
        if not long:
            break
        bmesh.ops.subdivide_edges(bm, edges=long, cuts=1, use_grid_fill=True)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    bm.to_mesh(me)
    bm.free()


def paint_damage(obj, centers, layer="damage"):
    """Point colour attribute: 1 inside the given (center, radius) spheres, falling off softly."""
    me = obj.data
    attr = ensure_attr(me, layer, 0.0)
    for i, v in enumerate(me.vertices):
        val = attr.data[i].color[0]
        for c, r in centers:
            d = (v.co - c).length / r
            val = max(val, max(0.0, 1.0 - d) ** 0.6 + 0.25 * noise.noise(v.co * 0.7))
        val = max(0.0, min(1.0, val))
        attr.data[i].color = (val, val, val, 1.0)


def slump(obj, center, radius, depth, down=0.6):
    """Collapses a region: vertices move inward and down, producing a scar of slumped core."""
    me = obj.data
    for v in me.vertices:
        d = (v.co - center).length
        if d < radius:
            k = (1.0 - d / radius) ** 1.5
            inward = Vector((center.x - v.co.x, center.y - v.co.y, 0.0))
            if inward.length > 1e-6:
                inward.normalize()
            jitter = 0.45 + 0.55 * (noise.noise(v.co * 0.6) * 0.5 + 0.5)
            v.co += (inward * depth + Vector((0, 0, -depth * down))) * k * jitter


def scatter_rubble(name, area_center, radius, count, size, mat, ground_fn, seed=3, squash=0.65):
    r = random.Random(seed)
    bm_all = bmesh.new()
    for i in range(count):
        ang = r.random() * math.tau
        rad = radius * math.sqrt(r.random())
        x = area_center.x + math.cos(ang) * rad
        y = area_center.y + math.sin(ang) * rad
        s = size * (0.35 + r.random() ** 2 * 1.4)
        z = ground_fn(x, y) + s * 0.25
        tmp = bmesh.new()
        bmesh.ops.create_cube(tmp, size=2.0)
        bmesh.ops.subdivide_edges(tmp, edges=tmp.edges[:], cuts=2, use_grid_fill=True)
        sd = r.random() * 50
        rot = Matrix.Rotation(r.random() * math.tau, 3, "Z") @ Matrix.Rotation((r.random() - 0.5) * 0.9, 3, "X")
        dims = Vector((s * (0.8 + r.random() * 0.6), s * (0.6 + r.random() * 0.5), s * squash * (0.6 + r.random() * 0.5)))
        for v in tmp.verts:
            p = v.co.copy()
            p += p.normalized() * 0.18 * fbm(p * 1.5 + Vector((sd, 0, 0)), 2)
            p = Vector((p.x * dims.x * 0.5, p.y * dims.y * 0.5, p.z * dims.z * 0.5))
            v.co = rot @ p + Vector((x, y, z))
        me = bpy.data.meshes.new("tmp")
        tmp.to_mesh(me)
        tmp.free()
        bm_all.from_mesh(me)
        bpy.data.meshes.remove(me)
    return new_object(name, bm_all, mat)


_talus = []


def talus_height(x, y):
    """Ground height including the rubble mounds (for blocks resting on them)."""
    h = ground_height(x, y)
    for c, (rx, ry), top in _talus:
        d = ((x - c.x) / rx) ** 2 + ((y - c.y) / ry) ** 2
        if d < 1.0:
            h = max(h, ground_height(c.x, c.y) + top * (1.0 - d) ** 1.4)
    return h


def talus(name, center, radii, top, mat, seed):
    """A slumped rubble mound (collapsed core and facing stones), irregular and settled."""
    _talus.append((center, radii, top))
    bm = bmesh.new()
    n = 40
    rings = []
    for j in range(n + 1):
        rr = j / n
        ring = []
        for k in range(48):
            a = k / 48 * math.tau
            x = center.x + math.cos(a) * radii[0] * rr * 1.08
            y = center.y + math.sin(a) * radii[1] * rr * 1.08
            z = talus_height(x, y) + 0.35 * fbm(Vector((x * 0.7, y * 0.7, seed)), 3) * (1 - rr) - 0.08
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for j in range(n):
        for k in range(48):
            if j == 0:
                continue
            bm.faces.new((rings[j][k], rings[j + 1][k], rings[j + 1][(k + 1) % 48], rings[j][(k + 1) % 48]))
    bm.faces.new(rings[1][::-1])
    obj = new_object(name, bm, mat)
    ensure_attr(obj.data, "damage", 1.0)
    return obj


def build_palace(mat, wood, origin, length=22.0, depth=6.2, doors=5, yaw=0.0, ruin=0.0):
    """Palace range: a long gallery with corbel-arched doorways, medial moulding and frieze."""
    parts = []
    x0, y0, z0 = origin
    wall_h = 3.6
    body = box_obj("palace_body", (0, 0, z0 + wall_h / 2), (depth / 2, length / 2, wall_h / 2), mat)
    gallery = box_obj("palace_gallery", (-0.6, 0, z0 + 1.7), (1.1, length / 2 - 1.2, 1.75), None)
    boolean(body, gallery, "DIFFERENCE")
    bpy.data.objects.remove(gallery, do_unlink=True)
    for i in range(doors):
        yd = -length / 2 + length * (i + 0.5) / doors
        cut = corbel_cutter((0, 0, 0), 0.8, 1.8, 0.6, 2.75, depth=3.0)
        cut.matrix_world = Matrix.Translation((-depth / 2 - 0.5, yd, z0)) @ Matrix.Rotation(-math.pi / 2, 4, "Z")
        apply_transform(cut)
        boolean(body, cut, "DIFFERENCE")
        bpy.data.objects.remove(cut, do_unlink=True)
    parts.append(body)
    parts.append(box_obj("palace_medial", (0, 0, z0 + wall_h + 0.18), (depth / 2 + 0.22, length / 2 + 0.22, 0.18), mat))
    parts.append(tapered_box("palace_frieze", (0, 0, z0 + wall_h + 0.36), (depth / 2 + 0.05, length / 2 + 0.05), (depth / 2 - 0.9, length / 2 - 0.5), 1.9, mat))
    if ruin > 0:
        for (yy, zz, rr) in ((length * 0.32, z0 + wall_h + 1.6, 2.8 * ruin), (-length * 0.45, z0 + wall_h + 1.2, 2.0 * ruin)):
            bite = rock_blob("bite", (0, yy, zz), rr, 0.45, None)
            for o in parts:
                boolean(o, bite, "DIFFERENCE")
            bpy.data.objects.remove(bite, do_unlink=True)
    for o in parts:
        o.matrix_world = Matrix.Translation((x0, y0, 0)) @ Matrix.Rotation(math.radians(yaw), 4, "Z")
        apply_transform(o)
    return parts


def build_acropolis(mat, mat_t, wood):
    """On the escarpment: a battered terrace wall with an apron moulding and a palace range on top."""
    parts = []
    y_c, length = 30.5, 16.0
    z_b = CLIFF_TOP - 2.6
    bm = bmesh.new()
    ys = np.linspace(y_c - length / 2, y_c + length / 2, 120)
    # (inward offset, height): battered wall, shadow recess, apron moulding, then the terrace top.
    prof = [(0.0, 0.0), (0.7, 5.4), (0.82, 5.45), (0.82, 5.55), (0.4, 5.6), (0.6, 6.8), (3.2, 6.8)]
    rows = []
    for (o, dz) in prof:
        rows.append([bm.verts.new((cliff_x(y) + 3.5 + o, y, z_b + dz)) for y in ys])
    for j in range(len(rows) - 1):
        for i in range(len(ys) - 1):
            bm.faces.new((rows[j][i], rows[j + 1][i], rows[j + 1][i + 1], rows[j][i + 1]))
    wall = new_object("acropolis_wall", bm, mat)
    weather(wall, 0.04, 0.12, 1.2, 21.0, 0.12)
    parts.append(wall)
    xp = cliff_x(y_c) + 3.5 + 3.0 + 3.6
    return parts


# ---------------------------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------------------------


def ground_height(x, y):
    """Plaza floor height (Blender XY): flat paving that rises into mounds towards the forest."""
    d_forest = max(0.0, abs(x) - 70.0) + max(0.0, y - 150.0)
    mound = 0.0 if d_forest <= 0 else min(2.5, d_forest * 0.05) * (0.5 + 0.5 * noise.noise(Vector((x * 0.03, y * 0.03, 1.0))))
    return PLAZA + 0.12 * fbm(Vector((x * 0.08, y * 0.08, 0.5)), 3) + 0.04 * noise.noise(Vector((x * 0.6, y * 0.6, 2.0))) + mound


def build_ground(mat):
    bm = bmesh.new()
    x0, x1, y0, y1 = -125.0, 105.0, -4.0, 230.0
    nx, ny = 230, 234
    grid = []
    for j in range(ny + 1):
        # Rows bunch up near the viewer, where the floor is seen closest.
        t = j / ny
        y = y0 + (y1 - y0) * (t ** 1.35)
        row = []
        for i in range(nx + 1):
            x = x0 + (x1 - x0) * i / nx
            row.append(bm.verts.new((x, y, ground_height(x, y))))
        grid.append(row)
    for j in range(ny):
        for i in range(nx):
            bm.faces.new((grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]))
    obj = new_object("plaza_floor", bm, mat)
    me = obj.data
    pav = ensure_attr(me, "paving", 0.0)
    for k, v in enumerate(me.vertices):
        x, y = v.co.x, v.co.y
        inside = max(0.0, 1.0 - max(abs(x + 5) / 62.0, abs(y - 75) / 70.0) ** 6)
        pav.data[k].color = (inside, inside, inside, 1.0)
    return obj


CLIFF_TOP = 2.0


def cliff_x(y):
    return 31.0 + 0.0042 * (y - 26.0) ** 2 - 0.05 * (y - 26.0)


def build_escarpment(mat):
    """Karst limestone outcrop on the right, facing the plaza, with a channel cut for the waterfall."""
    bm = bmesh.new()
    ys = np.linspace(8.0, 52.0, 120)
    zs = np.linspace(PLAZA - 1.0, CLIFF_TOP, 46)
    grid = []
    for z in zs:
        row = []
        for y in ys:
            base_x = cliff_x(y)
            t = (z - PLAZA) / (CLIFF_TOP - PLAZA)
            # Slight batter, fluting (vertical karren), blocky ledges and overhangs.
            flute = 0.45 * noise.noise(Vector((y * 0.55, 0.0, z * 0.06 + 3.0)))
            ledge = 0.9 * fbm(Vector((y * 0.09, 7.0, z * 0.33)), 3)
            big = 2.4 * fbm(Vector((y * 0.035, 3.0, z * 0.05)), 3)
            x = base_x + t * 1.6 + flute + ledge + big
            # Talus at the foot.
            x -= max(0.0, 2.5 - (z - PLAZA)) * 0.9
            # The outcrop sinks into the forest floor at both ends.
            k = math.exp(-((y - 30.0) / 13.0) ** 6)
            zz = PLAZA - 1.0 + (z - PLAZA + 1.0) * (0.25 + 0.75 * k)
            x += (1.0 - k) * 4.0 * t
            row.append(bm.verts.new((x, y, zz)))
        grid.append(row)
    # The cliff top runs back to the east.
    top_row = grid[-1]
    back = [bm.verts.new((v.co.x + 18.0, v.co.y, v.co.z + 0.6 * noise.noise(Vector((v.co.y * 0.1, 1, 1))))) for v in top_row]
    grid.append(back)
    for j in range(len(grid) - 1):
        for i in range(len(ys) - 1):
            bm.faces.new((grid[j][i], grid[j + 1][i], grid[j + 1][i + 1], grid[j][i + 1]))
    obj = new_object("escarpment", bm, mat)
    # Waterfall notch: lower the rim around the spillway.
    for v in obj.data.vertices:
        dy = abs(v.co.y - WATERFALL["y"])
        if dy < 2.4 and v.co.z > WATERFALL["lip"] - 1.0:
            v.co.z = min(v.co.z, WATERFALL["lip"] - 0.2 + (dy / 2.4) ** 2 * 1.5)
    return obj


WATERFALL = {"y": 26.0, "x": 31.0, "lip": CLIFF_TOP, "width": 5.6}


def build_spillway(mat):
    """Masonry chute that carries the stream over the cliff edge: floor, side walls and a projecting lip."""
    parts = []
    y, x, z = WATERFALL["y"], WATERFALL["x"], WATERFALL["lip"]
    w = WATERFALL["width"] / 2
    parts.append(box_obj("spill_floor", (x + 4.0, y, z - 0.35), (4.6, w + 0.6, 0.35), mat))
    for s in (-1, 1):
        parts.append(box_obj("spill_wall", (x + 4.0, y + s * (w + 0.45), z + 0.35), (4.6, 0.45, 0.7), mat))
    parts.append(box_obj("spill_lip", (x - 0.35, y, z - 0.55), (0.5, w + 0.9, 0.55), mat))
    return parts


def build_pool(mat):
    """Stone-lined basin at the foot of the falls, partly broken, with steps down from the plaza."""
    parts = []
    cx, cy = 25.0, 26.0
    hx, hy = 6.5, 7.5
    zt = PLAZA + 0.25
    for (c, h) in (((cx, cy - hy, zt - 0.9), (hx + 0.6, 0.6, 1.15)), ((cx, cy + hy, zt - 0.9), (hx + 0.6, 0.6, 1.15)), ((cx - hx, cy, zt - 0.9), (0.6, hy, 1.15))):
        parts.append(box_obj("pool_wall", c, h, mat))
    # Broken section of the front wall.
    bite = rock_blob("bite", (cx - hx, cy - 3.0, zt), 2.2, 0.4, None)
    boolean(parts[2], bite, "DIFFERENCE")
    bpy.data.objects.remove(bite, do_unlink=True)
    return parts


def stela_heightmap(seed, nx=64, ny=160):
    """Original glyph panel: two columns of rounded cartouches with inner grooves (height 0..1)."""
    r = np.random.default_rng(seed)
    hgt = np.zeros((ny, nx))
    yy, xx = np.mgrid[0:ny, 0:nx]
    cols, rows = 2, 6
    cw, ch = (nx - 8) / cols, (ny - 14) / rows
    for c in range(cols):
        for rr in range(rows):
            x0 = 4 + c * cw + 2
            y0 = 7 + rr * ch + 2
            w, h = cw - 4, ch - 4
            dx = np.clip(np.maximum(np.abs(xx - (x0 + w / 2)) - w / 2 + 3, 0), 0, None)
            dy = np.clip(np.maximum(np.abs(yy - (y0 + h / 2)) - h / 2 + 3, 0), 0, None)
            inside = (np.sqrt(dx ** 2 + dy ** 2) < 3).astype(float)
            # Inner motifs: a few random strokes and dots.
            motif = np.zeros_like(hgt)
            for _ in range(r.integers(3, 6)):
                px, py = x0 + r.uniform(3, w - 3), y0 + r.uniform(3, h - 3)
                rad = r.uniform(1.2, 3.2)
                motif = np.maximum(motif, (np.hypot(xx - px, yy - py) < rad).astype(float))
            for _ in range(r.integers(1, 3)):
                ya = y0 + r.uniform(3, h - 3)
                motif = np.maximum(motif, ((np.abs(yy - ya) < 0.9) & (xx > x0 + 2) & (xx < x0 + w - 2)).astype(float))
            hgt = np.maximum(hgt, inside * (0.75 - 0.45 * motif))
    # Border frame.
    frame = ((xx < 3) | (xx > nx - 4) | (yy < 4) | (yy > ny - 5)).astype(float)
    return np.maximum(hgt, frame)


def build_stela(name, base, yaw, height, mat, seed, lean=0.0, broken=False):
    w, d = 1.15, 0.42
    nx, ny = 24, 60
    hm = stela_heightmap(seed)
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=nx, y_segments=ny, size=0.5)
    # A slab: thicken the grid and carve the front.
    res = bmesh.ops.extrude_face_region(bm, geom=bm.faces[:])
    ext = [g for g in res["geom"] if isinstance(g, bmesh.types.BMVert)]
    for v in ext:
        v.co.z -= 1.0
    for v in bm.verts:
        u = v.co.x + 0.5
        t = v.co.y + 0.5
        front = v.co.z > -0.5
        carve = 0.0
        if front and 0.03 < u < 0.97 and 0.02 < t < 0.98:
            hx = min(hm.shape[1] - 1, int(u * hm.shape[1]))
            hy = min(hm.shape[0] - 1, int((1 - t) * hm.shape[0]))
            carve = (1.0 - hm[hy, hx]) * 0.045
        top_taper = 1.0 - 0.12 * t
        x = v.co.x * w * top_taper
        y = (0.0 if front else -d) + (-carve if front else 0.0)
        z = t * height
        # Rounded top corners.
        if t > 0.92:
            z -= (abs(v.co.x) * 2) ** 3 * 0.18
        v.co = Vector((x, y, z))
    obj = new_object(name, bm, mat)
    bm2 = bmesh.new()
    bm2.from_mesh(obj.data)
    bmesh.ops.remove_doubles(bm2, verts=bm2.verts, dist=1e-4)
    bm2.to_mesh(obj.data)
    bm2.free()
    # Glow mask: the carved recesses of the glyph panel (the game lights them faintly with the music).
    gattr = obj.data.color_attributes.new(name="glow", type="BYTE_COLOR", domain="POINT")
    for i, v in enumerate(obj.data.vertices):
        g = min(1.0, max(0.0, -v.co.y / 0.035)) if v.co.y > -0.1 else 0.0
        gattr.data[i].color = (g, g, g, 1.0)
    weather(obj, 0.015, 0.05, 0.6, seed, 0.0)
    obj.matrix_world = Matrix.Translation(base) @ Matrix.Rotation(math.radians(yaw), 4, "Z") @ Matrix.Rotation(lean, 4, "X")
    apply_transform(obj)
    return obj


def build_altar(name, base, radius, mat):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=28, radius1=radius, radius2=radius * 0.96, depth=0.75)
    for v in bm.verts:
        v.co.z += 0.375
    obj = new_object(name, bm, mat)
    subdivide_long_edges(obj, 0.25)
    weather(obj, 0.02, 0.06, 0.5, radius * 10, 0.03)
    obj.location = base
    apply_transform_loc(obj)
    return obj


def apply_transform_loc(obj):
    obj.data.transform(Matrix.Translation(obj.location))
    obj.location = (0, 0, 0)


def build_north_platform(mat):
    """Long terraced platform behind the board with a central stair and two small temples."""
    parts = []
    cy = 142.0
    for i, (hx, hy) in enumerate(((46, 13), (42, 10.5), (38, 8.5))):
        parts.append(box_obj(f"np_terrace{i}", (0, cy, PLAZA + 2.2 * i + 2.2), (hx, hy, 2.2), mat))
    for x in (-20.0, 20.0):
        zb = PLAZA + 8.8 - 2.4
        parts.append(box_obj("np_temple_base", (x, cy + 1.0, zb + 1.2), (5.0, 4.0, 1.2), mat))
        body = box_obj("np_temple", (x, cy + 1.0, zb + 2.4 + 2.0), (3.6, 2.8, 2.0), mat)
        door = corbel_cutter((x, cy + 1.0 - 2.8 - 0.4, zb + 2.4), 0.7, 1.7, 0.6, 2.4)
        boolean(body, door, "DIFFERENCE")
        bpy.data.objects.remove(door, do_unlink=True)
        parts.append(body)
        parts.append(tapered_box("np_frieze", (x, cy + 1.0, zb + 6.4), (3.8, 3.0), (3.2, 2.5), 1.5, mat))
        parts.append(tapered_box("np_comb", (x, cy + 2.2, zb + 7.9), (2.4, 0.6), (1.7, 0.45), 3.4, mat))
    # Central stair (simple stepped ramp).
    bm = bmesh.new()
    steps = 26
    rise = 8.8 / steps
    for k in range(steps):
        z0 = PLAZA + k * rise
        y_front = cy - 13.0 - 7.0 + k * 0.27
        depth = (cy - 8.5) - y_front
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((0, y_front + depth / 2, z0 + rise / 2)) @ Matrix.Diagonal((9.0, depth, rise, 1.0)))
    parts.append(new_object("np_stair", bm, mat))
    return parts


# The carved panel (Sketchfab "Mexico Maya Relief: K'inich Ahkal", CC0) is placed by the game's model
# component; this wall holds it in a recess so only its carved face shows.
PANEL = {"pos": Vector((-30.0, 32.0)), "yaw": 25.8, "height": 2.8, "scan_depth": 1.74}


def build_panel_wall(mat):
    pos = PANEL["pos"]
    gz = ground_height(pos.x, pos.y)
    wall = box_obj("panel_wall", (0, 1.0, gz + 1.7), (3.6, 1.0, 2.0), mat)
    recess = box_obj("recess", (0, 0.5, gz + 0.35 + 1.5), (0.72, 0.62, 1.52), None)
    boolean(wall, recess, "DIFFERENCE")
    bpy.data.objects.remove(recess, do_unlink=True)
    cap = tapered_box("panel_cap", (0, 1.0, gz + 3.7), (3.75, 1.12), (3.5, 0.95), 0.45, mat)
    plinth = box_obj("panel_plinth", (0, 0.95, gz + 0.12), (3.9, 1.2, 0.3), mat)
    parts = [wall, cap, plinth]
    for o in parts:
        subdivide_long_edges(o, 0.3)
        weather(o, 0.025, 0.08, 0.8, 31.0, 0.08)
        o.matrix_world = Matrix.Translation((pos.x, pos.y, 0)) @ Matrix.Rotation(math.radians(PANEL["yaw"]), 4, "Z")
        apply_transform(o)
    paint_damage(cap, [(Vector((pos.x + 2.5, pos.y, gz + 3.9)), 1.6)])
    # Where the game puts the scan: its footprint centre sits half its depth behind the wall face.
    c = Vector((pos.x, pos.y)) + Matrix.Rotation(math.radians(PANEL["yaw"]), 2) @ Vector((0.0, PANEL["scan_depth"] / 2 - 0.02))
    print("PANEL_GAME_POSITION", round(c.x, 3), round(gz + 0.42, 3), round(-c.y, 3), "yaw", PANEL["yaw"])
    return parts


SKETCHFAB = os.path.join(ROOT, "assets", "external", "sketchfab")
SCAN_PALACE = {
    "name": "palenque_palace", "dir": "palenque-palace",
    "up": (-0.3463, -0.9084, -0.2343), "height": 6.4, "yaw": 0.0, "pos": (45.5, 31.0), "z": CLIFF_TOP + 0.2, "tris": 60000, "sink": 0.6,
}
SCAN_CAHAL = {
    "name": "cahal_pech_b1", "dir": "cahal-pech-b1",
    "up": (0.0, 0.0, 1.0), "height": 17.0, "yaw": 180.0, "pos": (-4.0, 150.0), "z": None, "tris": 35000, "sink": 2.5,
}


def import_scan(spec):
    """Imports a Sketchfab photogrammetry scan, stands it upright, scales it to `height`, decimates it and
    places it; its photographed texture becomes the albedo of the bake (credited in ASSET_LICENSES.md)."""
    gdir = os.path.join(SKETCHFAB, spec["dir"], "gltf")
    path = os.path.join(gdir, next(f for f in os.listdir(gdir) if f.endswith(".gltf")))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH" and not o.name.lower().startswith("icosphere")]
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.data = o.data.copy()
        o.data.transform(mw)
        o.matrix_world = Matrix.Identity(4)
    for o in new:
        if o not in meshes:
            bpy.data.objects.remove(o, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = spec["name"]
    me = obj.data
    rot = Vector(spec["up"]).normalized().rotation_difference(Vector((0, 0, 1))).to_matrix().to_4x4()
    me.transform(rot)
    lo = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
    hi = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
    k = spec["height"] / max(1e-6, hi.z - lo.z)
    c = (lo + hi) / 2
    me.transform(Matrix.Translation((-c.x, -c.y, -lo.z)))
    me.transform(Matrix.Rotation(math.radians(spec["yaw"]), 4, "Z") @ Matrix.Diagonal((k, k, k, 1.0)))
    x, y = spec["pos"]
    z = spec["z"] if spec["z"] is not None else ground_height(x, y)
    me.transform(Matrix.Translation((x, y, z - spec["sink"])))
    tris = sum(len(p.vertices) - 2 for p in me.polygons)
    if tris > spec["tris"]:
        decimate(obj, spec["tris"] / tris)
    # Photogrammetry exports are often unlit (emission only): rebuild each material as a diffuse
    # surface from its photographed texture, lifted a little (the colour already holds the site's
    # real shading) so it sits under our light.
    for slot in obj.material_slots:
        m = slot.material
        if not (m and m.node_tree):
            continue
        img = next((n.image for n in m.node_tree.nodes if n.type == "TEX_IMAGE" and n.image), None)
        nb = NodeBuilder(m)
        if img is not None:
            t = nb.node("ShaderNodeTexImage")
            t.image = img
            hsv = nb.node("ShaderNodeHueSaturation")
            hsv.inputs["Value"].default_value = 1.25
            hsv.inputs["Saturation"].default_value = 0.9
            nb.link(t.outputs["Color"], hsv.inputs["Color"])
            col = hsv.outputs["Color"]
        else:
            col = nb.mix(0.0, (0.4, 0.38, 0.33, 1.0), (0.4, 0.38, 0.33, 1.0))
        finish(nb, col, 0.9, None)
    for p in me.polygons:
        p.use_smooth = True
    lo2 = Vector([min(v.co[i] for v in me.vertices) for i in range(3)])
    hi2 = Vector([max(v.co[i] for v in me.vertices) for i in range(3)])
    print("SCAN", spec["name"], "triangles", sum(len(p.vertices) - 2 for p in me.polygons), "scale", round(k, 4), "box", tuple(round(x, 1) for x in lo2), tuple(round(x, 1) for x in hi2), "verts", len(me.vertices))
    return [obj]


def build_ceiba(mat):
    """A buttressed ceiba at the far left edge of the view: trunk rising out of frame, five fins."""
    base = Vector((-21.0, -6.0, PLAZA))
    bm = bmesh.new()
    rings = []
    seg = 40
    # Only the part below the top of the frame is ever seen (about 25 m at this distance).
    heights = np.concatenate([np.linspace(0, 6, 16), np.linspace(6.6, 28, 12)])
    fins = [rng.uniform(0, math.tau) for _ in range(5)]
    for z in heights:
        ring = []
        for k in range(seg):
            a = k / seg * math.tau
            r = 1.55 + 0.06 * noise.noise(Vector((math.cos(a) * 2, math.sin(a) * 2, z * 0.2)))
            for f in fins:
                da = math.atan2(math.sin(a - f), math.cos(a - f))
                fin = math.exp(-(da / 0.13) ** 2) * max(0.0, 5.5 - z) ** 1.4 * 0.62
                r += fin
            r *= 1.0 - 0.0035 * z
            ring.append(bm.verts.new((base.x + math.cos(a) * r, base.y + math.sin(a) * r, base.z + z - 0.3)))
        rings.append(ring)
    for j in range(len(rings) - 1):
        for k in range(seg):
            bm.faces.new((rings[j][k], rings[j][(k + 1) % seg], rings[j + 1][(k + 1) % seg], rings[j + 1][k]))
    return new_object("ceiba", bm, mat)


def tube_mesh(bm, path, radii, sides=8):
    """Appends a tube along a polyline with per-point radii to bm."""
    prev = None
    rings = []
    for i, p in enumerate(path):
        t = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        up = Vector((0, 0, 1)) if abs(t.z) < 0.9 else Vector((1, 0, 0))
        a = t.cross(up).normalized()
        b = t.cross(a).normalized()
        ring = []
        for k in range(sides):
            ang = k / sides * math.tau
            ring.append(bm.verts.new(p + (a * math.cos(ang) + b * math.sin(ang)) * radii[i]))
        rings.append(ring)
    for j in range(len(rings) - 1):
        for k in range(sides):
            bm.faces.new((rings[j][k], rings[j][(k + 1) % sides], rings[j + 1][(k + 1) % sides], rings[j + 1][k]))
    tip = bm.verts.new(path[-1] + (path[-1] - path[-2]).normalized() * radii[-1])
    for k in range(sides):
        bm.faces.new((rings[-1][k], rings[-1][(k + 1) % sides], tip))


def drape_roots(targets, starts, mat, seed=5, length=40.0, step=0.35, max_r=0.32):
    """Strangler-fig roots that flow down over the given meshes (gravity, hugging the surface, branching)."""
    deps = bpy.context.evaluated_depsgraph_get()
    bms = []
    for o in targets:
        b = bmesh.new()
        b.from_mesh(o.data)
        b.transform(o.matrix_world)
        bms.append(b)
    merged = bmesh.new()
    for b in bms:
        me = bpy.data.meshes.new("tmp")
        b.to_mesh(me)
        merged.from_mesh(me)
        bpy.data.meshes.remove(me)
        b.free()
    tree = BVHTree.FromBMesh(merged)
    r = random.Random(seed)
    out = bmesh.new()
    queue = [(Vector(s), max_r, length, Vector((r.uniform(-1, 1), r.uniform(-1, 1), 0)).normalized()) for s in starts]
    count = 0
    while queue and count < 140:
        pos, rad, rem, drift = queue.pop(0)
        count += 1
        path, radii = [], []
        p = pos.copy()
        dist = 0.0
        while dist < rem and rad > 0.025:
            loc, nrm, _, _ = tree.find_nearest(p)
            if loc is None:
                break
            if (loc - p).length < 2.0:
                p = loc + nrm * (rad * 0.75)
            path.append(p.copy())
            radii.append(rad)
            # Downhill along the surface, wandering sideways.
            g = Vector((0, 0, -1))
            down = (g - nrm * g.dot(nrm))
            if down.length < 0.05:
                down = drift.copy()
            down.normalize()
            wander = Vector((noise.noise(p * 0.4 + Vector((count, 0, 0))), noise.noise(p * 0.4 + Vector((0, count, 0))), 0))
            move = (down * 0.8 + drift * 0.35 + wander * 0.45).normalized()
            p = p + move * step
            dist += step
            rad *= 0.994
            if r.random() < 0.025 and rad > 0.07:
                queue.append((p.copy(), rad * 0.62, (rem - dist) * 0.7, Vector((r.uniform(-1, 1), r.uniform(-1, 1), 0)).normalized()))
            if p.z < PLAZA - 0.2:
                break
        if len(path) > 3:
            tube_mesh(out, path, radii, sides=7 if rad > 0.12 else 5)
    merged.free()
    return new_object("fig_roots", out, mat)


def canopy_mask():
    """Dappled canopy transmission (0 leaves .. 1 open) over CANOPY_RECT, as a numpy image (rows = +Y)."""
    n = CANOPY_RES
    x0, y0, x1, y1 = CANOPY_RECT
    px = (x1 - x0) / n
    r = np.random.default_rng(31)

    def blur(img, sigma_m):
        s = sigma_m / px
        f = np.fft.rfft2(img)
        ky = np.fft.fftfreq(n)[:, None]
        kx = np.fft.rfftfreq(n)[None, :]
        return np.fft.irfft2(f * np.exp(-2 * (math.pi ** 2) * (s ** 2) * (kx ** 2 + ky ** 2)), s=img.shape)

    field = np.zeros((n, n))
    for sigma, w in ((0.25, 0.55), (0.6, 0.9), (1.6, 1.0), (4.0, 0.8), (11.0, 0.7)):
        g = blur(r.standard_normal((n, n)), sigma)
        field += w * g / (g.std() + 1e-9)
    yy, xx = np.mgrid[0:n, 0:n]
    wx = x0 + (xx + 0.5) * px
    wy = y0 + (yy + 0.5) * px
    # Openness: the plaza is a clearing; denser canopy over the edges and the viewer.
    def bump(cx, cy, rx, ry):
        return np.exp(-(((wx - cx) / rx) ** 2 + ((wy - cy) / ry) ** 2))
    shift = (CANOPY_Z - PLAZA) * np.array([SUN.x / SUN.z, SUN.y / SUN.z])
    def at(x, y, z):
        k = (CANOPY_Z - z) / (CANOPY_Z - PLAZA)
        return x + k * shift[0], y + k * shift[1]

    openness = (-0.6 + 1.1 * bump(*at(0, 70, PLAZA), 55, 55) + 1.0 * bump(*at(-50, 58, 0.0), 22, 22)
                + 1.25 * bump(*at(36, 28, -2.0), 20, 18) + 0.6 * bump(*at(26, 22, PLAZA), 10, 10))
    t = field / field.std() + openness * 2.2
    mask = 1.0 / (1.0 + np.exp(-(t - 1.1) * 2.6))
    mask = blur(mask, 0.18)
    return np.clip(mask, 0, 1)


def build_canopy(mask):
    n = mask.shape[0]
    img = bpy.data.images.new("canopy_dapple", n, n, alpha=False, float_buffer=False)
    # Data, not colour: the game samples the same values linearly.
    img.colorspace_settings.name = "Non-Color"
    px = np.ones((n, n, 4), dtype=np.float32)
    px[..., 0] = px[..., 1] = px[..., 2] = mask
    img.pixels.foreach_set(px.ravel())
    path = os.path.join(ROOT, "assets", "blender", "source", "textures", "lost_kingdom_canopy.png")
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    x0, y0, x1, y1 = CANOPY_RECT
    bm = bmesh.new()
    vs = [bm.verts.new((x, y, CANOPY_Z)) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    f = bm.faces.new(vs)
    uv = bm.loops.layers.uv.new("UVMap")
    for loop, (u, v) in zip(f.loops, ((0, 0), (1, 0), (1, 1), (0, 1))):
        loop[uv].uv = (u, v)
    obj = new_object("canopy_gobo", bm)
    mat = bpy.data.materials.new("canopy_gobo")
    nb = NodeBuilder(mat)
    t = nb.node("ShaderNodeTexImage", interpolation="Linear")
    t.image = img
    tr = nb.node("ShaderNodeBsdfTransparent")
    df = nb.node("ShaderNodeBsdfDiffuse")
    df.inputs["Color"].default_value = (0.02, 0.03, 0.01, 1)
    mix = nb.node("ShaderNodeMixShader")
    nb.link(t.outputs["Color"], mix.inputs[0])
    nb.link(df.outputs[0], mix.inputs[1])
    nb.link(tr.outputs[0], mix.inputs[2])
    out = nb.node("ShaderNodeOutputMaterial")
    nb.link(mix.outputs[0], out.inputs["Surface"])
    obj.data.materials.append(mat)
    obj.visible_camera = False
    obj.visible_diffuse = False
    obj.visible_glossy = False
    obj.visible_transmission = False
    obj.visible_volume_scatter = False
    return obj, img


def setup_world(strength=1.0, sun=True):
    scene = bpy.context.scene
    world = bpy.data.worlds.new("rainforest")
    world.use_nodes = True
    nt = world.node_tree
    for nd in list(nt.nodes):
        nt.nodes.remove(nd)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    # Blender's equirectangular u = 0.5 - atan2(y, x) / 2pi; the game's view axis (+Y here) must land on PANO_OFFSET.
    mp.inputs["Rotation"].default_value = (0, 0, -(PANO_OFFSET - 0.25) * math.tau)
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(HDR, check_existing=True)
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = strength
    out = nt.nodes.new("ShaderNodeOutputWorld")
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    nt.links.new(mp.outputs[0], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs[0], out.inputs["Surface"])
    scene.world = world
    sun_obj = None
    if sun:
        ld = bpy.data.lights.new("sun", "SUN")
        ld.energy = SUN_STRENGTH
        ld.angle = math.radians(0.6)
        ld.color = (1.0, 0.95, 0.84)
        sun_obj = bpy.data.objects.new("sun", ld)
        scene.collection.objects.link(sun_obj)
        sun_obj.rotation_euler = (-SUN).to_track_quat("-Z", "Y").to_euler()
    return world, sun_obj


def setup_camera():
    scene = bpy.context.scene
    cd = bpy.data.cameras.new("game")
    cd.sensor_fit = "VERTICAL"
    cd.angle_y = math.radians(42.0)
    cd.clip_start = 1.0
    cd.clip_end = 3000.0
    cam = bpy.data.objects.new("game_camera", cd)
    scene.collection.objects.link(cam)
    cam.location = EYE
    cam.rotation_euler = (Vector((0, 0, 0)) - EYE).to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    return cam


def use_gpu(scene):
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    try:
        prefs.compute_device_type = "HIP"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = d.type == "HIP"
        scene.cycles.device = "GPU"
    except Exception as e:  # CPU fallback
        print("GPU unavailable:", e)
        scene.cycles.device = "CPU"


def build_all():
    common.reset_scene()
    scene = bpy.context.scene
    m_lime = limestone_material("limestone", stucco=0.3)
    m_lime_temple = limestone_material("limestone_temple", stucco=0.55, moss=0.7)
    m_rock = rock_material("rock")
    m_ground = ground_material("ground")
    m_bark = bark_material("bark")
    m_wood = bark_material("lintel_wood", moss=0.0)

    groups = {"pyramid": [], "floor": [], "plaza": [], "escarpment": [], "north": []}

    terr, soil, cap_z = build_pyramid(m_lime, m_ground)
    stair, (front_top, top_z) = build_stair(m_lime, cap_z)
    temple_parts, summit = build_temple(m_lime_temple, cap_z, m_wood)
    for o in temple_parts:
        subdivide_long_edges(o, 0.4)
        weather(o, 0.03, 0.08, 1.0, 4.0, 0.06)
    subdivide_long_edges(stair, 0.4)
    weather(terr, 0.04, 0.14, 1.4, 1.0, 0.13)
    weather(stair, 0.03, 0.1, 0.9, 2.0, 0.1)
    # Collapse at the front-right corner (local +X, -Y) and the stair foot's left side.
    a0, b0 = PYR["base"]
    h_t = PYR["height"] / PYR["terraces"]
    break_aprons(terr, h_t)
    zones = [
        (Vector((-a0 + 1.0, -b0 + 1.0, PLAZA + 7.0)), 7.0, 2.0, 0.6),
        (Vector((3.4, -b0 - 9.0, PLAZA + 1.5)), 4.6, 1.5, 0.9),
        (Vector((-a0 + 4.2, 3.0, PLAZA + 15.0)), 5.5, 1.6, 0.7),
        (Vector((7.5, -b0 + 4.0, PLAZA + 12.0)), 4.5, 1.4, 0.7),
    ]
    for o in (terr, soil, stair):
        for c, r_, d_, down in zones:
            slump(o, c, r_, d_, down)
        paint_damage(o, [(c, r_ * 1.08) for c, r_, d_, down in zones])
    for o in temple_parts:
        paint_damage(o, [(Vector((2.7, 1.7, summit)), 3.0)])
    pyramid_parts = [terr, soil, stair] + temple_parts
    for o in pyramid_parts:
        transform_obj(o, PYR["center"] - Vector((0, 0, PLAZA)) + Vector((0, 0, 0)), PYR["yaw"])
    # Rubble at the slumped corner and the stair foot.
    rot = Matrix.Rotation(math.radians(PYR["yaw"]), 3, "Z")
    c1 = PYR["center"] + rot @ Vector((-a0 - 2.0, -b0 - 2.0, 0))
    c2 = PYR["center"] + rot @ Vector((3.6, -b0 - 11.0, 0))
    talus1 = talus("talus_a", c1, (7.0, 6.0), 3.2, m_lime, 11)
    talus2 = talus("talus_b", c2, (4.5, 4.0), 1.6, m_lime, 12)
    rub1 = scatter_rubble("pyr_rubble_a", c1, 7.5, 34, 1.0, m_lime, talus_height, 11)
    rub2 = scatter_rubble("pyr_rubble_b", c2, 4.5, 18, 0.9, m_lime, talus_height, 12)
    groups["pyramid"] += pyramid_parts + [talus1, talus2, rub1, rub2]

    # Strangler fig: roots from the summit platform's front-right corner down the terraces.
    starts = [PYR["center"] + rot @ Vector((-PYR["top"][0] - 0.3 + rng.uniform(-0.6, 0.6), PYR["top"][1] - 1.2 + rng.uniform(-2.5, 2.0), cap_z - PLAZA - 0.6)) for _ in range(9)]
    starts += [PYR["center"] + rot @ Vector((-PYR["top"][0] + rng.uniform(0, 2), -PYR["top"][1] + rng.uniform(0, 1.5), cap_z - PLAZA + 0.1)) for _ in range(3)]
    roots = drape_roots([terr], starts, m_bark, 5, 46.0)
    groups["pyramid"].append(roots)
    corner = PYR["center"] + rot @ Vector((-PYR["top"][0] + 0.6, PYR["top"][1] - 1.2, cap_z - PLAZA - 0.8))
    groups["pyramid"].append(build_fig_trunk(m_bark, corner, (rot @ Vector((-0.7, 0.4, 0))).normalized()))

    esc = build_escarpment(m_rock)
    spill = build_spillway(m_lime)
    pool = build_pool(m_lime)
    for o in spill + pool:
        subdivide_long_edges(o, 0.4)
        weather(o, 0.03, 0.08, 1.0, 9.0, 0.08)
    groups["escarpment"] += [esc] + spill + pool

    ground = build_ground(m_ground)
    groups["floor"].append(ground)
    stelae = []
    for i, (x, y, yaw, h) in enumerate(((-13.0, 112.0, 0, 3.6), (-4.5, 113.0, 2, 3.9), (4.5, 113.0, -2, 3.7), (13.0, 112.0, 1, 3.4), (-26.0, 34.0, 62, 3.3))):
        s = build_stela(f"stela_{i}", Vector((x, y, ground_height(x, y) - 0.1)), 180 + yaw, h, m_lime_temple, 40 + i, lean=math.radians(rng.uniform(-3, 3)))
        stelae.append(s)
        stelae.append(build_altar(f"altar_{i}", Vector((x + 0.2, y - 2.2, ground_height(x, y - 2.2) - 0.15)), 0.85, m_lime_temple))
    fallen = build_stela("stela_fallen", Vector((-17.0, 14.0, ground_height(-17, 14) + 0.2)), 120, 3.5, m_lime_temple, 77, lean=math.radians(84))
    groups["plaza"] += stelae + [fallen]
    groups["plaza"].append(scatter_rubble("plaza_blocks", Vector((-14.0, 22.0, 0)), 9.0, 9, 0.9, m_lime, ground_height, 21))
    # (build_acropolis: the earlier masonry terrace on the outcrop, replaced by the Palenque scan.)
    # Real Maya architecture (Sketchfab photogrammetry, CC BY 4.0): Cahal Pech Structure B1 closes the
    # plaza behind the board, Palenque's Palace stands on the outcrop.
    groups["north"] += import_scan(SCAN_CAHAL)
    groups["escarpment"] += import_scan(SCAN_PALACE)
    groups["plaza"] += build_panel_wall(m_lime_temple)
    # (build_ceiba: a buttressed trunk at the far left edge; removed, it read as a dark border.)
    for name, g in groups.items():
        for o in g:
            organic = o.name.startswith(("fig_roots", "ceiba", "escarpment", "plaza_floor", "rubble", "pyr_rubble", "talus", "plaza_blocks"))
            if organic:
                for p in o.data.polygons:
                    p.use_smooth = True
            else:
                common.shade_smooth_by_angle(o, 32.0)
    return scene, groups


# ---------------------------------------------------------------------------------------------
# Vegetation (Poly Haven plant scans, instanced)
# ---------------------------------------------------------------------------------------------

SCANS = os.path.join(ROOT, "assets", "blender", "exports", "lost_kingdom", "scans")
# Prototype name -> (scan file, object name, scale range, sway weight). Scales make tropical-sized
# undergrowth from the scanned house and garden plants (fern clumps 1.5-3 m, broad leaves to 1 m).
PLANTS = {
    "fern_a": ("fern_02", "fern_02_b", (1.6, 3.0)),
    "fern_b": ("fern_02", "fern_02_c", (1.6, 3.0)),
    "fern_c": ("fern_02", "fern_02_a", (1.8, 3.2)),
    "aroid_a": ("anthurium_botany_01", "anthurium_botany_01_a", (1.8, 3.2)),
    "aroid_b": ("anthurium_botany_01", "anthurium_botany_01_b", (1.8, 3.2)),
    "aroid_c": ("anthurium_botany_01", "anthurium_botany_01_c", (2.0, 3.4)),
    "calathea_a": ("calathea_orbifolia_01", "calathea_orbifolia_01_a", (1.8, 3.0)),
    "calathea_b": ("calathea_orbifolia_01", "calathea_orbifolia_01_b", (2.0, 3.4)),
    "shrub_a": ("pachira_aquatica_01", "pachira_aquatica_01_d7", (2.2, 3.6)),
    "shrub_b": ("pachira_aquatica_01", "pachira_aquatica_01_c6", (2.0, 3.4)),
    "shrub_c": ("pachira_aquatica_01", "pachira_aquatica_01_a4", (2.0, 3.0)),
}
MIXES = {
    "terrace": [("fern_a", 3), ("fern_b", 3), ("fern_c", 2), ("aroid_a", 2), ("aroid_c", 2), ("calathea_b", 1), ("shrub_c", 1)],
    "ground": [("fern_a", 3), ("fern_b", 3), ("aroid_a", 2), ("aroid_b", 2), ("aroid_c", 1), ("calathea_a", 2), ("calathea_b", 1), ("shrub_a", 1), ("shrub_b", 1), ("shrub_c", 1)],
    "edge": [("shrub_a", 3), ("shrub_b", 2), ("fern_a", 2), ("aroid_a", 2), ("calathea_a", 1)],
    "ledge": [("fern_a", 3), ("fern_c", 3), ("aroid_c", 1)],
}


def load_plant_protos():
    coll = bpy.data.collections.new("plant_protos")
    bpy.context.scene.collection.children.link(coll)
    protos = {}
    loaded = {}
    for key, (scan, obj_name, _) in PLANTS.items():
        if scan not in loaded:
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=os.path.join(SCANS, f"{scan}.glb"))
            loaded[scan] = [o for o in bpy.data.objects if o not in before]
            for o in loaded[scan]:
                for c in list(o.users_collection):
                    c.objects.unlink(o)
                coll.objects.link(o)
                o.hide_render = True
                o.hide_viewport = True
        src = next((o for o in loaded[scan] if o.name.startswith(obj_name)), None)
        if src is None or src.type != "MESH":
            print("missing plant", obj_name)
            continue
        protos[key] = src
    return protos


def sample_surface(objs, count, accept, seed):
    """Area-weighted random points on the faces of objs that pass accept(point, normal) (rejection)."""
    r = random.Random(seed)
    faces = []
    total = 0.0
    for o in objs:
        me = o.data
        me.calc_loop_triangles()
        for tri in me.loop_triangles:
            a = tri.area
            if a <= 0:
                continue
            total += a
            faces.append((total, o, tri))
    out = []
    tries = 0
    while len(out) < count and tries < count * 40 and faces:
        tries += 1
        x = r.random() * total
        lo, hi = 0, len(faces) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if faces[mid][0] < x:
                lo = mid + 1
            else:
                hi = mid
        _, o, tri = faces[lo]
        me = o.data
        u, v = r.random(), r.random()
        if u + v > 1:
            u, v = 1 - u, 1 - v
        pa, pb, pc = (me.vertices[i].co for i in tri.vertices)
        p = pa + (pb - pa) * u + (pc - pa) * v
        n = tri.normal
        if accept(p, n, r):
            out.append((p.copy(), n.copy()))
    return out


def place_plants(protos, points, mix, seed, coll, tilt=0.25, sink=0.06, scale_mul=1.0):
    r = random.Random(seed)
    keys = [k for k, w in mix for _ in range(w) if k in protos]
    placed = []
    for p, n in points:
        key = r.choice(keys)
        src = protos[key]
        lo, hi = PLANTS[key][2]
        sc = (lo + (hi - lo) * r.random() ** 1.5) * scale_mul
        inst = bpy.data.objects.new(f"veg_{key}", src.data)
        coll.objects.link(inst)
        up = Vector((0, 0, 1)).lerp(n, tilt).normalized()
        rot = up.to_track_quat("Z", "Y").to_matrix().to_4x4() @ Matrix.Rotation(r.random() * math.tau, 4, "Z")
        inst.matrix_world = Matrix.Translation(p - up * sink * sc) @ rot @ Matrix.Diagonal((sc, sc, sc * (0.85 + 0.3 * r.random()), 1.0))
        placed.append(inst)
    return placed


def build_vegetation(groups):
    protos = load_plant_protos()
    coll = bpy.data.collections.new("vegetation")
    bpy.context.scene.collection.children.link(coll)
    plants = []
    pyr = [o for o in groups["pyramid"] if o.name.startswith("pyramid_soil")]
    def terrace_ok(p, n, r):
        if n.z < 0.5:
            return False
        clump = noise.noise(Vector((p.x * 0.16, p.y * 0.16, p.z * 0.1 + 7.0))) * 0.5 + 0.5
        return r.random() < 0.05 + 1.4 * max(0.0, clump - 0.42)

    plants += place_plants(protos, sample_surface(pyr, 900, terrace_ok, 101), MIXES["terrace"], 102, coll, 0.3, 0.05, 1.15)
    # Summit platform and temple roof.
    tops = [o for o in groups["pyramid"] if o.name.startswith(("temple_platform", "temple_frieze", "comb", "pyramid_terraces"))]
    plants += place_plants(protos, sample_surface(tops, 120, lambda p, n, r: n.z > 0.85 and p.z > PLAZA + 14, 103), MIXES["terrace"], 104, coll, 0.2, 0.05, 0.9)
    ground = groups["floor"]

    def ground_ok(p, n, r):
        x, y = p.x, p.y
        if y < 6 or n.z < 0.6:
            return False
        # Dense at the edges, near walls and monuments; open patches in the plaza.
        edge = max(0.0, min(1.0, (abs(x + 8) - 26) / 30.0)) + max(0.0, min(1.0, (y - 95) / 25.0))
        clump = noise.noise(Vector((x * 0.06, y * 0.06, 4.0))) * 0.5 + 0.5
        dens = 0.08 + 0.9 * min(1.0, edge) + 0.5 * max(0.0, clump - 0.55)
        # Keep the pyramid stair foot and the pool readable.
        if (Vector((x, y, 0)) - Vector((-38.0, 44.0, 0))).length < 9:
            dens *= 0.25
        if 4 < y < 36 and abs(x - 0.446 * (y + 30)) < 7.0:
            dens *= 0.1
        return r.random() < dens

    pts = sample_surface(ground, 5200, ground_ok, 105)
    near = [q for q in pts if q[0].y < 45]
    far = [q for q in pts if q[0].y >= 45]
    plants += place_plants(protos, far, MIXES["ground"], 106, coll, 0.15, 0.05, 1.7)
    plants += place_plants(protos, near, MIXES["ground"], 116, coll, 0.15, 0.05, 2.6)

    def edge_ok(p, n, r):
        x, y = p.x, p.y
        band = (100 < y < 175) or (abs(x + 8) > 55 and y > 40)
        return band and n.z > 0.6 and r.random() < 0.5

    tall = sample_surface(ground, 140, edge_ok, 117)
    plants += place_plants(protos, tall, [("shrub_a", 3), ("shrub_b", 2), ("aroid_a", 1)], 118, coll, 0.1, 0.05, 2.2)
    esc = [o for o in groups["escarpment"] if o.name.startswith(("escarpment", "acropolis_wall", "palace"))]
    plants += place_plants(protos, sample_surface(esc, 900, lambda p, n, r: n.z > 0.5 and r.random() < 0.9, 107), MIXES["ledge"], 108, coll, 0.35, 0.05, 1.4)
    north = groups["north"]
    plants += place_plants(protos, sample_surface(north, 700, lambda p, n, r: n.z > 0.8, 109), MIXES["terrace"], 110, coll, 0.2, 0.05, 1.6)
    print("plants", len(plants))
    return plants


# ---------------------------------------------------------------------------------------------
# Bake and export
# ---------------------------------------------------------------------------------------------

# Group -> (albedo and sun resolution, sky light resolution).
BAKE_RES = {"pyramid": (4096, 2048), "floor": (4096, 2048), "plaza": (2048, 1024), "escarpment": (4096, 2048), "north": (2048, 1024)}
ENV_SCALE = 2.0


def join_group(name, objs):
    """Joined copy of a group's meshes (materials kept per face), ready for unwrapping."""
    copies = []
    for o in objs:
        if o.type != "MESH" or not o.data.polygons:
            continue
        c = o.copy()
        c.data = o.data.copy()
        bpy.context.scene.collection.objects.link(c)
        copies.append(c)
    bpy.ops.object.select_all(action="DESELECT")
    for c in copies:
        c.select_set(True)
    bpy.context.view_layer.objects.active = copies[0]
    bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = f"bake_{name}"
    obj.data.name = f"bake_{name}"
    return obj


def split_hidden(obj):
    """Moves faces that never face the player's eye into a shadow-only object (baked against, not exported)."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    away = [f for f in bm.faces if f.normal.dot((EYE - f.calc_center_median()).normalized()) < -0.02]
    hidden_bm = bm.copy()
    keep_idx = {f.index for f in away}
    bmesh.ops.delete(bm, geom=away, context="FACES")
    bm.to_mesh(me)
    bm.free()
    hidden_bm.faces.ensure_lookup_table()
    drop = [f for f in hidden_bm.faces if f.index not in keep_idx]
    bmesh.ops.delete(hidden_bm, geom=drop, context="FACES")
    hme = bpy.data.meshes.new(obj.name + "_hidden")
    hidden_bm.to_mesh(hme)
    hidden_bm.free()
    for m in me.materials:
        hme.materials.append(m)
    hobj = bpy.data.objects.new(obj.name + "_hidden", hme)
    bpy.context.scene.collection.objects.link(hobj)
    return hobj


def uv_islands(bm, uv):
    """Faces grouped into UV islands (connected through edges whose UVs agree on both sides)."""
    parent = list(range(len(bm.faces)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    bm.faces.ensure_lookup_table()
    for e in bm.edges:
        if len(e.link_faces) != 2:
            continue
        f1, f2 = e.link_faces
        uvs = []
        for f in (f1, f2):
            d = {l.vert.index: l[uv].uv.copy() for l in f.loops if l.vert in e.verts}
            uvs.append(d)
        if all((uvs[0][k] - uvs[1][k]).length < 1e-5 for k in uvs[0] if k in uvs[1]):
            a, b = find(f1.index), find(f2.index)
            if a != b:
                parent[a] = b
    groups = {}
    for f in bm.faces:
        groups.setdefault(find(f.index), []).append(f)
    return list(groups.values())


def unwrap(obj, margin=0.0015, ref=45.0):
    """Smart-projected islands scaled for a roughly even density on screen (nearer = more texels)."""
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    me.uv_layers.new(name="bake")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=margin, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.object.mode_set(mode="OBJECT")
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.active
    for faces in uv_islands(bm, uv):
        c = sum((f.calc_center_median() for f in faces), Vector()) / len(faces)
        k = max(0.3, min(2.5, ref / max(5.0, (c - EYE).length)))
        cu = Vector((0.0, 0.0))
        n = 0
        for f in faces:
            for l in f.loops:
                cu += l[uv].uv
                n += 1
        cu /= max(1, n)
        for f in faces:
            for l in f.loops:
                l[uv].uv = cu + (l[uv].uv - cu) * k
    bm.to_mesh(me)
    bm.free()
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    try:
        bpy.ops.uv.pack_islands(rotate=True, rotate_method="AXIS_ALIGNED", shape_method="CONCAVE", margin=margin, scale=True)
    except TypeError:
        bpy.ops.uv.pack_islands(rotate=True, margin=margin, scale=True)
    bpy.ops.object.mode_set(mode="OBJECT")


def unwrap_floor(obj, r0=12.0, r1=260.0, a0=-75.0, a1=75.0):
    """The plaza floor in perspective: u by azimuth and v by log distance from the eye, so texels on
    screen are about even from the nearest paving to the forest edge."""
    me = obj.data
    while me.uv_layers:
        me.uv_layers.remove(me.uv_layers[0])
    layer = me.uv_layers.new(name="bake")
    la, l0, l1 = math.radians(a1 - a0), math.log(r0), math.log(r1)
    for loop in me.loops:
        v = me.vertices[loop.vertex_index].co
        dx, dy = v.x - EYE.x, v.y - EYE.y
        az = math.degrees(math.atan2(dx, dy))
        r = max(r0, math.hypot(dx, dy))
        layer.data[loop.index].uv = ((az - a0) / (a1 - a0), (math.log(min(r, r1)) - l0) / (l1 - l0))


def bake_target(obj, img):
    """Points every material of obj at img (an unconnected, active image node: Cycles' bake target)."""
    for slot in obj.material_slots:
        m = slot.material
        if m is None:
            continue
        nt = m.node_tree
        node = nt.nodes.get("__bake__")
        if node is None:
            node = nt.nodes.new("ShaderNodeTexImage")
            node.name = "__bake__"
        node.image = img
        for n in nt.nodes:
            n.select = False
        node.select = True
        nt.nodes.active = node


def run_bake(obj, kind, passes, samples, margin):
    scene = bpy.context.scene
    scene.cycles.samples = samples
    scene.render.bake.use_clear = True
    scene.render.bake.margin = margin
    scene.render.bake.margin_type = "EXTEND"
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type=kind, pass_filter=passes, use_clear=True, margin=margin)


def pixels(img):
    a = np.empty(img.size[0] * img.size[1] * 4, dtype=np.float32)
    img.pixels.foreach_get(a)
    return a.reshape(img.size[1], img.size[0], 4)


def srgb_encode(x):
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def save_png(name, arr, path, colour=True):
    """8-bit PNG; byte images hold encoded values, so colour channels are sRGB-encoded here (alpha stays linear)."""
    h, w = arr.shape[:2]
    out = np.array(arr, dtype=np.float32)
    if colour:
        out[..., :3] = srgb_encode(out[..., :3])
    img = bpy.data.images.new(name, w, h, alpha=True, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    img.pixels.foreach_set(np.ascontiguousarray(out, dtype=np.float32).ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    return img


def denoise(arr, strength=1.0):
    """Light edge-aware smoothing of a baked lighting pass (removes sampling grain, keeps shadow edges)."""
    from numpy.lib.stride_tricks import sliding_window_view  # noqa: F401
    out = arr.copy()
    k = np.array([1, 4, 6, 4, 1], dtype=np.float32) / 16.0
    for axis in (0, 1):
        out = sum(np.roll(out, i - 2, axis=axis) * k[i] for i in range(5))
    lum_a = arr[..., :3].mean(-1, keepdims=True)
    lum_b = out[..., :3].mean(-1, keepdims=True)
    w = np.exp(-np.abs(lum_a - lum_b) / (0.08 * strength + 1e-4))
    return arr * (1 - w) + out * w


def glow_material():
    m = bpy.data.materials.new("__glow__")
    nb = NodeBuilder(m)
    sep = nb.node("ShaderNodeSeparateColor")
    nb.link(nb.attr("glow"), sep.inputs["Color"])
    em = nb.node("ShaderNodeEmission")
    nb.link(sep.outputs[0], em.inputs["Strength"])
    em.inputs["Color"].default_value = (1, 1, 1, 1)
    out = nb.node("ShaderNodeOutputMaterial")
    nb.link(em.outputs[0], out.inputs["Surface"])
    return m


def bake_group(name, objs, world, sun, gobo, samples):
    res, res_env = BAKE_RES[name]
    obj = join_group(name, objs)
    for i, slot in enumerate(obj.material_slots):
        if slot.material is None:
            slot.material = bpy.data.materials.get("limestone")
    hidden = split_hidden(obj)
    for o in objs:
        o.hide_render = True
    if name == "floor":
        unwrap_floor(obj)
    else:
        unwrap(obj)
    scene = bpy.context.scene
    bg = world.node_tree.nodes["Background"]
    env_strength = bg.inputs["Strength"].default_value

    def image(label, r):
        img = bpy.data.images.new(f"{name}_{label}", r, r, alpha=True, float_buffer=True)
        img.colorspace_settings.name = "Non-Color"
        img.generated_color = (0.0, 0.0, 0.0, 0.0)
        return img

    # 1. Albedo (diffuse colour only).
    alb = image("albedo", res)
    bake_target(obj, alb)
    run_bake(obj, "DIFFUSE", {"COLOR"}, 1, 8)
    # 2. Direct sun through the canopy (no sky).
    bg.inputs["Strength"].default_value = 0.0
    sun.hide_render = False
    gobo.hide_render = False
    sun_img = image("sun", res)
    bake_target(obj, sun_img)
    run_bake(obj, "DIFFUSE", {"DIRECT"}, max(8, samples // 4), 8)
    # 3. Sun bounce (indirect only), small.
    bounce = image("bounce", max(512, res_env // 2))
    bake_target(obj, bounce)
    run_bake(obj, "DIFFUSE", {"INDIRECT"}, samples, 8)
    # 4. Sky light: the photograph's surroundings, direct and indirect, without the canopy mask.
    bg.inputs["Strength"].default_value = env_strength
    sun.hide_render = True
    gobo.hide_render = True
    env = image("env", res_env)
    bake_target(obj, env)
    run_bake(obj, "DIFFUSE", {"DIRECT", "INDIRECT"}, samples, 8)
    # 5. Glow mask (carved glyphs), emission pass with a mask material.
    saved = [s.material for s in obj.material_slots]
    gm = glow_material()
    for s in obj.material_slots:
        s.material = gm
    glow = image("glow", res_env)
    bake_target(obj, glow)
    run_bake(obj, "EMIT", set(), 1, 8)
    for s, m in zip(obj.material_slots, saved):
        s.material = m
    sun.hide_render = False
    gobo.hide_render = False
    for o in objs:
        o.hide_render = False
    bpy.data.objects.remove(hidden, do_unlink=True)

    A = pixels(alb)
    S = pixels(sun_img)
    B = pixels(bounce)
    E = pixels(env)
    G = pixels(glow)
    sun_col = np.array(list(sun.data.color), dtype=np.float32)
    s_lum = S[..., 1] / max(1e-4, float(sun_col[1]))
    sun_eff = float(np.percentile(s_lum[A[..., 3] > 0.5], 99.7)) if np.any(A[..., 3] > 0.5) else 1.0
    sun_eff = max(sun_eff, 1e-3) * 1.02
    S_n = np.clip(denoise(np.repeat(s_lum[..., None] / sun_eff, 4, -1), 0.6)[..., 0], 0, 1)
    # Bounce upsampled to the sky-light resolution and added to it.
    if B.shape[0] != E.shape[0]:
        f = E.shape[0] // B.shape[0]
        B = np.repeat(np.repeat(B, f, 0), f, 1)
    E_tot = denoise(E, 1.0)[..., :3] + denoise(B, 1.0)[..., :3]
    out_dir = common.ensure_dir(os.path.join(OUT, "textures"))
    albedo_sun = np.concatenate([A[..., :3], S_n[..., None]], -1)
    p_alb = os.path.join(out_dir, f"{name}_albedo_sun.png")
    p_env = os.path.join(out_dir, f"{name}_light.png")
    save_png(f"{name}_albedo_sun_out", albedo_sun, p_alb, True)
    g = np.clip(G[..., :1], 0, 1)
    save_png(f"{name}_light_out", np.concatenate([np.clip(E_tot / ENV_SCALE, 0, 1), g], -1), p_env, True)
    stats = {
        "sunEff": round(sun_eff, 4),
        "envScale": ENV_SCALE,
        "res": res,
        "resLight": res_env,
        "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons),
        "albedoMean": [round(float(x), 4) for x in A[..., :3][A[..., 3] > 0.5].mean(0)] if np.any(A[..., 3] > 0.5) else None,
    }
    return obj, p_alb, p_env, stats


def export_group(obj, p_alb, p_env, path):
    """Replaces the group's bake materials with one glTF material carrying the baked maps."""
    m = bpy.data.materials.new(obj.name.replace("bake_", "lk_"))
    nb = NodeBuilder(m)
    t1 = nb.node("ShaderNodeTexImage")
    t1.image = bpy.data.images.load(p_alb, check_existing=True)
    t2 = nb.node("ShaderNodeTexImage")
    t2.image = bpy.data.images.load(p_env, check_existing=True)
    bsdf = nb.node("ShaderNodeBsdfPrincipled")
    nb.link(t1.outputs["Color"], bsdf.inputs["Base Color"])
    nb.link(t2.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0
    out = nb.node("ShaderNodeOutputMaterial")
    nb.link(bsdf.outputs["BSDF"], out.inputs["Surface"])
    obj.data.materials.clear()
    obj.data.materials.append(m)
    for p in obj.data.polygons:
        p.material_index = 0
    # Drop colour attributes and the vertex groups: the textures carry everything.
    for a in list(obj.data.color_attributes):
        obj.data.color_attributes.remove(a)
    common.export_glb([obj], path)


def export_vegetation(plants, path):
    """Plant instances (linked duplicates) as one GLB; glTF-Transform turns repeats into GPU instancing."""
    bpy.ops.object.select_all(action="DESELECT")
    for p in plants:
        p.hide_render = False
        p.hide_viewport = False
        p.select_set(True)
    kwargs = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=False, export_texcoords=True, export_normals=True, export_materials="EXPORT", export_yup=True)
    bpy.ops.export_scene.gltf(**kwargs)


def bake_all(groups, plants, world, sun, gobo, samples):
    common.ensure_dir(OUT)
    use_gpu(bpy.context.scene)
    meta = {"generator": "assets/blender/scripts/lost_kingdom.py", "license": "Original work for Prismfall (textures derived from CC0 Poly Haven photographs)", "groups": {}}
    meta_path = os.path.join(OUT, "lost_kingdom.meta.json")
    if os.path.exists(meta_path):
        # A partial bake (--groups) keeps the other groups' records.
        meta["groups"] = json.load(open(meta_path, encoding="utf-8")).get("groups", {})
    only = arg("--groups")
    rs = float(arg("--res-scale", 1.0))
    if rs != 1.0:
        for k in BAKE_RES:
            BAKE_RES[k] = (int(BAKE_RES[k][0] * rs), int(BAKE_RES[k][1] * rs))
    for name, objs in groups.items():
        if only and name not in only.split(","):
            continue
        obj, p_alb, p_env, stats = bake_group(name, objs, world, sun, gobo, samples)
        export_group(obj, p_alb, p_env, os.path.join(OUT, f"{name}.glb"))
        meta["groups"][name] = stats
        print(f"BAKED {name} {stats}")
    export_vegetation(plants, os.path.join(OUT, "vegetation.glb"))
    meta["plants"] = len(plants)
    meta["sun"] = {"direction": [round(SUN.x, 4), round(SUN.z, 4), round(-SUN.y, 4)], "color": list(sun.data.color), "strength": SUN_STRENGTH}
    meta["canopy"] = {"z": CANOPY_Z, "rect": CANOPY_RECT}
    common.write_metadata(os.path.join(OUT, "lost_kingdom.meta.json"), meta)
    # The canopy mask the game samples for the same dappled sun.
    print("BAKE_DONE")


def render_preview(path, samples, scale):
    scene = bpy.context.scene
    use_gpu(scene)
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = 2560
    scene.render.resolution_y = 1080
    scene.render.resolution_percentage = int(scale * 100)
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.filepath = path
    scene.render.image_settings.file_format = "JPEG"
    bpy.ops.render.render(write_still=True)


def main():
    scene, groups = build_all()
    plants = [] if arg("--no-veg") else build_vegetation(groups)
    mask = canopy_mask()
    gobo, _ = build_canopy(mask)
    world, sun = setup_world(ENV_STRENGTH, True)
    cam = setup_camera()
    view = arg("--view")
    if view:
        # --view x,y,z,tx,ty,tz,fov (Blender coordinates): a close-up camera for inspection.
        v = [float(t) for t in view.split(",")]
        cam.location = Vector(v[0:3])
        cam.rotation_euler = (Vector(v[3:6]) - Vector(v[0:3])).to_track_quat("-Z", "Y").to_euler()
        cam.data.angle_y = math.radians(v[6])
    preview = arg("--preview")
    if preview:
        render_preview(preview, int(arg("--samples", 48)), float(arg("--scale", 0.5)))
    if arg("--bake"):
        bake_all(groups, plants, world, sun, gobo, int(arg("--samples", 96)))
    if arg("--save"):
        common.save_blend(SRC)
    print("LOST_KINGDOM_OK")


main()
