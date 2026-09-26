"""Extract planned transmission projects from the two utility PDFs into structured tables.

Sources (provided by Sperry Tech in the GridLock starter package):
  - Dominion Energy South Carolina (DESC): "Planned Transmission Projects $2M and above", 44 projects, one per page.
  - Georgia Power (GPC): 2025 IRP Volume 3 (public disclosure), which embeds the
    "2024 GA ITS Ten-Year Plan (2025-2034)". Project detail pages carry a TEAMS number,
    a need (in-service) date and a start date.

Outputs (data/processed/):
  - desc_projects.json, gpc_projects.json: one record per project, with source page references.
  - projects_extracted.csv: both utilities in the column layout of Sperry's Projects_Overlaps.xlsx
    (coordinates left blank; they are filled in by the geocoding step).
"""
import csv
import json
import re
import subprocess
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "sperry" / "Project Listings"
TEXT = ROOT / "data" / "sperry" / "text"
OUT = ROOT / "data" / "processed"

DESC_PDF = RAW / "Dominion Energy" / "2024-2028-2million-and-above-project-descriptions.pdf"
GPC_PDF = RAW / "Georgia Power" / "2025 IRP Volume 3 PUBLIC DISCLOSURE.pdf"
GPC_PLAN_FIRST_PDF_PAGE = 171  # "Page 1 of 304" of the Ten-Year Plan is PDF page 171

BANNER_MARKERS = (
    "PUBLIC DISCLOSURE",
    "CRITICAL ENERGY INFRASTRUCTURE",
    "be aware that disclosure",
    "contents shall be handled",
    "notification. This document",
    "policy, should not be",
)

WORK_WORDS = (
    "REBUILD", "REBUILDS", "REBLD", "RECONDUCTOR", "UPGRADE", "UPGRADES", "CONSTRUCT", "CONSTRUCTION", "REACTORS",
    "REACTOR", "REPLACEMENT", "REPLACE", "INSTALLATION", "INSTALL", "IMPROVEMENTS", "EXPANSION", "TAP",
    "FOLD-IN", "LINE", "SUB", "SUBSTATION", "PROJECT", "NEW", "RETIREMENT", "RELOCATION", "MODERNIZATION",
    "TIE", "TRANSMISSION", "LOOP", "AND", "&", "SERIES", "STRATEGIC", "SPDC",
)


def pdf_to_text(pdf: Path, txt: Path) -> str:
    if not txt.exists():
        txt.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["pdftotext", "-enc", "UTF-8", "-layout", str(pdf), str(txt)], check=True)
    return txt.read_text(encoding="utf-8", errors="replace")


def parse_date(s: str):
    """Parse M/D/YY or M/D/YYYY into an ISO date string."""
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s)
    if not m:
        return None
    mo, d, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if y < 100:
        y += 2000
    return date(y, mo, d).isoformat()


def voltages(name: str):
    """All kV levels mentioned in a project name, e.g. '230-115kV' -> [230, 115]."""
    kv = []
    for m in re.finditer(r"(\d{2,3}(?:\s*[-/]\s*\d{2,3}(?:\.\d)?)*)\s*-?\s*[kK][vV]", name.replace("23O", "230")):
        for part in re.split(r"\s*[-/]\s*", m.group(1)):
            try:
                v = float(part)
            except ValueError:
                continue
            if v >= 34 and v not in kv:
                kv.append(int(v) if v.is_integer() else v)
    return kv


# Equipment/scope words: a sub-point name ends where these begin ("MELDRIM BANK D" -> "MELDRIM").
EQUIPMENT_CUT = re.compile(
    r"\s+(?:AKA\b.*|BUS(?:ES)?\b|RELAY|PROTECTIVE|PANEL|AUTO\s*BANK|AUTOBANK|AUTO\s+TRANSFORMER|TRANSFORMERS?\b|XFMR|"
    r"BANK\b|CAP\b|CAPACITOR|BREAKER|LINE\s+SWITCH|SWITCHING\s+STATION|STATION\s+MODIFICATION|JUMPERS?\b|STATCOM|"
    r"REACTOR|REMOVAL|EQUIPMENT|LIMITING|CUSTOMER|SECOND\b|2ND\b|NEW\s+AUTO|PARTIAL|AREA\b|SOLUTION|STRATEGIC|"
    r"CONVERSION|DUAL\s+STAGE|LOW\s+SIDE|SERIES\b|TRANSMISSION\s+NEEDS|NETWORK|NEW\s+BUILD|UPGRADE).*$",
    re.I,
)
ABBREVIATIONS = [(r"\bPRI\b", "PRIMARY"), (r"^N\s+", "NORTH "), (r"\bV\.\s*RICA\b", "VILLA RICA")]


