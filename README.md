# 🌙 Minimal Ghazal

A single-screen, ambient web player for Urdu ghazals — built for people who
discover this poetry at 3 AM, not in a syllabus.

Pick a mood. The screen becomes a mehfil: one couplet floating in the centre,
a frosted-glass capsule player at the bottom, and a live count of everyone
listening with you right now.

**This is a website** (runs in any browser, desktop or mobile). No React Native,
no app store, no install.

---

## Quick start

On Windows, double-click **`start.bat`** (or run `.\start.bat` in your terminal). It checks dependencies, starts the server, and automatically launches your browser.

Manual start:

```bash
npm install
npm run dev          # http://localhost:3000
```

Production:

```bash
npm run build
npm run start
```

No API keys, no accounts, no paid services.

---

## What actually works

| Feature | Status | How |
| :--- | :--- | :--- |
| Real ghazal audio streaming | ✅ | 1,500 tracks streamed from Internet Archive (HTTP 206, `Access-Control-Allow-Origin: *`) |
| Mood-based playlists | ✅ | 5 moods × 300 tracks, scored from title/artist/album keywords |
| Tri-script couplets (Urdu / Roman / Hindi) | ✅ | 877 ghazals crawled from Rekhta, 6,734 couplets |
| Live listener count | ✅ | Real SSE connection count — not a fake number (see below) |
| Spinning vinyl, seek bar, keyboard shortcuts | ✅ | Single shared `<audio>` element |
| Persisted mood / script / volume | ✅ | `localStorage` |
| Auto-skip on broken stream | ✅ | `onError` → toast → next track |
| Measured lyric timings | ✅ | Per-recording word/line spans; see [`SYNC.md`](./SYNC.md) |
| Tap-sync studio | ✅ | `/sync` — human-locked timing for any recording |

### Lyrics are measured, not guessed

The verse never changes on a timer. Each recording either has a measured
timeline in `public/timings/<tkey>.json` or the UI says
`text only · not timed yet` — there is no in-between. Timings come from
faster-whisper word timestamps matched against the poem with a windowed
longest-path aligner (`scraper/align/`), or from a human tapping lines in the
`/sync` studio. `[` / `]` nudge the lyric clock by 50 ms per recording when a
fixed offset is audible.

Coverage today: **30 of 1,500 recordings have a measured word-level timing** —
every recording that has a poem (median quality 0.78, zero validation errors).
The other 1,470 have no poem attached at all, so there is nothing to sync yet.
The bottleneck is text, not alignment — [`SYNC.md`](./SYNC.md) has the numbers
and the harvesting/tap-sync path to 1,000+.

### The "online" counter is real

`app/api/presence/route.ts` keeps a server-side `Map` of open SSE connections.
One browser tab = one connection.

- Open one tab → `1 in the mehfil`
- Open a second tab → both tabs immediately show `2`
- Close a tab → the count drops back to `1`
- Network drops → the UI says `reconnecting…` instead of displaying a stale number

Verified with raw sockets: two concurrent `GET /api/presence` requests returned
`{"count":1}` then `{"count":2}`, and the first connection received the update
when the second joined.

> **Serverless caveat:** this design needs a persistent Node process. On
> Vercel/Netlify the SSE connection is terminated at the function timeout and
> each invocation gets its own memory, so the count would be wrong. Deploy to a
> long-running Node host (or use a Redis-backed counter) if you go serverless.

---

## Data sources

