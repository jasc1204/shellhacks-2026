# ShellHacks 2026: GridLock

Entry for **Sperry Tech's GridLock challenge** at [ShellHacks 2026](https://shellhacks-2026.devpost.com/) (FIU, Miami, Sep 25-27, 2026).

Neighboring utilities plan their transmission work years in advance, mostly without seeing each other's plans. GridLock compares the public construction plans of **Dominion Energy South Carolina (DESC)** and **Georgia Power (GPC)** and flags where planned projects overlap in space (closest points within 40 km, ranked in tiers) and in time (the same build window). Those overlaps are where the two utilities could share crews, equipment and right-of-way.

The challenge brief is in [GRIDLOCK_SPEC.md](GRIDLOCK_SPEC.md).

## Status

Work in progress during the hackathon. Built so far: the data pipeline below, which extracts 252 planned projects (44 DESC, 208 Georgia Power), geocodes their named endpoints and ranks the cross-utility overlaps. Also in progress: `web/` (the interactive map: Vite, TypeScript, MapLibre GL) and `world3d/` (a 3D scene of each border region).

## Data pipeline

Python 3 with `pip install shapely numpy pillow`. Step 1 also needs `pdftotext` from [Poppler](https://poppler.freedesktop.org/).

| Step | Script | Output |
| --- | --- | --- |
| 1. Extract projects, dates and source pages from the two utility PDFs | `pipeline/extract_projects.py` | `data/processed/desc_projects.json`, `gpc_projects.json`, `projects_extracted.csv` |
| 2. Download substations and plants (GA + SC) and power lines (Savannah and Augusta border areas) from OpenStreetMap | `pipeline/fetch_osm.py` | `data/osm/*.json` |
| 3. Match each project's named endpoints to OpenStreetMap substations, with a town-level Nominatim fallback flagged as low confidence | `pipeline/geocode.py` | `data/processed/projects_located.json` |
| 4. Rank overlaps: closest-point distance tiers (touching, < 1.6 km, < 8 km, < 40 km) plus build-window overlap, with Sperry's center-to-center method for comparison | `pipeline/overlaps.py` | `data/processed/overlaps.json`, `overlap_summary.json` |
| 5. Write the compact files the web map loads | `pipeline/export_web.py` | `web/public/data/` |

Every step's output is committed, so you can start from any step:

```bash
python pipeline/extract_projects.py   # needs the starter package in data/sperry/
python pipeline/fetch_osm.py          # uses the cached files; --force re-downloads
python pipeline/geocode.py
python pipeline/overlaps.py
python pipeline/export_web.py
python world3d/prep_scene.py savannah # 3D scene: terrain, basemap and grid for one border region
```

## Data sources

- **DESC:** Planned Transmission Projects $2M and above (2024-2028), one project per page.
- **Georgia Power:** 2025 IRP Volume 3 (public disclosure version), which embeds the 2024 GA ITS Ten-Year Plan (2025-2034) with a need date and a start date for each project.
- Both PDFs came in **Sperry Tech's GridLock starter package**, which is not redistributed here (`data/sperry/` is git-ignored). Put the package there to re-run step 1.
- Substations, plants and power lines: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL, via the Overpass and Nominatim APIs.
- 3D scene: elevation from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium); basemap © OpenStreetMap contributors © [CARTO](https://carto.com/attributions).
- Manual location overrides for endpoints that OpenStreetMap does not name, each with a source and confidence level: `data/overrides/locations_manual.csv`.
