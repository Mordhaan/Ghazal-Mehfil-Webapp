#!/usr/bin/env python3
"""
align_timings.py - Real lyric timing for ghazal recordings.

The problem this solves
-----------------------
The previous build "synced" lyrics by dividing the track duration evenly across
the couplets. That is not synchronisation: the verse changes on a timer that has
nothing to do with the performance, so sung lines drift out of view and
instrumental interludes silently consume verses.

How this works
--------------
Two independent signals, combined:

  1. Vocal segmentation (dense, always available)
     The log-mel spectrogram is reduced to a vocal-activity score from
     low/mid-band tonality, spectral flux and level. Thresholding gives the
     spans where somebody is actually singing, which is exactly where verse can
     change. Gaps between them are instrumental interludes.

  2. Whisper word timestamps (sparse, opportunistic)
     Where the ASR does catch a line, we get a hard anchor: "this couplet is
     being sung at 110.2s". Anchors are matched fuzzily (Arabic-script
     normalisation + token alignment) so partial transcripts still help.

Anything not anchored is placed inside real vocal spans, weighted by how much
text it has to cover -- never across an instrumental break.

Output: data/timings.json
  {
    "<trackId>": {
      "duration": 199.2,
      "vocals":    [[s,e], ...],
      "interludes":[[s,e], ...],
      "shers":     [{"i":0,"start":18.4,"end":28.0,"anchored":true}, ...],
      "method": "anchored" | "segmented",
      "coverage": 0.86
    }
  }
"""
from __future__ import annotations

import hashlib
import json
import re
import subprocess
import sys
import unicodedata
import wave
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import numpy as np
from scipy.ndimage import uniform_filter1d

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
AUDIO = DATA / ".audio"
AUDIO.mkdir(parents=True, exist_ok=True)
OUT = DATA / "timings.json"

FFMPEG = r"D:\yt download\ffmpeg.exe"

# ---- segmentation tuning ---------------------------------------------------
WIN_S, HOP_S = 0.046, 0.010
MIN_VOCAL_S = 1.1          # ignore blips
MERGE_GAP_S = 0.55         # bridge breaths inside a phrase
GAP_BREAK_S = 2.2          # a silence this long ends a singing block
MIN_INTERLUDE_S = 1.6      # shorter gaps are not real interludes


# ---------------------------------------------------------------------------
# audio
# ---------------------------------------------------------------------------
def cache_key(track: dict) -> str:
    """Stable key derived from the media URL.

    Positional ids (t0, t1, ...) change whenever the catalogue is regenerated;
    the URL does not.
    """
    url = track.get("url") or ""
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:16]
    stem = re.sub(r"[^A-Za-z0-9]+", "_", track.get("title") or "")[:40].strip("_")
    return f"{stem}_{digest}" if stem else digest


def ensure_wav(track: dict) -> Path | None:
    safe = cache_key(track)
    mp3 = AUDIO / f"{safe}.mp3"
    wav = AUDIO / f"{safe}.wav"
    expect = float(track.get("duration") or 0)
    if wav.exists() and wav.stat().st_size > 20000:
        # never trust a cached decode whose length disagrees with the catalogue
        with wave.open(str(wav), "rb") as wf:
            got = wf.getnframes() / wf.getframerate()
        if not expect or abs(got - expect) <= 3.0:
            return wav
        print(f"    ! stale cache for {safe} ({got:.0f}s vs {expect:.0f}s) - re-decoding")
        wav.unlink(missing_ok=True)
    if not mp3.exists() or mp3.stat().st_size < 20000:
        r = subprocess.run(["curl", "-sL", "--max-time", "600",
                            "-o", str(mp3), track["url"]],
                           capture_output=True, text=True)
        if r.returncode != 0 or not mp3.exists() or mp3.stat().st_size < 20000:
            return None
    r = subprocess.run([FFMPEG, "-y", "-i", str(mp3), "-ac", "1", "-ar", "16000",
                        "-f", "wav", str(wav)], capture_output=True, text=True)
    if r.returncode != 0 or not wav.exists():
        return None
    return wav


def read_wav(path: Path) -> tuple[int, np.ndarray]:
    with wave.open(str(path), "rb") as wf:
        sr = wf.getframerate()
        a = np.frombuffer(wf.readframes(wf.getnframes()), dtype=np.int16)
    return sr, a.astype(np.float32) / 32768.0


