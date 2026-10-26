"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Catalog, ScriptMode } from "@/lib/types";
import { fmtTime } from "@/lib/usePlayer";
import type { TrackTiming } from "@/lib/timing";

/**
 * Tap-sync studio.
 *
 * The automatic aligner gets most recordings close; this is how a human makes
 * one exact. Play the recording, press Space at the instant each misra begins.
 * The export is a normal v3 timing file, so the player cannot tell whether a
 * timing came from ASR or from a person — except that `method` says `manual`.
 */

type Tap = { line: number; sher: number; misra: number; t: number };

type FlatLine = { sher: number; misra: number; text: string };

const SCRIPT_FIELD: Record<ScriptMode, "u" | "r" | "h"> = {
  urdu: "u",
  roman: "r",
  hindi: "h",
};

function lineText(raw: string, script: ScriptMode): string[] {
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function buildTiming(
  taps: Tap[],
  lines: FlatLine[],
  duration: number,
  trackId: string
): TrackTiming {
  const sorted = [...taps].sort((a, b) => a.t - b.t);
  const windows = sorted.map((tap, k) => {
    const next = k + 1 < sorted.length ? sorted[k + 1].t : null;
    const maxLen = 11.0;
    const end =
      next === null
        ? Math.min(duration, tap.t + 6)
        : Math.min(next - 0.06, tap.t + maxLen);
    return {
      sher: tap.sher,
      misra: tap.misra,
      start: Math.round(tap.t * 1000) / 1000,
      end: Math.round(Math.max(tap.t + 0.4, end) * 1000) / 1000,
    };
  });

  const occ: Array<{
    i: number;
    pass: number;
    start: number;
    end: number;
    lines: Array<{ m: number; start: number; end: number }>;
  }> = [];

  let cur: (typeof occ)[number] | null = null;
  for (const w of windows) {
    const last = cur?.lines[cur.lines.length - 1];
    const repeated =
      !!cur &&
      (cur.i !== w.sher ||
        (w.misra === 0 && cur.lines.some((l) => l.m === 0)) ||
        (!!last && w.misra < last.m));
    if (!cur || repeated) {
      if (cur) occ.push(cur);
      cur = {
        i: w.sher,
        pass: 0,
        start: w.start,
        end: w.end,
        lines: [{ m: w.misra, start: w.start, end: w.end }],
      };
    } else {
      cur.lines.push({ m: w.misra, start: w.start, end: w.end });
      cur.end = Math.max(cur.end, w.end);
    }
  }
  if (cur) occ.push(cur);

  const seen = new Map<number, number>();
  for (const o of occ) {
    o.lines.sort((a, b) => a.m - b.m);
    o.start = Math.min(...o.lines.map((l) => l.start));
    o.end = Math.max(...o.lines.map((l) => l.end));
    const p = seen.get(o.i) ?? 0;
    o.pass = p;
    seen.set(o.i, p + 1);
  }
  occ.sort((a, b) => a.start - b.start);

  const phrases: [number, number][] = occ.map((o) => [
    Math.round(o.start * 10) / 10,
    Math.round(o.end * 10) / 10,
  ]);
  const interludes: [number, number][] = [];
  let prev = 0;
  for (const [s, e] of phrases) {
    if (s - prev >= 1.6) interludes.push([Math.round(prev * 10) / 10, Math.round(s * 10) / 10]);
    prev = Math.max(prev, e);
  }
  if (duration - prev >= 1.6) {
    interludes.push([Math.round(prev * 10) / 10, Math.round(duration * 10) / 10]);
  }

  const covered = occ.reduce((n, o) => n + (o.end - o.start), 0);
  const first = occ[0]?.start ?? 0;
  const last = occ[occ.length - 1]?.end ?? duration;
  const temporal = covered / Math.max(1, last - first);

  return {
    v: 3,
    trackId,
    duration: Math.round(duration * 100) / 100,
    method: "manual",
    phrases,
    interludes,
    shers: occ.map((o) => ({
      i: o.i,
      pass: o.pass,
      start: o.start,
      end: o.end,
      lines: o.lines,
      anchored: true,
    })),
    quality: {
      score: Math.round((0.86 + 0.1 * Math.min(1, temporal)) * 1000) / 1000,
      lineScore: 0.95,
      wordCoverage: 0,
      temporal: Math.round(temporal * 1000) / 1000,
      monotonic: 1,
      coverage: 1,
    },
  };
}

export default function SyncStudio({ catalog }: { catalog: Catalog }) {
  const withText = useMemo(
    () => catalog.tracks.filter((t) => t.ghazalId && catalog.ghazals.some((g) => g.id === t.ghazalId)),
    [catalog]
  );

  const [query, setQuery] = useState("");
  const [trackId, setTrackId] = useState(withText[0]?.id ?? "");
  const [script, setScript] = useState<ScriptMode>("roman");
  const [taps, setTaps] = useState<Tap[]>([]);
  const [cursor, setCursor] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [preview, setPreview] = useState<TrackTiming | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const track = withText.find((t) => t.id === trackId) ?? withText[0];
  const ghazal = catalog.ghazals.find((g) => g.id === track?.ghazalId) ?? null;

  const lines = useMemo<FlatLine[]>(() => {
    if (!ghazal) return [];
    const out: FlatLine[] = [];
    ghazal.shers.forEach((sher, si) => {
      const raw = sher[SCRIPT_FIELD[script]] || sher.u || sher.r || "";
      lineText(raw, script).slice(0, 2).forEach((text, mi) => {
        out.push({ sher: si, misra: mi, text });
      });
    });
    return out;
  }, [ghazal, script]);

  const say = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1600);
  }, []);

  // restore taps for this recording
  useEffect(() => {
    setTaps([]);
    setCursor(0);
    setPreview(null);
    if (!track?.id) return;
    try {
      const raw = localStorage.getItem(`gfz.taps.${track.id}`);
      if (raw) {
        const doc = JSON.parse(raw) as { taps?: Tap[]; cursor?: number };
        if (Array.isArray(doc.taps)) {
          setTaps(doc.taps);
          setCursor(typeof doc.cursor === "number" ? doc.cursor : doc.taps.length);
        }
      }
    } catch {
      /* ignore */
    }
  }, [track?.id]);

  useEffect(() => {
    if (!track?.id) return;
    try {
      localStorage.setItem(`gfz.taps.${track.id}`, JSON.stringify({ taps, cursor }));
    } catch {
      /* ignore */
    }
  }, [track?.id, taps, cursor]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !track) return;
    if (el.src !== track.url) {
      el.src = track.url;
      el.load();
      setTime(0);
      setDuration(0);
    }
  }, [track]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.play().catch(() => setPlaying(false));
    } else {
      el.pause();
    }
  }, [playing, track?.url]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const tick = () => setTime(el.currentTime);
    el.addEventListener("timeupdate", tick);
    el.addEventListener("loadedmetadata", tick);
    return () => {
      el.removeEventListener("timeupdate", tick);
      el.removeEventListener("loadedmetadata", tick);
    };
  }, [track?.url]);

  const record = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (!playing) {
      say("press play first");
      return;
    }
    const line = lines[cursor];
    if (!line) {
      say("all lines tapped — export");
      return;
    }
    setTaps((prev) => [...prev, { line: cursor, sher: line.sher, misra: line.misra, t: el.currentTime }]);
    setCursor((c) => c + 1);
  }, [cursor, lines, playing, say]);

  const undo = useCallback(() => {
    setTaps((prev) => {
      if (!prev.length) return prev;
      const last = prev[prev.length - 1];
      setCursor(last.line);
      return prev.slice(0, -1);
    });
  }, []);

  const repeatSher = useCallback(() => {
    const line = lines[cursor];
    const target = line ? line.sher : Math.max(0, (lines[lines.length - 1]?.sher ?? 0) - 1);
    const first = lines.findIndex((l) => l.sher === target);
    if (first >= 0) {
      setCursor(first);
      say(`repeat sher ${target + 1}`);
    }
  }, [cursor, lines, say]);

  const skip = useCallback(() => {
    setCursor((c) => Math.min(lines.length, c + 1));
    say("skipped");
  }, [lines.length, say]);

  const reset = useCallback(() => {
    setTaps([]);
    setCursor(0);
    setPreview(null);
    say("reset");
  }, [say]);

  const build = useCallback(() => {
    if (!track || !audioRef.current) return null;
    const dur = audioRef.current.duration || duration || track.duration || 0;
    if (!taps.length || !dur) return null;
    return buildTiming(taps, lines, dur, track.id);
  }, [taps, lines, track, duration]);

  const exportJson = useCallback(() => {
    const doc = build();
    if (!doc) {
      say("nothing to export yet");
      return;
    }
    setPreview(doc);
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${track!.id}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    say("exported — drop it in data/taps/");
  }, [build, say, track]);

  const copyJson = useCallback(async () => {
    const doc = build();
    if (!doc) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(doc, null, 2));
      say("timing copied");
    } catch {
      say("clipboard blocked");
    }
  }, [build, say]);

  const seek = useCallback((t: number) => {
    const el = audioRef.current;
    if (!el) return;
    el.currentTime = Math.max(0, Math.min(el.duration || 0, t));
    setTime(el.currentTime);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (e.repeat) return;
        record();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        undo();
      } else if (e.key.toLowerCase() === "r") {
        e.preventDefault();
        repeatSher();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        skip();
      } else if (e.key === "Enter") {
        e.preventDefault();
        exportJson();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        seek((audioRef.current?.currentTime ?? 0) - 5);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        seek((audioRef.current?.currentTime ?? 0) + 5);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [record, undo, repeatSher, skip, exportJson, seek]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return withText;
    return withText.filter((t) => `${t.title} ${t.artist}`.toLowerCase().includes(q));
  }, [query, withText]);

  const current = lines[cursor];
  const next = lines[cursor + 1];
  const lastLine = lines[lines.length - 1];
  const done = cursor >= lines.length;
  const progress = duration ? Math.min(100, (time / duration) * 100) : 0;

  return (
    <div className="min-h-[100dvh] bg-[#05070c] text-white">
      <audio
        ref={audioRef}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
        onEnded={() => setPlaying(false)}
        preload="metadata"
        crossOrigin="anonymous"
      />

      <div className="mx-auto flex min-h-[100dvh] max-w-6xl flex-col px-4 py-4 sm:px-6 sm:py-6">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-white/10 pb-4">
          <div>
            <p className="text-[10px] uppercase tracking-[0.3em] text-white/35">internal tool</p>
            <h1 className="roman mt-1 text-[clamp(1.3rem,3vw,1.9rem)] text-white/95">Sync studio</h1>
            <p className="mt-1 text-[11.5px] text-white/40">
              play · press space at the start of every misra · export the json
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="filter recordings"
              className="h-9 w-[210px] rounded-full border border-white/12 bg-white/[0.06] px-3.5 text-[12px] text-white/80 outline-none placeholder:text-white/25 focus:border-white/30"
            />
            <select
              value={track?.id ?? ""}
              onChange={(e) => setTrackId(e.target.value)}
              className="h-9 max-w-[280px] rounded-full border border-white/12 bg-[#10141d] px-3 text-[12px] text-white/80 outline-none"
            >
              {filtered.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title} — {t.artist}
                </option>
              ))}
            </select>
          </div>
        </header>

        <div className="grid flex-1 gap-4 py-4 lg:grid-cols-[1fr_320px]">
          <main className="flex min-h-[420px] flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-4 sm:p-6">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-[13px] font-medium text-white/90">{track?.title}</p>
                <p className="truncate text-[11px] text-white/40">
                  {track?.artist} · {ghazal?.poet} · {fmtTime(duration || track?.duration || 0)}
                </p>
              </div>
              <div className="flex items-center gap-0.5 rounded-full bg-white/[0.07] p-0.5">
                {(["urdu", "roman", "hindi"] as ScriptMode[]).map((s) => (
                  <button
                    key={s}
                    onClick={() => setScript(s)}
                    className={`rounded-full px-2.5 py-1 text-[10.5px] capitalize ${
                      script === s ? "bg-white/90 text-black" : "text-white/50 hover:text-white/80"
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-1 flex-col items-center justify-center py-8 text-center">
              {done ? (
                <div className="max-w-md">
                  <p className="text-[11px] uppercase tracking-[0.24em] text-emerald-300/70">all lines tapped</p>
                  <p className="roman mt-3 text-[1.4rem] text-white/85">
                    {taps.length} lines · {new Set(taps.map((t) => t.sher)).size} couplets
                  </p>
                  <button
                    onClick={exportJson}
                    className="mt-6 rounded-full bg-white px-5 py-2 text-[12.5px] font-medium text-black"
                  >
                    export timing json
                  </button>
                </div>
              ) : (
                <div className="w-full max-w-2xl">
                  {current && (
                    <p
                      className={`${
                        script === "urdu" ? "urdu" : script === "hindi" ? "hindi" : "roman"
                      } text-[clamp(1.3rem,4vw,2.3rem)] leading-[1.9] text-[#f7f2e9]`}
                      dir={script === "urdu" ? "rtl" : "ltr"}
                    >
                      {current.text}
                    </p>
                  )}
                  {next && (
                    <p className="mt-5 text-[11px] uppercase tracking-[0.2em] text-white/25">
                      next · sher {next.sher + 1}
                    </p>
                  )}
                  <p className="mt-2 text-[10px] uppercase tracking-[0.2em] text-white/20">
                    line {cursor + 1} / {lines.length}
                    {taps.length ? ` · ${taps.length} tapped` : ""}
                  </p>
                </div>
              )}
            </div>

            <div className="mt-2 flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <button
                  onClick={() => setPlaying((p) => !p)}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white text-black"
                  aria-label={playing ? "Pause" : "Play"}
                >
                  {playing ? "❚❚" : "▶"}
                </button>
                <div
                  className="relative h-8 flex-1 cursor-pointer"
                  onPointerDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    seek(((e.clientX - r.left) / r.width) * (duration || 0));
                  }}
                >
                  <div className="absolute top-1/2 h-[3px] w-full -translate-y-1/2 rounded-full bg-white/12">
                    <div className="h-full rounded-full bg-white/70" style={{ width: `${progress}%` }} />
                    {taps.map((t, i) => (
                      <span
                        key={i}
                        className="absolute top-1/2 h-2 w-[2px] -translate-y-1/2 rounded bg-amber-300/80"
                        style={{ left: `${duration ? (t.t / duration) * 100 : 0}%` }}
                      />
                    ))}
                  </div>
                </div>
                <span className="tabnum w-[86px] text-right text-[11px] text-white/45">
                  {fmtTime(time)} / {fmtTime(duration)}
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={record}
                  className="h-12 flex-1 rounded-full bg-[#cbb894] px-6 text-[13px] font-semibold tracking-wide text-[#171208] transition-transform active:scale-[0.99]"
                >
                  TAP · space
                </button>
                <button onClick={undo} className="h-12 rounded-full border border-white/15 px-4 text-[12px] text-white/70">
                  undo
                </button>
                <button onClick={repeatSher} className="h-12 rounded-full border border-white/15 px-4 text-[12px] text-white/70">
                  repeat sher
                </button>
                <button onClick={skip} className="h-12 rounded-full border border-white/15 px-4 text-[12px] text-white/70">
                  skip
                </button>
                <button onClick={reset} className="h-12 rounded-full border border-white/10 px-4 text-[12px] text-white/40">
                  reset
                </button>
              </div>
            </div>
          </main>

          <aside className="flex max-h-[70vh] flex-col rounded-3xl border border-white/10 bg-white/[0.03] p-3 lg:max-h-none">
            <div className="flex items-center justify-between px-1 pb-2">
              <p className="text-[10px] uppercase tracking-[0.22em] text-white/35">taps</p>
              <p className="tabnum text-[10.5px] text-white/30">{taps.length}</p>
            </div>
            <div ref={listRef} className="thin-scroll min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {taps.length === 0 && (
                <p className="px-1 py-6 text-[11.5px] leading-relaxed text-white/25">
                  No taps yet. Play the recording, then hit space exactly when the singer starts
                  each line. The dialogue above always shows the line you are about to tap.
                </p>
              )}
              {taps
                .map((t, i) => ({ ...t, i }))
                .reverse()
                .map((t) => (
                  <button
                    key={t.i}
                    onClick={() => seek(t.t)}
                    className="flex w-full items-start gap-2 rounded-xl px-2 py-1.5 text-left hover:bg-white/[0.06]"
                  >
                    <span className="tabnum w-10 shrink-0 text-[10px] text-white/30">{fmtTime(t.t)}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[10px] uppercase tracking-[0.14em] text-white/25">
                        sher {t.sher + 1} · line {t.misra + 1}
                      </span>
                      <span className="block truncate text-[11.5px] text-white/65">
                        {lines[t.line]?.text ?? "—"}
                      </span>
                    </span>
                  </button>
                ))}
            </div>

            <div className="mt-2 space-y-1.5 border-t border-white/10 pt-2">
              <button
                onClick={exportJson}
                className="h-9 w-full rounded-full bg-white/90 text-[11.5px] font-medium text-black"
              >
                export json
              </button>
              <button
                onClick={copyJson}
                className="h-9 w-full rounded-full border border-white/15 text-[11.5px] text-white/65"
              >
                copy to clipboard
              </button>
              <p className="px-1 pt-1 text-[9.5px] leading-relaxed text-white/22">
                drop exports in <span className="text-white/40">data/taps/</span> and run
                <span className="text-white/40"> python scraper/import_taps.py</span>
              </p>
            </div>
          </aside>
        </div>

        {preview && (
          <p className="pb-2 text-[10.5px] text-white/30">
            preview: {preview.shers.length} occurrences · {preview.phrases?.length ?? 0} phrases · q=
            {preview.quality && typeof preview.quality === "object" ? preview.quality.score : "—"}
          </p>
        )}
      </div>

      {toast && (
        <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/80 px-4 py-1.5 text-[11px] text-white/85">
          {toast}
        </div>
      )}
    </div>
  );
}
