# Devpost draft: GridLock

> Draft written overnight. Edit it into your own voice before pasting it into Devpost. Two things to decide yourself:
> - Say which tools helped you build it (AI coding assistants, Blender). MLH events allow them, and judges value honesty.
> - Only select challenges the project really fits (see the bottom).

**Tagline:** Two utilities, one river, 78 places where they could share crews, land and time.

## Inspiration

Power companies plan their transmission work years ahead, and neighbors mostly plan alone. In 2024, FERC Order No. 1920 pushed utilities toward coordinated long-term planning, because planning in isolation wastes money and slows down the grid. Sperry Tech's GridLock challenge asked a sharp version of that question: where exactly do Dominion Energy South Carolina's and Georgia Power's planned projects come close enough, in space and in time, that they should be coordinating?

## What it does

GridLock reads both utilities' public construction plans, puts every project on a map, and ranks the places where they overlap.

- **252 planned projects extracted** (44 DESC, 208 Georgia Power); **217 mapped** to real substations and lines, each linked to its source page.
- **78 cross-utility overlaps**, measured between the **closest points** of the two projects (the spec's rule) and ranked the way the spec asks: **distance tier first, then build timing**, then the exact distance. The tiers:
  - touching / crossing (within 0.25 km): must coordinate
  - under 1.6 km: share the land
  - under 8 km: share site logistics
  - under 40 km: share crews and equipment
- **Build windows:** Georgia Power publishes start and need dates. DESC's windows come from its own year-by-year budget. 34 of the 78 pairs are under construction at the same time.
- **An impact estimate** for every opportunity: one mobilization avoided plus shared right-of-way, with editable assumptions.
- **#1, Thurmond Dam:** DESC's Hooks–Thurmond 115 kV tie rebuild and Georgia Power's Evans Primary–Thurmond Dam #5 and #6 115 kV rebuilds end in **the same substation** at the dam on the Savannah River. They touch, so the two utilities must coordinate outages and crossing structures there. As planned, their build windows are 4.4 years apart, so the opportunity is to line up the schedules. Sperry's own sample lists this pair first, about 4 miles apart center to center.
- **The best pair to share as planned (#3):** DESC's new $23.8M Jasper–Okatie 230 kV line and Georgia Power's McIntosh–Purrysburg 230 kV tie work are **0.94 km apart** and **both under construction for the same 24 months**, worth roughly $1M if coordinated. Georgia Power's equipment work is at McIntosh; its tie lines end in the same Purrysburg Road yard as DESC's existing Jasper lines.
- **Filters:** GEOGRAPHIC (by tier), TIMELINE (by timing) or BOTH (close and timed together). Everything else dims, so the map stays readable.
- **Add your own project:** draw a line or drop a substation, and GridLock scores it against the other utility's plans instantly, with the same rules.
- **See it:**
  - satellite imagery and 3D terrain in the map
  - a guided tour of the top opportunities
  - a walkable 3D world of both border regions, built in Blender and Three.js, with real buildings, substations and satellite ground, plus an optional Google photorealistic 3D mode
  - one click opens any opportunity in Google Earth's own 3D view
- **Downloads:** the overlap and project tables in the column layout of Sperry's starter spreadsheet, and a Google Earth file (KML) with every project and overlap. Each pop-up shows the gap, the timing, the savings estimate and the source pages, so a planner can open it in the tools they already use.

## How I built it

- **Parsing:** Python + Poppler's `pdftotext`.
  - DESC's PDF has one project per page, and each 5-year budget table is checked against its stated total.
  - Georgia Power's ten-year plan is embedded in its 2025 IRP (pages 171–474), with a TEAMS number, need date and start date per project.
- **Locations:** OpenStreetMap through the Overpass API, following Sperry's "Finding Real Locations" guide.
  - Names are matched to named substations, then checked against state boundaries and the other end of each line.
  - Where OSM has no name, I **traced the power-line network**. Tracing found DESC's "Hooks" (9.4 miles from Stevens Creek; DESC says 9.5) and Georgia Power's "Purrysburg" tie point, about 1 km from DESC's Jasper plant.
  - Town-level fallbacks (Nominatim) are always labeled low confidence.
- **Overlap engine:** closest points between point and line geometries (Shapely) in a local projection, the four tiers, and build-window overlap. The ranking follows the spec: tier, then timing, then distance. A 0–100 score (65% distance, 35% timing) is shown as a summary but never reorders pairs across tiers.
- **Validation:** it reproduces **all 6 overlaps in Sperry's sample**, with in-service gaps matching to the day. The browser version of the math matches the Python pipeline exactly: the same 78 overlaps, distances within 1 m.
- **Web app:** TypeScript + Vite + MapLibre GL, with an OpenFreeMap basemap, USGS satellite imagery and AWS terrain tiles, none of which need API keys.
- **3D world:** Blender + Three.js, generated from the same data files. The optional Google 3D mode streams Google's photorealistic tiles through `3d-tiles-renderer`.

## Challenges I ran into

- **Sperry's own documents disagree on how to measure.** The starter guide measures center to center, while the spec says closest points. Closest points matters: at Thurmond, the center method says 3.9 miles, but the two projects share the same substation. The app shows both methods side by side.
- **OpenStreetMap doesn't name every substation.** Tracing power lines found two key ones, and every manual location cites its evidence.
- **Street names are ambiguous.** "First Avenue" exists in every city. A Georgia Power line in Columbus, GA was briefly placed in Savannah, so street matches now need a nearby partner. A final audit also caught two Georgia Power ends named after streets ("Fenwick Street", "Sand Bar Ferry") and moved them off the road to the nearest Georgia Power 115 kV substations (Sand Bar Ferry is still marked approximate).
- **Three of DESC's budget tables don't add up** in the source PDF. They're flagged in the app instead of silently "fixed".

## Accomplishments I'm proud of

- Real findings from real public data, checked against the sponsor's answer key.
- Being honest about uncertainty: every location has a confidence level and every number has a source page.
- A tool, not just a report: add a project and see where it would collide.

## What I learned

How transmission planning actually works: IRPs, regional forums like SERTP, CEII. Also how much of "AI and data" work is really careful extraction, validation and admitting what you don't know.

## What's next for GridLock

- Draw real line routes along the OSM power network instead of straight segments.
- Add more utilities: Santee Cooper, Duke, and the rest of SERTP.
- Ingest new filings automatically.
- Alert planners when a new plan creates an overlap.

## Built with

python · shapely · poppler · openstreetmap · overpass-api · nominatim · typescript · vite · maplibre-gl · openfreemap · usgs-national-map · aws-terrain-tiles · blender · three.js · 3d-tiles-renderer · kml

## Challenges to select on Devpost

- **Sperry Tech (GridLock):** yes, this is the main target.
- **Best Overall:** entered automatically.
- **Microsoft "What's Missing?":** plausible. AI is part of the build, not a chatbot, and someone accomplishes a real task. Only select it if you're comfortable pitching it that way.
- **MLH GoDaddy Registry:** only if you register a domain with their code and point it at the site.
- **Don't select** Gemini, ElevenLabs, MongoDB, Snowflake, Solana or Tiger Data. We didn't use them.

Required in the submission: the GitHub repo link, at least one Discord tag, and your full name.