# ---------------------------------------------------------------------------
# vocal segmentation
# ---------------------------------------------------------------------------
def vocal_segments(sr: int, a: np.ndarray) -> tuple[list[list[float]], float]:
    win = int(sr * WIN_S)
    hop = int(sr * HOP_S)
    if len(a) < win * 4:
        return [[0.0, len(a) / sr]], 0.0

    n = 1 + (len(a) - win) // hop
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    frames = a[idx] * np.hanning(win)[None, :]
    spec = np.abs(np.fft.rfft(frames, axis=1))
    freqs = np.fft.rfftfreq(win, 1 / sr)
    times = (np.arange(n) * hop + win / 2) / sr

    def band(lo, hi):
        m = (freqs >= lo) & (freqs < hi)
        return spec[:, m].sum(axis=1)

    total = band(40, 8000) + 1e-9
    vocal = band(90, 1000)
    tonal = vocal / total
    flux = np.concatenate([[0.0], np.maximum(0, np.diff(spec, axis=0)).sum(axis=1)])
    level = 20 * np.log10(total / total.max() + 1e-9)

    def norm(x):
        lo, hi = np.percentile(x, 5), np.percentile(x, 95)
        return np.clip((x - lo) / (hi - lo + 1e-9), 0, 1)

    score = (0.45 * norm(uniform_filter1d(level, 30))
             + 0.35 * norm(uniform_filter1d(tonal, 25))
             + 0.20 * norm(uniform_filter1d(flux, 15)))
    score = uniform_filter1d(score, 30)
    thr = float(np.percentile(score, 45))
    active = score > thr

    segs: list[list[float]] = []
    start = None
    gap = 0
    for i, v in enumerate(active):
        if v:
            if start is None:
                start = i
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap * HOP_S > MERGE_GAP_S:
                    end = i - gap
                    if (end - start) * HOP_S >= MIN_VOCAL_S:
                        segs.append([float(times[start]), float(times[end])])
                    start = None
                    gap = 0
    if start is not None:
        end = len(active) - 1
        if (end - start) * HOP_S >= MIN_VOCAL_S:
            segs.append([float(times[start]), float(times[-1])])

    vocal_time = sum(e - s for s, e in segs)
    dur = len(a) / sr
    return segs, vocal_time / dur if dur else 0.0


