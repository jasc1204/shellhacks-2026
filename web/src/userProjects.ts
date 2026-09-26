// Projects a viewer adds on the map ("what if we build here?"). Kept in localStorage under a key the 3D viewer
// (world3d/viewer, same origin under /world3d/) also reads, so a new project shows up in both worlds.
import type { Feature, LonLat, Overlap, Utility } from './types'

export interface UserProject {
  id: string; utility: Utility; name: string; coords: LonLat[]; start: string; end: string
  cost?: number | null; kv?: number | null
}

const KEY = 'gridlock.userProjects.v1'  // {"projects": UserProject[], "overlaps": Overlap[]}: contract with world3d/viewer
const ISO = /^\d{4}-\d{2}-\d{2}$/

function valid(p: any): p is UserProject {
  return p && typeof p.id === 'string' && /^USER_\d+$/.test(p.id) && (p.utility === 'DESC' || p.utility === 'GPC') &&
    typeof p.name === 'string' && Array.isArray(p.coords) && p.coords.length >= 1 && p.coords.length <= 2 &&
    p.coords.every((c: any) => Array.isArray(c) && c.length === 2 && c.every((n: any) => Number.isFinite(n))) &&
    ISO.test(p.start) && ISO.test(p.end) && p.start < p.end
}

export function loadUserProjects(): UserProject[] {
  try {
    const raw = localStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : null
    return Array.isArray(v?.projects) ? v.projects.filter(valid) : []
  } catch {
    return []  // private mode, blocked storage or a corrupt value: start empty
  }
}

export function saveUserState(projects: UserProject[], overlaps: Overlap[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ projects, overlaps }))
  } catch { /* storage unavailable: the map still works for this visit */ }
}

/** Another tab (a second map window) changed the saved projects. */
export function onUserProjectsChanged(cb: () => void) {
  window.addEventListener('storage', (e) => { if (e.key === KEY) cb() })
}

export function nextUserId(existing: UserProject[]) {
  let n = 1
  while (existing.some((p) => p.id === `USER_${n}`)) n++
  return `USER_${n}`
}

export function toFeature(u: UserProject): Feature {
  return {
    type: 'Feature',
    geometry: u.coords.length > 1 ? { type: 'LineString', coordinates: u.coords } : { type: 'Point', coordinates: u.coords[0] },
    properties: {
      id: u.id, utility: u.utility, name: u.name, a: 'Point 1', b: u.coords.length > 1 ? 'Point 2' : '',
      kv: u.kv ? [u.kv] : [], status: 'Hypothetical, added on this map', start: u.start, isd: u.end,
      window_basis: 'entered by you', cost: u.cost ?? null, desc: '', source_id: 'YOURS', doc: 'Added by you', page: 0,
      conf: 'high', loc_a: null, loc_b: null, fix: '', n_overlaps: 0, best_tier: null, length_km: null,
      budget: null, budget_check: '', user: true,
    },
  }
}
