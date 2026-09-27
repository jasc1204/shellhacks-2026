// GridLock: where Dominion Energy South Carolina and Georgia Power plan work close together in space and time.
// Data comes from pipeline/ (see README): projects.geojson, endpoints.geojson, overlaps.json, backdrop.geojson, meta.json.
import { Map as MapLibreMap, NavigationControl, ScaleControl, LngLatBounds, GeoJSONSource, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import type { Feature, Level, Loc, LonLat, Meta, Method, Overlap, ProjectProps, Utility } from './types'
import { centerOf, scorePair } from './geo'
import { addSatellite, satelliteStyle, setLayersVisible } from './layers'
import { currentView, initWorld, preloadWorld, setVisible3D, show2D, show3D, tour3D, type Target, type View } from './world'
import { loadUserProjects, nextUserId, onUserProjectsChanged, saveUserState, toFeature, type UserProject } from './userProjects'

// MapLibre v6 finds its worker next to its own bundle, which Vite moves. Serve the worker from public/ instead
// (copied there by `npm run sync-maplibre`) so dev and production builds behave the same.
setWorkerUrl(new URL(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`, location.href).href)

const COLOR: Record<Utility, string> = { DESC: '#4dd8ff', GPC: '#3b7dff' }
const HOT = '#ffd166'
const ICE = '#eef4ff'
const UTIL_NAME: Record<Utility, string> = { DESC: 'DOMINION ENERGY SC', GPC: 'GEORGIA POWER' }
const TIER_SHORT: Record<number, string> = { 1: 'T1 TOUCHING', 2: 'T2 UNDER 1.6 KM', 3: 'T3 UNDER 8 KM', 4: 'T4 UNDER 40 KM' }

// The spec's two overlap signals, as three views of the same overlaps (the 3D world uses the same design).
// GEOGRAPHIC: every pair within 40 km, by tier. TIMELINE: the same pairs by build timing.
// BOTH: the spec's "used together", close enough to share (tier 1 to 3) AND timed together (same window or under 6 months).
type Mode = 'geo' | 'time' | 'both'
type Bucket = 'same' | 'u6' | 'u2y' | 'far'
const MODES: { key: Mode; label: string; tip: string }[] = [
  { key: 'geo', label: 'GEOGRAPHIC', tip: 'Primary signal: every pair within 40 km, measured between the closest points' },
  { key: 'time', label: 'TIMELINE', tip: 'Secondary signal: the same overlaps, grouped by how their build windows line up' },
  { key: 'both', label: 'BOTH', tip: 'Both signals used together: close enough to share, and building at the same time' },
]
const TIER_WORDS: Record<number, string> = { 1: 'TOUCHING', 2: 'UNDER 1.6 KM', 3: 'UNDER 8 KM', 4: 'UNDER 40 KM' }
const TIER_SHARE: Record<number, string> = {
  1: 'Must coordinate outage timing and crossing structures',
  2: 'Can share the land itself: right-of-way, access roads, permits',
  3: 'Can share site logistics: laydown yards, deliveries',
  4: 'Can share crews and equipment',
}
const BUCKETS: { key: Bucket; label: string; tip: string }[] = [
  { key: 'same', label: 'SAME WINDOW', tip: 'Build windows overlap: crews and equipment can be shared as planned' },
  { key: 'u6', label: 'UNDER 6 MONTHS APART', tip: 'Back to back or close: a small schedule shift lines them up' },
  { key: 'u2y', label: 'UNDER 2 YEARS APART', tip: 'Sharing would take a real schedule change' },
  { key: 'far', label: '2 YEARS OR MORE', tip: 'Far apart in time: close on the map, but built years apart' },
]
const bucketOf = (o: Overlap): Bucket =>
  o.overlap_days > 0 ? 'same' : o.window_gap_days < 183 ? 'u6' : o.window_gap_days < 730 ? 'u2y' : 'far'
const isBoth = (o: Overlap) => o.tier <= 3 && (o.overlap_days > 0 || o.window_gap_days < 183)
// Spec order: closer tiers first (touching leads), then build timing, then distance. The pipeline already ranks its
// overlaps this way, so those keep their exported rank; your own projects' overlaps are placed with the pipeline's key:
// (tier, -time_score, window_gap_days, closest_km, needs_location_check, id).
const pipelineKey = (x: Overlap, y: Overlap) =>
  x.tier - y.tier || y.time_score - x.time_score || x.window_gap_days - y.window_gap_days || x.closest_km - y.closest_km ||
  +x.needs_location_check - +y.needs_location_check || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)
const specOrder = (x: Overlap, y: Overlap) => (!x.user && !y.user ? x.rank - y.rank : pipelineKey(x, y))
// Sperry's starter sample (Projects_Overlaps.xlsx): their 6 overlaps, center distance in miles, in-service gap in days.
const SPERRY_SAMPLE = [
  { id: 'OVL_1', a: 'DESC_31', b: 'GPC_20793', mi: 4.09, gap: 3074 },
  { id: 'OVL_2', a: 'DESC_23', b: 'GPC_20277', mi: 5.65, gap: 152 },
  { id: 'OVL_3', a: 'DESC_23', b: 'GPC_20065', mi: 7.55, gap: 517 },
  { id: 'OVL_4', a: 'DESC_14', b: 'GPC_20793', mi: 8.01, gap: 3074 },
  { id: 'OVL_5', a: 'DESC_10', b: 'GPC_20277', mi: 14.34, gap: 365 },
  { id: 'OVL_6', a: 'DESC_10', b: 'GPC_20065', mi: 14.81, gap: 730 },
]

// Layer toggles: each group switches a set of map layers. 'labels' is filled with the basemap's symbol layers.
const LAYER_GROUPS: { key: string; label: string; swatch: string; layers: string[] }[] = [
  { key: 'desc', label: 'Dominion Energy SC', swatch: `<i style="background:${COLOR.DESC}"></i>`, layers: ['desc-lines', 'desc-points'] },
  { key: 'gpc', label: 'Georgia Power', swatch: '<i class="dash"></i>', layers: ['gpc-lines', 'gpc-points'] },
  { key: 'user', label: 'Your projects', swatch: '<i class="user"></i>', layers: ['user-glow', 'user-lines', 'user-points'] },
  { key: 'overlaps', label: 'Overlaps', swatch: `<i style="background:${HOT};box-shadow:0 0 8px ${HOT}"></i>`,
    layers: ['conn-glow', 'connectors', 'conn-ends', 'conn-sel', 'touch-halo', 'touch-ring', 'touch-core', 'touch-sel', 'touch-hit'] },
  { key: 'grid', label: 'Existing grid (OSM)', swatch: '<i style="background:#27406f"></i>', layers: ['backdrop'] },
  { key: 'ends', label: 'Line end points', swatch: '<i class="dot"></i>', layers: ['endpoints'] },
  { key: 'labels', label: 'Place names', swatch: '<i style="background:#7286a4;height:2px"></i>', layers: [] },
]
const UI_KEY = 'gridlock.ui.v1'

const state = {
  method: 'closest' as Method,
  mode: 'geo' as Mode,
  geoTiers: new Set([1, 2, 3, 4]),
  timeBuckets: new Set<Bucket>(['same', 'u6', 'u2y', 'far']),
  bothTiers: new Set([1, 2, 3]),
  selected: null as string | null,
  cost: { mobilizationPct: 3, easementPerAcre: 15000, rowWidthM: 0 },
  layers: Object.fromEntries(LAYER_GROUPS.map((g) => [g.key, true])) as Record<string, boolean>,
  legendCollapsed: window.innerWidth < 900,
  user: [] as UserProject[],
  drawing: false,
}

let map: MapLibreMap
let projects: Feature[] = []          // the utilities' projects (from the pipeline)
let userFeatures: Feature[] = []      // projects added on this map
let byId: Record<string, Feature> = {}
let overlaps: Overlap[] = []          // ranked by the pipeline
let userOverlaps: Overlap[] = []      // scored in the browser with the same rules (geo.ts)
let meta: Meta
let levels: Level[] = []
let levelOf: Record<string, { level: string; title: string }> = {}
let backdropData: any = null
let endpointsData: any = null
let draft: LonLat[] = []

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`)
const ym = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
const rankLabel = (o: Overlap) => (o.user ? `Y${o.rank}` : `#${o.rank}`)
const exactWindow = (p: ProjectProps) => p.user || p.window_basis.startsWith('published')
const allOverlaps = () => [...userOverlaps, ...overlaps]
const findOverlap = (id: string) => allOverlaps().find((o) => o.id === id)

// ------------------------------------------------------------------------------------------------ data
async function load() {
  const get = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => r.json())
  const [p, o, m, bd, ep] = await Promise.all([get('projects.geojson'), get('overlaps.json'), get('meta.json'),
    get('backdrop.geojson'), get('endpoints.geojson')])
  backdropData = bd
  endpointsData = ep
  projects = p.features
  overlaps = [...o].sort((x: Overlap, y: Overlap) => x.rank - y.rank)  // the pipeline's rank is the spec order
  meta = m
  // The 3D world is optional: without it the map works the same, just without "View in 3D".
  try {
    levels = await fetch(`${import.meta.env.BASE_URL}world3d/build/levels.json`).then((r) => (r.ok ? r.json() : []))
    for (const l of levels) for (const id of l.overlap_ids) levelOf[id] = { level: l.level, title: l.title }
  } catch { levels = []; levelOf = {} }
  try { Object.assign(state, pickUi(JSON.parse(localStorage.getItem(UI_KEY) || '{}'))) } catch { /* defaults */ }
  state.user = loadUserProjects()
  recomputeUserOverlaps(false)
}

function pickUi(v: any) {
  const out: Partial<typeof state> = {}
  if (v.layers && typeof v.layers === 'object') out.layers = { ...state.layers, ...v.layers }
  if (MODES.some((m) => m.key === v.mode)) out.mode = v.mode
  const nums = (a: unknown, ok: number[]) => (Array.isArray(a) ? new Set(a.filter((t) => ok.includes(t))) : null)
  const gt = nums(v.geoTiers, [1, 2, 3, 4]), bt = nums(v.bothTiers, [1, 2, 3])
  if (gt) out.geoTiers = gt
  if (bt) out.bothTiers = bt
  if (Array.isArray(v.timeBuckets)) out.timeBuckets = new Set(v.timeBuckets.filter((b: any) => BUCKETS.some((x) => x.key === b)))
  return out
}

function saveUi() {
  try {
    localStorage.setItem(UI_KEY, JSON.stringify({ layers: state.layers, mode: state.mode, geoTiers: [...state.geoTiers], timeBuckets: [...state.timeBuckets], bothTiers: [...state.bothTiers] }))
  } catch { /* ignore */ }
}

/** Score every user project against the other utility's projects (and other user projects), same rules as the pipeline. */
function recomputeUserOverlaps(save = true) {
  userFeatures = state.user.map(toFeature)
  const byUtil = (u: Utility, fs: Feature[]) => fs.filter((f) => f.properties.utility === u)
  const out: Overlap[] = []
  for (const uf of userFeatures) {
    if (uf.properties.utility === 'DESC') {
      for (const g of [...byUtil('GPC', projects), ...byUtil('GPC', userFeatures)]) { const o = scorePair(uf, g); if (o) out.push(o) }
    } else {
      for (const d of byUtil('DESC', projects)) { const o = scorePair(d, uf); if (o) out.push(o) }
    }
  }
  out.sort(pipelineKey)
  out.forEach((o, i) => { o.rank = i + 1; o.user = true })
  userOverlaps = out
  for (const uf of userFeatures) {
    const mine = out.filter((o) => o.a === uf.properties.id || o.b === uf.properties.id)
    uf.properties.n_overlaps = mine.length
    uf.properties.best_tier = mine.length ? Math.min(...mine.map((o) => o.tier)) : null
  }
  byId = Object.fromEntries([...projects, ...userFeatures].map((f) => [f.properties.id, f]))
  if (save) saveUserState(state.user, userOverlaps)
}

/** Every overlap the current distance method flags (the base set the three filter views split up). */
function methodOverlaps(): Overlap[] {
  return allOverlaps().filter((o) => state.method === 'closest' || o.flagged_by_center_method)
}

/** The base set of a view, before its sub-buttons: BOTH keeps only the pairs that are close AND timed together. */
function modeBase(mode: Mode = state.mode): Overlap[] {
  const all = methodOverlaps()
  return mode === 'both' ? all.filter(isBoth) : all
}

function passesSub(o: Overlap): boolean {
  if (state.mode === 'geo') return state.geoTiers.has(o.tier)
  if (state.mode === 'time') return state.timeBuckets.has(bucketOf(o))
  return state.bothTiers.has(o.tier)
}

function visibleOverlaps(): Overlap[] {
  return modeBase().filter(passesSub)
}

const connectorEnds = (o: Overlap): [LonLat, LonLat] =>
  state.method === 'closest' ? o.closest_points as [LonLat, LonLat] : [centerOf(byId[o.a]), centerOf(byId[o.b])]
const isTouchingPoint = ([p, q]: [LonLat, LonLat]) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6

function connectorGeoJSON(list: Overlap[]) {
  return {
    type: 'FeatureCollection',
    features: list.map((o) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: connectorEnds(o) },
      properties: { id: o.id, tier: o.tier, rank: o.rank, concurrent: o.overlap_days > 0, user: !!o.user },
    })),
  }
}

