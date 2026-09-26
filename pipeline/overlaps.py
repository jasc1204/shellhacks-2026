"""Find and rank coordination opportunities between the two utilities' planned projects.

Geographic overlap (primary signal, per the GridLock spec):
  distance between the CLOSEST POINTS of the two projects (a line can pass near a substation even if
  its center is far away). Pairs within 40 km (25 mi) are flagged and tiered:
    T1 touching/crossing (<= TOUCH_KM, allows for substation footprint + coordinate precision)
    T2 < 1.6 km  share the land itself (right-of-way, access roads, permits)
    T3 < 8 km    share site logistics (laydown yards, deliveries)
    T4 < 40 km   share crews and equipment
  We also report Sperry's starter-guide method (center-to-center haversine, 25 mi cutoff) for comparison.

Timeline overlap (strong secondary signal):
  GPC gives start + need dates. DESC gives only a planned in-service date, so its build window is
  ISD minus an assumed duration by work type (documented in each record as `window_basis`).

Outputs: data/processed/overlaps.json, data/processed/overlap_summary.json
"""
import json
import math
from datetime import date, timedelta
from pathlib import Path

from shapely.geometry import LineString, Point
from shapely.ops import nearest_points

ROOT = Path(__file__).resolve().parent.parent
PROC = ROOT / "data" / "processed"

R_KM = 6371.0088
MAX_KM = 40.0            # spec: 40 km (25 mi)
CENTER_MAX_KM = 40.2336  # Sperry guide: 25 miles, center to center
TOUCH_KM = 0.25
TIERS = [
    (1, TOUCH_KM, "Touching / crossing", "Must coordinate: outage timing, crossing structures"),
    (2, 1.6, "Under 1.6 km", "Can share the land itself: right-of-way, access roads, permits"),
    (3, 8.0, "Under 8 km", "Can share site logistics: laydown yards, deliveries"),
    (4, MAX_KM, "Under 40 km", "Can share crews and equipment"),
]
# Assumed DESC build durations (months before the in-service date) when no start date is published.
DESC_DURATION_MONTHS = {"construct": 24, "rebuild": 18, "other": 12}


def haversine_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    return 2 * R_KM * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


class LocalProjection:
    """Equirectangular projection centred on a pair: accurate to well under 1% at these distances."""

    def __init__(self, lat0):
        self.k = math.cos(math.radians(lat0))

    def fwd(self, lon, lat):
        return (R_KM * math.radians(lon) * self.k, R_KM * math.radians(lat))

    def inv(self, x, y):
        return (math.degrees(x / (R_KM * self.k)), math.degrees(y / R_KM))

    def geom(self, g):
        pts = [self.fwd(*c) for c in (g["coordinates"] if g["type"] == "LineString" else [g["coordinates"]])]
        return LineString(pts) if len(pts) > 1 else Point(pts[0])


def work_type(p):
    name = (p["project_name"] + " " + p.get("description", "")).lower()
    if "construct" in name and "rebuild" not in p["project_name"].lower():
        return "construct"
    if any(w in name for w in ("rebuild", "reconductor", "upgrade", "replace")):
        return "rebuild"
    return "other"


def build_window(p):
    isd = date.fromisoformat(p["in_service_date"])
    if p.get("start_date"):
        return date.fromisoformat(p["start_date"]), isd, "published start date"
    months = DESC_DURATION_MONTHS[work_type(p)]
    return isd - timedelta(days=round(months * 30.44)), isd, f"assumed {months}-month build before in-service date ({work_type(p)})"


def tier_for(d_km):
    for tier, limit, label, share in TIERS:
        if d_km <= limit:
            return tier, label, share
    return None, None, None


def geo_score(tier, d):
    if tier == 1:
        return 1.0
    if tier == 2:
        return 0.75 + 0.15 * (1 - d / 1.6)
    if tier == 3:
        return 0.5 + 0.2 * (1 - (d - 1.6) / 6.4)
    return 0.2 + 0.25 * (1 - (d - 8.0) / 32.0)


def time_score(overlap_days, window_days, gap_days):
    if overlap_days > 0:
        return 0.5 + 0.5 * min(1.0, overlap_days / max(1, window_days))
    return max(0.0, 0.5 - gap_days / (365.25 * 4))  # within ~2 years apart still has some value


