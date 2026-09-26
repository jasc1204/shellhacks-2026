// GridLock: where Dominion Energy South Carolina and Georgia Power plan work close together in space and time.
// Data comes from pipeline/ (see README): projects.geojson, endpoints.geojson, overlaps.json, backdrop.geojson, meta.json.
import { Map as MapLibreMap, NavigationControl, ScaleControl, LngLatBounds, GeoJSONSource, setWorkerUrl } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import './style.css'

// MapLibre v6 finds its worker next to its own bundle, which Vite moves. Serve the worker from public/ instead
// (copied there by `npm run sync-maplibre`) so dev and production builds behave the same.
setWorkerUrl(new URL(`${import.meta.env.BASE_URL}maplibre/maplibre-gl-worker.mjs`, location.href).href)

type Utility = 'DESC' | 'GPC'
type Method = 'closest' | 'center'

interface Loc { name: string; matched: string; method: string; confidence: string; note: string }
interface ProjectProps {
  id: string; utility: Utility; name: string; a: string; b: string; kv: number[]; status: string
  start: string; isd: string; window_basis: string; cost: number | null; desc: string; source_id: string
  doc: string; page: number; conf: string; loc_a: Loc | null; loc_b: Loc | null; fix: string
  n_overlaps: number; best_tier: number | null; length_km: number | null
  budget: Record<string, number> | null; budget_check: string
}
interface Feature { type: 'Feature'; geometry: { type: 'LineString' | 'Point'; coordinates: any }; properties: ProjectProps }
interface Overlap {
  id: string; rank: number; a: string; b: string; a_name: string; b_name: string
  closest_km: number; closest_points: [number, number][]; lines_cross: boolean
  center_km: number; center_mi: number; flagged_by_center_method: boolean
  tier: number; tier_label: string; can_share: string
  a_window: [string, string]; b_window: [string, string]; overlap_days: number; window_gap_days: number; isd_gap_days: number
  shared_corridor_km: number; geo_score: number; time_score: number; score: number; needs_location_check: boolean; why: string
}
interface Meta {
  desc_projects: number; gpc_projects: number; desc_mapped: number; gpc_mapped: number; pairs_flagged: number
  by_tier: Record<string, number>; caught_only_by_closest_points: string[]
  unmapped: { id: string; utility: Utility; name: string; a: string; b: string; isd: string; page: number }[]
  sources: { label: string; via: string }[]
}

const COLOR: Record<Utility, string> = { DESC: '#4dd8ff', GPC: '#3b7dff' }
const HOT = '#ffd166'
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

const state = {
  method: 'closest' as Method,
  tiers: new Set([1, 2, 3, 4]),
  concurrentOnly: false,
  selected: null as string | null,
  cost: { mobilizationPct: 3, easementPerAcre: 15000, rowWidthM: 0 },
}

