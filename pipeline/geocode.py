"""Give every project's named sub-points real coordinates.

Method (Sperry's "Finding Real Locations" guide, Parts 1-2):
  1. Match each sub-point name (e.g. "EVANS PRIMARY") against named OpenStreetMap substations/plants.
  2. Disambiguate same-named features with area hints ("SAV:" / "(SAV)" = Savannah), the owning
     utility's operator tag, and distance to the project's other sub-point.
  3. Apply manual overrides (data/overrides/locations_manual.csv) for sub-points that OSM does not name,
     each with a source and a confidence level.
  4. Validate against the coordinates in Sperry's sample (Projects_Overlaps.xlsx).

Output: data/processed/projects_located.json
"""
import csv
import difflib
import json
import math
import re
import time
import urllib.parse
import urllib.request
from pathlib import Path

from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
OSM_POINTS = ROOT / "data" / "osm" / "power_points.json"
OVERRIDES = ROOT / "data" / "overrides" / "locations_manual.csv"
POINT_FIXES = ROOT / "data" / "overrides" / "project_points.csv"
STATES = ROOT / "data" / "reference" / "us_states.geojson"
NOMINATIM_CACHE = ROOT / "data" / "reference" / "nominatim_cache.json"
USER_AGENT = "GridLock-ShellHacks2026/0.1 (hackathon project)"

HOME_STATE = {"GPC": "Georgia", "DESC": "South Carolina"}
CROSS_BORDER_KM = 15  # tie points sit on the Savannah River, so allow a little slack across the border
NOT_PLACES = {"CC", "GRID", "JUMPER", "TIE BREAKER", "SWITCH WAY", "SMART VALVE", "SKC", "MICROSOFT", "HALF STATION",
              "TRIBUTARY", "LG E MONROE", "PROJECT CHRONOS", "NORTH GEORGIA DATA", "EMBLEM RIVERSIDE",
              "SCOUT"}  # DESC's new "Scout" 230 kV sub: no public location; Nominatim's Scout Island is a guess

AREA_HINTS = {  # south, west, north, east
    "SAV": (31.6, -81.9, 32.6, -80.8),
}
UTILITY_OPERATORS = {
    "GPC": ("georgia power", "southern company", "georgia transmission", "gtc", "meag", "oglethorpe", "u.s. corps", "savannah electric"),
    "DESC": ("dominion", "south carolina electric", "south carolina gas", "sce&g", "sceg", "santee cooper", "u.s. corps"),
}
GENERIC = {
    "SUBSTATION", "SUB", "SS", "SWITCHING", "STATION", "SWITCHYARD", "SWITCH", "YARD", "GENERATING", "PLANT",
    "POWER", "FACILITY", "ELECTRIC", "STEAM", "COMBINED", "CYCLE", "HYDROELECTRIC", "HYDRO", "TRANSMISSION",
    "DISTRIBUTION", "THE", "OF", "KV", "SITE",
}
OPTIONAL = {"PRIMARY", "DAM", "LAKE", "USA", "SAV", "JCT", "JUNCTION", "CITY", "COUNTY", "TIE", "DEP"}