def main():
    projects = json.loads((PROC / "projects_located.json").read_text(encoding="utf-8"))
    desc = [p for p in projects if p["utility_code"] == "DESC" and p.get("geometry")]
    gpc = [p for p in projects if p["utility_code"] == "GPC" and p.get("geometry")]
    for p in desc + gpc:
        s, e, basis = build_window(p)
        p["window_start"], p["window_end"], p["window_basis"] = s.isoformat(), e.isoformat(), basis

    overlaps, center_only = [], []
    for a in desc:
        for b in gpc:
            ca, cb = a["center"], b["center"]
            center_km = haversine_km(ca[1], ca[0], cb[1], cb[0])
            if center_km > 150:  # far apart: cannot be within 40 km either
                continue
            proj = LocalProjection((ca[1] + cb[1]) / 2)
            ga, gb = proj.geom(a["geometry"]), proj.geom(b["geometry"])
            pa, pb = nearest_points(ga, gb)
            lon1, lat1 = proj.inv(pa.x, pa.y)
            lon2, lat2 = proj.inv(pb.x, pb.y)
            closest_km = haversine_km(lat1, lon1, lat2, lon2)
            crosses = ga.geom_type == "LineString" and gb.geom_type == "LineString" and ga.crosses(gb)
            tier, tier_label, share = tier_for(0.0 if crosses else closest_km)
            by_center = center_km <= CENTER_MAX_KM
            if tier is None:
                if by_center:
                    center_only.append((a["project_id"], b["project_id"], round(center_km, 2), round(closest_km, 2)))
                continue

            sa, ea = date.fromisoformat(a["window_start"]), date.fromisoformat(a["window_end"])
            sb, eb = date.fromisoformat(b["window_start"]), date.fromisoformat(b["window_end"])
            overlap_days = max(0, (min(ea, eb) - max(sa, sb)).days)
            gap_days = 0 if overlap_days else (max(sa, sb) - min(ea, eb)).days
            isd_gap_days = abs((ea - eb).days)
            shorter = min((ea - sa).days, (eb - sb).days)

            # Parallel corridor: how much of one line runs within 1.6 km of the other (right-of-way sharing).
            corridor_km = 0.0
            if ga.geom_type == "LineString" and gb.geom_type == "LineString":
                corridor_km = max(ga.intersection(gb.buffer(1.6)).length, gb.intersection(ga.buffer(1.6)).length)

            g = geo_score(tier, closest_km)
            t = time_score(overlap_days, shorter, gap_days)
            confs = {a["location_confidence"], b["location_confidence"]}
            verify = "low" in confs or "none" in confs
            score = 100 * (0.65 * g + 0.35 * t) * (0.85 if verify else 1.0)

            if overlap_days:
                when = f"build windows overlap by {overlap_days / 30.44:.0f} months"
            else:
                when = f"build windows {gap_days / 365.25:.1f} years apart"
            dist_txt = "touching" if tier == 1 else f"{closest_km:.1f} km apart at the closest point"
            overlaps.append({
                "id": f"{a['project_id']}__{b['project_id']}",
                "a": a["project_id"], "b": b["project_id"],
                "a_name": a["project_name"], "b_name": b["project_name"],
                "closest_km": round(closest_km, 3),
                "closest_points": [[round(lon1, 6), round(lat1, 6)], [round(lon2, 6), round(lat2, 6)]],
                "lines_cross": crosses,
                "center_km": round(center_km, 3), "center_mi": round(center_km / 1.609344, 2),
                "flagged_by_center_method": by_center,
                "tier": tier, "tier_label": tier_label, "can_share": share,
                "a_window": [a["window_start"], a["window_end"]], "b_window": [b["window_start"], b["window_end"]],
                "overlap_days": overlap_days, "window_gap_days": gap_days, "isd_gap_days": isd_gap_days,
                "shared_corridor_km": round(corridor_km, 2),
                "geo_score": round(g, 3), "time_score": round(t, 3), "score": round(score, 1),
                "needs_location_check": verify,
                "why": f"{dist_txt}; {when}. {share}.",
            })

    overlaps.sort(key=lambda o: -o["score"])
    for i, o in enumerate(overlaps, 1):
        o["rank"] = i

    by_tier = {t: sum(1 for o in overlaps if o["tier"] == t) for t, *_ in TIERS}
    missed_by_center = [o["id"] for o in overlaps if not o["flagged_by_center_method"]]
    summary = {
        "desc_projects": len([p for p in projects if p["utility_code"] == "DESC"]),
        "gpc_projects": len([p for p in projects if p["utility_code"] == "GPC"]),
        "desc_mapped": len(desc), "gpc_mapped": len(gpc),
        "pairs_flagged": len(overlaps), "by_tier": by_tier,
        "center_method_flags": sum(1 for o in overlaps if o["flagged_by_center_method"]) + len(center_only),
        "caught_only_by_closest_points": missed_by_center,
        "flagged_only_by_center_method": center_only,
    }
    (PROC / "overlaps.json").write_text(json.dumps(overlaps, indent=1), encoding="utf-8")
    (PROC / "overlap_summary.json").write_text(json.dumps(summary, indent=1), encoding="utf-8")
    (PROC / "projects_final.json").write_text(json.dumps(projects, indent=1), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("caught_only_by_closest_points", "flagged_only_by_center_method")}, indent=1))
    print("caught only by closest points:", len(missed_by_center), " flagged only by center method:", len(center_only))
    print("\nTop 15:")
    for o in overlaps[:15]:
        print(f"#{o['rank']:2} {o['score']:5.1f}  T{o['tier']} {o['closest_km']:6.2f} km (center {o['center_mi']:5.1f} mi)  "
              f"{o['a']} {o['a_name'][:34]:34} <-> {o['b']} {o['b_name'][:40]:40} | {o['why'][:70]}")
    return overlaps


if __name__ == "__main__":
    main()
