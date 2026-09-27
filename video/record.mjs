// Records the demo video's shots as separate 1080p takes by driving the real app in your installed Chrome.
//   node record.mjs            every shot          node record.mjs s4 s5      just those
// BASE defaults to the dev server (it exposes window.__map, used to glide the map and to aim clicks at coordinates).
// Each take lands in takes/raw/<shot>.mp4, and takes/raw/marks.json says where its action starts (after page load),
// so assemble.mjs can trim the loading off. Shots follow the 8 blocks of VOICEOVER.md.
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.env.BASE || 'http://localhost:5173/'
const OUT = path.resolve('takes/raw')
const W = 1920, H = 1080
fs.mkdirSync(OUT, { recursive: true })
const MARKS = path.join(OUT, 'marks.json')
const marks = fs.existsSync(MARKS) ? JSON.parse(fs.readFileSync(MARKS, 'utf8')) : {}

// A soft cursor and a click ripple, so viewers can follow the clicks (the recording has no OS cursor).
// Every frame gets its own (the 3D world is an iframe); a page hides its dot while the pointer is over an iframe.
const CURSOR = () => {
  const make = () => {
    if (document.getElementById('rec-cursor')) return
    const st = document.createElement('style')
    st.textContent = `#rec-cursor{position:fixed;left:-50px;top:-50px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      border:2px solid rgba(238,244,255,.95);background:rgba(111,141,255,.22);box-shadow:0 0 14px rgba(111,141,255,.6);
      pointer-events:none;z-index:2147483647;transition:transform .12s ease,opacity .2s}
      #rec-cursor.down{transform:scale(.72)}#rec-cursor.hide{opacity:0}
      .rec-ripple{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:2px solid rgba(238,244,255,.8);
      pointer-events:none;z-index:2147483646;animation:recr .55s ease-out forwards}
      @keyframes recr{to{transform:scale(3.2);opacity:0}}`
    document.head.appendChild(st)
    const c = document.createElement('div'); c.id = 'rec-cursor'; c.className = 'hide'; document.body.appendChild(c)
    addEventListener('mousemove', (e) => {
      c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'
      c.classList.toggle('hide', e.target?.tagName === 'IFRAME')
    }, true)
    addEventListener('mousedown', (e) => {
      c.classList.add('down')
      const r = document.createElement('div'); r.className = 'rec-ripple'; r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'
      document.body.appendChild(r); setTimeout(() => r.remove(), 600)
    }, true)
    addEventListener('mouseup', () => c.classList.remove('down'), true)
    document.addEventListener('mouseleave', () => c.classList.add('hide'))
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', make); else make()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openApp(page, hash = '') {
  await page.goto(BASE + hash)
  await page.waitForFunction(() => document.getElementById('loading')?.classList.contains('done'), null, { timeout: 60000 })
  await sleep(1800)   // let the satellite tiles settle
}

async function glide(page, x, y, steps = 28) { await page.mouse.move(x, y, { steps }) }

async function clickOn(page, locator, pause = 280) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('nothing to click: ' + locator)
  await glide(page, b.x + b.width / 2, b.y + b.height / 2)
  await sleep(pause)
  await page.mouse.down(); await sleep(70); await page.mouse.up()
}

/** Screen position of a [lon, lat] on the 2D map. */
const onMap = (page, ll) => page.evaluate((ll) => {
  const m = window.__map, p = m.project(ll), r = m.getContainer().getBoundingClientRect()
  return [p.x + r.left, p.y + r.top]
}, ll)

const ease = (page, o, linear = false) => page.evaluate(([o, linear]) => new Promise((res) => {
  window.__map.once('moveend', res)
  window.__map.easeTo(linear ? { ...o, easing: (t) => t } : o)
}), [o, linear])

const world = (page) => page.frameLocator('#world')

async function waitFor3D(page) {
  await page.waitForFunction(() => document.querySelector('.stage')?.classList.contains('v3d-done'), null, { timeout: 90000 })
}

const O3 = 'DESC_23__GPC_20277'   // #3: Jasper to Okatie x McIntosh reactors, 0.94 km, 24 shared months