def clean_point(token: str) -> str:
    """Strip voltages, circuit numbers, equipment and work words from one end of a project name."""
    t = token.replace("23O", "230")
    m = re.search(r"\bAT\s+(.+)$", t)  # "SMART VALVES AT EAST VILLA RICA SWITCHING STATION"
    if m:
        t = m.group(1)
    t = EQUIPMENT_CUT.sub("", t)
    for pat, rep in ABBREVIATIONS:
        t = re.sub(pat, rep, t, flags=re.I)
    t = re.sub(r"\([^)]*\)?", " ", t) if not re.search(r"\((SAV|USA)\)", t) else t
    t = t.split("/")[0] if "/" in t and not re.search(r"\d/\d", t) else t
    t = re.sub(r"\d{2,3}(?:\s*[-/]\s*\d{2,3}(?:\.\d)?)*\s*-?\s*[kK][vV]", " ", t)
    t = re.sub(r"#\s*\d+", " ", t) if not re.search(r"DAM|UNIT", t, re.I) else t
    words = [w for w in re.split(r"\s+", t) if w]
    while words and words[-1].upper().strip(",.:;()") in WORK_WORDS:
        words.pop()
    t = " ".join(words).strip(" ,.:;-–")
    return t


def split_endpoints(name: str):
    """Best-effort split of a project name into its named sub-points (A - B)."""
    base = re.sub(r"^(SAV|GTC|MEAG|DU|APC|GPC)\s*:\s*", "", name.strip(), flags=re.I)
    base = base.split(":")[0]  # DESC style "A - B 115 kV: Rebuild"
    base = base.split(",")[0]  # "Okatie 230-115kV Substation, Jasper - Yemassee ..." -> first clause
    # "A - B", "A – B", and DESC's unspaced "Okatie-Bluffton" (hyphen followed by a capital letter).
    parts = re.split(r"\s+[-–—]\s+|\s*–\s*|(?<=[A-Za-z0-9])-(?=[A-Z])", base)
    points = [clean_point(p) for p in parts if clean_point(p)]
    if len(points) == 1 and re.search(r"\s+AND\s+", points[0], re.I):
        points = [clean_point(p) for p in re.split(r"\s+AND\s+", points[0], flags=re.I) if clean_point(p)]
    return points[:2]


def between(lines, start, stops):
    """Join the lines after the header `start` up to the first header in `stops`."""
    out, on = [], False
    for ln in lines:
        s = ln.strip()
        if not on:
            if s.startswith(start):
                on = True
                rest = s[len(start):].strip()
                if rest:
                    out.append(rest)
            continue
        if any(s.startswith(x) for x in stops):
            break
        if s:
            out.append(s)
    return " ".join(out).strip()


# ----------------------------------------------------------------------------------------------
# Dominion Energy South Carolina
# ----------------------------------------------------------------------------------------------
BUDGET_COLS = ["Previous", "2024", "2025", "2026", "2027", "2028", "Total*"]


