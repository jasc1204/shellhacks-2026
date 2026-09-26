import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'

// The 3D world (../world3d, built by its own pipeline) is served from the same origin under /world3d/,
// so the map can deep-link into it: in dev via a middleware, in production by copying only the files the
// viewer needs into dist/world3d/ (no .blend masters, no lossless textures, no renders).
const WORLD3D = path.resolve(import.meta.dirname, '../world3d')
const LEVEL_FILES = ['scene.json', 'terrain.bin', 'ground.webp', 'ground_sat.webp', 'models.glb', 'buildings.bin', 'veg.png']
// Photoreal-mode API token: served by the local dev server only, NEVER copied into dist (it's git-ignored too).
const DEV_ONLY = ['viewer/tokens.local.json']
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.bin': 'application/octet-stream',
  '.webp': 'image/webp', '.png': 'image/png', '.glb': 'model/gltf-binary',
}

function world3dFiles(): string[] {
  const levelsPath = path.join(WORLD3D, 'build', 'levels.json')
  if (!fs.existsSync(levelsPath)) return []
  const levels: { level: string }[] = JSON.parse(fs.readFileSync(levelsPath, 'utf8'))
  const files = ['viewer/index.html', 'build/levels.json']
  for (const { level } of levels) {
    for (const f of LEVEL_FILES) files.push(`build/${level}/${f}`)
    // high-resolution satellite patches around the overlaps: sat_patch_0.webp, sat_patch_1.webp, ...
    const dir = path.join(WORLD3D, 'build', level)
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (/^sat_patch_\d+\.webp$/.test(f)) files.push(`build/${level}/${f}`)
  }
  return files.filter((f) => fs.existsSync(path.join(WORLD3D, f)))
}

function world3d(): Plugin {
  let outDir = 'dist'
  return {
    name: 'gridlock-world3d',
    configResolved(cfg) { outDir = path.resolve(cfg.root, cfg.build.outDir) },
    configureServer(server) {
      server.middlewares.use('/world3d', (req, res) => {
        let rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '')
        if (rel === 'viewer/' || rel === 'viewer') rel = 'viewer/index.html'
        const devOnly = DEV_ONLY.includes(rel) && fs.existsSync(path.join(WORLD3D, rel))
        if (!devOnly && !world3dFiles().includes(rel)) {
          // A real 404 (not Vite's index.html fallback), so the viewer's "file missing" paths behave as on Pages.
          res.statusCode = 404
          return res.end('Not found')
        }
        res.setHeader('Content-Type', TYPES[path.extname(rel)] || 'application/octet-stream')
        fs.createReadStream(path.join(WORLD3D, rel)).pipe(res)
      })
    },
    closeBundle() {
      for (const f of world3dFiles()) {
        const dest = path.join(outDir, 'world3d', f)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(WORLD3D, f), dest)
      }
    },
  }
}

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; set VITE_BASE=/shellhacks-2026/ for that build.
  base: process.env.VITE_BASE || '/',
  plugins: [world3d()],
  build: { chunkSizeWarningLimit: 1200 },  // MapLibre alone is ~1 MB minified
  // Serve MapLibre's own ESM files in dev: its pre-bundled copy spawned workers from a path that doesn't exist
  // before setWorkerUrl() ran, and tiles sent to those workers never finished (blank map, no 'load' event).
  optimizeDeps: { exclude: ['maplibre-gl'] },
})
