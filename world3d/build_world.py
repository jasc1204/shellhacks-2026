"""Build the GridLock 3D world in Blender from a level made by world3d/prep_scene.py.

Headless (what we run):
  blender -b --factory-startup -P world3d/build_world.py -- savannah --shots overview,crossing --save --glb
Options: --shots a,b  --res 1920x1080  --samples 32  --save (world.blend)  --glb (models.glb for the viewer)

Outputs in world3d/build/<region>/:
  render_<shot>.png  hero stills         world.blend  open it and press Shift+` to walk/fly (WASD, Q/E, wheel = speed)
  models.glb         Blender-made tower + substation models, instanced by the browser viewer

Everything is in meters: x = east, y = north, z = up (terrain is 6x exaggerated, same as terrain.bin).
"""
import json
import math
import re
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

HERE = Path(__file__).resolve().parent
FONT_DISPLAY = Path(r"C:\Windows\Fonts\bahnschrift.ttf")
FONT_MONO = Path(r"C:\Windows\Fonts\consola.ttf")

# Jose's palette (see the jose-design-taste skill): blue-cast near-black, ice text, blue->cyan, ONE hot accent (gold)
PAL = {
    "bg": "#020408", "haze": "#0b1a3a", "ice": "#f4f8ff", "muted": "#8fa3c4",
    "grid": "#3b7dff", "steel": "#7aa8ff", "desc": "#4dd8ff", "gpc": "#ffd166",
}
SIDE_COLOR = {"DESC": "desc", "GPC": "gpc"}
FEATURE_N = 4   # overlaps (by rank inside the level) whose projects get beacons + labels
MAX_ARCS = 6    # overlap arcs drawn in the stills


def lin(hex_color, a=1.0):
    h = hex_color.lstrip("#")
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in c) + (a,)


def args():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    opts = {"region": argv[0] if argv else "savannah", "shots": "overview", "res": "1920x1080",
            "samples": "32", "save": False, "glb": False}
    i = 1
    while i < len(argv):
        k = argv[i].lstrip("-")
        if k in ("save", "glb"):
            opts[k] = True
        else:
            opts[k] = argv[i + 1]
            i += 1
        i += 1
    return opts


# ---------------------------------------------------------------- helpers
def collection(name):
    col = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(col)
    return col


def node_mat(name):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    return m, nt, out


def emit_mat(name, color, strength, fade=None, alpha=1.0):
    """Unlit glow. fade='z' fades alpha along generated Z (beams), fade='uv' along UV v (curtains)."""
    m, nt, out = node_mat(name)
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = lin(PAL[color]) if color in PAL else lin(color)
    em.inputs["Strength"].default_value = strength
    if fade is None and alpha >= 1.0:
        nt.links.new(em.outputs[0], out.inputs["Surface"])
        return m
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    mix = nt.nodes.new("ShaderNodeMixShader")
    if fade is None:
        mix.inputs["Fac"].default_value = alpha
    else:
        tc = nt.nodes.new("ShaderNodeTexCoord")
        sep = nt.nodes.new("ShaderNodeSeparateXYZ")
        nt.links.new(tc.outputs["Generated" if fade == "z" else "UV"], sep.inputs[0])
        pw = nt.nodes.new("ShaderNodeMath")
        pw.operation = "POWER"
        if fade == "z":  # bright at the base, gone at the top
            inv = nt.nodes.new("ShaderNodeMath")
            inv.operation = "SUBTRACT"
            inv.inputs[0].default_value = 1.0
            nt.links.new(sep.outputs["Z"], inv.inputs[1])
            nt.links.new(inv.outputs[0], pw.inputs[0])
            pw.inputs[1].default_value = 2.2
        else:  # curtains: bright at the wire, gone at the ground
            nt.links.new(sep.outputs["Y"], pw.inputs[0])
            pw.inputs[1].default_value = 1.6
        mul = nt.nodes.new("ShaderNodeMath")
        mul.operation = "MULTIPLY"
        mul.inputs[1].default_value = alpha
        nt.links.new(pw.outputs[0], mul.inputs[0])
        nt.links.new(mul.outputs[0], mix.inputs["Fac"])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    m.surface_render_method = "BLENDED"
    m.use_transparent_shadow = True
    return m


