// Overlap math in the browser: the same rules as pipeline/overlaps.py, so a project someone adds on the map
// is scored exactly like the utilities' own projects (closest points, tiers, build-window overlap, score).
import type { Feature, LonLat, Overlap } from './types'

export const MAX_KM = 40            // spec: 40 km (25 mi)
export const CENTER_MAX_KM = 40.2336 // Sperry guide: 25 miles, center to center
export const TOUCH_KM = 0.25
export const TIERS = [
  { tier: 1, limit: TOUCH_KM, label: 'Touching / crossing', share: 'Must coordinate: outage timing, crossing structures' },
  { tier: 2, limit: 1.6, label: 'Under 1.6 km', share: 'Can share the land itself: right-of-way, access roads, permits' },
  { tier: 3, limit: 8, label: 'Under 8 km', share: 'Can share site logistics: laydown yards, deliveries' },
  { tier: 4, limit: MAX_KM, label: 'Under 40 km', share: 'Can share crews and equipment' },
]

const R_KM = 6371.0088
const DAY = 86400000
type P = [number, number]
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const p1 = rad(lat1), p2 = rad(lat2), dp = p2 - p1, dl = rad(lon2 - lon1)
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  return 2 * R_KM * Math.asin(Math.sqrt(h))
}

export function coordsOf(f: Feature): LonLat[] {
  return f.geometry.type === 'Point' ? [f.geometry.coordinates] : f.geometry.coordinates
}

export function centerOf(f: Feature): LonLat {
  const c = coordsOf(f)
  return [(c[0][0] + c[c.length - 1][0]) / 2, (c[0][1] + c[c.length - 1][1]) / 2]
}

// Equirectangular projection centred on a pair, in km: well under 1% error at these distances.
const fwd = (k: number, [lon, lat]: LonLat): P => [R_KM * rad(lon) * k, R_KM * rad(lat)]
const inv = (k: number, [x, y]: P): LonLat => [deg(x / (R_KM * k)), deg(y / R_KM)]
const dist = (p: P, q: P) => Math.hypot(p[0] - q[0], p[1] - q[1])

function onSegment(p: P, a: P, b: P): P {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy
  if (!len) return a
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len))
  return [a[0] + t * dx, a[1] + t * dy]
}

function onGeometry(p: P, g: P[]): P {
  if (g.length === 1) return g[0]
  let best = g[0], bd = Infinity
  for (let i = 0; i < g.length - 1; i++) {
    const q = onSegment(p, g[i], g[i + 1]), d = dist(p, q)
    if (d < bd) { bd = d; best = q }
  }
  return best
}

// Proper crossing of two segments (interiors intersect), returning the crossing point.
function crossing(a1: P, a2: P, b1: P, b2: P): P | null {
  const rx = a2[0] - a1[0], ry = a2[1] - a1[1], sx = b2[0] - b1[0], sy = b2[1] - b1[1]
  const den = rx * sy - ry * sx
  if (Math.abs(den) < 1e-12) return null
  const qx = b1[0] - a1[0], qy = b1[1] - a1[1]
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den
  return t > 0 && t < 1 && u > 0 && u < 1 ? [a1[0] + t * rx, a1[1] + t * ry] : null
}

/** Closest points between two point/polyline geometries in projected km. For non-crossing polylines the
 *  minimum is always reached at a vertex of one of them, so checking vertices against the other is exact. */
function closest(ga: P[], gb: P[]) {
  if (ga.length > 1 && gb.length > 1) {
    for (let i = 0; i < ga.length - 1; i++) for (let j = 0; j < gb.length - 1; j++) {
      const x = crossing(ga[i], ga[i + 1], gb[j], gb[j + 1])
      if (x) return { d: 0, pa: x, pb: x, cross: true }
    }
  }
  let best = { d: Infinity, pa: ga[0], pb: gb[0], cross: false }
  for (const p of ga) { const q = onGeometry(p, gb), d = dist(p, q); if (d < best.d) best = { d, pa: p, pb: q, cross: false } }
  for (const q of gb) { const p = onGeometry(q, ga), d = dist(p, q); if (d < best.d) best = { d, pa: p, pb: q, cross: false } }
  return best
}

// How much of one line runs within `within` km of the other (right-of-way sharing), sampled every 100 m.
function corridorKm(ga: P[], gb: P[], within = 1.6) {
  if (ga.length < 2 || gb.length < 2) return 0
  const along = (g: P[], other: P[]) => {
    let km = 0
    for (let i = 0; i < g.length - 1; i++) {
      const len = dist(g[i], g[i + 1]), n = Math.max(1, Math.round(len / 0.1))
      for (let s = 0; s < n; s++) {
        const t = (s + 0.5) / n
        const p: P = [g[i][0] + t * (g[i + 1][0] - g[i][0]), g[i][1] + t * (g[i + 1][1] - g[i][1])]
        if (dist(p, onGeometry(p, other)) <= within) km += len / n
      }
    }
    return km
  }
  return Math.max(along(ga, gb), along(gb, ga))
}

