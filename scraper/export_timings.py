#!/usr/bin/env python3
"""
export_timings.py — migrate the legacy `data/timings.json` into the v3 store.

The old file has a data bug worth naming: `i` was re-indexed to the *timeline
slot* after sorting, so it no longer pointed at the written couplet. The web app
indexed `ghazal.shers[i]` with it, which is why later verses showed the wrong
text or nothing at all. Here `i` is rebuilt from `pass` + position inside the
pass, and every line is converted to the v3 object shape.

These are still *segmented* timings (phrase boundaries from audio, not
content-anchored). They are published with `method: "segmented"` and a low
quality score; the aligner replaces them with `method: "asr"` when it runs.
"""
from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "timings"
PUBLIC.mkdir(parents=True, exist_ok=True)


def utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def load(path: Path, default):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def line_obj(raw, idx: int) -> dict | None:
    if isinstance(raw, (list, tuple)) and len(raw) >= 2:
        a, b = float(raw[0]), float(raw[1])
        return {"m": idx, "start": round(a, 3), "end": round(b, 3)}
    if isinstance(raw, dict):
        a, b = raw.get("start"), raw.get("end")
        if a is None or b is None or float(b) <= float(a):
            return None
        out = {
            "m": int(raw.get("m", idx)),
            "start": round(float(a), 3),
            "end": round(float(b), 3),
        }
        if raw.get("words"):
            out["words"] = [[round(float(w[0]), 3), round(float(w[1]), 3)] for w in raw["words"]]
            out["estimated"] = bool(raw.get("estimated"))
        return out
    return None


def convert(doc: dict, n_written: int) -> dict | None:
    shers = doc.get("shers") or []
    if not shers:
        return None

    by_pass: dict[int, list[dict]] = defaultdict(list)
    for s in shers:
        start = s.get("start")
        end = s.get("end")
        if start is None or end is None:
            continue
        by_pass[int(s.get("pass", 0) or 0)].append(s)

    out = []
    for pass_no in sorted(by_pass):
        group = sorted(by_pass[pass_no], key=lambda s: float(s["start"]))
        for rank, s in enumerate(group):
            i = rank if n_written <= 0 else min(n_written - 1, rank)
            start = float(s["start"])
            end = float(s["end"])
            if end <= start:
                continue
            lines = []
            for k, raw in enumerate(s.get("lines") or []):
                lo = line_obj(raw, k)
                if lo:
                    lines.append(lo)
            lines.sort(key=lambda l: l["start"])
            out.append(
                {
                    "i": i,
                    "pass": pass_no,
                    "start": round(start, 3),
                    "end": round(end, 3),
                    "lines": lines or None,
                    "anchored": False,
                }
            )

    out.sort(key=lambda s: s["start"])
    return {
        "v": 3,
        "duration": round(float(doc.get("duration") or 0), 2),
        "method": "segmented",
        "phrases": doc.get("vocals") or doc.get("phrases") or [],
        "interludes": doc.get("interludes") or [],
        "shers": out,
        "quality": {
            "score": 0.35,
            "lineScore": 0.35,
            "wordCoverage": 0.0,
            "temporal": round(float(doc.get("coverage") or 0), 3),
            "monotonic": 1.0,
        },
        "coverage": float(doc.get("coverage") or 0),
    }


def main() -> int:
    cat = load(DATA / "catalog.json", {})
    gh = {g["id"]: g for g in cat.get("ghazals", [])}
    tracks = {t["id"]: t for t in cat.get("tracks", [])}

    legacy = load(DATA / "timings.json", {})
    legacy.update({k: v for k, v in (cat.get("timings") or {}).items() if k not in legacy})

    index = load(PUBLIC / "index.json", {"v": 3, "tracks": {}})
    index.setdefault("tracks", {})

    written = 0
    combined: dict[str, dict] = {}
    for tid, doc in legacy.items():
        t = tracks.get(tid)
        if not t or not t.get("ghazalId"):
            continue
        n_written = len(gh.get(t["ghazalId"], {}).get("shers", []))
        if not n_written:
            continue
        out = convert(doc, n_written)
        if not out or not out["shers"]:
            continue
        out["trackId"] = tid
        key = t.get("tkey") or tid
        out["tkey"] = key

        # Never downgrade a measured/ASR/manual timing back to segmented.
        current = load(PUBLIC / f"{key}.json", {})
        if current and current.get("method") in ("asr", "manual"):
            q = (current.get("quality") or {}).get("score", 0) if isinstance(current.get("quality"), dict) else 0
            if q >= 0.5:
                combined[key] = current
                continue

        combined[key] = out
        (PUBLIC / f"{key}.json").write_text(
            json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
        )
        index["tracks"][key] = {
            "q": out["quality"]["score"],
            "m": "segmented",
            "d": out["duration"],
            "n": len(out["shers"]),
        }
        written += 1

    (DATA / "timings.v3.json").write_text(
        json.dumps(combined, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    index["v"] = 3
    index["generated"] = utc()
    (PUBLIC / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    with_text = sum(1 for t in cat.get("tracks", []) if t.get("ghazalId"))
    print(f"migrated {written} legacy timing(s)")
    print(f"tracks with poetry: {with_text} / {len(cat.get('tracks', []))}")
    print(f"-> {PUBLIC / 'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
