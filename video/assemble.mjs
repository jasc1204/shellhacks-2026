// Cuts the demo video to Jose's voiceover.       node assemble.mjs <voice file> [--no-captions]
//  1. cleans the voice (rumble, hiss, level) into takes/voice.wav
//  2. finds VOICEOVER.md's 8 blocks by the ~2 s pauses between them (or takes them from takes/blocks.json if present:
//     [[start, end], ...] in seconds of the cleaned voice, for takes with re-reads)
//  3. tightens the pauses, then fits each shot (takes/raw/sN.mp4, from its action mark) to its block: trims it, or
//     holds its last frame
//  4. joins the shots and the end card, lays the voice under them, burns in captions from VOICEOVER.md
// Output: out/gridlock-demo.mp4, 1080p30 H.264 + AAC.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [voiceIn, ...flags] = process.argv.slice(2)
if (!voiceIn) { console.error('usage: node assemble.mjs <voice file> [--no-captions]'); process.exit(1) }
const CAPTIONS = !flags.includes('--no-captions')
const RAW = path.resolve('takes/raw'), TMP = path.resolve('takes/cut'), OUT = path.resolve('out')
fs.mkdirSync(TMP, { recursive: true }); fs.mkdirSync(OUT, { recursive: true })
const ff = (...args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'] })
const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString())
const marks = JSON.parse(fs.readFileSync(path.join(RAW, 'marks.json'), 'utf8'))

// ---- 1. the voice
const VOICE = path.resolve('takes/voice.wav')
ff('-i', voiceIn, '-af', 'highpass=f=80,lowpass=f=13000,afftdn=nf=-25,acompressor=threshold=-20dB:ratio=3:attack=5:release=120,loudnorm=I=-16:TP=-1.5:LRA=11',
  '-ar', '48000', '-ac', '1', VOICE)

// ---- 2. the blocks
let speech
const manual = path.resolve('takes/blocks.json')
if (fs.existsSync(manual)) speech = JSON.parse(fs.readFileSync(manual, 'utf8'))
else {
  const log = spawnSync('ffmpeg', ['-i', VOICE, '-af', 'silencedetect=noise=-38dB:d=1.1', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
  const total = dur(VOICE), sil = []
  for (const m of log.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_end: ([\d.]+)/g)) sil.push([+m[1], +m[2]])
  speech = []
  let t = 0
  for (const [s, e] of sil) { if (s - t > 0.6) speech.push([t, s]); t = e }
  if (total - t > 0.6) speech.push([t, total])
}
console.log(`voice blocks (${speech.length}):`, speech.map(([s, e]) => `${s.toFixed(1)}-${e.toFixed(1)}`).join('  '))
if (speech.length !== 8) {
  console.error(`expected 8 blocks, found ${speech.length}. Write takes/blocks.json with the 8 [start, end] pairs to use.`)
  process.exit(2)
}

// ---- 3. tighter pauses: each block keeps a little air, then a fixed gap before the next
const PRE = 0.15, POST = 0.35, GAP = 0.45
const parts = speech.map(([s, e], i) => {
  const a = Math.max(0, s - PRE), b = e + POST, f = path.join(TMP, `v${i + 1}.wav`)
  ff('-ss', a.toFixed(3), '-to', b.toFixed(3), '-i', VOICE, '-af', `apad=pad_dur=${GAP}`, f)
  return { f, len: b - a + GAP, speak: [PRE, PRE + (e - s)] }
})

const clips = []
parts.forEach((p, i) => {
  const shot = `s${i + 1}`, src = path.join(RAW, `${shot}.mp4`), out = path.join(TMP, `${shot}.mp4`)
  const from = marks[shot] ?? 0, avail = dur(src) - from, hold = Math.max(0, p.len - avail)
  ff('-ss', from.toFixed(3), '-i', src, '-t', p.len.toFixed(3),
    '-vf', `tpad=stop_mode=clone:stop_duration=${hold.toFixed(3)},fps=30,format=yuv420p`, '-an',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)
  clips.push({ f: out, len: p.len })
})
const END = 5
{
  const src = path.join(RAW, 'end.mp4'), out = path.join(TMP, 'end.mp4')
  ff('-ss', (marks.end ?? 0).toFixed(3), '-i', src, '-t', String(END), '-vf', `tpad=stop_mode=clone:stop_duration=${END},fps=30,format=yuv420p`,
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', out)
  clips.push({ f: out, len: END })
}

// ---- 4. join, voice, captions
fs.writeFileSync(path.join(TMP, 'video.txt'), clips.map((c) => `file '${c.f.replace(/\\/g, '/')}'`).join('\n'))
fs.writeFileSync(path.join(TMP, 'voice.txt'), parts.map((p) => `file '${p.f.replace(/\\/g, '/')}'`).join('\n'))
const vid = path.join(TMP, 'video.mp4'), aud = path.join(TMP, 'voice_cut.wav')
ff('-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'video.txt'), '-c', 'copy', vid)
ff('-f', 'concat', '-safe', '0', '-i', path.join(TMP, 'voice.txt'), '-af', `apad=pad_dur=${END}`, aud)

// captions: each block's text from VOICEOVER.md, split into sentences, timed by their length within the block's speech
const md = fs.readFileSync('VOICEOVER.md', 'utf8').replace(/\r\n/g, '\n')
const blocks = [...md.matchAll(/\*\*\d\. [^*]+\*\*[^\n]*\n\n([\s\S]*?)(?=\n\n\*\*\d\. |\s*$)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim())
const ts = (t) => { const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = (t % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${s}` }
const lines = []
let t0 = 0
parts.forEach((p, i) => {
  const text = blocks[i] || ''
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) || []
  const chars = sentences.reduce((n, s) => n + s.length, 0) || 1
  let t = t0 + p.speak[0]
  const span = p.speak[1] - p.speak[0]
  for (const s of sentences) {
    const d = span * s.length / chars
    lines.push(`Dialogue: 0,${ts(t)},${ts(t + d)},Cap,,0,0,0,,${s}`)
    t += d
  }
  t0 += p.len
})
const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nWrapStyle: 0\n\n[V4+ Styles]\n` +
  'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\n' +
  'Style: Cap,Segoe UI Semibold,40,&H00FFF4EE,&H00FFF4EE,&H00100904,&H9A100904,0,0,0,0,100,100,0.5,0,3,14,0,2,140,540,64,1\n\n' +
  `[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n${lines.join('\n')}\n`
fs.writeFileSync(path.join(TMP, 'captions.ass'), ass)

const total = clips.reduce((n, c) => n + c.len, 0)
const vf = [`fade=t=in:st=0:d=0.6`, `fade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`]
if (CAPTIONS) vf.push(`subtitles=takes/cut/captions.ass`)
const final = path.join(OUT, 'gridlock-demo.mp4')
ff('-i', vid, '-i', aud, '-map', '0:v', '-map', '1:a', '-vf', vf.join(','), '-af', `afade=t=out:st=${(total - 1.2).toFixed(2)}:d=1.2`,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', final)
console.log(`done: ${path.relative(process.cwd(), final)}, ${total.toFixed(1)} s`)