let map: MapLibreMap
let projects: Feature[] = []
let byId: Record<string, Feature> = {}
let overlaps: Overlap[] = []
let meta: Meta

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
const money = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3)}K` : `$${Math.round(n)}`)
const ym = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', year: 'numeric' })

// ------------------------------------------------------------------------------------------------ data
async function load() {
  const get = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => r.json())
  const [p, o, m] = await Promise.all([get('projects.geojson'), get('overlaps.json'), get('meta.json')])
  projects = p.features
  byId = Object.fromEntries(projects.map((f) => [f.properties.id, f]))
  overlaps = o
  meta = m
}

function centerOf(f: Feature): [number, number] {
  if (f.geometry.type === 'Point') return f.geometry.coordinates
  const c = f.geometry.coordinates as [number, number][]
  return [(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2]
}

function visibleOverlaps(): Overlap[] {
  return overlaps.filter((o) =>
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
      properties: { id: o.id, tier: o.tier, rank: o.rank, concurrent: o.overlap_days > 0 },
    })),
  }
}

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
    attributionControl: { compact: true },
  })
  map.addControl(new NavigationControl({ showCompass: true, visualizePitch: true }), 'top-right')
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')
  map.on('error', (e) => console.error('map error:', e.error?.message ?? e))
  if (import.meta.env.DEV) (window as any).__map = map

  map.on('load', async () => {
    const backdrop = await fetch(`${import.meta.env.BASE_URL}data/backdrop.geojson`).then((r) => r.json())
    const endpoints = await fetch(`${import.meta.env.BASE_URL}data/endpoints.geojson`).then((r) => r.json())
    map.addSource('backdrop', { type: 'geojson', data: backdrop })
    map.addSource('projects', { type: 'geojson', data: { type: 'FeatureCollection', features: projects } as any })
    map.addSource('endpoints', { type: 'geojson', data: endpoints })
    map.addSource('connectors', { type: 'geojson', data: connectorGeoJSON(visibleOverlaps()) as any })

    map.addLayer({ id: 'backdrop', type: 'line', source: 'backdrop',
      paint: { 'line-color': '#27406f', 'line-opacity': 0.55, 'line-width': ['interpolate', ['linear'], ['get', 'kv'], 46, 0.6, 230, 1.2, 500, 1.8] } })

    // selection glow sits under everything it highlights
    map.addLayer({ id: 'sel-glow', type: 'line', source: 'projects', filter: ['in', ['get', 'id'], ['literal', []]],
      paint: { 'line-color': ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC], 'line-width': 12, 'line-blur': 8, 'line-opacity': 0.6 } })

    map.addLayer({ id: 'gpc-lines', type: 'line', source: 'projects', filter: ['all', ['==', ['get', 'utility'], 'GPC'], ['==', ['geometry-type'], 'LineString']],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': COLOR.GPC, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.6, 11, 3.2], 'line-dasharray': [2, 1.2],
        'line-opacity': ['case', ['==', ['get', 'conf'], 'low'], 0.55, 0.95] } })
    map.addLayer({ id: 'desc-lines', type: 'line', source: 'projects', filter: ['all', ['==', ['get', 'utility'], 'DESC'], ['==', ['geometry-type'], 'LineString']],
      layout: { 'line-cap': 'round' },
      paint: { 'line-color': COLOR.DESC, 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 1.8, 11, 3.6],
        'line-opacity': ['case', ['==', ['get', 'conf'], 'low'], 0.55, 0.95] } })
    map.addLayer({ id: 'proj-points', type: 'circle', source: 'projects', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3.5, 11, 7], 'circle-color': ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC],
        'circle-stroke-color': '#040910', 'circle-stroke-width': 1.5 } })
    map.addLayer({ id: 'endpoints', type: 'circle', source: 'endpoints', minzoom: 8,
      paint: { 'circle-radius': 3, 'circle-color': ['case', ['==', ['get', 'confidence'], 'low'], 'rgba(0,0,0,0)', ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC]],
        'circle-stroke-width': 1.2, 'circle-stroke-color': ['match', ['get', 'utility'], 'DESC', COLOR.DESC, COLOR.GPC] } })

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

    wireMapEvents()
    pulse()
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

  for (const layer of ['desc-lines', 'gpc-lines', 'proj-points']) {
    map.on('mousemove', layer, (e) => {
      const p = e.features![0].properties as any
      map.getCanvas().style.cursor = 'pointer'
      show(`<div class="u" style="color:${COLOR[p.utility as Utility]}">${UTIL_NAME[p.utility as Utility]} · ${esc(p.id)}</div>${esc(p.name)}`, e.point.x, e.point.y)
    })
    map.on('mouseleave', layer, hide)
    map.on('click', layer, (e) => showProject(String((e.features![0].properties as any).id)))
  }
  map.on('mousemove', 'connectors', (e) => {
    const o = overlaps.find((x) => x.id === (e.features![0].properties as any).id)!
    map.getCanvas().style.cursor = 'pointer'
    show(`<div class="u" style="color:${HOT}">#${o.rank} · ${TIER_SHORT[o.tier]}</div>${esc(o.why)}`, e.point.x, e.point.y)
  })
  map.on('mouseleave', 'connectors', hide)
  map.on('click', 'connectors', (e) => { e.preventDefault(); selectOverlap(String((e.features![0].properties as any).id)) })
}

function refreshMap() {
  const src = map.getSource('connectors') as GeoJSONSource | undefined
  src?.setData(connectorGeoJSON(visibleOverlaps()) as any)
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
  if (!map.getLayer('sel-glow')) return
  map.setFilter('sel-glow', ['in', ['get', 'id'], ['literal', ids]])
  map.setFilter('conn-sel', ['==', ['get', 'id'], connectorId])
  map.setPaintProperty('connectors', 'line-opacity', connectorOpacity(connectorId || null))
}

function fitTo(features: Feature[], extra: [number, number][] = []) {
  const b = new LngLatBounds()
  for (const f of features) {
    const cs = f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates
    for (const c of cs) b.extend(c)
  }
  for (const c of extra) b.extend(c)
  const detailW = Math.min(620, window.innerWidth - 28)
  map.fitBounds(b, { padding: { top: 80, right: 80, bottom: 80, left: 80 }, maxZoom: 12.5, duration: 1400,
    offset: [detailW / 4, -60] })
}