def haversine_km(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def tokens(name: str):
    s = name.upper().replace("&", " AND ").replace("’", "'")
    s = re.sub(r"\(\s*\d+\s*KV[^)]*\)", " ", s)          # "(230KV)" / "(500KV/230KV)"
    s = re.sub(r"\b\d+\s*KV\b", " ", s)
    s = re.sub(r"#\s*\d+", " ", s)
    s = re.sub(r"[^A-Z0-9 ]", " ", s)
    s = s.replace("QUEENSBOROUGH", "QUEENSBORO").replace("SAINT ", "ST ").replace("FORT ", "FT ")
    return [t for t in s.split() if t and t not in GENERIC]


def core(name: str, drop_optional=False):
    toks = tokens(name)
    if drop_optional:
        toks = [t for t in toks if t not in OPTIONAL]
    return " ".join(toks)


def in_box(lat, lon, box):
    s, w, n, e = box
    return s <= lat <= n and w <= lon <= e


_STATE_SHAPES = None


def state_shapes():
    global _STATE_SHAPES
    if _STATE_SHAPES is None:
        gj = json.loads(STATES.read_text(encoding="utf-8"))
        _STATE_SHAPES = {f["properties"]["name"]: shape(f["geometry"]) for f in gj["features"]}
    return _STATE_SHAPES


def km_outside_state(lat, lon, state):
    """0 if the point is inside `state`, else the approximate distance to it in km."""
    geom = state_shapes()[state]
    p = Point(lon, lat)
    if geom.contains(p):
        return 0.0
    return geom.distance(p) * 111.0 * math.cos(math.radians(lat)) ** 0.5


def load_osm():
    pts = json.loads(OSM_POINTS.read_text(encoding="utf-8"))
    named = []
    for p in pts:
        nm = p["tags"].get("name")
        if not nm:
            continue
        named.append({**p, "name": nm, "core": core(nm), "core2": core(nm, True), "toks": set(tokens(nm))})
    return named


def candidates(point_name: str, osm):
    """Score every named OSM feature against one sub-point name. Returns best-first list."""
    c1, c2 = core(point_name), core(point_name, True)
    want = set(tokens(point_name)) - OPTIONAL
    out = []
    for f in osm:
        if c1 and f["core"] == c1:
            s, how = 1.0, "exact"
        elif c2 and f["core2"] == c2:
            s, how = 0.92, "exact (ignoring qualifiers)"
        elif want and want <= f["toks"] and len(f["toks"] - want) <= 2:
            s, how = 0.78, "all name words present"
        elif len(f["toks"]) >= 2 and f["toks"] <= want and len(want - f["toks"]) <= 1:
            s, how = 0.75, "OSM name contained in project name"
        else:
            r = difflib.SequenceMatcher(None, c2, f["core2"]).ratio() if c2 and f["core2"] else 0
            if r < 0.88:
                continue
            s, how = 0.7 + (r - 0.88), f"fuzzy {r:.2f}"
        out.append({"f": f, "score": s, "how": how})
    return out


def pick(point_name, cands, utility, area_box, partner):
    """Choose one candidate using operator, area hint, feature type and partner distance."""
    if not cands:
        return None
    ops = UTILITY_OPERATORS[utility]
    for c in cands:
        f, bonus = c["f"], 0.0
        op = f["tags"].get("operator", "").lower()
        if any(o in op for o in ops):
            bonus += 0.12
        elif op:
            bonus -= 0.05
        if f["tags"].get("power") == "substation":
            bonus += 0.05
        if area_box and in_box(f["lat"], f["lon"], area_box):
            bonus += 0.3
        elif area_box:
            bonus -= 0.3
        if partner:
            d = haversine_km(f["lat"], f["lon"], partner[0], partner[1])
            bonus += 0.25 if d < 60 else (-0.4 if d > 150 else 0)
        if km_outside_state(f["lat"], f["lon"], HOME_STATE[utility]) > CROSS_BORDER_KM:
            bonus -= 0.8  # e.g. DESC "Ritter" must not land on a Jacksonville, FL substation
        c["total"] = c["score"] + bonus
    cands = [c for c in cands if c["total"] > 0.5]
    if not cands:
        return None
    cands.sort(key=lambda c: -c["total"])
    best = cands[0]
    runner = cands[1]["total"] if len(cands) > 1 else -1
    same_place = len(cands) > 1 and haversine_km(best["f"]["lat"], best["f"]["lon"], cands[1]["f"]["lat"], cands[1]["f"]["lon"]) < 1.0
    margin_ok = best["total"] - runner >= 0.15 or same_place
    conf = "high" if best["score"] >= 0.92 and margin_ok else ("medium" if best["score"] >= 0.78 else "low")
    return {
        "lat": best["f"]["lat"], "lon": best["f"]["lon"], "osm_id": best["f"]["osm"], "osm_name": best["f"]["name"],
        "osm_operator": best["f"]["tags"].get("operator", ""), "method": f"OSM name match ({best['how']})",
        "confidence": conf, "n_candidates": len(cands),
    }


def load_overrides():
    rows = {}
    if OVERRIDES.exists():
        with open(OVERRIDES, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["utility"] and r["point_name"]:
                    rows[(r["utility"], r["point_name"].upper())] = r
    return rows


class Nominatim:
    """Town/street-level fallback geocoder with an on-disk cache (1 request/second, per OSM policy)."""

    def __init__(self):
        self.cache = json.loads(NOMINATIM_CACHE.read_text(encoding="utf-8")) if NOMINATIM_CACHE.exists() else {}
        self.last = 0.0

    def search(self, q):
        if q not in self.cache:
            wait = 1.1 - (time.time() - self.last)
            if wait > 0:
                time.sleep(wait)
            url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
                {"q": q, "format": "jsonv2", "limit": 5, "countrycodes": "us"})
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=30) as r:
                    self.cache[q] = json.loads(r.read().decode("utf-8"))
            except Exception as e:
                print(f"  nominatim failed for {q!r}: {e}")
                return []
            finally:
                self.last = time.time()
            NOMINATIM_CACHE.write_text(json.dumps(self.cache), encoding="utf-8")
        return self.cache[q]

    def _street_near(self, other_name, state, lat, lon, km=10):
        """Does the project's other end also geocode (as a place or street) within `km` of this point?"""
        if not other_name:
            return False
        main = core(other_name, True)
        for q in (f"{other_name.title()}, {state}", f"{main.title()}, {state}"):
            for r in self.search(q):
                if r.get("category", r.get("class")) in ("place", "highway") and \
                        haversine_km(lat, lon, float(r["lat"]), float(r["lon"])) <= km:
                    return True
        return False

    def locate(self, name, utility, area_box, partner, other_name=""):
        state = HOME_STATE[utility]
        main = core(name, True)
        if not main or main in NOT_PLACES or len(main) < 3:
            return None
        for q in (f"{name.title()}, {state}", f"{main.title()}, {state}"):
            for r in self.search(q):
                # Places, streets, water bodies and industrial sites only: a landmark that merely shares the name
                # (e.g. the Grave of Tomochichi in Savannah) says nothing about where a substation is.
                cat, typ = r.get("category", r.get("class")), r.get("type", "")
                ok = (cat in ("place", "boundary", "natural", "water", "waterway")
                      or (cat == "highway" and typ not in ("track", "path", "footway", "cycleway", "service", "bridleway"))
                      or (cat == "landuse" and typ in ("industrial", "commercial", "port", "railway")))
                # A street name alone is ambiguous ("First Avenue" is in every city; GPC's First Avenue - North
                # Columbus line is in Columbus, GA). Accept a street only if the other end is located nearby, or
                # also geocodes within 10 km of it (Fenwick St + Sand Bar Ferry Rd, both in Augusta).
                if ok and cat == "highway" and partner is None and \
                        not self._street_near(other_name, state, float(r["lat"]), float(r["lon"])):
                    ok = False
                if not ok:
                    continue
                lat, lon = float(r["lat"]), float(r["lon"])
                if km_outside_state(lat, lon, state) > CROSS_BORDER_KM:
                    continue
                if area_box and not in_box(lat, lon, area_box):
                    continue
                if partner and haversine_km(lat, lon, partner[0], partner[1]) > 80:
                    continue  # a line's two ends are rarely more than ~80 km apart
                first = main.split()[0]
                if first.lower() not in r.get("display_name", "").lower():
                    continue
                kind = f"{r.get('category', r.get('class', ''))}/{r.get('type', '')}"
                return {"lat": lat, "lon": lon, "osm_id": f"{r.get('osm_type', '')}/{r.get('osm_id', '')}",
                        "osm_name": r.get("display_name", "")[:80], "osm_operator": "",
                        "method": f"approximate: Nominatim {kind} (town/street level, not the substation itself)",
                        "confidence": "low", "n_candidates": 0}
        return None


