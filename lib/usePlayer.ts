"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { Catalog, Mood, ScriptMode, Track, GhazalText } from "@/lib/types";
import { useTiming, type TimingState } from "@/lib/useTiming";
import type { TrackTiming } from "@/lib/timing";

const STORAGE = {
  mood: "gfz.mood",
  script: "gfz.script",
  volume: "gfz.volume",
  track: "gfz.track",
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

  const mood = useMemo<Mood>(
    () => catalog.moods.find((m) => m.id === moodId) ?? catalog.moods[0],
    [catalog.moods, moodId]
  );

  const playlist = useMemo<Track[]>(() => {
    const inMood = catalog.tracks.filter((t) => t.mood === moodId);
    return inMood.length ? inMood : catalog.tracks;
  }, [catalog.tracks, moodId]);

  const track = playlist[Math.min(trackIndex, Math.max(0, playlist.length - 1))];

  const ghazal = useMemo<GhazalText | null>(() => {
    if (!track?.ghazalId) return null;
    return catalog.ghazals.find((g) => g.id === track.ghazalId) ?? null;
  }, [catalog.ghazals, track]);

  /**
   * Measured timing for this exact recording. Fetched per track from
   * `/timings/<id>.json`; null means we have nothing measured and the UI must
   * say so rather than run a fake timer.
   */
  const { timing, state: timingState } = useTiming(track?.tkey ?? track?.id);

  // restore preferences
  useEffect(() => {
    try {
      const sMood = localStorage.getItem(STORAGE.mood);
      const sScript = localStorage.getItem(STORAGE.script) as ScriptMode | null;
      const sVol = localStorage.getItem(STORAGE.volume);
      if (sMood && catalog.moods.some((m) => m.id === sMood)) setMoodIdState(sMood);
      if (sScript === "urdu" || sScript === "roman" || sScript === "hindi") setScript(sScript);
      if (sVol) {
        const v = parseFloat(sVol);
        if (!Number.isNaN(v)) setVolume(Math.min(1, Math.max(0, v)));
      }
    } catch {
      /* storage unavailable */
    }
    setHydrated(true);
  }, [catalog.moods]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(STORAGE.mood, moodId);
      localStorage.setItem(STORAGE.script, script);
      localStorage.setItem(STORAGE.volume, String(volume));
      if (track) localStorage.setItem(STORAGE.track, track.id);
    } catch {
      /* ignore */
    }
  }, [hydrated, moodId, script, volume, track]);

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

  const selectMood = useCallback(
    (id: string) => {
      if (id === moodId) return;
      setMoodIdState(id);
      setTrackIndex(0);
      setCurrentTime(0);
      setDuration(0);
      setErrorMsg(null);
    },
    [moodId]
  );

  const next = useCallback(() => {
    setTrackIndex((i) => (playlist.length ? (i + 1) % playlist.length : 0));
    setCurrentTime(0);
    setDuration(0);
    setErrorMsg(null);
  }, [playlist.length]);

  const prev = useCallback(() => {
    setTrackIndex((i) => (playlist.length ? (i - 1 + playlist.length) % playlist.length : 0));
    setCurrentTime(0);
    setDuration(0);
    setErrorMsg(null);
  }, [playlist.length]);

  const jumpTo = useCallback(
    (t: Track) => {
      const idx = playlist.findIndex((x) => x.id === t.id);
      if (idx >= 0) {
        setTrackIndex(idx);
        setCurrentTime(0);
        setDuration(0);
        setErrorMsg(null);
        setIsPlaying(true);
      }
    },
    [playlist]
  );

  return {
    mood,
    moodId,
    selectMood,
    playlist,
    track,
    trackIndex,
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
