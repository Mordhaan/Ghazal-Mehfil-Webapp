#!/usr/bin/env python3
"""Text normalisation and similarity for Urdu / Hindi / Roman ghazal matching.

The ASR and the poem never spell a word the same way. `ġham`, `gham`, `غم` and
`ग़म` are one word. Everything here reduces a token to a comparable key and
then measures how much of a misra a candidate span of transcript actually
covers. Nothing here guesses timestamps.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

# ---------------------------------------------------------------- normalise

_UR_FOLD = {
    "آ": "ا", "أ": "ا", "إ": "ا", "ٱ": "ا", "ٲ": "ا",
    "ی": "ي", "ى": "ي", "ئ": "ي", "ے": "ي",
    "ک": "ك", "ڪ": "ك",
    "ہ": "ه", "ۃ": "ه", "ھ": "ه", "ۀ": "ه",
    "ؤ": "و", "ۄ": "و",
    "ں": "ن", "ڻ": "ن",
    "ڑ": "ر", "ڑ": "ر",
    "ٹ": "ت", "ڻ": "ن",
    "ڈ": "د",
    "ء": "",
    "\u200c": "", "\u200d": "", "\u200e": "", "\u200f": "",
}

_ROMAN_FOLD = [
    ("ḳh", "kh"), ("ġh", "gh"), ("ẓ", "z"), ("ṣ", "s"), ("ṭ", "t"), ("ḍ", "d"),
    ("ṛ", "r"), ("ñ", "n"), ("ḥ", "h"), ("ā", "a"), ("ī", "i"), ("ū", "u"),
    ("ē", "e"), ("ō", "o"), ("ṉ", "n"), ("'", ""), ("’", ""), ("ʻ", ""), ("ʾ", ""),
]

# Only grammar glue that appears in almost every line. Dropping more than this
# (as an earlier version did) left a misra with 3 tokens, which made a single
# ASR error look like a wrong couplet.
_URDU_STOP = {
    "كا", "كي", "كه", "كو", "سي", "میں", "هے", "هيں", "نے", "اور", "ايک", "يك",
    "كے", "كی", "ہے", "ہیں", "سے", "کو", "کا", "کی", "کے",
}

_ROMAN_STOP = {
    "the", "a", "an", "and", "or", "of", "in", "on", "at", "to", "for", "from",
    "with", "by", "ki", "ka", "ke", "ko", "se", "mein", "main", "hai", "hain",
    "ek", "ik", "aur",
}


def is_urdu(s: str) -> bool:
    return any("\u0600" <= c <= "\u06ff" for c in s)


def is_devanagari(s: str) -> bool:
    return any("\u0900" <= c <= "\u097f" for c in s)


def strip_marks(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\u064b-\u0652\u0670\u0640\u06d6-\u06ed]", "", s)
    return s


def norm_urdu(s: str) -> str:
    s = strip_marks(s)
    for a, b in _UR_FOLD.items():
        s = s.replace(a, b)
    s = re.sub(r"[^\u0600-\u06ff\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_roman(s: str) -> str:
    s = unicodedata.normalize("NFKD", s or "").lower()
    s = "".join(c for c in s if not unicodedata.combining(c))
    for a, b in _ROMAN_FOLD:
        s = s.replace(a, b)
    s = re.sub(r"[^a-z0-9\s]", " ", s)
    s = re.sub(r"([aeiou])\1+", r"\1", s)  # aa -> a, ii -> i
    return re.sub(r"\s+", " ", s).strip()


def norm_hindi(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "")
    s = re.sub(r"[\u093a-\u094f\u0951-\u0957\u0962\u0963]", "", s)  # matras
    s = re.sub(r"[^\u0900-\u097f\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_for(s: str, script: str) -> str:
    if script == "urdu":
        return norm_urdu(s)
    if script == "hindi":
        return norm_hindi(s)
    return norm_roman(s)


def tokens_for(s: str, script: str) -> list[str]:
    return [t for t in norm_for(s, script).split() if t]


def stop_for(script: str) -> set[str]:
    return _URDU_STOP if script == "urdu" else _ROMAN_STOP


def content_tokens(text: str, script: str) -> list[str]:
    """Tokens that carry the line's identity, not its grammar."""
    stop = stop_for(script)
    return [t for t in tokens_for(text, script) if t not in stop and len(t) > 1]


def squash(tokens: list[str]) -> str:
    return "".join(tokens)


_PHON = str.maketrans({
    "ٹ": "ت", "ط": "ت", "ث": "س", "ص": "س", "ذ": "ز", "ض": "ز", "ظ": "ز",
    "ق": "ک", "ع": "ا", "ء": "ا", "ۓ": "ی", "ے": "ی", "ۃ": "ہ",
})


def phon(s: str) -> str:
    """Skeleton that survives the letter substitutions ASR makes on singing."""
    return s.translate(_PHON)


def tok_sim(a: str, b: str) -> float:
    """Similarity of two already-normalised tokens, 0..1."""
    if a == b:
        return 1.0
    if phon(a) == phon(b):
        return 0.93
    if len(a) > 3 and len(b) > 3 and (a.startswith(b) or b.startswith(a)):
        return 0.88
    if min(len(a), len(b)) >= 2 and (phon(a) in phon(b) or phon(b) in phon(a)):
        return 0.8
    return SequenceMatcher(None, a, b).ratio()


