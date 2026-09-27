"""Write the compact data files the web app loads (web/public/data/).

  projects.geojson   one feature per mapped project (LineString between its sub-points, or a Point)
  endpoints.geojson  one point per located sub-point, with how it was located and how confident we are
  overlaps.json      ranked coordination opportunities (from overlaps.py)
  backdrop.geojson   existing OSM transmission lines in the two border areas (map context only)
  meta.json          summary numbers, unmapped projects and data sources
  gridlock.kml       every mapped project and the ranked overlaps, for Google Earth (or any GIS)
"""
import csv
import json
import math
from datetime import datetime
from pathlib import Path
from xml.sax.saxutils import escape

from overlaps import timing_phrase

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


# ---------------------------------------------------------------- Google Earth (KML)
KML_COLOR = {"DESC": "ffffd84d", "GPC": "ffff7d3b", "gold": "ff66d1ff"}  # the app's colors, as KML aabbggrr
UTILITY = {"DESC": "Dominion Energy SC (DESC)", "GPC": "Georgia Power (GPC)"}
ICON = "https://maps.google.com/mapfiles/kml/shapes/{}.png"
MOBILIZATION_PCT, EASEMENT_PER_ACRE = 3, 15000  # the app's default savings assumptions (costModel in web/src/main.ts)


def money(n):
    if n >= 1e6:
        return f"${n / 1e6:.{1 if n >= 1e7 else 2}f}M"
    return f"${n / 1e3:.0f}K" if n >= 1e3 else f"${n:.0f}"


def month(iso):
    return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%b %Y") if iso else "unknown"


def pair_name(p):
    return f"{p['name_a']} – {p['name_b']}" if p.get("name_b") else p["name_a"]


def savings(o, a, b):
    """Rough savings if coordinated: the same transparent model as the app's cost card (a = the DESC side)."""
    kv = max([*(a.get("voltage_kv") or []), *(b.get("voltage_kv") or []), 0])
    row = 45 if kv >= 230 else 30
    total, items = 0.0, []
    aligned = o["overlap_days"] > 0 or o["window_gap_days"] < 180
    cost = a.get("estimated_cost_usd")
    if cost and aligned:
        mob = cost * MOBILIZATION_PCT / 100
        total += mob
        items.append(f"{money(mob)}: one crew and equipment mobilization avoided "
                     f"({MOBILIZATION_PCT}% of DESC's published {money(cost)})")
    elif not aligned:
        items.append("The build windows don't line up as planned, so crews can't be shared yet. "
                     "Shifting one schedule is the opportunity.")
    if o["tier"] <= 2:
        km = max(o["shared_corridor_km"], 0.5 if o["tier"] == 1 else 0)
        acres = km * 1000 * row / 4046.86
        total += acres * EASEMENT_PER_ACRE
        items.append(f"{money(acres * EASEMENT_PER_ACRE)}: right-of-way, {km:.1f} km of shared corridor × {row} m wide "
                     f"= {acres:.0f} acres at {money(EASEMENT_PER_ACRE)}/acre")
    if o["tier"] == 1:
        items.append("Touching projects must also coordinate outages and crossing structures: one planned outage instead of two.")
    return total, items


def kml_text(s):
    """Data text for an HTML balloon inside CDATA."""
    return escape(str(s)).replace("]]>", "]]&gt;")


def kml_coords(coords):
    return " ".join(f"{lon:.6f},{lat:.6f},0" for lon, lat in coords)


def kml_lookat(lon, lat, rng, heading=0.0, tilt=50):
    return (f"<LookAt><longitude>{lon:.6f}</longitude><latitude>{lat:.6f}</latitude><altitude>0</altitude>"
            f"<heading>{heading:.1f}</heading><tilt>{tilt}</tilt><range>{rng:.0f}</range>"
            "<altitudeMode>relativeToGround</altitudeMode></LookAt>")


