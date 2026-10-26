#!/usr/bin/env python3
"""
migrate_keys.py — give every track a stable timing key and move existing files.

`t0`, `t1` are positional: they change whenever the catalogue is rebuilt, which
would attach one recording's lyrics to another. The key is a hash of the media
URL, which survives re-ordering, re-ranking, and adding tracks.

Idempotent: safe to run more than once.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC = ROOT / "public" / "timings"


def tkey(url: str) -> str:
    return hashlib.sha1((url or "").encode("utf-8")).hexdigest()[:16]


def load(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def main() -> int:
    cat_path = DATA / "catalog.json"
    cat = load(cat_path)
    if not cat:
        print("!! catalog.json missing")
        return 1

    added = 0
    changed = 0
    for t in cat.get("tracks", []):
        k = t.get("tkey") or tkey(t.get("url", ""))
        if not t.get("tkey"):
            t["tkey"] = k
            added += 1
        if t["tkey"] != k:
            t["tkey"] = k
            changed += 1

    cat_path.write_text(
        json.dumps(cat, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    by_id = {t["id"]: t for t in cat.get("tracks", [])}
    old_index = load(PUBLIC / "index.json", {"tracks": {}})
    old_entries = old_index.get("tracks", {}) if isinstance(old_index, dict) else {}

    new_entries: dict[str, dict] = {}
    moved = 0
    for tid, meta in old_entries.items():
        t = by_id.get(tid)
        if not t:
            continue
        key = t["tkey"]
        src = PUBLIC / f"{tid}.json"
        dst = PUBLIC / f"{key}.json"
        if src.exists() and not dst.exists():
            src.replace(dst)
            moved += 1
        elif src.exists() and dst.exists():
            # keep the better of the two, then drop the positional copy
            try:
                a = float(meta.get("q", 0))
                b = float((load(dst, {}) or {}).get("quality", {}).get("score", 0))
                if a > b:
                    dst.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
            except Exception:
                pass
            src.unlink(missing_ok=True)
        if dst.exists():
            new_entries[key] = meta

    # files that exist but were never in the index
    for p in PUBLIC.glob("*.json"):
        if p.name == "index.json":
            continue
        key = p.stem
        if key not in new_entries:
            doc = load(p, {}) or {}
            q = (doc.get("quality") or {}).get("score", 0) if isinstance(doc.get("quality"), dict) else doc.get("quality", 0)
            new_entries[key] = {
                "q": q or 0,
                "m": doc.get("method", "segmented"),
                "d": doc.get("duration", 0),
                "n": len(doc.get("shers", [])),
            }

    index = {
        "v": 3,
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "tracks": new_entries,
    }
    PUBLIC.mkdir(parents=True, exist_ok=True)
    (PUBLIC / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )

    # debug files are a convenience; move them too
    debug = DATA / "align"
    for p in debug.glob("*.debug.json"):
        tid = p.name[: -len(".debug.json")]
        t = by_id.get(tid)
        if t:
            target = debug / f"{t['tkey']}.debug.json"
            if not target.exists():
                p.replace(target)

    print(f"tracks                 {len(cat.get('tracks', []))}")
    print(f"keys added             {added}")
    print(f"keys corrected         {changed}")
    print(f"timing files moved     {moved}")
    print(f"index entries          {len(new_entries)}")
    print("example:", cat["tracks"][0]["id"], "->", cat["tracks"][0]["tkey"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
