// The 2D map is satellite imagery, flat: 3D lives in the 3D world (world.ts). All sources are free and need no API key.
import type { Map as MapLibreMap } from 'maplibre-gl'

// USGS The National Map orthoimagery: US public domain, served with CORS, no key.
const SAT_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'

/** Keep only what shows: labels and boundaries over the photo, and the water fill under it (USGS has no imagery
 *  offshore, where the ocean would otherwise show as black tile steps). Land use, roads, buildings and the rest would
 *  be drawn under an opaque satellite layer, costing tile parsing, GPU buffers and draw calls for pixels nobody sees.
 *  2026-09-27: part of the "less memory, same look" pass. */
export function satelliteStyle(style: any) {
  style.layers = style.layers.filter((l: any) => l.type === 'background' || l.type === 'symbol' || /^boundary/.test(l.id) ||
    (l.type === 'fill' && l['source-layer'] === 'water'))
  const used = new Set(style.layers.map((l: any) => l.source).filter(Boolean))
  for (const k of Object.keys(style.sources)) if (!used.has(k)) delete style.sources[k]
  return style
}

/** The imagery itself, under our data layers and the basemap's labels. `firstDataLayer` is the lowest GridLock layer. */
export function addSatellite(map: MapLibreMap, firstDataLayer: string) {
  const firstSymbol = map.getStyle().layers.find((l) => l.type === 'symbol')?.id
  map.addSource('sat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 16,
    attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>' })
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat',
    paint: { 'raster-brightness-max': 0.78, 'raster-saturation': -0.12, 'raster-contrast': 0.06, 'raster-fade-duration': 150 } }, firstSymbol)
  // Keep the Georgia / South Carolina line visible on top of the imagery: every overlap sits on that border.
  if (map.getLayer('boundary_state')) {
    map.moveLayer('boundary_state', firstDataLayer)
    map.setPaintProperty('boundary_state', 'line-color', '#9fc2ff')
  }
}

const show = (map: MapLibreMap, id: string, on: boolean) => {
  if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none')
}

export function setLayersVisible(map: MapLibreMap, ids: string[], on: boolean) {
  for (const id of ids) show(map, id, on)
}
