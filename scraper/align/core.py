#!/usr/bin/env python3
"""Windowed audio→poem alignment.

Why windows, not "divide the track by the number of couplets":

* A ghazal performance is not a metronome. Shers are held, repeated, skipped,
  and separated by harmonium or sarangi improvisation.
* ASR word timestamps on sung Urdu are noisy, but they are *locally* good: a
  span of 8-12 words around a phrase boundary usually contains the misra.
* So we score every plausible word span against every plausible misra, keep
  only mutually consistent spans (monotonic, non-overlapping), and derive line
  boundaries from the matched words themselves.

The result is a set of *occurrences*: which written couplet was sung, in which
repetition, and exactly when each of its two misras starts and ends. If the
transcript is too poor to support that, we return an empty timing instead of
inventing one.
"""
from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher

from .text import (
    AsrWord,
    RefIndex,
    RefLine,
    content_tokens,
    coverage_score,
    norm_for,
    squash,
    tok_sim,
    tokens_for,
)


@dataclass
class Window:
    i0: int
    i1: int
    start: float
    end: float
    ref: int
    score: float
    words: list[AsrWord]


@dataclass
class Occurrence:
    sher: int
    start: float
    end: float
    score: float
    lines: list[dict]
    pass_no: int = 0


# ---------------------------------------------------------------- phrases


def phrase_spans(words: list[AsrWord], gap: float = 0.85, max_len: float = 14.0) -> list[list[float]]:
    """Group ASR words into sung phrases — used for the vocal map only."""
    if not words:
        return []
    spans: list[list[float]] = []
    start = words[0].start
    prev_end = words[0].end
    for w in words[1:]:
        if w.start - prev_end > gap or w.end - start > max_len:
            if prev_end - start >= 0.4:
                spans.append([round(start, 2), round(prev_end, 2)])
            start = w.start
        prev_end = max(prev_end, w.end)
    if prev_end - start >= 0.4:
        spans.append([round(start, 2), round(prev_end, 2)])
    return spans


def interludes_from(phrases: list[list[float]], duration: float, min_gap: float = 1.6) -> list[list[float]]:
    gaps: list[list[float]] = []
    prev = 0.0
    for s, e in phrases:
        if s - prev >= min_gap:
            gaps.append([round(prev, 2), round(s, 2)])
        prev = max(prev, e)
    if duration - prev >= min_gap:
        gaps.append([round(prev, 2), round(duration, 2)])
    return gaps


# ---------------------------------------------------------------- windows


def _pause_after(words: list[AsrWord], i: int) -> float:
    if i + 1 >= len(words):
        return 9.9
    return max(0.0, words[i + 1].start - words[i].end)


def _pause_before(words: list[AsrWord], i: int) -> float:
    if i <= 0:
        return 9.9
    return max(0.0, words[i].start - words[i - 1].end)


def candidate_windows(words: list[AsrWord], pause: float = 0.5) -> list[tuple[int, int]]:
    """Plausible word spans, anchored on breaths but not limited to them.

    A misra can begin immediately after the previous one, with no audible gap.
    Restricting starts to pauses (an earlier version did) made those lines
    unmatchable. Every word is a start; only ends need a breath or a max length.
    """
    n = len(words)
    if n < 4:
        return [(0, n - 1)] if n else []

    out: list[tuple[int, int]] = []
    for i in range(n - 3):
        for j in range(i + 3, min(n, i + 19)):
            span = words[j].end - words[i].start
            if span > 24:
                break
            at_break = j == n - 1 or _pause_after(words, j) >= pause
            long_enough = j >= i + 6
            if at_break or long_enough:
                out.append((i, j))
    return out


def build_windows(words: list[AsrWord], refs: list[RefLine], script: str, per_window: int = 4) -> list[Window]:
    index = RefIndex(refs)
    out: list[Window] = []

    for i0, i1 in candidate_windows(words):
        hyp_text = " ".join(w.text for w in words[i0 : i1 + 1])
        hyp = content_tokens(hyp_text, script)
        if len(hyp) < 2:
            continue

        for ref_i in index.candidates(hyp, per_window):
            ref = refs[ref_i]
            score, pairs = coverage_score(ref, hyp)
            if score < 0.42:
                continue
            # Fuzzy token matching alone can pair garbled ASR with any line.
            # Require a couple of *exact* normalised tokens as well.
            exact = sum(1 for _, _, sim in pairs if sim >= 0.999)
            if exact < (2 if len(ref.content) >= 4 else 1):
                continue
            # a line that starts mid-breath is probably a chopped line
            if _pause_before(words, i0) < 0.2 and i0 > 0:
                score -= 0.02
            if _pause_after(words, i1) < 0.2 and i1 < len(words) - 1:
                score -= 0.02
            out.append(
                Window(
                    i0=i0,
                    i1=i1,
                    start=words[i0].start,
                    end=words[i1].end,
                    ref=ref_i,
                    score=max(0.0, score),
                    words=words[i0 : i1 + 1],
                )
            )

    # one window per (line, start): the best-scoring one
    best: dict[tuple[int, int], Window] = {}
    for w in out:
        k = (w.ref, w.i0)
        if k not in best or w.score > best[k].score:
            best[k] = w
    return sorted(best.values(), key=lambda w: (w.start, -w.score))


