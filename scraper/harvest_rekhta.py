#!/usr/bin/env python3
"""
harvest_rekhta.py - Collect real ghazal text (Urdu / Roman / Hindi) from Rekhta.

Rekhta serves server-rendered HTML:
  * listing : /poets/{slug}/ghazals?lang=ur          -> ~50 items, then AJAX
  * AJAX    : the `data-url` on `.contentLoadMorePaging`, pageNumber incremented
  * poem    : couplets live in `div.c`, each with p[data-l] lines built from
              `<span data-m>` per word -> ideal for tap-to-define vocabulary.

Output: data/ghazals.json   (incremental: data/ghazals.partial.jsonl)
Cache : data/.cache/
"""
from __future__ import annotations

import json
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CACHE = DATA / ".cache"
CACHE.mkdir(parents=True, exist_ok=True)
PARTIAL = DATA / "ghazals.partial.jsonl"

BASE = "https://www.rekhta.org"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")

_local = threading.local()


def session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update({"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9"})
        _local.s = s
    return s


POETS = [
    "mirza-ghalib", "mir", "mir-taqi-mir", "ahmed-faraz", "faiz-ahmed-faiz",
    "jaun-elia", "parveen-shakir", "allama-iqbal", "bahadur-shah-zafar",
    "makhdoom-mohiuddin", "sahir-ludhianvi", "majrooh-sultanpuri",
    "qateel-shifai", "rahat-indori", "wasi-shah", "bullah-shah",
    "amir-khusrau", "jigar-moradabadi", "firaq-gorakhpuri", "nasir-kazmi",
    "munawwar-rana", "bashir-badar", "shakeb-jalali", "jan-nisar-akhtar",
    "majaz-lucknavi", "fani-badanvi", "daagh-dehlvi", "aatish",
    "momin-khan-momin", "zauq", "hasrat-mohani", "khwaja-mir-dard",
    "nida-fazli", "kaifi-azmi", "ali-sardar-jafri", "ibn-e-insha",
    "mustafa-zaidi", "himayat-ali-shayar", "ahmad-nadeem-qasmi",
    "sudarshan-fakir", "gulzar", "javed-akhtar", "sahir-hoshiarpuri",
]

MAX_PER_POET = 45
SLEEP_POEM = 0.5
WORKERS = 5
_print_lock = threading.Lock()


def say(msg: str) -> None:
    with _print_lock:
        print(msg, flush=True)


def cached_get(url: str, tag: str = "") -> str | None:
    key = re.sub(r"[^A-Za-z0-9]+", "_", f"{tag}_{url}")[:150]
    f = CACHE / f"rek_{key}.html"
    if f.exists():
        try:
            return f.read_text(encoding="utf-8")
        except Exception:
            pass
    for attempt in range(3):
        try:
            s = session()
            extra = {"X-Requested-With": "XMLHttpRequest"} if "/PoetCollection" in url else None
            r = s.get(url, timeout=60, headers=extra)
            if r.status_code == 200 and len(r.text) > 500:
                f.write_text(r.text, encoding="utf-8")
                return r.text
            if r.status_code == 404:
                return None
        except Exception:
            pass
        time.sleep(1.2 * (attempt + 1))
    return None


def collect_slugs(poet: str) -> list[str]:
    html = cached_get(f"{BASE}/poets/{poet}/ghazals?lang=ur", tag=f"{poet}_p1")
    if not html:
        return []

    slugs: list[str] = []
    seen: set[str] = set()

    def absorb(fragment: str) -> int:
        added = 0
        for m in re.finditer(r"/ghazals/([a-z0-9][a-z0-9\-]{8,120})-ghazals", fragment):
            s = m.group(1)
            if s not in seen:
                seen.add(s)
                slugs.append(s)
                added += 1
        return added

    absorb(html)
    ajax = re.search(r'data-url="(/PoetCollection\?[^"]+)"', html)
    if not ajax:
        return slugs[:MAX_PER_POET]

    raw_url = ajax.group(1).replace("&amp;", "&")
    # Sort by popularity: the ghazals people actually sing are the ones we can
    # match against real recordings. Year-asc gave us obscure early couplets.
    raw_url = re.sub(r"sort=[a-z\-]+", "sort=popular", raw_url)
    parsed = urlparse(raw_url)
    qs = parse_qs(parsed.query)
    page = 2
    while len(slugs) < MAX_PER_POET and page <= 8:
        qs["pageNumber"] = [str(page)]
        url = urlunparse(parsed._replace(query=urlencode(
            {k: v[0] for k, v in qs.items()})))
        frag = cached_get(BASE + url, tag=f"{poet}_p{page}")
        if not frag or absorb(frag) == 0:
            break
        page += 1
        time.sleep(0.5)
    return slugs[:MAX_PER_POET]


def parse_couplets(soup: BeautifulSoup) -> list[dict]:
    shers = []
    for idx, block in enumerate(soup.select("div.c")):
        lines: list[tuple[str, str]] = []
        all_words: list[str] = []
        for p in block.select("p[data-l]"):
            words = [sp.get_text().strip() for sp in p.select("span[data-m]")]
            all_words.extend(w for w in words if w)
            line = " ".join(w for w in words if w).strip()
            if not line:
                line = p.get_text(" ", strip=True)
            if line:
                lines.append((p.get("data-l") or "1", line))
        if not lines:
            txt = block.get_text(" ", strip=True)
            if not txt:
                continue
            lines = [("1", txt)]
            all_words = txt.split()
        lines.sort(key=lambda x: x[0])
        shers.append({"index": idx + 1,
                      "lines": [l for _, l in lines],
                      "words": all_words})
    return shers


