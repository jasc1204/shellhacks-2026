"""Prepare a 3D "level" of the GridLock world for Blender and the browser viewer.

A level is one border region (Savannah, Augusta). For it we build, in local meters
(x = east, y = north, origin = region center, z = up):
  - terrain.bin   float32 height grid (row 0 = north), already vertically exaggerated
  - ground.png    map texture painted from OSM vectors in our palette (water, marsh, roads, 1 km grid)
  - scene.json    existing grid (OSM power lines, towers, substations), the planned
                  projects, and their overlaps measured closest-point to closest-point

Usage:  python world3d/prep_scene.py savannah [--projects path.csv|path.xlsx] [--overlaps overlaps.json]

By default it reads the pipeline's data/processed/projects_located.csv + overlaps.json (so ranks, tiers and
closest points match the 2D app exactly) and falls back to Sperry's sample xlsx + its own closest-point math.

Sources: AWS Terrain Tiles (terrarium), OpenStreetMap via Overpass (water, marsh, coastline, roads),
OSM power data already cached by pipeline/fetch_osm.py, Sperry's Projects_Overlaps.xlsx sample.
Tiles are cached in world3d/cache so a level only downloads once.
"""
import argparse
import csv
import json
import math
import time
import urllib.parse
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

EXAGGERATION = 6.0     # default; the coastal plain is ~0-30 m, so bluffs and river valleys need the help
GRID_SPACING_M = 120.0  # terrain sample spacing
TEX_WIDTH = 8192        # ground texture width in px (~6.5 m/px for a 54 km level)

TILES = {
    "terrarium": ("https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png", 12),
}

