"""Prototype: can we align known Rekhta couplets to a real recording?

Steps
  1. pick a catalogue track that has a matched ghazal
  2. download the audio (cached)
  3. transcribe with word timestamps
  4. fuzzy-match the known couplet lines into that transcript
  5. report how many of the ghazal's shers actually appear, with times
"""
import json, re, sys, io, subprocess, unicodedata
from difflib import SequenceMatcher
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

CACHE = Path('data/.audio')
CACHE.mkdir(parents=True, exist_ok=True)

cat = json.load(open('data/catalog.json', encoding='utf-8'))
gh = {g['id']: g for g in cat['ghazals']}

cands = [t for t in cat['tracks'] if t.get('ghazalId')]
# prefer ones with several shers
cands.sort(key=lambda t: -len(gh.get(t['ghazalId'], {}).get('shers', [])))
print('candidates:', len(cands))
for t in cands[:5]:
    g = gh[t['ghazalId']]
    print(f"  {t['duration']:5d}s  {t['title'][:40]:40s} shers={len(g['shers'])}  {t['artist'][:20]}")

target = cands[0]
g = gh[target['ghazalId']]
print('\n>>> chosen:', target['title'], '|', target['artist'])
print('    ghazal:', g['titleRoman'], '| shers:', len(g['shers']))
print('    url:', target['url'][:100])

# --- download ---------------------------------------------------------------
name = re.sub(r'[^A-Za-z0-9]+', '_', target['id'])[:80] + '.mp3'
local = CACHE / name
if not local.exists() or local.stat().st_size < 10000:
    print('\ndownloading...', flush=True)
    r = subprocess.run(['curl', '-sL', '--max-time', '600', '-o', str(local), target['url']],
                       capture_output=True, text=True)
    print('  curl rc=', r.returncode, 'size=', local.stat().st_size if local.exists() else 0)
else:
    print('\ncached:', local, local.stat().st_size, 'bytes')

# --- transcribe -------------------------------------------------------------
from faster_whisper import WhisperModel

print('\nloading whisper (cuda)...', flush=True)
model = WhisperModel('small', device='cuda', compute_type='float16')

print('transcribing...', flush=True)
segments, info = model.transcribe(
    str(local), language='ur', beam_size=5, word_timestamps=True,
    vad_filter=True, condition_on_previous_text=False,
)
print('detected:', info.language, f'prob={info.language_probability:.2f}', 'dur=', info.duration)

words = []
for seg in segments:
    for w in (seg.words or []):
        t = w.word.strip()
        if t:
            words.append((w.start, w.end, t))

print('words transcribed:', len(words))
print('\nfirst 60 words with times:')
for s, e, w in words[:60]:
    print(f'  {s:7.2f}-{e:7.2f}  {w}')