// Touching pairs (tier 1: within 0.25 km, the footprint of a substation) have a connector of zero or near-zero length.
// They get a marker of their own at the middle of their closest points: one per spot, even when several pairs touch
// there (both Thurmond Dam circuits meet the Hooks line in one yard). With the centers method only an exactly
// zero-length connector needs it. `ids` is ",id1,id2," so an expression can test membership with a substring 'in'.
function touchGeoJSON(list: Overlap[]) {
  const spots = new Map<string, { c: LonLat; ids: string[] }>()
  for (const o of list) {
    const ends = connectorEnds(o)
    if (state.method === 'closest' ? o.tier !== 1 : !isTouchingPoint(ends)) continue
    const mid: LonLat = [(ends[0][0] + ends[1][0]) / 2, (ends[0][1] + ends[1][1]) / 2]
    const k = mid.map((v) => v.toFixed(5)).join(',')
    if (!spots.has(k)) spots.set(k, { c: mid, ids: [] })
    spots.get(k)!.ids.push(o.id)
  }
  return fc([...spots.values()].map((s) => ({
    type: 'Feature', geometry: { type: 'Point', coordinates: s.c }, properties: { id: s.ids[0], ids: `,${s.ids.join(',')},`, tier: 1 },
  })))
}

/** Projects in at least one shown overlap stay bright; the rest dim (never removed: the spec wants both plans on screen). */
function shownProjectIds(list = visibleOverlaps()): string[] {
  return [...new Set(list.flatMap((o) => [o.a, o.b]))]
}

const fc = (features: any[]) => ({ type: 'FeatureCollection', features }) as any

// ------------------------------------------------------------------------------------------------ map
// OpenFreeMap's dark vector style (free, no key), recolored from neutral gray to the blue-black palette.
const BASEMAP = 'https://tiles.openfreemap.org/styles/dark'
const BASE_PAINT: [string, string, unknown][] = [
  ['background', 'background-color', '#040910'],
  ['water', 'fill-color', '#08172c'],
  ['waterway', 'line-color', '#0b1d38'],
  ['landcover_wood', 'fill-color', '#050c17'],
  ['landuse_park', 'fill-color', '#050c17'],
  ['landuse_residential', 'fill-color', '#070f1c'],
  ['building', 'fill-color', '#08111f'],
  ['highway_path', 'line-color', '#0b1526'],
  ['highway_minor', 'line-color', '#0d182b'],
  ['highway_major_casing', 'line-color', 'rgba(40,64,111,0.35)'],
  ['highway_major_inner', 'line-color', '#0d1729'],
  ['highway_major_subtle', 'line-color', '#122038'],
  ['highway_motorway_casing', 'line-color', 'rgba(40,64,111,0.45)'],
  ['highway_motorway_inner', 'line-color', '#14243f'],
  ['highway_motorway_subtle', 'line-color', '#122038'],
  ['railway', 'line-color', '#101c31'],
  ['railway_minor', 'line-color', '#101c31'],
  ['railway_transit', 'line-color', '#101c31'],
  ['boundary_state', 'line-color', '#35548f'],
  ['boundary_state', 'line-width', 1.4],
  ['boundary_country_z5-', 'line-color', '#35548f'],
  ['water_name', 'text-color', '#2d5288'],
  ['highway_name_other', 'text-color', '#34496b'],
  ['highway_name_motorway', 'text-color', '#3d5479'],
  ...['place_other', 'place_suburb', 'place_village', 'place_town', 'place_city', 'place_city_large', 'place_state']
    .flatMap((id): [string, string, unknown][] => [[id, 'text-color', '#7286a4'], [id, 'text-halo-color', '#040910']]),
]

// Fetch the basemap style ourselves: drop sources no layer uses (MapLibre v6 never marks OpenFreeMap's unused
// 'ne2_shaded' raster source as loaded, so the map's 'load' event would never fire) and bake in the palette.
async function basemapStyle() {
  const style = await fetch(BASEMAP).then((r) => r.json())
  const used = new Set(style.layers.map((l: any) => l.source).filter(Boolean))
  for (const k of Object.keys(style.sources)) if (!used.has(k)) delete style.sources[k]
  for (const [id, prop, value] of BASE_PAINT) {
    const layer = style.layers.find((l: any) => l.id === id)
    if (layer) layer.paint = { ...(layer.paint || {}), [prop]: value }
  }
  return satelliteStyle(style)
}

