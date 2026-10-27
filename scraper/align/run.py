#!/usr/bin/env python3
"""
run.py — align every recording that has poetry to a measured word timeline.

    python -m scraper.align.run --report
    python -m scraper.align.run --track t0 --force
    python -m scraper.align.run --limit 10 --model small
    python -m scraper.align.run --all --model medium --device cuda
    python -m scraper.align.run --all --shard 2/4

Output
    public/timings/<trackId>.json     what the browser fetches (v3)
    public/timings/index.json         availability + quality manifest
    data/align/<trackId>.debug.json   ASR + match evidence, for review

Resumable: a v3 file with method "asr" is never recomputed unless --force.
Text-first: a track with no ghazal is skipped, not guessed at.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "timings"
DEBUG = DATA / "align"
PUBLIC.mkdir(parents=True, exist_ok=True)
DEBUG.mkdir(parents=True, exist_ok=True)

MIN_SCORE = 0.30


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_catalog() -> dict:
    return load_json(DATA / "catalog.json")


def load_index() -> dict:
    p = PUBLIC / "index.json"
    if not p.exists():
        return {"v": 3, "tracks": {}}
    try:
        doc = load_json(p)
        doc.setdefault("tracks", {})
        return doc
    except Exception:
        return {"v": 3, "tracks": {}}


def save_index(index: dict) -> None:
    index["v"] = 3
    index["generated"] = utc()
    (PUBLIC / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )


def untimed(doc: dict) -> bool:
    return not doc.get("shers")


def key_of(track: dict) -> str:
    """Stable across catalogue rebuilds; falls back for old catalogues."""
    return track.get("tkey") or track["id"]


def write_timing(track_id: str, doc: dict, index: dict) -> None:
    """Persist a v3 document and update the manifest entry."""
    doc["trackId"] = track_id
    path = PUBLIC / f"{track_id}.json"
    if untimed(doc):
        path.unlink(missing_ok=True)
        index["tracks"].pop(track_id, None)
        return
    path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    q = doc.get("quality") or {}
    index["tracks"][track_id] = {
        "q": q.get("score", 0),
        "m": doc.get("method", "asr"),
        "d": doc.get("duration", 0),
        "n": len(doc.get("shers", [])),
    }


def gap_key(title: str) -> str:
    import re

    t = re.sub(r"^\s*\d{1,3}\s*[-._)]?\s*", "", title or "")
    t = re.sub(r"[^a-z0-9]+", " ", t.lower())
    return re.sub(r"\s+", " ", t).strip()


def text_gaps(cat: dict) -> list[dict]:
    """Distinct titles with no poem — the actual shopping list for harvesting."""
    buckets: dict[str, dict] = {}
    for t in cat.get("tracks", []):
        if t.get("ghazalId"):
            continue
        k = gap_key(t.get("title", ""))
        if len(k) < 8:
            continue
        b = buckets.setdefault(k, {"key": k, "title": t.get("title", ""), "artist": t.get("artist", ""), "count": 0, "ids": []})
        b["count"] += 1
        b["ids"].append(t.get("id"))
    return sorted(buckets.values(), key=lambda b: -b["count"])


def report(cat: dict, index: dict) -> None:
    tracks = cat.get("tracks", [])
    with_text = [t for t in tracks if t.get("ghazalId")]
    aligned = [t for t in with_text if key_of(t) in index["tracks"]]
    print("Ghazal — lyric sync coverage")
    print("=" * 62)
    print(f"tracks                 {len(tracks):6d}")
    print(f"tracks with poetry     {len(with_text):6d}  ({len(with_text) / max(1, len(tracks)):.1%})")
    print(f"tracks with timing     {len(aligned):6d}  ({len(aligned) / max(1, len(with_text)):.1%} of poems)")
    by_method: dict[str, int] = {}
    for t in aligned:
        m = index["tracks"][key_of(t)].get("m", "?")
        by_method[m] = by_method.get(m, 0) + 1
    for m, n in sorted(by_method.items()):
        print(f"  {m:12s}          {n:6d}")
    scores = sorted((index["tracks"][key_of(t)].get("q", 0), t["id"]) for t in aligned)
    if scores:
        print(f"quality  min/median/max  {scores[0][0]:.2f} / {scores[len(scores) // 2][0]:.2f} / {scores[-1][0]:.2f}")
    missing = [t for t in with_text if key_of(t) not in index["tracks"]]
    if missing:
        print(f"\nnext up ({len(missing)}):")
        for t in missing[:12]:
            print(f"  {t['id']:6s} {t['title'][:46]:46s} {t['duration']:4d}s")
    no_text = len(tracks) - len(with_text)
    if no_text:
        gaps = text_gaps(cat)
        print(
            f"\n{no_text} recordings have no poem attached yet "
            f"({len(gaps)} distinct titles). Sync needs text first:\n"
            "  python scraper/harvest_by_title.py   # targeted Rekhta harvest\n"
            "  python scraper/build_catalog.py      # relink titles to poems"
        )


def main() -> int:
    ap = argparse.ArgumentParser(description="Measure per-word lyric timings for ghazal recordings.")
    ap.add_argument("--track", help="one track id")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--model", default="small", help="tiny/base/small/medium/large-v3")
    ap.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda"])
    ap.add_argument("--compute", default=None, help="int8 / float16 / int8_float16")
    ap.add_argument("--shard", default="", help="i/n — process every n-th track")
    ap.add_argument("--report", action="store_true")
    ap.add_argument("--gaps", action="store_true", help="write data/text-gaps.json")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    cat = load_catalog()
    index = load_index()

    if args.gaps:
        gaps = text_gaps(cat)
        (DATA / "text-gaps.json").write_text(
            json.dumps(gaps, ensure_ascii=False, indent=1), encoding="utf-8"
        )
        print(f"{len(gaps)} distinct titles -> data/text-gaps.json")
        for g in gaps[:20]:
            print(f"  {g['count']:3d}x  {g['title'][:64]}")
        return 0

    if args.report or (not args.track and not args.all and not args.limit):
        report(cat, index)
        return 0

    ghazals = {g["id"]: g for g in cat.get("ghazals", [])}
    targets = [t for t in cat["tracks"] if t.get("ghazalId") in ghazals]
    if args.track:
        targets = [t for t in targets if args.track in (t["id"], key_of(t))]
        if not targets:
            print(f"!! {args.track} has no linked poem")
            return 1

    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        targets = [t for k, t in enumerate(targets) if k % n == i]

    if args.limit:
        targets = targets[: args.limit]

    print(f"Aligning {len(targets)} recording(s) · model={args.model} device={args.device}")
    if args.dry_run:
        for t in targets:
            print(f"  {t['id']:6s} {t['title'][:50]:50s} {t['duration']:4d}s")
        return 0

    # imported here so --report works without ctranslate2 installed
    from .asr import cache_words, ensure_audio, load_cached_words, transcribe, detect_script
    from .core import align
    from .text import build_refs

    done = failed = skipped = 0
    t_start = time.time()

    for n, track in enumerate(targets, 1):
        tid = track["id"]
        key = key_of(track)
        gh = ghazals[track["ghazalId"]]

        if not args.force and key in index["tracks"] and index["tracks"][key].get("m") in ("asr", "manual"):
            print(f"[{n}/{len(targets)}] cached  {track['title'][:46]}")
            skipped += 1
            continue

        audio = ensure_audio(track)
        if not audio:
            print(f"[{n}/{len(targets)}] NO AUDIO {track['title'][:40]}")
            failed += 1
            continue

        print(f"[{n}/{len(targets)}] {track['title'][:46]}  ({track['duration']}s)")

        cached = None if args.force else load_cached_words(audio, args.model)
        if cached:
            words, meta = cached
            print(f"    transcript cached · {len(words)} words")
        else:
            t0 = time.time()
            words, meta = transcribe(
                audio, model_size=args.model, device=args.device, compute=args.compute
            )
            cache_words(audio, words, meta, args.model)
            print(f"    transcribed {len(words)} words in {time.time() - t0:.0f}s")

        if not words:
            print("    ! empty transcript — skipped")
            failed += 1
            continue

        script = detect_script(words)
        refs = build_refs(gh, script)
        if not refs:
            print(f"    ! no {script} reference lines")
            failed += 1
            continue

        duration = float(meta.get("duration") or track.get("duration") or 0)
        t0 = time.time()
        doc = align(words, refs, script, duration)
        doc["trackId"] = tid
        doc["tkey"] = key
        doc["asr"] = {k: meta.get(k) for k in ("language", "language_probability", "model", "device")}
        doc["script"] = script

        q = (doc.get("quality") or {}).get("score", 0)
        print(
            f"    aligned {len(doc['shers'])} occurrence(s) · q={q:.2f} "
            f"· {time.time() - t0:.1f}s"
        )

        (DEBUG / f"{key}.debug.json").write_text(
            json.dumps(
                {
                    "track": {"id": tid, "title": track["title"], "artist": track["artist"], "url": track["url"]},
                    "asr": meta,
                    "script": script,
                    "words": [{"s": round(w.start, 2), "e": round(w.end, 2), "t": w.text} for w in words],
                    "timing": doc,
                },
                ensure_ascii=False,
                separators=(",", ":"),
            ),
            encoding="utf-8",
        )

        if q < MIN_SCORE or untimed(doc):
            print(f"    ! below gate ({q:.2f} < {MIN_SCORE}) — not published")
            failed += 1
        else:
            write_timing(key, doc, index)
            done += 1

        if n % 5 == 0:
            save_index(index)

    save_index(index)
    elapsed = time.time() - t_start
    print("\n" + "=" * 62)
    print(f"published {done} · skipped {skipped} · failed/gated {failed} · {elapsed / 60:.1f} min")
    report(cat, index)
    return 0


if __name__ == "__main__":
    sys.exit(main())
