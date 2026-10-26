#!/usr/bin/env python3
"""
repair.py — re-run the aligner over already-transcribed recordings.

Use after changing the matching/scoring code: the expensive ASR is cached next
to the audio, so a repair is seconds per track, not minutes. It never downloads
or transcribes anything.

    python scraper/align/repair.py
    python scraper/align/repair.py --model small
    python scraper/align/repair.py --key d9e0133ab17ca61a
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "timings"

sys.path.insert(0, str(ROOT))


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="small")
    ap.add_argument("--key")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    from scraper.align.asr import detect_script, ensure_audio, load_cached_words
    from scraper.align.core import align
    from scraper.align.text import build_refs

    cat = json.loads((DATA / "catalog.json").read_text(encoding="utf-8"))
    gh = {g["id"]: g for g in cat["ghazals"]}
    index = json.loads((PUBLIC / "index.json").read_text(encoding="utf-8"))
    entries = index.setdefault("tracks", {})

    # Scan the files, not just the manifest: a crashed batch may have written
    # an ASR file before saving the index.
    targets = []
    for path in sorted(PUBLIC.glob("*.json")):
        if path.name == "index.json":
            continue
        if args.key and path.stem != args.key:
            continue
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        if doc.get("method") == "asr":
            targets.append((path.stem, doc.get("quality") or {}))
    if not targets:
        print("no ASR timings to repair")
        return 0

    by_key = {(t.get("tkey") or t["id"]): t for t in cat["tracks"]}
    done = failed = 0

    for key, meta in targets:
        track = by_key.get(key)
        if not track or not track.get("ghazalId"):
            print(f"!! {key}: no track/poem")
            failed += 1
            continue
        audio = ensure_audio(track)
        if not audio:
            print(f"!! {key}: no audio")
            failed += 1
            continue
        cached = load_cached_words(audio, args.model)
        if not cached:
            print(f"!! {key}: no cached {args.model} transcript")
            failed += 1
            continue
        words, asr_meta = cached
        script = detect_script(words)
        refs = build_refs(gh[track["ghazalId"]], script)
        doc = align(words, refs, script, asr_meta.get("duration") or track.get("duration") or 0)
        doc["trackId"] = track["id"]
        doc["tkey"] = key
        q = (doc.get("quality") or {}).get("score", 0)
        print(f"{key}  q={q:.3f}  occ={len(doc.get('shers', []))}  {track['title'][:40]}")
        if args.dry_run:
            continue
        (PUBLIC / f"{key}.json").write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        if q >= 0.30 and doc.get("shers"):
            entries[key] = {"q": q, "m": "asr", "d": doc.get("duration", 0), "n": len(doc["shers"])}
            done += 1
        else:
            failed += 1

    if not args.dry_run:
        index["v"] = 3
        index["generated"] = utc()
        (PUBLIC / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    print(f"\nrepaired {done} · failed {failed}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
