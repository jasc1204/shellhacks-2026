# Sperry Tech: GridLock Challenge (ShellHacks 2026)

> Source: the "Challenge Specifications" section of the Sperry Tech challenge in the ShellHacks 2026 Hacker Guide, as pasted by Jose on 2026-09-26. Kept as close to the original as possible (minor typo fixes only). Open questions are collected at the bottom.

## 1. What this challenge is

Power grid companies ("utilities") each plan their own future construction projects (new power lines, upgraded substations, etc.) years in advance. The problem: neighboring utilities in different states often plan this work without much visibility into what the other one is doing nearby.

The challenge: **build a tool that compares at least two utilities' public future construction plans and flags where their planned work overlaps**, either because the projects are physically close to each other, or because they're scheduled around the same time.

Why it matters: when utilities coordinate on nearby projects, they can potentially share resources (crews, equipment, right-of-way, substation capacity), which saves money and gets infrastructure built faster. Right now, that coordination mostly doesn't happen at this level of detail.

This is a real, current problem. Federal regulators (FERC) issued a rule in 2024 ("Order No. 1920") specifically because utilities have historically planned in isolation, leading to duplicated, inefficient work and delays in construction of our nation's infrastructure. This challenge is a smaller, hackathon-sized version of that same coordination problem.

## 2. The two utilities used as the example

- **Utility 1:** Dominion Energy South Carolina (DESC)
- **Utility 2:** Georgia Power (GPC)

Georgia Power is a founding sponsor of the same regional coordination forum DESC is joining (SERTP, see glossary), so this example mirrors a real coordination relationship, not a made-up scenario. More importantly, South Carolina and Georgia share a border (the Savannah River). Sperry confirmed real, currently planned DESC projects (**Jasper, Okatie, Bluffton** near Savannah; **Urquhart** near Augusta) sitting directly across the river from active Georgia Power work in the same two areas (a **Plant McIntosh expansion** near Savannah, and the **Thomson–Vogtle transmission line** near Augusta). DESC also owns an existing hydro plant physically located in **Martinez, GA**, near Augusta, so there's already a real crossover of the two utilities.

*Optional base map layer:* HIFLD (Homeland Infrastructure Foundation-Level Data) provides public, downloadable GIS data on existing transmission lines and substations. Useful as a backdrop layer, though it shares the same straight-line-approximation limitation noted in Section 4 (Section 4 was not included in the pasted spec).

## 3. Vocabulary