def char_cover(ref_key: str, hyp_key: str) -> float:
    """How much of the misra appears somewhere in the window.

    Full-string ratio punishes a window that contains one extra ASR word; the
    matched-block sum does not, which is what we want for a sung line.
    """
    if not ref_key or not hyp_key:
        return 0.0
    sm = SequenceMatcher(None, ref_key, hyp_key, autojunk=False)
    matched = sum(size for _, _, size in sm.get_matching_blocks())
    return min(1.0, matched / len(ref_key))


# ---------------------------------------------------------------- references


@dataclass
class RefLine:
    sher: int
    misra: int
    script: str
    text: str
    tokens: list[str]          # display tokens, in reading order
    content: list[str]         # stopword-free normalised tokens

    @property
    def key(self) -> str:
        return squash(self.content)


@dataclass
class AsrWord:
    start: float
    end: float
    text: str
    prob: float = 1.0

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)


def build_refs(ghazal: dict, script: str) -> list[RefLine]:
    """Flatten a ghazal into misra-level reference lines."""
    field = {"urdu": "u", "hindi": "h", "roman": "r"}[script]
    out: list[RefLine] = []
    for si, sher in enumerate(ghazal.get("shers", [])):
        raw = (sher.get(field) or "").strip()
        if not raw:
            # tri-script coverage is uneven; fall back rather than skip the sher
            raw = (sher.get("u") or sher.get("r") or "").strip()
            use_script = "urdu" if sher.get("u") else script
        else:
            use_script = script
        lines = [ln for ln in raw.split("\n") if ln.strip()]
        for mi, line in enumerate(lines[:2]):
            toks = tokens_for(line, use_script)
            ct = content_tokens(line, use_script)
            if len(ct) < 2:
                continue
            out.append(RefLine(si, mi, use_script, line, toks, ct))
    return out


# ---------------------------------------------------------------- scoring


def match_pairs(ref: list[str], hyp: list[str], thresh: float = 0.76):
    """Greedy token matching, longest/most similar first. Returns (i,j,sim)."""
    cand = []
    for i, r in enumerate(ref):
        for j, h in enumerate(hyp):
            if r == h:
                cand.append((2.0, i, j, 1.0))
            else:
                # cheap reject: very different lengths are not the same word
                if abs(len(r) - len(h)) > max(2, len(r) // 2):
                    continue
                s = tok_sim(r, h)
                if s >= thresh:
                    cand.append((s, i, j, s))
    cand.sort(reverse=True)
    used_r, used_h, pairs = set(), set(), []
    for _, i, j, s in cand:
        if i in used_r or j in used_h:
            continue
        used_r.add(i)
        used_h.add(j)
        pairs.append((i, j, s))
    pairs.sort()
    return pairs


def coverage_score(ref: RefLine, hyp_tokens: list[str]) -> tuple[float, list[tuple[int, int, float]]]:
    """How much of one misra is present in a candidate span, and in order."""
    if not ref.content or not hyp_tokens:
        return 0.0, []
    pairs = match_pairs(ref.content, hyp_tokens)
    if not pairs:
        return 0.0, []

    recall = len(pairs) / len(ref.content)
    precision = len(pairs) / max(1, len(hyp_tokens))
    ref_seq = [ref.content[i] for i, _, _ in pairs]
    hyp_seq = [hyp_tokens[j] for _, j, _ in pairs]
    order = SequenceMatcher(None, ref_seq, hyp_seq, autojunk=False).ratio()
    char = char_cover(ref.key, squash(hyp_tokens))

    # A window far longer than the line is usually two lines glued together.
    over = max(0.0, len(hyp_tokens) / max(1, len(ref.content)) - 1.6)
    score = 0.34 * recall + 0.12 * precision + 0.12 * order + 0.42 * char - 0.12 * over
    if recall < 0.34:
        score *= 0.55
    return max(0.0, min(1.0, score)), pairs


class RefIndex:
    """Inverted index so a phrase is only scored against plausible lines."""

    def __init__(self, lines: list[RefLine]):
        self.lines = lines
        self.by_token: dict[str, set[int]] = {}
        self.by_prefix: dict[str, set[int]] = {}
        for k, ln in enumerate(lines):
            for t in set(ln.content):
                self.by_token.setdefault(t, set()).add(k)
                self.by_prefix.setdefault(t[:4], set()).add(k)

    def candidates(self, hyp: list[str], k: int = 5) -> list[int]:
        votes: dict[int, float] = {}
        for t in set(hyp):
            for i in self.by_token.get(t, ()):  # exact
                votes[i] = votes.get(i, 0.0) + 2.0
            if len(t) >= 4:
                for i in self.by_prefix.get(t[:4], ()):
                    votes[i] = votes.get(i, 0.0) + 0.6
        ranked = sorted(votes.items(), key=lambda kv: -kv[1])[:k]
        return [i for i, _ in ranked] or list(range(min(k, len(self.lines))))
