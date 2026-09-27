# ShellHacks 2026: GridLock

Entry for **Sperry Tech's GridLock challenge** at [ShellHacks 2026](https://shellhacks-2026.devpost.com/) (FIU, Miami, Sep 25-27, 2026).

Neighboring utilities plan their transmission work years in advance, mostly without seeing each other's plans. GridLock compares the public construction plans of **Dominion Energy South Carolina (DESC)** and **Georgia Power (GPC)** and flags where planned projects overlap in space (closest points within 40 km) and in time (the same build window). It ranks them the way the spec asks: distance tier first, then build timing, then the exact distance. Those overlaps are where the two utilities could share crews, equipment and right-of-way.

**Try it:** [jasc1204.github.io/shellhacks-2026](https://jasc1204.github.io/shellhacks-2026/), the 2D map and the 3D world on one page: the **2D / 3D** switch in the header flips between them at the same spot. The optional GOOGLE 3D mode needs your own token, so it only works when you run the app locally.

The challenge brief is in [GRIDLOCK_SPEC.md](GRIDLOCK_SPEC.md).

## Status

Built during the hackathon:
- **The data pipeline** below. It extracts 252 planned projects (44 DESC, 208 Georgia Power), locates their named end points, ranks the 78 cross-utility overlaps, and reproduces all 6 overlaps in Sperry's starter sample.
- **`web/`:** the app (Vite, TypeScript, MapLibre GL): the 2D satellite map with the ranked list, and the 3D world embedded in place behind the **2D / 3D** switch, plus "add your own project", a Google Earth link for every opportunity and a Google Earth file of everything.
- **`world3d/`:** a 3D world of the two border regions (Savannah River and Augusta/Thurmond), built with Blender and Three.js from the same data, with an optional Google photorealistic 3D mode.

## Data pipeline

Python 3 with `pip install shapely numpy pillow`. Step 1 also needs `pdftotext` from [Poppler](https://poppler.freedesktop.org/).

| Step | Script | Output |
| --- | --- | --- |
| 1. Extract projects, dates and source pages from the two utility PDFs | `pipeline/extract_projects.py` | `data/processed/desc_projects.json`, `gpc_projects.json`, `projects_extracted.csv` |
| 2. Download substations and plants (GA + SC) and power lines (Savannah and Augusta border areas) from OpenStreetMap | `pipeline/fetch_osm.py` | `data/osm/*.json` |
| 3. Match each project's named endpoints to OpenStreetMap substations, with a town-level Nominatim fallback flagged as low confidence | `pipeline/geocode.py` | `data/processed/projects_located.json` |
| 4. Find overlaps between the closest points of each pair (projects are straight lines between their named end substations, since the filings name only the ends) and rank them: distance tier first (touching within 0.25 km, under 1.6 km, under 8 km, under 40 km), then build timing (overlapping windows, then the smaller gap), then the exact distance. Sperry's center-to-center method is kept for comparison | `pipeline/overlaps.py` | `data/processed/overlaps.json`, `overlap_summary.json` |
| 5. Write the compact files the web map loads, the project and overlap tables in the column layout of Sperry's `Projects_Overlaps.xlsx`, and a Google Earth file | `pipeline/export_web.py` | `web/public/data/` (incl. `overlaps_sperry_format.csv`, `gridlock.kml`), `data/processed/projects_located.csv` |

Every step's output is committed, so you can start from any step:

```bash
python pipeline/extract_projects.py   # needs the starter package in data/sperry/
python pipeline/fetch_osm.py          # uses the cached files; --force re-downloads
python pipeline/geocode.py
python pipeline/overlaps.py
python pipeline/export_web.py
python world3d/prep_scene.py savannah # 3D scene: terrain, basemap and grid for one border region (and augusta)
```

## Web app

The interactive map (`web/`, Vite + TypeScript + MapLibre GL) reads the files from step 5.

```bash
cd web
npm install
npm run dev     # http://localhost:5173 (also copies MapLibre's worker into public/maplibre/)
npm run build   # static site in web/dist/
```

The public site is built and deployed by `.github/workflows/pages.yml` (GitHub Pages, `VITE_BASE=/shellhacks-2026/`) on every push to `main`.

- **Map:** both utilities' planned projects, with the overlaps drawn in gold between their closest points and the selected pair labeled on the map. Toggle **CENTERS** to compare with the center-to-center method from Sperry's starter guide.
- **2D / 3D:** one page, two views of the same overlaps. **2D** is the satellite map: Sentinel-2 cloudless zoomed out, USGS aerial imagery up close. **3D** puts the 3D world in place of the map at the selected overlap: the map leans in toward it and the 3D camera takes over from the same spot. The 3D world builds in the background once the map is up, and draws nothing while you're in 2D (`web/src/world.ts`).
- **Layers:** toggle either utility's projects, your projects, overlaps, the existing grid, line end points and place names.
- **Opportunities:** the ranked list (distance tier first, then build timing). Three filters narrow it: **GEOGRAPHIC** (by distance tier), **TIMELINE** (by build timing) and **BOTH** (close and timed together); everything else on the map dims. Each opportunity opens a card with both projects, their source pages, how confident each location is, a build-window timeline, a rough, editable savings estimate (the 3D card shows it too), **View in 3D** (switches in place), and **Google Earth**, which opens Google Earth's own 3D view at the gap.
- **Add your own project:** draw a line or drop a substation, pick the utility and build window, and it's scored in the browser with exactly the same rules as the pipeline (`web/src/geo.ts`, checked against `overlaps.json`: the same 78 overlaps, distances within 1 m). Saved in the browser (`localStorage["gridlock.userProjects.v1"]`) and shown in the 3D world too.
- **Data quality:** downloads of the overlap and project tables in the column layout of Sperry's `Projects_Overlaps.xlsx` and of `gridlock.kml` (every mapped project and the ranked overlaps, with the gap, timing, savings estimate and source pages in each pop-up; opens in Google Earth or any GIS), the check against Sperry's sample, location confidence, manual locations with their evidence, and the projects that couldn't be mapped.
- **Links:** `#o=<overlap id>` opens an opportunity, e.g. `#o=DESC_23__GPC_20277`, and `&v=3d` opens it straight in 3D (`#o=DESC_23__GPC_20277&v=3d`). The 3D world is served from the same site under `/world3d/viewer/`, embedded with `?embed=1` (the dev server serves `../world3d`; `npm run build` copies the files the viewer needs into `dist/world3d/`).

## 3D world

`world3d/viewer/` (Three.js) is the app's **3D** view. It also runs on its own at `/world3d/viewer/?level=savannah` (or `augusta`): add `&select=1` to fly to overlap #1. In 3D, the panel at the top left switches between the two regions (L1 SAVANNAH, L2 AUGUSTA).

- Satellite ground, real building footprints, today's grid with its towers (OpenStreetMap), substations, and both utilities' planned lines shown as see-through towers at real height. Your own projects from the map appear too.
- **GOOGLE 3D** (`?photoreal=1`) swaps our ground for Google's photorealistic 3D tiles (via `3d-tiles-renderer`). It needs your own free token in `world3d/viewer/tokens.local.json`: `{"cesiumIonToken": "..."}` from cesium.com/ion, or `{"googleMapsKey": "..."}`. The file is git-ignored and only the dev server serves it, so a built site never includes it.

## Data sources

- **DESC:** Planned Transmission Projects $2M and above (2024-2028), one project per page.
- **Georgia Power:** 2025 IRP Volume 3 (public disclosure version), which embeds the 2024 GA ITS Ten-Year Plan (2025-2034) with a need date and a start date for each project.
- Both PDFs came in **Sperry Tech's GridLock starter package**, which is not redistributed here (`data/sperry/` is git-ignored). Put the package there to re-run step 1.
- Substations, plants and power lines: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL, via the Overpass and Nominatim APIs.
- Web map labels: [OpenFreeMap](https://openfreemap.org), © [OpenMapTiles](https://openmaptiles.org), © OpenStreetMap contributors. Satellite imagery zoomed out: [Sentinel-2 cloudless 2024](https://s2maps.eu) by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0. Up close: [USGS The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map) (public domain). Both credits show on the map.
- Optional GOOGLE 3D mode: Google Photorealistic 3D Tiles, streamed live with your own token. Nothing from Google is saved in this repo.
- 3D scene: elevation from [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium); basemap © OpenStreetMap contributors © [CARTO](https://carto.com/attributions).
- Manual location overrides for endpoints that OpenStreetMap does not name, each with a source and confidence level: `data/overrides/locations_manual.csv`.