// ------------------------------------------------------------------------------------------------ side panel
function renderStats() {
  const vis = visibleOverlaps()
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
    [1, 2, 3, 4].map((t, i) => `<button class="chip hotchip ${state.tiers.has(t) ? 'on' : ''}" data-tier="${t}">${TIER_SHORT[t]} · ${counts[i]}</button>`).join('') +
    `<button class="chip ${state.concurrentOnly ? 'on' : ''}" data-concurrent="1" title="Only pairs whose build windows overlap">SAME WINDOW ONLY</button>`
  $('#filters').querySelectorAll<HTMLButtonElement>('button').forEach((btn) => btn.addEventListener('click', () => {
    if (btn.dataset.tier) {
      const t = Number(btn.dataset.tier)
      state.tiers.has(t) ? state.tiers.delete(t) : state.tiers.add(t)
    } else state.concurrentOnly = !state.concurrentOnly
    rerender()
  }))
}

function timingText(o: Overlap) {
  if (o.overlap_days > 0) return `windows overlap ${Math.round(o.overlap_days / 30.44)} mo`
  return `windows ${(o.window_gap_days / 365.25).toFixed(1)} yr apart`
}

function renderRanked() {
  const list = visibleOverlaps()
  const ol = $('#ranked')
  if (!list.length) { ol.innerHTML = `<li class="empty">No overlaps match these filters.</li>`; return }
  ol.innerHTML = list.map((o) => {
    const a = byId[o.a].properties, b = byId[o.b].properties
    const dist = state.method === 'closest' ? (o.tier === 1 ? 'touching' : `${o.closest_km.toFixed(1)} km closest`) : `${o.center_mi.toFixed(1)} mi center-to-center`
    return `<li tabindex="0" data-id="${o.id}" class="${o.id === state.selected ? 'sel' : ''}">
      <div class="top"><span class="rank">#${o.rank}</span><span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span><span class="score">${o.score.toFixed(0)}</span></div>
      <div class="names"><div><span class="dot desc"></span>${esc(a.name)}</div><div><span class="dot gpc"></span>${esc(b.name)}</div></div>
      <div class="meta">${dist} · ${timingText(o)}${o.needs_location_check ? ' · <span class="warn">verify location</span>' : ''}</div>
    </li>`
  }).join('')
  ol.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => {
    li.addEventListener('click', () => selectOverlap(li.dataset.id!))
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectOverlap(li.dataset.id!) } })
  })
}

function renderLegend() {
  $('#legend').innerHTML = `
    <div class="row"><i style="background:${COLOR.DESC}"></i><span class="t">Dominion Energy SC</span></div>
    <div class="row"><i class="dash"></i><span class="t">Georgia Power</span></div>
    <div class="row"><i style="background:${HOT};box-shadow:0 0 8px ${HOT}"></i><span class="t">Overlap</span>&nbsp;(${state.method === 'closest' ? 'closest points' : 'centers'})</div>
    <div class="row"><i style="background:#27406f"></i>Existing lines (OSM)</div>
    <div class="row" style="margin-top:4px">Faded = approximate location</div>`
}

