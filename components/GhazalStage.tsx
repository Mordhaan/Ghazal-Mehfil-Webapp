"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePlayer, fmtTime } from "@/lib/usePlayer";
import { usePresence } from "@/lib/usePresence";
import { useGaplessAudio } from "@/lib/useGaplessAudio";
import { useMediaSession } from "@/lib/useMediaSession";
import { prefetchTiming } from "@/lib/useTiming";
import Lyrics from "@/components/Lyrics";
import MoodPicker from "@/components/MoodPicker";
import type { Catalog, ScriptMode } from "@/lib/types";

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const SCRIPTS: ScriptMode[] = ["urdu", "roman", "hindi"];

/** The keyboard legend, kept in one place so the key handler and the bar agree. */
const COMMANDS: { keys: string; action: string }[] = [
  { keys: "space", action: "play" },
  { keys: "← →", action: "seek" },
  { keys: "shift ← →", action: "track" },
  { keys: "[ ]", action: "sync" },
  { keys: "m", action: "mute" },
];

/** Thin progress strip showing real vocal spans, so you can see the interludes. */
function VocalMap({
  vocals,
  duration,
  time,
  onSeek,
}: {
  vocals: [number, number][];
  duration: number;
  time: number;
  onSeek: (t: number) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  if (!duration) return null;

  const pct = (v: number) => `${Math.min(100, Math.max(0, (v / duration) * 100))}%`;

  return (
    <div
      ref={ref}
      className="group/vm relative h-[3px] w-full cursor-pointer rounded-full bg-white/10"
      onPointerDown={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        onSeek(((e.clientX - r.left) / r.width) * duration);
      }}
      title="Bright bands are sung lines, dark bands are instrumental interludes"
    >
      {vocals.map(([s, e], i) => (
        <span
          key={`v${i}`}
          className="absolute top-0 h-full rounded-full bg-white/35"
          style={{ left: pct(s), width: pct(e - s) }}
        />
      ))}
      <span
        className="absolute -top-[3px] h-[9px] w-[2px] rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]"
        style={{ left: pct(time) }}
      />
    </div>
  );
}

