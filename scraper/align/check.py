#!/usr/bin/env python3
"""
check.py — independent verification of the published timing files.

This does not trust the aligner's own score. It re-reads every file and tests
the invariants the browser depends on:

  * `i` points at a real written couplet (the old bug: it pointed at a timeline slot)
  * occurrences are chronological and do not overlap
  * each line window sits inside its occurrence
  * word spans are ordered and inside their line
  * a repetition actually repeats a known couplet

    python scraper/align/check.py
    python scraper/align/check.py --track t0
    python scraper/align/check.py --worst 15
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "timings"


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def check_one(tid: str, doc: dict, n_written: int) -> list[str]:
    errs: list[str] = []
    shers = doc.get("shers") or []
    if not shers:
        return [f"{tid}: no shers"]

    prev_end = -1.0
    prev_key = (-1, -1)
    for k, s in enumerate(shers):
        i = s.get("i")
        if not isinstance(i, int) or i < 0 or i >= n_written:
            errs.append(f"{tid}: sher[{k}] i={i} outside 0..{n_written - 1}")
        a, b = s.get("start"), s.get("end")
        if a is None or b is None or b <= a:
            errs.append(f"{tid}: sher[{k}] bad span {a}..{b}")
            continue
        if a < prev_end - 0.03:
            errs.append(f"{tid}: sher[{k}] starts {prev_end - a:.2f}s before previous ends")
        prev_end = max(prev_end, b)

        key = (int(s.get("pass", 0)), int(i))
        if key < prev_key:
            errs.append(f"{tid}: sher[{k}] goes backwards {prev_key} -> {key}")
        prev_key = key

        for ln in s.get("lines") or []:
            m = ln.get("m")
            la, lb = ln.get("start"), ln.get("end")
            if la is None or lb is None or lb <= la:
                errs.append(f"{tid}: sher[{k}] line{m} bad span")
                continue
            if la < a - 0.6 or lb > b + 0.6:
                errs.append(f"{tid}: sher[{k}] line{m} outside occurrence")
            words = ln.get("words") or []
            if words and len(words) != ln.get("ntok", len(words)):
                errs.append(f"{tid}: sher[{k}] line{m} token/span count mismatch")
            last = -1.0
            for w in words:
                if len(w) != 2 or w[1] <= w[0]:
                    errs.append(f"{tid}: sher[{k}] line{m} bad word span {w}")
                    break
                if w[0] < last - 0.05:
                    errs.append(f"{tid}: sher[{k}] line{m} words out of order")
                    break
                last = w[1]

    return errs


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--track")
    ap.add_argument("--worst", type=int, default=10)
    args = ap.parse_args()

    cat = load(DATA / "catalog.json", {})
    gh = {g["id"]: g for g in cat.get("ghazals", [])}
    tracks = {t["id"]: t for t in cat.get("tracks", [])}
    by_key = {(t.get("tkey") or t["id"]): t for t in cat.get("tracks", [])}
    index = load(PUBLIC / "index.json", {"tracks": {}})
    entries = index.get("tracks", {})

    if args.track:
        tid = args.track
        doc = load(PUBLIC / f"{tid}.json")
        if not doc and tid in tracks:
            tid = tracks[tid].get("tkey") or tid
            doc = load(PUBLIC / f"{tid}.json")
        if not doc:
            print(f"no timing file for {tid}")
            return 1
        t = tracks.get(tid) or by_key.get(tid, {})
        g = gh.get(t.get("ghazalId"), {})
        print(f"{tid} · {t.get('title')} · {t.get('artist')}")
        print(f"method={doc.get('method')} q={(doc.get('quality') or {}).get('score')} "
              f"duration={doc.get('duration')}")
        print(f"written shers={len(g.get('shers', []))} occurrences={len(doc.get('shers', []))}")
        for k, s in enumerate(doc.get("shers", [])):
            text = ""
            if 0 <= s["i"] < len(g.get("shers", [])):
                text = (g["shers"][s["i"]].get("r") or "").split("\n")[0][:44]
            print(f"  [{k:2d}] {s['start']:7.2f}-{s['end']:7.2f}  i={s['i']} pass={s.get('pass')}  {text}")
        errs = check_one(tid, doc, len(g.get("shers", [])))
        print("\nOK" if not errs else "\n".join(errs))
        return 0

    total = len(entries)
    bad: list[tuple[int, str, list[str]]] = []
    by_method: dict[str, int] = {}
    measured = 0
    for tid, meta in entries.items():
        doc = load(PUBLIC / f"{tid}.json")
        if not doc:
            bad.append((99, tid, ["missing file"]))
            continue
        t = tracks.get(tid) or by_key.get(tid, {})
        g = gh.get(t.get("ghazalId"), {})
        errs = check_one(tid, doc, len(g.get("shers", [])))
        by_method[doc.get("method", "?")] = by_method.get(doc.get("method", "?"), 0) + 1
        if any(ln.get("words") for s in doc.get("shers", []) for ln in s.get("lines") or []):
            measured += 1
        if errs:
            bad.append((len(errs), tid, errs))

    print(f"timing files        {total}")
    for m, n in sorted(by_method.items()):
        print(f"  {m:12s}      {n}")
    print(f"with word spans     {measured}")
    print(f"files with errors   {len(bad)}")

    if bad:
        print("\nworst:")
        for n, tid, errs in sorted(bad, reverse=True)[: args.worst]:
            print(f"  {tid}: {errs[0]}")
            for e in errs[1:3]:
                print(f"      {e}")

    print("\ncoverage")
    with_text = sum(1 for t in tracks.values() if t.get("ghazalId"))
    print(f"  poems / recordings  {with_text} / {len(tracks)}")
    print(f"  timed / poems       {total} / {with_text}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
