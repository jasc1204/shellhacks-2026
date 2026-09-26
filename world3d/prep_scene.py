"""Prepare a 3D "level" of the GridLock world for Blender and the browser viewer.

A level is one border region (Savannah, Augusta). For it we build, in local meters
(x = east, y = north, origin = region center, z = up):
  - terrain.bin   float32 height grid (row 0 = north), already vertically exaggerated
  - ground.jpg    CARTO dark basemap resampled onto the same grid, tinted into our blue
  - scene.json    existing grid (OSM power lines, towers, substations), the planned
                  projects, and their overlaps measured closest-point to closest-point

Usage:  python world3d/prep_scene.py savannah [--projects path.xlsx|path.csv]

Sources: AWS Terrain Tiles (terrarium), CARTO dark_nolabels (c) OpenStreetMap contributors (c) CARTO,
OSM power data already cached by pipeline/fetch_osm.py, Sperry's Projects_Overlaps.xlsx sample.
Tiles are cached in world3d/cache so a level only downloads once.
"""
import argparse
import csv
import json
import math
import time
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
CACHE = HERE / "cache"
BUILD = HERE / "build"
R_EARTH = 6371008.8
UA = "GridLock-ShellHacks2026/0.1 (hackathon 3D viewer)"

EXAGGERATION = 6.0     # the coastal plain is ~0-30 m; exaggerate so bluffs and river valleys read
GRID_SPACING_M = 120.0  # terrain sample spacing
TEX_WIDTH = 4096        # ground texture width in px (~13 m/px for a 54 km level)

TILES = {
    "terrarium": ("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", 12),
    "carto": ("https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}.png", 13),
}

# (south, west, north, east)
REGIONS = {
    "savannah": {
        "title": "Savannah River",
        "subtitle": "DESC Jasper / Okatie / Bluffton vs GPC McIntosh / Goshen",
        "bbox": (32.00, -81.35, 32.48, -80.78),
        "places": [
            ("SAVANNAH", 32.0809, -81.0912, "city"), ("POOLER", 32.1155, -81.2471, "town"),
            ("PORT WENTWORTH", 32.1491, -81.1632, "town"), ("RINCON", 32.2960, -81.2354, "town"),
            ("HARDEEVILLE", 32.2871, -81.0790, "town"), ("BLUFFTON", 32.2371, -80.8604, "town"),
            ("GEORGIA", 32.215, -81.300, "state"), ("SOUTH CAROLINA", 32.420, -80.960, "state"),
        ],
    },
    "augusta": {
        "title": "Augusta / Thurmond",
        "subtitle": "DESC Stevens Creek / Hooks / Thurmond vs GPC Evans - Thurmond Dam",
        "bbox": (33.40, -82.32, 33.75, -81.88),
        "places": [
            ("AUGUSTA", 33.4735, -82.0105, "city"), ("NORTH AUGUSTA", 33.5018, -81.9651, "town"),
            ("EVANS", 33.5337, -82.1307, "town"), ("MARTINEZ", 33.5174, -82.0757, "town"),
            ("GEORGIA", 33.45, -82.25, "state"), ("SOUTH CAROLINA", 33.70, -81.95, "state"),
        ],
    },
}

TIERS = [  # (tier, max km, what can be shared) from the GridLock spec
    (1, 0.1, "Touching / crossing: must coordinate outages and crossing structures"),
    (2, 1.6, "Under 1.6 km: share the land itself (right-of-way, access roads, permits)"),
    (3, 8.0, "Under 8 km: share site logistics (laydown yards, deliveries)"),
    (4, 40.0, "Under 40 km: share crews and equipment"),
]


# ---------------------------------------------------------------- projection
class Local:
    """Equirectangular projection around the region center; <0.1% error at 50 km."""

    def __init__(self, bbox):
        s, w, n, e = bbox
        self.lat0, self.lon0 = (s + n) / 2, (w + e) / 2
        self.kx = R_EARTH * math.cos(math.radians(self.lat0)) * math.pi / 180
        self.ky = R_EARTH * math.pi / 180
        self.width = (e - w) * self.kx
        self.height = (n - s) * self.ky

    def xy(self, lat, lon):
        return (lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky

    def latlon(self, x, y):
        return self.lat0 + y / self.ky, self.lon0 + x / self.kx

    def inside(self, x, y, pad=0.0):
        return abs(x) <= self.width / 2 + pad and abs(y) <= self.height / 2 + pad


# ---------------------------------------------------------------- tiles
def fetch_tile(src, z, x, y):
    path = CACHE / "tiles" / src / str(z) / str(x) / f"{y}.png"
    if not path.exists():
        url = TILES[src][0].format(z=z, x=x, y=y, s="abcd"[(x + y) % 4])
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=30) as r:
                    data = r.read()
                break
            except Exception as err:  # noqa: BLE001 - retry any network hiccup
                if attempt == 3:
                    raise RuntimeError(f"tile {url} failed: {err}") from err
                time.sleep(1.5 * (attempt + 1))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        time.sleep(0.03)
    return Image.open(path).convert("RGB")