def solid_mat(name, color, rough=0.6, metal=0.0, glow=None, glow_strength=0.0):
    m, nt, out = node_mat(name)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Base Color"].default_value = lin(color)
    bsdf.inputs["Roughness"].default_value = rough
    bsdf.inputs["Metallic"].default_value = metal
    if glow:
        bsdf.inputs["Emission Color"].default_value = lin(PAL.get(glow, glow))
        bsdf.inputs["Emission Strength"].default_value = glow_strength
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return m


def curve_object(name, polylines, radius, mat, col, resolution=0):
    cu = bpy.data.curves.new(name, "CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = resolution
    cu.use_fill_caps = True
    for pts in polylines:
        if len(pts) < 2:
            continue
        sp = cu.splines.new("POLY")
        sp.points.add(len(pts) - 1)
        flat = np.ones((len(pts), 4), np.float32)
        flat[:, :3] = np.asarray(pts, np.float32)
        sp.points.foreach_set("co", flat.ravel())
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    col.objects.link(ob)
    return ob


def text_object(name, body, size, mat, col, loc, font, spacing=1.0, align="CENTER", rot=(0, 0, 0), face=None):
    cu = bpy.data.curves.new(name, "FONT")
    cu.body = body
    cu.size = size
    cu.align_x = align
    cu.align_y = "CENTER"
    cu.space_character = spacing
    if font:
        cu.font = font
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    ob.location = loc
    ob.rotation_euler = rot
    if face is not None:  # billboard: same orientation as the camera
        c = ob.constraints.new("COPY_ROTATION")
        c.target = face
    col.objects.link(ob)
    return ob


# ---------------------------------------------------------------- terrain
class Terrain:
    def __init__(self, scene, build):
        t = scene["terrain"]
        self.nx, self.ny = t["nx"], t["ny"]
        self.w, self.h = scene["size_m"]
        self.z = np.fromfile(build / t["file"], dtype=np.float32).reshape(self.ny, self.nx)

    def at(self, x, y):
        fx = min(max((x + self.w / 2) / self.w * (self.nx - 1), 0), self.nx - 1.001)
        fy = min(max((self.h / 2 - y) / self.h * (self.ny - 1), 0), self.ny - 1.001)
        x0, y0 = int(fx), int(fy)
        wx, wy = fx - x0, fy - y0
        z = self.z
        return float(z[y0, x0] * (1 - wx) * (1 - wy) + z[y0, x0 + 1] * wx * (1 - wy)
                     + z[y0 + 1, x0] * (1 - wx) * wy + z[y0 + 1, x0 + 1] * wx * wy)

    def mesh(self, name):
        nx, ny = self.nx, self.ny
        xs = np.linspace(-self.w / 2, self.w / 2, nx, dtype=np.float32)
        ys = np.linspace(self.h / 2, -self.h / 2, ny, dtype=np.float32)
        gx, gy = np.meshgrid(xs, ys)
        co = np.stack([gx, gy, self.z], axis=-1).reshape(-1, 3)
        idx = np.arange(nx * ny, dtype=np.int32).reshape(ny, nx)
        quads = np.stack([idx[:-1, :-1], idx[1:, :-1], idx[1:, 1:], idx[:-1, 1:]], axis=-1).reshape(-1, 4)
        me = bpy.data.meshes.new(name)
        me.vertices.add(len(co))
        me.vertices.foreach_set("co", co.ravel())
        me.loops.add(quads.size)
        me.loops.foreach_set("vertex_index", quads.ravel())
        me.polygons.add(len(quads))
        me.polygons.foreach_set("loop_start", np.arange(0, quads.size, 4, dtype=np.int32))
        me.update(calc_edges=True)
        uv = me.uv_layers.new(name="UVMap")
        vuv = np.stack([(co[:, 0] + self.w / 2) / self.w, (co[:, 1] + self.h / 2) / self.h], axis=-1)
        try:
            uv.data.foreach_set("uv", vuv[quads.ravel()].ravel())
        except AttributeError:
            uv.uv.foreach_set("vector", vuv[quads.ravel()].ravel())
        me.shade_smooth()
        return me


def ground_material(build, scene):
    m, nt, out = node_mat("ground")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(str(build / scene["ground"]["file"]))
    tex.interpolation = "Cubic"
    wat = nt.nodes.new("ShaderNodeTexImage")
    wat.image = bpy.data.images.load(str(build / scene["ground"]["water"]))
    wat.image.colorspace_settings.name = "Non-Color"
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    rough = nt.nodes.new("ShaderNodeMapRange")  # water glossy, land matte
    rough.inputs["To Min"].default_value = 0.95
    rough.inputs["To Max"].default_value = 0.12
    nt.links.new(wat.outputs["Color"], rough.inputs["Value"])
    nt.links.new(rough.outputs["Result"], bsdf.inputs["Roughness"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 1.0  # the map stays readable at night
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])
    return m


# ---------------------------------------------------------------- models
def tower_mesh(thickness=0.0045):
    """Lattice transmission tower, unit height (scaled per voltage). Arms run along local X.
    `thickness` is the lattice member width as a fraction of the height (render_clips.py uses a thicker one)."""
    bm = bmesh.new()
    levels = [0.0, 0.2, 0.38, 0.54, 0.68]
    rings = []
    for z in levels:
        s = 0.095 - (0.095 - 0.03) * (z / 0.68)
        rings.append([bm.verts.new((sx * s, sy * s, z)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    for z, s in ((0.84, 0.024), (1.0, 0.01)):
        rings.append([bm.verts.new((sx * s, sy * s, z)) for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])
    faces = []
    for r0, r1 in zip(rings[:-1], rings[1:]):
        for k in range(4):
            faces.append(bm.faces.new((r0[k], r0[(k + 1) % 4], r1[(k + 1) % 4], r1[k])))
    for z, half_len, t in ((0.68, 0.30, 0.022), (0.84, 0.20, 0.018)):  # lower + upper cross arms
        res = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((0, 0, z + t)) @ Matrix.Diagonal((2 * half_len, 2 * t, 1.6 * t, 1)))
        faces += [f for f in {f for v in res["verts"] for f in v.link_faces} if abs(f.normal.x) < 0.5]
    bmesh.ops.poke(bm, faces=faces)  # X bracing on every panel
    me = bpy.data.meshes.new("tower_cage")
    bm.to_mesh(me)
    bm.free()
    tmp = bpy.data.objects.new("tower_cage", me)
    bpy.context.scene.collection.objects.link(tmp)
    wf = tmp.modifiers.new("lattice", "WIREFRAME")
    wf.thickness = thickness
    wf.use_even_offset = True
    wf.use_replace = True
    dg = bpy.context.evaluated_depsgraph_get()
    out = bpy.data.meshes.new_from_object(tmp.evaluated_get(dg))
    out.name = "tower"
    bpy.data.objects.remove(tmp)
    bpy.data.meshes.remove(me)
    return out


def substation_mesh(mat_body, mat_fence):
    """Unit (1 x 0.7) fenced yard with transformers and gantries; scaled per voltage."""
    bm = bmesh.new()

    def box(cx, cy, cz, sx, sy, sz, mat_index=0):
        res = bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation((cx, cy, cz + sz / 2)) @ Matrix.Diagonal((sx, sy, sz, 1)))
        for f in {f for v in res["verts"] for f in v.link_faces}:
            f.material_index = mat_index

    box(0, 0, 0, 1.0, 0.7, 0.004)  # pad
    for i, x in enumerate((-0.32, -0.12, 0.08, 0.28)):  # transformers
        box(x, -0.12, 0.004, 0.1, 0.12, 0.06 + 0.01 * (i % 2))
    for y in (0.12, 0.22):  # bus gantries
        for x in (-0.4, -0.2, 0.0, 0.2, 0.4):
            box(x, y, 0.004, 0.012, 0.012, 0.09)
        box(0, y, 0.09, 0.82, 0.01, 0.01)
    t = 0.006  # glowing fence
    for cx, cy, sx, sy in ((0, 0.35, 1.0, t), (0, -0.35, 1.0, t), (0.5, 0, t, 0.7), (-0.5, 0, t, 0.7)):
        box(cx, cy, 0.004, sx, sy, 0.03, 1)
    me = bpy.data.meshes.new("substation")
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat_body)
    me.materials.append(mat_fence)
    return me


def sub_scale(s):
    kv = s.get("kv") or 0
    if s.get("kind") == "plant":
        return 380.0
    return 240.0 if kv >= 500 else 160.0 if kv >= 230 else 110.0 if kv >= 100 else 70.0


# ---------------------------------------------------------------- scene assembly
def build(scene, build_dir, opts):
    ter = Terrain(scene, build_dir)
    font_d = bpy.data.fonts.load(str(FONT_DISPLAY)) if FONT_DISPLAY.exists() else None
    font_m = bpy.data.fonts.load(str(FONT_MONO)) if FONT_MONO.exists() else font_d

    c_ter, c_grid, c_tow, c_sub = collection("Terrain"), collection("Existing grid"), collection("Towers"), collection("Substations")
    c_proj, c_ovl, c_lab = collection("Planned projects"), collection("Overlaps"), collection("Labels")

    ob = bpy.data.objects.new("terrain", ter.mesh("terrain"))
    ob.data.materials.append(ground_material(build_dir, scene))
    c_ter.objects.link(ob)

    # existing grid: towers at real OSM positions, wires sagging between arm tips, plus a glow line for far views
    m_tower = solid_mat("tower", "#1d2433", rough=0.45, metal=0.7, glow="steel", glow_strength=0.7)
    tme = tower_mesh()
    tme.materials.append(m_tower)
    for i, (x, y, z, heading, h) in enumerate(scene["towers"]):
        t = bpy.data.objects.new(f"tower.{i:05d}", tme)
        t.location = (x, y, z)
        t.rotation_euler = (0, 0, math.radians(heading + 90))
        t.scale = (h, h, h)
        c_tow.objects.link(t)

    glow, wires = [], []
    for line in scene["grid"]:
        pts = line["pts"]
        h = 48.0 if (line["kv"] or 0) >= 500 else 36.0 if (line["kv"] or 0) >= 230 else 27.0 if (line["kv"] or 0) >= 100 else 20.0
        glow.append([(x, y, z + h * 0.7) for x, y, z in pts])
        for side in (-1, 1):
            poly = []
            for (x0, y0, z0), (x1, y1, z1) in zip(pts[:-1], pts[1:]):
                dx, dy = x1 - x0, y1 - y0
                span = math.hypot(dx, dy) or 1.0
                ox, oy = -dy / span * side * 0.28 * h, dx / span * side * 0.28 * h  # arm tip offset
                sag = min(0.03 * span, 0.35 * h)
                for k in range(8):
                    f = k / 8
                    poly.append((x0 + dx * f + ox, y0 + dy * f + oy, z0 + (z1 - z0) * f + 0.7 * h - 4 * sag * f * (1 - f)))
            poly.append((pts[-1][0] + ox, pts[-1][1] + oy, pts[-1][2] + 0.7 * h))
            wires.append(poly)
    curve_object("grid_glow", glow, 8.0, emit_mat("grid_glow", "#1b5ce8", 0.9), c_grid)
    curve_object("grid_wires", wires, 0.35, emit_mat("wire", "steel", 2.0), c_grid)

    m_body = solid_mat("sub_body", "#0b1226", rough=0.7, metal=0.3, glow="steel", glow_strength=0.08)
    m_fence = emit_mat("sub_fence", "steel", 1.1)
    sme = substation_mesh(m_body, m_fence)
    for i, s in enumerate(scene["substations"]):
        o = bpy.data.objects.new(f"sub.{i:03d} {s.get('name') or ''}"[:60], sme)
        k = sub_scale(s)
        o.location = (s["x"], s["y"], s["z"])
        o.scale = (k, k, k)
        c_sub.objects.link(o)

    # planned projects: glowing corridor lifted over the land; featured ones also get a curtain to the ground
    featured = {pid for o in scene["overlaps"] if o["level_rank"] <= FEATURE_N for pid in (o["a"], o["b"])}
    lift = 140.0
    for p in scene["projects"]:
        side = SIDE_COLOR[p["side"]]
        feat = p["id"] in featured
        dim = 0.45 if p.get("conf") == "low" else 1.0
        if not p["b"]:
            continue
        a, b = Vector((p["a"]["x"], p["a"]["y"])), Vector((p["b"]["x"], p["b"]["y"]))
        n = max(2, int((b - a).length / 200))
        top = [(v.x, v.y, ter.at(v.x, v.y) + lift) for v in (a + (b - a) * (k / n) for k in range(n + 1))]
        ob = curve_object(f"proj {p['id']}", [top], 22.0 if feat else 12.0,
                          emit_mat(f"proj_{p['id']}", side, (6.0 if feat else 1.6) * dim), c_proj, 1)
        ob["project"] = p["id"]
        if not feat:
            continue
        me = bpy.data.meshes.new(f"curtain {p['id']}")  # vertical ribbon, UV v = 0 ground .. 1 wire
        verts, faces = [], []
        for k, (x, y, zt) in enumerate(top):
            verts += [(x, y, zt - lift), (x, y, zt)]
            if k:
                i0 = 2 * (k - 1)
                faces.append((i0, i0 + 2, i0 + 3, i0 + 1))
        me.from_pydata(verts, [], faces)
        uv = me.uv_layers.new(name="UVMap")
        for poly in me.polygons:
            for li in poly.loop_indices:
                vi = me.loops[li].vertex_index
                uv.data[li].uv = (vi // 2 / max(1, len(top) - 1), vi % 2)
        cur = bpy.data.objects.new(f"curtain {p['id']}", me)
        cur.data.materials.append(emit_mat(f"curtain_{p['id']}", side, 2.5 * dim, fade="uv", alpha=0.55))
        c_proj.objects.link(cur)

    # beacons: one per physical endpoint of a featured project (side by side when both utilities meet there)
    beam_h = 2600.0
    for c in endpoint_clusters(scene, featured):
        sides = sorted(c["sides"])
        for i, s in enumerate(sides):
            off = 0.0 if len(sides) == 1 else (i - 0.5) * 120
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=45, depth=beam_h, location=(c["x"] + off, c["y"], c["z"] + beam_h / 2))
            beam = bpy.context.active_object
            beam.name = f"beacon {s} {c['name']}"
            for col in beam.users_collection:
                col.objects.unlink(beam)
            c_proj.objects.link(beam)
            beam.data.materials.append(emit_mat(f"beam_{s}_{c['name']}", SIDE_COLOR[s], 5.0, fade="z", alpha=0.9 * c["dim"]))
    return ter, font_d, font_m, (c_proj, c_ovl, c_lab)


def clean_name(n):
    n = (n or "").upper().replace("–", "-")
    for junk in (" SUBSTATION", " SUB", " (USA)", " PRIMARY", " STATION", " (SAV)"):
        n = n.replace(junk, "")
    return re.sub(r"\s*#\s*\d+$", "", n).strip()


def endpoint_clusters(scene, featured):
    """Featured endpoints merged when within 300 m (Okatie, McIntosh and Thurmond are shared by several projects)."""
    clusters = []
    for p in scene["projects"]:
        if p["id"] not in featured:
            continue
        for e in (p["a"], p["b"]):
            if not e:
                continue
            c = next((c for c in clusters if math.hypot(c["x"] - e["x"], c["y"] - e["y"]) < 300), None)
            if c is None:
                c = {"x": e["x"], "y": e["y"], "z": e["z"], "names": set(), "sides": set(), "dim": 1.0}
                clusters.append(c)
            if clean_name(e["name"]):
                c["names"].add(clean_name(e["name"]))
            c["sides"].add(p["side"])
            if p.get("conf") == "low":
                c["dim"] = 0.45
    for c in clusters:
        c["name"] = min(c["names"], key=len) if c["names"] else "?"
    return clusters


def fmt_km(d):
    return "TOUCHING" if d < 0.05 else f"{d:.2f} KM" if d < 1 else f"{d:.1f} KM"


def timing(o):
    od = o.get("overlap_days")
    if od:
        return f"BUILD WINDOWS OVERLAP {max(1, round(od / 30.44))} MO"
    gap = o.get("window_gap_days", o.get("time_gap_days"))
    return f"{gap} DAYS APART" if gap is not None else "DATES UNKNOWN"


def build_overlays(scene, ter, fonts, cols, cam):
    font_d, font_m = fonts
    c_proj, c_ovl, c_lab = cols
    m_ice = emit_mat("ovl_arc", "ice", 9.0)
    m_label = emit_mat("label_ice", "ice", 1.6)
    m_muted = emit_mat("label_muted", "muted", 1.0)
    m_ring = emit_mat("tier_ring", "ice", 1.4, alpha=0.8)
    featured = {pid for o in scene["overlaps"] if o["level_rank"] <= FEATURE_N for pid in (o["a"], o["b"])}
    placed = []
    for c in endpoint_clusters(scene, featured):  # endpoint names beside the beacon tops, staggered when close
        color = SIDE_COLOR[next(iter(c["sides"]))] if len(c["sides"]) == 1 else "ice"
        z = c["z"] + 2750
        while any(math.hypot(c["x"] - x, c["y"] - y) < 3000 and abs(z - zz) < 500 for x, y, zz in placed):
            z -= 620
        placed.append((c["x"], c["y"], z))
        text_object(f"lbl {c['name']}", "   " + c["name"], 520, emit_mat(f"lbl_{color}", color, 2.2 * c["dim"]), c_lab,
                    (c["x"], c["y"], z), font_d, spacing=1.15, align="LEFT", face=cam)
    for o in scene["overlaps"]:
        lr = o["level_rank"]
        if lr > MAX_ARCS:
            continue  # the stills stay readable; the browser viewer lists every overlap
        pa, pb = Vector(o["pa"]), Vector(o["pb"])
        dist = (pb - pa).length
        tagged = []
        if dist < 50:  # touching / crossing: a white pillar and ring at the shared point
            bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=28, depth=1900, location=(pa.x, pa.y, pa.z + 950))
            pillar = bpy.context.active_object
            pillar.name = f"touch {o['id']}"
            for col in pillar.users_collection:
                col.objects.unlink(pillar)
            c_ovl.objects.link(pillar)
            pillar.data.materials.append(emit_mat("touch_pillar", "ice", 7.0, fade="z", alpha=1.0))
            ring = [(pa.x + 420 * math.cos(t), pa.y + 420 * math.sin(t), pa.z + 30) for t in np.linspace(0, 2 * math.pi, 97)]
            tagged += [pillar, curve_object(f"touch ring {o['id']}", [ring], 14.0, m_ice, c_ovl)]
            top = pa.z + 1900
            mid = pa
        else:
            apex = 350 + 0.10 * dist + 750 * (lr - 1)
            pts = [(v.x, v.y, v.z + 30 + 4 * apex * f * (1 - f)) for f, v in ((k / 48, pa.lerp(pb, k / 48)) for k in range(49))]
            tagged.append(curve_object(f"arc {o['id']}", [pts], 16.0, m_ice, c_ovl, 1))
            mid = pa.lerp(pb, 0.5)
            top = mid.z + 30 + apex
        tagged.append(text_object(f"dist {o['id']}", fmt_km(o["dist_km"]), 380, m_label, c_ovl, (mid.x, mid.y, top + 330), font_m, spacing=1.05, face=cam))
        tagged.append(text_object(f"tier {o['id']}", f"#{o['rank']}  TIER {o['tier']}  {timing(o)}", 170, m_muted, c_ovl,
                                  (mid.x, mid.y, top + 100), font_m, spacing=1.2, face=cam))
        for ob in tagged:
            ob["rank"] = lr
    top1 = scene["overlaps"][0]
    for r, cap in ((1600, "1.6 KM  SHARED RIGHT-OF-WAY"), (8000, "8 KM  SHARED LAYDOWN YARDS")):
        cx, cy = top1["pa"][0], top1["pa"][1]
        ring = [(cx + r * math.cos(a), cy + r * math.sin(a), ter.at(cx + r * math.cos(a), cy + r * math.sin(a)) + 25)
                for a in np.linspace(0, 2 * math.pi, 181)]
        curve_object(f"tier ring {r}", [ring], 9.0, m_ring, c_ovl)
        text_object(f"tier cap {r}", cap, 300 if r > 2000 else 150, m_muted, c_ovl, (cx, cy - r - 260, ter.at(cx, cy - r) + 30), font_m, spacing=1.25)
    for pl in scene["places"]:
        size = {"city": 700, "town": 560, "state": 1900}[pl["kind"]]
        mat = m_muted if pl["kind"] != "state" else emit_mat("label_state", "muted", 0.28)
        text_object(f"place {pl['name']}", pl["name"], size, mat, c_lab, (pl["x"], pl["y"], pl["z"] + 40), font_d,
                    spacing=1.35 if pl["kind"] == "state" else 1.15)


