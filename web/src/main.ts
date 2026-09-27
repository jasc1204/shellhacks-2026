// GridLock: where Dominion Energy South Carolina and Georgia Power plan work close together in space and time.
// Data comes from pipeline/ (see README): projects.geojson, endpoints.geojson, overlaps.json, backdrop.geojson, meta.json.
import { Map as MapLibreMap, NavigationControl, ScaleControl, LngLatBounds, GeoJSONSource, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'
import type { Feature, Level, Loc, LonLat, Meta, Method, Overlap, ProjectProps, Utility } from './types'
import { centerOf, scorePair } from './geo'
import { addMapModes, set3D, setLayersVisible, setSatellite } from './layers'
import { loadUserProjects, nextUserId, onUserProjectsChanged, saveUserState, toFeature, type UserProject } from './userProjects'

// MapLibre v6 finds its worker next to its own bundle, which Vite moves. Serve the worker from public/ instead
// (copied there by `npm run sync-maplibre`) so dev and production builds behave the same.
setWorkerUrl(new URL(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`, location.href).href)

const COLOR: Record<Utility, string> = { DESC: '#4dd8ff', GPC: '#3b7dff' }
const HOT = '#ffd166'
const ICE = '#eef4ff'
const UTIL_NAME: Record<Utility, string> = { DESC: 'DOMINION ENERGY SC', GPC: 'GEORGIA POWER' }
const TIER_SHORT: Record<number, string> = { 1: 'T1 TOUCHING', 2: 'T2 < 1.6 KM', 3: 'T3 < 8 KM', 4: 'T4 < 40 KM' }
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
  { key: 'overlaps', label: 'Overlaps', swatch: `<i style="background:${HOT};box-shadow:0 0 8px ${HOT}"></i>`, layers: ['conn-glow', 'connectors', 'conn-ends', 'conn-sel'] },
  { key: 'grid', label: 'Existing grid (OSM)', swatch: '<i style="background:#27406f"></i>', layers: ['backdrop'] },
  { key: 'ends', label: 'Line end points', swatch: '<i class="dot"></i>', layers: ['endpoints'] },
  { key: 'labels', label: 'Place names', swatch: '<i style="background:#7286a4;height:2px"></i>', layers: [] },
]
const UI_KEY = 'gridlock.ui.v1'

const state = {
  method: 'closest' as Method,
  tiers: new Set([1, 2, 3, 4]),
  concurrentOnly: false,
  selected: null as string | null,
  cost: { mobilizationPct: 3, easementPerAcre: 15000, rowWidthM: 0 },
  satellite: false,
  view3d: false,
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
const WORLD_VIEWER = `${import.meta.env.BASE_URL}world3d/viewer/`
type Clip = { id: string; file: string; poster?: string }
let clips: Record<string, Clip> = {}  // pre-rendered Blender fly-ins by overlap id (public/clips/manifest.json)
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
  overlaps = o
  meta = m
  // The 3D world is optional: without it the map works the same, just without "View in 3D".
  try {
    levels = await fetch(`${import.meta.env.BASE_URL}world3d/build/levels.json`).then((r) => (r.ok ? r.json() : []))
    for (const l of levels) for (const id of l.overlap_ids) levelOf[id] = { level: l.level, title: l.title }
  } catch { levels = []; levelOf = {} }
  // So are the Blender fly-ins: no manifest, no WATCH button. (In dev a missing file comes back as HTML, which json() rejects.)
  try {
    const cm = await fetch(`${import.meta.env.BASE_URL}clips/manifest.json`).then((r) => (r.ok ? r.json() : { clips: [] }))
    for (const c of cm.clips ?? []) clips[c.id] = c
  } catch { clips = {} }
  try { Object.assign(state, pickUi(JSON.parse(localStorage.getItem(UI_KEY) || '{}'))) } catch { /* defaults */ }
  state.user = loadUserProjects()
  recomputeUserOverlaps(false)
}

function pickUi(v: any) {
  const out: Partial<typeof state> = {}
  if (typeof v.satellite === 'boolean') out.satellite = v.satellite
  if (typeof v.view3d === 'boolean') out.view3d = v.view3d
  if (v.layers && typeof v.layers === 'object') out.layers = { ...state.layers, ...v.layers }
  return out
}

function saveUi() {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ satellite: state.satellite, view3d: state.view3d, layers: state.layers })) } catch { /* ignore */ }
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
  out.sort((x, y) => y.score - x.score)
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

function visibleOverlaps(): Overlap[] {
  return allOverlaps().filter((o) =>
    state.tiers.has(o.tier) &&
    (!state.concurrentOnly || o.overlap_days > 0) &&
    (state.method === 'closest' || o.flagged_by_center_method))
}

function connectorGeoJSON(list: Overlap[]) {
  return {
    type: 'FeatureCollection',
    features: list.map((o) => ({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: state.method === 'closest' ? o.closest_points : [centerOf(byId[o.a]), centerOf(byId[o.b])],
      },
      properties: { id: o.id, tier: o.tier, rank: o.rank, concurrent: o.overlap_days > 0, user: !!o.user },
    })),
  }
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
  return style
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

  // 'style.load', not 'load': 'load' waits for every basemap tile, and our layers don't need them.
  map.once('style.load', () => {
    LAYER_GROUPS.find((g) => g.key === 'labels')!.layers = map.getStyle().layers.filter((l) => l.type === 'symbol').map((l) => l.id)
    const utilColor: any = ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC]
    map.addSource('backdrop', { type: 'geojson', data: backdropData })
    map.addSource('projects', { type: 'geojson', data: fc(projects) })
    map.addSource('user-projects', { type: 'geojson', data: fc(userFeatures) })
    map.addSource('endpoints', { type: 'geojson', data: endpointsData })
    map.addSource('connectors', { type: 'geojson', data: connectorGeoJSON(visibleOverlaps()) as any })
    map.addSource('draft', { type: 'geojson', data: fc([]) })

    map.addLayer({ id: 'backdrop', type: 'line', source: 'backdrop',
      paint: { 'line-color': '#27406f', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['get', 'kv'], 46, 0.6, 230, 1.2, 500, 1.8] } })

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

    addMapModes(map, 'backdrop')
    map.once('idle', () => $('#loading').classList.add('done'))
    setTimeout(() => $('#loading').classList.add('done'), 8000)  // never leave it up on a slow tile server
    applyLayerState()
    if (state.satellite) setSatellite(map, true)
    if (state.view3d) set3D(map, true)
    wireMapEvents()
    pulse()
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('o')
    if (fromHash) selectOverlap(fromHash)
  })
}

// The selected connector breathes: glow is for live things.
function pulse() {
  const t = performance.now() / 1000
  if (map.getLayer('conn-sel')) map.setPaintProperty('conn-sel', 'line-opacity', 0.55 + 0.45 * Math.abs(Math.sin(t * 2.2)))
  requestAnimationFrame(pulse)
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
    map.on('click', layer, (e) => { if (!state.drawing) showProject(String((e.features![0].properties as any).id)) })
  }
  map.on('mousemove', 'connectors', (e) => {
    if (state.drawing) return
    const o = findOverlap(String((e.features![0].properties as any).id))
    if (!o) return
    map.getCanvas().style.cursor = 'pointer'
    show(`<div class="u" style="color:${HOT}">${o.user ? 'YOURS ' : ''}${rankLabel(o)}, ${TIER_SHORT[o.tier]}</div>${esc(o.why)}`, e.point.x, e.point.y)
  })
  map.on('mouseleave', 'connectors', hide)
  map.on('click', 'connectors', (e) => { if (!state.drawing) { e.preventDefault(); selectOverlap(String((e.features![0].properties as any).id)) } })
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
  ;(map.getSource('connectors') as GeoJSONSource).setData(connectorGeoJSON(visibleOverlaps()) as any)
  ;(map.getSource('user-projects') as GeoJSONSource).setData(fc(userFeatures))
}

// T4 (< 40 km) pairs are most of the list; keep them faint when zoomed out so the close pairs read first.
// With a selection, everything else steps back.
function connectorOpacity(selectedId: string | null): any {
  const base = (t4: number): any => ['case', ['get', 'concurrent'],
    ['match', ['get', 'tier'], 4, t4, 1], ['match', ['get', 'tier'], 4, t4 * 0.5, 0.6]]
  const byZoom = ['interpolate', ['linear'], ['zoom'], 7, base(0.14), 10, base(0.5)]
  if (!selectedId) return byZoom
  return ['interpolate', ['linear'], ['zoom'], 7, ['case', ['==', ['get', 'id'], selectedId], 1, 0.08], 10, ['case', ['==', ['get', 'id'], selectedId], 1, 0.18]]
}

function highlight(ids: string[], connectorId = '') {
  if (!map?.getLayer('sel-glow')) return
  map.setFilter('sel-glow', ['in', ['get', 'id'], ['literal', ids]])
  map.setFilter('conn-sel', ['==', ['get', 'id'], connectorId])
  map.setPaintProperty('connectors', 'line-opacity', connectorOpacity(connectorId || null))
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
    pt(pa, { text: shortName(a.name), color: colorOf(a), size: 12, anchor: touching ? 'right' : east ? 'right' : 'left',
      offset: touching ? [-1.1, 0.2] : [east ? -0.9 : 0.9, 0] }),
    pt(pb, { text: shortName(b.name), color: colorOf(b), size: 12, anchor: touching ? 'top-left' : east ? 'left' : 'right',
      offset: touching ? [0.7, 1.0] : [east ? 0.9 : -0.9, 0] }),
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
  map.fitBounds(b, { padding: pad, maxZoom: 12.5, duration: 1400, pitch: state.view3d ? 62 : 0 })
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
    <div class="seg"><button data-base="map" class="${state.satellite ? '' : 'on'}">MAP</button><button data-base="sat" class="${state.satellite ? 'on' : ''}" title="USGS aerial imagery">SATELLITE</button></div>
    <div class="seg"><button data-view="2d" class="${state.view3d ? '' : 'on'}">2D</button><button data-view="3d" class="${state.view3d ? 'on' : ''}" title="Terrain (x4 height) and 3D buildings">3D TERRAIN</button></div>
    <div class="head"><span>LAYERS</span><button data-collapse title="Show or hide the layer list">${state.legendCollapsed ? '+' : '–'}</button></div>
    <div class="body">${rows}<div class="note">Faded = approximate location<br>Overlaps by ${state.method === 'closest' ? 'closest points' : 'centers'}</div></div>`
  const L = $('#legend')
  L.querySelectorAll<HTMLButtonElement>('[data-base]').forEach((b) => b.addEventListener('click', () => {
    state.satellite = b.dataset.base === 'sat'
    if (map?.getLayer('sat')) setSatellite(map, state.satellite)
    saveUi(); renderLegend()
  }))
  L.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => {
    const want = b.dataset.view === '3d'
    if (want === state.view3d) return
    state.view3d = want
    if (map?.getSource('dem')) set3D(map, want)
    saveUi(); renderLegend()
  }))
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
    ${items ? `<ul>${items}</ul>` : `<div class="hint">What if a utility builds somewhere new? Draw a line or drop a substation, and GridLock scores it against the other utility's plans.</div>`}`
  box.querySelector('[data-add]')!.addEventListener('click', () => (state.drawing ? stopDrawing() : startDrawing()))
  box.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    const del = (e.target as HTMLElement).closest<HTMLElement>('[data-del]')
    if (del) { e.stopPropagation(); deleteUserProject(del.dataset.del!) } else showProject(li.dataset.id!)
  }))
}

// ------------------------------------------------------------------------------------------------ guided tour
// One button for the pitch: satellite + 3D, then the camera flies to each top opportunity with its numbers on screen.
const TOUR_MS = 11000
let tour: { steps: (Overlap | null)[]; i: number; timer: number; paused: boolean; saved: { satellite: boolean; view3d: boolean } } | null = null

function startTour() {
  if (!map?.getSource('dem')) return
  if (state.drawing) stopDrawing()
  closeDetail()
  const steps: (Overlap | null)[] = [null, ...overlaps.slice(0, 3)]
  if (userOverlaps[0]) steps.push(userOverlaps[0])
  tour = { steps, i: 0, timer: 0, paused: false, saved: { satellite: state.satellite, view3d: state.view3d } }
  if (!state.satellite) { state.satellite = true; setSatellite(map, true) }
  if (!state.view3d) { state.view3d = true; set3D(map, true) }
  renderLegend()
  tourGo(0)
}

function stopTour(restore = true) {
  if (!tour) return
  clearTimeout(tour.timer)
  const { saved } = tour
  tour = null
  $('#tourbar').hidden = true
  $('#tour-btn').textContent = '▶ TOUR'
  if (restore) {
    if (state.satellite !== saved.satellite) { state.satellite = saved.satellite; setSatellite(map, saved.satellite) }
    if (state.view3d !== saved.view3d) { state.view3d = saved.view3d; set3D(map, saved.view3d) }
    highlight([])
  }
  renderLegend()
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
    map.fitBounds([[-82.5, 31.95], [-80.7, 33.85]], { pitch: 55, bearing: -12, duration: 3200, padding: 40 })
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
    map.fitBounds([[mid[0] - dLon, mid[1] - dLat], [mid[0] + dLon, mid[1] + dLat]], { pitch: 62, bearing: az - 90, maxZoom: 14,
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
  const concurrent = vis.filter((o) => o.overlap_days > 0).length
  $('#stats').innerHTML = `
    <span><b>${meta.desc_mapped + meta.gpc_mapped}</b>PROJECTS MAPPED</span>
    <span class="hot"><b>${vis.length}</b>OVERLAPS</span>
    <span><b>${concurrent}</b>SAME BUILD WINDOW</span>
    <span class="hot"><b>${vis.filter((o) => o.tier <= 2).length}</b>SHARE LAND OR TOUCH</span>`
}

function renderFilters() {
  const counts = [1, 2, 3, 4].map((t) => overlaps.filter((o) => o.tier === t && (state.method === 'closest' || o.flagged_by_center_method)).length)
  $('#filters').innerHTML =
    [1, 2, 3, 4].map((t, i) => `<button class="chip hotchip ${state.tiers.has(t) ? 'on' : ''}" data-tier="${t}">${TIER_SHORT[t]} (${counts[i]})</button>`).join('') +
    `<button class="chip ${state.concurrentOnly ? 'on' : ''}" data-concurrent="1" title="Only pairs whose build windows overlap">SAME WINDOW ONLY</button>`
  $('#filters').querySelectorAll<HTMLButtonElement>('button').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.tier) {
      const t = Number(btn.dataset.tier)
      state.tiers.has(t) ? state.tiers.delete(t) : state.tiers.add(t)
    } else state.concurrentOnly = !state.concurrentOnly
    rerender()
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
    <div class="top"><span class="rank">${rankLabel(o)}</span>${o.user ? '<span class="yours">YOURS</span>' : ''}<span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span><span class="score">${o.score.toFixed(0)}</span></div>
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
  const url = lv ? `${WORLD_VIEWER}?level=${encodeURIComponent(lv.level)}&select=${encodeURIComponent(o.id)}` : ''
  const world = lv ? `<a class="btn3d" href="${url}" title="Opens the ${esc(lv.title)} level of the 3D world">VIEW IN 3D ↗</a>
    <a class="btn3d hotbtn" href="${url}&walk=1" title="Drop onto the ground at one end, facing the other">WALK THE GAP ↗</a>`
    : levels.length ? '<span class="m">NOT IN A 3D LEVEL YET</span>' : ''
  const clip = clips[o.id] ? '<button class="btn3d" data-watch title="A short fly-in over this gap, rendered in Blender">▶ WATCH FLY-IN</button>' : ''
  return `<div class="actions3d">${world}${clip}
    <a class="btn3d" href="${earthUrl(o)}" target="_blank" rel="noopener" title="Google Earth's own 3D view of this spot">GOOGLE EARTH ↗</a>
  </div>`
}

// Google Earth's photoreal 3D, opened at the gap. Just a link: nothing of Google's is stored or drawn here.
function earthUrl(o: Overlap) {
  const [p, q] = o.closest_points
  const d = Math.round(Math.min(60000, Math.max(1800, o.closest_km * 2600)))  // camera distance that frames both ends
  return `https://earth.google.com/web/@${((p[1] + q[1]) / 2).toFixed(5)},${((p[0] + q[0]) / 2).toFixed(5)},0a,${d}d,35y,0h,55t,0r`
}

