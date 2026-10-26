#!/usr/bin/env python3
"""
harvest_audio.py - Build the "Ghazal for Gen Z" listening library from Internet Archive.

Internet Archive hosts freely-streamable ghazal recordings and its download
endpoints send `Access-Control-Allow-Origin: *` with HTTP 206 range support,
so a browser <audio> element can stream them directly.

Design notes:
  * Every network response is cached under data/.cache/, so re-runs are cheap.
  * Results are appended to data/tracks.raw.jsonl as they are produced, so an
    interrupted run never loses completed work.
  * Raw output is intentionally broad; build_catalog.py applies scoring.

Output: data/tracks.raw.jsonl  ->  data/tracks.json (deduped, ranked)
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import quote

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import requests

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / ".cache"
CACHE.mkdir(parents=True, exist_ok=True)
RAW = DATA / "tracks.raw.jsonl"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers.update({"User-Agent": UA})

MIN_SECONDS = 40
MAX_ITEMS_PER_QUERY = 400
TARGET = 4000          # stop once we have comfortably more than needed

QUERIES = [
    'mediatype:audio AND (subject:ghazal OR subject:ghazals)',
    'mediatype:audio AND (title:ghazal OR title:ghazals)',
    'mediatype:audio AND subject:("urdu poetry" OR "urdu ghazal" OR "urdu shayari")',
    'mediatype:audio AND title:("urdu poetry" OR "urdu ghazal")',
    'mediatype:audio AND creator:("Jagjit Singh" OR "Mehdi Hassan" OR "Ghulam Ali")',
    'mediatype:audio AND creator:("Farida Khanum" OR "Pankaj Udhas" OR "Talat Aziz")',
    'mediatype:audio AND creator:("Nusrat Fateh Ali Khan" OR "Abida Parveen")',
    'mediatype:audio AND creator:("Begum Akhtar" OR "Iqbal Bano" OR "Tina Sani")',
    'mediatype:audio AND creator:("Ahmad Faraz" OR "Faiz Ahmed Faiz" OR "Jon Elia")',
    'mediatype:audio AND (title:mehfil OR title:mushaira OR title:kulliyat)',
    'mediatype:audio AND (subject:ghalib OR subject:iqbal OR subject:rekhta)',
    'mediatype:audio AND subject:("sufi" OR "qawwali" OR "kalam")',
]


def search_items(query: str) -> list[dict]:
    key = re.sub(r"[^a-z0-9]+", "_", query.lower())[:70]
    cache_file = CACHE / f"search_{key}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass

    docs: list[dict] = []
    page = 1
    while len(docs) < MAX_ITEMS_PER_QUERY:
        try:
            r = S.get("https://archive.org/advancedsearch.php", params={
                "q": query,
                "fl[]": ["identifier", "title", "creator", "downloads", "year", "subject"],
                "rows": 200, "page": page, "output": "json",
                "sort[]": "downloads desc"}, timeout=90)
            if r.status_code != 200:
                break
            batch = r.json().get("response", {}).get("docs", [])
        except Exception:
            break
        if not batch:
            break
        docs.extend(batch)
        if len(batch) < 200:
            break
        page += 1
        time.sleep(0.25)

    docs = docs[:MAX_ITEMS_PER_QUERY]
    cache_file.write_text(json.dumps(docs, ensure_ascii=False), encoding="utf-8")
    return docs


def item_metadata(identifier: str) -> dict | None:
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", identifier)[:110]
    cache_file = CACHE / f"meta_{safe}.json"
    if cache_file.exists():
        try:
            return json.loads(cache_file.read_text(encoding="utf-8"))
        except Exception:
            pass
    for attempt in range(3):
        try:
            r = S.get(f"https://archive.org/metadata/{identifier}", timeout=90)
            if r.status_code == 200:
                d = r.json()
                if d.get("files"):
                    cache_file.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
                    return d
                return None
        except Exception:
            pass
        time.sleep(1.0 * (attempt + 1))
    return None


AUDIO_EXT = (".mp3", ".m4a", ".ogg", ".oga", ".opus")
TRACK_NO_RE = re.compile(r"^\s*(?:cd\s*)?\d{1,2}\s*[-._)]\s*", re.I)
SITE_TAG_RE = re.compile(
    r"(?:www\.[a-z0-9.\-]+|rkmania|downloadming|pagalworld|songspk|mr-?jatt|djmaza|"
    r"freshmaza|_?320\s?kbps|_?128\s?kbps|_?160\s?k|_?320k|flac|\bmp3\b|lyrical|"
    r"full song|full video|official video)", re.I)

STRONG = re.compile(
    r"ghazal|غزل|rekhta|urdu poetry|urdu shayari|shayari|mushaira|mehfil-e|"
    r"kulliyat|diwan|deewan|nazm|rubai|qawwali|sufi|ghalib|iqbal|mir taqi|"
    r"faiz|faraz|jaun|parveen shakir|jagjit|mehdi hassan|ghulam ali|"
    r"farida khanum|begum akhtar|abida parveen|nusrat fateh", re.I)


def tidy(text: str) -> str:
    t = unicodedata.normalize("NFKC", str(text))
    t = re.sub(r"\.(mp3|m4a|ogg|oga|opus)$", "", t, flags=re.I)
    t = t.replace("_", " ").replace("+", " ")
    t = re.sub(r"[\[\]{}()]", " ", t)
    t = SITE_TAG_RE.sub(" ", t)
    t = re.sub(r"\s*-\s*(?=-|$)", " ", t)
    t = re.sub(r"^[\s\-|,.]+|[\s\-|,.]+$", "", t)
    return re.sub(r"\s{2,}", " ", t).strip() or "Untitled"


def split_artist(title: str) -> tuple[str, str]:
    for sep in (" - ", " – ", " — ", " | "):
        if sep in title:
            left, right = title.split(sep, 1)
            left, right = left.strip(), right.strip()
            if 2 < len(left) < 42 and len(right) > 3:
                return right, left
    return title, ""


def parse_length(value) -> float:
    if value is None:
        return 0.0
    s = str(value).strip()
    if not s:
        return 0.0
    if ":" in s:
        try:
            parts = [float(p) for p in s.split(":")]
        except ValueError:
            return 0.0
        total = 0.0
        for p in parts:
            total = total * 60 + p
        return total
    try:
        return float(s)
    except ValueError:
        return 0.0


def stream_url(identifier: str, name: str) -> str:
    return f"https://archive.org/download/{quote(identifier)}/{quote(name)}"


def extract_item(doc: dict) -> list[dict]:
    ident = doc.get("identifier")
    if not ident:
        return []
    meta = item_metadata(ident)
    if not meta:
        return []
    mmeta = meta.get("metadata", {}) or {}

    item_title = tidy(str(doc.get("title") or mmeta.get("title") or ident))
    creator = doc.get("creator") or mmeta.get("creator") or ""
    if isinstance(creator, list):
        creator = ", ".join(str(c) for c in creator)
    creator = tidy(str(creator)) or "Various Artists"

    subject = doc.get("subject") or mmeta.get("subject") or ""
    if isinstance(subject, list):
        subject = " ".join(str(s) for s in subject)

    hay = f"{item_title} {creator} {subject}"
    if not STRONG.search(hay):
        return []

    year = str(doc.get("year") or mmeta.get("year") or mmeta.get("date") or "")[:12]
    out: list[dict] = []
    for f in meta.get("files", []):
        name = f.get("name") or ""
        if not name.lower().endswith(AUDIO_EXT):
            continue
        if str(f.get("private", "")).lower() == "true":
            continue
        length = parse_length(f.get("length"))
        if length and length < MIN_SECONDS:
            continue

        title = TRACK_NO_RE.sub("", tidy(name.rsplit("/", 1)[-1])).strip()
        title, artist = split_artist(title)
        artist = TRACK_NO_RE.sub("", artist).strip() if artist else creator
        if not title or re.fullmatch(r"(track|audio|untitled|unknown)", title, re.I):
            title = item_title

        out.append({
            "id": f"{ident}::{name}",
            "title": title[:160],
            "artist": (artist or creator)[:120],
            "album": item_title[:160],
            "identifier": ident,
            "duration": round(length, 1),
            "url": stream_url(ident, name),
            "downloads": int(doc.get("downloads") or 0),
            "year": year,
        })
    return out


def load_done() -> set[str]:
    done = set()
    if RAW.exists():
        with RAW.open("r", encoding="utf-8") as fh:
            for line in fh:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                for t in obj.get("tracks", []):
                    done.add(t["url"])
    return done


def main() -> int:
    print("Ghazal for Gen Z - audio harvester")
    print("=" * 72)

    docs: dict[str, dict] = {}
    for q in QUERIES:
        found = search_items(q)
        new = 0
        for d in found:
            i = d.get("identifier")
            if i and i not in docs:
                docs[i] = d
                new += 1
        print(f"  [{len(found):4d} hits / {new:4d} new]  {q[:56]}", flush=True)

    print(f"\nUnique candidate items: {len(docs)}")

    seen = load_done()
    if seen:
        print(f"Resuming - {len(seen)} track URLs already captured")

    written = 0
    processed = 0
    with RAW.open("a", encoding="utf-8") as sink:
        with ThreadPoolExecutor(max_workers=8) as pool:
            futures = [pool.submit(extract_item, d) for d in docs.values()]
            for fut in as_completed(futures):
                processed += 1
                try:
                    tracks = fut.result()
                except Exception:
                    tracks = []
                fresh = [t for t in tracks if t["url"] not in seen]
                for t in fresh:
                    seen.add(t["url"])
                if fresh:
                    sink.write(json.dumps({"tracks": fresh}, ensure_ascii=False) + "\n")
                    sink.flush()
                    written += len(fresh)
                if processed % 50 == 0:
                    print(f"  ... {processed}/{len(docs)} items, +{written} new tracks"
                          f" (total {len(seen)})", flush=True)

    print(f"\nNew tracks written: {written}")
    print(f"Total unique     : {len(seen)}")
    print(f"Raw file: {RAW}  ({RAW.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