function initMap(style: any) {
  map = new MapLibreMap({
    container: 'map',
    style,
    bounds: [[-82.6, 31.9], [-80.6, 33.9]],
    fitBoundsOptions: { padding: 40 },
    // The challenge is Georgia + South Carolina: keep the camera there (every project is inside, with room for the
    // side panel and tilted 3D views) so a demo can't wander off to the rest of the world.
    maxBounds: [[-88, 29], [-76.5, 36.8]],
    renderWorldCopies: false,
    attributionControl: { compact: true },
    maxPitch: 75,
  })
  map.addControl(new NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')
  map.on('error', (e) => console.error('map error:', e.error?.message ?? e))
  if (import.meta.env.DEV) (window as any).__map = map
  initWorld(map, $('.stage'), {
    levels: () => levels,
    visibleIds: () => visibleOverlaps().map((o) => o.id),
    onView: viewChanged,
    onSelect: (id) => (id ? selectOverlap(id, { from3d: true }) : closeDetail()),
  })

  // 'style.load', not 'load': 'load' waits for every basemap tile, and our layers don't need them.
  map.once('style.load', () => {
    LAYER_GROUPS.find((g) => g.key === 'labels')!.layers = map.getStyle().layers.filter((l) => l.type === 'symbol').map((l) => l.id)
    const utilColor: any = ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC]
    map.addSource('backdrop', { type: 'geojson', data: backdropData })
    map.addSource('projects', { type: 'geojson', data: fc(projects) })
    map.addSource('user-projects', { type: 'geojson', data: fc(userFeatures) })
    map.addSource('endpoints', { type: 'geojson', data: endpointsData })
    map.addSource('connectors', { type: 'geojson', data: connectorGeoJSON(visibleOverlaps()) as any })
    map.addSource('touch', { type: 'geojson', data: touchGeoJSON(visibleOverlaps()) })
    map.addSource('draft', { type: 'geojson', data: fc([]) })

    map.addLayer({ id: 'backdrop', type: 'line', source: 'backdrop',
      paint: { 'line-color': '#27406f', 'line-opacity': ['interpolate', ['linear'], ['zoom'], 7, 0.3, 10, 0.55], 'line-width': ['interpolate', ['linear'], ['get', 'kv'], 46, 0.6, 230, 1.2, 500, 1.8] } })

    // selection glow sits under everything it highlights
    map.addLayer({ id: 'sel-glow', type: 'line', source: 'projects', filter: ['in', ['get', 'id'], ['literal', []]],
      paint: { 'line-color': utilColor, 'line-width': 12, 'line-blur': 8, 'line-opacity': 0.6 } })

    const isLine: any = ['==', ['geometry-type'], 'LineString'], isPoint: any = ['==', ['geometry-type'], 'Point']
    map.addLayer({ id: 'gpc-lines', type: 'line', source: 'projects', filter: ['all', ['==', ['get', 'utility'], 'GPC'], isLine],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': COLOR.GPC, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 11, 3.2], 'line-dasharray': [2, 1.2],
        'line-opacity': ['case', ['==', ['get', 'conf'], 'low'], 0.55, 0.95] } })
    map.addLayer({ id: 'desc-lines', type: 'line', source: 'projects', filter: ['all', ['==', ['get', 'utility'], 'DESC'], isLine],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': COLOR.DESC, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 11, 3.6],
        'line-opacity': ['case', ['==', ['get', 'conf'], 'low'], 0.55, 0.95] } })
    for (const u of ['desc', 'gpc'] as const) {
      map.addLayer({ id: `${u}-points`, type: 'circle', source: 'projects', filter: ['all', ['==', ['get', 'utility'], u.toUpperCase()], isPoint],
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 11, 7], 'circle-color': COLOR[u.toUpperCase() as Utility],
          'circle-stroke-color': '#040910', 'circle-stroke-width': 1.5, 'circle-opacity': ['case', ['==', ['get', 'conf'], 'low'], 0.55, 1] } })
    }
    map.addLayer({ id: 'endpoints', type: 'circle', source: 'endpoints', minzoom: 8,
      paint: { 'circle-radius': 3, 'circle-color': ['case', ['==', ['get', 'confidence'], 'low'], 'rgba(0,0,0,0)', utilColor],
        'circle-stroke-width': 1.2, 'circle-stroke-color': utilColor } })

    // projects added on this map: ice white, dashed, glowing (they're "live" what-ifs)
    map.addLayer({ id: 'user-glow', type: 'line', source: 'user-projects', filter: isLine as any,
      paint: { 'line-color': ICE, 'line-width': 9, 'line-blur': 6, 'line-opacity': 0.35 } })
    map.addLayer({ id: 'user-lines', type: 'line', source: 'user-projects', filter: isLine as any, layout: { 'line-cap': 'round' },
      paint: { 'line-color': ICE, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 2, 11, 3.8], 'line-dasharray': [1, 1.4] } })
    map.addLayer({ id: 'user-points', type: 'circle', source: 'user-projects', filter: isPoint as any,
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 5, 11, 9], 'circle-color': ICE, 'circle-stroke-color': '#040910',
        'circle-stroke-width': 2, 'circle-blur': 0.15 } })

    // overlap connectors: the only gold on the map
    map.addLayer({ id: 'conn-glow', type: 'line', source: 'connectors', filter: ['<=', ['get', 'tier'], 3],
      paint: { 'line-color': HOT, 'line-width': 10, 'line-blur': 7, 'line-opacity': 0.35 } })
    map.addLayer({ id: 'connectors', type: 'line', source: 'connectors',
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': HOT, 'line-width': ['match', ['get', 'tier'], 1, 4, 2, 3.4, 3, 2.6, 1], 'line-opacity': connectorOpacity(null) } })
    map.addLayer({ id: 'conn-ends', type: 'circle', source: 'connectors', filter: ['<=', ['get', 'tier'], 3],
      paint: { 'circle-radius': 4, 'circle-color': HOT, 'circle-opacity': 0.9 } })
    map.addLayer({ id: 'conn-sel', type: 'line', source: 'connectors', filter: ['==', ['get', 'id'], ''],
      layout: { 'line-cap': 'round' }, paint: { 'line-color': '#fff5d6', 'line-width': 5 } })

    // Tier 1: where two projects touch. A breathing gold halo (pulse()), a crisp ring and a core, clickable like a connector.
    map.addLayer({ id: 'touch-halo', type: 'circle', source: 'touch',
      paint: { 'circle-color': HOT, 'circle-radius': 16, 'circle-blur': 0.9, 'circle-opacity': 0.4 } })
    map.addLayer({ id: 'touch-ring', type: 'circle', source: 'touch',
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 7, 12, 10], 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': HOT, 'circle-stroke-width': 2.5 } })
    map.addLayer({ id: 'touch-core', type: 'circle', source: 'touch', paint: { 'circle-radius': 3.5, 'circle-color': HOT } })
    map.addLayer({ id: 'touch-sel', type: 'circle', source: 'touch', filter: ['in', ',none,', ['get', 'ids']],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 11, 12, 15], 'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': '#fff5d6', 'circle-stroke-width': 2 } })
    // an invisible, generous hit area: a 3 px core is too small to click
    map.addLayer({ id: 'touch-hit', type: 'circle', source: 'touch', paint: { 'circle-radius': 14, 'circle-color': HOT, 'circle-opacity': 0 } })

    // labels for the selected opportunity: both project names and the gap, placed at the closest points
    map.addSource('sel-labels', { type: 'geojson', data: fc([]) })
    map.addLayer({ id: 'sel-labels', type: 'symbol', source: 'sel-labels',
      layout: { 'text-field': ['get', 'text'], 'text-font': ['Noto Sans Bold'], 'text-size': ['get', 'size'],
        'text-anchor': ['get', 'anchor'], 'text-offset': ['get', 'offset'], 'text-max-width': 16, 'text-letter-spacing': 0.04,
        'text-allow-overlap': true, 'text-ignore-placement': true },
      paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#040910', 'text-halo-width': 1.8, 'text-halo-blur': 0.4 } })

    // the project being drawn
    map.addLayer({ id: 'draft-line', type: 'line', source: 'draft', filter: isLine as any,
      paint: { 'line-color': ICE, 'line-width': 3, 'line-dasharray': [1, 1] } })
    map.addLayer({ id: 'draft-pts', type: 'circle', source: 'draft', filter: isPoint as any,
      paint: { 'circle-radius': 6, 'circle-color': ICE, 'circle-stroke-color': '#040910', 'circle-stroke-width': 2 } })

    addSatellite(map, 'backdrop')
    // The breathing glow repaints the map, so the map would never go 'idle' while it runs: the loading screen used
    // to sit there until its 8 s timeout. First frame in, then the glow. 2026-09-27.
    let up = false
    const ready = () => {
      if (up) return
      up = true
      $('#loading').classList.add('done')
      requestAnimationFrame(pulse)
      // Build the 3D world in the background once the map is up, so the first switch to 3D doesn't wait.
      if (levels.length) setTimeout(() => preloadWorld(worldTarget(null)!.level), 2500)
    }
    map.once('idle', ready)
    setTimeout(ready, 8000)  // never leave it up on a slow tile server
    applyLayerState()
    applyProjectDim()
    wireMapEvents()
    const hash = new URLSearchParams(location.hash.slice(1))
    if (hash.get('o')) selectOverlap(hash.get('o')!)
    if (hash.get('v') === '3d') setView('3d')   // shareable straight into the 3D world
  })
}

// The selected connector breathes: glow is for live things.
// So do touching points (Tier 1, "must coordinate"): their halo swells and fades on a slower breath.
// Every paint change makes MapLibre redraw, so the breath runs at 30 fps (plenty for a slow swell) and stops while the
// 3D world is on screen, where the map is hidden: no redraws nobody sees. 2026-09-27.
let breathAt = 0
function pulse(now: number) {
  requestAnimationFrame(pulse)
  if (currentView() === '3d' || now - breathAt < 33) return
  breathAt = now
  const t = now / 1000
  if (map.getLayer('conn-sel')) map.setPaintProperty('conn-sel', 'line-opacity', 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2)))
  if (map.getLayer('touch-halo')) {
    const b = 0.5 + 0.5 * Math.sin(t * 2.4)
    map.setPaintProperty('touch-halo', 'circle-radius', 13 + 11 * b)
    map.setPaintProperty('touch-halo', 'circle-opacity', 0.55 - 0.35 * b)
  }
}

function wireMapEvents() {
  const tip = $('#tooltip')
  const show = (html: string, x: number, y: number) => { tip.innerHTML = html; tip.hidden = false; tip.style.left = `${x + 14}px`; tip.style.top = `${y + 14}px` }
  const hide = () => { tip.hidden = true; map.getCanvas().style.cursor = '' }

  for (const layer of ['desc-lines', 'gpc-lines', 'desc-points', 'gpc-points', 'user-lines', 'user-points']) {
    map.on('mousemove', layer, (e) => {
      if (state.drawing) return
      const p = e.features![0].properties as any
      map.getCanvas().style.cursor = 'pointer'
      const head = p.user ? `<div class="u" style="color:${ICE}">YOUR ${esc(UTIL_NAME[p.utility as Utility])} PROJECT</div>`
        : `<div class="u" style="color:${COLOR[p.utility as Utility]}">${UTIL_NAME[p.utility as Utility]}, ${esc(p.id)}</div>`
      show(`${head}${esc(p.name)}`, e.point.x, e.point.y)
    })
    map.on('mouseleave', layer, hide)
    map.on('click', layer, (e) => {
      if (state.drawing) return
      // an overlap drawn on top of the project wins the click (its own handler selects it)
      if (map.queryRenderedFeatures(e.point, { layers: ['connectors', 'touch-hit'] }).length) return
      showProject(String((e.features![0].properties as any).id))
    })
  }
  // Several pairs can meet at one spot (both Thurmond Dam circuits touch the same yard): list them in the tooltip,
  // and let repeated clicks step through them.
  // Both overlap layers at once: a touching point can also be the end of a longer connector.
  const under = (e: { point: { x: number; y: number } }) => {
    const feats = map.queryRenderedFeatures([e.point.x, e.point.y], { layers: ['touch-hit', 'connectors'] })
    const ids = [...new Set(feats.flatMap((f) => (f.properties.ids ? String(f.properties.ids).split(',').filter(Boolean) : [String(f.properties.id)])))]
    return ids.map(findOverlap).filter((o): o is Overlap => !!o).sort(specOrder)
  }
  for (const layer of ['connectors', 'touch-hit']) {
    map.on('mousemove', layer, (e) => {
      if (state.drawing) return
      const os = under(e)
      if (!os.length) return
      map.getCanvas().style.cursor = 'pointer'
      const o = os[0]
      const more = os.length > 1
        ? `<div class="u" style="margin-top:4px">ALSO HERE: ${os.slice(1).map(rankLabel).join(' AND ')}<br>CLICK AGAIN FOR THE NEXT</div>` : ''
      show(`<div class="u" style="color:${HOT}">${o.user ? 'YOURS ' : ''}${rankLabel(o)}, ${TIER_SHORT[o.tier]}</div>${esc(o.why)}${more}`, e.point.x, e.point.y)
    })
    map.on('mouseleave', layer, hide)
    map.on('click', layer, (e) => {
      if (state.drawing || e.defaultPrevented) return
      e.preventDefault()
      const os = under(e)
      if (!os.length) return
      const i = os.findIndex((o) => o.id === state.selected)
      selectOverlap(os[(i + 1) % os.length].id)
    })
  }
  map.on('click', (e) => {
    if (!state.drawing || draft.length >= 2) return
    draft.push([+e.lngLat.lng.toFixed(6), +e.lngLat.lat.toFixed(6)])
    updateDraft()
    renderDrawbar()
    if (draft.length === 2) openNewProjectForm()
  })
}

function refreshMap() {
  if (!map?.getSource('connectors')) return
  const vis = visibleOverlaps()
  ;(map.getSource('connectors') as GeoJSONSource).setData(connectorGeoJSON(vis) as any)
  ;(map.getSource('touch') as GeoJSONSource).setData(touchGeoJSON(vis))
  ;(map.getSource('user-projects') as GeoJSONSource).setData(fc(userFeatures))
  applyProjectDim(vis)
}

