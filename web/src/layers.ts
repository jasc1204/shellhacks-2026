// Map modes: satellite imagery, 3D terrain and extruded buildings. All sources are free and need no API key.
import type { Map as MapLibreMap } from 'maplibre-gl'

// USGS The National Map orthoimagery: US public domain, served with CORS, no key.
const SAT_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
// Mapzen/AWS Terrain Tiles (terrarium encoding), open data on AWS.
const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png'
// The coastal plain along the Savannah River is nearly flat; exaggerate so river bluffs and valleys read in 3D.
const EXAGGERATION = 4

/** Add the optional layers (hidden) under our data layers. `firstDataLayer` is the lowest GridLock layer. */
export function addMapModes(map: MapLibreMap, firstDataLayer: string) {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
  const dem = { type: 'raster-dem' as const, tiles: [DEM_TILES], encoding: 'terrarium' as const, tileSize: 256, maxzoom: 15,
    attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' }

  map.addSource('sat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 16,
    attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>' })
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', layout: { visibility: 'none' },
    paint: { 'raster-brightness-max': 0.78, 'raster-saturation': -0.12, 'raster-contrast': 0.06, 'raster-fade-duration': 150 } }, firstSymbol)

  map.addSource('dem', dem)     // terrain mesh
  map.addSource('dem-hs', dem)  // hillshade (MapLibre wants a separate source from the terrain one)
  map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'dem-hs', layout: { visibility: 'none' },
    paint: { 'hillshade-shadow-color': '#010307', 'hillshade-highlight-color': '#23406f', 'hillshade-accent-color': '#0a1830',
      'hillshade-exaggeration': 0.5 } }, firstSymbol)

  map.addLayer({ id: 'buildings-3d', type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 12.5,
    layout: { visibility: 'none' },
    paint: { 'fill-extrusion-color': '#1a2f52', 'fill-extrusion-opacity': 0.88,
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 6],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0] } }, firstDataLayer)

  // Keep the Georgia / South Carolina line visible on top of the imagery: every overlap sits on that border.
  if (map.getLayer('boundary_state')) map.moveLayer('boundary_state', firstDataLayer)
}

const show = (map: MapLibreMap, id: string, on: boolean) => {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
}

export function setSatellite(map: MapLibreMap, on: boolean) {
  show(map, 'sat', on)
  if (map.getLayer('boundary_state')) map.setPaintProperty('boundary_state', 'line-color', on ? '#9fc2ff' : '#35548f')
  // Light roofs read better over photos; dark ones over the night map.
  if (map.getLayer('buildings-3d')) map.setPaintProperty('buildings-3d', 'fill-extrusion-color', on ? '#c9d4e6' : '#1a2f52')
}

export function set3D(map: MapLibreMap, on: boolean) {
  show(map, 'hillshade', on)
  show(map, 'buildings-3d', on)
  map.setTerrain(on ? { source: 'dem', exaggeration: EXAGGERATION } : null)
  const anyMap = map as any
  if (typeof anyMap.setSky === 'function') {
    anyMap.setSky(on ? { 'sky-color': '#07142a', 'horizon-color': '#1b3566', 'fog-color': '#06101f', 'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.7, 'fog-ground-blend': 0.35, 'atmosphere-blend': 0.8 } : undefined)
  }
  map.easeTo({ pitch: on ? 62 : 0, bearing: on ? -18 : 0, duration: 1200 })
}

export function setLayersVisible(map: MapLibreMap, ids: string[], on: boolean) {
  for (const id of ids) show(map, id, on)
}