def merc_px(lat, lon, z):
    """Global Web Mercator pixel coordinates for 256 px tiles."""
    n = 256.0 * 2 ** z
    lat_r = np.radians(lat)
    return (np.asarray(lon) + 180.0) / 360.0 * n, (1.0 - np.log(np.tan(lat_r) + 1 / np.cos(lat_r)) / np.pi) / 2.0 * n


def sample_tiles(src, lat, lon):
    """Bilinear-sample a tile source at arrays of lat/lon. Returns float32 [..., 3]."""
    z = TILES[src][1]
    px, py = merc_px(lat, lon, z)
    tx0, ty0 = int(px.min() // 256), int(py.min() // 256)
    tx1, ty1 = int(px.max() // 256), int(py.max() // 256)
    mos = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    count = (tx1 - tx0 + 1) * (ty1 - ty0 + 1)
    print(f"  {src} z{z}: {count} tiles")
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            mos.paste(fetch_tile(src, z, tx, ty), ((tx - tx0) * 256, (ty - ty0) * 256))
    a = np.asarray(mos).astype(np.float32)
    fx = np.clip(px - tx0 * 256 - 0.5, 0, a.shape[1] - 1.001)
    fy = np.clip(py - ty0 * 256 - 0.5, 0, a.shape[0] - 1.001)
    x0, y0 = fx.astype(int), fy.astype(int)
    wx, wy = (fx - x0)[..., None], (fy - y0)[..., None]
    return (a[y0, x0] * (1 - wx) * (1 - wy) + a[y0, x0 + 1] * wx * (1 - wy)
            + a[y0 + 1, x0] * (1 - wx) * wy + a[y0 + 1, x0 + 1] * wx * wy)


def build_terrain(loc):
    nx = int(round(loc.width / GRID_SPACING_M)) + 1
    ny = int(round(loc.height / GRID_SPACING_M)) + 1
    xs = np.linspace(-loc.width / 2, loc.width / 2, nx)
    ys = np.linspace(loc.height / 2, -loc.height / 2, ny)  # row 0 = north
    gx, gy = np.meshgrid(xs, ys)
    lat, lon = loc.latlon(gx, gy)
    rgb = sample_tiles("terrarium", lat, lon)
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    print(f"  elevation m: min {elev.min():.1f}  p50 {np.median(elev):.1f}  p99 {np.percentile(elev, 99):.1f}  max {elev.max():.1f}")
    # water sits at 0; clamp dredged channels/bathymetry so the river reads as a flat surface
    return (np.maximum(elev, 0.0) * EXAGGERATION).astype(np.float32), nx, ny


def tint(rgb):
    """CARTO dark -> Jose's blue: near-black blue land, navy water, roads glowing toward periwinkle."""
    lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2]) / 255.0
    stops = np.array([0.0, 0.06, 0.14, 0.24, 0.40, 0.70, 1.0])
    cols = np.array([
        [2, 4, 9], [5, 9, 18], [10, 18, 38], [22, 40, 88], [48, 82, 190], [111, 141, 255], [200, 215, 255],
    ], dtype=np.float32)
    out = np.stack([np.interp(lum, stops, cols[:, c]) for c in range(3)], axis=-1)
    return out


def build_ground(loc):
    w = TEX_WIDTH
    h = int(round(TEX_WIDTH * loc.height / loc.width))
    xs = (np.arange(w) + 0.5) / w * loc.width - loc.width / 2
    ys = loc.height / 2 - (np.arange(h) + 0.5) / h * loc.height
    gx, gy = np.meshgrid(xs, ys)
    lat, lon = loc.latlon(gx, gy)
    rgb = sample_tiles("carto", lat, lon)
    lum = (0.2126 * rgb[..., 0] + 0.7152 * rgb[..., 1] + 0.0722 * rgb[..., 2])
    hist = np.percentile(lum, [1, 10, 25, 50, 75, 90, 99])
    print(f"  carto luminance percentiles 1/10/25/50/75/90/99: {np.round(hist, 1).tolist()}")
    return Image.fromarray(np.clip(tint(rgb), 0, 255).astype(np.uint8)), (w, h)