// Projects outside every shown overlap step far back (not removed: both utilities' plans stay on the map).
const DIM = 0.24
function applyProjectDim(vis = visibleOverlaps()) {
  if (!map?.getLayer('desc-lines')) return
  const ids = shownProjectIds(vis)
  const shown = (key = 'id'): any => ['in', ['get', key], ['literal', ids]]
  const dim = (normal: any, low = DIM): any => ['case', shown(), normal, low]
  const byConf = (hi: number): any => ['case', ['==', ['get', 'conf'], 'low'], 0.55, hi]
  for (const l of ['desc-lines', 'gpc-lines']) map.setPaintProperty(l, 'line-opacity', dim(byConf(0.95)))
  for (const l of ['desc-points', 'gpc-points']) {
    map.setPaintProperty(l, 'circle-opacity', dim(byConf(1)))
    map.setPaintProperty(l, 'circle-stroke-opacity', dim(1))
  }
  map.setPaintProperty('user-glow', 'line-opacity', dim(0.35, 0.05))
  map.setPaintProperty('user-lines', 'line-opacity', dim(1, 0.3))
  map.setPaintProperty('user-points', 'circle-opacity', dim(1, 0.3))
  map.setPaintProperty('endpoints', 'circle-opacity', ['case', shown('project'), 1, DIM])
  map.setPaintProperty('endpoints', 'circle-stroke-opacity', ['case', shown('project'), 1, DIM])
}

// T4 (< 40 km) pairs are most of the list; keep them faint when zoomed out so the close pairs read first.
// With a selection, everything else steps back.
function connectorOpacity(selectedId: string | null): any {
  const base = (t4: number): any => ['case', ['get', 'concurrent'],
    ['match', ['get', 'tier'], 4, t4, 1], ['match', ['get', 'tier'], 4, t4 * 0.5, 0.6]]
  const byZoom = ['interpolate', ['linear'], ['zoom'], 7, base(0.14), 10, base(0.5)]
  if (!selectedId) return byZoom
  // Selected: the other close pairs stay faintly readable; the fan of < 40 km lines nearly disappears.
  return ['case', ['==', ['get', 'id'], selectedId], 1, ['match', ['get', 'tier'], 4, 0.06, 0.28]]
}

function highlight(ids: string[], connectorId = '') {
  if (!map?.getLayer('sel-glow')) return
  map.setFilter('sel-glow', ['in', ['get', 'id'], ['literal', ids]])
  map.setFilter('conn-sel', ['==', ['get', 'id'], connectorId])
  map.setPaintProperty('connectors', 'line-opacity', connectorOpacity(connectorId || null))
  // Touching points: the selected one gets a ring; with any overlap selected, only it keeps breathing.
  const isSel: any = ['in', `,${connectorId},`, ['get', 'ids']]
  map.setFilter('touch-sel', isSel)
  map.setFilter('touch-halo', connectorId ? isSel : null)
  for (const [l, p] of [['touch-ring', 'circle-stroke-opacity'], ['touch-core', 'circle-opacity']] as const)
    map.setPaintProperty(l, p, connectorId ? ['case', isSel, 1, 0.3] : 1)
  setSelectionLabels(connectorId ? findOverlap(connectorId) ?? null : null)
}

const shortName = (s: string) => {
  const t = s.replace(/^(SAV|GTC|MEAG|DU)\s*:\s*/i, '').replace(/:\s.*$/, '').trim()
  return t.length > 36 ? t.slice(0, 34) + '…' : t
}

// Name both projects and the gap right where they come closest, pushed apart so they don't collide.
function setSelectionLabels(o: Overlap | null) {
  const src = map?.getSource('sel-labels') as GeoJSONSource | undefined
  if (!src) return
  if (!o) { src.setData(fc([])); return }
  const a = byId[o.a].properties, b = byId[o.b].properties
  const [pa, pb] = state.method === 'closest' ? o.closest_points : [centerOf(byId[o.a]), centerOf(byId[o.b])]
  const touching = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 1e-6
  const east = pb[0] >= pa[0]
  const pt = (c: LonLat, props: Record<string, unknown>) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: props })
  const colorOf = (p: ProjectProps) => (p.user ? ICE : COLOR[p.utility])
  const dist = state.method === 'closest' ? (o.tier === 1 ? 'TOUCHING' : `${o.closest_km.toFixed(2)} KM`) : `${o.center_mi.toFixed(1)} MI (CENTERS)`
  src.setData(fc([
    pt([(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2], { text: dist, color: HOT, size: 15, anchor: 'bottom', offset: [0, touching ? -1.2 : -0.8] }),
    // touching: both names to the right of the Tier 1 ring, stacked (the detail card covers the left side)
    pt(pa, { text: shortName(a.name), color: colorOf(a), size: 12, anchor: touching ? 'bottom-left' : east ? 'right' : 'left',
      offset: touching ? [1.5, -0.1] : [east ? -0.9 : 0.9, 0] }),
    pt(pb, { text: shortName(b.name), color: colorOf(b), size: 12, anchor: touching ? 'top-left' : east ? 'left' : 'right',
      offset: touching ? [1.5, 0.1] : [east ? 0.9 : -0.9, 0] }),
  ]))
}

function fitTo(features: Feature[], extra: LonLat[] = []) {
  const b = new LngLatBounds()
  for (const f of features) {
    const cs = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const c of cs) b.extend(c)
  }
  for (const c of extra) b.extend(c)
  // Keep the pair clear of the detail card: it sits on the left on a laptop, at the bottom on a phone.
  const box = map.getContainer().getBoundingClientRect()
  const card = $('#detail').hidden ? null : $('#detail').getBoundingClientRect()
  const pad = { top: 80, right: 60, bottom: 50, left: 60 }  // top: room for the labels above the points
  if (card && window.innerWidth >= 900) pad.left = Math.min(card.right - box.left + 30, box.width * 0.6)
  else if (card) pad.bottom = Math.min(box.bottom - card.top + 20, box.height * 0.6)
  map.fitBounds(b, { padding: pad, maxZoom: 12.5, duration: 1400, pitch: 0, bearing: 0 })   // 2D stays flat and north-up
}

// ------------------------------------------------------------------------------------------------ layers panel
function applyLayerState() {
  for (const g of LAYER_GROUPS) setLayersVisible(map, g.layers, state.layers[g.key])
}

function renderLegend() {
  const rows = LAYER_GROUPS.map((g) => `<label class="row ${state.layers[g.key] ? '' : 'off'}">
      <input type="checkbox" data-layer="${g.key}" ${state.layers[g.key] ? 'checked' : ''}>${g.swatch}<span class="t">${esc(g.label)}</span>
    </label>`).join('')
  $('#legend').classList.toggle('collapsed', state.legendCollapsed)
  $('#legend').innerHTML = `
    <div class="head"><span>LAYERS</span><button data-collapse title="Show or hide the layer list">${state.legendCollapsed ? '+' : '–'}</button></div>
    <div class="body">${rows}<div class="note">Faded: approximate location<br>Dimmed: no overlap in this view</div></div>`
  const L = $('#legend')
  L.querySelector<HTMLButtonElement>('[data-collapse]')!.addEventListener('click', () => { state.legendCollapsed = !state.legendCollapsed; renderLegend() })
  L.querySelectorAll<HTMLInputElement>('input[data-layer]').forEach((inp) => inp.addEventListener('change', () => {
    state.layers[inp.dataset.layer!] = inp.checked
    const g = LAYER_GROUPS.find((x) => x.key === inp.dataset.layer)!
    if (map?.getLayer('backdrop')) setLayersVisible(map, g.layers, inp.checked)
    saveUi(); renderLegend()
  }))
}

// ------------------------------------------------------------------------------------------------ add your own project
function updateDraft() {
  const feats: any[] = draft.map((c) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: {} }))
  if (draft.length === 2) feats.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: draft }, properties: {} })
  ;(map?.getSource('draft') as GeoJSONSource | undefined)?.setData(fc(feats))
}

function renderDrawbar() {
  const bar = $('#drawbar')
  bar.hidden = !state.drawing
  if (!state.drawing) return
  const msg = draft.length === 0 ? 'Click the map where your project starts. For a substation, click once.'
    : draft.length === 1 ? 'Click where the line ends, or finish as a single substation.'
    : 'Now fill in the details.'
  bar.innerHTML = `<span>${msg}</span>
    ${draft.length === 1 ? '<button class="go" data-act="point">SUBSTATION HERE</button>' : ''}
    ${draft.length ? '<button data-act="undo">UNDO</button>' : ''}
    <button data-act="cancel">CANCEL</button>`
  bar.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'cancel') return stopDrawing()
    if (b.dataset.act === 'undo') { draft.pop(); updateDraft(); renderDrawbar(); if (draft.length < 2) $('#detail').hidden = true; return }
    if (b.dataset.act === 'point') openNewProjectForm()
  }))
}

function startDrawing() {
  closeDetail()
  state.drawing = true
  draft = []
  $('.stage').classList.add('drawing')
  updateDraft(); renderDrawbar()
}

function stopDrawing() {
  state.drawing = false
  draft = []
  $('.stage').classList.remove('drawing')
  updateDraft(); renderDrawbar()
  if ($('#detail').querySelector('form.newproj')) $('#detail').hidden = true
}

function openNewProjectForm() {
  renderDrawbar()
  const n = state.user.length + 1
  const card = $('#detail')
  card.hidden = false
  card.innerHTML = `<button class="close" aria-label="Cancel">ESC ✕</button>
    <div class="kicker" style="color:${ICE}">NEW HYPOTHETICAL PROJECT</div>
    <h2>${draft.length > 1 ? 'A new line' : 'A new substation'}: who's building it, and when?</h2>
    <div class="why">GridLock scores it against the other utility's plans with the same rules: closest points, tiers, build windows.</div>
    <form class="newproj" novalidate>
      <label class="wide">NAME <input name="name" maxlength="80" value="My ${draft.length > 1 ? 'line' : 'substation'} ${n}" required></label>
      <div class="wide util">
        <label><input type="radio" name="utility" value="DESC" checked><span class="dot desc"></span>DOMINION ENERGY SC</label>
        <label><input type="radio" name="utility" value="GPC"><span class="dot gpc"></span>GEORGIA POWER</label>
      </div>
      <label>BUILD STARTS <input type="month" name="start" value="2026-01" required></label>
      <label>IN SERVICE <input type="month" name="end" value="2027-06" required></label>
      <label>COST ($M) <input type="number" name="cost" min="0" step="0.1" placeholder="optional"></label>
      <label>VOLTAGE (kV) <input type="number" name="kv" min="1" step="1" placeholder="optional"></label>
      <div class="wide err" hidden></div>
      <div class="wide buttons"><button type="submit">SCORE IT</button><button type="button" data-act="cancel">CANCEL</button></div>
    </form>`
  const form = card.querySelector<HTMLFormElement>('form')!
  card.querySelector('.close')!.addEventListener('click', stopDrawing)
  form.querySelector('[data-act="cancel"]')!.addEventListener('click', stopDrawing)
  form.addEventListener('submit', (e) => {
    e.preventDefault()
    const f = new FormData(form)
    const start = `${f.get('start')}-01`, end = `${f.get('end')}-01`
    const err = form.querySelector<HTMLElement>('.err')!
    const name = String(f.get('name') || '').trim()
    if (!name) { err.hidden = false; err.textContent = 'Give it a name.'; return }
    if (!/^\d{4}-\d{2}-01$/.test(start) || !/^\d{4}-\d{2}-01$/.test(end) || start >= end) {
      err.hidden = false; err.textContent = 'The in-service month has to come after the build start.'; return
    }
    const cost = Number(f.get('cost')), kv = Number(f.get('kv'))
    const p: UserProject = { id: nextUserId(state.user), utility: f.get('utility') === 'GPC' ? 'GPC' : 'DESC', name, coords: [...draft],
      start, end, cost: cost > 0 ? Math.round(cost * 1e6) : null, kv: kv > 0 ? kv : null }
    state.user = [...state.user, p]
    stopDrawing()
    recomputeUserOverlaps()
    rerender()
    showProject(p.id)
  })
  form.querySelector<HTMLInputElement>('input[name="name"]')!.select()
}

