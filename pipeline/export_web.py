"""Write the compact data files the web app loads (web/public/data/).

  projects.geojson   one feature per mapped project (LineString between its sub-points, or a Point)
  endpoints.geojson  one point per located sub-point, with how it was located and how confident we are
  overlaps.json      ranked coordination opportunities (from overlaps.py)
  backdrop.geojson   existing OSM transmission lines in the two border areas (map context only)
  meta.json          summary numbers, unmapped projects and data sources
"""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"
OSM = ROOT / "data" / "osm"
OUT = ROOT / "web" / "public" / "data"


def r6(c):
    return [round(c[0], 5), round(c[1], 5)]


def loc_props(loc, name):
    if not loc:
        return None
    matched = loc.get("osm_name", "")
    if loc.get("method", "").startswith("approximate: Nominatim"):
        matched = ", ".join(matched.split(", ")[:2]) + " (approx.)"  # "Fenwick Street, Hillside Park (approx.)"
    return {"name": name, "matched": matched, "method": loc.get("method", ""),
            "confidence": loc.get("confidence", ""), "note": loc.get("note", "")}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    projects = json.loads((PROC / "projects_final.json").read_text(encoding="utf-8"))
    overlaps = json.loads((PROC / "overlaps.json").read_text(encoding="utf-8"))
    summary = json.loads((PROC / "overlap_summary.json").read_text(encoding="utf-8"))

    best = {}
    count = {}
    for o in overlaps:
        for pid in (o["a"], o["b"]):
            count[pid] = count.get(pid, 0) + 1
            best[pid] = min(best.get(pid, 9), o["tier"])

    feats, ends, unmapped = [], [], []
    for p in projects:
        props = {
            "id": p["project_id"], "utility": p["utility_code"], "name": p["project_name"],
            "a": p["name_a"], "b": p["name_b"], "kv": p["voltage_kv"], "status": p.get("status", ""),
            "start": p.get("window_start"), "isd": p["in_service_date"], "window_basis": p.get("window_basis", ""),
            "cost": p.get("estimated_cost_usd"), "desc": p.get("description", ""), "source_id": p["source_id"],
            "doc": p["source_doc"], "page": p["source_page"], "conf": p["location_confidence"],
            "loc_a": loc_props(p.get("loc_a"), p["name_a"]), "loc_b": loc_props(p.get("loc_b"), p["name_b"]),
            "fix": p.get("point_fix_note", ""), "n_overlaps": count.get(p["project_id"], 0),
            "budget": p.get("budget"), "budget_check": p.get("budget_check", ""),
            "best_tier": best.get(p["project_id"]), "length_km": p.get("straight_length_km"),
        }
        if not p.get("geometry"):
            unmapped.append({k: props[k] for k in ("id", "utility", "name", "a", "b", "isd", "page")})
            continue
        g = p["geometry"]
        coords = [r6(c) for c in g["coordinates"]] if g["type"] == "LineString" else r6(g["coordinates"])
        feats.append({"type": "Feature", "geometry": {"type": g["type"], "coordinates": coords}, "properties": props})
        for k in ("a", "b"):
            loc = p.get(f"loc_{k}")
            if loc:
                ends.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": r6([loc["lon"], loc["lat"]])},
                             "properties": {"project": p["project_id"], "utility": p["utility_code"], "name": p[f"name_{k}"],
                                            "confidence": loc["confidence"], "method": loc["method"]}})

    backdrop = []
    for area in ("savannah", "augusta"):
        f = OSM / f"power_lines_{area}.json"
        if f.exists():
            for ln in json.loads(f.read_text(encoding="utf-8")):
                v = ln["tags"].get("voltage", "")
                try:
                    kv = max(int(x) for x in v.split(";") if x.strip().isdigit()) // 1000
                except ValueError:
                    kv = 0
                if kv and kv < 46:
                    continue  # skip distribution-level lines
                backdrop.append({"type": "Feature", "geometry": {"type": "LineString", "coordinates": [r6(c) for c in ln["coords"]]},
                                 "properties": {"kv": kv, "name": ln["tags"].get("name", ""), "operator": ln["tags"].get("operator", "")}})

    meta = {
        **summary,
        "unmapped": unmapped,
        "sources": [
            {"label": "DESC Planned Transmission Projects $2M and above (2024-2028)", "via": "Sperry Tech GridLock starter package"},
            {"label": "Georgia Power 2025 IRP Vol. 3, public disclosure: 2024 GA ITS Ten-Year Plan (2025-2034)", "via": "Sperry Tech GridLock starter package"},
            {"label": "Substations, plants and power lines: OpenStreetMap contributors (ODbL), via Overpass and Nominatim", "via": "openstreetmap.org"},
        ],
    }
    dump = lambda name, obj: (OUT / name).write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    dump("projects.geojson", {"type": "FeatureCollection", "features": feats})
    dump("endpoints.geojson", {"type": "FeatureCollection", "features": ends})
    dump("overlaps.json", overlaps)
    dump("backdrop.geojson", {"type": "FeatureCollection", "features": backdrop})
    dump("meta.json", meta)
    # Same table in the column layout of Sperry's Projects_Overlaps.xlsx, with our coordinates filled in
    # (the 3D viewer, world3d/prep_scene.py --projects, reads this format).
    cols = ["project_id", "utility", "state", "project_name", "name_a", "lat_a", "lon_a", "name_b", "lat_b", "lon_b",
            "lat_center", "lon_center", "start_date", "in_service_date", "location_confidence", "source_page"]
    with open(PROC / "projects_located.csv", "w", newline="", encoding="utf-8") as fh:
        w = csv.DictWriter(fh, fieldnames=cols)
        w.writeheader()
        for p in projects:
            if not p.get("geometry"):
                continue
            row = {k: p.get(k, "") for k in ("project_id", "utility", "state", "project_name", "name_a", "name_b",
                                              "in_service_date", "location_confidence", "source_page")}
            row["start_date"] = p.get("window_start") if p.get("start_date") else ""
            for k in ("a", "b"):
                loc = p.get(f"loc_{k}")
                row[f"lat_{k}"], row[f"lon_{k}"] = (round(loc["lat"], 6), round(loc["lon"], 6)) if loc else ("", "")
            row["lon_center"], row["lat_center"] = (round(p["center"][0], 6), round(p["center"][1], 6))
            w.writerow(row)

    # Downloads for the judges, in the column layout of Sperry's Projects_Overlaps.xlsx ("overlaps" sheet first,
    # then our additions). distance_mi and time_gap (day) keep Sperry's definitions (center to center, in-service gap).
    by_code = {p["project_id"]: p for p in projects}
    ocols = ["overlap_id", "distance_mi", "time_gap (day)", "utility_a", "project_id_a", "project_name_a", "utility_b",
             "project_id_b", "project_name_b", "rank", "closest_km", "tier", "tier_label", "can_share",
             "build_overlap_days", "window_gap_days", "score", "needs_location_check", "source_page_a", "source_page_b"]
    # utf-8-sig: a byte-order mark so Excel reads the en dashes in project names correctly.
    with open(OUT / "overlaps_sperry_format.csv", "w", newline="", encoding="utf-8-sig") as fh:
        w = csv.DictWriter(fh, fieldnames=ocols)
        w.writeheader()
        for o in overlaps:
            a, b = by_code[o["a"]], by_code[o["b"]]
            w.writerow({
                "overlap_id": f"OVL_{o['rank']}", "distance_mi": o["center_mi"], "time_gap (day)": o["isd_gap_days"],
                "utility_a": a["utility"], "project_id_a": o["a"], "project_name_a": o["a_name"],
                "utility_b": b["utility"], "project_id_b": o["b"], "project_name_b": o["b_name"],
                "rank": o["rank"], "closest_km": o["closest_km"], "tier": o["tier"], "tier_label": o["tier_label"],
                "can_share": o["can_share"], "build_overlap_days": o["overlap_days"], "window_gap_days": o["window_gap_days"],
                "score": o["score"], "needs_location_check": o["needs_location_check"],
                "source_page_a": a["source_page"], "source_page_b": b["source_page"],
            })
    # The pipeline copy stays BOM-free (world3d/prep_scene.py reads it); the download gets one for Excel.
    (OUT / "projects_located.csv").write_bytes(b"\xef\xbb\xbf" + (PROC / "projects_located.csv").read_bytes())

    sizes = {p.name: f"{p.stat().st_size / 1024:.0f} KB" for p in OUT.iterdir()}
    print(f"mapped {len(feats)} projects, {len(ends)} endpoints, {len(overlaps)} overlaps, {len(backdrop)} backdrop lines; unmapped {len(unmapped)}")
    print(sizes)


if __name__ == "__main__":
    main()