function rerender() {
  renderStats(); renderFilters(); renderRanked(); renderLegend(); refreshMap()
  if (state.selected && !visibleOverlaps().some((o) => o.id === state.selected)) closeDetail()
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
  const util = p.utility === 'DESC' ? 'desc' : 'gpc'
  const window = p.window_basis.startsWith('published') ? `${ym(p.start)} → ${ym(p.isd)}` : `~${ym(p.start)} → ${ym(p.isd)}*`
  return `<div class="proj ${util}">
    <div class="u" style="color:${COLOR[p.utility]}">${UTIL_NAME[p.utility]} · ${esc(p.source_id)}</div>
    <div class="n">${esc(p.name)}</div>
    <div class="m">BUILD ${window}${p.cost ? ' · ' + money(p.cost) : p.utility === 'GPC' ? ' · cost redacted' : ''}</div>
    <div class="m">${esc(p.status)} · source p.${p.page}</div>
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
  for (let y = new Date(y0).getFullYear(); y <= new Date(y1).getFullYear(); y++) {
    const xx = x(new Date(y, 0, 1).getTime())
    years.push(`<line x1="${xx}" x2="${xx}" y1="6" y2="64" stroke="rgba(70,105,230,.18)"/><text x="${xx + 3}" y="76" fill="#7286a4" font-size="10" font-family="JetBrains Mono">${y}</text>`)
  }
  const bar = (w: [string, string], y: number, color: string, label: string) =>
    `<text x="0" y="${y + 11}" fill="${color}" font-size="10" font-family="JetBrains Mono">${label}</text>` +
    `<rect x="${x(toX(w[0]))}" y="${y}" width="${Math.max(2, x(toX(w[1])) - x(toX(w[0])))}" height="14" rx="2" fill="${color}" opacity=".85"/>`
  let overlap = ''
  if (o.overlap_days > 0) {
    const s = Math.max(toX(o.a_window[0]), toX(o.b_window[0])), e = Math.min(toX(o.a_window[1]), toX(o.b_window[1]))
    overlap = `<rect x="${x(s)}" y="4" width="${x(e) - x(s)}" height="58" fill="${HOT}" opacity=".16" stroke="${HOT}" stroke-opacity=".6"/>`
  }
  return `<svg viewBox="0 0 ${W} 82" role="img" aria-label="Build windows">${years.join('')}${overlap}${bar(o.a_window, 14, COLOR.DESC, 'DESC')}${bar(o.b_window, 38, COLOR.GPC, 'GPC')}</svg>`
}

// Rough, transparent cost/impact model. GPC's costs are redacted in its public filing, so we anchor on DESC's.
function costModel(o: Overlap) {
  const a = byId[o.a].properties, b = byId[o.b].properties
  const kv = Math.max(...a.kv, ...b.kv, 0)
  const row = state.cost.rowWidthM || (kv >= 230 ? 45 : 30)
  const items: string[] = []
  let total = 0
  const schedulesAlign = o.overlap_days > 0 || o.window_gap_days < 180
  if (a.cost && schedulesAlign) {
    const mob = a.cost * state.cost.mobilizationPct / 100
    total += mob
    items.push(`<b>${money(mob)}</b> one crew and equipment mobilization avoided: ${state.cost.mobilizationPct}% of DESC's published ${money(a.cost)}`)
  } else if (!schedulesAlign) {
    items.push(`Build windows are ${(o.window_gap_days / 365.25).toFixed(1)} years apart, so crews can't be shared as planned. Shifting one schedule is the opportunity.`)
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

function renderOverlapDetail(o: Overlap) {
  const a = byId[o.a].properties, b = byId[o.b].properties
  const card = $('#detail')
  card.hidden = false
  card.innerHTML = `<button class="close" aria-label="Close">ESC ✕</button>
    <div class="kicker">COORDINATION OPPORTUNITY #${o.rank} · ${TIER_SHORT[o.tier]}</div>
    <h2>${esc(o.tier_label)}</h2>
    <div class="why">${esc(o.why)}</div>
    <div class="pair">${projectBlock(a)}${projectBlock(b)}</div>
    <div class="nums">
      <div class="hot"><b>${o.tier === 1 ? '0 km' : o.closest_km.toFixed(2) + ' km'}</b>CLOSEST POINTS (SPEC)</div>
      <div><b>${o.center_mi.toFixed(1)} mi</b>CENTER TO CENTER (GUIDE)</div>
      <div><b>${o.overlap_days > 0 ? Math.round(o.overlap_days / 30.44) + ' mo' : (o.window_gap_days / 365.25).toFixed(1) + ' yr'}</b>${o.overlap_days > 0 ? 'SHARED BUILD TIME' : 'GAP BETWEEN WINDOWS'}</div>
      <div><b>${o.score.toFixed(0)}</b>SCORE</div>
    </div>
    <div class="section-title">BUILD WINDOWS</div>
    <div class="timeline">${timelineSVG(o)}</div>
    ${a.window_basis.startsWith('published') ? '' : `<div class="note" style="font-size:11px;color:#7286a4">* DESC publishes an in-service date, not a start date. Window start: ${esc(a.window_basis)}.</div>`}
    <div class="section-title">IMPACT ESTIMATE</div>
    ${renderCost(o)}`
  card.querySelector('.close')!.addEventListener('click', closeDetail)
  card.querySelectorAll<HTMLInputElement>('input[data-cost]').forEach((inp) => inp.addEventListener('change', () => {
    (state.cost as any)[inp.dataset.cost!] = Number(inp.value)
    renderOverlapDetail(o)
  }))
}

function selectOverlap(id: string) {
  const o = overlaps.find((x) => x.id === id)
  if (!o) return
  state.selected = id
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
  const mine = overlaps.filter((o) => o.a === pid || o.b === pid)
  state.selected = null
  renderRanked()
  const card = $('#detail')
  card.hidden = false
  card.innerHTML = `<button class="close" aria-label="Close">ESC ✕</button>
    <div class="kicker" style="color:${COLOR[p.utility]}">${UTIL_NAME[p.utility]} PROJECT</div>
    <div style="margin-top:8px">${projectBlock(p)}</div>
    <div class="section-title">${mine.length ? `${mine.length} OVERLAP${mine.length > 1 ? 'S' : ''} WITH THE OTHER UTILITY` : 'NO OVERLAPS WITHIN 40 KM'}</div>
    <ol class="ranked">${mine.slice(0, 8).map((o) => {
      const other = byId[o.a === pid ? o.b : o.a].properties
      return `<li data-id="${o.id}"><div class="top"><span class="rank">#${o.rank}</span><span class="tier t${o.tier}">${TIER_SHORT[o.tier]}</span><span class="score">${o.score.toFixed(0)}</span></div>
        <div class="names"><div><span class="dot ${other.utility === 'DESC' ? 'desc' : 'gpc'}"></span>${esc(other.name)}</div></div>
        <div class="meta">${o.tier === 1 ? 'touching' : o.closest_km.toFixed(1) + ' km'} · ${timingText(o)}</div></li>`
    }).join('')}</ol>`
  card.querySelector('.close')!.addEventListener('click', closeDetail)
  card.querySelectorAll<HTMLLIElement>('li[data-id]').forEach((li) => li.addEventListener('click', () => selectOverlap(li.dataset.id!)))
  highlight([pid])
  fitTo([f])
}

function closeDetail() {
  state.selected = null
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
    return `<tr><td class="mono">${s.id}</td><td>${s.mi.toFixed(2)} mi · ${s.gap} d</td><td>${o ? `${o.center_mi.toFixed(2)} mi · ${o.isd_gap_days} d → <b>${o.tier === 1 ? 'touching' : o.closest_km.toFixed(2) + ' km'}</b> (T${o.tier})` : 'missing'}</td></tr>`
  }).join('')
  $('#tab-quality').innerHTML = `<div class="prose">
    <h3>Checked against Sperry's answer key</h3>
    <p>All 6 overlaps in Sperry's starter sample are reproduced. In-service gaps match to the day. Center distances differ slightly because we also located <b>Hooks</b> and <b>Purrysburg</b>, which the sample leaves blank. The closest-point rule shows two of those pairs are much closer than their centers suggest.</p>
    <table><tr><th>SAMPLE</th><th>THEIRS (CENTER · GAP)</th><th>OURS</th></tr>${sample}</table>
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
      <li><b>Tiers:</b> touching (≤ 0.25 km, the footprint of a substation) · under 1.6 km (share land) · under 8 km (share logistics) · under 40 km (share crews). Anything farther is ignored.</li>
      <li><b>Timing:</b> Georgia Power publishes start and need dates. DESC publishes an in-service date plus a 5-year budget, so a DESC window starts in the first year its budget spends money on the project. 41 of 44 budgets add up to their stated totals; the other 3 don't in the source PDF and are flagged. If a project has no budget, the window is assumed: 24 months for new construction, 18 for rebuilds, 12 for other work.</li>
      <li><b>Score:</b> 65% distance, 35% timing, ×0.85 when a location is approximate.</li>
    </ul>
    <h3>Limits</h3>
    <ul>
      <li>Lines are drawn straight between their named end points. Real routes bend.</li>
      <li>OpenStreetMap doesn't name every substation. Locations are labeled by confidence, and manual ones cite their evidence (see Data Quality).</li>
      <li>Georgia Power's plan carries a CEII notice, but this is the redacted public-disclosure version supplied in the challenge package, and its costs are redacted.</li>
    </ul>
    <h3>Sources</h3>
    <ul>${meta.sources.map((s) => `<li>${esc(s.label)} <span style="color:#7286a4">(${esc(s.via)})</span></li>`).join('')}</ul>
    <p style="margin-top:18px">Built at ShellHacks 2026 for Sperry Tech's GridLock challenge.</p>
  </div>`
}

function wireChrome() {
  document.querySelectorAll<HTMLButtonElement>('.method button').forEach((btn) => btn.addEventListener('click', () => {
    state.method = btn.dataset.method as Method
    document.querySelectorAll('.method button').forEach((b) => b.classList.toggle('on', b === btn))
    rerender()
  }))
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b === btn))
    for (const t of ['ranked', 'quality', 'about']) $(`#tab-${t}`).hidden = t !== btn.dataset.tab
  }))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail() })
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