function deleteUserProject(id: string) {
  state.user = state.user.filter((p) => p.id !== id)
  recomputeUserOverlaps()
  closeDetail()
  rerender()
}

function renderUserBox() {
  const box = $('#userbox')
  const items = state.user.map((p) => {
    const f = byId[p.id]?.properties
    const n = f?.n_overlaps ?? 0
    const best = f?.best_tier ? `T${f.best_tier}` : 'none'
    return `<li data-id="${p.id}"><span class="dot ${p.utility === 'DESC' ? 'desc' : 'gpc'}"></span><span class="n">${esc(p.name)}</span>
      <span class="m">${n ? `${n} OVERLAP${n === 1 ? '' : 'S'}, BEST ${best}` : 'NO OVERLAPS'}</span>
      <button data-del="${p.id}" title="Delete this project" aria-label="Delete ${esc(p.name)}">✕</button></li>`
  }).join('')
  box.innerHTML = `<div class="headrow"><span class="micro">YOUR PROJECTS</span><button class="chip add" data-add>+ ADD A PROJECT</button></div>
    ${items ? `<ul>${items}</ul>` : `<div class="hint">Draw a what-if line or substation and see what it overlaps.</div>`}`
  box.querySelector('[data-add]')!.addEventListener('click', () => (state.drawing ? stopDrawing() : startDrawing()))
  box.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del]')
    if (del) { e.stopPropagation(); deleteUserProject(del.dataset.del!) } else showProject(li.dataset.id!)
  }))
}

// ------------------------------------------------------------------------------------------------ guided tour
// One button for the pitch: the camera flies to each top opportunity with its numbers on screen.
// (In 3D the same button runs the 3D world's own tour.)
const TOUR_MS = 11000
let tour: { steps: (Overlap | null)[]; i: number; timer: number; paused: boolean } | null = null

function startTour() {
  if (!map?.getLayer('sat')) return
  if (state.drawing) stopDrawing()
  closeDetail()
  // Top 3 in spec order among what the current view shows (like the 3D world's tour), skipping a pair that meets at the
  // same spot as one already shown (the two Thurmond Dam circuits). An empty view falls back to the full ranking.
  const shown = visibleOverlaps().filter((o) => !o.user)
  const top: Overlap[] = []
  for (const o of shown.length ? shown : overlaps) {
    if (top.length === 3) break
    if (!top.some((x) => JSON.stringify(x.closest_points) === JSON.stringify(o.closest_points))) top.push(o)
  }
  const steps: (Overlap | null)[] = [null, ...top]
  if (userOverlaps[0]) steps.push(userOverlaps[0])
  tour = { steps, i: 0, timer: 0, paused: false }
  tourGo(0)
}

function stopTour(restore = true) {
  if (!tour) return
  clearTimeout(tour.timer)
  tour = null
  $('#tourbar').hidden = true
  $('#tour-btn').textContent = '▶ TOUR'
  if (restore) highlight([])
}

// Compass direction from a to b, in degrees (0 = north).
function azimuth(a: LonLat, b: LonLat) {
  return (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI
}

function tourGo(i: number) {
  if (!tour) return
  tour.i = (i + tour.steps.length) % tour.steps.length
  clearTimeout(tour.timer)
  const o = tour.steps[tour.i]
  if (!o) {
    highlight([])
    map.fitBounds([[-82.5, 31.95], [-80.7, 33.85]], { pitch: 0, bearing: 0, duration: 3200, padding: 40 })
  } else {
    highlight([o.a, o.b], o.id)
    const [p, q] = o.closest_points
    const ca = byId[o.a].geometry.coordinates as LonLat[]
    // Look across the gap: the connector runs left to right on screen (or the line, if they touch).
    const touching = Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6
    const az = touching && Array.isArray(ca[0]) ? azimuth(ca[0], ca[ca.length - 1]) : azimuth(p, q)
    // Frame the gap itself (the story), not the whole projects: a box a few km around the closest points.
    const mid: LonLat = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
    const r = Math.max(2.5, o.closest_km * 1.6)
    const dLat = r / 111.32, dLon = r / (111.32 * Math.cos((mid[1] * Math.PI) / 180))
    map.fitBounds([[mid[0] - dLon, mid[1] - dLat], [mid[0] + dLon, mid[1] + dLat]], { pitch: 0, bearing: az - 90, maxZoom: 14,
      duration: 4200, padding: { top: 60, bottom: Math.min(240, window.innerHeight * 0.3), left: 40, right: 40 } })
  }
  renderTourbar()
  if (!tour.paused) tour.timer = window.setTimeout(() => tourGo(tour!.i + 1), TOUR_MS)
}

function renderTourbar() {
  const bar = $('#tourbar')
  if (!tour) { bar.hidden = true; return }
  bar.hidden = false
  $('#tour-btn').textContent = '■ STOP TOUR'
  const n = tour.steps.length, o = tour.steps[tour.i]
  let body: string
  if (!o) {
    body = `<div class="kicker">GUIDED TOUR 1 OF ${n}</div>
      <h3>Two utilities, one river, ${meta.desc_projects + meta.gpc_projects} planned projects</h3>
      <div class="who">Dominion Energy South Carolina and Georgia Power plan their transmission work separately. GridLock found
        <b>${overlaps.length}</b> places where they'll build within 40 km of each other, <b>${overlaps.filter((x) => x.overlap_days > 0).length}</b> of them at the same time.</div>`
  } else {
    const a = byId[o.a].properties, b = byId[o.b].properties
    const { total } = costModel(o)
    body = `<div class="kicker">GUIDED TOUR ${tour.i + 1} OF ${n}, ${o.user ? 'YOUR PROJECT' : 'OPPORTUNITY ' + rankLabel(o)}</div>
      <h3>${esc(o.tier_label)}: ${esc(o.can_share.replace(/^Can share /, 'they can share ').replace(/^Must coordinate/, 'they must coordinate'))}</h3>
      <div class="who"><span class="dot ${dotClass(a)}"></span>${esc(a.name)}<b>×</b><span class="dot ${dotClass(b)}"></span>${esc(b.name)}</div>
      <div class="big">
        <div class="hot"><b>${o.tier === 1 ? 'Touching' : o.closest_km.toFixed(2) + ' km'}</b>APART</div>
        <div><b>${o.overlap_days > 0 ? Math.round(o.overlap_days / 30.44) + ' mo' : gapText(o.window_gap_days)}</b>${o.overlap_days > 0 ? 'BUILDING AT THE SAME TIME' : 'BETWEEN BUILD WINDOWS'}</div>
        <div class="hot"><b>${total > 0 ? '≈ ' + money(total) : 'Reschedule'}</b>${total > 0 ? 'ROUGH SAVINGS' : 'TO SHARE CREWS'}</div>
      </div>`
  }
  bar.innerHTML = `${body}
    <div class="ctrl"><button data-t="prev" aria-label="Previous">◀</button><button data-t="pause">${tour.paused ? '▶ PLAY' : '❚❚ PAUSE'}</button>
      <button data-t="next" aria-label="Next">▶</button>${o ? '<button data-t="details">DETAILS</button>' : ''}<button data-t="exit">✕ EXIT</button>
      <span class="keys"><span>← →</span><span>SPACE</span><span>ESC</span></span></div>
    <div class="progress"><i class="${tour.paused ? '' : 'run'}" style="--dur:${TOUR_MS}ms"></i></div>`
  bar.querySelectorAll<HTMLButtonElement>('[data-t]').forEach((btn) => btn.addEventListener('click', () => tourAction(btn.dataset.t!)))
}

function tourAction(act: string) {
  if (!tour) return
  if (act === 'prev') tourGo(tour.i - 1)
  else if (act === 'next') tourGo(tour.i + 1)
  else if (act === 'exit') stopTour()
  else if (act === 'details') { const o = tour.steps[tour.i]; stopTour(false); if (o) selectOverlap(o.id) }
  else if (act === 'pause') {
    tour.paused = !tour.paused
    clearTimeout(tour.timer)
    if (!tour.paused) tour.timer = window.setTimeout(() => tourGo(tour!.i + 1), TOUR_MS)
    renderTourbar()
  }
}

// ------------------------------------------------------------------------------------------------ side panel
function renderStats() {
  const vis = visibleOverlaps().filter((o) => !o.user)
  const mine = visibleOverlaps().length - vis.length   // your projects' overlaps: counted by the filter chips too
  const concurrent = vis.filter((o) => o.overlap_days > 0).length
  $('#stats').innerHTML = `
    <span><b>${meta.desc_mapped + meta.gpc_mapped}</b>PROJECTS MAPPED</span>
    <span class="hot"><b>${vis.length}</b>OVERLAPS${mine ? ` + ${mine} YOURS` : ''}</span>
    <span><b>${concurrent}</b>SAME BUILD WINDOW</span>
    <span class="hot"><b>${vis.filter((o) => o.tier <= 2).length}</b>SHARE LAND OR TOUCH</span>`
}

// Three views of the spec's two signals. The top row picks the view; the row under it toggles its groups, each
// with its count (counts are the view's base set, so they don't change while you toggle).
function renderFilters() {
  const base = modeBase()
  const chip = (key: string, label: string, n: number, on: boolean, tip: string) =>
    `<button class="chip hotchip ${on && n ? 'on' : ''}" data-sub="${key}" title="${esc(tip)}" ${n ? '' : 'disabled'} aria-pressed="${on}">${label} (${n})</button>`
  let subs = ''
  if (state.mode === 'geo') {
    subs = [1, 2, 3, 4].map((t) => chip(String(t), TIER_WORDS[t], base.filter((o) => o.tier === t).length, state.geoTiers.has(t), TIER_SHARE[t])).join('')
  } else if (state.mode === 'time') {
    subs = BUCKETS.map((b) => chip(b.key, b.label, base.filter((o) => bucketOf(o) === b.key).length, state.timeBuckets.has(b.key), b.tip)).join('')
  } else {
    subs = [1, 2, 3].map((t) => chip(String(t), TIER_WORDS[t], base.filter((o) => o.tier === t).length, state.bothTiers.has(t), TIER_SHARE[t])).join('')
  }
  $('#filters').innerHTML = `
    <div class="modes" role="group" aria-label="Overlap signal">${MODES.map((m) =>
      `<button class="${m.key === state.mode ? 'on' : ''}" data-mode="${m.key}" title="${esc(m.tip)}" aria-pressed="${m.key === state.mode}">${m.label}</button>`).join('')}</div>
    <div class="subs">${subs}</div>
    ${state.mode === 'both' ? '<div class="modehint">Close enough to share, and building at the same time</div>' : ''}`
  $('#filters').querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
    if (state.mode === btn.dataset.mode) return
    state.mode = btn.dataset.mode as Mode
    saveUi(); rerender()
  }))
  $('#filters').querySelectorAll<HTMLButtonElement>('[data-sub]').forEach((btn) => btn.addEventListener('click', () => {
    const k = btn.dataset.sub!
    const toggle = <T,>(s: Set<T>, v: T) => (s.has(v) ? s.delete(v) : s.add(v))
    if (state.mode === 'geo') toggle(state.geoTiers, Number(k))
    else if (state.mode === 'time') toggle(state.timeBuckets, k as Bucket)
    else toggle(state.bothTiers, Number(k))
    saveUi(); rerender()
  }))
}

