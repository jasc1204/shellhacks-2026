// One page, two ways to see the same overlaps: the flat satellite map (2D) and the 3D world (3D). 2026-09-27.
// The 3D world is the viewer in world3d/viewer/, embedded in place of the map. It's same-origin, so this page drives it.
//   2D -> 3D: the map leans toward the target, the 3D camera takes over from the exact same spot, then flies on.
//   3D -> 2D: under the fade the map takes the 3D camera's spot, then flattens back to 2D.
// The viewer exposes window.gridlock3d in ?embed=1 mode. Older viewers without it still work: the handoff just isn't
// camera-matched, and this page hides their own list and map link itself.
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Level, LonLat } from './types'

export type View = '2d' | '3d'
export type Cam = { lon: number; lat: number; alt: number; bearing: number; pitch: number; fov: number }
export type Target = { level: string; center: LonLat; id: string | null; km: number; walk?: boolean }
interface Api3D {
  level: string
  select(id: string | null, opts?: { fly?: boolean; walk?: boolean }): boolean
  camera(): Cam
  jump(cam: Cam): void
  setVisible?(ids: string[] | null): void
  tour?(): void
}
type Hooks = { levels(): Level[]; onSelect(id: string | null): void; onView(v: View): void; visibleIds(): string[] }

/** The viewer's vertical field of view. The map uses it too: a flat view looks the same at any FOV, and a tilted one
 *  then lines up with the 3D camera at the handoff. */
export const FOV = 55
const VIEWER = `${import.meta.env.BASE_URL}world3d/viewer/`
const FADE_MS = 480

let map: MapLibreMap
let stage: HTMLElement
let hooks: Hooks
let frame: HTMLIFrameElement | null = null
let level = ''
let ready = false
let view: View = '2d'
let run = 0   // bumps on every switch, so a transition that was overtaken stops itself

export const currentView = () => view
export const worldLevel = () => level
const win = (): any => { try { return frame?.contentWindow ?? null } catch { return null } }
const api = (): Api3D | null => win()?.gridlock3d ?? null
const frames = (n: number) => new Promise<void>((res) => { const f = () => (--n <= 0 ? res() : requestAnimationFrame(f)); requestAnimationFrame(f) })
const wait = (ms: number) => new Promise((res) => setTimeout(res, ms))
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const bearingTo = (a: LonLat, b: LonLat) => (Math.atan2((b[0] - a[0]) * Math.cos((a[1] * Math.PI) / 180), b[1] - a[1]) * 180) / Math.PI

export function initWorld(m: MapLibreMap, st: HTMLElement, h: Hooks) {
  map = m; stage = st; hooks = h
  map.setVerticalFieldOfView(FOV)
  addEventListener('message', (e) => {   // the 3D world picked something: a chip, a number key, its tour
    if (!frame || e.source !== frame.contentWindow || e.data?.source !== 'gridlock3d') return
    if (e.data.type === 'select' && view === '3d') hooks.onSelect(e.data.id ?? null)
  })
}

/** Where a level sits: [lon, lat] of its middle. */
function levelCenter(key: string): LonLat | null {
  const l = hooks.levels().find((x) => x.level === key)
  return l ? [(l.bbox[1] + l.bbox[3]) / 2, (l.bbox[0] + l.bbox[2]) / 2] : null
}

/** Load a level into the (hidden) 3D frame. Hidden means display: none, so the viewer sees a 0 x 0 window and skips
 *  drawing: no GPU work while you're in 2D. */
function load(key: string) {
  if (frame && level === key) return
  level = key
  ready = false
  if (!frame) {
    frame = document.createElement('iframe')
    frame.id = 'world'
    frame.title = 'GridLock 3D world'
    stage.appendChild(frame)
    frame.addEventListener('load', frameLoaded)
  }
  frame.src = `${VIEWER}?embed=1&level=${encodeURIComponent(key)}`
}

/** Every page the frame loads: ours, or one the viewer navigated to itself (its tour hopping levels, GOOGLE 3D).
 *  Follow its level, then wait for it to finish building. */
let loads = 0
function frameLoaded() {
  const f = frame!, n = ++loads
  ready = false
  try { level = new URLSearchParams(f.contentWindow!.location.search).get('level') || level } catch { /* keep */ }
  const t0 = performance.now()
  const poll = () => {
    if (f !== frame || n !== loads) return
    let d: Document | null = null
    try { d = f.contentDocument } catch { d = null }
    // the viewer takes its boot screen away once the level is built
    if (d && d.getElementById('stage') && !d.getElementById('boot')) { adopt(d); ready = true; api()?.setVisible?.(hooks.visibleIds()); return }
    if (performance.now() - t0 < 120000) setTimeout(poll, 120)
  }
  poll()
}

/** Older viewers (no ?embed=1 support): hide their own list and map link, and follow their selection through the
 *  map link's #o= that they keep up to date. */
function adopt(d: Document) {
  if (api()) return
  const st = d.createElement('style')
  st.textContent = '#leftcol, #to-map { display: none !important; }'
  d.head.appendChild(st)
  const link = d.getElementById('to-map')
  if (link) new MutationObserver(() => {
    if (view !== '3d') return
    hooks.onSelect(new URLSearchParams((link.getAttribute('href') || '').split('#')[1] || '').get('o'))
  }).observe(link, { attributes: true, attributeFilter: ['href'] })
}

/** Start building a level in the background, so the first switch to 3D is instant. */
export function preloadWorld(key: string) { if (!frame) load(key) }

