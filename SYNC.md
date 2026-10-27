# Lyric sync

The player used to change verses on a timer derived from the track duration. That
is not sync — it is a slideshow. This document describes what replaced it, how to
run it, and what "perfect" costs at 1,500 recordings.

## The contract

A lyric timestamp is either **measured** or it does not exist.

- `public/timings/<tkey>.json` holds a measured timeline (v3). `tkey` is a
  hash of the media URL, stored on every track by `scraper/migrate_keys.py`;
  positional ids (`t0`) would attach the wrong lyrics after a catalogue rebuild.
- If the file is absent, the player shows the poem as text and says
  `text only · not timed yet`. It never starts a fake timer.
- `method` is one of `asr` (automatic, measured), `manual` (a human tapped it),
  or `segmented` (legacy: real phrase boundaries, but not content-anchored —
  labelled `auto-timed · not yet content-verified` in the UI).

The old bug that made even the 22 timed recordings look broken: the timing
writer re-indexed `i` to the *timeline slot* after sorting, while the UI used it to
index `ghazal.shers`. After the first repetition, the app asked for couplet 11 of
a 5-couplet poem and rendered the fallback title card. `scraper/export_timings.py`
rebuilds `i` from `pass` + position and `lib/timing.ts` now keeps the written
index distinct from the occurrence index.

## The pipeline

```
audio ──► faster-whisper (word timestamps)
             │
             ▼
     candidate windows (start/end at breaths, 4–20 words)
             │
             ▼
     score every window against every plausible misra
       recall + precision + token order + character coverage
             │
             ▼
     longest-path DP: non-overlapping, poem order non-decreasing,
       repeats allowed only across a real break
             │
             ▼
     occurrences (written sher + pass + two misra windows)
             │
             ▼
     Needleman–Wunsch inside each misra → one span per display token
             │
             ▼
     public/timings/<tkey>.json  +  quality score
```

Design choices that matter:

- **VAD is off.** Silero VAD is trained on speech and removed roughly two thirds
  of a sung ghazal in testing. The aligner uses the transcript, not a speech
  detector, to decide what is singing.
- **Windows, not one global alignment.** A singer repeats, skips, and reorders
  shers. A single monotonic alignment cannot represent that; independent window
  scores plus an order-constrained path can.
- **Word spans are honest.** Matched ASR words keep their measured times;
  unmatched words are interpolated and the line is marked `estimated`. The UI
  only does word-by-word karaoke when `method === "asr"`, quality ≥ 0.5, and the
  line is not estimated. Otherwise it highlights whole misras.
- **A quality gate.** Below 0.30 the file is not published at all.

## Running it

```bash
# what do we have?
python scraper/align_cli.py --report

# one recording (cached ASR is reused; --force re-transcribes)
python scraper/align_cli.py --track t0 --force --model small

# a batch, resumed automatically
python scraper/align_cli.py --all --model small --device cpu
python scraper/align_cli.py --all --model medium --device cuda --shard 2/4

# re-align already-transcribed tracks after a scoring change (no ASR cost)
python scraper/align/repair.py

# independent audit of every published file
python scraper/align/check.py
python scraper/align/check.py --track t0   # catalog id or tkey
```

### Throughput (measured on this machine)

| path | one 5-minute recording | 1,000 recordings |
| :--- | ---: | ---: |
| CPU, `small`, int8 | ~8–10 min | ~6–7 days continuous |
| GPU, `medium` | ~30–60 s (estimated) | ~8–16 hours |
| human tap-sync | one pass of the audio (~5 min) | ~80–100 hours |

The CPU figure is measured (a 221 s track transcribed in 107 s, plus alignment).
The GPU figure needs cuBLAS/cuDNN installed; it is an estimate, not a benchmark.
The human figure is the honest cost of line-exact sync: you have to hear every
line to place it.

Outputs:

| path | purpose |
| :--- | :--- |
| `public/timings/<tkey>.json` | what the browser fetches, one track at a time |
| `public/timings/index.json` | availability + quality manifest (a few KB) |
| `data/align/<tkey>.debug.json` | transcript + evidence, for review |
| `data/.audio/` | downloaded audio and cached ASR per model |

