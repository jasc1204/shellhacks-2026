// The 2D map is satellite imagery, flat: 3D lives in the 3D world (world.ts). All sources are free and need no API key.
import type { Map as MapLibreMap } from 'maplibre-gl'

// USGS The National Map orthoimagery: US public domain, served with CORS, no key. Sharp up close (NAIP, ~1 m), but its
// zoomed-out tiles have gray smears and end in stair steps at the coast.
const SAT_TILES = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'
// So zoomed out, EOX's Sentinel-2 cloudless 2024 mosaic: seamless, cloud-free, ocean included, 10 m. CORS, no key,
// CC BY-NC-SA 4.0 (a student hackathon is non-commercial), attribution below. The two crossfade around zoom 11.
const S2_TILES = 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg'

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
  const look = { 'raster-brightness-max': 0.78, 'raster-saturation': -0.12, 'raster-contrast': 0.06, 'raster-fade-duration': 150 }
  map.addSource('s2', { type: 'raster', tiles: [S2_TILES], tileSize: 256, maxzoom: 13,
    attribution: '<a href="https://s2maps.eu">Sentinel-2 cloudless 2024</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024)' })
  map.addLayer({ id: 'sat-s2', type: 'raster', source: 's2', maxzoom: 12, paint: look }, firstSymbol)
  map.addSource('sat', { type: 'raster', tiles: [SAT_TILES], tileSize: 256, maxzoom: 16,
    attribution: 'Imagery: <a href="https://www.usgs.gov/programs/national-geospatial-program/national-map">USGS The National Map</a>' })
  // USGS only from zoom 10.5 (no requests for its smeared overview tiles), fading in over the Sentinel mosaic
  map.addLayer({ id: 'sat', type: 'raster', source: 'sat', minzoom: 10.5,
    paint: { ...look, 'raster-opacity': ['interpolate', ['linear'], ['zoom'], 10.5, 0, 11.5, 1] } }, firstSymbol)
  // Only seen while the map leans into 3D (2D itself is flat): the 3D world's own satellite-mode sky and haze, so the
  // crossfade blends instead of flashing a black band above the horizon.
  const anyMap = map as any
  if (typeof anyMap.setSky === 'function') {
    anyMap.setSky({ 'sky-color': '#3d6594', 'horizon-color': '#c6d3df', 'fog-color': '#a6b7c7', 'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.6, 'atmosphere-blend': 0 })
  }
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