def parse_budget(page: str):
    """DESC's 5-year budget table (Previous, 2024..2028, Total). pdftotext scatters it over 2-3 lines, so try
    assignments until the years add up to the stated total. Returns (budget dict, how, check note)."""
    lines = page.splitlines()
    i0 = next(i for i, ln in enumerate(lines) if "Estimated Project Cost" in ln)
    i1 = next(i for i, ln in enumerate(lines) if "Total Estimated Amount" in ln)
    heads, vals = [], []
    for ln in lines[i0:i1]:
        heads += [(m.start(), m.group(0)) for m in re.finditer(r"Previous|20\d\d|Total\*", ln)]
        vals += [(m.start(), int(m.group(0)[1:].replace(",", ""))) for m in re.finditer(r"\$[\d,]+", ln)]
    sums_ok = lambda d: len(d) == 7 and abs(sum(d[c] for c in BUDGET_COLS[:-1]) - d["Total*"]) <= 2
    tries = []
    if len(vals) == 7:
        tries.append((dict(zip(BUDGET_COLS, [v for _, v in sorted(vals)])), "columns left to right"))
    nearest = {}
    for pos, v in vals:
        nearest.setdefault(min(heads, key=lambda h: abs(h[0] - pos))[1], v)
    tries.append((nearest, "nearest column header"))
    if len(vals) == 7:
        total = max(v for _, v in vals)
        rest = sorted(vals, key=lambda x: (x[1] == total, x[0]))[:6]
        d = dict(zip(BUDGET_COLS[:-1], [v for _, v in sorted(rest)]))
        d["Total*"] = total
        tries.append((d, "largest value is the total"))
    for d, how in tries:
        if sums_ok(d):
            return {k.rstrip("*"): v for k, v in d.items()}, how, "years sum to the total"
    d = {k.rstrip("*"): v for k, v in nearest.items()}
    parts = sum(v for k, v in d.items() if k != "Total")
    return d, "nearest column header", f"source inconsistency: years sum to ${parts:,} but the total says ${d.get('Total', 0):,}"


def budget_start(budget, isd):
    """First year DESC budgets money for the project ('Previous' = spending before 2024)."""
    if not budget:
        return None, ""
    if budget.get("Previous", 0) > 0:
        return "2023-01-01", "spending before 2024 (DESC budget 'Previous' column)"
    years = [int(y) for y in ("2024", "2025", "2026", "2027", "2028") if budget.get(y, 0) > 0]
    if not years:
        return None, ""
    first = min(years[0], int(isd[:4]))
    return f"{first}-01-01", f"DESC budget: spending starts in {first}"


def extract_desc():
    text = pdf_to_text(DESC_PDF, TEXT / "desc_projects.txt")
    pages = [p for p in text.split("\f") if p.strip()]
    projects = []
    for page_no, page in enumerate(pages, 1):
        lines = [ln.rstrip() for ln in page.splitlines()]
        stripped = [ln.strip() for ln in lines]
        # Title: the lines between "5 Year Budget" and "Project ID".
        i0 = stripped.index("5 Year Budget") + 1
        i1 = stripped.index("Project ID")
        title = " ".join(s for s in stripped[i0:i1] if s)
        pid = next(s for s in stripped[i1 + 1:] if s)
        description = between(lines, "Project Description", ("Project Need",))
        need = between(lines, "Project Need", ("Project Status",))
        status = between(lines, "Project Status", ("Planned In-Service Date",))
        isd_raw = between(lines, "Planned In-Service Date", ("Estimated Project Cost",))
        dates = [parse_date(m.group(0)) for m in re.finditer(r"\d{1,2}/\d{1,2}/\d{2,4}", isd_raw)]
        amounts = [int(a.replace(",", "")) for a in re.findall(r"\$([\d,]+)", page)]
        budget, budget_how, budget_check = parse_budget(page)
        isd = dates[-1] if dates else None
        b_start, b_basis = budget_start(budget, isd) if isd else (None, "")
        points = split_endpoints(title)
        projects.append({
            "project_id": f"DESC_{page_no}",
            "source_id": pid,
            "utility": "Dominion Energy South Carolina",
            "utility_code": "DESC",
            "state": "SC",
            "project_name": title,
            "name_a": points[0] if points else "",
            "name_b": points[1] if len(points) > 1 else "",
            "voltage_kv": voltages(title),
            "status": status,
            "start_date": None,
            "in_service_date": dates[-1] if dates else None,
            "in_service_raw": isd_raw,
            "estimated_cost_usd": budget.get("Total") or (max(amounts) if amounts else None),
            "budget": budget, "budget_parse": budget_how, "budget_check": budget_check,
            "budget_start": b_start, "budget_start_basis": b_basis,
            "description": description,
            "need": need,
            "source_doc": "DESC Planned Transmission Projects $2M and above (2024-2028)",
            "source_page": page_no,
        })
    return projects


