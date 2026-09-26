export type Utility = 'DESC' | 'GPC'
export type Method = 'closest' | 'center'
export type LonLat = [number, number]

export interface Loc { name: string; matched: string; method: string; confidence: string; note: string }

export interface ProjectProps {
  id: string; utility: Utility; name: string; a: string; b: string; kv: number[]; status: string
  start: string; isd: string; window_basis: string; cost: number | null; desc: string; source_id: string
  doc: string; page: number; conf: string; loc_a: Loc | null; loc_b: Loc | null; fix: string
  n_overlaps: number; best_tier: number | null; length_km: number | null
  budget: Record<string, number> | null; budget_check: string
  user?: boolean  // added in the browser by the viewer, not from a utility filing
}

export interface Feature { type: 'Feature'; geometry: { type: 'LineString' | 'Point'; coordinates: any }; properties: ProjectProps }

export interface Overlap {
  id: string; rank: number; a: string; b: string; a_name: string; b_name: string
  closest_km: number; closest_points: LonLat[]; lines_cross: boolean
  center_km: number; center_mi: number; flagged_by_center_method: boolean
  tier: number; tier_label: string; can_share: string
  a_window: [string, string]; b_window: [string, string]; overlap_days: number; window_gap_days: number; isd_gap_days: number
  shared_corridor_km: number; geo_score: number; time_score: number; score: number; needs_location_check: boolean; why: string
  user?: boolean  // involves a user-added project
}

export interface Meta {
  desc_projects: number; gpc_projects: number; desc_mapped: number; gpc_mapped: number; pairs_flagged: number
  by_tier: Record<string, number>; caught_only_by_closest_points: string[]
  unmapped: { id: string; utility: Utility; name: string; a: string; b: string; isd: string; page: number }[]
  sources: { label: string; via: string }[]
}

export interface Level { level: string; title: string; bbox: [number, number, number, number]; overlap_ids: string[] }
