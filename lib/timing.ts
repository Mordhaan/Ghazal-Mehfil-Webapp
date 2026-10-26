/**
 * Lyric timing model.
 *
 * One principle: a timestamp is either *measured* or it is not. Nothing in this
 * file interpolates a verse onto a timer, because that is exactly how lyrics
 * drift out of sync with the performance. If a recording has no measured
 * timing, `normalizeTiming` returns null and the UI says so.
 *
 * Schema v3 (per recording, `public/timings/<trackId>.json`):
 *   {
 *     "v": 3, "trackId": "t0", "duration": 221.3, "method": "asr",
 *     "quality": { "score": 0.83, ... },
 *     "phrases":  [[9.56, 12.64], ...],     // sung phrases (for the vocal map)
 *     "interludes": [[0, 9.56], ...],
 *     "shers": [
 *       { "i": 0, "pass": 0, "start": 9.56, "end": 23.19,
 *         "lines": [
 *           { "m": 0, "start": 9.56, "end": 12.64, "words": [[9.56,9.90], ...] },
 *           { "m": 1, "start": 15.95, "end": 23.19, "words": [...] }
 *         ] }
 *     ]
 *   }
 */

export type Span = [number, number];

export type WordSpan = [number, number];

export type LineTiming = {
  /** Misra index inside the couplet: 0 or 1. */
  m: number;
  start: number;
  end: number;
  /** One span per whitespace token of that misra, in reading order. */
  words?: WordSpan[];
  /** True when word spans were inferred rather than measured by the aligner. */
  estimated?: boolean;
};

export type SherTiming = {
  /** Index into `ghazal.shers` — the *written* couplet, not the timeline slot. */
  i: number;
  /** Which repetition of the couplet this is (0 = first time it is sung). */
  pass?: number;
  start: number;
  end: number;
  lines?: LineTiming[];
  anchored?: boolean;
  score?: number;
};

export type TimingQuality = {
  /** 0..1 — how much of this timing is backed by measured word times. */
  score: number;
  lineScore?: number;
  coverage?: number;
  wordCoverage?: number;
  monotonic?: number;
  temporal?: number;
};

export type TrackTiming = {
  v?: number;
  trackId?: string;
  duration: number;
  /** Sung phrases; falls back to `vocals` for v1 files. */
  phrases?: Span[];
  vocals?: Span[];
  interludes?: Span[];
  shers: SherTiming[];
  method: "asr" | "segmented" | "manual";
  quality?: TimingQuality | number;
  offset?: number;
  coverage?: number;
};

export type TimingIndex = {
  v?: number;
  generated?: string;
  tracks: Record<string, { q?: number; m?: string; d?: number; n?: number }>;
};

export type LyricPhase = "intro" | "verse" | "interlude" | "outro" | "untimed";

/* ------------------------------------------------------------------------- */
/* normalisation                                                             */
/* ------------------------------------------------------------------------- */

type Loose = Partial<TrackTiming> & {
  timings?: Array<{ sherIndex: number; start: number; end: number }>;
  shers?: Array<
    | SherTiming
    | {
        sherIndex?: number;
        start?: number;
        end?: number;
        lines?: Array<LineTiming | Span>;
      }
  >;
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function normLine(raw: LineTiming | Span | undefined, idx: number): LineTiming | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    const [a, b] = raw;
    if (num(a) === null || num(b) === null) return null;
    return { m: idx, start: a, end: b };
  }
  const start = num(raw.start);
  const end = num(raw.end);
  if (start === null || end === null || end <= start) return null;
  const words = Array.isArray(raw.words)
    ? raw.words
        .filter((w): w is Span => Array.isArray(w) && num(w[0]) !== null && num(w[1]) !== null)
        .map((w) => [w[0], w[1]] as Span)
        .filter(([a, b]) => b > a)
    : undefined;
  return {
    m: typeof raw.m === "number" ? raw.m : idx,
    start,
    end,
    words: words && words.length ? words : undefined,
    estimated: raw.estimated === true,
  };
}

function qualityOf(raw: TimingQuality | number | undefined, method: string): TimingQuality {
  if (typeof raw === "number") return { score: raw };
  if (raw && typeof raw.score === "number") return raw;
  // Legacy files never carried a score. They are measured phrase boundaries but
  // not content-anchored, so they sit below the "verified" line on purpose.
  return { score: method === "asr" ? 0.5 : 0.35 };
}

/**
 * Accepts every timing shape this project has ever written and returns the v3
 * model — or null when there is nothing honest to show.
 */