def select_windows(wins: list[Window], refs: list[RefLine], min_score: float = 0.45) -> list[Window]:
    """Longest-path DP: non-overlapping, poem order non-decreasing, repeats allowed."""
    if not wins:
        return []

    # keep the strongest candidates per start so the DP stays small
    wins = [w for w in wins if w.score >= min_score]
    if not wins:
        return []

    n = len(wins)
    best = [w.score for w in wins]
    prev = [-1] * n

    for i in range(n):
        wi = wins[i]
        for j in range(i):
            wj = wins[j]
            if wj.end > wi.start + 0.01:
                continue
            gap = wi.start - wj.end
            # Whisper loops on sung phrases: the same words are emitted twice a
            # few seconds apart. That is an artefact, not a repeated couplet.
            if wi.ref == wj.ref and gap < 8.0:
                continue
            same_or_forward = wi.ref >= wj.ref
            # A repeat of the whole ghazal moves backwards in poem order. Allow
            # it only across a real break and only for a confident match.
            backwards_ok = gap > 8.0 and wi.score >= 0.66
            if not (same_or_forward or backwards_ok):
                continue
            cand = best[j] + wi.score - (0.10 if not same_or_forward else 0.0)
            if cand > best[i]:
                best[i] = cand
                prev[i] = j

    end = max(range(n), key=lambda k: best[k])
    chain: list[Window] = []
    while end >= 0:
        chain.append(wins[end])
        end = prev[end]
    chain.reverse()

    # merge a line that was split by a breath into one line window
    merged: list[Window] = []
    for w in chain:
        if merged and merged[-1].ref == w.ref and w.start - merged[-1].end < 0.9:
            m = merged[-1]
            m.i1 = w.i1
            m.end = w.end
            m.words = m.words + w.words
            m.score = max(m.score, w.score)
        else:
            merged.append(w)
    return merged


# ---------------------------------------------------------------- word times


def _nw_pairs(ref: list[str], hyp: list[str]) -> list[tuple[int, int] | None]:
    """Needleman-Wunsch over display tokens; returns one entry per ref token."""
    n, m = len(ref), len(hyp)
    if not n:
        return []
    if not m:
        return [None] * n
    NEG = -1e9
    dp = [[0.0] * (m + 1) for _ in range(n + 1)]
    back = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        dp[i][0] = dp[i - 1][0] - 1.2
        back[i][0] = 1
    for j in range(1, m + 1):
        dp[0][j] = dp[0][j - 1] - 1.2
        back[0][j] = 2
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            s = tok_sim(ref[i - 1], hyp[j - 1])
            sub = dp[i - 1][j - 1] + (2.0 if s >= 0.8 else (0.4 if s >= 0.55 else -0.8))
            up = dp[i - 1][j] - 1.2
            left = dp[i][j - 1] - 1.2
            if sub >= up and sub >= left:
                dp[i][j], back[i][j] = sub, 0
            elif up >= left:
                dp[i][j], back[i][j] = up, 1
            else:
                dp[i][j], back[i][j] = left, 2

    out: list[tuple[int, int] | None] = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        b = back[i][j]
        if b == 0:
            if tok_sim(ref[i - 1], hyp[j - 1]) >= 0.55:
                out[i - 1] = (i - 1, j - 1)
            i -= 1
            j -= 1
        elif b == 1:
            i -= 1
        else:
            j -= 1
    return out