def parse_ghazal(poet: str, slug: str) -> dict | None:
    variants: dict[str, dict] = {}
    for lang in ("ur", "ro", "hi"):
        url = f"{BASE}/ghazals/{slug}-ghazals" + ("" if lang == "ro" else f"?lang={lang}")
        html = cached_get(url, tag=f"{slug}_{lang}")
        if not html:
            continue
        soup = BeautifulSoup(html, "lxml")
        shers = parse_couplets(soup)
        if not shers:
            continue
        h1 = soup.find("h1")
        poet_el = soup.select_one(".headerTitleWithAuthorBody a, .headerTitleWithAuthor a")
        variants[lang] = {
            "title": h1.get_text(" ", strip=True) if h1 else slug,
            "poet": poet_el.get_text(" ", strip=True) if poet_el else "",
            "shers": shers,
        }
        time.sleep(0.25)

    if "ur" not in variants:
        return None

    base = variants["ur"]
    n = len(base["shers"])

    def line_of(vk: str, i: int, li: int) -> str:
        v = variants.get(vk)
        if not v or i >= len(v["shers"]):
            return ""
        ls = v["shers"][i]["lines"]
        return ls[li] if li < len(ls) else ""

    out_shers = []
    for i in range(n):
        out_shers.append({
            "index": i + 1,
            "is_matla": i == 0,
            "is_maqta": i == n - 1,
            "text_urdu": "\n".join(base["shers"][i]["lines"]),
            "text_roman": "\n".join(x for x in (line_of("ro", i, 0), line_of("ro", i, 1)) if x),
            "text_hindi": "\n".join(x for x in (line_of("hi", i, 0), line_of("hi", i, 1)) if x),
            "words": base["shers"][i]["words"][:40],
        })

    title_ur = re.sub(r"\s*\(ردیف[^)]*\)\s*$", "", base["title"]).strip()
    title_ro = re.sub(r"\s*\(Radeef[^)]*\)\s*$", "",
                      variants.get("ro", {}).get("title") or slug.replace("-", " "),
                      flags=re.I).strip()

    return {
        "id": slug,
        "slug": slug,
        "poet_slug": poet,
        "poet_name": variants.get("ro", {}).get("poet", ""),
        "title_urdu": title_ur,
        "title_roman": title_ro,
        "title_hindi": variants.get("hi", {}).get("title", ""),
        "source": f"{BASE}/ghazals/{slug}-ghazals",
        "shers": out_shers,
        "shers_count": len(out_shers),
    }


def load_partial() -> tuple[list[dict], set[str]]:
    out, ids = [], set()
    if PARTIAL.exists():
        with PARTIAL.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    g = json.loads(line)
                except Exception:
                    continue
                if g.get("id") and g["id"] not in ids:
                    ids.add(g["id"])
                    out.append(g)
    return out, ids


def main() -> int:
    only = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].isdigit() else None
    limit = int(sys.argv[-1]) if sys.argv[-1].isdigit() else MAX_PER_POET
    poets = [only] if only else POETS

    say("Ghazal - Rekhta text harvester")
    say("=" * 72)

    existing, done_ids = load_partial()
    if existing:
        say(f"Resuming - {len(existing)} ghazals already captured")

    tasks: list[tuple[str, str]] = []
    for poet in poets:
        try:
            slugs = collect_slugs(poet)[:limit]
        except Exception as e:
            say(f"  ! {poet}: listing failed ({e})")
            continue
        fresh = [s for s in slugs if s not in done_ids]
        say(f"[{poet}] {len(slugs)} found, {len(fresh)} to fetch")
        tasks.extend((poet, s) for s in fresh)

    say(f"\nTotal ghazals to fetch: {len(tasks)}\n")

    kept = 0
    with PARTIAL.open("a", encoding="utf-8") as sink:
        with ThreadPoolExecutor(max_workers=WORKERS) as pool:
            futs = {pool.submit(parse_ghazal, p, s): (p, s) for p, s in tasks}
            for n, fut in enumerate(as_completed(futs), 1):
                poet, slug = futs[fut]
                try:
                    g = fut.result()
                except Exception:
                    g = None
                if g and g["shers"]:
                    sink.write(json.dumps(g, ensure_ascii=False) + "\n")
                    sink.flush()
                    kept += 1
                if n % 25 == 0:
                    say(f"  ... {n}/{len(tasks)} done, {kept} kept")
                time.sleep(SLEEP_POEM)

    allg, _ = load_partial()
    DATA.mkdir(exist_ok=True)
    (DATA / "ghazals.json").write_text(
        json.dumps(allg, ensure_ascii=False, indent=1), encoding="utf-8")

    total = sum(g["shers_count"] for g in allg)
    ro = sum(1 for g in allg if any(s["text_roman"] for s in g["shers"]))
    hi = sum(1 for g in allg if any(s["text_hindi"] for s in g["shers"]))
    say("\n" + "=" * 72)
    say(f"Ghazals    : {len(allg)}")
    say(f"Shers      : {total}")
    say(f"With Roman : {ro}")
    say(f"With Hindi : {hi}")
    say(f"-> {DATA / 'ghazals.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