export default function GhazalStage({ catalog }: { catalog: Catalog }) {
  const p = usePlayer(catalog);
  const presence = usePresence();
  const [clock, setClock] = useState("");
  const [showQueue, setShowQueue] = useState(false);
  const [showCmds, setShowCmds] = useState(false);
  const [seekDrag, setSeekDrag] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const seekRef = useRef<HTMLDivElement | null>(null);
  const queueButtonRef = useRef<HTMLButtonElement | null>(null);
  const queueCloseRef = useRef<HTMLButtonElement | null>(null);
  const queuePanelRef = useRef<HTMLElement | null>(null);
  const toastTimer = useRef<number | null>(null);

  // The global key handler is bound once. Re-binding it on every timeupdate
  // (the player re-renders ~4x/second) is how a keypress ends up handled twice.
  const pRef = useRef(p);
  pRef.current = p;
  const queueOpenRef = useRef(showQueue);
  queueOpenRef.current = showQueue;

  const showToast = useCallback((message: string, ms = 1800) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), ms);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    },
    []
  );

  /** The recording the queue will play after this one (the queue loops). */
  const nextTrack = useMemo(() => {
    if (!p.track || p.playlist.length < 2) return null;
    const i = p.playlist.findIndex((t) => t.id === p.track?.id);
    return i >= 0 ? p.playlist[(i + 1) % p.playlist.length] : null;
  }, [p.playlist, p.track]);

  // Fetch the next timeline while this one is still singing.
  useEffect(() => {
    prefetchTiming(nextTrack?.tkey ?? nextTrack?.id);
  }, [nextTrack]);

  // Two decks: one audible, one already buffering the next recording. The
  // hand-off at track end is a ref swap, not a network request, so the mehfil
  // never goes quiet between ghazals.
  const { audioRef, slotRefs } = useGaplessAudio({
    src: p.track?.url ?? null,
    nextSrc: nextTrack?.url ?? null,
    playing: p.isPlaying,
    volume: p.volume,
    muted: p.muted,
    onTime: (t) => {
      if (!seekDrag) p.setCurrentTime(t);
    },
    onDuration: p.setDuration,
    onStatus: p.setStatus,
    onEnded: p.next,
    onError: () => {
      p.setErrorMsg("Stream unavailable — skipping");
      showToast("That recording would not load. Finding another…", 2800);
      window.setTimeout(() => p.next(), 1200);
    },
    onBlocked: () => {
      showToast("Tap play to start the mehfil", 3000);
    },
  });

  useEffect(() => {
    const tick = () => {
      const d = new Date();
      let h = d.getHours();
      const suffix = h >= 12 ? "PM" : "AM";
      h = h % 12 || 12;
      setClock(`${pad(h)}:${pad(d.getMinutes())} ${suffix}`);
    };
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);

  const timezone = useMemo(() => {
    try {
      return (
        Intl.DateTimeFormat().resolvedOptions().timeZone?.split("/").pop()?.replace(/_/g, " ") ??
        "LOCAL"
      );
    } catch {
      return "LOCAL";
    }
  }, []);

  const mediaDuration = p.duration;
  const setAudioTime = p.setCurrentTime;
  const seekTo = useCallback(
    (t: number) => {
      const el = audioRef.current;
      if (!el) return;
      const total = mediaDuration || el.duration || 0;
      const clamped = total ? Math.min(total, Math.max(0, t)) : Math.max(0, t);
      el.currentTime = clamped;
      setAudioTime(clamped);
    },
    [audioRef, mediaDuration, setAudioTime]
  );

  useMediaSession({
    title: p.track?.title ?? "",
    artist: p.track?.artist ?? "",
    album: p.mood?.name,
    playing: p.isPlaying,
    duration: p.duration || p.track?.duration || 0,
    position: p.currentTime,
    onPlay: p.play,
    onPause: p.pause,
    onNext: p.next,
    onPrev: p.prev,
    onSeek: seekTo,
  });

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const bar = seekRef.current;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const total = mediaDuration || 0;
      seekTo(((clientX - rect.left) / rect.width) * total);
    },
    [mediaDuration, seekTo]
  );

  useEffect(() => {
    if (!seekDrag) return;
    const move = (e: PointerEvent) => seekFromClientX(e.clientX);
    const up = () => setSeekDrag(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [seekDrag, seekFromClientX]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)) return;
      if (queueOpenRef.current) return; // the dialog owns keys while it is open

      const player = pRef.current;
      if (!player.track) return;

      if (e.code === "Space") {
        e.preventDefault();
        player.toggle();
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        if (e.shiftKey) player.next();
        else if (audioRef.current) audioRef.current.currentTime += 10;
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        if (e.shiftKey) player.prev();
        else if (audioRef.current) audioRef.current.currentTime -= 10;
      } else if (e.key.toLowerCase() === "m") {
        player.setMuted((m) => !m);
      } else if (e.key === "[" || e.key === "]") {
        // Human calibration: shift the lyric clock by 50 ms per press.
        // Persisted per recording, so a fixed offset only has to be found once.
        e.preventDefault();
        const step = e.key === "]" ? 0.05 : -0.05;
        player.nudgeOffset(step);
        const ms = Math.round((player.offset + step) * 1000);
        showToast(`sync ${ms >= 0 ? "+" : ""}${ms} ms`, 1200);
      } else if (e.key === "\\") {
        e.preventDefault();
        player.nudgeOffset(-player.offset);
        showToast("sync reset", 1200);
      } else if (e.key === "Escape") {
        setShowCmds(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [audioRef, showToast]);

  // While the playlist drawer is open it behaves like a dialog: initial focus,
  // Escape to close, Tab kept inside, and focus returned to the trigger.
  useEffect(() => {
    if (!showQueue) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    queueCloseRef.current?.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setShowQueue(false);
        return;
      }
      if (e.key !== "Tab") return;
      const panel = queuePanelRef.current;
      if (!panel) return;
      const nodes = panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus({ preventScroll: true });
    };
  }, [showQueue]);

  const timing = p.timing;
  const progress = p.duration > 0 ? (p.currentTime / p.duration) * 100 : 0;

  const moodStyle = {
    "--bg-a": p.mood?.bg_gradient?.match(/#[0-9a-f]{6}/i)?.[0] ?? "#090e1a",
    "--bg-b": "#03040a",
    "--accent": p.mood?.color ?? "#cbb894",
  } as React.CSSProperties;

  const centre = p.track ? (
    <Lyrics
      audioRef={audioRef}
      timing={p.timing}
      timingState={p.timingState}
      ghazal={p.ghazal}
      track={p.track}
      script={p.script}
      offset={p.offset}
    />
  ) : (
    <div className="animate-fade-swap px-6 text-center">
      <p className="roman text-[clamp(1.2rem,3.6vw,2rem)] text-white/85">
        Nothing timed here yet
      </p>
      <p className="mx-auto mt-3 max-w-sm text-[12.5px] leading-relaxed text-white/40">
        {p.onlyTimed
          ? `None of the ${p.moodTotal} recordings in ${p.mood?.name ?? "this mood"} has a measured timing.`
          : "There are no recordings in this mood."}
      </p>
      {p.onlyTimed && (
        <button
          type="button"
          onClick={() => p.setOnlyTimed(false)}
          className="mt-6 rounded-full border border-white/18 px-4 py-2 text-[12px] text-white/75 transition-colors hover:bg-white/10"
        >
          Show all recordings
        </button>
      )}
    </div>
  );

  return (
    <div
      className="stage"
      style={moodStyle}
      data-ts={p.timingState}
      data-tn={p.timing?.shers.length ?? -1}
    >
      <div className="vignette" />
      <div className="grain" />

      <h1 className="sr-only">Ghazal — a mehfil for the quiet hours</h1>

      {slotRefs.map((ref, i) => (
        <audio key={i} ref={ref} preload="auto" />
      ))}

      <p className="sr-only" aria-live="polite">
        {p.track ? `Now playing ${p.track.title} by ${p.track.artist}` : ""}
      </p>

      <div className="relative z-10 flex h-[100dvh] w-full flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 px-4 pt-4 sm:px-7 sm:pt-6">
          <div className="glass-soft hidden items-center gap-2 rounded-full px-3.5 py-1.5 sm:flex">
            <span className="text-[10px] uppercase tracking-[0.22em] text-white/45">{timezone}</span>
            <span className="h-1 w-1 rounded-full bg-white/25" />
            <span className="tabnum text-[12px] font-medium text-white/80">{clock || "--:--"}</span>
          </div>

          <div
            className="glass flex items-center gap-2 rounded-full px-3 py-1.5"
            role="status"
            aria-label={
              presence.state === "live"
                ? `${presence.count} listeners in the mehfil`
                : "Reconnecting to the mehfil"
            }
            title={
              presence.state === "live"
                ? "Live listeners connected right now"
                : "Reconnecting to the mehfil"
            }
          >
            <span className="relative flex h-1.5 w-1.5">
              <span
                className={`absolute inline-flex h-full w-full rounded-full ${
                  presence.state === "live" ? "animate-ping bg-emerald-400" : "bg-amber-400"
                } opacity-75`}
              />
              <span
                className={`relative inline-flex h-1.5 w-1.5 rounded-full ${
                  presence.state === "live" ? "bg-emerald-400" : "bg-amber-400"
                }`}
              />
            </span>
            <span className="tabnum text-[11.5px] font-medium text-white/85 max-[380px]:hidden">
              {presence.state === "live"
                ? `${presence.count} in the mehfil`
                : presence.state === "connecting"
                ? "joining…"
                : "reconnecting…"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="glass-soft hidden items-center gap-0.5 rounded-full p-0.5 sm:flex">
              {SCRIPTS.map((s) => (
                <button
                  key={s}
                  onClick={() => p.setScript(s)}
                  className={`rounded-full px-2.5 py-1 text-[10.5px] font-medium capitalize transition-colors ${
                    p.script === s ? "bg-white/85 text-black" : "text-white/55 hover:text-white/85"
                  }`}
                  aria-pressed={p.script === s}
                >
                  {s}
                </button>
              ))}
            </div>

            <button
              ref={queueButtonRef}
              onClick={() => setShowQueue((v) => !v)}
              aria-label="Show playlist"
              aria-expanded={showQueue}
              aria-controls="playlist-dialog"
              className="glass btn-round h-9 w-9 text-white/75 hover:text-white"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
              </svg>
            </button>

            <MoodPicker moods={catalog.moods} activeId={p.moodId} onSelect={p.selectMood} />
          </div>
        </header>

        <main className="flex min-h-0 flex-1 items-center justify-center px-5 sm:px-8">
          <div className="w-full max-w-3xl text-center">{centre}</div>
        </main>

        <footer className="safe-bottom shrink-0 px-3 pb-4 sm:px-6 sm:pb-6">
          <div className="mx-auto w-full max-w-3xl">
            <div className="glass flex flex-col gap-3 rounded-[28px] p-3 lg:flex-row lg:items-center lg:gap-4 lg:rounded-full lg:py-2.5 lg:pl-2.5 lg:pr-6">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <div className="vinyl h-[52px] w-[52px] shrink-0 sm:h-[58px] sm:w-[58px]">
                  <div
                    className={`vinyl-label h-[22px] w-[22px] text-[9px] font-bold ${
                      p.isPlaying ? "spinning" : "spinning paused"
                    }`}
                  >
                    {initials(p.track?.artist ?? "")}
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13.5px] font-semibold leading-tight text-white/95">
                    {p.track?.title ?? "—"}
                  </p>
                  <p className="mt-0.5 truncate text-[11.5px] text-white/50">
                    {p.track?.artist}
                    {p.mood ? ` · ${p.mood.name}` : ""}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-center gap-1.5 lg:order-3">
                <button onClick={p.prev} aria-label="Previous" className="btn-round h-9 w-9 text-white/65 hover:bg-white/10 hover:text-white">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
                </button>
                <button
                  onClick={p.toggle}
                  aria-label={p.isPlaying ? "Pause" : "Play"}
                  className="btn-round h-11 w-11 bg-white text-black shadow-lg hover:bg-white/90"
                >
                  {p.isPlaying ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" /></svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5l12 7-12 7z" /></svg>
                  )}
                </button>
                <button onClick={p.next} aria-label="Next" className="btn-round h-9 w-9 text-white/65 hover:bg-white/10 hover:text-white">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 6l8.5 6L6 18z" /></svg>
                </button>
                <button
                  onClick={() => p.setMuted((m) => !m)}
                  aria-label={p.muted ? "Unmute" : "Mute"}
                  aria-pressed={p.muted}
                  className="btn-round ml-1 grid h-9 w-9 text-white/55 hover:bg-white/10 hover:text-white"
                >
                  {p.muted ? (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M11 5L6 9H3v6h3l5 4z" strokeLinejoin="round" /><path d="M17 9l4 6M21 9l-4 6" strokeLinecap="round" />
                    </svg>
                  ) : (
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                      <path d="M11 5L6 9H3v6h3l5 4z" strokeLinejoin="round" />
                      <path d="M16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12" strokeLinecap="round" />
                    </svg>
                  )}
                </button>
              </div>

              <div className="flex flex-col gap-1 lg:order-2 lg:w-[240px] lg:shrink-0">
                <div className="flex items-center gap-2.5">
                  <span className="tabnum w-[34px] shrink-0 text-right text-[10.5px] text-white/45">
                    {fmtTime(p.currentTime)}
                  </span>
                  <div
                    ref={seekRef}
                    className="seek flex-1"
                    data-active={seekDrag}
                    role="slider"
                    tabIndex={0}
                    aria-label="Seek"
                    aria-valuemin={0}
                    aria-valuemax={Math.round(p.duration)}
                    aria-valuenow={Math.round(p.currentTime)}
                    aria-valuetext={fmtTime(p.currentTime)}
                    onPointerDown={(e) => {
                      setSeekDrag(true);
                      seekFromClientX(e.clientX);
                    }}
                    onKeyDown={(e) => {
                      if (!audioRef.current) return;
                      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                        e.preventDefault();
                        const step = e.key === "ArrowRight" ? 5 : -5;
                        seekTo((audioRef.current.currentTime || 0) + step);
                      }
                    }}
                  >
                    <div className="seek-track w-full">
                      <div className="seek-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
                    </div>
                    <div className="seek-thumb" style={{ left: `${Math.min(100, Math.max(0, progress))}%` }} />
                  </div>
                  <span className="tabnum w-[34px] shrink-0 text-[10.5px] text-white/45">
                    {p.duration ? fmtTime(p.duration) : "0:00"}
                  </span>
                </div>

                {timing && (timing.phrases?.length || timing.vocals?.length) ? (
                  <VocalMap
                    vocals={timing.phrases?.length ? timing.phrases : timing.vocals ?? []}
                    duration={p.duration || timing.duration}
                    time={p.currentTime}
                    onSeek={seekTo}
                  />
                ) : null}
              </div>
            </div>

            <div className="mt-2 flex flex-col items-center">
              <div
                id="cmd-legend"
                className="cmd-drawer w-full"
                data-open={showCmds}
                aria-hidden={!showCmds}
              >
                <div className="cmd-drawer-inner">
                  <div className="cmd-legend glass-soft">
                    {COMMANDS.map((c, i) => (
                      <Fragment key={c.keys}>
                        {i > 0 && (
                          <span className="cmd-dot" aria-hidden>
                            ·
                          </span>
                        )}
                        <span className="cmd-hint">
                          <span className="cmd-key">{c.keys}</span>
                          <span>{c.action}</span>
                        </span>
                      </Fragment>
                    ))}
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => setShowCmds((v) => !v)}
                aria-expanded={showCmds}
                aria-controls="cmd-legend"
                data-open={showCmds}
                title={showCmds ? "Hide keyboard shortcuts" : "Show keyboard shortcuts"}
                className="cmd-bar"
              >
                <span className="cmd-bar-grip" aria-hidden />
                <span className="sr-only">
                  {showCmds ? "Hide keyboard shortcuts" : "Show keyboard shortcuts"}
                </span>
              </button>
            </div>
          </div>
        </footer>
      </div>

      {showQueue && (
        <div className="fixed inset-0 z-40 flex justify-end">
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={() => setShowQueue(false)} />
          <aside
            ref={queuePanelRef}
            id="playlist-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="queue-title"
            className="glass relative flex h-full w-[86vw] max-w-[380px] animate-fade-swap flex-col rounded-l-3xl p-4"
          >
            <div className="mb-3 flex items-start justify-between">
              <div>
                <p id="queue-title" className="text-[13px] font-semibold text-white/90">
                  {p.mood?.name}
                </p>
                <p className="mt-0.5 text-[10.5px] text-white/40">
                  {p.playlist.length} of {p.moodTotal} recordings
                  {p.onlyTimed ? " · timed" : ""}
                </p>
                <button
                  onClick={() => p.setOnlyTimed(!p.onlyTimed)}
                  aria-pressed={p.onlyTimed}
                  disabled={!p.timingIndexReady || (p.timedCount === 0 && !p.onlyTimed)}
                  className={`mt-1.5 rounded-full border px-2 py-0.5 text-[9px] uppercase tracking-[0.14em] transition-colors disabled:opacity-45 ${
                    p.onlyTimed
                      ? "border-[#cbb894]/45 text-[#cbb894]"
                      : "border-white/12 text-white/35 hover:text-white/60"
                  }`}
                >
                  {!p.timingIndexReady
                    ? "checking timings…"
                    : p.timedCount === 0
                    ? "no timed recordings"
                    : p.onlyTimed
                    ? `showing ${p.timedCount} timed`
                    : `timed only · ${p.timedCount}`}
                </button>
              </div>
              <button
                ref={queueCloseRef}
                onClick={() => setShowQueue(false)}
                aria-label="Close playlist"
                className="btn-round h-8 w-8 text-white/50 hover:bg-white/10 hover:text-white"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" /></svg>
              </button>
            </div>

            <div className="mb-3 flex items-center gap-0.5 rounded-full border border-white/10 p-0.5 sm:hidden">
              {SCRIPTS.map((s) => (
                <button
                  key={s}
                  onClick={() => p.setScript(s)}
                  aria-pressed={p.script === s}
                  className={`flex-1 rounded-full px-2.5 py-1 text-[10.5px] font-medium capitalize transition-colors ${
                    p.script === s ? "bg-white/85 text-black" : "text-white/55 hover:text-white/85"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <ul className="thin-scroll -mx-1 flex-1 overflow-y-auto px-1">
              {p.playlist.length === 0 && (
                <li className="px-2 py-6 text-[11px] leading-relaxed text-white/30">
                  No timed recordings in this mood yet. Turn the filter off, or open
                  /sync to time one.
                </li>
              )}
              {p.playlist.map((t, i) => {
                const active = t.id === p.track?.id;
                const hasTiming = p.timingKeys?.has(t.tkey ?? t.id) ?? false;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => {
                        p.jumpTo(t);
                        setShowQueue(false);
                      }}
                      className={`flex w-full items-center gap-2.5 rounded-xl px-2 py-2 text-left transition-colors hover:bg-white/10 ${
                        active ? "bg-white/[0.09]" : ""
                      }`}
                    >
                      <span className={`tabnum w-5 shrink-0 text-[10px] ${active ? "text-white/85" : "text-white/30"}`}>
                        {active && p.isPlaying ? "♪" : i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={`flex items-center gap-1.5 text-[12px] ${active ? "font-medium text-white/95" : "text-white/72"}`}>
                          {hasTiming && (
                            <span
                              className="h-1 w-1 shrink-0 rounded-full bg-[#cbb894]/80"
                              title="measured lyric timing"
                            />
                          )}
                          <span className="truncate">{t.title}</span>
                        </span>
                        <span className="block truncate text-[10px] text-white/35">{t.artist}</span>
                      </span>
                      <span className="tabnum shrink-0 text-[10px] text-white/28">
                        {t.duration ? fmtTime(t.duration) : "—"}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      )}

      {toast && (
        <div
          role="status"
          aria-live="polite"
          className="pointer-events-none fixed bottom-28 left-1/2 z-50 -translate-x-1/2 rounded-full bg-black/70 px-3.5 py-1.5 text-[11px] text-white/85 backdrop-blur-md"
        >
          {toast}
        </div>
      )}
    </div>
  );
}