def sampler(terrain, loc):
    ny, nx = terrain.shape

    def z_at(x, y):
        fx = (x + loc.width / 2) / loc.width * (nx - 1)
        fy = (loc.height / 2 - y) / loc.height * (ny - 1)
        fx, fy = min(max(fx, 0), nx - 1.001), min(max(fy, 0), ny - 1.001)
        x0, y0 = int(fx), int(fy)
        wx, wy = fx - x0, fy - y0
        return float(terrain[y0, x0] * (1 - wx) * (1 - wy) + terrain[y0, x0 + 1] * wx * (1 - wy)
                     + terrain[y0 + 1, x0] * (1 - wx) * wy + terrain[y0 + 1, x0 + 1] * wx * wy)
    return z_at


# ---------------------------------------------------------------- existing grid (OSM)
def clip_segment(p, q, hw, hh):
    """Liang-Barsky clip of segment p->q to the box [-hw,hw]x[-hh,hh]."""
    (x0, y0), (x1, y1) = p, q
    dx, dy = x1 - x0, y1 - y0
    t0, t1 = 0.0, 1.0
    for pk, qk in ((-dx, x0 + hw), (dx, hw - x0), (-dy, y0 + hh), (dy, hh - y0)):
        if pk == 0:
            if qk < 0:
                return None
        else:
            t = qk / pk
            if pk < 0:
                t0 = max(t0, t)
            else:
                t1 = min(t1, t)
    if t0 > t1:
        return None
    return (x0 + t0 * dx, y0 + t0 * dy), (x0 + t1 * dx, y0 + t1 * dy), t0 == 0.0, t1 == 1.0


def kv_of(tags):
    try:
        return max(int(v) for v in str(tags.get("voltage", "")).split(";") if v.strip().isdigit()) // 1000
    except ValueError:
        return None


def tower_height(kv):
    if kv is None:
        return 20.0
    return 48.0 if kv >= 500 else 36.0 if kv >= 230 else 27.0 if kv >= 100 else 20.0


def build_grid(loc, z_at, region):
    ways = json.load(open(ROOT / "data" / "osm" / f"power_lines_{region}.json", encoding="utf-8"))
    hw, hh = loc.width / 2, loc.height / 2
    lines, towers = [], {}
    for way in ways:
        tags = way.get("tags", {})
        kv = kv_of(tags)
        pts = [loc.xy(lat, lon) for lon, lat in way["coords"]]
        runs, cur = [], []
        for i in range(len(pts) - 1):
            c = clip_segment(pts[i], pts[i + 1], hw, hh)
            if c is None:
                if cur:
                    runs.append(cur)
                    cur = []
                continue
            a, b, a_orig, b_orig = c
            if not cur:
                cur = [(a, a_orig)]
            cur.append((b, b_orig))
            if not b_orig:  # left the box
                runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        for run in runs:
            if len(run) < 2:
                continue
            xyz = [[round(x, 1), round(y, 1), round(z_at(x, y), 1)] for (x, y), _ in run]
            lines.append({"id": way.get("osm"), "kv": kv, "name": tags.get("name"), "op": tags.get("operator"), "pts": xyz})
            for i, ((x, y), is_orig) in enumerate(run):
                if not is_orig:
                    continue  # clip points are not towers
                # face the cross arm across the line: heading = direction of travel through this tower
                (xa, ya), _ = run[max(i - 1, 0)]
                (xb, yb), _ = run[min(i + 1, len(run) - 1)]
                heading = math.degrees(math.atan2(yb - ya, xb - xa))
                key = (round(x), round(y))
                h = tower_height(kv)
                if key not in towers or towers[key][4] < h:
                    towers[key] = [round(x, 1), round(y, 1), round(z_at(x, y), 1), round(heading, 1), h]
    print(f"  grid: {len(lines)} line runs, {len(towers)} towers")
    return lines, list(towers.values())