// A pre-rendered Blender fly-in (our own world: USGS imagery + OpenStreetMap, no Google data), played over the map.
function openClip(o: Overlap) {
  const c = clips[o.id]
  if (!c) return
  const base = `${import.meta.env.BASE_URL}clips/`
  const a = byId[o.a].properties, b = byId[o.b].properties
  const box = document.createElement('div')
  box.className = 'clipmodal'
  box.innerHTML = `<div class="clipbox" role="dialog" aria-label="Fly-in video">
      <button class="close" aria-label="Close">ESC ✕</button>
      <div class="kicker">COORDINATION OPPORTUNITY ${rankLabel(o)}, ${TIER_SHORT[o.tier]}</div>
      <video src="${base}${esc(c.file)}"${c.poster ? ` poster="${base}${esc(c.poster)}"` : ''} autoplay muted playsinline controls></video>
      <div class="cap"><span class="dot ${dotClass(a)}"></span>${esc(a.name)}<b>×</b><span class="dot ${dotClass(b)}"></span>${esc(b.name)}</div>
      <div class="meta">${o.tier === 1 ? 'Touching' : o.closest_km.toFixed(2) + ' km apart'}, ${timingText(o)}</div>
      <div class="credit">Rendered in Blender from USGS imagery and OpenStreetMap data (© OpenStreetMap contributors)</div>
    </div>`
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close() } }
  const close = () => { box.remove(); removeEventListener('keydown', onKey, true) }
  box.addEventListener('click', (e) => { if (e.target === box) close() })
  box.querySelector('.close')!.addEventListener('click', close)
  addEventListener('keydown', onKey, true)  // capture: Esc closes the video, not the card under it
  document.body.append(box)
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
  card.querySelector('[data-watch]')?.addEventListener('click', () => openClip(o))
  card.querySelectorAll<HTMLInputElement>('input[data-cost]').forEach((inp) => inp.addEventListener('change', () => {
    (state.cost as any)[inp.dataset.cost!] = Number(inp.value)
    renderOverlapDetail(o)
  }))
}