// Tier 1 includes its tolerance; the others are "under" their limit, as the spec words them.
export function tierFor(dKm: number) {
  return TIERS.find((t) => (t.tier === 1 ? dKm <= t.limit : dKm < t.limit)) || null
}

function geoScore(tier: number, d: number) {
  if (tier === 1) return 1
  if (tier === 2) return 0.75 + 0.15 * (1 - d / 1.6)
  if (tier === 3) return 0.5 + 0.2 * (1 - (d - 1.6) / 6.4)
  return 0.2 + 0.25 * (1 - (d - 8) / 32)
}

function timeScore(overlapDays: number, windowDays: number, gapDays: number) {
  if (overlapDays > 0) return 0.5 + 0.5 * Math.min(1, overlapDays / Math.max(1, windowDays))
  return Math.max(0, 0.5 - gapDays / (365.25 * 4))
}

/** Same wording as pipeline/overlaps.py timing_phrase(). */
export function timingPhrase(overlapDays: number, gapDays: number) {
  if (overlapDays > 0) return `build windows overlap by ${Math.round(overlapDays / 30.44)} months`
  if (gapDays < 45) return 'build windows are back to back'
  if (gapDays < 365) return `build windows ${Math.round(gapDays / 30.44)} months apart`
  return `build windows ${(gapDays / 365.25).toFixed(1)} years apart`
}

const utc = (iso: string) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }

/** Score one DESC-side project `a` against one GPC-side project `b`. Null if farther than 40 km. */
export function scorePair(a: Feature, b: Feature): Overlap | null {
  const ca = centerOf(a), cb = centerOf(b)
  const centerKm = haversineKm(ca[1], ca[0], cb[1], cb[0])
  if (centerKm > 150) return null
  const k = Math.cos(rad((ca[1] + cb[1]) / 2))
  const pa = coordsOf(a).map((c) => fwd(k, c)), pb = coordsOf(b).map((c) => fwd(k, c))
  const c = closest(pa, pb)
  const [lon1, lat1] = inv(k, c.pa), [lon2, lat2] = inv(k, c.pb)
  const closestKm = c.cross ? 0 : haversineKm(lat1, lon1, lat2, lon2)
  const t = tierFor(closestKm)
  if (!t) return null

  const A = a.properties, B = b.properties
  const sa = utc(A.start), ea = utc(A.isd), sb = utc(B.start), eb = utc(B.isd)
  const overlapDays = Math.max(0, Math.round((Math.min(ea, eb) - Math.max(sa, sb)) / DAY))
  const gapDays = overlapDays ? 0 : Math.round((Math.max(sa, sb) - Math.min(ea, eb)) / DAY)
  const shorter = Math.min(ea - sa, eb - sb) / DAY
  const g = geoScore(t.tier, closestKm), tm = timeScore(overlapDays, shorter, gapDays)
  const verify = [A.conf, B.conf].some((x) => x === 'low' || x === 'none')
  const score = 100 * (0.65 * g + 0.35 * tm) * (verify ? 0.85 : 1)
  const when = timingPhrase(overlapDays, gapDays)
  const distTxt = t.tier === 1 ? 'touching' : `${closestKm.toFixed(1)} km apart at the closest point`
  return {
    id: `${A.id}__${B.id}`, rank: 0, a: A.id, b: B.id, a_name: A.name, b_name: B.name,
    closest_km: +closestKm.toFixed(3), closest_points: [[lon1, lat1], [lon2, lat2]], lines_cross: c.cross,
    center_km: +centerKm.toFixed(3), center_mi: +(centerKm / 1.609344).toFixed(2), flagged_by_center_method: centerKm <= CENTER_MAX_KM,
    tier: t.tier, tier_label: t.label, can_share: t.share,
    a_window: [A.start, A.isd], b_window: [B.start, B.isd], overlap_days: overlapDays, window_gap_days: gapDays,
    isd_gap_days: Math.round(Math.abs(ea - eb) / DAY), shared_corridor_km: +corridorKm(pa, pb).toFixed(2),
    geo_score: +g.toFixed(3), time_score: +tm.toFixed(3), score: +score.toFixed(1), needs_location_check: verify,
    why: `${distTxt}; ${when}. ${t.share}.`,
  }
}