| Source | Used for | Notes |
| :--- | :--- | :--- |
| [Internet Archive](https://archive.org) | **Audio** | Free/publicly streamable recordings. 75k+ candidate tracks harvested; filterd to ghazal-relevant. Each track links back to its `archive.org/details/<identifier>` item. |
| [Rekhta](https://www.rekhta.org) | **Poetry text** | Couplets in Urdu, Roman and Devanagari. Crawled politely (cached, throttled). Poetry remains Rekhta's content — attribute and link back. |
| [BestGhazals.net](https://www.bestghazals.net) | English meanings | Blogger JSON feed (`/feeds/posts/default?alt=json`, 370 posts). Used for reference; the live app does not depend on it. |

Sufinama.org was evaluated but is fully client-side rendered — its poetry is not
in the served HTML — so it is not used.

**Please respect these sites.** The scrapers cache every response under
`data/.cache/` and sleep between requests. Don't hammer them; don't redistribute
their poetry as your own.

---

## Rebuilding the data

The app reads `data/catalog.json`. To regenerate it:

```bash
# 1. audio — walks the Internet Archive search + metadata APIs
python scraper/harvest_audio.py        # -> data/tracks.raw.jsonl

# 2. poetry — walks Rekhta poet listings (AJAX paginated)
python scraper/harvest_rekhta.py       # -> data/ghazals.json

# 3. merge, score into moods, match couplets to recordings
python scraper/build_catalog.py        # -> data/catalog.json
```

All three are resumable and idempotent — every HTTP response is cached in
`data/.cache/`, so a re-run only fetches what is missing.

### How a track gets its couplet

Track titles on archive.org are messy (`08 Zindagi Yun Hui Basar Tanha`,
`RukJaKeSubahTakNaHoYehRaatAakhri`). The matcher:

1. folds Rekhta's diacritics (`baġhair` → `baghair`, `ḳhāna` → `khana`)
2. strips stopwords, spaces and punctuation, so `tum ko dekha`, `tumko-dekha`
   and `TumkoDekha` all collapse to one key
3. requires the title to be a **prefix** of a real couplet line, at least 14
   characters long

Prefix-anchoring matters: an earlier token-overlap matcher paired "Raat Bhar"
with an unrelated sher. Rejecting a weak match is better than showing wrong
poetry.

---

## Project layout

```
app/
  page.tsx                 server component; imports the catalogue
  layout.tsx               fonts, metadata, viewport
  globals.css              atmosphere, glass, nastaliq, vinyl, seek bar
  api/presence/route.ts    real SSE presence counter
components/
  GhazalStage.tsx          the whole single-screen experience
  Lyrics.tsx               rAF-driven couplet + word highlight + interlude state
lib/
  usePlayer.ts             playlist, transport, script + persistence
  useTiming.ts             per-recording timing fetch + cache
  useAudioClock.ts         animation-frame audio clock
  timing.ts                v3 timing model, normalisation, binary-search lookups
  usePresence.ts           SSE client with backoff and honest state
  types.ts                 shared types
public/
  timings/<tkey>.json      measured timing for one recording (URL key)
  timings/index.json       availability + quality manifest
data/
  moods.json               the 5 moods
  ghazals.json             877 ghazals × tri-script couplets
  catalog.json             what ships: 1,500 tracks + matching poetry
  timings.json             legacy phrase timings (migrated by export_timings.py)
  tracks.raw.jsonl         raw harvest (gitignored, ~42 MB)
  taps/                    tap-sync exports awaiting import
scraper/
  align/                   ASR → windowed alignment → v3 timings
  align_cli.py             entry point (works with PYTHONSAFEPATH)
  export_timings.py        migrate legacy timings, fix the `i` bug, build manifest
  import_taps.py           validate + publish tap-sync exports
  harvest_audio.py         Internet Archive harvester
  harvest_rekhta.py        Rekhta poetry harvester
  harvest_by_title.py      targeted top-up for known titles
  build_catalog.py         merge + mood scoring + text matching
```

`scraper/rea_extractor.py` is a leftover schema sketch from an earlier
experiment. It is not part of the pipeline and can be deleted.

---

## Design

Deliberately radical: `100dvh`, no scrolling, no routing, no search box.
One screen holds the clock, the presence badge, the mood pill, the couplet and
the player. Everything else is noise.

- **Type:** Noto Nastaliq Urdu for the couplet (RTL, generous leading),
  Cormorant Garamond for Roman, Noto Serif Devanagari for Hindi. System serif
  fallbacks so a failed font request never breaks layout.
- **Keys:** `Space` play/pause · `←/→` seek 10s · `Shift+←/→` prev/next · `M` mute
- **Reduced motion:** the vinyl and fades respect `prefers-reduced-motion`.

---

## Known limitations

- **Couplet coverage is partial.** 30 of 1,500 tracks have a matched poem.
  The rest fall back to showing the title and artist — never invented poetry.
  Improving this means harvesting more Rekhta pages for the specific titles we
  own audio of; the matcher is in place and measured, the corpus is the limit.
- **Timing coverage equals text coverage.** All 30 poem-bearing recordings have
  measured ASR timings (median quality 0.78); the remaining 1,470 have no poem,
  so they show title/artist only. `/sync` exists for any recording that must be
  line-exact, and `python scraper/align/check.py` audits every published file.
- **Title/artist metadata is uneven.** Archive.org filenames vary wildly; a
  share of tracks show `Various Artists` because the original upload did not
  name the performer.
- **Audio availability is not guaranteed.** Internet Archive occasionally
  returns 500 for an individual item. The player detects this and skips.