const whenReady = (r: number) => new Promise<boolean>((res) => {
  if (ready) return res(true)
  const t = setInterval(() => { if (run !== r) { clearInterval(t); res(false) } else if (ready) { clearInterval(t); res(true) } }, 100)
})

/** "Building the 3D world" veil, with the viewer's own progress bar mirrored. */
function veil(on: boolean, label = 'BUILDING THE 3D WORLD') {
  let v = stage.querySelector<HTMLElement>('.worldveil')
  if (!v) {
    v = document.createElement('div')
    v.className = 'worldveil'
    v.innerHTML = '<span class="bar"><i></i></span><b></b>'
    stage.appendChild(v)
  }
  v.querySelector('b')!.textContent = label
  v.classList.toggle('on', on)
  if (!on) return
  const tick = () => {
    if (!v!.classList.contains('on')) return
    let w = ''
    try { w = frame?.contentDocument?.getElementById('bar')?.style.width || '' } catch { /* not ready */ }
    v!.querySelector<HTMLElement>('.bar i')!.style.width = w || '8%'
    setTimeout(tick, 150)
  }
  tick()
}

function mapCamera(): Cam {
  const tr = (map as any).transform
  const ll = tr.getCameraLngLat()
  return { lon: ll.lng, lat: ll.lat, alt: tr.getCameraAltitude(), bearing: map.getBearing(), pitch: map.getPitch(), fov: map.getVerticalFieldOfView() }
}

const easeMap = (o: Record<string, unknown>, ms: number) => new Promise<void>((res) => {
  let done = false
  const end = () => { if (!done) { done = true; res() } }
  map.once('moveend', end)
  setTimeout(end, ms + 250)
  map.easeTo({ ...o, duration: ms, easing: easeInOut })
})

/** 2D -> 3D. */
export async function show3D(t: Target) {
  const r = ++run
  const from2D = view === '2d'
  view = '3d'
  hooks.onView('3d')
  if (!from2D) return retarget(t, r)
  load(t.level)
  stage.classList.add('v3d')
  // 1. The map leans in toward the target, facing away from the level's middle so the camera stays inside the level.
  const mid = levelCenter(t.level)
  const bearing = t.id && mid ? bearingTo(mid, t.center) : 0
  const zoom = t.id ? clamp(12.3 - Math.log2(Math.max(1, t.km)), 9.6, 12.3) : 9.3
  map.stop()
  await easeMap({ center: t.center, zoom, pitch: 58, bearing }, 1150)
  if (run !== r) return
  if (!ready) {
    veil(true)
    if (!(await whenReady(r))) return
    veil(false)
  }
  // 2. The 3D camera takes the map's exact spot, draws a couple of frames, then fades in while it flies on.
  const f = frame!
  f.style.display = 'block'
  const a = api()
  a?.jump(mapCamera())
  await frames(3)
  if (run !== r) return
  f.classList.add('on')
  if (t.id) a?.select(t.id, { fly: true, walk: !!t.walk })
  await wait(FADE_MS)
  if (run !== r) return
  stage.classList.add('v3d-done')   // the map is covered: hide it so MapLibre stays idle
  try { f.contentWindow?.focus() } catch { /* ignore */ }
}

/** Already in 3D: fly to another overlap, loading its level first if it lives in the other one. */
async function retarget(t: Target, r: number) {
  if (t.level === level && ready) {
    if (t.id) api()?.select(t.id, { fly: true, walk: !!t.walk })
    return
  }
  const f = frame!
  veil(true, 'LOADING THE NEXT LEVEL')
  f.classList.remove('on')
  await wait(FADE_MS)
  if (run !== r) return
  load(t.level)
  if (!(await whenReady(r))) return
  f.classList.add('on')
  if (t.id) api()?.select(t.id, { fly: true, walk: !!t.walk })
  veil(false)
  try { f.contentWindow?.focus() } catch { /* ignore */ }
}

/** 3D -> 2D. `settle` frames the map afterwards (the selected overlap); without it the map just flattens. */
export async function show2D(settle?: () => void) {
  const r = ++run
  if (view === '2d') return
  view = '2d'
  hooks.onView('2d')
  veil(false)
  stage.classList.remove('v3d-done')
  const f = frame, a = api()
  if (f && a && f.classList.contains('on')) {
    try {   // under the fade, the map takes the 3D camera's spot (MapLibre tops out at 75 degrees of tilt)
      const c = a.camera()
      map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation([c.lon, c.lat], c.alt, c.bearing, Math.min(c.pitch, 75)))
    } catch { /* keep the map where it was */ }
    await frames(2)
  }
  if (run !== r) return
  stage.classList.remove('v3d')
  f?.classList.remove('on')
  await wait(FADE_MS)
  if (run !== r) return
  if (f) f.style.display = 'none'
  if (settle) settle()
  else map.easeTo({ pitch: 0, bearing: 0, duration: 1100, easing: easeInOut })
}

/** Keep the 3D world's arcs in step with the page's filter. */
export function setVisible3D(ids: string[]) { if (ready) api()?.setVisible?.(ids) }

/** The TOUR button while in 3D: the 3D world's own tour. */
export function tour3D() {
  const a = api()
  if (a?.tour) a.tour()
  else win()?.dispatchEvent(new KeyboardEvent('keydown', { key: 't' }))
  try { frame?.contentWindow?.focus() } catch { /* ignore */ }
}