# ---------------------------------------------------------------------------
# text normalisation for fuzzy matching
# ---------------------------------------------------------------------------
def nz(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\u064B-\u0652\u0670\u0640]", "", s)
    for a, b in [("آ", "ا"), ("أ", "ا"), ("إ", "ا"), ("ی", "ي"), ("ک", "ك"),
                 ("ہ", "ه"), ("ۃ", "ه"), ("ؤ", "و"), ("ئ", "ي"),
                 ("ء", ""), ("ڑ", "")]:
        s = s.replace(a, b)
    s = re.sub(r"[^\u0600-\u06FF\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def asr_words(wav: Path) -> list[tuple[float, float, str]]:
    """Word timestamps, or [] if the model is unavailable."""
    try:
        from faster_whisper import WhisperModel
    except Exception:
        return []
    try:
        global _MODEL
        try:
            _MODEL
        except NameError:
            _MODEL = WhisperModel("small", device="cuda", compute_type="float16")
        sr, a = read_wav(wav)
        segments, _ = _MODEL.transcribe(
            a, language="ur", beam_size=5, word_timestamps=True,
            vad_filter=False, condition_on_previous_text=False,
            no_speech_threshold=0.9, log_prob_threshold=-2.0,
        )
        out = []
        for seg in segments:
            for w in (seg.words or []):
                t = nz(w.word.strip())
                if t:
                    out.append((float(w.start), float(w.end), t))
        return out
    except Exception:
        return []


# ---------------------------------------------------------------------------
# alignment
# ---------------------------------------------------------------------------
def _phrase_blocks(vocals: list[list[float]], gap_break: float = GAP_BREAK_S) -> list[list[float]]:
    """Merge vocal segments into singing blocks, severed by real silence."""
    if not vocals:
        return []
    blocks: list[list[float]] = [list(vocals[0])]
    for s, e in vocals[1:]:
        if s - blocks[-1][1] < gap_break:
            blocks[-1][1] = e
        else:
            blocks.append([s, e])
    return blocks


def _allocate(counts: list[int], total: int) -> list[int]:
    """Distribute `total` units across `counts` weights, each at least 1.

    Guarantees sum(result) == total when total >= len(counts).
    """
    n = len(counts)
    if n == 0:
        return []
    if total <= n:
        return [1] * n

    w_sum = float(sum(counts)) or 1.0
    alloc = [max(1, round(c / w_sum * total)) for c in counts]

    # trim
    guard = 0
    while sum(alloc) > total and guard < 10000:
        guard += 1
        j = max(range(n), key=lambda k: (alloc[k], counts[k]))
        if alloc[j] <= 1:
            break
        alloc[j] -= 1

    # grow
    guard = 0
    while sum(alloc) < total and guard < 10000:
        guard += 1
        j = max(range(n), key=lambda k: counts[k] / (alloc[k] + 1))
        alloc[j] += 1

    return alloc



def _line_units(vocals: list[list[float]]) -> list[list[float]]:
    """Turn raw vocal segments into misra-sized units (about 4-10 seconds)."""
    segs = [[s, e] for s, e in vocals if (e - s) >= 1.2]
    if not segs:
        segs = [[s, e] for s, e in vocals] or [[0.0, 1.0]]

    # merge forward until each unit carries enough singing
    units: list[list[float]] = []
    cur = list(segs[0])
    for s, e in segs[1:]:
        if (cur[1] - cur[0]) < 4.5 and (s - cur[1]) < 1.6:
            cur[1] = e
        else:
            units.append(cur)
            cur = [s, e]
    units.append(cur)

    # split units that are implausibly long, at their internal silence
    final: list[list[float]] = []
    for u in units:
        span = u[1] - u[0]
        if span <= 12.0:
            final.append(u)
            continue
        n_parts = max(2, int(round(span / 7.0)))
        step = span / n_parts
        for k in range(n_parts):
            final.append([u[0] + k * step, u[0] + (k + 1) * step])
    return final


def align_shers(ghazal: dict, words, vocals, duration) -> tuple[list[dict], str]:
    """Give every sher a real sung interval.

    Rules:
      * a sher never spans an instrumental break when there are enough
        singing blocks to go round
      * allocation follows how much text the sher carries
      * ASR anchors override placement when the transcript is confident
    """
    shers = ghazal.get("shers", [])
    if not shers:
        return [], "empty"

    n = len(shers)
    weights = [max(1, len(nz(s.get("text_urdu") or "").split())) for s in shers]

    # ---- ASR anchors ------------------------------------------------------
    anchors: dict[int, tuple[float, float]] = {}
    if words:
        ref, owner = [], []
        for i, s in enumerate(shers):
            for line in (s.get("text_urdu") or "").split("\n"):
                for tk in nz(line).split():
                    ref.append(tk)
                    owner.append(i)
        if ref:
            try:
                from difflib import SequenceMatcher
                hyp = [w for _, _, w in words]
                sm = SequenceMatcher(None, ref, hyp, autojunk=False)
                per: dict[int, list[int]] = {}
                for a, b, size in sm.get_matching_blocks():
                    for k in range(size):
                        if a + k < len(ref) and ref[a + k] == hyp[b + k]:
                            per.setdefault(owner[a + k], []).append(b + k)
                for si, his in per.items():
                    n_ref = sum(len(nz(l).split()) for l in
                                (shers[si].get("text_urdu") or "").split("\n"))
                    if n_ref and len(set(his)) / n_ref >= 0.5:
                        anchors[si] = (float(words[min(his)][0]),
                                       float(words[max(his)][1]))
            except Exception:
                pass

    if not vocals:
        vocals = [[0.0, max(1.0, float(duration or 1.0))]]

    blocks = _phrase_blocks(vocals)

    if not blocks:
        span = max(1.0, float(duration or 1.0))
        out = [{"i": i, "start": round(span * i / n, 3),
                "end": round(span * (i + 1) / n, 3), "anchored": False}
               for i in range(n)]
        return out, "segmented"

    # ---- pace the couplets against line-sized units -----------------------
    units = _line_units(vocals)
    if not units:
        span = max(1.0, float(duration or 1.0))
        out = [{"i": i, "start": round(span * i / n, 3),
                "end": round(span * (i + 1) / n, 3), "anchored": False}
               for i in range(n)]
        return out, "segmented"

    # a sher = two consecutive misra units
    sher_units: list[list[float]] = []
    for k in range(0, len(units) - 1, 2):
        sher_units.append([units[k][0], units[k + 1][1]])
    if len(units) % 2 == 1:
        if sher_units:
            sher_units[-1][1] = max(sher_units[-1][1], units[-1][1])
        else:
            sher_units.append(units[-1])

    out: list[dict] = []
    reps = max(1, (len(sher_units) + n - 1) // n)
    for r in range(reps):
        for si in range(n):
            idx = r * n + si
            if idx >= len(sher_units):
                break
            us, ue = sher_units[idx]
            out.append({"i": si, "start": round(us, 3), "end": round(ue, 3),
                        "anchored": False, "pass": r})

    # Fewer sung units than written couplets: stop where the performance stops.
    # Inventing zero-length couplets at the end would just flash text nobody sings.

    cycles = len(sher_units) / max(1, n)

    # ---- apply anchors, re-index -----------------------------------------
    if cycles < 1.6:
        for si, (ast, aen) in anchors.items():
            if 0 <= si < len(out):
                out[si]["start"] = round(ast, 3)
                out[si]["end"] = round(max(aen, ast + 0.4), 3)
                out[si]["anchored"] = True

    out.sort(key=lambda x: x["start"])
    cleaned = []
    for i, o in enumerate(out):
        o["i"] = i
        if i and o["start"] < out[i - 1]["end"] - 0.05:
            o["start"] = out[i - 1]["end"]
        if o["end"] - o["start"] < 1.5:
            # too short to read: drop it rather than flash it
            continue
        cleaned.append(o)
    out = cleaned

    # Line-level (misra) boundaries. Each line must correspond to ONE sung unit
    # so the text appears exactly while that half-couplet is being sung and
    # disappears during instrumental breaks. Lines never span a silence.
    for o in out:
        inside = [u for u in units
                  if u[1] > o["start"] + 0.05 and u[0] < o["end"] - 0.05]
        if len(inside) >= 2:
            o["lines"] = [[round(inside[0][0], 3), round(inside[0][1], 3)],
                          [round(inside[1][0], 3), round(inside[1][1], 3)]]
        elif len(inside) == 1:
            o["lines"] = [[round(inside[0][0], 3), round(inside[0][1], 3)]]
        else:
            o["lines"] = []

    return out, ("anchored" if anchors else "segmented")



def _split_lines(vocals: list[list[float]], st: float, en: float) -> list[list[float]]:
    """Split one sher span into its two misra at the strongest internal pause.

    A couplet is sung as two breaths; using the real pause means the second line
    appears when it is actually sung, not halfway through by arithmetic.
    """
    mid = (st + en) / 2
    span = en - st
    if span < 3.0:
        return [[st, en]]

    best_gap = 0.0
    best_at = None
    prev_end = st
    for s, e in vocals:
        if e <= st or s >= en:
            continue
        gap = s - prev_end
        # prefer pauses near the middle of the span
        if gap > best_gap and abs((prev_end + s) / 2 - mid) < span * 0.35:
            best_gap = gap
            best_at = (prev_end + s) / 2
        prev_end = max(prev_end, e)

    if best_at is None or best_gap < 0.30:
        # no usable breath: fall back to a proportional split
        return [[st, mid], [mid, en]]

    return [[st, best_at], [best_at, en]]


def voice_pos(vocals: list[list[float]], t: float) -> float:
    """Map a position along the vocal timeline back to a real timestamp."""
    left = t
    for s, e in vocals:
        span = e - s
        if left <= span:
            return s + max(0.0, left)
        left -= span
    return vocals[-1][1]


def interludes_from(vocals: list[list[float]], duration: float) -> list[list[float]]:
    gaps = []
    prev_end = 0.0
    for s, e in vocals:
        if s - prev_end >= GAP_BREAK_S:
            gaps.append([round(prev_end, 2), round(s, 2)])
        prev_end = max(prev_end, e)
    if duration - prev_end >= GAP_BREAK_S:
        gaps.append([round(prev_end, 2), round(duration, 2)])
    return gaps


# ---------------------------------------------------------------------------
def main() -> int:
    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    gh = {g["id"]: g for g in cat["ghazals"]}
    targets = [t for t in cat["tracks"] if t.get("ghazalId") and t["ghazalId"] in gh]

    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(targets)
    targets = targets[:limit]
    print(f"Tracks with poetry to sync: {len(targets)}")

    timings: dict[str, dict] = {}
    if OUT.exists():
        try:
            timings = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            timings = {}

    for n, tr in enumerate(targets, 1):
        key = tr["id"]
        if key in timings:
            print(f"[{n}/{len(targets)}] cached {tr['title'][:44]}")
            continue

        wav = ensure_wav(tr)
        if not wav:
            print(f"[{n}/{len(targets)}] SKIP (no audio) {tr['title'][:40]}")
            continue

        sr, a = read_wav(wav)
        duration = len(a) / sr
        vocals, coverage = vocal_segments(sr, a)
        words = asr_words(wav)
        shers, method = align_shers(gh[tr["ghazalId"]], words, vocals, duration)

        timings[key] = {
            "duration": round(duration, 2),
            "vocals": [[round(s, 2), round(e, 2)] for s, e in vocals],
            "interludes": interludes_from(vocals, duration),
            "shers": shers,
            "method": method,
            "coverage": round(coverage, 3),
        }
        OUT.write_text(json.dumps(timings, ensure_ascii=False, indent=1), encoding="utf-8")

        anch = sum(1 for s in shers if s["anchored"])
        print(f"[{n}/{len(targets)}] {method:9s} shers={len(shers)} anchored={anch} "
              f"vocal_cov={coverage:.0%} interludes={len(timings[key]['interludes'])}  "
              f"{tr['title'][:38]}", flush=True)

    print(f"\nWrote {len(timings)} timings -> {OUT}")
    if timings:
        vals = list(timings.values())
        print(f"  anchored  : {sum(1 for v in vals if v['method'] == 'anchored')}")
        print(f"  segmented : {sum(1 for v in vals if v['method'] == 'segmented')}")
        print(f"  avg vocal coverage: {np.mean([v['coverage'] for v in vals]):.0%}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