const SHOTS = {
  // 1. The problem: the whole river corridor, a slow push in
  async s1(page) {
    await openApp(page)
    await page.mouse.move(W * 0.36, H * 0.55)
    mark(page)
    await ease(page, { center: [-81.55, 32.75], zoom: 7.9, duration: 11000 }, true)
  },
  // 2. What GridLock does: the header numbers, then down the ranked list
  async s2(page) {
    await openApp(page)
    mark(page)
    for (const t of ['PROJECTS MAPPED', 'OVERLAPS', 'SAME BUILD WINDOW']) {
      const b = await page.locator('#stats span', { hasText: t }).first().boundingBox()
      if (b) { await glide(page, b.x + b.width / 2, b.y + b.height / 2, 24); await sleep(900) }
    }
    const list = page.locator('#ranked')
    const b = await list.boundingBox()
    await glide(page, b.x + b.width / 2, b.y + 160, 30)
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 180); await sleep(650) }
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -180); await sleep(250) }
    await sleep(1200)
  },
  // 3. How it measures: GEOGRAPHIC, TIMELINE, BOTH
  async s3(page) {
    await openApp(page)
    mark(page)
    await sleep(800)
    for (const m of ['TIMELINE', 'BOTH', 'GEOGRAPHIC']) {
      await clickOn(page, page.locator('.modes button', { hasText: m }).first())
      await sleep(3600)
    }
  },
  // 4. One opportunity: #3 opens, the map flies to it
  async s4(page) {
    await openApp(page)
    mark(page)
    await sleep(600)
    await clickOn(page, page.locator(`#ranked li[data-id="${O3}"]`))
    await sleep(2600)
    const total = page.locator('#detail .cost .total')
    await total.scrollIntoViewIfNeeded()
    const b = await total.boundingBox()
    if (b) await glide(page, b.x + b.width / 2, b.y + b.height / 2, 34)
    await sleep(5200)
  },
  // 5. The same spot, in 3D: the switch, the fly-in, the rings, then walk the gap
  async s5(page) {
    await openApp(page, `#o=${O3}`)
    await sleep(2500)   // #3 framed; the 3D world finishes building in the background
    mark(page)
    await clickOn(page, page.locator('#viewswitch button[data-view="3d"]'))
    await waitFor3D(page)
    await sleep(9000)
    await clickOn(page, world(page).locator('#b-walk'), 400)
    await sleep(11000)
  },
  // 6. The top two: the 3D tour reaches Thurmond Dam
  async s6(page) {
    await openApp(page, '#v=3d')
    await waitFor3D(page)
    await sleep(2500)
    mark(page)
    await clickOn(page, page.locator('#tour-btn'))
    await sleep(19000)
  },
  // 7. A planning tool: draw a Georgia Power line near #3, score it, then see it in 3D
  async s7(page) {
    await openApp(page)
    await ease(page, { center: [-81.13, 32.36], zoom: 11.2, duration: 10 })
    await sleep(1500)
    mark(page)
    await clickOn(page, page.locator('#userbox [data-add]'))
    await sleep(700)
    const a = await onMap(page, [-81.205, 32.405]), z = await onMap(page, [-81.142, 32.352])
    await glide(page, a[0], a[1], 34); await sleep(300); await page.mouse.down(); await page.mouse.up()
    await sleep(700)
    await glide(page, z[0], z[1], 40); await sleep(300); await page.mouse.down(); await page.mouse.up()
    await sleep(900)
    const form = page.locator('#detail form.newproj')
    await form.locator('input[name="name"]').fill('Port Wentworth tap (what if)')
    await clickOn(page, form.locator('.util label', { hasText: 'GEORGIA POWER' }))
    await form.locator('input[name="start"]').fill('2025-01')
    await form.locator('input[name="end"]').fill('2026-06')
    await sleep(500)
    await clickOn(page, form.locator('button[type="submit"]'))
    await sleep(4200)
    await clickOn(page, page.locator('#viewswitch button[data-view="3d"]'))
    await waitFor3D(page)
    await sleep(6500)
  },
  // 8. Close: the answer key check, then the end card
  async s8(page) {
    await openApp(page)
    mark(page)
    await clickOn(page, page.locator('.tabs button[data-tab="quality"]'))
    await sleep(900)
    const h = page.locator('#tab-quality h3', { hasText: "Checked against Sperry's answer key" })
    const panel = await page.locator('#tab-quality').boundingBox()
    await glide(page, panel.x + panel.width / 2, panel.y + 300, 24)
    await h.evaluate((el) => el.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    await sleep(6500)
  },
  // End card: rendered here in the house style, held for a few seconds
  async end(page) {
    await page.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Space+Grotesk:wght@500;700&display=swap" rel="stylesheet">
      <style>html,body{margin:0;height:100%;background:radial-gradient(ellipse at 50% 40%,#0b1226,#020408 70%);color:#eef4ff;font-family:'Space Grotesk',sans-serif}
      .c{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px}
      .logo{font-weight:700;font-size:120px;letter-spacing:.06em}.logo span{background:linear-gradient(90deg,#eef4ff,#4dd8ff 55%,#3b7dff);-webkit-background-clip:text;background-clip:text;color:transparent}
      .t{font-size:34px;color:#eef4ff}.m{font-family:'JetBrains Mono',monospace;font-size:22px;letter-spacing:.18em;color:#8fa3c4}
      .g{position:fixed;inset:0;background-image:linear-gradient(rgba(70,105,230,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(70,105,230,.07) 1px,transparent 1px);background-size:64px 64px}</style></head>
      <body><div class="g"></div><div class="c"><div class="logo">GRID<span>LOCK</span></div><div class="t">Find the overlap before the crews do.</div>
      <div class="m">JASC1204.GITHUB.IO/SHELLHACKS-2026</div><div class="m" style="font-size:18px">SHELLHACKS 2026 &nbsp; SPERRY TECH GRIDLOCK CHALLENGE</div></div></body></html>`)
    await sleep(1500)
    mark(page)
    await sleep(5000)
  },
}

// Capture: Chrome's own compositor frames (JPEG q92, every repaint, iframes included), timestamped, then encoded
// with ffmpeg as H.264 near-lossless at a constant 30 fps. Playwright's built-in recorder is VP8 at ~1.5 Mbps, which
// smears satellite imagery. 2026-09-27.
async function startCapture(page, dir) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true })
  const cdp = await page.context().newCDPSession(page)
  const frames = [], writes = []
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const f = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`)
    frames.push({ f, t: metadata.timestamp })
    writes.push(fs.promises.writeFile(f, Buffer.from(data, 'base64')))
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W, maxHeight: H, everyNthFrame: 1 })
  return async () => { await cdp.send('Page.stopScreencast').catch(() => {}); await sleep(400); await Promise.all(writes); return frames }
}

function encode(frames, dir, dest) {
  if (frames.length < 2) throw new Error('no frames captured')
  const lines = ['ffconcat version 1.0']
  frames.forEach((fr, i) => {
    const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].t - fr.t) : 0.5
    lines.push(`file '${path.basename(fr.f)}'`, `duration ${d.toFixed(4)}`)
  })
  lines.push(`file '${path.basename(frames.at(-1).f)}'`)   // the concat demuxer drops the last duration without this
  fs.writeFileSync(path.join(dir, 'list.ffconcat'), lines.join('\n'))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.ffconcat'),
    '-vf', `scale=${W}:${H}:flags=lanczos,fps=30`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', dest])
}


const mark = (page) => { marks[page.__shot] = page.__t0 ? Date.now() / 1000 - page.__t0 : 0 }

const want = process.argv.slice(2)
const order = Object.keys(SHOTS).filter((k) => !want.length || want.includes(k))
const browser = await chromium.launch({ channel: 'chrome', headless: false,
  args: [`--window-size=${W + 16},${H + 120}`, '--force-device-scale-factor=1', '--hide-scrollbars', '--disable-infobars'] })
for (const shot of order) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 })
  await ctx.addInitScript(CURSOR)
  const page = await ctx.newPage()
  page.__shot = shot
  const dir = path.join(OUT, `${shot}_frames`)
  const stop = await startCapture(page, dir)
  page.__t0 = Date.now() / 1000
  process.stdout.write(`${shot} ... `)
  try { await SHOTS[shot](page) } catch (e) { console.log(`FAILED: ${e.message}`) }
  const frames = await stop()
  await ctx.close()
  // marks are wall-clock; frames carry Chrome's timestamps: line them up on the first frame
  if (frames.length && marks[shot] != null) marks[shot] = Math.max(0, marks[shot] + page.__t0 - frames[0].t)
  const dest = path.join(OUT, `${shot}.mp4`)
  try { encode(frames, dir, dest) } catch (e) { console.log(`ENCODE FAILED: ${e.message}`); continue }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.writeFileSync(MARKS, JSON.stringify(marks, null, 2))
  const secs = frames.length ? (frames.at(-1).t - frames[0].t).toFixed(1) : 0
  console.log(`saved ${path.relative(process.cwd(), dest)}: ${frames.length} frames over ${secs} s, action at ${marks[shot]?.toFixed(1)} s`)
}
await browser.close()