const gapText = (days: number) => (days < 45 ? 'back to back' : days < 365 ? `${Math.round(days / 30.44)} mo apart` : `${(days / 365.25).toFixed(1)} yr apart`)

function timingText(o: Overlap) {
  if (o.overlap_days > 0) return `windows overlap ${Math.round(o.overlap_days / 30.44)} mo`
  return `windows ${gapText(o.window_gap_days)}`
}

function dotClass(p: ProjectProps) { return p.user ? 'user' : p.utility === 'DESC' ? 'desc' : 'gpc' }

function overlapItem(o: Overlap) {
  const a = byId[o.a].properties, b = byId[o.b].properties
  const dist = state.method === 'closest' ? (o.tier === 1 ? 'touching' : `${o.closest_km.toFixed(1)} km closest`) : `${o.center_mi.toFixed(1)} mi center-to-center`
  return `<li tabindex="0" data-id="${o.id}" class="${o.id === state.selected ? 'sel' : ''}">
    <div class="top"><span class="rank">${rankLabel(o)}</span>${o.user ? '<span class="yours">YOURS</span>' : ''}<span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span>${o.overlap_days > 0 ? '<span class="when">SAME WINDOW</span>' : ''}</div>
    <div class="names"><div><span class="dot ${dotClass(a)}"></span>${esc(a.name)}</div><div><span class="dot ${dotClass(b)}"></span>${esc(b.name)}</div></div>
    <div class="meta">${dist}, ${timingText(o)}${o.needs_location_check ? ', <span class="warn">verify location</span>' : ''}</div>
  </li>`
}

function renderRanked() {
  const list = visibleOverlaps()
  const mine = list.filter((o) => o.user), theirs = list.filter((o) => !o.user)
  const ol = $('#ranked')
  if (!list.length) { ol.innerHTML = `<li class="empty">No overlaps match these filters.</li>`; return }
  ol.innerHTML = (mine.length ? `<li class="listhead">YOUR PROJECTS' OVERLAPS</li>${mine.map(overlapItem).join('')}<li class="listhead">FROM THE UTILITIES' PLANS</li>` : '') +
    theirs.map(overlapItem).join('')
  ol.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => selectOverlap(li.dataset.id!))
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectOverlap(li.dataset.id!) } })
  })
}

function rerender() {
  renderStats(); renderUserBox(); renderFilters(); renderRanked(); renderLegend(); refreshMap()
  setVisible3D(visibleOverlaps().map((o) => o.id))   // the 3D world shows the same overlaps as the list
  if (state.selected && !visibleOverlaps().some((o) => o.id === state.selected)) closeDetail()
  else if (state.selected) setSelectionLabels(findOverlap(state.selected) ?? null)  // e.g. CLOSEST POINTS <-> CENTERS
}

// ------------------------------------------------------------------------------------------------ detail card
function locLine(l: Loc | null) {
  if (!l) return ''
  return `<div class="m" title="${esc(l.method + (l.note ? ' — ' + l.note : ''))}">${esc(l.name)} → ${esc(l.matched || 'located')} <span class="conf ${esc(l.confidence)}">${esc(l.confidence.toUpperCase())}</span></div>`
}

// DESC's 5-year budget as tiny bars: when the money is actually spent is the best evidence of when crews are out.
function budgetBars(b: Record<string, number>, check: string) {
  const cols = ['Previous', '2024', '2025', '2026', '2027', '2028']
  const max = Math.max(...cols.map((c) => b[c] || 0), 1)
  const bars = cols.map((c, i) => {
    const h = Math.round(((b[c] || 0) / max) * 26)
    return `<rect x="${i * 30}" y="${30 - h}" width="22" height="${Math.max(h, 1)}" rx="1" fill="${COLOR.DESC}" opacity="${b[c] ? 0.85 : 0.2}"><title>${c}: ${money(b[c] || 0)}</title></rect>
      <text x="${i * 30 + 11}" y="41" text-anchor="middle" fill="#7286a4" font-size="8" font-family="JetBrains Mono">${c === 'Previous' ? '<24' : "'" + c.slice(2)}</text>`
  }).join('')
  const warn = check.startsWith('source inconsistency') ? `<div class="m" style="color:${HOT}">⚠ ${esc(check)}</div>` : ''
  return `<svg viewBox="0 0 180 44" width="180" height="44" role="img" aria-label="Budget by year">${bars}</svg>${warn}`
}

function projectBlock(p: ProjectProps) {
  const window = exactWindow(p) ? `${ym(p.start)} → ${ym(p.isd)}` : `~${ym(p.start)} → ${ym(p.isd)}*`
  if (p.user) {
    return `<div class="proj user">
      <div class="u" style="color:${ICE}">YOUR ${UTIL_NAME[p.utility]} PROJECT</div>
      <div class="n">${esc(p.name)}</div>
      <div class="m">BUILD ${window}${p.cost ? ', ' + money(p.cost) : ''}${p.kv.length ? ', ' + p.kv[0] + ' kV' : ''}</div>
      <div class="m">Hypothetical, added on this map</div>
    </div>`
  }
  return `<div class="proj ${p.utility === 'DESC' ? 'desc' : 'gpc'}">
    <div class="u" style="color:${COLOR[p.utility]}">${UTIL_NAME[p.utility]}, ${esc(p.source_id)}</div>
    <div class="n">${esc(p.name)}</div>
    <div class="m">BUILD ${window}${p.cost ? ', ' + money(p.cost) : p.utility === 'GPC' ? ', cost redacted' : ''}</div>
    <div class="m">${esc(p.status)}, source page ${p.page}</div>
    ${p.budget ? budgetBars(p.budget, p.budget_check) : ''}
    ${locLine(p.loc_a)}${locLine(p.loc_b)}
    ${p.fix ? `<div class="m">Mapping note: ${esc(p.fix)}</div>` : ''}
    ${p.desc ? `<div class="d">${esc(p.desc.length > 230 ? p.desc.slice(0, 227) + '…' : p.desc)}</div>` : ''}
  </div>`
}

function timelineSVG(o: Overlap) {
  const toX = (iso: string) => new Date(iso + 'T00:00:00').getTime()
  const all = [...o.a_window, ...o.b_window].map(toX)
  const y0 = new Date(new Date(Math.min(...all)).getFullYear(), 0, 1).getTime()
  const y1 = new Date(new Date(Math.max(...all)).getFullYear() + 1, 0, 1).getTime()
  const W = 580, L = 44, R = 10
  const x = (t: number) => L + ((t - y0) / (y1 - y0)) * (W - L - R)
  const years: string[] = []
  const yEnd = new Date(y1).getFullYear()
  for (let y = new Date(y0).getFullYear(); y <= yEnd; y++) {
    const xx = x(new Date(y, 0, 1).getTime())
    // the closing line is the end of the last year, so it gets no label (it was cut off at the edge anyway)
    years.push(`<line x1="${xx}" x2="${xx}" y1="6" y2="64" stroke="rgba(70,105,230,.18)"/>` +
      (y < yEnd ? `<text x="${xx + 3}" y="76" fill="#7286a4" font-size="10" font-family="JetBrains Mono">${y}</text>` : ''))
  }
  const bar = (w: [string, string], y: number, color: string, label: string) =>
    `<text x="0" y="${y + 11}" fill="${color}" font-size="10" font-family="JetBrains Mono">${label}</text>` +
    `<rect x="${x(toX(w[0]))}" y="${y}" width="${Math.max(2, x(toX(w[1])) - x(toX(w[0])))}" height="14" rx="2" fill="${color}" opacity=".85"/>`
  let overlap = ''
  if (o.overlap_days > 0) {
    const s = Math.max(toX(o.a_window[0]), toX(o.b_window[0])), e = Math.min(toX(o.a_window[1]), toX(o.b_window[1]))
    overlap = `<rect x="${x(s)}" y="4" width="${x(e) - x(s)}" height="58" fill="${HOT}" opacity=".16" stroke="${HOT}" stroke-opacity=".6"/>`
  }
  const a = byId[o.a].properties, b = byId[o.b].properties
  return `<svg viewBox="0 0 ${W} 82" role="img" aria-label="Build windows">${years.join('')}${overlap}` +
    `${bar(o.a_window, 14, a.user ? ICE : COLOR.DESC, a.user ? 'YOURS' : 'DESC')}${bar(o.b_window, 38, b.user ? ICE : COLOR.GPC, b.user ? 'YOURS' : 'GPC')}</svg>`
}

// Rough, transparent cost/impact model. GPC's costs are redacted in its public filing, so we anchor on DESC's.
function costModel(o: Overlap) {
  const a = byId[o.a].properties, b = byId[o.b].properties
  const kv = Math.max(...a.kv, ...b.kv, 0)
  const row = state.cost.rowWidthM || (kv >= 230 ? 45 : 30)
  const items: string[] = []
  let total = 0
  const schedulesAlign = o.overlap_days > 0 || o.window_gap_days < 180
  const anchor = a.cost ? a : b.user && b.cost ? b : null  // DESC's published cost, or a cost you typed in
  if (anchor && schedulesAlign) {
    const mob = anchor.cost! * state.cost.mobilizationPct / 100
    total += mob
    items.push(`<b>${money(mob)}</b> one crew and equipment mobilization avoided: ${state.cost.mobilizationPct}% of ${anchor.user ? 'your' : "DESC's published"} ${money(anchor.cost!)}`)
  } else if (!schedulesAlign) {
    items.push(`Build windows are ${gapText(o.window_gap_days).replace(' yr', ' years').replace(' mo', ' months')}, so crews can't be shared as planned. Shifting one schedule is the opportunity.`)
  } else if (a.user) {
    items.push('Add an estimated cost to your project to estimate the crew and equipment savings.')
  }
  if (o.tier <= 2) {
    const km = Math.max(o.shared_corridor_km, o.tier === 1 ? 0.5 : 0)
    const acres = (km * 1000 * row) / 4046.86
    const land = acres * state.cost.easementPerAcre
    total += land
    items.push(`<b>${money(land)}</b> right-of-way: ${km.toFixed(1)} km of shared corridor × ${row} m wide = ${acres.toFixed(0)} acres at ${money(state.cost.easementPerAcre)}/acre`)
  }
  if (o.tier === 1) items.push('Touching projects must also coordinate outages and crossing structures: one planned outage instead of two.')
  return { total, items, row }
}