def word_spans(ref: RefLine, window: Window, script: str) -> tuple[list[list[float]], bool, int, tuple[float, float]]:
    """One [start,end] per display token of the misra, always monotonic.

    Matched tokens keep the ASR word's measured times. Unmatched runs are
    distributed *between their two measured neighbours* by token length. An
    earlier version distributed by a global fraction, which could place a token
    after its right anchor and produce backwards word spans.
    """
    norm = [norm_for(w.text, ref.script) for w in window.words]
    words = [w for w, t in zip(window.words, norm) if t]
    hyp_tokens = [t for t in norm if t]
    if not hyp_tokens or not words:
        return [[window.start, window.end]] * len(ref.tokens), True, 0, (window.start, window.end)

    pairs = _nw_pairs(ref.tokens, hyp_tokens)
    spans: list[list[float] | None] = [None] * len(ref.tokens)
    matched = 0
    for k, p in enumerate(pairs):
        if p is None:
            continue
        j = p[1]
        if 0 <= j < len(words):
            a = words[j].start
            b = max(words[j].end, a + 0.05)
            spans[k] = [round(a, 3), round(b, 3)]
            matched += 1

    # fill each gap between measured anchors
    k = 0
    while k < len(spans):
        if spans[k] is not None:
            k += 1
            continue
        run_start = k
        while k < len(spans) and spans[k] is None:
            k += 1
        run_end = k  # exclusive
        left = spans[run_start - 1][1] if run_start > 0 and spans[run_start - 1] else window.start
        right = spans[run_end][0] if run_end < len(spans) and spans[run_end] else window.end
        if right <= left:
            right = left + 0.05 * (run_end - run_start)

        weights = [max(1, len(ref.tokens[i])) for i in range(run_start, run_end)]
        total = float(sum(weights)) or 1.0
        acc = 0.0
        for i, w in zip(range(run_start, run_end), weights):
            a = left + (right - left) * (acc / total)
            acc += w
            b = left + (right - left) * (acc / total)
            spans[i] = [round(a, 3), round(max(b, a + 0.03), 3)]

    # Whisper occasionally emits overlapping word timestamps (a long word
    # starting before the short word before it ends). Enforce order once, at the
    # end, so the renderer can trust a simple increasing sequence.
    floor = window.start
    for sp in spans:
        if sp is None:
            continue
        a = max(sp[0], floor - 0.01)
        b = max(sp[1], a + 0.03)
        sp[0], sp[1] = round(a, 3), round(b, 3)
        floor = b

    measured = [k for k, p in enumerate(pairs) if p is not None]
    anchor = (window.start, window.end)
    if measured:
        pts = sorted(
            ((spans[k][0], spans[k][1]) for k in measured if spans[k]), key=lambda x: x[0]
        )
        # A single spurious match 10 s before the real line must not drag the
        # line start with it. Cluster measured words by time and keep the
        # densest run.
        clusters: list[list[tuple[float, float]]] = []
        cur: list[tuple[float, float]] = []
        for pt in pts:
            if cur and pt[0] - cur[-1][1] > 3.0:
                clusters.append(cur)
                cur = []
            cur.append(pt)
        if cur:
            clusters.append(cur)
        if clusters:
            best = max(clusters, key=lambda c: (len(c), c[-1][1] - c[0][0]))
            if len(best) >= 2:
                anchor = (best[0][0], best[-1][1])
            elif pts:
                anchor = (pts[0][0], pts[-1][1])

    estimated = matched < len(ref.tokens)
    return [s or [window.start, window.end] for s in spans], estimated, matched, anchor


# ---------------------------------------------------------------- assemble


