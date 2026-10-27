"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Catalog, Mood, ScriptMode, Track, GhazalText } from "@/lib/types";
import { useTiming, useTimingIndex, type TimingState } from "@/lib/useTiming";
import { applyTimedFilter, clampIndex } from "@/lib/queue";
import type { TrackTiming } from "@/lib/timing";

const STORAGE = {
  mood: "gfz.mood",
  script: "gfz.script",
  volume: "gfz.volume",
  track: "gfz.track",
  onlyTimed: "gfz.onlyTimed",
  offset: "gfz.offset.",
};

export function usePlayer(catalog: Catalog) {
  const [moodId, setMoodIdState] = useState<string>(catalog.moods[0]?.id ?? "");
  const [trackIndex, setTrackIndex] = useState(0);
  const [script, setScript] = useState<ScriptMode>("urdu");
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.85);
  const [muted, setMuted] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [offset, setOffset] = useState(0);
  const [onlyTimed, setOnlyTimedState] = useState(false);

  /** Track id read from storage, resolved once the right playlist exists. */
  const restoreTrack = useRef<string | null>(null);

  const mood = useMemo<Mood>(
    () => catalog.moods.find((m) => m.id === moodId) ?? catalog.moods[0],
    [catalog.moods, moodId]
  );

  /** Every recording in this mood, before the timed-only filter. */
  const moodTracks = useMemo<Track[]>(() => {
    const inMood = catalog.tracks.filter((t) => t.mood === moodId);
    return inMood.length ? inMood : catalog.tracks;
  }, [catalog.tracks, moodId]);

  const timingKeys = useTimingIndex();
  const timingIndexReady = timingKeys !== null;

  const timedCount = useMemo(
    () => applyTimedFilter(moodTracks, timingKeys).length,
    [moodTracks, timingKeys]
  );

  /**
   * The one queue the transport walks. The playlist drawer, prev/next, the
   * gapless preloader and "jump to track" all read this value, so the
   * timed-only toggle changes what actually plays — not just what is listed.
   */
  const playlist = useMemo<Track[]>(
    () => (onlyTimed ? applyTimedFilter(moodTracks, timingKeys) : moodTracks),
    [moodTracks, onlyTimed, timingKeys]
  );

  const safeIndex = clampIndex(trackIndex, playlist.length);
  const track = playlist[safeIndex];

  const ghazal = useMemo<GhazalText | null>(() => {
    if (!track?.ghazalId) return null;
    return catalog.ghazals.find((g) => g.id === track.ghazalId) ?? null;
  }, [catalog.ghazals, track]);

  /**
   * Measured timing for this exact recording. Fetched per track from
   * `/timings/<tkey>.json`; null means we have nothing measured and the UI must
   * say so rather than run a fake timer.
   */
  const timingKey = track?.tkey ?? track?.id;
  const {
    timing: loadedTiming,
    state: loadedTimingState,
    loadedFor,
  } = useTiming(timingKey);
  // The effect that clears a previous track's timing runs after paint. Gate on
  // the id it was loaded for so a new poem never renders against the old
  // recording's word spans for even one frame.
  const timing = loadedTiming && loadedFor === timingKey ? loadedTiming : null;
  const timingState: TimingState = !timingKey
    ? "idle"
    : loadedFor === timingKey
    ? loadedTimingState
    : "loading";

  // restore preferences
  useEffect(() => {
    try {
      const sMood = localStorage.getItem(STORAGE.mood);
      const sScript = localStorage.getItem(STORAGE.script) as ScriptMode | null;
      const sVol = localStorage.getItem(STORAGE.volume);
      const sTrack = localStorage.getItem(STORAGE.track);
      const sTimed = localStorage.getItem(STORAGE.onlyTimed);
      if (sMood && catalog.moods.some((m) => m.id === sMood)) setMoodIdState(sMood);
      if (sScript === "urdu" || sScript === "roman" || sScript === "hindi") setScript(sScript);
      if (sVol) {
        const v = parseFloat(sVol);
        if (!Number.isNaN(v)) setVolume(Math.min(1, Math.max(0, v)));
      }
      if (sTrack) restoreTrack.current = sTrack;
      if (sTimed === "1") setOnlyTimedState(true);
    } catch {
      /* storage unavailable */
    }
    setHydrated(true);
  }, [catalog.moods]);

  // Resolve the saved recording once its playlist is available. If the queue
  // changed mood or was filtered, the saved track is simply not there and the
  // first track of the queue wins — never a stale index from another mood.
  useEffect(() => {
    if (!hydrated) return;
    const id = restoreTrack.current;
    if (!id) return;
    const idx = playlist.findIndex((t) => t.id === id);
    if (idx >= 0) setTrackIndex(idx);
    restoreTrack.current = null;
  }, [hydrated, playlist]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE.mood, moodId);
      localStorage.setItem(STORAGE.script, script);
      localStorage.setItem(STORAGE.volume, String(volume));
      localStorage.setItem(STORAGE.onlyTimed, onlyTimed ? "1" : "0");
      if (track) localStorage.setItem(STORAGE.track, track.id);
    } catch {
      /* ignore */
    }
  }, [hydrated, moodId, script, volume, onlyTimed, track]);

  // A shorter queue must not leave the transport pointing past its end.
  useEffect(() => {
    setTrackIndex((i) => clampIndex(i, playlist.length));
  }, [playlist.length]);

  // Per-recording manual calibration. This is the escape hatch when a human
  // hears a consistent lead/lag that the aligner could not model.
  useEffect(() => {
    if (!track?.id) {
      setOffset(0);
      return;
    }
    const base = timing?.offset ?? 0;
    try {
      const saved = localStorage.getItem(STORAGE.offset + track.id);
      const v = saved === null ? base : parseFloat(saved);
      setOffset(Number.isFinite(v) ? v : base);
    } catch {
      setOffset(base);
    }
  }, [track?.id, timing?.offset]);

  const nudgeOffset = useCallback(
    (delta: number) => {
      setOffset((prev) => {
        const next = Math.round(Math.min(2, Math.max(-2, prev + delta)) * 1000) / 1000;
        try {
          if (track?.id) localStorage.setItem(STORAGE.offset + track.id, String(next));
        } catch {
          /* ignore */
        }
        return next;
      });
    },
    [track?.id]
  );

  const play = useCallback(() => setIsPlaying(true), []);
  const pause = useCallback(() => setIsPlaying(false), []);
  const toggle = useCallback(() => setIsPlaying((p) => !p), []);

  const resetTransport = useCallback(() => {
    setCurrentTime(0);
    setDuration(0);
    setErrorMsg(null);
  }, []);

  const selectMood = useCallback(
    (id: string) => {
      if (id === moodId) return;
      setMoodIdState(id);
      setTrackIndex(0);
      resetTransport();
    },
    [moodId, resetTransport]
  );

  const setOnlyTimed = useCallback(
    (on: boolean) => {
      setOnlyTimedState(on);
      setTrackIndex(0);
      resetTransport();
    },
    [resetTransport]
  );

  const next = useCallback(() => {
    setTrackIndex((i) => (playlist.length ? (i + 1) % playlist.length : 0));
    resetTransport();
  }, [playlist.length, resetTransport]);

  const prev = useCallback(() => {
    setTrackIndex((i) =>
      playlist.length ? (i - 1 + playlist.length) % playlist.length : 0
    );
    resetTransport();
  }, [playlist.length, resetTransport]);

  const jumpTo = useCallback(
    (t: Track) => {
      const idx = playlist.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        setTrackIndex(idx);
        resetTransport();
        setIsPlaying(true);
      }
    },
    [playlist, resetTransport]
  );

  return {
    mood,
    moodId,
    selectMood,
    moodTracks,
    moodTotal: moodTracks.length,
    playlist,
    timedCount,
    timingKeys,
    timingIndexReady,
    onlyTimed,
    setOnlyTimed,
    track,
    trackIndex: safeIndex,
    ghazal,
    timing: timing as TrackTiming | null,
    timingState: timingState as TimingState,
    offset,
    nudgeOffset,
    script,
    setScript,
    isPlaying,
    play,
    pause,
    toggle,
    next,
    prev,
    jumpTo,
    currentTime,
    setCurrentTime,
    duration,
    setDuration,
    volume,
    setVolume,
    muted,
    setMuted,
    status,
    setStatus,
    errorMsg,
    setErrorMsg,
    hydrated,
  };
}

export function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds % 60);
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}