def kml_data(fields):
    rows = "".join(f'<Data name="{k}"><value>{escape(str(v).lower() if isinstance(v, bool) else str(v))}</value></Data>'
                   for k, v in fields.items() if v not in (None, ""))
    return f"<ExtendedData>{rows}</ExtendedData>"


def kml_placemark(name, snippet, html, lookat, style, data, geometry):
    return (f"<Placemark><name>{escape(name)}</name><Snippet maxLines=\"2\">{escape(snippet)}</Snippet>"
            f"<description><![CDATA[{html}]]></description>{lookat}<styleUrl>#{style}</styleUrl>"
            f"{kml_data(data)}{geometry}</Placemark>")


def kml_styles():
    balloon = f"<BalloonStyle><text>{escape('<b>$[name]</b><br/>$[description]')}</text></BalloonStyle>"

    def style(sid, color, icon, icon_scale, label_scale, width, label_color="ffffffff"):
        return (f'<Style id="{sid}"><IconStyle><color>{color}</color><scale>{icon_scale}</scale>'
                f"<Icon><href>{ICON.format(icon)}</href></Icon></IconStyle>"
                f"<LabelStyle><color>{label_color}</color><scale>{label_scale}</scale></LabelStyle>"
                f"<LineStyle><color>{color}</color><width>{width}</width></LineStyle>{balloon}</Style>")

    def style_map(sid):
        return (f'<StyleMap id="{sid}"><Pair><key>normal</key><styleUrl>#{sid}_n</styleUrl></Pair>'
                f"<Pair><key>highlight</key><styleUrl>#{sid}_h</styleUrl></Pair></StyleMap>")

    gold = KML_COLOR["gold"]
    return "".join([
        style("desc", KML_COLOR["DESC"], "placemark_circle", 0.9, 0, 3),
        style("gpc", KML_COLOR["GPC"], "placemark_circle", 0.9, 0, 3),
        # the top 10 are labeled on the globe; the rest show their label on hover
        style("top_n", gold, "star", 1.3, 1.0, 6, gold), style("top_h", gold, "star", 1.5, 1.1, 7, gold), style_map("top"),
        style("ovl_n", gold, "star", 0.9, 0, 3.5, gold), style("ovl_h", gold, "star", 1.1, 1.0, 4.5, gold), style_map("ovl"),
    ])