def align(words: list[AsrWord], refs: list[RefLine], script: str, duration: float) -> dict:
    if not words or not refs:
        return _empty(duration, "no transcript" if not words else "no reference text")

    wins = build_windows(words, refs, script)
    chain = select_windows(wins, refs)
    if not chain:
        return _empty(duration, "no line matched")

    occurrences: list[Occurrence] = []
    open_occ: Occurrence | None = None
    last_sher = -1
    pass_no = 0

    def flush() -> None:
        nonlocal open_occ
        if open_occ is not None:
            occurrences.append(open_occ)
            open_occ = None

    for w in chain:
        ref = refs[w.ref]
        spans, estimated, n_matched, anchor = word_spans(ref, w, script)
        # Anchor the line to its measured words, not to whatever noise the ASR
        # emitted at the edge of the window. This is what removes the "text
        # appears ten seconds early" failure.
        line_start = max(w.start, anchor[0] - 0.12)
        line_end = min(w.end, anchor[1] + 0.18)
        line = {
            "m": ref.misra,
            "start": round(line_start, 3),
            "end": round(max(line_start + 0.3, line_end), 3),
            "words": spans,
            "estimated": estimated,
            "matched": n_matched,
            "ntok": len(ref.tokens),
            "script": ref.script,
            "score": round(w.score, 3),
        }

        if ref.sher < last_sher:
            pass_no += 1
            flush()

        if ref.misra == 0:
            flush()
            open_occ = Occurrence(
                sher=ref.sher,
                start=line["start"],
                end=line["end"],
                score=w.score,
                lines=[line],
                pass_no=pass_no,
            )
        else:
            if (
                open_occ is not None
                and open_occ.sher == ref.sher
                and line["start"] - open_occ.end < 15.0
            ):
                open_occ.lines.append(line)
                open_occ.end = max(open_occ.end, line["end"])
                open_occ.score = max(open_occ.score, w.score)
            else:
                flush()
                open_occ = Occurrence(
                    sher=ref.sher,
                    start=line["start"],
                    end=line["end"],
                    score=w.score,
                    lines=[line],
                    pass_no=pass_no,
                )
        last_sher = ref.sher

    flush()

    # chronological, non-overlapping, long enough to read
    occurrences.sort(key=lambda o: o.start)
    cleaned: list[Occurrence] = []
    for occ in occurrences:
        occ.lines.sort(key=lambda l: l["m"])
        if occ.end - occ.start < 0.8:
            continue
        if cleaned and occ.start < cleaned[-1].end - 0.05:
            occ.start = cleaned[-1].end + 0.02
        if occ.lines and occ.lines[0]["start"] < occ.start:
            occ.lines[0]["start"] = occ.start
        if occ.lines and occ.lines[-1]["end"] > occ.end:
            occ.end = occ.lines[-1]["end"]
        if occ.end <= occ.start:
            continue
        cleaned.append(occ)

    if not cleaned:
        return _empty(duration, "no usable occurrence")

    # Near-duplicate guard: the same sher twice within 22 s is usually one real
    # occurrence plus one ASR-loop false positive. Keep the one with more
    # measured lines (then the better score).
    deduped: list[Occurrence] = []
    for occ in cleaned:
        clash = next((o for o in deduped if o.sher == occ.sher and abs(o.start - occ.start) < 22), None)
        if clash is None:
            deduped.append(occ)
            continue
        better = (len(occ.lines), occ.score) > (len(clash.lines), clash.score)
        if better:
            deduped[deduped.index(clash)] = occ
    cleaned = sorted(deduped, key=lambda o: o.start)

    sher_out = []
    for occ in cleaned:
        sher_out.append(
            {
                "i": occ.sher,
                "pass": occ.pass_no,
                "start": round(occ.start, 3),
                "end": round(occ.end, 3),
                "score": round(occ.score, 3),
                "lines": occ.lines,
            }
        )

    phrases = phrase_spans(words)
    interludes = interludes_from(phrases, duration)

    # ---- quality -----------------------------------------------------------
    line_scores = [w.score for w in chain]
    line_score = sum(line_scores) / len(line_scores)
    total_tokens = sum(line.get("ntok", 0) for occ in cleaned for line in occ.lines)
    matched_tokens = sum(line.get("matched", 0) for occ in cleaned for line in occ.lines)
    word_cov = matched_tokens / max(1, total_tokens)

    vocal_time = sum(e - s for s, e in phrases) or max(1.0, words[-1].end - words[0].start)
    covered = sum(o.end - o.start for o in cleaned)
    temporal = min(1.0, covered / max(1.0, vocal_time))

    violations = 0
    for a, b in zip(cleaned, cleaned[1:]):
        if (b.pass_no, b.sher) < (a.pass_no, a.sher):
            violations += 1
    monotonic = 1.0 - violations / max(1, len(cleaned) - 1)

    distinct = len({o.sher for o in cleaned})
    written = len({r.sher for r in refs})
    coverage = distinct / max(1, written)

    score = (
        0.50 * line_score
        + 0.20 * word_cov
        + 0.15 * temporal
        + 0.10 * monotonic
        + 0.05 * min(1.0, coverage / 0.7)
    )
    if len(cleaned) < 3:
        score *= 0.75

    return {
        "v": 3,
        "duration": round(duration, 2),
        "method": "asr",
        "phrases": phrases,
        "interludes": interludes,
        "shers": sher_out,
        "quality": {
            "score": round(min(1.0, max(0.0, score)), 3),
            "lineScore": round(line_score, 3),
            "wordCoverage": round(word_cov, 3),
            "temporal": round(temporal, 3),
            "monotonic": round(monotonic, 3),
            "coverage": round(coverage, 3),
        },
    }


def _empty(duration: float, reason: str) -> dict:
    return {
        "v": 3,
        "duration": round(duration, 2),
        "method": "asr",
        "phrases": [],
        "interludes": [],
        "shers": [],
        "quality": {"score": 0.0, "reason": reason},
    }