def locate_point(name, utility, area_box, partner, osm, overrides, nominatim=None, other_name=""):
    if not name:
        return None
    ov = overrides.get((utility, name.upper()))
    if ov:
        return {"lat": float(ov["lat"]), "lon": float(ov["lon"]), "osm_id": ov.get("osm_id", ""),
                "osm_name": ov.get("matched_feature", ""), "osm_operator": "", "method": f"manual: {ov['source']}",
                "confidence": ov["confidence"], "note": ov.get("note", ""), "n_candidates": 0}
    hit = pick(name, candidates(name, osm), utility, area_box, partner)
    if hit is None and nominatim is not None:
        hit = nominatim.locate(name, utility, area_box, partner, other_name)
    return hit


def load_point_fixes():
    fixes = {}
    if POINT_FIXES.exists():
        with open(POINT_FIXES, encoding="utf-8") as f:
            for r in csv.DictReader(f):
                fixes[r["project_id"]] = r
    return fixes


def main():
    osm = load_osm()
    overrides = load_overrides()
    fixes = load_point_fixes()
    nominatim = Nominatim()
    projects = json.loads((PROC / "desc_projects.json").read_text(encoding="utf-8")) + \
        json.loads((PROC / "gpc_projects.json").read_text(encoding="utf-8"))

    for p in projects:
        util = p["utility_code"]
        fix = fixes.get(p["project_id"])
        if fix:
            p["name_a"], p["name_b"], p["point_fix_note"] = fix["name_a"], fix["name_b"], fix["note"]
        hint = "SAV" if p.get("area_prefix") == "SAV" or "(SAV)" in p["project_name"] else None
        box = AREA_HINTS.get(hint)
        # Pass 1: OSM only, no partner. Pass 2: re-pick each end using the other end as a partner,
        # falling back to Nominatim for names OSM does not know.
        a = locate_point(p["name_a"], util, box, None, osm, overrides)
        b = locate_point(p["name_b"], util, box, None, osm, overrides)
        if p["name_b"]:
            b = locate_point(p["name_b"], util, box, (a["lat"], a["lon"]) if a else None, osm, overrides, nominatim,
                             other_name=p["name_a"]) or b
        if p["name_a"]:
            a = locate_point(p["name_a"], util, box, (b["lat"], b["lon"]) if b else None, osm, overrides, nominatim,
                             other_name=p["name_b"]) or a
        p["loc_a"], p["loc_b"] = a, b
        pts = [x for x in (a, b) if x]
        if len(pts) == 2:
            p["geometry"] = {"type": "LineString", "coordinates": [[a["lon"], a["lat"]], [b["lon"], b["lat"]]]}
            p["straight_length_km"] = round(haversine_km(a["lat"], a["lon"], b["lat"], b["lon"]), 2)
        elif len(pts) == 1:
            p["geometry"] = {"type": "Point", "coordinates": [pts[0]["lon"], pts[0]["lat"]]}
        else:
            p["geometry"] = None
        # Sperry's center point: midpoint of the two sub-points, or the single located point.
        p["center"] = [sum(x["lon"] for x in pts) / len(pts), sum(x["lat"] for x in pts) / len(pts)] if pts else None
        confs = [x["confidence"] for x in pts]
        p["location_confidence"] = "none" if not pts else ("low" if "low" in confs else ("medium" if "medium" in confs or len(pts) < (2 if p["name_b"] else 1) else "high"))

    (PROC / "projects_located.json").write_text(json.dumps(projects, indent=1), encoding="utf-8")

    for util in ("DESC", "GPC"):
        rows = [p for p in projects if p["utility_code"] == util]
        ends = [(p, k) for p in rows for k in ("a", "b") if p[f"name_{k}"]]
        found = [(p, k) for p, k in ends if p[f"loc_{k}"]]
        by_conf = {}
        for p in rows:
            by_conf[p["location_confidence"]] = by_conf.get(p["location_confidence"], 0) + 1
        print(f"{util}: sub-points located {len(found)}/{len(ends)}; projects by confidence {by_conf}")
    return projects


if __name__ == "__main__":
    main()
