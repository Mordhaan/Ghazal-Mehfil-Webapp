#!/usr/bin/env python3
"""
import_taps.py — publish tap-sync exports from `data/taps/` into the app.

The studio writes one v3 JSON per recording. This validates it (indices inside
the poem, chronological, non-overlapping), then installs it as the timing for
that track. Manual timings always win over an ASR pass: a person heard it.

    python scraper/import_taps.py
    python scraper/import_taps.py data/taps/t0.json
    python scraper/import_taps.py --dry-run
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
TAPS = DATA / "taps"
PUBLIC = ROOT / "public" / "timings"
PUBLIC.mkdir(parents=True, exist_ok=True)


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def validate(doc: dict, n_written: int) -> list[str]:
    errs: list[str] = []
    if doc.get("v") != 3:
        errs.append("not a v3 timing")
    if doc.get("method") != "manual":
        errs.append("method is not manual")
    shers = doc.get("shers") or []
    if not shers:
        return errs + ["no occurrences"]
    prev = -1.0
    for k, s in enumerate(shers):
        if not isinstance(s.get("i"), int) or not (0 <= s["i"] < n_written):
            errs.append(f"sher[{k}] i out of range")
        a, b = s.get("start"), s.get("end")
        if a is None or b is None or b <= a:
            errs.append(f"sher[{k}] bad span")
            continue
        if a < prev - 0.03:
            errs.append(f"sher[{k}] overlaps previous")
        prev = max(prev, b)
        for line in s.get("lines") or []:
            la, lb = line.get("start"), line.get("end")
            if la is None or lb is None or lb <= la:
                errs.append(f"sher[{k}] bad line")
            elif la < a - 0.4 or lb > b + 0.4:
                errs.append(f"sher[{k}] line outside occurrence")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", help="specific json files (default: data/taps/*.json)")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-overwrite-asr", action="store_true",
                    help="replace a higher-quality ASR timing with a manual one")
    args = ap.parse_args()

    cat = load(DATA / "catalog.json", {})
    gh = {g["id"]: g for g in cat.get("ghazals", [])}
    tracks = {t["id"]: t for t in cat.get("tracks", [])}
    index = load(PUBLIC / "index.json", {"v": 3, "tracks": {}})
    index.setdefault("tracks", {})

    paths = [Path(p) for p in args.files] if args.files else sorted(TAPS.glob("*.json"))
    if not paths:
        print(f"no tap files in {TAPS}")
        return 1

    ok = 0
    for path in paths:
        doc = load(path)
        if not doc:
            print(f"!! {path.name}: unreadable")
            continue
        tid = doc.get("trackId") or path.stem
        track = tracks.get(tid)
        if not track or not track.get("ghazalId"):
            print(f"!! {path.name}: track {tid} has no poem")
            continue
        n_written = len(gh.get(track["ghazalId"], {}).get("shers", []))
        errs = validate(doc, n_written)
        if errs:
            print(f"!! {path.name}: " + "; ".join(errs[:4]))
            continue

        key = track.get("tkey") or tid
        existing = index["tracks"].get(key, {})
        if (
            existing.get("m") == "asr"
            and existing.get("q", 0) > (doc.get("quality") or {}).get("score", 0)
            and not args.allow_overwrite_asr
        ):
            print(f"!! {path.name}: ASR timing scores higher — pass --allow-overwrite-asr")
            continue

        print(
            f"ok {tid}  {len(doc['shers'])} occurrences  "
            f"q={(doc.get('quality') or {}).get('score')}  {path.name}"
        )
        if args.dry_run:
            continue

        doc["v"] = 3
        doc["method"] = "manual"
        doc["trackId"] = tid
        doc["tkey"] = key
        (PUBLIC / f"{key}.json").write_text(
            json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        index["tracks"][key] = {
            "q": (doc.get("quality") or {}).get("score", 0.9),
            "m": "manual",
            "d": doc.get("duration", 0),
            "n": len(doc["shers"]),
        }
        ok += 1

    if not args.dry_run and ok:
        index["v"] = 3
        index["generated"] = utc()
        (PUBLIC / "index.json").write_text(
            json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
    print(f"\nimported {ok} / {len(paths)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
