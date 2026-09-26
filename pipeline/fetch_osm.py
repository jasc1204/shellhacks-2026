"""Download power infrastructure from OpenStreetMap (Overpass API) for Georgia + South Carolina.

This follows Sperry's "Finding Real Locations" guide (Part 1): query OSM for all substations/plants
at once, cache the result as JSON, and match project names against it in geocode.py.

Outputs (data/osm/):
  - power_points.json: every power=substation / power=plant feature (center point + tags)
  - power_lines_<area>.json: power=line ways with full geometry for the border areas (map backdrop / routing)
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OSM_DIR = ROOT / "data" / "osm"
ENDPOINTS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"]
USER_AGENT = "GridLock-ShellHacks2026/0.1 (hackathon project; contact via GitHub)"

# South, West, North, East
GA_SC_BBOX = (30.3, -85.7, 35.3, -78.4)
BORDER_AREAS = {
    # Savannah / Jasper / Beaufort: McIntosh, Purrysburg, Jasper, Okatie, Bluffton, Yemassee
    "savannah": (31.85, -81.60, 32.75, -80.55),
    # Augusta / Aiken / Thurmond: Evans, Thurmond Dam, Stevens Creek, Hooks, Urquhart, Vogtle, Thomson
    "augusta": (32.95, -82.75, 33.95, -81.35),
}


def overpass(query: str) -> dict:
    data = urllib.parse.urlencode({"data": query}).encode()
    last_err = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(req, timeout=240) as resp:
                    return json.loads(resp.read().decode("utf-8"))
            except Exception as e:  # network hiccup or rate limit: try the next mirror, then back off
                last_err = e
                print(f"  {url} failed ({e}); retrying...", file=sys.stderr)
        time.sleep(10 * (attempt + 1))
    raise RuntimeError(f"Overpass failed: {last_err}")


def bbox_str(b):
    return ",".join(str(x) for x in b)


def fetch_points(force=False):
    out = OSM_DIR / "power_points.json"
    if out.exists() and not force:
        return json.loads(out.read_text(encoding="utf-8"))
    q = f"""[out:json][timeout:200];
(
  nwr["power"="substation"]({bbox_str(GA_SC_BBOX)});
  nwr["power"="plant"]({bbox_str(GA_SC_BBOX)});
);
out center tags;"""
    res = overpass(q)
    pts = []
    for el in res.get("elements", []):
        lat = el.get("lat", el.get("center", {}).get("lat"))
        lon = el.get("lon", el.get("center", {}).get("lon"))
        if lat is None:
            continue
        pts.append({"osm": f"{el['type']}/{el['id']}", "lat": lat, "lon": lon, "tags": el.get("tags", {})})
    out.write_text(json.dumps(pts), encoding="utf-8")
    return pts


def fetch_lines(area: str, force=False):
    out = OSM_DIR / f"power_lines_{area}.json"
    if out.exists() and not force:
        return json.loads(out.read_text(encoding="utf-8"))
    q = f"""[out:json][timeout:200];
way["power"="line"]({bbox_str(BORDER_AREAS[area])});
out tags geom;"""
    res = overpass(q)
    lines = [{"osm": f"way/{el['id']}", "tags": el.get("tags", {}),
              "coords": [[g["lon"], g["lat"]] for g in el.get("geometry", [])]}
             for el in res.get("elements", []) if el.get("geometry")]
    out.write_text(json.dumps(lines), encoding="utf-8")
    return lines


def main():
    OSM_DIR.mkdir(parents=True, exist_ok=True)
    force = "--force" in sys.argv
    pts = fetch_points(force)
    named = [p for p in pts if p["tags"].get("name")]
    print(f"substations/plants: {len(pts)} ({len(named)} named)")
    for area in BORDER_AREAS:
        lines = fetch_lines(area, force)
        print(f"power lines in {area}: {len(lines)}")


if __name__ == "__main__":
    main()
