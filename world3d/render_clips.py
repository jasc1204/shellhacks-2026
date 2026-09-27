"""GridLock fly-in clips: a ~7 s cinematic Blender render of one ranked overlap, for local previews only.
(The site shows no videos since 0b1e176, so clips land in the git-ignored world3d/explore/clips/, not web/public.)

Headless, one clip per run (a few minutes each on an RTX 3070 laptop):
  blender -b --factory-startup -P world3d/render_clips.py -- DESC_23__GPC_20277
  blender -b --factory-startup -P world3d/render_clips.py -- 1                  (a global rank works too)
Options:
  --seconds 7  --fps 24  --res 1280x720  --samples 48
  --tmp DIR        where the PNG frames go (deleted after encoding unless --keep)
  --still 1,168    look test: render only these frames as PNGs into --tmp, no video
  --manifest       only rewrite world3d/explore/clips/manifest.json from the clips already there

Explore mode (no rendering): the same look for a whole level, saved as a .blend to fly around in:
  blender -b --factory-startup -P world3d/render_clips.py -- --explore savannah      (or augusta)
  --top 10         highlight every overlap of this global rank or better inside the level
  --out PATH       default world3d/explore/<level>.blend (git-ignored; image paths stay relative, nothing packed)
  a positional id or rank picks the main overlap (default: #1 for savannah, #3 for augusta)
The main overlap's fly-in is the active camera (Space plays it, Numpad 0 looks through it). The Layout 3D view opens
in EEVEE Rendered with the bloom compositor, km-scale clipping, at the fly-in's first frame.

Writes world3d/explore/clips/<id>.mp4 (H.264 yuv420p, no audio), <id>.jpg (poster: the final framing) and
manifest.json (every clip whose files exist and probe as playable). Overlay the facts separately: the frames
carry no text. Only our own data: USGS imagery (public domain), OpenStreetMap grid, yards and buildings, AWS terrain.

The camera starts ~2.5 km out and ~900 m up, then eases in (orbiting 40 degrees) to a framing solved per overlap so
both projects and the gap between them sit inside the frame (wide gaps get a proportionally higher, wider view).
Colors follow the app's key: DESC sky-blue, Georgia Power yellow, today's grid blue, towers steel, overlap white.
"""
import hashlib
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import build_world as bw  # noqa: E402  (shared helpers: Terrain, tower_mesh, curve_object, lin, node_mat)

BUILD = HERE / "build"
OUT = HERE / "explore" / "clips"   # git-ignored; the site itself shows no videos

SUN_AZ, SUN_EL = 160.0, 35.0   # compass bearing + elevation: from the south-southeast, like the imagery's own shadows
SUN_E = 6.5                    # sun lamp strength
SKY_K = 0.06                   # the multiple-scattering sky is ~20x brighter than our sun lamp scale
HAZE = (0.34, 0.47, 0.70)      # linear haze color side-on to the sun (the world's horizon uses the same function)
HAZE_SUN = (0.40, 0.34, 0.22)  # added toward the sun (forward scattering)
RHO, HS = 4.6e-5, 1500.0       # haze extinction per m at sea level, scale height in m (half visibility ~15 km)
FAR = 45000.0                  # plus (d / FAR)^2 so the far land melts into the sky; set per clip (wide shots push it out)
LIFT = 140.0                   # planned corridors float this far above the land, as in the viewer
LENS = 28.0
TOUCH_R = 120.0                # ring around a touching point (the shared yard)
ORBIT = 40.0                   # degrees the camera swings around the target during the glide
EDGE = 2500.0                  # the level eases to sea level over its last 2.5 km (as the viewer) to meet the far ground
COL = {"DESC": "#4dd8ff", "GPC": "#ffd166", "grid": "#3b7dff", "steel": "#7aa8ff", "ice": "#f4f8ff"}


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    o = {"key": None, "seconds": "7", "fps": "24", "res": "1280x720", "samples": "48", "still": None,
         "tmp": str(Path(tempfile.gettempdir()) / "gridlock_clips"), "keep": False, "manifest": False,
         "explore": None, "top": "10", "out": None}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            k = a[2:]
            if k in ("keep", "manifest"):
                o[k] = True
            else:
                o[k] = argv[i + 1]
                i += 1
        else:
            o["key"] = a
        i += 1
    return o