def kml_overlap(o, a, b, n):
    (lon1, lat1), (lon2, lat2) = o["closest_points"]
    lon, lat = (lon1 + lon2) / 2, (lat1 + lat2) / 2
    k = math.cos(math.radians(lat))
    gap = o["closest_km"] > 0
    # look across the gap (it runs left to right on screen), like the app's tour
    heading = (math.degrees(math.atan2((lon2 - lon1) * k, lat2 - lat1)) - 90) % 360 if gap else 0
    timing = timing_phrase(o["overlap_days"], o["window_gap_days"])
    total, items = savings(o, a, b)
    side = lambda p, w: (f"<b>{p['project_id']}</b> {kml_text(p['project_name'])}<br/>"
                         f"{UTILITY[p['utility_code']]}, build window {month(w[0])} – {month(w[1])}, "
                         f"in service {month(p['in_service_date'])}"
                         + (f", {money(p['estimated_cost_usd'])}" if p.get("estimated_cost_usd") else "")
                         + f"<br/><i>{kml_text(p['source_doc'])}, PDF page {p['source_page']}</i>")
    html = (f"<b>#{o['rank']} of {n}</b>, Tier {o['tier']} ({kml_text(o['tier_label'].lower())})<br/>{kml_text(o['can_share'])}<br/><br/>"
            + (f"<b>Closest points:</b> {o['closest_km']:.2f} km apart" if gap else "<b>Closest points:</b> the two projects touch")
            + (" (the lines cross)" if o["lines_cross"] else "")
            + f"<br/><b>Center to center:</b> {o['center_km']:.1f} km ({o['center_mi']:.1f} mi), the starter guide's measure<br/>"
            f"<b>Timing:</b> {timing}; in-service dates {o['isd_gap_days']} days apart<br/>"
            f"<b>Rough savings if coordinated:</b> {money(total) if total > 0 else 'depends on the schedule'}"
            f"<ul>{''.join(f'<li>{kml_text(i)}</li>' for i in items)}</ul>"
            f"<b>Score:</b> {o['score']:.1f} / 100 (65% distance, 35% timing)<br/><br/>"
            f"{side(a, o['a_window'])}<br/><br/>{side(b, o['b_window'])}"
            + ("<br/><br/><i>At least one end is located approximately: check it before relying on this match.</i>"
               if o["needs_location_check"] else ""))
    name = f"#{o['rank']} " + (f"({o['closest_km']:.2f} km)" if gap else "(touching)")
    snippet = f"{pair_name(a)} × {pair_name(b)}, {timing}"
    point = f"<Point><coordinates>{kml_coords([(lon, lat)])}</coordinates></Point>"
    geometry = (f"<MultiGeometry>{point}<LineString><tessellate>1</tessellate>"
                f"<coordinates>{kml_coords(o['closest_points'])}</coordinates></LineString></MultiGeometry>") if gap else point
    data = {"rank": o["rank"], "tier": o["tier"], "closest_km": o["closest_km"], "center_mi": o["center_mi"],
            "desc_project": o["a"], "gpc_project": o["b"], "desc_window": " to ".join(o["a_window"]),
            "gpc_window": " to ".join(o["b_window"]), "build_overlap_days": o["overlap_days"],
            "window_gap_days": o["window_gap_days"], "isd_gap_days": o["isd_gap_days"], "score": o["score"],
            "est_savings_usd": round(total), "needs_location_check": o["needs_location_check"]}
    rng = max(1500, o["closest_km"] * 1000 * 2.5)
    return kml_placemark(name, snippet, html, kml_lookat(lon, lat, rng, heading), "top" if o["rank"] <= 10 else "ovl", data, geometry)


def kml_project(p, n_overlaps, best_tier):
    g = p["geometry"]
    code = p["utility_code"]
    locs = []
    for key in ("a", "b"):
        lp = loc_props(p.get(f"loc_{key}"), p.get(f"name_{key}"))
        if lp:
            locs.append(f"{kml_text(lp['name'])}: {kml_text(lp['matched'] or lp['method'])} ({kml_text(lp['confidence'])} confidence)")
    html = (f"<b>{p['project_id']}</b>, {UTILITY[code]}<br/>{kml_text(p['project_name'])}<br/><br/>"
            f"<b>In service:</b> {month(p['in_service_date'])}<br/>"
            + (f"<b>Status:</b> {kml_text(p['status'])}<br/>" if p.get("status") else "")
            + f"<b>Build window:</b> {month(p.get('window_start'))} – {month(p.get('window_end'))}<br/>"
            + (f"<b>Start date from:</b> {kml_text(p['window_basis'])}<br/>" if p.get("window_basis") else "")
            + (f"<b>Published cost:</b> {money(p['estimated_cost_usd'])}<br/>" if p.get("estimated_cost_usd") else "")
            + (f"<b>Voltage:</b> {', '.join(str(v) for v in p['voltage_kv'])} kV<br/>" if p.get("voltage_kv") else "")
            + f"<b>Located:</b> {'; '.join(locs)}<br/>"
            + (f"<b>Overlaps:</b> {n_overlaps} (closest: Tier {best_tier})<br/>" if n_overlaps else "<b>Overlaps:</b> none within 40 km<br/>")
            + ("<i>Drawn as a straight line between its two end substations: the filing names only the ends.</i><br/>"
               if g["type"] == "LineString" else "")
            + f"<i>{kml_text(p['source_doc'])}, PDF page {p['source_page']}</i>")
    if g["type"] == "LineString":
        (lon1, lat1), (lon2, lat2) = g["coordinates"][0], g["coordinates"][-1]
        km = math.hypot((lon2 - lon1) * 111.195 * math.cos(math.radians(lat1)), (lat2 - lat1) * 111.195)
        geometry = f"<LineString><tessellate>1</tessellate><coordinates>{kml_coords(g['coordinates'])}</coordinates></LineString>"
        lon, lat, rng = (lon1 + lon2) / 2, (lat1 + lat2) / 2, max(3000, km * 1000 * 1.6)
    else:
        (lon, lat), rng = g["coordinates"], 3000
        geometry = f"<Point><coordinates>{kml_coords([g['coordinates']])}</coordinates></Point>"
    data = {"project_id": p["project_id"], "utility": p["utility"], "in_service_date": p["in_service_date"],
            "window_start": p.get("window_start"), "window_end": p.get("window_end"),
            "cost_usd": p.get("estimated_cost_usd"), "kv": ";".join(str(v) for v in p.get("voltage_kv") or []),
            "location_confidence": p["location_confidence"], "overlaps": n_overlaps, "best_tier": best_tier,
            "source_page": p["source_page"]}
    snippet = f"{pair_name(p)}, in service {month(p['in_service_date'])}"
    return kml_placemark(f"{p['project_id']} {p['project_name']}", snippet, html, kml_lookat(lon, lat, rng),
                         code.lower(), data, geometry)