function renderCost(o: Overlap) {
  const { total, items, row } = costModel(o)
  return `<div class="cost">
    <div>Rough savings if coordinated: <span class="total">${total > 0 ? money(total) : 'schedule-dependent'}</span></div>
    <ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>
    <label>MOBILIZATION % <input type="number" min="0" max="20" step="0.5" value="${state.cost.mobilizationPct}" data-cost="mobilizationPct"></label>
    <label>EASEMENT $/ACRE <input type="number" min="0" step="1000" value="${state.cost.easementPerAcre}" data-cost="easementPerAcre"></label>
    <label>ROW WIDTH m <input type="number" min="10" max="100" step="5" value="${row}" data-cost="rowWidthM"></label>
    <div class="note">Assumptions are editable. Georgia Power's costs are redacted in its public filing, so the estimate uses DESC's published cost only.</div>
  </div>`
}

/** Which 3D level shows this overlap: the pipeline's membership list, or (for your projects) the level box
 *  that contains both closest points. */
function levelFor(o: Overlap) {
  if (levelOf[o.id]) return levelOf[o.id]
  const inside = (l: Level, [lon, lat]: LonLat) => lat >= l.bbox[0] && lon >= l.bbox[1] && lat <= l.bbox[2] && lon <= l.bbox[3]
  const l = levels.find((lv) => o.closest_points.every((c) => inside(lv, c)))
  return l ? { level: l.level, title: l.title } : null
}

function actions3d(o: Overlap) {
  const lv = levels.length ? levelFor(o) : null
  const world = lv ? `<button class="btn3d" data-go3d="fly" title="Switch to 3D, in the ${esc(lv.title)} level">VIEW IN 3D</button>
    <button class="btn3d hotbtn" data-go3d="walk" title="Switch to 3D and drop onto the ground at one end, facing the other">WALK THE GAP</button>`
    : levels.length ? '<span class="m">NOT IN A 3D LEVEL YET</span>' : ''
  return `<div class="actions3d">${world}
    <a class="btn3d" href="${earthUrl(o)}" target="_blank" rel="noopener" title="Google Earth's own 3D view of this spot">GOOGLE EARTH ↗</a>
  </div>`
}

// Google Earth's photoreal 3D, opened at the gap. Just a link: nothing of Google's is stored or drawn here.
function earthUrl(o: Overlap) {
  const [p, q] = o.closest_points
  const d = Math.round(Math.min(60000, Math.max(1800, o.closest_km * 2600)))  // camera distance that frames both ends
  return `https://earth.google.com/web/@${((p[1] + q[1]) / 2).toFixed(5)},${((p[0] + q[0]) / 2).toFixed(5)},0a,${d}d,35y,0h,55t,0r`
}

function renderOverlapDetail(o: Overlap) {
  const a = byId[o.a].properties, b = byId[o.b].properties
  const card = $('#detail')
  card.hidden = false
  card.innerHTML = `<button class="close" aria-label="Close">ESC ✕</button>
    <div class="kicker">${o.user ? 'YOUR ' : ''}COORDINATION OPPORTUNITY ${rankLabel(o)}, ${TIER_SHORT[o.tier]}</div>
    <h2>${esc(o.tier_label)}</h2>
    <div class="why">${esc(o.why)}</div>
    ${actions3d(o)}
    <div class="pair">${projectBlock(a)}${projectBlock(b)}</div>
    <div class="nums">
      <div class="hot"><b>${o.tier === 1 ? '0 km' : o.closest_km.toFixed(2) + ' km'}</b>CLOSEST POINTS (SPEC)</div>
      <div><b>${o.center_mi.toFixed(1)} mi</b>CENTER TO CENTER (GUIDE)</div>
      <div><b>${o.overlap_days > 0 ? Math.round(o.overlap_days / 30.44) + ' mo' : o.window_gap_days < 45 ? 'Back to back' : o.window_gap_days < 365 ? Math.round(o.window_gap_days / 30.44) + ' mo' : (o.window_gap_days / 365.25).toFixed(1) + ' yr'}</b>${o.overlap_days > 0 ? 'SHARED BUILD TIME' : 'GAP BETWEEN WINDOWS'}</div>
      <div><b>${o.score.toFixed(0)}</b>SCORE</div>
    </div>
    <div class="section-title">BUILD WINDOWS</div>
    <div class="timeline">${timelineSVG(o)}</div>
    ${exactWindow(a) ? '' : `<div class="note" style="font-size:11px;color:#7286a4">* DESC publishes an in-service date, not a start date. Window start: ${esc(a.window_basis)}.</div>`}
    <div class="section-title">IMPACT ESTIMATE</div>
    ${renderCost(o)}`
  card.querySelector('.close')!.addEventListener('click', closeDetail)
  card.querySelectorAll<HTMLButtonElement>('[data-go3d]').forEach((b) => b.addEventListener('click', () => setView('3d', b.dataset.go3d === 'walk')))
  card.querySelectorAll<HTMLInputElement>('input[data-cost]').forEach((inp) => inp.addEventListener('change', () => {
    (state.cost as any)[inp.dataset.cost!] = Number(inp.value)
    renderOverlapDetail(o)
  }))
}

// Whatever opens an overlap (the list, a tour stop, DETAILS, a project card, a #o= link from the 3D world) must be able
// to see it: if the saved view hides it, switch to GEOGRAPHIC with its tier on (and to closest points if the centers
// method doesn't flag it), so the card never opens for a pair that has no ring, connector or list row.
function revealOverlap(o: Overlap) {
  if (visibleOverlaps().some((x) => x.id === o.id)) return
  if (state.method === 'center' && !o.user && !o.flagged_by_center_method) {
    state.method = 'closest'
    document.querySelectorAll<HTMLButtonElement>('.method button').forEach((b) => b.classList.toggle('on', b.dataset.method === 'closest'))
  }
  state.mode = 'geo'
  state.geoTiers.add(o.tier)
  saveUi()
  rerender()
}

function selectOverlap(id: string, how: { from3d?: boolean } = {}) {
  const o = findOverlap(id)
  if (!o || !byId[o.a] || !byId[o.b]) return
  if (state.drawing) stopDrawing()
  revealOverlap(o)
  state.selected = id
  writeHash()
  renderRanked()
  $('#ranked').querySelector(`li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  renderOverlapDetail(o)
  highlight([o.a, o.b], o.id)
  // In 3D the map is hidden: the 3D world flies there instead, and the map catches up on the way back to 2D.
  if (currentView() === '3d') { if (!how.from3d) { const t = worldTarget(o); if (t) show3D(t) } }
  else fitTo([byId[o.a], byId[o.b]], o.closest_points)
}

// ------------------------------------------------------------------------------------------------ 2D and 3D, one page
/** Where the 3D world should go: the picked overlap in its level, else the level under the map's center. */
function worldTarget(o: Overlap | null, walk = false): Target | null {
  if (!levels.length) return null
  const lv = o ? levelFor(o) : null
  if (o && lv) {
    const [p, q] = o.closest_points
    return { level: lv.level, center: [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], id: o.id, km: o.closest_km, walk }
  }
  const c = map.getCenter()
  const l = levels.find((x) => c.lat >= x.bbox[0] && c.lng >= x.bbox[1] && c.lat <= x.bbox[2] && c.lng <= x.bbox[3]) ?? levels[0]
  return { level: l.level, center: [(l.bbox[1] + l.bbox[3]) / 2, (l.bbox[0] + l.bbox[2]) / 2], id: null, km: 0 }
}

function setView(v: View, walk = false) {
  if (v === '3d') {
    if (tour) stopTour(false)
    if (state.drawing) stopDrawing()
    const o = state.selected ? findOverlap(state.selected) ?? null : null
    const t = worldTarget(o, walk)
    if (t) show3D(t)
    return
  }
  const o = state.selected ? findOverlap(state.selected) : null
  show2D(o ? () => fitTo([byId[o.a], byId[o.b]], o.closest_points) : undefined)
}

/** The switch, the header and the side panel follow the view. */
function viewChanged(v: View) {
  const sw = $('#viewswitch')
  sw.classList.toggle('is3d', v === '3d')
  sw.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === v)
    b.setAttribute('aria-pressed', String(b.dataset.view === v))
  })
  document.body.classList.toggle('in3d', v === '3d')
  writeHash()
}

/** #o=<overlap>&v=3d: shareable, and a reload lands in the same place and view. */
function writeHash() {
  const h = new URLSearchParams()
  if (state.selected) h.set('o', state.selected)
  if (currentView() === '3d') h.set('v', '3d')
  const s = h.toString()
  history.replaceState(null, '', s ? `#${s}` : location.pathname + location.search)
}

function showProject(pid: string) {
  const f = byId[pid]
  if (!f) return
  const p = f.properties
  const mine = allOverlaps().filter((o) => o.a === pid || o.b === pid).sort(specOrder)
  state.selected = null
  renderRanked()
  const card = $('#detail')
  card.hidden = false
  const kicker = p.user ? `<div class="kicker" style="color:${ICE}">YOUR HYPOTHETICAL PROJECT</div>`
    : `<div class="kicker" style="color:${COLOR[p.utility]}">${UTIL_NAME[p.utility]} PROJECT</div>`
  const other = p.utility === 'DESC' ? 'GEORGIA POWER' : 'DOMINION ENERGY SC'
  card.innerHTML = `<button class="close" aria-label="Close">ESC ✕</button>
    ${kicker}
    <div style="margin-top:8px">${projectBlock(p)}</div>
    ${p.user ? `<div class="actions3d"><button class="btn3d hotbtn" data-del="${p.id}">DELETE THIS PROJECT</button></div>` : ''}
    <div class="section-title">${mine.length ? `${mine.length} OVERLAP${mine.length > 1 ? 'S' : ''} WITH ${other}` : `NO ${other} WORK WITHIN 40 KM`}</div>
    <ol class="ranked">${mine.slice(0, 8).map((o) => {
      const q = byId[o.a === pid ? o.b : o.a].properties
      return `<li data-id="${o.id}"><div class="top"><span class="rank">${rankLabel(o)}</span><span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span>${o.overlap_days > 0 ? '<span class="when">SAME WINDOW</span>' : ''}</div>
        <div class="names"><div><span class="dot ${dotClass(q)}"></span>${esc(q.name)}</div></div>
        <div class="meta">${o.tier === 1 ? 'touching' : o.closest_km.toFixed(1) + ' km'}, ${timingText(o)}</div></li>`
    }).join('')}</ol>`
  card.querySelector('.close')!.addEventListener('click', closeDetail)
  card.querySelector<HTMLButtonElement>('[data-del]')?.addEventListener('click', () => deleteUserProject(p.id))
  card.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => li.addEventListener('click', () => selectOverlap(li.dataset.id!)))
  highlight([pid])
  fitTo([f])
}