def build_substations(loc, z_at):
    pts = json.load(open(ROOT / "data" / "osm" / "power_points.json", encoding="utf-8"))
    out = []
    for p in pts:
        x, y = loc.xy(p["lat"], p["lon"])
        if not loc.inside(x, y):
            continue
        t = p.get("tags", {})
        out.append({"name": t.get("name"), "kind": t.get("power"), "op": t.get("operator"), "kv": kv_of(t),
                    "x": round(x, 1), "y": round(y, 1), "z": round(z_at(x, y), 1)})
    print(f"  substations/plants: {len(out)}")
    return out


# ---------------------------------------------------------------- planned projects
def read_xlsx_rows(path, sheet_index=0):
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
    z = zipfile.ZipFile(path)
    shared = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", ns):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % ns["m"])))
    sheet = ET.fromstring(z.read(f"xl/worksheets/sheet{sheet_index + 1}.xml"))
    rows = []
    for row in sheet.iter("{%s}row" % ns["m"]):
        vals = {}
        for c in row.findall("m:c", ns):
            col = "".join(ch for ch in c.get("r") if ch.isalpha())
            v = c.find("m:v", ns)
            val = v.text if v is not None else None
            if c.get("t") == "s" and val is not None:
                val = shared[int(val)]
            vals[col] = val
        rows.append(vals)
    header = rows[0]
    return [{header[k]: r.get(k) for k in header} for r in rows[1:]]


def read_projects(path):
    path = Path(path)
    if path.suffix.lower() == ".csv":
        return list(csv.DictReader(open(path, encoding="utf-8")))
    return read_xlsx_rows(path)


def parse_date(v):
    if v in (None, ""):
        return None
    s = str(v).strip()
    if s.replace(".", "").isdigit():  # Excel serial
        return date(1899, 12, 30) + timedelta(days=int(float(s)))
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def build_projects(loc, z_at, path):
    out = []
    for r in read_projects(path):
        ends = []
        for side in ("a", "b"):
            lat, lon = fnum(r.get(f"lat_{side}")), fnum(r.get(f"lon_{side}"))
            if lat is None or lon is None:
                continue
            x, y = loc.xy(lat, lon)
            ends.append({"name": r.get(f"name_{side}"), "lat": lat, "lon": lon,
                         "x": round(x, 1), "y": round(y, 1), "z": round(z_at(x, y), 1)})
        if not ends or not any(loc.inside(e["x"], e["y"], pad=2000) for e in ends):
            continue
        util = r.get("utility") or ""
        d = parse_date(r.get("in_service_date"))
        s = parse_date(r.get("start_date"))
        out.append({
            "id": r.get("project_id"), "utility": util, "side": "DESC" if "Dominion" in util else "GPC",
            "name": r.get("project_name"), "kind": "line" if len(ends) == 2 else "point",
            "a": ends[0], "b": ends[1] if len(ends) == 2 else None,
            "in_service": d.isoformat() if d else None, "start": s.isoformat() if s else None,
        })
    print(f"  projects in level: {len(out)} ({', '.join(p['id'] for p in out)})")
    return out


def closest_points(p, q):
    """Closest points between two segments (points are zero-length segments), planar."""
    def seg(pr):
        a = np.array([pr["a"]["x"], pr["a"]["y"]])
        b = np.array([pr["b"]["x"], pr["b"]["y"]]) if pr["b"] else a.copy()
        return a, b

    def pt_seg(pt, a, b):
        ab = b - a
        denom = float(ab @ ab)
        t = 0.0 if denom == 0 else float(np.clip((pt - a) @ ab / denom, 0, 1))
        c = a + t * ab
        return float(np.linalg.norm(pt - c)), c

    a1, b1 = seg(p)
    a2, b2 = seg(q)
    # proper intersection -> touching/crossing
    d1, d2 = b1 - a1, b2 - a2
    den = d1[0] * d2[1] - d1[1] * d2[0]
    if abs(den) > 1e-9:
        t = ((a2[0] - a1[0]) * d2[1] - (a2[1] - a1[1]) * d2[0]) / den
        u = ((a2[0] - a1[0]) * d1[1] - (a2[1] - a1[1]) * d1[0]) / den
        if 0 <= t <= 1 and 0 <= u <= 1:
            c = a1 + t * d1
            return 0.0, c, c
    best = None
    for pt, (a, b), first in ((a1, (a2, b2), True), (b1, (a2, b2), True), (a2, (a1, b1), False), (b2, (a1, b1), False)):
        d, c = pt_seg(pt, a, b)
        if best is None or d < best[0]:
            best = (d, pt, c) if first else (d, c, pt)
    return best