# ---------------------------------------------------------------- look + camera
def setup_render(opts, build_dir):
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE"
    w, h = (int(v) for v in opts["res"].split("x"))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.eevee.taa_render_samples = int(opts["samples"])
    for k, v in (("use_raytracing", True), ("use_shadows", True), ("shadow_pool_size", "1024")):
        try:
            setattr(sc.eevee, k, v)
        except AttributeError:
            pass
    sc.view_settings.view_transform = "Standard"
    world = bpy.data.worlds.new("night")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    bg.inputs["Color"].default_value = lin(PAL["bg"])
    bg.inputs["Strength"].default_value = 1.0
    world.mist_settings.start = 4000
    world.mist_settings.depth = 70000
    world.mist_settings.falloff = "QUADRATIC"
    sc.world = world
    sun = bpy.data.objects.new("moon", bpy.data.lights.new("moon", "SUN"))
    sun.data.energy = 0.9
    sun.data.color = lin("#9fb8ff")[:3]
    sun.rotation_euler = (math.radians(68), 0, math.radians(-120))  # low, from the west-northwest
    sc.collection.objects.link(sun)

    vl = sc.view_layers[0]
    vl.use_pass_mist = True
    ng = bpy.data.node_groups.new("GridLock comp", "CompositorNodeTree")
    ng.interface.new_socket(name="Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    rl = ng.nodes.new("CompositorNodeRLayers")
    out = ng.nodes.new("NodeGroupOutput")
    fog = ng.nodes.new("ShaderNodeMix")
    fog.data_type = "RGBA"
    sock = {s.identifier: s for s in fog.inputs}
    amt = ng.nodes.new("ShaderNodeMath")
    amt.operation = "MULTIPLY"
    amt.inputs[1].default_value = 0.85
    ng.links.new(rl.outputs["Mist"], amt.inputs[0])
    ng.links.new(amt.outputs[0], sock["Factor_Float"])
    ng.links.new(rl.outputs["Image"], sock["A_Color"])
    sock["B_Color"].default_value = lin(PAL["haze"])
    glare = ng.nodes.new("CompositorNodeGlare")
    for name, val in (("Type", "Bloom"), ("Quality", "High"), ("Threshold", 0.9), ("Strength", 0.9), ("Size", 0.75), ("Saturation", 1.0)):
        try:
            glare.inputs[name].default_value = val
        except (KeyError, TypeError, ValueError) as err:
            print(f"glare {name}: {err}")
    res = next(s for s in fog.outputs if s.identifier == "Result_Color")
    ng.links.new(res, glare.inputs["Image"])
    ng.links.new(glare.outputs["Image"], out.inputs["Image"])
    sc.compositing_node_group = ng
    sc.render.use_compositing = True


def camera():
    cam = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    cam.data.lens = 32
    cam.data.clip_start = 5
    cam.data.clip_end = 250000
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def aim(cam, target, bearing_deg, dist, elev_deg, lens=32, origin=None):
    """Place the camera `dist` m from target, coming from compass `bearing_deg`, `elev_deg` above horizon
    (or at an explicit `origin`), looking at the target."""
    t = Vector(target)
    b, e = math.radians(bearing_deg), math.radians(elev_deg)
    cam.location = Vector(origin) if origin else t + Vector((math.sin(b) * math.cos(e), math.cos(b) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (t - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens


def shots(scene, ter):
    """Camera plan derived from the level's own data, so every level frames itself."""
    feat = {pid for o in scene["overlaps"] if o["level_rank"] <= FEATURE_N for pid in (o["a"], o["b"])}
    ends = [(e["x"], e["y"]) for p in scene["projects"] if p["id"] in feat for e in (p["a"], p["b"]) if e]
    xs, ys = [x for x, _ in ends], [y for _, y in ends]
    bx, by = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    o1 = scene["overlaps"][0]
    pa, pb = np.array(o1["pa"][:2]), np.array(o1["pb"][:2])
    mx, my = (pa + pb) / 2
    d1 = float(np.linalg.norm(pb - pa))
    # street level: stand beside the real tower nearest a spot ~1.5 km past the GPC end, look back at the overlap
    away = (pb - pa) / d1 if d1 > 1 else np.array([-1.0, 0.0])
    probe = pb + away * 1500 + np.array([-away[1], away[0]]) * 400
    tw = np.array(scene["towers"])
    tx, ty, _, th = tw[int(np.argmin(np.hypot(tw[:, 0] - probe[0], tw[:, 1] - probe[1])))][:4]
    gx, gy = tx - 70 * math.sin(math.radians(th)), ty + 70 * math.cos(math.radians(th))
    city = next((p for p in scene["places"] if p["kind"] == "city"), None)
    # name: (target, bearing, distance, elevation, lens, line scale, hide far grid glow, text scale, max level rank)
    w, h = scene["size_m"]

    def inside_bearing(target, dist, elev, prefer):
        """First bearing (starting at `prefer`) whose camera stays over the terrain, so the world edge never shows."""
        ground = dist * math.cos(math.radians(elev))
        for b in [prefer + k * s for k in range(0, 181, 15) for s in (1, -1)]:
            cx_ = target[0] + math.sin(math.radians(b)) * ground
            cy_ = target[1] + math.cos(math.radians(b)) * ground
            if abs(cx_) < w / 2 - 1500 and abs(cy_) < h / 2 - 1500:
                return b % 360
        return prefer

    close = (mx, my, ter.at(mx, my) + 900)
    close_d = 9000 + 2.0 * d1
    plan = {
        "overview": ((bx, by + 0.06 * span, 0), 175, max(26000, 1.25 * span), 36, 30, 1.0, False, 1.0, FEATURE_N),
        "crossing": (close, inside_bearing(close, close_d, 22, 150), close_d, 22, 30, 0.7, False, 0.7, 1),
        "ground": ((mx, my, ter.at(mx, my) + 320), 0, 0, 0, 22, 0.3, True, 0.4, 1),
        "_ground_from": (gx, gy, ter.at(gx, gy) + 38),
    }
    touch = next((o for o in scene["overlaps"] if o["dist_km"] < 0.05 and o["level_rank"] <= MAX_ARCS), None)
    if touch:  # both utilities' lines end on the same structure
        t = (touch["pa"][0], touch["pa"][1], ter.at(*touch["pa"][:2]) + 900)
        plan["touch"] = (t, inside_bearing(t, 8500, 24, 160), 8500, 24, 30, 0.6, False, 0.7, touch["level_rank"])
    if city:  # downtown, looking at the overlap zone: shows how far away it really is
        plan["city"] = ((mx, my, ter.at(mx, my) + 300), 0, 0, 0, 30, 0.8, False, 1.0, 3)
        plan["_city_from"] = (city["x"] + 1500, city["y"] - 5200, 2600)
    return plan


def main():
    opts = args()
    build_dir = HERE / "build" / opts["region"]
    scene = json.load(open(build_dir / "scene.json", encoding="utf-8"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_render(opts, build_dir)
    cam = camera()
    ter, font_d, font_m, cols = build(scene, build_dir, opts)
    build_overlays(scene, ter, (font_d, font_m), cols, cam)
    plan = shots(scene, ter)
    base = {ob.name: ob.data.bevel_depth for ob in bpy.data.objects if ob.type == "CURVE"}
    base_txt = {ob.name: ob.data.size for ob in bpy.data.objects if ob.type == "FONT"}
    for name in [s for s in opts["shots"].split(",") if s]:
        target, bearing, dist, elev, lens, scale, hide, text_scale, max_rank = plan[name]
        for ob in bpy.data.objects:
            if ob.name in base and not ob.name.startswith("grid_wires"):
                ob.data.bevel_depth = base[ob.name] * scale
            if ob.name in base_txt:
                ob.data.size = base_txt[ob.name] * text_scale
            if ob.name.startswith("grid_glow"):
                ob.hide_render = hide
            if ob.name.startswith(("tier ring", "tier cap")):
                ob.hide_render = name == "ground"  # aerial guides; edge-on at street level they only glare
            if "rank" in ob:
                ob.hide_render = ob["rank"] > max_rank
        aim(cam, target, bearing, dist, elev, lens, plan.get(f"_{name}_from"))
        bpy.context.scene.render.filepath = str(build_dir / f"render_{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"RENDERED {name}")
    if opts["glb"]:
        col = collection("Export")
        objs = []
        for name in ("tower", "substation"):
            o = bpy.data.objects.new(f"{name}_model", bpy.data.meshes[name])
            col.objects.link(o)
            objs.append(o)
        for o in bpy.context.view_layer.objects:
            o.select_set(o in objs)
        bpy.context.view_layer.objects.active = objs[0]
        bpy.ops.export_scene.gltf(filepath=str(build_dir / "models.glb"), export_format="GLB", use_selection=True,
                                  export_apply=True, export_yup=True, export_cameras=False, export_lights=False)
        for o in objs:
            bpy.data.objects.remove(o)
        bpy.data.collections.remove(col)
        print("EXPORTED models.glb")
    if opts["save"]:
        for scr in bpy.data.screens:  # a 54 km world needs a long viewport clip range
            for area in scr.areas:
                if area.type == "VIEW_3D":
                    sp = area.spaces[0]
                    sp.clip_start, sp.clip_end = 2, 250000
        bpy.ops.wm.save_as_mainfile(filepath=str(build_dir / "world.blend"))
        print("SAVED world.blend")


if __name__ == "__main__":
    main()