export function normalizeTiming(raw: unknown, trackId?: string): TrackTiming | null {
  if (!raw || typeof raw !== "object") return null;
  const doc = raw as Loose;
  const method: TrackTiming["method"] =
    doc.method === "asr" || doc.method === "manual" || doc.method === "segmented"
      ? doc.method
      : "segmented";

  const written: SherTiming[] = [];

  if (Array.isArray(doc.shers)) {
    for (const item of doc.shers) {
      if (!item || typeof item !== "object") continue;
      const start = num((item as SherTiming).start);
      const end = num((item as SherTiming).end);
      if (start === null || end === null || end <= start) continue;
      const idx = num((item as SherTiming).i);
      const legacyIdx = num((item as { sherIndex?: number }).sherIndex);
      const i = idx ?? legacyIdx;
      if (i === null || i < 0) continue;
      const lines = Array.isArray((item as SherTiming).lines)
        ? ((item as SherTiming).lines as Array<LineTiming | Span>)
            .map((l, k) => normLine(l, k))
            .filter((l): l is LineTiming => Boolean(l))
            .sort((a, b) => a.start - b.start)
        : undefined;
      written.push({
        i,
        pass: num((item as SherTiming).pass) ?? 0,
        start,
        end,
        lines: lines && lines.length ? lines : undefined,
        anchored: (item as SherTiming).anchored,
        score: num((item as SherTiming).score) ?? undefined,
      });
    }
  }

  // Old per-track `timings: [{sherIndex,start,end}]` shape.
  if (!written.length && Array.isArray(doc.timings)) {
    for (const t of doc.timings) {
      const start = num(t?.start);
      const end = num(t?.end);
      const i = num(t?.sherIndex);
      if (start === null || end === null || i === null || end <= start) continue;
      written.push({ i, pass: 0, start, end });
    }
  }

  if (!written.length) return null;

  written.sort((a, b) => a.start - b.start || a.i - b.i);

  // Repair overlaps instead of dropping the verse: a 40 ms overlap is a
  // rounding artefact, not a reason to flash text at the wrong time.
  for (let k = 1; k < written.length; k += 1) {
    if (written[k].start < written[k - 1].start) written[k].start = written[k - 1].start;
    if (written[k].start < written[k - 1].end - 0.02) {
      written[k].start = written[k - 1].end - 0.02;
    }
    if (written[k].end <= written[k].start + 0.05) {
      written[k].end = written[k].start + 0.05;
    }
  }

  const duration = num(doc.duration) ?? written[written.length - 1].end;
  const phrases = (doc.phrases ?? doc.vocals ?? [])
    .filter((p): p is Span => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null)
    .map(([a, b]) => [a, b] as Span);

  return {
    v: 3,
    trackId,
    duration,
    phrases,
    vocals: phrases,
    interludes: (doc.interludes ?? [])
      .filter((p): p is Span => Array.isArray(p) && num(p[0]) !== null && num(p[1]) !== null)
      .map(([a, b]) => [a, b] as Span),
    shers: written,
    method,
    quality: qualityOf(doc.quality, method),
    offset: num(doc.offset) ?? 0,
    coverage: num(doc.coverage) ?? undefined,
  };
}

/* ------------------------------------------------------------------------- */
/* lookups — binary search because this runs on every animation frame        */
/* ------------------------------------------------------------------------- */

/** Last index whose `start` is <= t, or -1. */
export function lastBefore<T extends { start: number }>(items: readonly T[], t: number): number {
  let lo = 0;
  let hi = items.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (items[mid].start <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export function occurrenceAt(shers: readonly SherTiming[], t: number): number {
  return lastBefore(shers, t);
}

export type LineState = {
  /** Index into the occurrence's `lines`, or -1 between misras / outside. */
  line: number;
  /** Index into that line's `words`, or -1. */
  word: number;
  /** True while the current line's measured window is on screen. */
  inside: boolean;
};

export function lineStateAt(occ: SherTiming | undefined, t: number): LineState {
  if (!occ || !occ.lines?.length) return { line: -1, word: -1, inside: false };
  const index = lastBefore(occ.lines, t);
  if (index < 0) return { line: -1, word: -1, inside: false };
  const line = occ.lines[index];
  // Between two misras the singer takes a breath. Keep the last line as the
  // visual anchor (so the couplet does not flash) but highlight no word.
  if (t >= line.end) return { line: index, word: -1, inside: false };
  const word = line.words?.length ? lastBefore(line.words.map(([a]) => ({ start: a })), t) : -1;
  return { line: index, word, inside: true };
}

export function phaseAt(timing: TrackTiming | null, t: number): LyricPhase {
  if (!timing || !timing.shers.length) return "untimed";
  const shers = timing.shers;
  if (t < shers[0].start) return "intro";
  if (t > shers[shers.length - 1].end) return "outro";
  const idx = occurrenceAt(shers, t);
  if (idx < 0) return "intro";
  if (t < shers[idx].end) return "verse";
  return "interlude";
}

/** Closest occurrence fully after t — what the interlude preview should show. */
export function nextOccurrence(timing: TrackTiming | null, t: number): number {
  if (!timing) return -1;
  for (let k = 0; k < timing.shers.length; k += 1) {
    if (timing.shers[k].start > t) return k;
  }
  return -1;
}

export function qualityScore(timing: TrackTiming | null): number {
  if (!timing?.quality) return 0;
  return typeof timing.quality === "number" ? timing.quality : timing.quality.score;
}

/** Enough measured detail to drive a word-by-word highlight. */
export function isKaraoke(timing: TrackTiming | null): boolean {
  if (!timing) return false;
  // Word-level highlighting is only honest when the aligner actually measured
  // most of the words and the overall match is trustworthy. Otherwise the UI
  // falls back to line-level highlighting, which cannot jitter word by word.
  if (timing.method !== "asr" || qualityScore(timing) < 0.5) return false;
  return timing.shers.some((s) => s.lines?.some((l) => (l.words?.length ?? 0) > 1 && !l.estimated));
}

export function tokenizeLine(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean);
}