def build_overlaps(projects, z_at):
    desc = [p for p in projects if p["side"] == "DESC"]
    gpc = [p for p in projects if p["side"] == "GPC"]
    out = []
    for a in desc:
        for b in gpc:
            d, pa, pb = closest_points(a, b)
            km = d / 1000
            tier = next((t for t in TIERS if km < t[1]), None)
            if tier is None:
                continue
            ca = np.mean([[e["x"], e["y"]] for e in (a["a"], a["b"]) if e], axis=0)
            cb = np.mean([[e["x"], e["y"]] for e in (b["a"], b["b"]) if e], axis=0)
            da, db = a["in_service"], b["in_service"]
            gap = abs((date.fromisoformat(da) - date.fromisoformat(db)).days) if da and db else None
            out.append({
                "a": a["id"], "b": b["id"], "dist_km": round(km, 2), "center_dist_km": round(float(np.linalg.norm(ca - cb)) / 1000, 2),
                "tier": tier[0], "tier_label": tier[2], "time_gap_days": gap,
                "pa": [round(float(pa[0]), 1), round(float(pa[1]), 1), round(z_at(*pa), 1)],
                "pb": [round(float(pb[0]), 1), round(float(pb[1]), 1), round(z_at(*pb), 1)],
            })
    out.sort(key=lambda o: (o["tier"], o["dist_km"], o["time_gap_days"] if o["time_gap_days"] is not None else 1e9))
    for i, o in enumerate(out, 1):
        o["rank"] = i
        o["id"] = f"OVL_{i}"
    print("  overlaps (closest points):")
    for o in out:
        print(f"    #{o['rank']} {o['a']} x {o['b']}: {o['dist_km']} km (center {o['center_dist_km']} km) tier {o['tier']}, gap {o['time_gap_days']} d")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("region", choices=sorted(REGIONS))
    ap.add_argument("--projects", default=str(ROOT / "data" / "sperry" / "Projects_Overlaps.xlsx"))
    args = ap.parse_args()
    reg = REGIONS[args.region]
    loc = Local(reg["bbox"])
    out = BUILD / args.region
    out.mkdir(parents=True, exist_ok=True)
    print(f"[{args.region}] {loc.width / 1000:.1f} x {loc.height / 1000:.1f} km")

    terrain, nx, ny = build_terrain(loc)
    terrain.tofile(out / "terrain.bin")
    z_at = sampler(terrain, loc)
    ground, (tw, th) = build_ground(loc)
    ground.save(out / "ground.jpg", quality=88)

    lines, towers = build_grid(loc, z_at, args.region)
    subs = build_substations(loc, z_at)
    projects = build_projects(loc, z_at, args.projects)
    overlaps = build_overlaps(projects, z_at)
    places = []
    for name, lat, lon, kind in reg["places"]:
        x, y = loc.xy(lat, lon)
        places.append({"name": name, "kind": kind, "x": round(x, 1), "y": round(y, 1), "z": round(z_at(x, y), 1)})

    scene = {
        "region": args.region, "title": reg["title"], "subtitle": reg["subtitle"],
        "origin": {"lat": loc.lat0, "lon": loc.lon0}, "bbox": reg["bbox"],
        "size_m": [round(loc.width, 1), round(loc.height, 1)],
        "terrain": {"file": "terrain.bin", "nx": nx, "ny": ny, "exaggeration": EXAGGERATION, "row0": "north",
                    "zmax": round(float(terrain.max()), 1)},
        "ground": {"file": "ground.jpg", "px": [tw, th]},
        "tiers": [{"tier": t, "max_km": m, "label": l} for t, m, l in TIERS],
        "projects": projects, "overlaps": overlaps, "places": places,
        "substations": subs, "towers": towers, "grid": lines,
        "sources": {
            "projects": Path(args.projects).name,
            "grid": "OpenStreetMap power=line / substation (Overpass)",
            "terrain": "AWS Terrain Tiles (terrarium), x%g vertical" % EXAGGERATION,
            "basemap": "(c) OpenStreetMap contributors (c) CARTO",
        },
    }
    (out / "scene.json").write_text(json.dumps(scene, separators=(",", ":")), encoding="utf-8")
    print(f"  wrote {out}")


if __name__ == "__main__":
    main()