def log(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------- data
def level_names():
    return [lv["level"] for lv in json.load(open(BUILD / "levels.json", encoding="utf-8"))]


def load_scene(level):
    return json.load(open(BUILD / level / "scene.json", encoding="utf-8"))


def find_overlap(key):
    for lv in level_names():
        scene = load_scene(lv)
        for o in scene["overlaps"]:
            if o["id"] == key or (key.isdigit() and o["rank"] == int(key)):
                return lv, scene, o
    raise SystemExit(f"overlap {key!r} not found in {level_names()}")


def sun_dir():
    az, el = math.radians(SUN_AZ), math.radians(SUN_EL)
    return Vector((math.sin(az) * math.cos(el), math.cos(az) * math.cos(el), math.sin(el)))


def edge_k(x, y, w, h):
    t = np.clip(np.minimum(w / 2 - np.abs(x), h / 2 - np.abs(y)) / EDGE, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def kv_of(name):
    kvs = [int(m) for m in re.findall(r"(\d{2,3})\s*kv", name or "", re.I)]
    return max(kvs) if kvs else 115


def tower_h(kv):
    return 48.0 if kv >= 500 else 36.0 if kv >= 230 else 27.0 if kv >= 100 else 20.0


def owner_of(op):
    op = op or ""
    if re.search(r"georgia power|savannah electric", op, re.I):
        return "GPC"
    if re.search(r"dominion|south carolina electric|sce&g", op, re.I):
        return "DESC"
    return "other"


# ---------------------------------------------------------------- node helpers
class NT:
    """Small node-tree builder so the shader math reads like math."""

    def __init__(self, tree):
        self.t = tree

    def node(self, kind, **inputs):
        n = self.t.nodes.new(kind)
        for k, v in inputs.items():
            self.put(n.inputs[k], v)
        return n

    def put(self, sock, v):
        if isinstance(v, bpy.types.NodeSocket):
            self.t.links.new(v, sock)
        else:
            sock.default_value = v

    def link(self, a, b):
        self.t.links.new(a, b)

    def math(self, op, a, b=None, clamp=False):
        n = self.t.nodes.new("ShaderNodeMath")
        n.operation = op
        n.use_clamp = clamp
        self.put(n.inputs[0], a)
        if b is not None:
            self.put(n.inputs[1], b)
        return n.outputs[0]

    def mix_rgb(self, fac, a, b, blend="MIX"):
        n = self.t.nodes.new("ShaderNodeMix")
        n.data_type = "RGBA"
        n.blend_type = blend
        s = {x.identifier: x for x in n.inputs}
        self.put(s["Factor_Float"], fac)
        self.put(s["A_Color"], a)
        self.put(s["B_Color"], b)
        return next(x for x in n.outputs if x.identifier == "Result_Color")


def haze_color_group():
    """Haze color seen along a view direction: bluish grey, warmer toward the sun. Shared by materials and the sky."""
    ng = bpy.data.node_groups.new("haze color", "ShaderNodeTree")
    ng.interface.new_socket(name="Dir", in_out="INPUT", socket_type="NodeSocketVector")
    ng.interface.new_socket(name="Color", in_out="OUTPUT", socket_type="NodeSocketColor")
    b = NT(ng)
    gi, go = ng.nodes.new("NodeGroupInput"), ng.nodes.new("NodeGroupOutput")
    dot = b.node("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    b.link(gi.outputs[0], dot.inputs[0])
    dot.inputs[1].default_value = sun_dir()
    t = b.math("POWER", b.math("MAXIMUM", dot.outputs["Value"], 0.0), 5.0)
    b.link(b.mix_rgb(t, HAZE + (1.0,), HAZE_SUN + (1.0,), "ADD"), go.inputs[0])
    return ng


def haze_group(hcol):
    """Aerial perspective for any surface: mixes it toward the haze color by an exponential-height fog integrated
    from the camera to the point (thick near the ground, thin looking down from altitude). Also outputs Keep
    (light that survives the haze, for additive glows) and the view distance."""
    ng = bpy.data.node_groups.new("haze", "ShaderNodeTree")
    ng.interface.new_socket(name="Shader", in_out="INPUT", socket_type="NodeSocketShader")
    ng.interface.new_socket(name="Shader", in_out="OUTPUT", socket_type="NodeSocketShader")
    ng.interface.new_socket(name="Keep", in_out="OUTPUT", socket_type="NodeSocketFloat")
    ng.interface.new_socket(name="Distance", in_out="OUTPUT", socket_type="NodeSocketFloat")
    b = NT(ng)
    gi, go = ng.nodes.new("NodeGroupInput"), ng.nodes.new("NodeGroupOutput")
    geo = b.node("ShaderNodeNewGeometry")
    cam = b.node("ShaderNodeCameraData")
    d = cam.outputs["View Distance"]
    sp = b.node("ShaderNodeSeparateXYZ")
    b.link(geo.outputs["Position"], sp.inputs[0])
    si = b.node("ShaderNodeSeparateXYZ")
    b.link(geo.outputs["Incoming"], si.inputs[0])
    x = b.math("MAXIMUM", b.math("DIVIDE", b.math("MULTIPLY", si.outputs["Z"], d), HS), 0.001)  # climb toward camera
    ratio = b.math("DIVIDE", b.math("SUBTRACT", 1.0, b.math("EXPONENT", b.math("MULTIPLY", x, -1.0))), x)
    dens = b.math("EXPONENT", b.math("DIVIDE", b.math("MAXIMUM", sp.outputs["Z"], 0.0), -HS))
    tau = b.math("MULTIPLY", b.math("MULTIPLY", b.math("MULTIPLY", d, RHO), dens), ratio)
    tau = b.math("ADD", tau, b.math("POWER", b.math("DIVIDE", d, FAR), 2.0))
    keep = b.math("EXPONENT", b.math("MULTIPLY", tau, -1.0))
    fog = b.math("SUBTRACT", 1.0, keep)
    neg = b.node("ShaderNodeVectorMath")
    neg.operation = "SCALE"
    b.link(geo.outputs["Incoming"], neg.inputs[0])
    neg.inputs["Scale"].default_value = -1.0
    hc = b.node("ShaderNodeGroup")
    hc.node_tree = hcol
    b.link(neg.outputs[0], hc.inputs[0])
    em = b.node("ShaderNodeEmission", Strength=1.0)
    b.link(hc.outputs[0], em.inputs["Color"])
    mix = b.node("ShaderNodeMixShader")
    b.link(fog, mix.inputs[0])
    b.link(gi.outputs[0], mix.inputs[1])
    b.link(em.outputs[0], mix.inputs[2])
    b.link(mix.outputs[0], go.inputs[0])
    b.link(keep, go.inputs[1])
    b.link(d, go.inputs[2])
    return ng


class Looks:
    """All materials for one clip (few shaders = short EEVEE compile)."""

    def __init__(self):
        self.hcol = haze_color_group()
        self.hz = haze_group(self.hcol)
        self.cache = {}

    def _new(self, name):
        m, nt, out = bw.node_mat(name)
        return m, nt, out, NT(nt)

    def _hazed(self, nt, out, shader):
        g = nt.nodes.new("ShaderNodeGroup")
        g.node_tree = self.hz
        nt.links.new(shader, g.inputs[0])
        nt.links.new(g.outputs[0], out.inputs["Surface"])
        return g

    def glow(self, color, strength):
        """Opaque neon tube (lines, arcs, rails): pure emission, hazed with distance."""
        key = ("glow", color, strength)
        if key not in self.cache:
            m, nt, out, b = self._new(f"glow {color} {strength}")
            em = b.node("ShaderNodeEmission", Color=bw.lin(color), Strength=strength)
            self._hazed(nt, out, em.outputs[0])
            self.cache[key] = m
        return self.cache[key]

    def light(self, color, strength, fade=None, power=1.6, near=None):
        """Additive light (beams, curtains, fences, ghost towers, faint rings): order-free, dimmed by the haze.
        fade 'z': bright at the base of the object's box; 'v': bright where UV v = 1. near=(a, b): fade in with distance."""
        key = ("light", color, strength, fade, power, near)
        if key in self.cache:
            return self.cache[key]
        m, nt, out, b = self._new(f"light {color} {strength} {fade}")
        g = b.node("ShaderNodeGroup")
        g.node_tree = self.hz
        k = b.math("MULTIPLY", g.outputs["Keep"], strength)
        if fade:
            tc = b.node("ShaderNodeTexCoord")
            sp = b.node("ShaderNodeSeparateXYZ")
            b.link(tc.outputs["Generated" if fade == "z" else "UV"], sp.inputs[0])
            v = b.math("SUBTRACT", 1.0, sp.outputs["Z"]) if fade == "z" else sp.outputs["Y"]
            k = b.math("MULTIPLY", k, b.math("POWER", b.math("MAXIMUM", v, 0.0), power))
        if near:
            mr = b.node("ShaderNodeMapRange")
            mr.interpolation_type = "SMOOTHSTEP"
            b.link(g.outputs["Distance"], mr.inputs["Value"])
            mr.inputs["From Min"].default_value, mr.inputs["From Max"].default_value = near
            k = b.math("MULTIPLY", k, mr.outputs["Result"])
        em = b.node("ShaderNodeEmission", Color=bw.lin(color))
        b.link(k, em.inputs["Strength"])
        tr = b.node("ShaderNodeBsdfTransparent")
        add = b.node("ShaderNodeAddShader")
        b.link(tr.outputs[0], add.inputs[0])
        b.link(em.outputs[0], add.inputs[1])
        b.link(add.outputs[0], out.inputs["Surface"])
        m.surface_render_method = "BLENDED"
        m.use_transparent_shadow = True
        self.cache[key] = m
        return m

    def solid(self, name, color, rough=0.6, metal=0.0, glow=None, glow_k=0.0, attr=None):
        m, nt, out, b = self._new(name)
        p = b.node("ShaderNodeBsdfPrincipled")
        p.inputs["Base Color"].default_value = bw.lin(color)
        p.inputs["Roughness"].default_value = rough
        p.inputs["Metallic"].default_value = metal
        if attr:
            ca = b.node("ShaderNodeVertexColor")
            ca.layer_name = attr
            b.link(ca.outputs["Color"], p.inputs["Base Color"])
        if glow:
            p.inputs["Emission Color"].default_value = bw.lin(glow)
            p.inputs["Emission Strength"].default_value = glow_k
        self._hazed(nt, out, p.outputs[0])
        return m

    def ground(self, build, scene):
        """USGS satellite photo on the terrain: the whole level plus ~2 m/px patches around the top overlaps."""
        w, h = scene["size_m"]
        m, nt, out, b = self._new("ground")
        geo = b.node("ShaderNodeNewGeometry")

        def uv_for(box):
            x0, y0, x1, y1 = box
            mp = b.node("ShaderNodeMapping")
            mp.vector_type = "POINT"
            b.link(geo.outputs["Position"], mp.inputs["Vector"])
            mp.inputs["Scale"].default_value = (1 / (x1 - x0), 1 / (y1 - y0), 1)
            mp.inputs["Location"].default_value = (-x0 / (x1 - x0), -y0 / (y1 - y0), 0)
            return mp.outputs[0]

        def tex(path, uv, noncolor=False):
            t = b.node("ShaderNodeTexImage")
            t.image = bpy.data.images.load(str(path), check_existing=True)
            if noncolor:
                t.image.colorspace_settings.name = "Non-Color"
            t.interpolation = "Linear"
            t.extension = "EXTEND"
            b.link(uv, t.inputs["Vector"])
            return t

        sat = scene["ground"]["sat"]
        base_uv = uv_for((-w / 2, -h / 2, w / 2, h / 2))
        color = tex(build / sat["file"], base_uv).outputs["Color"]
        if sat.get("far"):  # near the level edge, fade into the far image so the seam with the far ground disappears
            ft = tex(build / sat["far"]["file"], uv_for(sat["far"]["box"]))
            sp = b.node("ShaderNodeSeparateXYZ")
            b.link(base_uv, sp.inputs[0])
            e = b.math("MINIMUM", b.math("MINIMUM", sp.outputs["X"], b.math("SUBTRACT", 1.0, sp.outputs["X"])),
                       b.math("MINIMUM", sp.outputs["Y"], b.math("SUBTRACT", 1.0, sp.outputs["Y"])))
            color = b.mix_rgb(b.math("SUBTRACT", 1.0, b.math("MULTIPLY", e, 16.0, clamp=True)), color, ft.outputs["Color"])
        for p in sat.get("patches", []):
            uv = uv_for(p["box"])
            t = tex(build / p["file"], uv)
            sp = b.node("ShaderNodeSeparateXYZ")
            b.link(uv, sp.inputs[0])
            e = b.math("MINIMUM", b.math("MINIMUM", sp.outputs["X"], b.math("SUBTRACT", 1.0, sp.outputs["X"])),
                       b.math("MINIMUM", sp.outputs["Y"], b.math("SUBTRACT", 1.0, sp.outputs["Y"])))
            color = b.mix_rgb(b.math("MULTIPLY", e, 12.0, clamp=True), color, t.outputs["Color"])
        hs = b.node("ShaderNodeHueSaturation")
        hs.inputs["Saturation"].default_value = 1.08
        hs.inputs["Value"].default_value = 1.0
        b.link(color, hs.inputs["Color"])
        water = tex(build / scene["ground"]["water"], base_uv, True)
        rough = b.node("ShaderNodeMapRange")
        b.link(water.outputs["Color"], rough.inputs["Value"])
        rough.inputs["To Min"].default_value = 0.9
        rough.inputs["To Max"].default_value = 0.12
        p = b.node("ShaderNodeBsdfPrincipled")
        b.link(hs.outputs["Color"], p.inputs["Base Color"])
        b.link(rough.outputs["Result"], p.inputs["Roughness"])
        self._hazed(nt, out, p.outputs[0])
        return m

    def far_ground(self, build, scene):
        """Low-res USGS ground past the level edge; its own border melts into the haze."""
        far = scene["ground"]["sat"]["far"]
        x0, y0, x1, y1 = far["box"]
        m, nt, out, b = self._new("far ground")
        geo = b.node("ShaderNodeNewGeometry")
        mp = b.node("ShaderNodeMapping")
        mp.vector_type = "POINT"
        b.link(geo.outputs["Position"], mp.inputs["Vector"])
        mp.inputs["Scale"].default_value = (1 / (x1 - x0), 1 / (y1 - y0), 1)
        mp.inputs["Location"].default_value = (-x0 / (x1 - x0), -y0 / (y1 - y0), 0)
        t = b.node("ShaderNodeTexImage")
        t.image = bpy.data.images.load(str(build / far["file"]), check_existing=True)
        t.extension = "EXTEND"
        b.link(mp.outputs[0], t.inputs["Vector"])
        p = b.node("ShaderNodeBsdfPrincipled", Roughness=0.9)
        b.link(t.outputs["Color"], p.inputs["Base Color"])
        g = self._hazed(nt, out, p.outputs[0])
        sp = b.node("ShaderNodeSeparateXYZ")
        b.link(mp.outputs[0], sp.inputs[0])
        e = b.math("MINIMUM", b.math("MINIMUM", sp.outputs["X"], b.math("SUBTRACT", 1.0, sp.outputs["X"])),
                   b.math("MINIMUM", sp.outputs["Y"], b.math("SUBTRACT", 1.0, sp.outputs["Y"])))
        edge = b.math("SUBTRACT", 1.0, b.math("MULTIPLY", e, 5.0, clamp=True))
        neg = b.node("ShaderNodeVectorMath")
        neg.operation = "SCALE"
        b.link(geo.outputs["Incoming"], neg.inputs[0])
        neg.inputs["Scale"].default_value = -1.0
        hc = b.node("ShaderNodeGroup")
        hc.node_tree = self.hcol
        b.link(neg.outputs[0], hc.inputs[0])
        em = b.node("ShaderNodeEmission", Strength=1.0)
        b.link(hc.outputs[0], em.inputs["Color"])
        mix = b.node("ShaderNodeMixShader")
        b.link(edge, mix.inputs[0])
        b.link(g.outputs[0], mix.inputs[1])
        b.link(em.outputs[0], mix.inputs[2])
        b.link(mix.outputs[0], out.inputs["Surface"])
        return m


# ---------------------------------------------------------------- look: world, sun, render, bloom
def setup_look(o, looks, n_frames):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    w, h = (int(v) for v in o["res"].split("x"))
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    sc.render.fps = int(o["fps"])
    sc.frame_start, sc.frame_end = 1, n_frames
    ee = sc.eevee
    ee.taa_render_samples = int(o["samples"])
    for k, v in (("use_shadows", True), ("shadow_pool_size", "1024"), ("use_raytracing", True),
                 ("ray_tracing_method", "SCREEN"), ("use_fast_gi", True), ("shadow_resolution_scale", 0.5)):
        try:
            setattr(ee, k, v)
        except (AttributeError, TypeError) as err:
            log(f"eevee {k}: {err}")
    sc.render.film_transparent = False
    sc.render.filter_size = 1.2
    sc.render.use_motion_blur = True     # a touch of camera blur, as a real camera would have
    sc.render.motion_blur_shutter = 0.5
    sc.view_settings.view_transform = "AgX"
    for look in ("AgX - Medium High Contrast", "Medium High Contrast"):
        try:
            sc.view_settings.look = look
            break
        except TypeError:
            pass
    sc.view_settings.exposure = 0.0
    img = sc.render.image_settings
    img.file_format = "PNG"
    img.color_mode = "RGB"
    img.color_depth = "8"
    img.compression = 15
    try:
        bpy.context.preferences.system.anisotropic_filter = "FILTER_16"
    except (AttributeError, TypeError):
        pass

    world = bpy.data.worlds.new("day")
    world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    b = NT(nt)
    out = b.node("ShaderNodeOutputWorld")
    sky = b.node("ShaderNodeTexSky")
    sky.sky_type = "MULTIPLE_SCATTERING"
    sky.sun_disc = False
    sky.sun_elevation = math.radians(SUN_EL)
    sky.sun_rotation = math.radians(SUN_AZ)   # measured: rotation = compass bearing of the sun
    tc = b.node("ShaderNodeTexCoord")
    nrm = b.node("ShaderNodeVectorMath")
    nrm.operation = "NORMALIZE"
    b.link(tc.outputs["Generated"], nrm.inputs[0])
    sp = b.node("ShaderNodeSeparateXYZ")
    b.link(nrm.outputs[0], sp.inputs[0])
    band = b.node("ShaderNodeMapRange")          # near the horizon the sky melts into the same haze as the land
    band.interpolation_type = "SMOOTHSTEP"
    b.link(sp.outputs["Z"], band.inputs["Value"])
    band.inputs["From Min"].default_value, band.inputs["From Max"].default_value = -0.01, 0.11
    band.inputs["To Min"].default_value, band.inputs["To Max"].default_value = 1.0, 0.0
    hc = b.node("ShaderNodeGroup")
    hc.node_tree = looks.hcol
    b.link(nrm.outputs[0], hc.inputs[0])
    skyk = b.node("ShaderNodeVectorMath")
    skyk.operation = "SCALE"
    b.link(sky.outputs["Color"], skyk.inputs[0])
    skyk.inputs["Scale"].default_value = SKY_K
    bg = b.node("ShaderNodeBackground", Strength=1.0)
    b.link(b.mix_rgb(band.outputs["Result"], skyk.outputs[0], hc.outputs[0]), bg.inputs["Color"])
    b.link(bg.outputs[0], out.inputs["Surface"])
    sc.world = world

    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = SUN_E
    sun.data.color = bw.lin("#fff1dc")[:3]
    sun.data.angle = math.radians(1.5)
    try:
        sun.data.use_shadow_jitter = True
    except AttributeError:
        pass
    sun.rotation_euler = sun_dir().to_track_quat("Z", "Y").to_euler()
    sc.collection.objects.link(sun)

    ng = bpy.data.node_groups.new("clip comp", "CompositorNodeTree")
    ng.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = ng.nodes.new("CompositorNodeRLayers")
    gout = ng.nodes.new("NodeGroupOutput")
    glare = ng.nodes.new("CompositorNodeGlare")
    for k, v in (("Type", "Bloom"), ("Quality", "High"), ("Threshold", 1.2), ("Smoothness", 0.4),
                 ("Strength", 0.55), ("Size", 0.62), ("Saturation", 1.1)):
        try:
            glare.inputs[k].default_value = v
        except (KeyError, TypeError, ValueError) as err:
            log(f"glare {k}: {err}")
    ng.links.new(rl.outputs["Image"], glare.inputs["Image"])
    ng.links.new(glare.outputs["Image"], gout.inputs["Image"])
    sc.compositing_node_group = ng
    sc.render.use_compositing = True


# ---------------------------------------------------------------- camera plan
def ease(t):
    return t * t * (3 - 2 * t)


def look_q(loc, aim):
    return (aim - loc).to_track_quat("-Z", "Y")


class Plan:
    """Camera path for one overlap: solved so the final frame holds both projects and the gap between them."""

    def __init__(self, o, scene, ter, projects, aspect, twins=True):
        w, h = scene["size_m"]
        self.ter = ter
        # a "twin" (same closest points as a higher-ranked overlap, e.g. two circuits of one line) gets another view
        twin = None
        if twins:
            same = [x for x in scene["overlaps"] if x["rank"] < o["rank"]
                    and math.dist(x["pa"][:2], o["pa"][:2]) < 1 and math.dist(x["pb"][:2], o["pb"][:2]) < 1]
            if same:
                twin = Plan(min(same, key=lambda x: x["rank"]), scene, ter, projects, aspect, twins=False)
        pa, pb = Vector(o["pa"][:2]), Vector(o["pb"][:2])
        self.pa, self.pb = pa, pb
        g = (pb - pa).length
        self.g = g
        self.touching = g < 50
        self.apex = 0.22 * g + 90.0
        mid = (pa + pb) / 2
        self.T = Vector((mid.x, mid.y, ter.at(mid.x, mid.y)))
        tanh = 18.0 / LENS
        tanv = tanh / aspect
        pitch1 = math.radians(23.0 if self.touching else 19.0 + 13.0 * min(max((g - 2000.0) / 15000.0, 0.0), 1.0))
        self.h1 = 60.0 if self.touching else 0.3 * self.apex
        keys = self.key_points(o, projects)

        def cam(b, dist, alt):
            loc = Vector((self.T.x + math.sin(b) * dist, self.T.y + math.cos(b) * dist, self.T.z + alt))
            loc.z = max(loc.z, ter.at(loc.x, loc.y) + 150.0)
            return loc

        def fits(b, dist):
            loc = cam(b, dist, dist * math.tan(pitch1))
            qi = look_q(loc, self.T + Vector((0, 0, self.h1))).inverted()
            for p in keys:
                v = qi @ (p - loc)
                if v.z > -1.0:
                    return False
                x, y = v.x / -v.z / tanh, v.y / -v.z / tanv
                if abs(x) > 0.78 or y < -0.72 or y > 0.62:
                    return False
            return not any(self.occluded(loc, p) for p in keys[:4:2])

        cands = []
        for bdeg in range(0, 360, 10):
            dist = 1300.0 if self.touching else 700.0
            while dist < 90000 and not fits(math.radians(bdeg), dist):
                dist *= 1.04
            cands.append((bdeg, dist))
        dmin = min(d for _, d in cands)
        pref = self.touch_bearing(o, projects) if self.touching else None

        def cost(bdeg, dist):
            view_az = (bdeg + 180) % 360
            rel = abs((view_az - SUN_AZ + 180) % 360 - 180)   # 0 = looking straight into the sun
            c = dist / dmin
            if rel < 70:
                c += 0.45 * (70 - rel) / 70
            if pref is not None:  # touching: stand behind the meeting point so both lines run away into the frame
                c += 1.2 * (1 - math.cos(math.radians(bdeg - pref))) / 2
            if twin is not None and abs((bdeg - twin.b1deg + 180) % 360 - 180) < 35:
                c += 1.0
            return c

        b1deg, d1 = min(cands, key=lambda c: cost(*c))
        a1 = d1 * math.tan(pitch1)
        loc1 = cam(math.radians(b1deg), d1, a1)
        for _ in range(3):  # re-aim so the subject sits in the middle of the final frame, not in its top half
            qi = look_q(loc1, self.T + Vector((0, 0, self.h1))).inverted()
            ys = [(qi @ (p - loc1)) for p in keys]
            ys = [v.y / -v.z / tanv for v in ys if v.z < -1]
            mid_y = (min(ys) + max(ys)) / 2
            span = max(ys) - min(ys)
            if abs(mid_y) < 0.03 or span > 1.5:
                break
            self.h1 += mid_y * tanv * (loc1 - self.T).length
        k = 2.2 - 0.5 * min(max((d1 - 1500.0) / 10000.0, 0.0), 1.0)
        d0 = max(2500.0, k * d1)
        a0 = max(900.0, d0 * math.tan(math.radians(20.0)), 1.3 * a1)
        # orbit direction: keep the start over the level; otherwise vary it per overlap so clips don't repeat
        prefer = 1 if int(hashlib.md5(o["id"].encode()).hexdigest(), 16) % 2 else -1
        if twin is not None:
            prefer = -twin.sgn
        best = None
        for sgn in (prefer, -prefer):
            b0 = math.radians(b1deg - sgn * ORBIT)
            s0 = cam(b0, d0, a0)
            margin = min(w / 2 - abs(s0.x), h / 2 - abs(s0.y))
            if best is None or margin > 2500 and best[2] <= 2500:
                best = (b0, sgn, margin)
        self.b0, self.sgn, self.b1, self.b1deg = best[0], best[1], math.radians(b1deg), b1deg
        self.d0, self.d1, self.a0, self.a1 = d0, d1, a0, a1
        self.h0 = 0.2 * a0
        slant = math.hypot(d1, a1 - self.h1)
        self.s = max(1.0, slant / 1000.0) ** 0.85   # line widths grow with the viewing distance
        self.cam = cam
        log(f"PLAN{'' if twins else ' (twin)'} gap {g:.0f} m  end bearing {b1deg} dist {d1:.0f} alt {a1:.0f}"
            f"  start dist {d0:.0f} alt {a0:.0f}  orbit {math.degrees(self.b1 - self.b0):+.0f}  width scale {self.s:.2f}")

    def key_points(self, o, projects):
        ter = self.ter
        pts = []
        for p in (self.pa, self.pb):
            z = ter.at(p.x, p.y)
            pts += [Vector((p.x, p.y, z + 20)), Vector((p.x, p.y, z + LIFT))]
        for pid, p0 in ((o["a"], self.pa), (o["b"], self.pb)):
            prj = projects[pid]
            if not prj["b"]:
                continue
            a = Vector((prj["a"]["x"], prj["a"]["y"]))
            bb = Vector((prj["b"]["x"], prj["b"]["y"]))
            length = (bb - a).length
            if length < 1:
                continue
            d = (bb - a) / length
            t0 = (p0 - a).dot(d)
            for dt in (-350.0, 350.0):
                q = a + d * min(max(t0 + dt, 0.0), length)
                z = ter.at(q.x, q.y)
                pts += [Vector((q.x, q.y, z + 10)), Vector((q.x, q.y, z + LIFT))]
        if self.touching:
            for k in range(8):
                t = k / 8 * 2 * math.pi
                x, y = self.pa.x + TOUCH_R * math.cos(t), self.pa.y + TOUCH_R * math.sin(t)
                pts.append(Vector((x, y, ter.at(x, y) + 20)))
        else:
            za, zb = ter.at(self.pa.x, self.pa.y), ter.at(self.pb.x, self.pb.y)
            pts.append(Vector((self.T.x, self.T.y, (za + zb) / 2 + 25 + self.apex)))
        return pts

    def touch_bearing(self, o, projects):
        """Compass bearing for a camera behind the shared point, opposite both lines' directions."""
        dirs = []
        for pid in (o["a"], o["b"]):
            prj = projects[pid]
            if not prj["b"]:
                continue
            ends = [Vector((prj[k]["x"], prj[k]["y"])) for k in ("a", "b")]
            far_end = max(ends, key=lambda e: (e - self.pa).length)
            if (far_end - self.pa).length > 1:
                dirs.append((far_end - self.pa).normalized())
        if not dirs:
            return None
        bis = Vector((0.0, 0.0))
        for d in dirs:
            bis += d
        if bis.length < 0.3:  # lines leave in opposite directions: look across them instead
            bis = Vector((-dirs[0].y, dirs[0].x))
        back = -bis.normalized()
        return math.degrees(math.atan2(back.x, back.y)) % 360

    def occluded(self, loc, p):
        for k in range(1, 24):
            q = loc.lerp(p, k / 24)
            if self.ter.at(q.x, q.y) > q.z + 5:
                return True
        return False

    def at(self, t):
        e = ease(t)
        b = self.b0 + (self.b1 - self.b0) * e
        dist = self.d0 * (self.d1 / self.d0) ** e
        alt = self.a0 * (self.a1 / self.a0) ** e
        loc = self.cam(b, dist, alt)
        aim = self.T + Vector((0, 0, self.h0 + (self.h1 - self.h0) * e))
        return loc, look_q(loc, aim)


# ---------------------------------------------------------------- world building
def ring_pts(ter, cx, cy, r, lift, n=None):
    n = n or int(min(max(r / 12, 96), 3000))
    return [(cx + r * math.cos(t), cy + r * math.sin(t), ter.at(cx + r * math.cos(t), cy + r * math.sin(t)) + lift)
            for t in np.linspace(0, 2 * math.pi, n + 1)]


def cylinder(name, x, y, z, radius, height, mat, col):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=False, segments=24, radius1=radius, radius2=radius, depth=height)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = (x, y, z + height / 2)
    me.materials.append(mat)
    col.objects.link(ob)
    ob.visible_shadow = False
    return ob


def ribbon(name, top, lift, mat, col):
    """Vertical ribbon under a polyline, UV v = 1 at the top line, 0 at the ground."""
    me = bpy.data.meshes.new(name)
    verts, faces = [], []
    for k, (x, y, zt) in enumerate(top):
        verts += [(x, y, zt - lift), (x, y, zt)]
        if k:
            faces.append((2 * k - 2, 2 * k, 2 * k + 1, 2 * k - 1))
    me.from_pydata(verts, [], faces)
    uv = me.uv_layers.new(name="UVMap")
    n = max(1, len(top) - 1)
    for poly in me.polygons:
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            uv.data[li].uv = (vi // 2 / n, vi % 2)
    ob = bpy.data.objects.new(name, me)
    me.materials.append(mat)
    col.objects.link(ob)
    ob.visible_shadow = False
    return ob


def glow_curve(name, polylines, radius, mat, col, res=1):
    ob = bw.curve_object(name, polylines, radius, mat, col, res)
    ob.visible_shadow = False
    return ob


def build_world(scene, build, o, plan, looks, extra=None):
    """The clip's world around overlap o. extra (explore mode only): more (overlap, plan) pairs to highlight too,
    with lighter detail (40 % of the radii) around their ends."""
    w, h = scene["size_m"]
    ter = plan.ter
    s = plan.s
    focus = [(o, plan)] + list(extra or [])
    # detail centers: the target at full radius; in explore mode also the two ends of every other overlap, at 40 %
    centers = [(plan.T, 1.0)]
    for _, pl in (extra or []):
        for p in (pl.pa, pl.pb):
            if all(math.hypot(p.x - c.x, p.y - c.y) > 500 for c, _ in centers):
                centers.append((p, 0.4))
    Ts = [c for c, _ in centers]
    near = lambda x, y, r: any(math.hypot(x - c.x, y - c.y) < r * k for c, k in centers)  # noqa: E731

    c_ter, c_grid, c_proj, c_ovl = (bw.collection(n) for n in ("Terrain", "Grid", "Planned", "Overlap"))
    # lattice meshes first: tower_mesh() evaluates the depsgraph, which is cheap while the scene is still empty
    tme = bw.tower_mesh(0.011)
    tme_ghost = bw.tower_mesh(0.011)
    tme_ghost.name = "ghost tower"

    ob = bpy.data.objects.new("terrain", ter.mesh("terrain"))
    ob.data.materials.append(looks.ground(build, scene))
    c_ter.objects.link(ob)
    if scene["ground"]["sat"].get("far"):
        x0, y0, x1, y1 = scene["ground"]["sat"]["far"]["box"]
        me = bpy.data.meshes.new("far ground")
        if extra is None:
            me.from_pydata([(x0, y0, -2.0), (x1, y0, -2.0), (x1, y1, -2.0), (x0, y1, -2.0)], [], [(0, 1, 2, 3)])
        else:  # explore: a frame around the level (no plane under the land to flicker through it from afar)
            ix, iy = w / 2 - 60.0, h / 2 - 60.0
            me.from_pydata([(x0, y0, -2.0), (x1, y0, -2.0), (x1, y1, -2.0), (x0, y1, -2.0),
                            (-ix, -iy, -2.0), (ix, -iy, -2.0), (ix, iy, -2.0), (-ix, iy, -2.0)], [],
                           [(0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)])
        far = bpy.data.objects.new("far ground", me)
        me.materials.append(looks.far_ground(build, scene))
        c_ter.objects.link(far)

    # today's grid: wires sagging between real OSM towers near the target, a soft glow line for the far ones
    ek = lambda x, y: float(edge_k(x, y, w, h))  # noqa: E731
    wires, glow = [], []
    r_grid, r_wire = 30000.0 * max(1.0, s * 0.8), 9000.0
    for line in scene["grid"]:
        pts = [(x, y, z * ek(x, y)) for x, y, z in line["pts"]]
        if not any(near(x, y, r_grid) for x, y, _ in pts[::3] + pts[-1:]):
            continue
        th = tower_h(line.get("kv") or 0)
        glow.append([(x, y, z + th * 0.7) for x, y, z in pts])
        if s > 3 or not any(near(x, y, r_wire) for x, y, _ in pts):
            continue
        for side in (-1, 1):
            poly = []
            for (x0, y0, z0), (x1, y1, z1) in zip(pts[:-1], pts[1:]):
                dx, dy = x1 - x0, y1 - y0
                span = math.hypot(dx, dy) or 1.0
                ox, oy = -dy / span * side * 0.28 * th, dx / span * side * 0.28 * th
                sag = min(0.03 * span, 0.35 * th)
                for k in range(8):
                    f = k / 8
                    poly.append((x0 + dx * f + ox, y0 + dy * f + oy, z0 + (z1 - z0) * f + 0.7 * th - 4 * sag * f * (1 - f)))
            poly.append((pts[-1][0] + ox, pts[-1][1] + oy, pts[-1][2] + 0.7 * th))
            wires.append(poly)
    if wires:
        glow_curve("grid wires", wires, 0.45, looks.glow(COL["grid"], 1.8), c_grid, 0)
    glow_curve("grid glow", glow, 3.5 * s, looks.light(COL["grid"], 0.9, near=(1400.0 * s, 4500.0 * s)), c_grid, 1)

    if s <= 3:
        tme.materials.append(looks.solid("tower", "#9aa6b8", rough=0.4, metal=0.75, glow=COL["steel"], glow_k=0.55))
        r_tow = min(6500.0 * s, 8000.0)   # past ~8 km a tower is a few pixels: all cost, no picture
        n = 0
        for x, y, z, heading, th in scene["towers"]:
            if not near(x, y, r_tow):
                continue
            t = bpy.data.objects.new(f"tower.{n:05d}", tme)
            t.location = (x, y, z * ek(x, y))
            t.rotation_euler = (0, 0, math.radians(heading + 90))
            t.scale = (th, th, th)
            c_grid.objects.link(t)
            n += 1
        log(f"  towers {n} ({len(tme.polygons)} faces each)")

    # yards: glowing fence in the owner's color (Dominion sky-blue, Georgia Power yellow, others steel)
    fences, rails = {}, {}
    for f in scene["structures"].get("facilities", []):
        ring0 = f["rings"][0]
        if not near(ring0[0][0], ring0[0][1], 15000.0 * s):
            continue
        own = owner_of(f.get("op"))
        z = f["z"] * ek(ring0[0][0], ring0[0][1])
        for r in f["rings"]:
            top = [(x, y, z + 7.0) for x, y in r]
            fences.setdefault(own, []).append(top)
            rails.setdefault(own, []).append(top)
    for own, tops in fences.items():
        color = COL.get(own, COL["steel"])
        for i, top in enumerate(tops):
            ribbon(f"fence {own} {i}", top, 7.0, looks.light(color, 2.4, fade="v", power=0.6), c_grid)
        glow_curve(f"rail {own}", rails[own], 0.6 * max(1.0, s * 0.7), looks.glow(color, 4.0), c_grid, 0)

    if s <= 4:   # explore: every building in the level (under a million triangles in all)
        build_buildings(scene, build, Ts, 5000.0 if extra is None else math.inf, looks, c_ter, ek)

    # planned projects: the pair glows bright with a curtain and see-through towers; the rest of the plan stays dim
    pair = {pid for ov, _ in focus for pid in (ov["a"], ov["b"])}
    projects = {p["id"]: p for p in scene["projects"]}
    for p in scene["projects"]:
        side = p["side"]
        color = COL[side]
        mine = p["id"] in pair
        dim = 0.5 if p.get("conf") == "low" else 1.0
        if not p["b"]:
            continue
        a = Vector((p["a"]["x"], p["a"]["y"]))
        bb = Vector((p["b"]["x"], p["b"]["y"]))
        n = max(2, int((bb - a).length / 150))
        top = [(v.x, v.y, ter.at(v.x, v.y) + LIFT) for v in (a.lerp(bb, k / n) for k in range(n + 1))]
        glow_curve(f"plan {p['id']}", [top], (2.6 if mine else 1.6) * s,
                   looks.glow(color, (6.0 if mine else 2.0) * dim), c_proj, 1)
        if not mine:
            continue
        ribbon(f"curtain {p['id']}", top, LIFT, looks.light(color, 0.7 * dim, fade="v", power=1.5), c_proj)
        if s > 3:
            continue
        # preview towers at real height every ~320 m with two sagging conductors
        length = (bb - a).length
        th = tower_h(kv_of(p["name"]))
        if length < 400:
            continue
        cnt = max(1, round((length - 300) / 320))
        d = (bb - a) / length
        heading = math.degrees(math.atan2(d.y, d.x))
        gme = tme_ghost.copy()
        gme.materials.clear()
        gme.materials.append(looks.light(color, 1.6 * dim))
        spots = []
        for k in range(cnt + 1):
            q = a + d * (150 + (length - 300) * k / cnt)
            z = ter.at(q.x, q.y)
            spots.append((q.x, q.y, z))
            gt = bpy.data.objects.new(f"ghost {p['id']} {k}", gme)
            gt.location = (q.x, q.y, z)
            gt.rotation_euler = (0, 0, math.radians(heading + 90))
            gt.scale = (th, th, th)
            gt.visible_shadow = False
            c_proj.objects.link(gt)
        cw = []
        for sd in (-1, 1):
            ox, oy = -d.y * sd * 0.28 * th, d.x * sd * 0.28 * th
            poly = []
            for (x0, y0, z0), (x1, y1, z1) in zip(spots[:-1], spots[1:]):
                span = math.hypot(x1 - x0, y1 - y0)
                sag = min(0.03 * span, 0.35 * th)
                for k in range(8):
                    f = k / 8
                    poly.append((x0 + (x1 - x0) * f + ox, y0 + (y1 - y0) * f + oy,
                                 z0 + (z1 - z0) * f + 0.7 * th - 4 * sag * f * (1 - f)))
            poly.append((spots[-1][0] + ox, spots[-1][1] + oy, spots[-1][2] + 0.7 * th))
            cw.append(poly)
        glow_curve(f"ghost wires {p['id']}", cw, 0.45, looks.glow(color, 5.0 * dim), c_proj, 0)

    # light beams on the pair's end points and yards (both colors side by side where the utilities meet)
    ends = {}
    for pid in (pid for ov, _ in focus for pid in (ov["a"], ov["b"])):
        p = projects[pid]
        for e in (p["a"], p["b"]):
            if not e:
                continue
            key = next((k for k in ends if math.hypot(k[0] - e["x"], k[1] - e["y"]) < 300), (e["x"], e["y"]))
            ends.setdefault(key, set()).add(p["side"])
    beam_h, beam_r = 1100.0 * s ** 0.6, 9.0 * s
    rx, ry = -math.cos(plan.b1), math.sin(plan.b1)   # the final view's right-hand direction
    for (x, y), sides in ends.items():
        for i, side in enumerate(sorted(sides)):
            off = 0.0 if len(sides) == 1 else (i - 0.5) * 60.0 * s   # side by side across the view, or they add up to white
            bx, by = x + rx * off, y + ry * off
            cylinder(f"beam {side}", bx, by, ter.at(bx, by), beam_r, beam_h, looks.light(COL[side], 1.8, fade="z", power=2.6), c_proj)
            glow_curve(f"end ring {side}", [ring_pts(ter, bx, by, 70.0 * s, 6.0, 72)], 1.4 * s, looks.glow(COL[side], 5.0), c_proj)

    # the overlap: white arc across the gap (or pillar + ring where the projects touch), end markers, sharing circles
    # (explore mode draws every highlighted overlap at the main one's width scale, with lower arcs for the wide gaps,
    # so they read as lines when you fly close instead of white bands across the sky)
    ice = COL["ice"]
    drawn = []
    for ov, pl in focus:
        pa, pb = pl.pa, pl.pb
        if any((pa - a).length < 1 and (pb - b).length < 1 for a, b in drawn):   # a twin: same closest points
            continue
        drawn.append((pa, pb))
        apex = pl.apex if pl is plan else min(pl.apex, 1500.0)
        tag = "" if extra is None else f" #{ov['rank']}"
        za, zb = ter.at(pa.x, pa.y), ter.at(pb.x, pb.y)
        if pl.touching:
            if not any(math.hypot(x - pa.x, y - pa.y) < 150 for x, y in ends):  # the two beams already mark a shared yard
                cylinder("touch pillar" + tag, pa.x, pa.y, za, 7.0 * s, 500.0 * s,
                         looks.light(ice, 2.5, fade="z", power=2.2), c_ovl)
            ring = ring_pts(ter, pa.x, pa.y, TOUCH_R * s, 8.0, 180)
            z = np.array([q[2] for q in ring[:-1]])
            zs = np.convolve(np.concatenate([z[-15:], z, z[:15]]), np.ones(15) / 15, mode="same")[15:-15]
            z = np.maximum(z, zs)   # bridge over dam faces and banks instead of plunging down them
            ring = [(x, y, float(zz)) for (x, y, _), zz in zip(ring[:-1], z)]
            glow_curve("touch ring" + tag, [ring + ring[:1]], 1.6 * s, looks.glow(ice, 6.0), c_ovl)
        else:
            arc = [(pa.x + (pb.x - pa.x) * f, pa.y + (pb.y - pa.y) * f, za + (zb - za) * f + 25 + 4 * apex * f * (1 - f))
                   for f in (k / 64 for k in range(65))]
            glow_curve("overlap arc" + tag, [arc], 2.6 * s, looks.glow(ice, 9.0), c_ovl, 2)
            for p, z in ((pa, za), (pb, zb)):
                glow_curve("gap end" + tag, [ring_pts(ter, p.x, p.y, 38.0 * s, 8.0, 48)], 1.5 * s, looks.glow(ice, 7.0), c_ovl)
                cylinder("gap pin" + tag, p.x, p.y, z, 5.0 * s, 25.0 + 30.0 * s,
                         looks.light(ice, 4.0, fade="z", power=1.0), c_ovl)
    pa = plan.pa
    for r, k, strength in ((1600.0, 2.0, 0.75), (8000.0, 3.0, 0.6), (40000.0, 5.0, 0.45)):
        glow_curve(f"sharing ring {r:.0f}", [ring_pts(ter, pa.x, pa.y, r, 6.0)], k * s, looks.light(ice, strength), c_ovl)


def build_buildings(scene, build, Ts, radius, looks, col, ek):
    """OSM footprints extruded to their tagged (or estimated) height; roofs colored from the satellite photo.
    Only those within radius of one of the targets Ts."""
    meta = scene["structures"].get("buildings")
    path = build / "buildings.bin"
    if not meta or not path.exists():
        return
    n, npt = meta["count"], meta["points"]
    raw = path.read_bytes()
    xy = np.frombuffer(raw, np.float32, 2 * npt, 0).reshape(-1, 2).astype(np.float64)
    cnt = np.frombuffer(raw, np.uint16, n, 8 * npt).astype(np.int64)
    hdm = np.frombuffer(raw, np.uint16, n, 8 * npt + 2 * n).astype(np.float64) / 10
    zdm = np.frombuffer(raw, np.int16, n, 8 * npt + 4 * n).astype(np.float64) / 10
    rgb = (np.frombuffer(raw, np.uint8, 3 * n, 8 * npt + 6 * n).reshape(-1, 3) / 255.0
           if len(raw) >= 8 * npt + 9 * n else np.full((n, 3), 0.25))
    off = np.concatenate([[0], np.cumsum(cnt)[:-1]])
    cx = np.add.reduceat(xy[:, 0], off) / cnt
    cy = np.add.reduceat(xy[:, 1], off) / cnt
    sel = np.nonzero(np.min([np.hypot(cx - t.x, cy - t.y) for t in Ts], axis=0) < radius)[0]
    if not len(sel):
        return
    verts, faces, fcol = [], [], []
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4  # noqa: E731
    for i in sel:
        ring = xy[off[i]:off[i] + cnt[i]]
        z = zdm[i] * ek(cx[i], cy[i])
        top, bot = z + hdm[i], z - 3.0
        base = len(verts)
        m = len(ring)
        verts += [(x, y, bot) for x, y in ring] + [(x, y, top) for x, y in ring]
        faces.append(tuple(range(base + m, base + 2 * m)))
        roof = tuple(max(0.1, 1.3 * lin(c)) for c in rgb[i])
        fcol.append(roof)
        for k in range(m):
            k2 = (k + 1) % m
            faces.append((base + k, base + k2, base + m + k2, base + m + k))
            fcol.append(tuple(c * 0.55 for c in roof))
    me = bpy.data.meshes.new("buildings")
    me.from_pydata(verts, [], faces)
    attr = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")   # from_pydata keeps each face's loops together
    loop_cols = np.repeat(np.array([c + (1.0,) for c in fcol], np.float32), [len(f) for f in faces], axis=0)
    attr.data.foreach_set("color", loop_cols.ravel())
    ob = bpy.data.objects.new("buildings", me)
    me.materials.append(looks.solid("building", "#808080", rough=0.75, attr="Col"))
    col.objects.link(ob)
    log(f"  buildings {len(sel)}")


# ---------------------------------------------------------------- output: frames -> mp4 + poster, manifest
def tool(name):
    found = shutil.which(name)
    if found:
        return found
    for p in (Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / f"{name}.exe",
              Path(r"C:\ffmpeg-8.0.1-full_build-shared\bin") / f"{name}.exe"):
        if p.exists():
            return str(p)
    return None


def probe(mp4):
    fp = tool("ffprobe")
    if not fp or not mp4.exists():
        return None
    r = subprocess.run([fp, "-v", "error", "-select_streams", "v:0", "-show_entries",
                        "stream=codec_name,width,height,pix_fmt:format=duration", "-of", "json", str(mp4)],
                       capture_output=True, text=True)
    try:
        info = json.loads(r.stdout)
        st = info["streams"][0]
        dur = float(info["format"]["duration"])
    except (ValueError, KeyError, IndexError):
        return None
    if st.get("codec_name") != "h264" or st.get("pix_fmt") != "yuv420p" or dur < 1:
        return None
    return {"duration": dur, "width": st["width"], "height": st["height"]}


def write_manifest(out_dir=OUT):
    index = {}
    for lv in level_names():
        for o in load_scene(lv)["overlaps"]:
            index[o["id"]] = (o["rank"], lv)
    clips = []
    for mp4 in sorted(out_dir.glob("*.mp4")):
        oid = mp4.stem
        jpg = mp4.with_suffix(".jpg")
        info = probe(mp4) if oid in index and jpg.exists() else None
        if not info:
            continue
        rank, lv = index[oid]
        clips.append({"id": oid, "rank": rank, "level": lv, "file": mp4.name, "poster": jpg.name,
                      "seconds": round(info["duration"])})
    clips.sort(key=lambda c: c["rank"])
    tmp = out_dir / "manifest.json.tmp"
    tmp.write_text(json.dumps({"clips": clips}, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, out_dir / "manifest.json")
    log(f"MANIFEST {len(clips)} clips: {', '.join(str(c['rank']) for c in clips)}")


def encode(frames, fps, oid):
    ff = tool("ffmpeg")
    if not ff:
        raise SystemExit("ffmpeg not found")
    OUT.mkdir(parents=True, exist_ok=True)
    tmp_mp4 = OUT / f"{oid}.part.mp4"
    subprocess.run([ff, "-y", "-loglevel", "error", "-framerate", str(fps), "-i", str(frames / "f_%04d.png"),
                    "-vf", "scale=out_color_matrix=bt709:out_range=tv,format=yuv420p",   # browsers read HD video as BT.709
                    "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
                    "-c:v", "libx264", "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
                    "-b:v", "3M", "-maxrate", "4M", "-bufsize", "6M", "-g", str(2 * fps),
                    "-movflags", "+faststart", "-an", str(tmp_mp4)], check=True)
    last = sorted(frames.glob("f_*.png"))[-1]
    tmp_jpg = OUT / f"{oid}.part.jpg"
    py = shutil.which("python")
    ok = False
    if py:
        r = subprocess.run([py, "-c", "import sys; from PIL import Image; "
                            "Image.open(sys.argv[1]).convert('RGB').save(sys.argv[2], 'JPEG', quality=85, optimize=True)",
                            str(last), str(tmp_jpg)], capture_output=True)
        ok = r.returncode == 0 and tmp_jpg.exists()
    if not ok:
        subprocess.run([ff, "-y", "-loglevel", "error", "-i", str(last), "-q:v", "3", "-f", "image2", str(tmp_jpg)], check=True)
    if not probe(tmp_mp4):
        raise SystemExit(f"encoded clip does not probe as H.264: {tmp_mp4}")
    os.replace(tmp_jpg, OUT / f"{oid}.jpg")
    os.replace(tmp_mp4, OUT / f"{oid}.mp4")
    log(f"WROTE {OUT / (oid + '.mp4')} {(OUT / (oid + '.mp4')).stat().st_size / 1e6:.2f} MB, "
        f"poster {(OUT / (oid + '.jpg')).stat().st_size / 1e3:.0f} KB")


# ---------------------------------------------------------------- camera
def add_camera(plan, n_frames, name="camera"):
    """The fly-in as the scene's active camera, keyed on every frame."""
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    cam.data.lens = LENS
    cam.data.clip_start = 10
    cam.data.clip_end = 400000
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    prev = None
    for f in range(1, n_frames + 1):
        loc, q = plan.at((f - 1) / (n_frames - 1))
        cam.location = loc
        cam.rotation_euler = q.to_euler("XYZ", prev) if prev else q.to_euler("XYZ")
        prev = cam.rotation_euler.copy()
        cam.keyframe_insert("location", frame=f)
        cam.keyframe_insert("rotation_euler", frame=f)
    return cam


# ---------------------------------------------------------------- explore: a whole level saved as a .blend
EXPLORE_MAIN = {"savannah": "DESC_23__GPC_20277", "augusta": "DESC_31__GPC_20793"}
VIEW_LENS = 2 * LENS   # the 3D view measures its lens against a 72 mm sensor: 56 mm there = the clips' 28 mm camera
SESSION_PY = '''"""Settings for one Blender session with a GridLock explore scene (written by world3d/render_clips.py).
blender --factory-startup world3d/explore/savannah.blend --python world3d/explore/explore_session.py
Nothing here is saved: preference auto-save is off for this session."""
import bpy
from bpy.app.handlers import persistent

p = bpy.context.preferences
p.use_preferences_save = False
w = p.inputs.walk_navigation
w.walk_speed = 80.0            # m/s in walk/fly mode (Shift+`); the mouse wheel changes it while flying
w.walk_speed_factor = 5.0      # hold Shift for 5x
p.inputs.use_emulate_numpad = True   # the number row acts as a numpad: 0 looks through the fly-in camera
p.system.anisotropic_filter = "FILTER_16"


@persistent
def rendered(*_):
    """Blender opens a saved Rendered view as Solid; switch the Layout 3D view back to EEVEE Rendered."""
    if "explore" not in bpy.data.filepath.replace("\\\\", "/"):
        return
    for scr in bpy.data.screens:
        if scr.name != "Layout":
            continue
        for area in scr.areas:
            for sp in area.spaces:
                if sp.type == "VIEW_3D":
                    sp.shading.type = "RENDERED"
            area.tag_redraw()


rendered()
bpy.app.handlers.load_post.append(rendered)
'''


def explore_view(plan):
    """Saved UI: every 3D view gets km-scale clipping; the Layout view opens in EEVEE Rendered with the viewport
    compositor (so the bloom shows), in free perspective at the fly-in's first frame."""
    loc, q = plan.at(0.0)
    aim = plan.T + Vector((0, 0, plan.h0))
    dist = (aim - loc).length
    n = 0
    for scr in bpy.data.screens:
        for area in scr.areas:
            for sp in area.spaces:
                if sp.type != "VIEW_3D":
                    continue
                sp.clip_start, sp.clip_end, sp.lens = 1.0, 200000.0, VIEW_LENS
                if scr.name != "Layout":
                    continue
                sp.shading.type = "RENDERED"
                try:
                    sp.shading.use_compositor = "ALWAYS"
                except (AttributeError, TypeError) as err:
                    log(f"viewport compositor: {err}")
                ovl = sp.overlay
                ovl.show_floor = ovl.show_axis_x = ovl.show_axis_y = ovl.show_cursor = False  # z = 0 is sea level
                r3 = sp.region_3d
                r3.view_perspective = "PERSP"
                r3.view_distance = dist   # the view matrix setter keeps this distance to place the orbit point
                r3.view_matrix = Matrix.LocRotScale(loc, q, None).inverted()
                log(f"  view {scr.name}: orbit point {tuple(round(v) for v in r3.view_location)} "
                    f"(aim {tuple(round(v) for v in aim)}), rotation matches the fly-in start: "
                    f"{r3.view_rotation.rotation_difference(q).angle < 1e-3}")
                n += 1
    for win in bpy.context.window_manager.windows:
        if win.workspace.name != "Layout" and "Layout" in bpy.data.workspaces:
            win.workspace = bpy.data.workspaces["Layout"]
    log(f"  3D views set up: {n} in Layout")


def scene_stats():
    """Rough weight of what EEVEE draws: evaluated triangles per group of objects, and the textures."""
    dg = bpy.context.evaluated_depsgraph_get()
    groups, per_mesh = {}, {}
    for ob in bpy.context.scene.objects:
        if ob.type not in ("MESH", "CURVE"):
            continue
        shared = ob.type == "MESH" and not ob.modifiers
        if shared and ob.data.name in per_mesh:
            tris = per_mesh[ob.data.name]
        else:
            ev = ob.evaluated_get(dg)
            me = ev.to_mesh()
            lt = np.zeros(len(me.polygons), np.int64) if me else np.zeros(0, np.int64)
            if me:
                me.polygons.foreach_get("loop_total", lt)
            tris = int((lt - 2).sum())
            ev.to_mesh_clear()
            if shared:
                per_mesh[ob.data.name] = tris
        key = ob.name.split(" ")[0].split(".")[0]
        g = groups.setdefault(key, [0, 0])
        g[0] += 1
        g[1] += tris
    total = sum(g[1] for g in groups.values())
    for k, (n, t) in sorted(groups.items(), key=lambda kv: -kv[1][1])[:14]:
        log(f"  {k:<22} {n:>6} objects {t / 1e6:8.3f} M tris")
    log(f"  TOTAL {total / 1e6:.2f} M tris")
    for img in bpy.data.images:
        if img.source == "FILE":
            log(f"  image {img.name} {img.size[0]}x{img.size[1]}")


def explore(o):
    t_start = time.time()
    level = o["explore"]
    if level not in level_names():
        raise SystemExit(f"level {level!r} not in {level_names()}")
    scene = load_scene(level)
    build = BUILD / level
    key = o["key"] or EXPLORE_MAIN.get(level)
    feats = sorted((x for x in scene["overlaps"] if x["rank"] <= int(o["top"])), key=lambda x: x["rank"])
    main_ov = next((x for x in scene["overlaps"] if key and (x["id"] == key or (key.isdigit() and x["rank"] == int(key)))),
                   None) or feats[0]
    fps = int(o["fps"])
    n_frames = max(2, round(float(o["seconds"]) * fps))
    log(f"EXPLORE {level}: main #{main_ov['rank']} {main_ov['id']}, highlighted {[x['rank'] for x in feats]}")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0   # this background session only: no .blend1 next to the file
    ter = bw.Terrain(scene, build)
    w, h = scene["size_m"]
    gx, gy = np.meshgrid(np.linspace(-w / 2, w / 2, ter.nx), np.linspace(h / 2, -h / 2, ter.ny))
    ter.z = (ter.z * edge_k(gx, gy, w, h)).astype(np.float32)
    rw, rh = (int(v) for v in o["res"].split("x"))
    projects = {p["id"]: p for p in scene["projects"]}
    plan = Plan(main_ov, scene, ter, projects, rw / rh)
    extra = [(x, Plan(x, scene, ter, projects, rw / rh)) for x in feats if x["id"] != main_ov["id"]]
    global FAR
    FAR = max(FAR, 6.0 * math.hypot(plan.d0, plan.a0))
    looks = Looks()
    setup_look(o, looks, n_frames)
    sc = bpy.context.scene
    sc.eevee.taa_samples = 16          # viewport samples: stays interactive while moving, cleans up when still
    sc.eevee.shadow_pool_size = "512"  # half the clips' pool: less GPU memory for a window that stays open
    sc.render.use_motion_blur = False
    sc.sync_mode = "FRAME_DROP"        # the fly-in plays in real time even when the viewport can't keep up
    build_world(scene, build, main_ov, plan, looks, extra=extra)
    add_camera(plan, n_frames, "fly-in camera")
    sc.frame_current = 1
    explore_view(plan)
    log(f"BUILT in {time.time() - t_start:.1f} s")
    scene_stats()

    out = Path(o["out"]) if o["out"] else HERE / "explore" / f"{level}.blend"
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(out))
    try:
        bpy.ops.file.make_paths_relative()
    except RuntimeError as err:
        log(f"make_paths_relative: {err}")
    for img in bpy.data.images:
        if img.filepath and not img.filepath.startswith("//"):
            img.filepath = bpy.path.relpath(img.filepath)
        log(f"  path {img.filepath}")
    bpy.ops.wm.save_mainfile()
    session = out.parent / "explore_session.py"
    session.write_text(SESSION_PY, encoding="utf-8")
    log(f"SAVED {out} {out.stat().st_size / 1e6:.1f} MB in {time.time() - t_start:.1f} s")
    log(f'OPEN IT: "{bpy.app.binary_path}" --factory-startup "{out}" --python "{session}"')


# ---------------------------------------------------------------- main
def main():
    o = args()
    if o["manifest"]:
        write_manifest()
        return
    if o["explore"]:
        explore(o)
        return
    if not o["key"]:
        raise SystemExit("usage: blender -b --factory-startup -P world3d/render_clips.py -- <overlap id or rank>")
    t_start = time.time()
    level, scene, ov = find_overlap(o["key"])
    build = BUILD / level
    fps = int(o["fps"])
    n_frames = max(2, round(float(o["seconds"]) * fps))
    log(f"CLIP #{ov['rank']} {ov['id']} ({level}) tier {ov['tier']} {ov['dist_km']} km, {n_frames} frames")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    ter = bw.Terrain(scene, build)
    w, h = scene["size_m"]
    gx, gy = np.meshgrid(np.linspace(-w / 2, w / 2, ter.nx), np.linspace(h / 2, -h / 2, ter.ny))
    ter.z = (ter.z * edge_k(gx, gy, w, h)).astype(np.float32)
    rw, rh = (int(v) for v in o["res"].split("x"))
    plan = Plan(ov, scene, ter, {p["id"]: p for p in scene["projects"]}, rw / rh)
    global FAR
    FAR = max(FAR, 6.0 * math.hypot(plan.d0, plan.a0))   # wide shots look from far away: keep their subject clear
    looks = Looks()
    setup_look(o, looks, n_frames)
    build_world(scene, build, ov, plan, looks)
    add_camera(plan, n_frames)
    log(f"BUILT in {time.time() - t_start:.1f} s")

    frames = Path(o["tmp"]) / ov["id"]
    frames.mkdir(parents=True, exist_ok=True)
    for old in frames.glob("f_*.png"):
        old.unlink()
    todo = [int(v) for v in o["still"].split(",")] if o["still"] else list(range(1, n_frames + 1))
    sc = bpy.context.scene
    t0 = time.time()
    for i, f in enumerate(todo):
        tf = time.time()
        sc.frame_set(f)
        sc.render.filepath = str(frames / f"f_{f:04d}.png")
        bpy.ops.render.render(write_still=True)
        log(f"FRAME {f} ({i + 1}/{len(todo)}) {time.time() - tf:.2f} s")
    per = (time.time() - t0) / len(todo)
    log(f"RENDERED {len(todo)} frames in {time.time() - t0:.1f} s ({per:.2f} s/frame)")
    if o["still"]:
        log(f"STILLS in {frames}")
        return
    encode(frames, fps, ov["id"])
    if not o["keep"]:
        shutil.rmtree(frames, ignore_errors=True)
    write_manifest()
    log(f"DONE #{ov['rank']} {ov['id']} in {time.time() - t_start:.1f} s")


if __name__ == "__main__":
    main()