# ----------------------------------------------------------------------------------------------
# Georgia Power (GA ITS Ten-Year Plan inside the 2025 IRP, Volume 3)
# ----------------------------------------------------------------------------------------------
SECTION_RX = re.compile(r"^\s*([A-H])\.\s+(.*Project[s]?\s+Details.*|.*Projects?)\s*$")


def extract_gpc():
    text = pdf_to_text(GPC_PDF, TEXT / "gpc_irp_vol3.txt")
    segments = text.split("\f")
    projects, section = [], ""
    for seg in segments:
        footer = re.search(r"Page\s+(\d+)\s+of\s+304", seg)
        lines = [ln.rstrip() for ln in seg.splitlines() if ln.strip()]
        lines = [ln for ln in lines if not any(m in ln for m in BANNER_MARKERS) and ln.strip() != "employees."]
        for ln in lines:
            m = SECTION_RX.match(ln)
            if m and "Teams" not in seg[: seg.find(ln)]:
                section = f"{m.group(1)}. {m.group(2).strip()}"
        tm = re.search(r"Teams\s*#\s*(\d+)", seg)
        if not tm or not footer:
            continue
        plan_page = int(footer.group(1))
        stripped = [ln.strip() for ln in lines]
        t_idx = next(i for i, s in enumerate(stripped) if re.match(r"Teams\s*#", s))
        name = " ".join(stripped[:t_idx])
        dates = re.search(r"Need Date\s+(\d{2}/\d{2}/\d{4})\s+Start Date\s+(\d{2}/\d{2}/\d{4})", seg)
        description = between(lines, "Description", ("Supporting Statement",))
        chg_plan = between(lines, "Change From Previous Ten Year Plan", ("Change From Previous IRP",))
        chg_irp = between(lines, "Change From Previous IRP", ("Estimated Cost",))
        points = split_endpoints(name)
        area = re.match(r"^(SAV|GTC|MEAG|DU)\s*:", name)
        projects.append({
            "project_id": f"GPC_{tm.group(1)}",
            "source_id": tm.group(1),
            "utility": "Georgia Power",
            "utility_code": "GPC",
            "state": "GA",
            "project_name": name,
            "name_a": points[0] if points else "",
            "name_b": points[1] if len(points) > 1 else "",
            "voltage_kv": voltages(name),
            "area_prefix": area.group(1) if area else "",
            "section": section,
            "status": chg_irp,
            "change_from_previous_plan": chg_plan,
            "start_date": parse_date(dates.group(2)) if dates else None,
            "in_service_date": parse_date(dates.group(1)) if dates else None,
            "description": description,
            "source_doc": "Georgia Power 2025 IRP Vol. 3 (public disclosure): 2024 GA ITS Ten-Year Plan (2025-2034)",
            "plan_page": plan_page,
            "source_page": GPC_PLAN_FIRST_PDF_PAGE - 1 + plan_page,
        })
    return projects


CSV_COLUMNS = [
    "project_id", "utility", "state", "project_name", "name_a", "lat_a", "lon_a", "name_b", "lat_b", "lon_b",
    "lat_center", "lon_center", "start_date", "in_service_date", "voltage_kv", "status", "source_id", "source_page",
    "description",
]


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    desc, gpc = extract_desc(), extract_gpc()
    (OUT / "desc_projects.json").write_text(json.dumps(desc, indent=2), encoding="utf-8")
    (OUT / "gpc_projects.json").write_text(json.dumps(gpc, indent=2), encoding="utf-8")
    with open(OUT / "projects_extracted.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=CSV_COLUMNS, extrasaction="ignore")
        w.writeheader()
        for p in desc + gpc:
            row = dict(p)
            row["voltage_kv"] = "/".join(str(v) for v in p["voltage_kv"])
            w.writerow(row)
    print(f"DESC projects: {len(desc)}   GPC projects: {len(gpc)}")
    for label, rows in (("DESC", desc), ("GPC", gpc)):
        missing_dates = [p["project_id"] for p in rows if not p["in_service_date"]]
        no_points = [p["project_id"] for p in rows if not p["name_a"]]
        print(f"{label}: missing in-service date: {missing_dates or 'none'}; no parsed sub-point: {no_points or 'none'}")


if __name__ == "__main__":
    main()
