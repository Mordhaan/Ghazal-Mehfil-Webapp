#!/usr/bin/env python3
"""
build_catalog.py - Turn harvested raw data into the catalogue the web app ships.

Inputs
  data/tracks.raw.jsonl   archive.org audio (broad, messy)
  data/ghazals.json       Rekhta couplets (tri-script)
  data/moods.json         5 curated moods + keyword vocabularies

Output
  data/catalog.json       slim, ranked, mood-tagged playlist the browser loads

Design rules
  * Never invent tracks. Every entry keeps its real archive.org URL.
  * Tracks that have a matched couplet are ranked first so the centre stage
    actually shows poetry.
  * Every mood gets a healthy playlist; nothing is ever silently empty.
  * Keep the shipped JSON small so first paint stays fast.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

PER_MOOD = 300
MAX_TRACKS = 1500
MIN_SECONDS = 60
MAX_SECONDS = 900

POET_ARTIST = re.compile(
    r"jagjit|mehdi hassan|ghulam ali|farida khanum|begum akhtar|iqbal bano|"
    r"tina sani|pankaj udhas|talat aziz|abida parveen|nusrat fateh|rahat fateh|"
    r"amanat ali|habib wali|munni begum|noor jahan|tasawwur khanum|"
    r"bade ghulam ali|anis sabri|sabri brothers|aziz mian|"
    r"ghazal|rekhta|urdu poetry|faiz|faraz|jaun|ghalib|parveen shakir|"
    r"nasir kazmi|majaz|jigar|firaq|daagh|momin|zauq|iqbal|mir taqi|"
    r"ahmad faraz|sahir|majrooh|qateel|rahat indori|nida fazli|kaifi",
    re.I)

BLOCK = re.compile(
    r"quran|qur'an|fatiha|baqara|nasheed|bible|tilawat|azaan|azan|khutba|bayan|"
    r"tajweed|ruqyah|surah|pushto|pashto|hadith|sunnat|maslak|madrasa|maulana|"
    r"sheikh|qari|imam|juma|ramadan|hajj|umrah|melayu|joget|zapin|senandung|"
    r"koleksi|naat|salaat|manqabat|marsiya|soaz|noha|"
    r"audiobook|podcast|motivational|lecture|keynote|interview|advert",
    re.I)

MOOD_KEYWORDS: dict[str, list[str]] = {
    "3am-melancholy": [
        "ranjish", "gham", "gam", "dard", "tanha", "tanhai", "hijr", "judai",
        "judaai", "aansu", "ansu", "ashk", "yaad", "raat", "muddat", "khamosh",
        "bewafa", "bewafai", "zakhm", "dukh", "udaas", "udaasi", "intezar",
        "intizar", "bichhad", "bichhda", "maatam", "rote", "rona", "aah",
        "fariyaad", "shab", "raatein", "tanhaai", "broken", "alone", "sad",
        "sorrow", "tears", "melancholy", "regret", "afsoos", "afsos",
        "kya kahun", "na karo", "aakhri", "chhod", "chhoot", "juda",
    ],
    "tender-romance": [
        "ishq", "mohabbat", "muhabbat", "pyaar", "pyar", "dil", "jaan",
        "zulf", "nazar", "nigah", "hothon", "hont", "chaahat", "chahat",
        "dilbar", "sanam", "mehboob", "husn", "ada", "sharm", "baahon",
        "bahon", "muskura", "muskurahat", "khwaab", "khwab", "chand",
        "chaand", "bahar", "bahaar", "gul", "phool", "love", "romance",
        "beloved", "sweetheart", "aaj jane ki zid", "aap ki ankhon",
        "hoshwalon", "tum ko dekha", "chupke chupke", "hothon se",
    ],
    "sufi-transcendence": [
        "sufi", "khuda", "allah", "maula", "rab", "fana", "baqa", "ruh",
        "rooh", "murshid", "peer", "dargah", "khanqah", "noor", "divine",
        "ecstasy", "sama", "raqs", "wajd", "tasawwuf", "mystic", "spiritual",
        "qawwali", "hamd", "sana", "bulleh", "rumi", "khusrau", "wasi shah",
        "sachal", "shah latif", "bhagti", "bhajan", "aarti", "sacred", "soul",
        "chhap tilak", "damadam mast", "mast qalandar", "tera ishq",
        "sanwal", "mor", "mukhi", "jaan-e-jaan",
    ],
    "rebellious-philosophical": [
        "jaun", "jon elia", "ghalib", "zahid", "rind", "falsafa", "sawal",
        "hasti", "maut", "zindagi", "duniya", "jahan", "kaaynat", "kainat",
        "khudi", "taqdeer", "muqaddar", "inqilab", "inquilab", "zulm",
        "sitam", "azaadi", "azadi", "sarkash", "baghi", "sar utha",
        "bekhudi", "bekhabar", "nafrat", "ghussa", "tark", "inkar",
        "philosophy", "existential", "nihilist", "rebel", "protest",
        "freedom", "question", "absurd", "meaningless", "kyun", "kya hai",
        "insaan", "aadmi", "shikwa", "jawab-e-shikwa",
    ],
    "lofi-rain-chill": [
        "barish", "baaris", "barsaat", "monsoon", "rain", "badal", "baadal",
        "sawan", "saawan", "chai", "shaam", "subah", "sukoon", "chain",
        "aram", "aaram", "halka", "dheema", "slow", "lofi", "lo-fi", "chill",
        "calm", "peace", "quiet", "khamoshi", "thandi", "hawa", "bheegi",
        "geela", "chhat", "khidki", "deewar", "ghar", "dheere", "dhun",
        "instrumental", "acoustic", "flute", "sitar", "sarangi", "santoor",
    ],
}

ARTIST_MOOD: dict[str, str] = {
    "jagjit": "3am-melancholy",
    "mehdi hassan": "3am-melancholy",
    "ghulam ali": "tender-romance",
    "farida khanum": "tender-romance",
    "begum akhtar": "3am-melancholy",
    "iqbal bano": "rebellious-philosophical",
    "pankaj udhas": "tender-romance",
    "talat aziz": "tender-romance",
    "tina sani": "tender-romance",
    "abida parveen": "sufi-transcendence",
    "nusrat fateh": "sufi-transcendence",
    "rahat fateh": "sufi-transcendence",
    "amanat ali": "tender-romance",
    "habib wali": "tender-romance",
    "faiz": "rebellious-philosophical",
    "faraz": "3am-melancholy",
    "jaun": "rebellious-philosophical",
    "ghalib": "rebellious-philosophical",
    "parveen shakir": "tender-romance",
    "iqbal": "rebellious-philosophical",
    "shaikh": "sufi-transcendence",
    "sabri": "sufi-transcendence",
    "aziz mian": "sufi-transcendence",
}


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").lower()
    return re.sub(r"\s+", " ", s)


def score_mood(text: str, artist: str) -> tuple[str, int]:
    t = norm(text)
    scores = {m: 0 for m in MOOD_KEYWORDS}
    for mood, kws in MOOD_KEYWORDS.items():
        for kw in kws:
            if kw in t:
                scores[mood] += 3 if " " in kw else 2
    a = norm(artist)
    for key, mood in ARTIST_MOOD.items():
        if key in a:
            scores[mood] += 3
            break
    return max(scores.items(), key=lambda kv: kv[1])


def clean_title(title: str, artist: str, album: str) -> str:
    t = unicodedata.normalize("NFKC", title)
    t = re.sub(r"@\s*\S+\.(com|net|org)\S*", " ", t, flags=re.I)
    t = re.sub(r"\b(?:arp|arth|premgeet|nikah|gharaonda|revival|duet|solo)\b",
               " ", t, flags=re.I)
    t = re.sub(r"[\-_/]+$", "", t).strip()
    t = re.sub(r"\s{2,}", " ", t).strip()
    if not t or len(t) < 3:
        return (album or "Untitled")[:90]
    return t[:90]


ARTIST_IN_ALBUM = re.compile(
    r"(jagjit singh|mehdi hassan|ghulam ali|pankaj udhas|farida khanum|"
    r"begum akhtar|iqbal bano|abida parveen|nusrat fateh ali khan|"
    r"rahat fateh ali khan|talat aziz|tina sani|munni begum|habib wali|"
    r"amanat ali|anis sabri)", re.I)


def pretty_artist(artist: str, album: str) -> str:
    a = re.sub(r"^[#\s]+", "", artist or "").strip()
    if a.lower() in {"", "untitled", "na", "unknown", "various", "various artists"}:
        m = ARTIST_IN_ALBUM.search(album or "")
        if m:
            return m.group(1).title()
        return "Various Artists"
    a = re.sub(r"\s*[\(\[]?(?:19|20)\d{2}[\)\]]?\s*$", "", a).strip()
    a = re.sub(r"\.(com|net|org).*$", "", a, flags=re.I).strip()
    a = re.sub(r"^http.*$", "", a, flags=re.I).strip()
    if not a:
        m = ARTIST_IN_ALBUM.search(album or "")
        return m.group(1).title() if m else "Various Artists"
    return a[:60]


_FOLD = {
    "\u0121": "g", "\u1e21": "g", "\u1e33": "k", "\u1e35": "k",
    "\u1e96": "h", "\u1e25": "h", "\u1e93": "z", "\u1e95": "z",
    "\u1e63": "s", "\u015b": "sh", "\u1e6d": "t", "\u1e0d": "d",
    "\u1e5b": "r", "\u1e59": "r", "\u1e47": "n", "\u00f1": "n",
    "\u1e37": "l", "\u017c": "z", "\u01e7": "g", "\u00e7": "c",
    "\u0161": "sh", "\u017e": "zh", "\u2019": "", "\u02bb": "",
    "\u02bc": "", "\u02be": "",
}

STOPWORDS = {
    "the", "a", "an", "ki", "ka", "ke", "ko", "se", "mein", "me", "hai",
    "hain", "na", "to", "bhi", "hi", "ho", "hoon", "hun", "tha", "thi",
    "aur", "ek", "yeh", "ye", "wo", "woh", "kya", "nahin", "nahi",
}


def squash(s: str) -> str:
    """Space- and diacritic-insensitive key.

    Rekhta slugs run words together ("tumko-dekha") while archive.org titles
    often split them ("Tum Ko Dekha"), and some titles have no spaces at all
    ("RukJaKeSubahTakNaHoYehRaatAakhri"). Removing every separator lets all
    three spellings collapse to the same key.
    """
    return match_key(s).replace(" ", "")


def match_key(s: str) -> str:
    """Bare comparable slug of latin words, diacritic-insensitive."""
    s = s or ""
    for src, dst in _FOLD.items():
        s = s.replace(src, dst)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = " ".join(w for w in s.split() if w not in STOPWORDS)
    return s.strip()


def main() -> int:
    moods_raw = json.loads((DATA / "moods.json").read_text(encoding="utf-8"))
    mood_ids = [m["id"] for m in moods_raw]
    print(f"Moods: {', '.join(mood_ids)}")

    rows: list[dict] = []
    raw_path = DATA / "tracks.raw.jsonl"
    if not raw_path.exists():
        print("!! data/tracks.raw.jsonl missing - run scraper/harvest_audio.py")
        return 1
    with raw_path.open(encoding="utf-8") as fh:
        for line in fh:
            try:
                rows.extend(json.loads(line)["tracks"])
            except Exception:
                continue
    print(f"Raw tracks: {len(rows)}")

    # ---------- ghazal text index ----------
    ghazals: list[dict] = []
    gpath = DATA / "ghazals.json"
    if gpath.exists():
        try:
            ghazals = json.loads(gpath.read_text(encoding="utf-8"))
        except Exception:
            ghazals = []
    print(f"Ghazal texts: {len(ghazals)}")

    # A track title is usually the ghazal's opening line, so index EVERY
    # sher line alongside the romanised ghazal title.
    by_key: dict[str, dict] = {}
    for g in ghazals:
        k = match_key(g.get("title_roman") or "")
        if len(k) >= 8:
            by_key.setdefault(k, g)
        for s in g.get("shers", []):
            for line in (s.get("text_roman") or "").split("\n"):
                lk = match_key(line)
                if len(lk) >= 12:
                    by_key.setdefault(lk, g)

    # squash index: every sher line and every romanised title
    by_squash: dict[str, dict] = {}
    for g in ghazals:
        cands = [g.get("title_roman") or ""]
        for s in g.get("shers", []):
            cands.extend((s.get("text_roman") or "").split("\n"))
        for c in cands:
            sq = squash(c)
            if len(sq) >= 14:
                by_squash.setdefault(sq, g)

    squash_keys = sorted(by_squash.keys(), key=len, reverse=True)

    def find_text(title: str) -> dict | None:
        """Match a track title to the ghazal it performs.

        Track titles are the opening phrase of the couplet, so we match on a
        squashed prefix rather than loose token overlap -- the old token
        matcher happily paired 'Raat Bhar' with an unrelated sher.
        """
        sq = squash(title)
        if len(sq) < 12:
            return None

        # exact
        if sq in by_squash:
            return by_squash[sq]

        # the title is a leading fragment of a sher line / title
        for k in squash_keys:
            if k.startswith(sq) or sq.startswith(k):
                shorter = min(len(k), len(sq))
                # require the shared opening to be long enough to be unique
                if shorter >= 14:
                    return by_squash[k]
        return None

    # ---------- track filtering ----------
    candidates: list[dict] = []
    seen_titles: set[str] = set()
    for r in rows:
        hay = f"{r['artist']} {r['album']} {r['title']}"
        if BLOCK.search(hay) or not POET_ARTIST.search(hay):
            continue
        dur = float(r.get("duration") or 0)
        if dur and not (MIN_SECONDS <= dur <= MAX_SECONDS):
            continue

        title = clean_title(r["title"], r["artist"], r["album"])
        artist = pretty_artist(r["artist"], r["album"])
        key = norm(f"{title}|{artist}")
        if key in seen_titles:
            continue
        seen_titles.add(key)

        entry = {
            "title": title,
            "artist": artist,
            "album": (r["album"] or "")[:80],
            "duration": int(dur) or 0,
            "url": r["url"],
            "downloads": int(r.get("downloads") or 0),
        }

        g = find_text(title)
        if g:
            entry["ghazalId"] = g["id"]
            entry["poet"] = (g.get("poet_name") or
                             g.get("poet_slug", "").replace("-", " ").title())
        candidates.append(entry)

    print(f"After filtering: {len(candidates)}")
    print(f"With couplet text: {sum(1 for c in candidates if c.get('ghazalId'))}")

    # ---------- mood scoring ----------
    buckets: dict[str, list[dict]] = defaultdict(list)
    for c in candidates:
        mood, score = score_mood(f"{c['title']} {c['album']} {c['artist']}", c["artist"])
        c["mood"] = mood
        c["score"] = score
        c["hasText"] = 1 if c.get("ghazalId") else 0
        buckets[mood].append(c)

    # rank: text first, then keyword strength, then popularity
    def rank(c: dict):
        return (-c["hasText"], -c["score"], -c["downloads"], c["title"])

    # ---------- selection: text-bearing tracks first ----------
    catalog: list[dict] = []
    used_urls: set[str] = set()

    def push(c: dict, mood: str) -> bool:
        if len(catalog) >= MAX_TRACKS:
            return False
        item = {
            "id": f"t{len(catalog)}",
            # positional ids change on every rebuild; the media URL does not
            "tkey": hashlib.sha1(c["url"].encode("utf-8")).hexdigest()[:16],
            "title": c["title"],
            "artist": c["artist"],
            "mood": mood,
            "duration": c["duration"],
            "url": c["url"],
            "album": c["album"],
        }
        if c.get("ghazalId"):
            item["ghazalId"] = c["ghazalId"]
            item["poet"] = c["poet"]
        catalog.append(item)
        used_urls.add(c["url"])
        return True

    for mood in mood_ids:
        picks = sorted(buckets[mood], key=rank)
        kept = 0
        # pass 1: with text
        for c in picks:
            if kept >= PER_MOOD or len(catalog) >= MAX_TRACKS:
                break
            if c["url"] in used_urls or not c["hasText"]:
                continue
            if push(c, mood):
                kept += 1
        # pass 2: fill with the best remaining
        for c in picks:
            if kept >= PER_MOOD or len(catalog) >= MAX_TRACKS:
                break
            if c["url"] in used_urls:
                continue
            if push(c, mood):
                kept += 1

    # ---------- top up thin moods from the wider pool ----------
    pool = sorted(candidates, key=rank)
    for mood in mood_ids:
        count = sum(1 for t in catalog if t["mood"] == mood)
        if count >= PER_MOOD:
            continue
        for c in pool:
            if count >= PER_MOOD or len(catalog) >= MAX_TRACKS:
                break
            if c["url"] in used_urls:
                continue
            if push(c, mood):
                count += 1

    # ---------- slim ghazal payload ----------
    used_gh = {t["ghazalId"] for t in catalog if t.get("ghazalId")}
    gh_out = []
    for g in ghazals:
        if g["id"] not in used_gh:
            continue
        gh_out.append({
            "id": g["id"],
            "titleRoman": g.get("title_roman", "")[:120],
            "titleUrdu": g.get("title_urdu", "")[:140],
            "titleHindi": g.get("title_hindi", "")[:160],
            "poet": (g.get("poet_name") or g.get("poet_slug", "")).replace("-", " ").title(),
            "shers": [
                {
                    "u": (s.get("text_urdu") or "")[:300],
                    "r": (s.get("text_roman") or "")[:300],
                    "h": (s.get("text_hindi") or "")[:300],
                }
                for s in g.get("shers", [])[:14]
            ],
        })

    out = {
        "generated": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "moods": moods_raw,
        "tracks": catalog,
        "ghazals": gh_out,
    }
    (DATA / "catalog.json").write_text(
        json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    size = (DATA / "catalog.json").stat().st_size / 1e6
    per = Counter(t["mood"] for t in catalog)
    with_text = Counter(t["mood"] for t in catalog if t.get("ghazalId"))
    artists = Counter(t["artist"] for t in catalog)

    print("\n" + "=" * 72)
    print(f"Catalogued tracks : {len(catalog)}")
    print(f"With couplet text : {sum(with_text.values())}")
    print(f"Ghazal texts      : {len(gh_out)}")
    print(f"Distinct artists  : {len(artists)}")
    print(f"File size         : {size:.2f} MB")
    print("\nPer mood (tracks / with text):")
    for m in mood_ids:
        print(f"  {per.get(m, 0):5d} / {with_text.get(m, 0):3d}   {m}")
    print("\nTop artists:")
    for a, n in artists.most_common(15):
        print(f"  {n:5d}  {a}")
    print(f"\n-> {DATA / 'catalog.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