Timing files are per track on purpose: 1,500 word-level timelines in the main
catalogue bundle would add tens of megabytes to first paint. The player fetches
the manifest once, then exactly one timing file per recording.

GPU: faster-whisper needs cuBLAS + cuDNN 9 for CUDA. On this machine the driver
is present but those DLLs are not, so the pipeline runs on CPU (`int8`). Install
`nvidia-cublas-cu12` and `nvidia-cudnn-cu12` before using `--device cuda`.

## The 1,500-recording problem

As of this build the catalogue has:

| | count |
| :--- | ---: |
| recordings | 1,500 |
| recordings with a poem attached | 30 |
| distinct poems | 26 |
| measured word-level timings | **30 / 30** (median quality 0.78) |
| validation errors | 0 |

You cannot sync lyrics that do not exist. **1470 recordings have no poem at
all.** No aligner, model, or front-end trick changes that; the corpus is the
ceiling. Two things raise it:

1. **Harvest text for the titles we own.** `scraper/harvest_by_title.py` walks
   Rekhta's poet listings and matches slugs against archive.org titles. It is
   the right shape but capped at five pages per poet. Raise the page cap and the
   poet list for a real run, then `python scraper/build_catalog.py`.
2. **Match more of the 873 poems already on disk.** The current matcher requires
   a squashed prefix of the title. A token-set + phonetic matcher can link more
   recordings to text we already have; measure before trusting it.

## Guaranteed sync: the tap studio

Automatic alignment is a first pass. For a recording that must be exact, use the
studio:

```
http://localhost:3000/sync
```

1. Pick a recording (only tracks with a poem appear).
2. Press play.
3. Press **Space** at the instant each misra begins. The line you are about to
   tap is always the large one in the centre.
4. `R` repeats the previous sher, `S` skips a line, `Backspace` undoes.
5. **Export** → drop the JSON into `data/taps/` → `python scraper/import_taps.py`.

The export is a normal v3 file with `method: "manual"` and quality ≈ 0.9. The
player treats it as line-synced (no intra-line karaoke), which is exactly what a
human tap can guarantee.

Cost: a 5-couplet recording takes 10 taps and one pass of the audio — about
five minutes. 1,000 recordings is therefore roughly 80–100 hours of listening.
The automatic pass exists to make that shorter (only review the tracks whose
score is low), not to pretend it is zero.

## Verification

- `npm test` — lookup/normalisation invariants plus catalogue projection and
  queue-filter tests.
- `npm run verify:data` — the catalogue, media keys, poem references and every
  published timing file are cross-checked before a build.
- `npm run typecheck`, `npm run lint` and `npm run build` (or `npm run check`).
- `python scraper/align/check.py` — every published file is re-read and checked
  for out-of-range `i`, overlaps, backwards passes, line windows outside their
  occurrence, and word spans out of order.
- `data/align/<tkey>.debug.json` keeps the transcript, so a bad match can be
  explained rather than guessed at.

## In the player

- `audio.currentTime` is read inside `requestAnimationFrame`, not `timeupdate`
  (4 Hz). The media element stays the clock; pause/seek/buffer need no extra
  state.
- `lib/useAudioClock.ts` drives only the lyric subtree, so 60 fps updates do not
  re-render the player.
- `lib/timing.ts` does binary searches for occurrence → misra → word.
- `[` and `]` nudge the lyric clock by 50 ms for the current recording and
  persist it in `localStorage`; `\` resets.
- The timed-only toggle in the playlist drawer rebuilds the transport queue, so
  prev/next and the gapless preloader stay inside measured recordings.
- Media Session publishes the recording to the lock screen and maps headphone
  play/pause/next onto the same transport.
- `/timings/index.json` is revalidated on each visit; a per-track file is cached
  for a day, and the next recording's timeline is prefetched while the current
  one plays. This absorbs output latency and any
  constant offset the aligner missed.
- During an interlude the last couplet stays on screen at reduced opacity, the
  next couplet is previewed faintly, and a progress hairline shows the gap. The
  screen never goes blank between verses.
