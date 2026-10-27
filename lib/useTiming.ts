"use client";

import { useEffect, useState } from "react";
import { normalizeTiming, type TimingIndex, type TrackTiming } from "@/lib/timing";

/**
 * Timing files are served one per recording, not bundled into the catalogue.
 * 1,500 word-level timelines in one JSON would be tens of megabytes on first
 * paint; this way a listener downloads exactly the track they are hearing.
 */

let indexPromise: Promise<TimingIndex | null> | null = null;

function loadIndex(): Promise<TimingIndex | null> {
  if (!indexPromise) {
    indexPromise = fetch("/timings/index.json", { cache: "no-cache" })
      .then((r) => (r.ok ? (r.json() as Promise<TimingIndex>) : null))
      .catch(() => null)
      .then((v) => {
        if (!v) indexPromise = null; // allow a retry after a dev-server restart
        return v;
      });
  }
  return indexPromise;
}

const cache = new Map<string, TrackTiming | null>();
const inflight = new Map<string, Promise<TrackTiming | null>>();

async function fetchTiming(trackId: string): Promise<TrackTiming | null> {
  if (cache.has(trackId)) return cache.get(trackId) ?? null;

  const index = await loadIndex();
  // A failed manifest fetch is transient; do not negative-cache the track or a
  // single bad network moment would hide its lyrics for the whole session.
  if (!index) return null;
  if (!index.tracks || !index.tracks[trackId]) {
    cache.set(trackId, null);
    return null;
  }

  try {
    // The route sends a long-lived cache header for these immutable-ish files,
    // so the browser can answer a repeat visit without a round trip.
    const res = await fetch(`/timings/${encodeURIComponent(trackId)}.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = normalizeTiming(await res.json(), trackId);
    cache.set(trackId, doc);
    return doc;
  } catch (err) {
    console.error("[timing] failed", trackId, err);
    cache.set(trackId, null);
    return null;
  }
}

function getTiming(trackId: string): Promise<TrackTiming | null> {
  if (cache.has(trackId)) return Promise.resolve(cache.get(trackId) ?? null);
  const existing = inflight.get(trackId);
  if (existing) return existing;
  const request = fetchTiming(trackId).finally(() => inflight.delete(trackId));
  inflight.set(trackId, request);
  return request;
}

/**
 * Warm the next recording's timeline while the current one plays. Gapless
 * audio already fetches the next MP3; this removes the second wait that used
 * to show `loading timings…` on every track change.
 */
export function prefetchTiming(trackId: string | undefined): void {
  if (!trackId || cache.has(trackId)) return;
  void getTiming(trackId);
}

export type TimingState = "idle" | "loading" | "ready" | "none";

/** Keys of every recording that has a published timing file. */
export function useTimingIndex(): Set<string> | null {
  const [keys, setKeys] = useState<Set<string> | null>(null);
  useEffect(() => {
    let dead = false;
    loadIndex().then((idx) => {
      if (dead) return;
      setKeys(new Set(Object.keys(idx?.tracks ?? {})));
    });
    return () => {
      dead = true;
    };
  }, []);
  return keys;
}

export function useTiming(trackId: string | undefined): {
  timing: TrackTiming | null;
  state: TimingState;
  /** The id the current timing/state belongs to; guards against a stale frame. */
  loadedFor: string | null;
} {
  const [timing, setTiming] = useState<TrackTiming | null>(null);
  const [state, setState] = useState<TimingState>("idle");
  const [loadedFor, setLoadedFor] = useState<string | null>(null);

  useEffect(() => {
    if (!trackId) {
      setTiming(null);
      setState("idle");
      setLoadedFor(null);
      return;
    }

    if (cache.has(trackId)) {
      const hit = cache.get(trackId) ?? null;
      setTiming(hit);
      setState(hit ? "ready" : "none");
      setLoadedFor(trackId);
      return;
    }

    let dead = false;
    // Never let the previous recording's timeline drive the new poem while the
    // next file is in flight.
    setTiming(null);
    setState("loading");
    setLoadedFor(null);

    void getTiming(trackId).then((doc) => {
      if (dead) return;
      setTiming(doc);
      setState(doc ? "ready" : "none");
      setLoadedFor(trackId);
    });

    return () => {
      dead = true;
    };
  }, [trackId]);

  return { timing, state, loadedFor };
}

/** Test/debug helper: drop the in-memory cache. */
export function clearTimingCache(): void {
  cache.clear();
  inflight.clear();
  indexPromise = null;
}