function selectOverlap(id: string) {
  const o = findOverlap(id)
  if (!o || !byId[o.a] || !byId[o.b]) return
  if (state.drawing) stopDrawing()
  state.selected = id
  history.replaceState(null, '', `#o=${encodeURIComponent(id)}`)  // shareable, and the 3D viewer links back here
  renderRanked()
  $('#ranked').querySelector(`li[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' })
  renderOverlapDetail(o)
  highlight([o.a, o.b], o.id)
  fitTo([byId[o.a], byId[o.b]], o.closest_points)
}

function showProject(pid: string) {
  const f = byId[pid]
  if (!f) return
  const p = f.properties
  const mine = allOverlaps().filter((o) => o.a === pid || o.b === pid).sort((x, y) => y.score - x.score)
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
      return `<li data-id="${o.id}"><div class="top"><span class="rank">${rankLabel(o)}</span><span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span><span class="score">${o.score.toFixed(0)}</span></div>
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
  if (location.hash) history.replaceState(null, '', location.pathname + location.search)
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
    <p>All 6 overlaps in Sperry's starter sample are reproduced. In-service gaps match to the day. Center distances differ slightly because we also located <b>Hooks</b> and <b>Purrysburg</b>, which the sample leaves blank. The closest-point rule shows two of those pairs are much closer than their centers suggest.</p>
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
      <li><b>Timing:</b> Georgia Power publishes start and need dates. DESC publishes an in-service date plus a 5-year budget, so a DESC window starts in the first year its budget spends money on the project. 41 of 44 budgets add up to their stated totals; the other 3 don't in the source PDF and are flagged. If a project has no budget, the window is assumed: 24 months for new construction, 18 for rebuilds, 12 for other work.</li>
      <li><b>Score:</b> 65% distance, 35% timing, ×0.85 when a location is approximate.</li>
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
  if (levels.length) {
    const link = $<HTMLAnchorElement>('#world-link')
    link.href = `${WORLD_VIEWER}?level=savannah`
    link.hidden = false
  }
  document.querySelectorAll<HTMLButtonElement>('.method button').forEach((btn) => btn.addEventListener('click', () => {
    state.method = btn.dataset.method as Method
    document.querySelectorAll('.method button').forEach((b) => b.classList.toggle('on', b === btn))
    rerender()
  }))
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn))
    for (const t of ['ranked', 'quality', 'about']) $(`#tab-${t}`).hidden = t !== btn.dataset.tab
  }))
  $('#tour-btn').addEventListener('click', () => (tour ? stopTour() : startTour()))
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