function closeDetail() {
  state.selected = null
  writeHash()
  $('#detail').hidden = true
  highlight([])
  renderRanked()
}

// ------------------------------------------------------------------------------------------------ other tabs
function renderQuality() {
  const confCount = (u: Utility) => {
    const c: Record<string, number> = { high: 0, medium: 0, low: 0 }
    projects.filter((f) => f.properties.utility === u).forEach((f) => { c[f.properties.conf] = (c[f.properties.conf] || 0) + 1 })
    return c
  }
  const d = confCount('DESC'), g = confCount('GPC')
  const manual: string[] = []
  const approx: string[] = []
  for (const f of projects) {
    for (const l of [f.properties.loc_a, f.properties.loc_b]) {
      if (!l) continue
      if (l.method.startsWith('manual')) manual.push(`<tr><td>${esc(l.name)}</td><td>${esc(l.method.replace('manual: ', ''))}</td><td>${esc(l.note)}</td></tr>`)
      if (l.confidence === 'low' && f.properties.best_tier) approx.push(`<tr><td>${esc(f.properties.id)}</td><td>${esc(l.name)}</td><td>${esc(l.matched)}</td></tr>`)
    }
  }
  const sample = SPERRY_SAMPLE.map((s) => {
    const o = overlaps.find((x) => x.a === s.a && x.b === s.b)
    return `<tr><td class="mono">${s.id}</td><td>${s.mi.toFixed(2)} mi, ${s.gap} d</td><td>${o ? `${o.center_mi.toFixed(2)} mi, ${o.isd_gap_days} d → <b>${o.tier === 1 ? 'touching' : o.closest_km.toFixed(2) + ' km'}</b> (T${o.tier})` : 'missing'}</td></tr>`
  }).join('')
  // keep "download": the dev server sends .kml with no content type, so without it the browser may just show the XML
  const dl = (f: string, label: string, title = '') =>
    `<a class="btn3d" href="${import.meta.env.BASE_URL}data/${f}" download${title ? ` title="${esc(title)}"` : ''}>${label} ↓</a>`
  $('#tab-quality').innerHTML = `<div class="prose">
    <h3>Download the tables</h3>
    <p>Same columns as Sperry's <span class="mono">Projects_Overlaps.xlsx</span>, so they open next to the starter sample. <b>distance_mi</b> and <b>time_gap (day)</b> keep the starter guide's definitions (center to center, in-service gap). Our closest-point distance, tier, build-window overlap and score come after.</p>
    <div class="actions3d">${dl('overlaps_sperry_format.csv', 'OVERLAP TABLE (CSV)')}${dl('projects_located.csv', 'PROJECT TABLE (CSV)')}${dl('gridlock.kml', 'GOOGLE EARTH FILE (KML)',
      'Google Earth web: Projects, New project, Import KML file from computer. Google Earth Pro: File, Open')}</div>
    <p>The Google Earth file holds every mapped project and all ${overlaps.length} overlaps, with the gap, timing, savings and source pages in each pop-up.</p>
    <h3>Checked against Sperry's answer key</h3>
    <p>All 6 overlaps in Sperry's starter sample are reproduced, and the in-service gaps match to the day. Center distances differ where our points differ from the sample's: we located <b>Hooks</b> and <b>Purrysburg</b>, which the sample leaves blank, and the sample's <b>McIntosh</b> point (its GPC_3 row) sits 657 m west of the substation. OVL_4 differs the most (8.01 mi in the sample, 4.45 mi here). The closest-point rule shows two of these pairs are much closer than their centers suggest.</p>
    <table><tr><th>SAMPLE</th><th>THEIRS (CENTER, GAP)</th><th>OURS</th></tr>${sample}</table>
    <h3>Location confidence</h3>
    <table><tr><th></th><th>HIGH</th><th>MEDIUM</th><th>LOW</th><th>UNMAPPED</th></tr>
      <tr><td>DESC</td><td>${d.high}</td><td>${d.medium}</td><td>${d.low}</td><td>${meta.desc_projects - meta.desc_mapped}</td></tr>
      <tr><td>Georgia Power</td><td>${g.high}</td><td>${g.medium}</td><td>${g.low}</td><td>${meta.gpc_projects - meta.gpc_mapped}</td></tr></table>
    <p><b>High</b>: exact name match to an OpenStreetMap substation. <b>Medium</b>: partial name match, disambiguated, or traced along the power-line network. <b>Low</b>: town or street level (Nominatim), so it is approximate and drawn faded.</p>
    <h3>Manual locations (${manual.length})</h3>
    <table><tr><th>POINT</th><th>SOURCE</th><th>EVIDENCE</th></tr>${manual.join('')}</table>
    <h3>Overlaps that rely on an approximate location (${approx.length})</h3>
    <table><tr><th>PROJECT</th><th>POINT</th><th>APPROXIMATED AS</th></tr>${approx.join('')}</table>
    <h3>Not mapped (${meta.unmapped.length})</h3>
    <table><tr><th>ID</th><th>PROJECT</th></tr>${meta.unmapped.map((u) => `<tr><td class="mono">${esc(u.id)}</td><td>${esc(u.name)}</td></tr>`).join('')}</table>
  </div>`
}

function renderAbout() {
  $('#tab-about').innerHTML = `<div class="prose">
    <h3>What this is</h3>
    <p>Neighboring utilities plan transmission work years ahead, mostly without seeing each other's plans. <b>GridLock</b> reads the public plans of <b>Dominion Energy South Carolina</b> (${meta.desc_projects} projects) and <b>Georgia Power</b> (${meta.gpc_projects} projects), puts every project on the map, and ranks the places where the two could share crews, equipment and land.</p>
    <h3>How overlaps are found</h3>
    <ul>
      <li><b>Distance:</b> between the <b>closest points</b> of the two projects, as the GridLock spec asks. A line can pass right by a substation even when their centers are miles apart. Toggle <span class="mono">CENTERS</span> to compare with the center-to-center method in Sperry's starter guide.</li>
      <li><b>Tiers:</b> touching (≤ 0.25 km, the footprint of a substation), under 1.6 km (share land), under 8 km (share logistics) or under 40 km (share crews). Anything farther is ignored.</li>
      <li><b>Timing:</b> Georgia Power publishes start and need dates. DESC publishes an in-service date plus a 5-year budget, so a DESC window starts in the first year its budget spends money on the project. Every DESC window comes from its budget years; money in the budget's "Previous" column is taken to start in January 2023. 41 of 44 budgets add up to their stated totals; the other 3 don't in the source PDF and are flagged.</li>
      <li><b>Ranking:</b> by distance tier first (touching, then under 1.6, 8 and 40 km), then build timing (the same window first, then the smaller gap), then distance. Each pair also carries a score (65% distance, 35% timing, ×0.85 when a location is approximate), shown for reference only.</li>
      <li><b>Filters:</b> GEOGRAPHIC splits the overlaps by tier, TIMELINE by build timing, and BOTH keeps the pairs that are close enough to share (touching to under 8 km) and building at the same time (or under 6 months apart). Projects outside the shown overlaps dim, but stay on the map.</li>
      <li><b>Your projects:</b> anything you add is scored in your browser with exactly the same rules (checked against the pipeline: the same 78 overlaps, distances within 1 m). It's saved only in this browser and shows up in the 3D world too.</li>
    </ul>
    <h3>Limits</h3>
    <ul>
      <li>Lines are drawn straight between their named end points. Real routes bend.</li>
      <li>OpenStreetMap doesn't name every substation. Locations are labeled by confidence, and manual ones cite their evidence (see Data Quality).</li>
      <li>Georgia Power's plan carries a CEII notice, but this is the redacted public-disclosure version supplied in the challenge package, and its costs are redacted.</li>
    </ul>
    <h3>Sources</h3>
    <ul>${meta.sources.map((s) => `<li>${esc(s.label)} <span style="color:#7286a4">(${esc(s.via)})</span></li>`).join('')}
      <li>Satellite imagery: USGS The National Map (public domain). Elevation: AWS Terrain Tiles. Basemap: OpenFreeMap, OpenMapTiles, © OpenStreetMap contributors.</li></ul>
    <p style="margin-top:18px">Built at ShellHacks 2026 for Sperry Tech's GridLock challenge.</p>
  </div>`
}

function wireChrome() {
  // 2D / 3D: the 3D side only exists when the 3D world was built (world3d/build/levels.json)
  $('#viewswitch').hidden = !levels.length
  $('#viewswitch').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)))
  document.querySelectorAll<HTMLButtonElement>('.method button').forEach((btn) => btn.addEventListener('click', () => {
    state.method = btn.dataset.method as Method
    document.querySelectorAll('.method button').forEach((b) => b.classList.toggle('on', b === btn))
    rerender()
  }))
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn))
    for (const t of ['ranked', 'quality', 'about']) $(`#tab-${t}`).hidden = t !== btn.dataset.tab
  }))
  $('#tour-btn').addEventListener('click', () => (currentView() === '3d' ? tour3D() : tour ? stopTour() : startTour()))
  document.addEventListener('keydown', (e) => {
    const typing = (e.target as HTMLElement)?.closest?.('input, textarea, select')
    if (tour && !typing) {
      if (e.key === 'ArrowRight') { e.preventDefault(); return tourAction('next') }
      if (e.key === 'ArrowLeft') { e.preventDefault(); return tourAction('prev') }
      if (e.key === ' ') { e.preventDefault(); return tourAction('pause') }
      if (e.key === 'Escape') return stopTour()
    }
    if (e.key !== 'Escape') return
    if (state.drawing) stopDrawing(); else closeDetail()
  })
  onUserProjectsChanged(() => { state.user = loadUserProjects(); recomputeUserOverlaps(false); rerender() })
}

// ------------------------------------------------------------------------------------------------ boot
Promise.all([load(), basemapStyle()]).then(([, style]) => {
  initMap(style)
  wireChrome()
  renderQuality()
  renderAbout()
  rerender()
}).catch((err) => {
  document.body.innerHTML = `<pre style="color:#ffd166;padding:20px">Could not load data: ${esc(err)}</pre>`
})
