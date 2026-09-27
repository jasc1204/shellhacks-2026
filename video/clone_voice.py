"""Reads VOICEOVER.md in Jose's own voice, cloned locally from a short sample with Chatterbox (Resemble AI, MIT).

    .venv-tts/Scripts/python clone_voice.py <sample audio> [--exaggeration 0.45] [--cfg 0.5] [--seed 7]

Nothing leaves this laptop: the model runs on the GPU from the Hugging Face cache. Chatterbox adds an inaudible
watermark to what it generates (its responsible-AI default). Output:
  voice/ref.wav          the sample, cleaned (hum, hiss and long pauses out, level evened), up to 30 s
  voice/block1..8.wav    each block on its own, to listen to
  voice/narration.wav    all 8 blocks, 2 s apart
  takes/blocks.json      where each block starts and ends, for assemble.mjs (exact, no silence detection)
"""
import argparse, json, os, re, subprocess
import torch, torchaudio as ta
from chatterbox.tts import ChatterboxTTS

HERE = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(HERE, 'voice'), exist_ok=True)
ap = argparse.ArgumentParser()
ap.add_argument('sample')
ap.add_argument('--exaggeration', type=float, default=0.45)   # 0.5 is the model's default; a notch calmer for narration
ap.add_argument('--cfg', type=float, default=0.5)
ap.add_argument('--seed', type=int, default=7)
a = ap.parse_args()

# the voice only: how to say the names a model trips on (the captions keep the real spelling)
SAY = {'Okatie': 'Oh-kay-tee', 'GridLock': 'Grid Lock', 'Sperry': 'Sperry', 'right-of-way': 'right of way'}

ref = os.path.join(HERE, 'voice', 'ref.wav')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', a.sample, '-t', '45', '-af',
                'highpass=f=80,afftdn=nf=-25,silenceremove=start_periods=1:start_threshold=-45dB:'
                'stop_periods=-1:stop_duration=0.6:stop_threshold=-45dB,loudnorm=I=-18:TP=-2',
                '-ar', '24000', '-ac', '1', '-t', '30', ref], check=True)

md = open(os.path.join(HERE, 'VOICEOVER.md'), encoding='utf-8').read().replace('\r\n', '\n')
blocks = [re.sub(r'\s+', ' ', m.group(1)).strip()
          for m in re.finditer(r'\*\*\d\. [^*]+\*\*[^\n]*\n\n([\s\S]*?)(?=\n\n\*\*\d\. |\s*$)', md)]
assert len(blocks) == 8, f'found {len(blocks)} blocks in VOICEOVER.md'

torch.manual_seed(a.seed)
model = ChatterboxTTS.from_pretrained(device='cuda' if torch.cuda.is_available() else 'cpu')
sr = model.sr
gap = lambda s: torch.zeros(1, int(sr * s))

out, spans, t = [gap(0.5)], [], 0.5
for i, text in enumerate(blocks, 1):
    for k, v in SAY.items():
        text = text.replace(k, v)
    sentences = [s.strip() for s in re.findall(r'[^.!?]+[.!?]+|[^.!?]+$', text) if s.strip()]
    parts = []
    for s in sentences:
        wav = model.generate(s, audio_prompt_path=ref, exaggeration=a.exaggeration, cfg_weight=a.cfg)
        parts += [wav.cpu(), gap(0.22)]
    block = torch.cat(parts[:-1], dim=1)
    ta.save(os.path.join(HERE, 'voice', f'block{i}.wav'), block, sr)
    d = block.shape[1] / sr
    spans.append([round(t, 3), round(t + d, 3)])
    out += [block, gap(2.0)]
    t += d + 2.0
    print(f'block {i}: {d:.1f} s')

ta.save(os.path.join(HERE, 'voice', 'narration.wav'), torch.cat(out, dim=1), sr)
json.dump(spans, open(os.path.join(HERE, 'takes', 'blocks.json'), 'w'))
print(f'narration: {t:.1f} s -> voice/narration.wav; block timings -> takes/blocks.json')