def write_kml(projects, overlaps, count, best, n_total):
    by_code = {p["project_id"]: p for p in projects}
    mapped = [p for p in projects if p.get("geometry")]
    tiers = {o["tier"]: o["tier_label"] for o in overlaps}
    about = (f"Where Dominion Energy South Carolina's and Georgia Power's planned transmission projects come close in "
             f"place and time: {len(overlaps)} overlaps, ranked by the gap between the closest points of the two projects "
             f"and by how much their build windows overlap. Tiers: "
             + "; ".join(f"{t} {tiers[t].lower()}" for t in sorted(tiers))
             + f". {len(mapped)} of {n_total} projects are mapped. Double-click an overlap to fly to it.<br/><br/>"
             "Sources: DESC Planned Transmission Projects $2M and above (2024-2028); Georgia Power 2025 IRP Vol. 3, "
             "2024 GA ITS Ten-Year Plan (public disclosure version); substation locations from OpenStreetMap contributors "
             "(ODbL). Made for ShellHacks 2026, Sperry Tech GridLock challenge: "
             "https://github.com/jasc1204/shellhacks-2026")
    folder = lambda name, items, is_open=0: (f"<Folder><name>{escape(name)}</name><open>{is_open}</open>"
                                              f"{''.join(items)}</Folder>")
    ranked = [kml_overlap(o, by_code[o["a"]], by_code[o["b"]], len(overlaps)) for o in sorted(overlaps, key=lambda o: o["rank"])]
    side = lambda code: [kml_project(p, count.get(p["project_id"], 0), best.get(p["project_id"]))
                         for p in mapped if p["utility_code"] == code]
    desc, gpc = side("DESC"), side("GPC")
    kml = ('<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
           f"<name>GridLock: DESC and Georgia Power planned projects</name><open>1</open>"
           f"<description><![CDATA[{about}]]></description>"
           f"{kml_lookat(-81.55, 32.85, 330000, 0, 0)}{kml_styles()}"
           + folder(f"Overlaps, ranked ({len(ranked)})", ranked, 1)
           + folder(f"DESC planned projects ({len(desc)})", desc)
           + folder(f"Georgia Power planned projects ({len(gpc)})", gpc)
           + "</Document></kml>\n")
    (OUT / "gridlock.kml").write_text(kml, encoding="utf-8")


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
    write_kml(projects, overlaps, count, best, len(projects))

    sizes = {p.name: f"{p.stat().st_size / 1024:.0f} KB" for p in OUT.iterdir()}
    print(f"mapped {len(feats)} projects, {len(ends)} endpoints, {len(overlaps)} overlaps, {len(backdrop)} backdrop lines; unmapped {len(unmapped)}")
    print(sizes)


if __name__ == "__main__":
    main()
