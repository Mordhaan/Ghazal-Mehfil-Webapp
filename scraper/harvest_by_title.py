#!/usr/bin/env python3
"""
harvest_by_title.py - Targeted Rekhta harvest for ghazals we actually own audio for.

The generic poet-list harvest pulls whatever Rekhta lists first, which is
dominated by obscure couplets. This script takes the distinct titles found in
our archive.org track catalogue and fetches the matching Rekhta poems by
searching the poet's popular listing for a title-fragment match.

Strategy (all verified live):
  * Rekhta's own /search is client-rendered, so we do not use it.
  * Poet listings paginate through the AJAX `/PoetCollection` endpoint, and
    `sort=popular` is accepted.
  * We scrape the listing HTML for ghazal slugs + their Urdu titles, then fetch
    any ghazal whose slug (which is the romanised opening line) shares a strong
    word-prefix with a title we are looking for.

Output: appends to data/ghazals.partial.jsonl (idempotent)
"""
from __future__ import annotations

import json
import re
import sys
import time
import unicodedata
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import requests

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scraper"))
from harvest_rekhta import parse_ghazal, BASE  # noqa: E402

DATA = ROOT / "data"
PARTIAL = DATA / "ghazals.partial.jsonl"

S = requests.Session()
S.headers.update({
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"),
    "Accept-Language": "en-US,en;q=0.9",
})

POETS = [
    "mirza-ghalib", "ahmed-faraz", "faiz-ahmed-faiz", "jaun-elia",
    "parveen-shakir", "allama-iqbal", "makhdoom-mohiuddin", "sahir-ludhianvi",
    "majrooh-sultanpuri", "qateel-shifai", "rahat-indori", "jigar-moradabadi",
    "firaq-gorakhpuri", "nasir-kazmi", "munawwar-rana", "shakeb-jalali",
    "jan-nisar-akhtar", "aatish", "momin-khan-momin", "zauq", "hasrat-mohani",
    "nida-fazli", "kaifi-azmi", "ali-sardar-jafri", "ibn-e-insha",
    "mustafa-zaidi", "himayat-ali-shayar", "ahmad-nadeem-qasmi",
    "sudarshan-fakir", "gulzar", "javed-akhtar", "bahadur-shah-zafar",
    "wasi-shah", "mir-taqi-mir", "mir", "daagh-dehlvi", "fani-badanvi",
    "majaz-lucknavi", "khwaja-mir-dard", "bullah-shah", "amir-khusrau",
]

STOP = {"the","a","an","ki","ka","ke","ko","se","mein","me","hai","hain","na",
        "to","bhi","hi","ho","hoon","hun","tha","thi","aur","ek","yeh","ye",
        "wo","woh","kya","nahin","nahi","kuch","koi","jo","jab","tab","ab","is",
        "us","in","un","par","pe","liye","liye","kar","kar","hua","hui","hue",
        "raha","rahi","rahe","gaya","gayi","gaye","diya","diye","diya"}


def fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def toks(s: str) -> list[str]:
    """Significant words, keeping 2-letter ones that carry meaning in Urdu
    romanisation (aa, dil, gul...)."""
    return [w for w in fold(s).split() if w not in STOP and len(w) >= 2]


def main() -> int:
    # ---- what titles do we need? -------------------------------------------
    wanted: dict[str, str] = {}
    if (DATA / "tracks.raw.jsonl").exists():
        with (DATA / "tracks.raw.jsonl").open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    for t in json.loads(line)["tracks"]:
                        title = re.sub(r"@\s*\S+\.(com|net|org)\S*", " ",
                                       t.get("title") or "", flags=re.I)
                        title = re.sub(r"^\s*\d{1,3}\s*[-._)]?\s*", "", title)
                        tt = toks(title)
                        if len(tt) >= 2:
                            key = " ".join(tt[:6])
                            wanted.setdefault(key, title.strip())
                except Exception:
                    continue
    print(f"Distinct wanted title-keys: {len(wanted)}")

    have: set[str] = set()
    if PARTIAL.exists():
        with PARTIAL.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    have.add(json.loads(line)["id"])
                except Exception:
                    continue
    print(f"Already have: {len(have)}")

    added = 0
    checked = 0
    with PARTIAL.open("a", encoding="utf-8") as sink:
        for poet in POETS:
            listing = f"{BASE}/poets/{poet}/ghazals?lang=ur"
            try:
                r = S.get(listing, timeout=60)
                if r.status_code != 200:
                    print(f"  ! {poet}: {r.status_code}")
                    continue
                html = r.text
            except Exception as e:
                print(f"  ! {poet}: {e}")
                continue

            aja = re.search(r'data-url="(/PoetCollection\?[^"]+)"', html)
            pages: list[str] = [html]
            if aja:
                raw = aja.group(1).replace("&amp;", "&")
                raw = re.sub(r"sort=[a-z\-]+", "sort=popular", raw)
                for pg in range(2, 6):
                    u = re.sub(r"pageNumber=\d+", f"pageNumber={pg}", raw)
                    try:
                        rr = S.get(BASE + u, timeout=60,
                                   headers={"X-Requested-With": "XMLHttpRequest"})
                        if rr.status_code == 200 and len(rr.text) > 500:
                            pages.append(rr.text)
                        else:
                            break
                    except Exception:
                        break
                    time.sleep(0.6)

            # every slug on the listing, with its urdu title
            cands: dict[str, str] = {}
            for pg in pages:
                for m in re.finditer(
                        r'/ghazals/([a-z0-9][a-z0-9\-]{8,120})-ghazals', pg):
                    cands.setdefault(m.group(1), "")

            hits = 0
            for slug in cands:
                if slug in have:
                    continue
                st = toks(slug.replace("-", " "))
                if len(st) < 2:
                    continue
                frag = " ".join(st[:5])
                # a match needs the slug's opening tokens to line up with a
                # wanted title's opening tokens (>= 2 shared leading words)
                matched = None
                f2 = " ".join(st[:2])
                for wk, orig in wanted.items():
                    if wk == frag or wk.startswith(frag + " ") or frag.startswith(wk + " "):
                        matched = orig
                        break
                    if wk.startswith(f2 + " ") or f2 == wk:
                        matched = orig
                        break
                if not matched:
                    continue
                checked += 1
                try:
                    g = parse_ghazal(poet, slug)
                except Exception:
                    g = None
                if g and g["shers"]:
                    g["poet_slug"] = poet
                    sink.write(json.dumps(g, ensure_ascii=False) + "\n")
                    sink.flush()
                    have.add(slug)
                    added += 1
                    hits += 1
                time.sleep(0.4)
            print(f"[{poet}] listing={len(cands)} matched+fetched={hits}", flush=True)

    print(f"\nMatched attempts: {checked}")
    print(f"Newly added     : {added}")

    # rebuild consolidated file
    allg, ids = [], set()
    with PARTIAL.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                g = json.loads(line)
            except Exception:
                continue
            if g.get("id") and g["id"] not in ids:
                ids.add(g["id"])
                allg.append(g)
    (DATA / "ghazals.json").write_text(
        json.dumps(allg, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Total ghazal texts: {len(allg)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