# (south, west, north, east)
REGIONS = {
    "savannah": {
        "title": "Savannah River",
        "subtitle": "DESC Jasper / Okatie / Bluffton vs GPC McIntosh / Goshen",
        "bbox": (32.00, -81.52, 32.50, -80.53), "exaggeration": 6.0,
        "places": [
            ("SAVANNAH", 32.0809, -81.0912, "city"), ("POOLER", 32.1155, -81.2471, "town"),
            ("PORT WENTWORTH", 32.1491, -81.1632, "town"), ("RINCON", 32.2960, -81.2354, "town"),
            ("HARDEEVILLE", 32.2871, -81.0790, "town"), ("BLUFFTON", 32.2371, -80.8604, "town"),
            ("GEORGIA", 32.150, -81.240, "state"), ("SOUTH CAROLINA", 32.400, -80.980, "state"),
            ("BEAUFORT", 32.4316, -80.6698, "town"), ("HILTON HEAD", 32.2163, -80.7526, "town"),
            ("HYUNDAI METAPLANT", 32.1450, -81.4750, "town"),
        ],
    },
    "augusta": {
        "title": "Augusta / Thurmond",
        "subtitle": "DESC Stevens Creek / Hooks / Thurmond vs GPC Evans - Thurmond Dam",
        "bbox": (33.28, -82.46, 33.75, -81.60), "exaggeration": 2.5,
        "places": [
            ("AUGUSTA", 33.4735, -82.0105, "city"), ("NORTH AUGUSTA", 33.5018, -81.9651, "town"),
            ("EVANS", 33.5337, -82.1307, "town"), ("MARTINEZ", 33.5174, -82.0757, "town"),
            ("GEORGIA", 33.45, -82.25, "state"), ("SOUTH CAROLINA", 33.70, -81.95, "state"),
            ("AIKEN", 33.5604, -81.7196, "town"),
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


def sample_tiles(src, lat, lon, z=None):
    """Bilinear-sample a tile source at arrays of lat/lon. Returns float32 [..., 3]."""
    z = z or TILES[src][1]
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


def build_terrain(loc, exaggeration):
    nx = int(round(loc.width / GRID_SPACING_M)) + 1
    ny = int(round(loc.height / GRID_SPACING_M)) + 1
    xs = np.linspace(-loc.width / 2, loc.width / 2, nx)
    ys = np.linspace(loc.height / 2, -loc.height / 2, ny)  # row 0 = north
    gx, gy = np.meshgrid(xs, ys)
    lat, lon = loc.latlon(gx, gy)
    rgb = sample_tiles("terrarium", lat, lon)
    elev = rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768
    print(f"  elevation m: min {elev.min():.1f}  p50 {np.median(elev):.1f}  p99 {np.percentile(elev, 99):.1f}  max {elev.max():.1f}")
    # water sits at 0: clamp dredged channels/bathymetry flat, and knock out the few >40 m tile-seam spikes
    import cv2
    elev = cv2.medianBlur(np.clip(elev, 0.0, np.percentile(elev, 99.95) + 5).astype(np.float32), 3)
    return (elev * exaggeration).astype(np.float32), nx, ny


# ---------------------------------------------------------------- ground texture (drawn from OSM vectors)
# CARTO's raster tiles now answer "API KEY REQUIRED", so we paint our own map: full control of the palette.
OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
ROADS = {  # class -> (px width at 8192, rgb); drawn small to big so highways sit on top
    "residential": (1, (16, 29, 58)), "unclassified": (1, (16, 29, 58)),
    "tertiary": (2, (24, 44, 92)), "secondary": (2, (24, 44, 92)),
    "primary_link": (2, (40, 72, 160)), "trunk_link": (2, (40, 72, 160)), "motorway_link": (2, (58, 94, 200)),
    "primary": (3, (40, 72, 160)), "trunk": (3, (40, 72, 160)), "motorway": (4, (70, 110, 230)),
}
LAND, MARSH, WATER, SHORE = (6, 11, 22), (9, 18, 34), (2, 5, 12), (27, 60, 120)
KM_GRID, KM5_GRID = (10, 19, 38), (15, 29, 58)


def fetch_basemap(region, bbox):
    import hashlib
    path = CACHE / f"osm_basemap_{region}_{hashlib.sha1(repr(tuple(bbox)).encode()).hexdigest()[:8]}.json"
    if path.exists():
        return json.load(open(path, encoding="utf-8"))
    b = ",".join(str(v) for v in bbox)
    road_re = "|".join(ROADS)
    parts = [
        f'''way["natural"="water"]({b}); relation["natural"="water"]({b}); way["waterway"="riverbank"]({b});
  way["natural"="coastline"]({b}); way["natural"="wetland"]({b}); relation["natural"="wetland"]({b});''',
        f'''way["highway"~"^({road_re})$"]({b}); way["railway"="rail"]({b}); way["aeroway"="runway"]({b});''',
    ]
    elements = []
    for part in parts:
        body = urllib.parse.urlencode({"data": f"[out:json][timeout:300];\n(\n  {part}\n);\nout geom;"}).encode()
        last = None
        for attempt in range(6):
            ep = OVERPASS[attempt % len(OVERPASS)]
            try:
                req = urllib.request.Request(ep, data=body, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=360) as r:
                    elements += json.loads(r.read())["elements"]
                break
            except Exception as err:  # noqa: BLE001 - busy mirrors answer 429/504; back off and rotate
                last = err
                print(f"  overpass {ep} failed ({err}); retrying")
                time.sleep(10 * (attempt + 1))
        else:
            raise RuntimeError(f"all Overpass attempts failed: {last}")
    data = {"elements": elements}
    CACHE.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return data


def assemble_rings(ways):
    """Join member ways (lists of (lat, lon)) that share endpoints into rings."""
    segs = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while segs:
        ring = segs.pop()
        grown = True
        while ring[0] != ring[-1] and grown:
            grown = False
            for i, s in enumerate(segs):
                if s[0] == ring[-1]:
                    ring = ring + s[1:]
                elif s[-1] == ring[-1]:
                    ring = ring + s[::-1][1:]
                elif s[-1] == ring[0]:
                    ring = s[:-1] + ring
                elif s[0] == ring[0]:
                    ring = s[::-1][:-1] + ring
                else:
                    continue
                segs.pop(i)
                grown = True
                break
        rings.append(ring)
    return rings


def build_ground(loc, region, bbox):
    import cv2  # only needed here

    tw = TEX_WIDTH
    th = int(round(TEX_WIDTH * loc.height / loc.width))
    sx, sy = tw / loc.width, th / loc.height

    def px(latlon):
        a = np.array([loc.xy(lat, lon) for lat, lon in latlon], dtype=np.float64)
        return np.stack([(a[:, 0] + loc.width / 2) * sx, (loc.height / 2 - a[:, 1]) * sy], axis=1)

    def poly(p):
        return (p * 16).astype(np.int32).reshape(-1, 1, 2)  # 4 bits of sub-pixel precision

    data = fetch_basemap(region, bbox)
    els = data["elements"]
    print(f"  basemap elements: {len(els)}")

    def geom(el):
        return [(g["lat"], g["lon"]) for g in el.get("geometry", [])]

    def areas(pred):
        """Yield (outer rings, inner rings) for matching closed ways and multipolygon relations."""
        for el in els:
            tags = el.get("tags", {})
            if not pred(tags):
                continue
            if el["type"] == "way":
                g = geom(el)
                if len(g) >= 3 and g[0] == g[-1]:
                    yield [g], []
            elif el["type"] == "relation":
                outer = [geom(m) for m in el.get("members", []) if m.get("role") != "inner" and m.get("geometry")]
                inner = [[(g["lat"], g["lon"]) for g in m["geometry"]] for m in el.get("members", []) if m.get("role") == "inner" and m.get("geometry")]
                yield assemble_rings(outer), assemble_rings(inner)

    def area_mask(pred):
        m = np.zeros((th, tw), np.uint8)
        for outer, inner in areas(pred):
            cv2.fillPoly(m, [poly(px(r)) for r in outer if len(r) >= 3], 255, cv2.LINE_8, shift=4)
            if inner:
                cv2.fillPoly(m, [poly(px(r)) for r in inner if len(r) >= 3], 0, cv2.LINE_8, shift=4)
        return m > 0

    water = area_mask(lambda t: t.get("natural") == "water" or t.get("waterway") == "riverbank")
    marsh = area_mask(lambda t: t.get("natural") == "wetland")

    # sea: OSM coastline keeps land on the left, so flood the components on its right-hand side
    coast = [px(geom(el)) for el in els if el["type"] == "way" and el.get("tags", {}).get("natural") == "coastline"]
    if coast:
        barrier = np.zeros((th, tw), np.uint8)
        for c in coast:
            cv2.polylines(barrier, [poly(c)], False, 255, 2, cv2.LINE_8, shift=4)
        n, labels = cv2.connectedComponents((barrier == 0).astype(np.uint8), connectivity=4)
        votes = np.zeros(n, np.int64)
        for c in coast:
            d = np.diff(c, axis=0)
            length = np.hypot(d[:, 0], d[:, 1])
            ok = length > 0.5
            mid = (c[:-1] + c[1:])[ok] / 2
            nrm = np.stack([-d[ok, 1], d[ok, 0]], axis=1) / length[ok, None]  # right-hand side in pixel space
            for sign in (1, -1):
                p = np.rint(mid + sign * 4 * nrm).astype(int)
                inside = (p[:, 0] >= 0) & (p[:, 0] < tw) & (p[:, 1] >= 0) & (p[:, 1] < th)
                np.add.at(votes, labels[p[inside, 1], p[inside, 0]], sign)
        votes[0] = 0  # label 0 is the barrier itself
        sea = votes[labels] > 0
        SEA[region] = sea   # reused by build_satellite: paint open sea over USGS's smeared coastal tiles
        water |= sea
        water |= (barrier > 0) & (cv2.dilate(sea.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0)
        print(f"  coastline ways: {len(coast)}, sea px: {sea.mean() * 100:.1f}%")

    img = np.empty((th, tw, 3), np.uint8)
    img[:] = LAND
    img[marsh] = MARSH
    img[water] = WATER
    edge = cv2.morphologyEx(water.astype(np.uint8), cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8)) > 0
    img[edge & ~water] = SHORE

    # 1 km scale grid (the HUD layer; every 5th line brighter) so distances read at a glance
    for axis, extent, scale, count in ((0, loc.width, sx, tw), (1, loc.height, sy, th)):
        for k in range(-int(extent / 2000), int(extent / 2000) + 1):
            p = int(round((k * 1000 + extent / 2) * scale)) if axis == 0 else int(round((extent / 2 - k * 1000) * scale))
            if 0 <= p < count:
                col = KM5_GRID if k % 5 == 0 else KM_GRID
                if axis == 0:
                    img[:, p][~water[:, p]] = col
                else:
                    img[p, :][~water[p, :]] = col

    order = {c: i for i, c in enumerate(ROADS)}
    lines = []
    for el in els:
        t = el.get("tags", {})
        if el["type"] != "way":
            continue
        if t.get("highway") in ROADS:
            w, col = ROADS[t["highway"]]
            lines.append((order[t["highway"]], w, col, el))
        elif t.get("railway") == "rail":
            lines.append((-1, 1, (22, 36, 70), el))
        elif t.get("aeroway") == "runway":
            lines.append((-2, 7, (20, 34, 64), el))
    for _, w, col, el in sorted(lines, key=lambda r: r[0]):
        cv2.polylines(img, [poly(px(geom(el)))], False, col, w, cv2.LINE_AA, shift=4)
    print(f"  roads/rail/runways drawn: {len(lines)}  water {water.mean() * 100:.1f}%  marsh {marsh.mean() * 100:.1f}%")
    # half-res water mask: Blender uses it for glossy water, the viewer for shimmer
    Image.fromarray((water * 255).astype(np.uint8)).resize((tw // 2, th // 2), Image.BILINEAR).save(BUILD / region / "water.png", optimize=True)
    return Image.fromarray(img), (tw, th)


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


def build_projects(loc, z_at, path, must_include=()):
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
        if not ends or not (any(loc.inside(e["x"], e["y"], pad=2000) for e in ends) or r.get("project_id") in must_include):
            continue
        util = r.get("utility") or ""
        d = parse_date(r.get("in_service_date"))
        s = parse_date(r.get("start_date"))
        out.append({
            "id": r.get("project_id"), "utility": util, "side": "DESC" if "Dominion" in util else "GPC",
            "name": r.get("project_name"), "kind": "line" if len(ends) == 2 else "point",
            "a": ends[0], "b": ends[1] if len(ends) == 2 else None,
            "in_service": d.isoformat() if d else None, "start": s.isoformat() if s else None,
            "conf": r.get("location_confidence") or "sample", "source_page": r.get("source_page"),
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


def pipeline_overlaps(path, loc, z_at):
    """Overlaps ranked by the GridLock pipeline whose two closest points both fall inside this level."""
    out = []
    for o in json.load(open(path, encoding="utf-8")):
        (lon_a, lat_a), (lon_b, lat_b) = o["closest_points"]
        pa, pb = loc.xy(lat_a, lon_a), loc.xy(lat_b, lon_b)
        if not (loc.inside(*pa) and loc.inside(*pb)):
            continue
        out.append({
            "id": o["id"], "rank": o["rank"], "a": o["a"], "b": o["b"],
            "dist_km": round(o["closest_km"], 2), "center_dist_km": o.get("center_km"),
            "tier": o["tier"], "tier_label": o.get("can_share") or o.get("tier_label"),
            "time_gap_days": o.get("isd_gap_days"), "overlap_days": o.get("overlap_days"),
            "window_gap_days": o.get("window_gap_days"), "a_window": o.get("a_window"), "b_window": o.get("b_window"),
            "score": o.get("score"), "why": o.get("why"), "check": o.get("needs_location_check"),
            "shared_corridor_km": o.get("shared_corridor_km"), "lines_cross": o.get("lines_cross"),
            "pa": [round(pa[0], 1), round(pa[1], 1), round(z_at(*pa), 1)],
            "pb": [round(pb[0], 1), round(pb[1], 1), round(z_at(*pb), 1)],
        })
    out.sort(key=lambda o: o["rank"])
    for i, o in enumerate(out, 1):
        o["level_rank"] = i
    print(f"  pipeline overlaps in level: {len(out)} (global ranks {[o['rank'] for o in out[:8]]}...)")
    return out


# ---------------------------------------------------------------- real structures (OSM) around the project sites
STRUCT_RADIUS_M = 2200


def overpass_json(query, cache_path):
    """POST a query to Overpass with polite retries (busy mirrors answer 429/504), cached on disk."""
    if cache_path.exists():
        return json.load(open(cache_path, encoding="utf-8"))
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for attempt in range(6):
        ep = OVERPASS[attempt % len(OVERPASS)]
        try:
            req = urllib.request.Request(ep, data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=360) as r:
                data = json.loads(r.read())
            CACHE.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(json.dumps(data), encoding="utf-8")
            return data
        except Exception as err:  # noqa: BLE001
            last = err
            print(f"  overpass {ep} failed ({err}); retrying")
            time.sleep(12 * (attempt + 1))
    raise RuntimeError(f"all Overpass attempts failed: {last}")


def structure_sites(loc, projects, overlaps):
    """Project endpoints + top overlap points, merged within 1.5 km: where we want real buildings."""
    pts = [(e["x"], e["y"]) for p in projects for e in (p["a"], p["b"]) if e and loc.inside(e["x"], e["y"])]
    pts += [tuple(o[k][:2]) for o in overlaps if o["level_rank"] <= 8 for k in ("pa", "pb")]
    sites = []
    for x, y in pts:
        if all(math.hypot(x - sx, y - sy) > 1500 for sx, sy in sites):
            sites.append((x, y))
    return [loc.latlon(x, y) for x, y in sites]


def parse_height(tags, default):
    h = tags.get("height") or tags.get("building:height")
    if h:
        try:
            return float(str(h).lower().replace("m", "").replace("'", "").strip().split(";")[0])
        except ValueError:
            pass
    if tags.get("building:levels"):
        try:
            return float(tags["building:levels"]) * 3.4
        except ValueError:
            pass
    return default


BUILDING_DEFAULT_H = {"industrial": 14, "warehouse": 12, "commercial": 10, "retail": 7, "house": 6, "residential": 7,
                      "detached": 6, "shed": 4, "roof": 6, "garage": 4, "service": 5, "office": 12, "church": 12}


def build_structures(loc, z_at, region, sites):
    """Real power facilities for the whole level + buildings / stacks / tanks around each project site."""
    s, w, n, e = (round(v, 4) for v in (loc.lat0 - loc.height / 2 / loc.ky, loc.lon0 - loc.width / 2 / loc.kx,
                                         loc.lat0 + loc.height / 2 / loc.ky, loc.lon0 + loc.width / 2 / loc.kx))
    b = f"{s},{w},{n},{e}"
    around = "".join(
        f'way["building"](around:{STRUCT_RADIUS_M},{la:.5f},{lo:.5f});'
        f'nwr["man_made"~"^(chimney|cooling_tower|storage_tank|silo|tower)$"](around:{STRUCT_RADIUS_M},{la:.5f},{lo:.5f});'
        for la, lo in sites)
    query = f"""[out:json][timeout:240];
(
  way["power"~"^(substation|plant)$"]({b}); relation["power"~"^(substation|plant)$"]({b});
  node["power"~"^(transformer|portal|switch|compensator|converter)$"]({b});
  way["power"~"^(portal|busbar|bay)$"]({b});
  {around}
);
out geom;"""
    import hashlib  # cache per site list, so moved/removed projects refetch their surroundings
    key = hashlib.sha1((b + ";" + ",".join(f"{la:.3f},{lo:.3f}" for la, lo in sites)).encode()).hexdigest()[:10]
    els = overpass_json(query, CACHE / f"osm_structures_{region}_{key}.json")["elements"]

    def ring_xy(g):
        return [[round(v, 1) for v in loc.xy(lat, lon)] for lat, lon in g]

    def geom(el):
        return [(p["lat"], p["lon"]) for p in el.get("geometry", [])]

    facilities, buildings, equipment, busbars, stacks = [], [], [], [], []
    for el in els:
        t = el.get("tags", {})
        power, mm = t.get("power"), t.get("man_made")
        if el["type"] in ("way", "relation") and power in ("substation", "plant"):
            if el["type"] == "way":
                g = geom(el)
                outer, inner = ([g], []) if len(g) >= 4 and g[0] == g[-1] else ([], [])
            else:
                outer = assemble_rings([geom(m) for m in el.get("members", []) if m.get("role") != "inner" and m.get("geometry")])
                inner = assemble_rings([geom(m) for m in el.get("members", []) if m.get("role") == "inner" and m.get("geometry")])
            outer = [r for r in outer if len(r) >= 4 and r[0] == r[-1]]
            if not outer:
                continue
            rings = [ring_xy(r) for r in outer]
            cx = float(np.mean([p[0] for r in rings for p in r]))
            cy = float(np.mean([p[1] for r in rings for p in r]))
            if not loc.inside(cx, cy, pad=-100):
                continue
            facilities.append({"kind": power, "name": t.get("name"), "op": t.get("operator"), "kv": kv_of(t),
                               "rings": rings, "holes": [ring_xy(r) for r in inner if len(r) >= 4], "z": round(z_at(cx, cy), 1)})
        elif el["type"] == "way" and "building" in t:
            g = geom(el)
            if len(g) < 4 or g[0] != g[-1]:
                continue
            ring = ring_xy(g)
            cx, cy = float(np.mean([p[0] for p in ring])), float(np.mean([p[1] for p in ring]))
            if not loc.inside(cx, cy, pad=-50):
                continue
            buildings.append({"ring": ring, "h": round(parse_height(t, BUILDING_DEFAULT_H.get(t["building"], 8)), 1),
                              "z": round(z_at(cx, cy), 1), "name": t.get("name")})
        elif mm in ("chimney", "cooling_tower", "storage_tank", "silo", "tower"):
            g = geom(el) if el["type"] != "node" else [(el["lat"], el["lon"])]
            if not g:
                continue
            ring = ring_xy(g)
            cx, cy = float(np.mean([p[0] for p in ring])), float(np.mean([p[1] for p in ring]))
            if not loc.inside(cx, cy, pad=-50):
                continue
            r = max(3.0, float(np.max([math.hypot(p[0] - cx, p[1] - cy) for p in ring]))) if len(ring) > 2 else {"chimney": 4, "storage_tank": 12}.get(mm, 5)
            default_h = {"chimney": 60, "cooling_tower": 45, "storage_tank": 14, "silo": 20, "tower": 30}[mm]
            stacks.append({"kind": mm, "x": round(cx, 1), "y": round(cy, 1), "z": round(z_at(cx, cy), 1),
                           "r": round(min(r, 45), 1), "h": round(parse_height(t, default_h), 1)})
        elif el["type"] == "node" and power in ("transformer", "portal", "switch", "compensator", "converter"):
            x, y = loc.xy(el["lat"], el["lon"])
            if loc.inside(x, y):
                equipment.append({"type": power, "x": round(x, 1), "y": round(y, 1), "z": round(z_at(x, y), 1)})
        elif el["type"] == "way" and power in ("busbar", "bay", "portal"):
            g = geom(el)
            if len(g) >= 2:
                pts = [[round(v, 1) for v in loc.xy(lat, lon)] for lat, lon in g]
                busbars.append({"type": power, "pts": [[x, y, round(z_at(x, y), 1)] for x, y in pts]})
    print(f"  real structures: {len(facilities)} substations/plants, {len(buildings)} buildings, {len(equipment)} equipment, "
          f"{len(busbars)} busbars/portals, {len(stacks)} stacks/tanks (around {len(sites)} sites)")
    return {"facilities": facilities, "buildings": buildings, "equipment": equipment, "busbars": busbars, "stacks": stacks,
            "radius_m": STRUCT_RADIUS_M}


# ---------------------------------------------------------------- satellite ground (USGS The National Map, public domain)
SAT_URL = "https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"
SAT_Z, PATCH_Z = 14, 16          # whole level ~8 m/px source; site patches ~2 m/px
PATCH_M, PATCH_PX = 4000, 2048   # 4 km squares around the top overlap sites


def fetch_sat_tile(z, x, y):
    path = CACHE / "tiles" / "usgs_sat" / str(z) / str(x) / f"{y}.jpg"
    if path.exists():
        return path
    req = urllib.request.Request(SAT_URL.format(z=z, x=x, y=y), headers={"User-Agent": UA})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                data = r.read()
            break
        except Exception as err:  # noqa: BLE001
            if attempt == 3:
                print(f"  sat tile {z}/{x}/{y} failed: {err}")
                return None
            time.sleep(1.5 * (attempt + 1))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def sat_warp(loc, box, out_w, out_h, z, strips=96):
    """Fetch the Web Mercator tiles covering `box` (local meters: west, south, east, north) and resample them onto
    the level's local grid. Latitude -> Mercator y is non-linear, so the warp is done in thin affine strips."""
    from concurrent.futures import ThreadPoolExecutor
    xa, ya, xb, yb = box
    lat_n, lon_w = loc.latlon(xa, yb)
    lat_s, lon_e = loc.latlon(xb, ya)
    px0, py0 = merc_px(lat_n, lon_w, z)
    px1, py1 = merc_px(lat_s, lon_e, z)
    tx0, ty0, tx1, ty1 = int(px0 // 256), int(py0 // 256), int(px1 // 256), int(py1 // 256)
    jobs = [(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)]
    with ThreadPoolExecutor(8) as ex:
        paths = list(ex.map(lambda t: fetch_sat_tile(z, *t), jobs))
    mos = Image.new("RGB", ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256))
    for (tx, ty), path in zip(jobs, paths):
        if path:
            try:
                mos.paste(Image.open(path).convert("RGB"), ((tx - tx0) * 256, (ty - ty0) * 256))
            except OSError:
                pass  # a bad tile stays black
    ox, oy = tx0 * 256, ty0 * 256
    scale = min(1.0, out_w / (px1 - px0))  # pre-shrink with a real filter so the warp doesn't alias
    if scale < 0.98:
        mos = mos.resize((max(1, round(mos.width * scale)), max(1, round(mos.height * scale))), Image.BOX)
    mesh = []
    for i in range(strips):
        r0, r1 = i * out_h // strips, (i + 1) * out_h // strips
        y_top, y_bot = yb - r0 / out_h * (yb - ya), yb - r1 / out_h * (yb - ya)
        la_t, _ = loc.latlon(xa, y_top)
        la_b, _ = loc.latlon(xa, y_bot)
        _, qy_t = merc_px(la_t, lon_w, z)
        _, qy_b = merc_px(la_b, lon_w, z)
        qx_w, qx_e = (px0 - ox) * scale, (px1 - ox) * scale
        qt, qb = (float(qy_t) - oy) * scale, (float(qy_b) - oy) * scale
        mesh.append(((0, r0, out_w, r1), (float(qx_w), qt, float(qx_w), qb, float(qx_e), qb, float(qx_e), qt)))
    print(f"  usgs z{z}: {len(jobs)} tiles -> {out_w}x{out_h}")
    return mos.transform((out_w, out_h), Image.MESH, mesh, Image.BILINEAR)


SEA = {}   # region -> OSM open-sea mask at ground-texture resolution (set by build_ground)


def fill_nodata(img, sea=(44, 68, 80)):
    """USGS has no imagery over open ocean: those tiles come back black. Paint them sea-colored instead."""
    a = np.asarray(img).copy()
    a[a.max(axis=2) < 12] = sea
    return Image.fromarray(a)


def build_satellite(loc, out, overlaps, tex_w, tex_h):
    """ground_sat.webp for the whole level, sharper patches around the top overlaps, and a vegetation mask."""
    base = fill_nodata(sat_warp(loc, (-loc.width / 2, -loc.height / 2, loc.width / 2, loc.height / 2), tex_w, tex_h, SAT_Z))
    sea = SEA.get(out.name)
    if sea is not None and sea.shape == (tex_h, tex_w):  # open sea from the OSM coastline: USGS smears its tile edges there
        a = np.asarray(base).copy()
        a[sea] = (a[sea] * 0.2 + np.array((44, 68, 80)) * 0.8).astype(np.uint8)
        base = Image.fromarray(a)
    base.save(out / "ground_sat.webp", quality=72, method=4)
    a = np.asarray(base.resize((tex_w // 4, tex_h // 4), Image.BOX)).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    lum = (r + g + b) / 3
    veg = (g >= r + 2) & (g >= b - 4) & (lum > 18) & (lum < 120)   # dark green canopy, not lawns or water
    Image.fromarray((veg * 255).astype(np.uint8)).save(out / "veg.png", optimize=True)
    centers = []
    for o in sorted(overlaps, key=lambda o: o["level_rank"]):
        if o["level_rank"] > 4:
            break
        for pt in (o["pa"], o["pb"]):
            if all(math.hypot(pt[0] - cx, pt[1] - cy) > PATCH_M * 0.6 for cx, cy in centers):
                centers.append((pt[0], pt[1]))
    patches = []
    for i, (cx, cy) in enumerate(centers[:6]):
        cx = min(max(cx, -loc.width / 2 + PATCH_M / 2), loc.width / 2 - PATCH_M / 2)
        cy = min(max(cy, -loc.height / 2 + PATCH_M / 2), loc.height / 2 - PATCH_M / 2)
        box = (cx - PATCH_M / 2, cy - PATCH_M / 2, cx + PATCH_M / 2, cy + PATCH_M / 2)
        img = fill_nodata(sat_warp(loc, box, PATCH_PX, PATCH_PX, PATCH_Z, strips=32))
        name = f"sat_patch_{i}.webp"
        img.save(out / name, quality=78, method=4)
        patches.append({"file": name, "box": [round(v, 1) for v in box], "px": PATCH_PX, "img": img})
    sizes = sum((out / p["file"]).stat().st_size for p in patches) / 1e6
    print(f"  ground_sat.webp {(out / 'ground_sat.webp').stat().st_size / 1e6:.1f} MB, veg {veg.mean() * 100:.0f}%, "
          f"{len(patches)} patches {sizes:.1f} MB")

    def color_at(x, y):
        """Roof color: 3x3 average from the sharpest image covering (x, y)."""
        for p in patches:
            x0, y0, x1, y1 = p["box"]
            if x0 <= x <= x1 and y0 <= y <= y1:
                im, u, v = p["img"], (x - x0) / (x1 - x0), (y1 - y) / (y1 - y0)
                break
        else:
            im, u, v = base, (x + loc.width / 2) / loc.width, (loc.height / 2 - y) / loc.height
        px, py = int(u * (im.width - 3)), int(v * (im.height - 3))
        c = np.asarray(im.crop((px, py, px + 3, py + 3))).reshape(-1, 3).mean(axis=0)
        return [int(v) for v in c]

    m = 60000
    far_box = (-loc.width / 2 - m, -loc.height / 2 - m, loc.width / 2 + m, loc.height / 2 + m)
    far = fill_nodata(sat_warp(loc, far_box, 2048, round(2048 * (loc.height + 2 * m) / (loc.width + 2 * m)), 10, strips=48))
    # no OSM coastline out here, but the terrain tiles carry bathymetry: below -2 m is open sea
    gx, gy = np.meshgrid(np.linspace(far_box[0], far_box[2], far.width // 4), np.linspace(far_box[3], far_box[1], far.height // 4))
    rgb = sample_tiles("terrarium", *loc.latlon(gx, gy), z=9)
    deep = (rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768) < -2
    deep = np.asarray(Image.fromarray((deep * 255).astype(np.uint8)).resize(far.size, Image.BILINEAR)) > 127
    a = np.asarray(far).copy()
    a[deep] = (a[deep] * 0.2 + np.array((44, 68, 80)) * 0.8).astype(np.uint8)
    far = Image.fromarray(a)
    far.save(out / "ground_far.webp", quality=70, method=4)
    meta = {"file": "ground_sat.webp", "veg": "veg.png", "credit": "Imagery: USGS The National Map",
            "far": {"file": "ground_far.webp", "box": [round(v, 1) for v in far_box]},
            "patches": [{k: v for k, v in p.items() if k != "img"} for p in patches]}
    return meta, color_at


def write_buildings_bin(out, structures, color_at=None):
    """Move building footprints out of scene.json into a compact binary the viewer extrudes itself.
    Layout (little-endian): f32 xy[2P] | u16 npts[N] | u16 height_dm[N] | i16 ground_z_dm[N] | u8 rgb[3N];
    rings are open (no repeat) and counter-clockwise; rgb is the roof color sampled from the satellite image."""
    keep = []
    for bl in structures.pop("buildings"):
        r = np.array(bl["ring"][:-1], np.float64)
        if len(r) < 3:
            continue
        area = 0.5 * (np.dot(r[:, 0], np.roll(r[:, 1], -1)) - np.dot(r[:, 1], np.roll(r[:, 0], -1)))  # > 0: CCW
        if abs(area) < 25:  # sheds and slivers
            continue
        if area < 0:
            r = r[::-1]
        keep.append((r, bl["h"], bl["z"]))
    xy = np.concatenate([r for r, _, _ in keep]).astype(np.float32) if keep else np.zeros((0, 2), np.float32)
    npts = np.array([len(r) for r, _, _ in keep], np.uint16)
    h_dm = np.array([min(65535, round(h * 10)) for _, h, _ in keep], np.uint16)
    z_dm = np.array([round(z * 10) for _, _, z in keep], np.int16)
    rgb = np.array([color_at(*r.mean(axis=0)) if color_at else (40, 48, 70) for r, _, _ in keep], np.uint8).reshape(-1)
    with open(out / "buildings.bin", "wb") as f:
        for arr in (xy, npts, h_dm, z_dm, rgb):
            f.write(arr.tobytes())
    structures["buildings"] = {"file": "buildings.bin", "count": len(keep), "points": int(len(xy)),
                               "layout": "f32 xy[2P] | u16 npts[N] | u16 height_dm[N] | i16 ground_z_dm[N] | u8 rgb[3N]",
                               "heights": "OSM height / building:levels where tagged, else a per-type default"}
    print(f"  buildings.bin: {len(keep)} footprints, {len(xy)} points, {(out / 'buildings.bin').stat().st_size / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("region", choices=sorted(REGIONS))
    located = ROOT / "data" / "processed" / "projects_located.csv"
    ranked = ROOT / "data" / "processed" / "overlaps.json"
    sample = ROOT / "data" / "sperry" / "Projects_Overlaps.xlsx"
    ap.add_argument("--projects", default=str(located if located.exists() else sample))
    ap.add_argument("--overlaps", default=str(ranked) if ranked.exists() and located.exists() else "")
    args = ap.parse_args()
    reg = REGIONS[args.region]
    loc = Local(reg["bbox"])
    out = BUILD / args.region
    out.mkdir(parents=True, exist_ok=True)
    print(f"[{args.region}] {loc.width / 1000:.1f} x {loc.height / 1000:.1f} km")

    exag = reg.get("exaggeration", EXAGGERATION)
    terrain, nx, ny = build_terrain(loc, exag)
    terrain.tofile(out / "terrain.bin")
    z_at = sampler(terrain, loc)
    ground, (tw, th) = build_ground(loc, args.region, reg["bbox"])
    ground.save(out / "ground.png", optimize=True)  # lossless master for Blender: flat colors + hairlines
    ground.save(out / "ground.webp", quality=85, method=4)  # ~3 MB instead of ~9 MB, for the browser viewer

    lines, towers = build_grid(loc, z_at, args.region)
    subs = build_substations(loc, z_at)
    if args.overlaps:
        overlaps = pipeline_overlaps(args.overlaps, loc, z_at)
        projects = build_projects(loc, z_at, args.projects, {pid for o in overlaps for pid in (o["a"], o["b"])})
    else:
        projects = build_projects(loc, z_at, args.projects)
        overlaps = build_overlaps(projects, z_at)
        for o in overlaps:
            o["level_rank"] = o["rank"]
    sat_meta, color_at = build_satellite(loc, out, overlaps, tw, th)
    structures = build_structures(loc, z_at, args.region, structure_sites(loc, projects, overlaps))
    write_buildings_bin(out, structures, color_at)
    places = []
    for name, lat, lon, kind in reg["places"]:
        x, y = loc.xy(lat, lon)
        places.append({"name": name, "kind": kind, "x": round(x, 1), "y": round(y, 1), "z": round(z_at(x, y), 1)})

    scene = {
        "region": args.region, "title": reg["title"], "subtitle": reg["subtitle"], "build": int(time.time()),
        "origin": {"lat": loc.lat0, "lon": loc.lon0}, "bbox": reg["bbox"],
        "size_m": [round(loc.width, 1), round(loc.height, 1)],
        "terrain": {"file": "terrain.bin", "nx": nx, "ny": ny, "exaggeration": exag, "row0": "north",
                    "zmax": round(float(terrain.max()), 1)},
        "ground": {"file": "ground.png", "web": "ground.webp", "water": "water.png", "px": [tw, th], "sat": sat_meta},
        "tiers": [{"tier": t, "max_km": m, "label": l} for t, m, l in TIERS],
        "projects": projects, "overlaps": overlaps, "places": places,
        "substations": subs, "towers": towers, "grid": lines, "structures": structures,
        "sources": {
            "projects": Path(args.projects).name,
            "overlaps": Path(args.overlaps).name if args.overlaps else "computed here (closest points, straight segments)",
            "grid": "OpenStreetMap power=line / substation (Overpass)",
            "structures": "OpenStreetMap substation/plant outlines, transformers, portals, busbars, buildings (heights estimated when untagged)",
            "terrain": "AWS Terrain Tiles (terrarium), x%g vertical" % exag,
            "basemap": "drawn from OpenStreetMap (c) OpenStreetMap contributors, ODbL",
            "satellite": "USGS The National Map, USGSImageryOnly (public domain)",
        },
    }
    (out / "scene.json").write_text(json.dumps(scene, separators=(",", ":")), encoding="utf-8")
    write_levels_index(args.region, reg, overlaps)
    print(f"  wrote {out}")


def write_levels_index(region, reg, overlaps):
    """build/levels.json: which overlaps each 3D level holds, so the web app can link straight into the viewer."""
    path = BUILD / "levels.json"
    levels = [lv for lv in (json.loads(path.read_text(encoding="utf-8")) if path.exists() else []) if lv["level"] != region]
    levels.append({"level": region, "title": reg["title"], "bbox": list(reg["bbox"]),
                   "overlap_ids": [o["id"] for o in overlaps], "ranks": [o["rank"] for o in overlaps],
                   "viewer": f"viewer/?level={region}&select=<overlap id or global rank>"})
    order = list(REGIONS)
    levels.sort(key=lambda lv: order.index(lv["level"]) if lv["level"] in order else len(order))
    path.write_text(json.dumps(levels, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