| Term | What it means |
| --- | --- |
| **Transmission line** | A high-voltage power line that moves electricity long distances between power plants, substations, and regions. (Different from the smaller "distribution lines" that run to individual houses.) |
| **Substation** | A facility where electricity is stepped up/down in voltage and routed between transmission lines. Think of it as a highway interchange for electricity. |
| **Right-of-way** | The strip of land a utility owns or has legal access to in order to build/maintain a line. If two projects could share a right-of-way, that's a resource-sharing win. |
| **IRP (Integrated Resource Plan)** | A utility's official long-term plan for how it will generate and deliver power. Both DESC and Georgia Power file one: DESC's is a 15-year plan with the SC PSC; Georgia Power's is a 10-year plan with the Georgia PSC. |
| **10-Year Transmission Plan** | Georgia Power's version of a long-term plan. Not a separate filing, but a section embedded within their IRP, filed with the Georgia PSC. |
| **PSC (Public Service Commission)** | The state agency that regulates utilities and reviews/approves their plans. Both SC and GA have one. |
| **FERC** | Federal Energy Regulatory Commission: the federal agency that regulates interstate electricity transmission; sits above the state PSCs. |
| **FERC Order No. 1920** | A 2024 federal rule requiring utilities to do more coordinated, long-term regional transmission planning. The real-world reason this challenge is relevant right now. |
| **SERTP** | Southeastern Regional Transmission Planning: a regional coordination forum founded by Southern Company (Georgia Power's parent) with Georgia Transmission Corporation, MEAG, and others. DESC is joining SERTP as part of its Order 1920 compliance, so both utilities sit in the same regional forum. |
| **SCRTP** | South Carolina Regional Transmission Planning: the process DESC and Santee Cooper use to publish their planned project lists (**this is where Sperry's DESC data comes from**). Co-administered by Dominion and Santee Cooper as peers. DESC is transitioning from SCRTP to SERTP, so newer project lists may be published by SERTP; worth checking for a newer source. |
| **CEII (Critical Energy Infrastructure Information)** | A confidential label on sensitive grid data. **Anything marked CEII is off-limits for this challenge; use only public filings.** |
| **Geographic overlap** | Two planned projects are physically near or crossing each other on a map. |
| **Timeline overlap** | Two planned projects are scheduled to be built in the same window of time (even if not in the exact same spot). |

## 4. What to build

Build a tool that ingests publicly available future-construction data from at least two neighboring electric utilities, such as Dominion Energy South Carolina and Georgia Power, and identifies where their planned transmission projects overlap, using two definitions of overlap.

### Geographic overlap (primary signal)

- Two planned projects overlap if they are **within 40 km (25 miles) of each other**. Closer than 40 km: flag it. Farther: ignore it.
- Measure the **closest points** between the two projects, **not their centers**. A 60 km power line can still pass within 5 km of the other utility's substation, and that counts.
- Why 40 km: roughly how far a crew drives from one staging yard in the morning. Inside that, two utilities can share crews, cranes, and contractors; outside it, they'd set up separately anyway.

Closer overlaps are worth more; rank them by distance:

| Tier | Distance | What can be shared |
| --- | --- | --- |
| 1 | Touching / crossing | Must coordinate (outage timing, crossing structures) |
| 2 | Under 1.6 km | The land itself (right-of-way, access roads, permits) |
| 3 | Under 8 km | Site logistics (laydown yards, deliveries) |
| 4 | Under 40 km | Crews and equipment |

### Timeline overlap (strong secondary signal)

- Planned projects scheduled in the same build window.
- Treat geographic overlap as the primary signal and timeline overlap as a strong secondary signal used together with it.

### Data sources (examples; any tools/sources are allowed)

- Refer to `ShellHakcs_finding_real_locations` (document name as given; not included in the paste)
- `www.OneDriveLinkHere.com` (LINK TO PDF), **a placeholder, not a real link**

**Expect most of the dataset NOT to overlap. Finding the real matches is the point of the exercise.**

## 5. Deliverables

Format is up to you: web app, dashboard, notebook, anything. No prescribed tech stack. The output must be visually clear and at least somewhat interactive (e.g., a map you can pan/zoom/click into, not just a static image). Be creative.

- **Required:** an interactive UI showing both utilities' planned projects, visually highlighting where overlaps occur.
- **Required:** a ranked list of the top coordination opportunities (which overlaps).
- **Bonus:** a rough cost/impact estimate for at least one flagged opportunity (e.g., how much land the two projects could share instead of using separate land, or a simple explanation of how much money that could save).

## 6. Prizes

Per this spec:

- **1st:** guaranteed internship + laptop
- **2nd:** internship interview + laptop
- **3rd:** internship interview

Devpost lists the prizes as: 1st, guaranteed internships + MacBook Airs; 2nd, interviews + iPads; 3rd, interviews ("$5,000 in cash, 3 winners", which is most likely the total prize value, not a cash payout).

The internship is Software Engineer Intern, AI Department, hybrid in Coral Springs, FL (data extraction, cleaning, validation, Python, Git; apply via careers@sperrytech.ai).

## Open questions (ask Sperry Tech on Discord or at their booth)

1. The real data PDF: the OneDrive link in the spec is a placeholder.
2. The `ShellHakcs_finding_real_locations` document.
3. The missing "Section 4" (the straight-line-approximation note).
4. The prize mismatch: laptop vs. iPad for 2nd place, and whether any cash is involved.
5. Whether the internship is paid, and how much of it is in person in Coral Springs.
