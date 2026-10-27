"use client";

import { useMemo } from "react";
import { useAudioClock } from "@/lib/useAudioClock";
import type { TimingState } from "@/lib/useTiming";
import type { GhazalText, ScriptMode, Sher, Track } from "@/lib/types";
import {
  isKaraoke,
  lineStateAt,
  nextOccurrence,
  occurrenceAt,
  phaseAt,
  qualityScore,
  tokenizeLine,
  type LineTiming,
  type SherTiming,
  type TrackTiming,
} from "@/lib/timing";

type Props = {
  audioRef: React.RefObject<HTMLAudioElement>;
  timing: TrackTiming | null;
  timingState: TimingState;
  ghazal: GhazalText | null;
  track: Track;
  script: ScriptMode;
  /** Seconds added to the audio clock. Positive = lyrics arrive later. */
  offset: number;
};

const SCRIPT_CLASS: Record<ScriptMode, string> = {
  urdu: "urdu text-[clamp(1.18rem,3.7vw,2.35rem)] leading-[2.05]",
  roman: "roman text-[clamp(1rem,2.9vw,1.75rem)] leading-[1.55]",
  hindi: "hindi text-[clamp(0.92rem,2.75vw,1.6rem)] leading-[1.7]",
};

function Equalizer({ tone = "default" }: { tone?: "default" | "faint" }) {
  return (
    <span className="inline-flex items-end gap-[3px]" aria-hidden="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`w-[2.5px] rounded-full animate-breathe ${
            tone === "faint" ? "bg-white/20" : "bg-white/35"
          }`}
          style={{ height: `${7 + (i % 3) * 5}px`, animationDelay: `${i * 150}ms` }}
        />
      ))}
    </span>
  );
}

/** One misra. Word spans are used only when the count matches the text exactly. */
function Misra({
  text,
  timing,
  activeWord,
  dim,
  karaoke,
  script,
  className = "",
}: {
  text: string;
  timing?: LineTiming;
  activeWord: number;
  dim: boolean;
  karaoke: boolean;
  script: ScriptMode;
  className?: string;
}) {
  const tokens = useMemo(() => tokenizeLine(text), [text]);
  const spans = timing?.words;
  const perWord = karaoke && !!spans && spans.length === tokens.length && !timing?.estimated;

  const base = `${SCRIPT_CLASS[script]} transition-[color,opacity,filter] duration-200 ${
    dim ? "text-white/32" : "text-[#f6f1e8]"
  } ${className}`;

  if (!perWord) {
    return (
      <p
        dir={script === "urdu" ? "rtl" : "ltr"}
        lang={script === "urdu" ? "ur" : script === "hindi" ? "hi" : "ur-Latn"}
        className={base}
        style={!dim ? { textShadow: "0 2px 24px rgba(0,0,0,0.8)" } : undefined}
      >
        {text}
      </p>
    );
  }

  return (
    <p
      dir={script === "urdu" ? "rtl" : "ltr"}
      lang={script === "urdu" ? "ur" : script === "hindi" ? "hi" : "ur-Latn"}
      className={base}
      style={!dim ? { textShadow: "0 2px 24px rgba(0,0,0,0.8)" } : undefined}
    >
      {tokens.map((tok, i) => {
        const state = activeWord < 0 ? "unsung" : i < activeWord ? "sung" : i === activeWord ? "sing" : "unsung";
        return (
          <span
            key={`${i}-${tok}`}
            className={
              state === "sing"
                ? "text-white"
                : state === "sung"
                ? "text-[#f6f1e8]/88"
                : "text-[#f6f1e8]/34"
            }
            style={
              state === "sing"
                ? { textShadow: "0 0 22px rgba(203,184,148,0.55), 0 2px 18px rgba(0,0,0,0.8)" }
                : undefined
            }
          >
            {tok}
            {i < tokens.length - 1 ? " " : ""}
          </span>
        );
      })}
    </p>
  );
}

function scriptText(sher: Sher | undefined, script: ScriptMode): string {
  if (!sher) return "";
  if (script === "urdu") return sher.u || sher.r || "";
  if (script === "hindi") return sher.h || sher.r || sher.u || "";
  return sher.r || sher.u || "";
}

function Couplet({
  sher,
  occurrence,
  activeLine,
  activeWord,
  script,
  dim = false,
  karaoke = true,
}: {
  sher: Sher | undefined;
  occurrence?: SherTiming;
  activeLine: number;
  activeWord: number;
  script: ScriptMode;
  dim?: boolean;
  karaoke?: boolean;
}) {
  const lines = scriptText(sher, script).split("\n").filter((l) => l.trim().length > 0);
  return (
    <div className="space-y-2 sm:space-y-3">
      {lines.map((line, li) => {
        const lt = occurrence?.lines?.find((l) => l.m === li);
        const isActive = activeLine === li;
        return (
          <Misra
            key={li}
            text={line}
            timing={lt}
            activeWord={isActive ? activeWord : -1}
            dim={dim || (activeLine >= 0 && !isActive)}
            karaoke={karaoke}
            script={script}
          />
        );
      })}
    </div>
  );
}

function PoetRule({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 flex items-center justify-center gap-2.5 sm:mt-7">
      <span className="h-px w-8 bg-white/20" />
      <span className="text-[10.5px] uppercase tracking-[0.26em] text-white/45">{children}</span>
      <span className="h-px w-8 bg-white/20" />
    </div>
  );
}

export default function Lyrics({
  audioRef,
  timing,
  timingState,
  ghazal,
  track,
  script,
  offset,
}: Props) {
  const clock = useAudioClock(audioRef);
  const t = clock + offset;

  const shers = ghazal?.shers ?? [];
  const phase = phaseAt(timing, t);
  const occIndex = timing ? occurrenceAt(timing.shers, t) : -1;
  const occ = occIndex >= 0 ? timing!.shers[occIndex] : undefined;
  const nextIndex = timing ? nextOccurrence(timing, t) : -1;
  const next = nextIndex >= 0 ? timing!.shers[nextIndex] : undefined;

  const state = occ ? lineStateAt(occ, t) : { line: -1, word: -1, inside: false };
  const activeM = state.line >= 0 && occ?.lines ? occ.lines[state.line].m : -1;

  const karaoke = isKaraoke(timing);
  const q = qualityScore(timing);
  const pending = timingState === "idle" || timingState === "loading";

  const containerProps = {
    "data-phase": phase,
    "data-occ": occIndex,
    "data-sher": occ?.i ?? -1,
    "data-line": activeM,
    "data-word": state.word,
  } as const;

  /* ---------------- no text at all ---------------- */
  if (!ghazal || !shers.length) {
    return (
      <div key={track.id} className="animate-fade-swap" {...containerProps}>
        <p className="roman text-[clamp(1.2rem,3.6vw,2.1rem)] leading-snug text-[#f4efe6]">
          {track.title}
        </p>
        <PoetRule>{track.artist}</PoetRule>
        <p className="mt-3 text-[10px] tracking-wide text-white/22">
          no couplet transcribed for this recording
        </p>
      </div>
    );
  }

  const poet = ghazal.poet || track.artist;

  /* ---------------- intro ---------------- */
  if (phase === "intro") {
    const first = timing?.shers[0];
    const firstSher = first ? shers[first.i] : shers[0];
    return (
      <div key={`${track.id}-intro`} className="animate-fade-swap" {...containerProps}>
        <p className="roman text-[clamp(1.05rem,2.8vw,1.6rem)] text-white/65">
          {ghazal.titleRoman || track.title}
        </p>
        <PoetRule>{poet}</PoetRule>

        {firstSher && (
          <div className="mt-7 opacity-[0.22]">
            <Couplet
              sher={firstSher}
              occurrence={first}
              activeLine={-1}
              activeWord={-1}
              script={script}
              karaoke={false}
            />
          </div>
        )}

        <p className="mt-6 flex items-center justify-center gap-2 text-[10px] tracking-[0.18em] text-white/30">
          <Equalizer tone="faint" />
          <span className="uppercase">opening instrumental</span>
          {timing ? (
            <span className="tabnum text-white/25">· {Math.max(0, Math.ceil(timing.shers[0].start - t))}s</span>
          ) : null}
        </p>
      </div>
    );
  }

  /* ---------------- outro ---------------- */
  if (phase === "outro") {
    const last = timing?.shers[timing.shers.length - 1];
    const lastSher = last ? shers[last.i] : shers[shers.length - 1];
    return (
      <div key={`${track.id}-outro`} className="animate-fade-swap" {...containerProps}>
        {lastSher && (
          <div className="opacity-40">
            <Couplet
              sher={lastSher}
              occurrence={last}
              activeLine={-1}
              activeWord={-1}
              script={script}
              karaoke={false}
            />
          </div>
        )}
        <PoetRule>{poet}</PoetRule>
        <p className="mt-4 text-[10px] uppercase tracking-[0.22em] text-white/28">the ghazal ends</p>
      </div>
    );
  }

  /* ---------------- interlude ---------------- */
  if (phase === "interlude") {
    const prevSher = occ ? shers[occ.i] : undefined;
    const nextSher = next ? shers[next.i] : undefined;
    const gapStart = occ?.end ?? t;
    const gapEnd = next?.start ?? timing?.duration ?? t;
    const span = Math.max(0.001, gapEnd - gapStart);
    const progress = Math.min(1, Math.max(0, (t - gapStart) / span));
    const nearNext = gapEnd - t < 3.5;

    return (
      <div key={`${track.id}-gap-${occIndex}`} className="animate-fade-swap" {...containerProps}>
        <div className={nearNext ? "opacity-25 transition-opacity duration-700" : "opacity-45 transition-opacity duration-700"}>
          {prevSher && (
            <Couplet
              sher={prevSher}
              occurrence={occ}
              activeLine={-1}
              activeWord={-1}
              script={script}
              karaoke={false}
            />
          )}
        </div>

        <div className="my-5 flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-white/12" />
          <Equalizer />
          <span className="text-[9.5px] uppercase tracking-[0.26em] text-white/30">
            instrumental
          </span>
          <span className="h-px w-10 bg-white/12" />
        </div>

        {nextSher && (
          <div className={nearNext ? "opacity-50 transition-opacity duration-700" : "opacity-[0.16] transition-opacity duration-700"}>
            <Couplet
              sher={nextSher}
              occurrence={next}
              activeLine={-1}
              activeWord={-1}
              script={script}
              karaoke={false}
            />
          </div>
        )}

        <div className="mx-auto mt-6 h-px w-24 overflow-hidden bg-white/10">
          <div
            className="h-full bg-white/40 transition-[width] duration-200 ease-linear"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
      </div>
    );
  }

  /* ---------------- text exists, timing does not ---------------- */
  if (!timing) {
    return (
      <div key={`${track.id}-untimed`} className="animate-fade-swap" {...containerProps}>
        <Couplet
          sher={shers[0]}
          activeLine={-1}
          activeWord={-1}
          script={script}
          karaoke={false}
        />
        <PoetRule>{poet}</PoetRule>
        <p className="mt-3 text-[9px] uppercase tracking-[0.18em] text-white/18">
          {pending ? "loading timings…" : "text only · not timed yet"}
        </p>
      </div>
    );
  }

  /* ---------------- verse ---------------- */
  const current = occ ? shers[occ.i] : undefined;

  return (
    <div
      key={`${track.id}-${occIndex}`}
      className="animate-fade-swap"
      {...containerProps}
    >
      <Couplet
        sher={current}
        occurrence={occ}
        activeLine={activeM}
        activeWord={state.word}
        script={script}
        karaoke={karaoke}
      />

      <PoetRule>{poet}</PoetRule>

      {timing && shers.length > 1 && (
        <p className="tabnum mt-2 text-[10px] tracking-[0.18em] text-white/25">
          {Math.min(shers.length, (occ?.i ?? 0) + 1)} / {shers.length}
          {occ?.pass ? <span className="ml-1 text-white/15">· repeat {occ.pass + 1}</span> : null}
        </p>
      )}

      {timing.method === "segmented" && (
        <p className="mt-2 text-[9px] uppercase tracking-[0.18em] text-amber-200/25">
          auto-timed · not yet content-verified
        </p>
      )}
      {q >= 0.75 && <span className="sr-only">lyrics verified against this recording</span>}
    </div>
  );
}
