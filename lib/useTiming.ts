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
} {
  const [timing, setTiming] = useState<TrackTiming | null>(null);
  const [state, setState] = useState<TimingState>("idle");

  useEffect(() => {
    if (!trackId) {
      setTiming(null);
      setState("idle");
      return;
    }

    if (cache.has(trackId)) {
      const hit = cache.get(trackId) ?? null;
      setTiming(hit);
      setState(hit ? "ready" : "none");
      return;
    }

    let dead = false;
    // Never let the previous recording's timeline drive the new poem while the
    // next file is in flight.
    setTiming(null);
    setState("loading");

    (async () => {
      const index = await loadIndex();
      if (dead) return;
      if (!index?.tracks || !index.tracks[trackId]) {
        cache.set(trackId, null);
        setTiming(null);
        setState("none");
        return;
      }

      try {
        const res = await fetch(`/timings/${encodeURIComponent(trackId)}.json`, {
          cache: "no-cache",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const doc = normalizeTiming(await res.json(), trackId);
        cache.set(trackId, doc);
        if (dead) return;
        setTiming(doc);
        setState(doc ? "ready" : "none");
      } catch (err) {
        console.error("[timing] failed", trackId, err);
        cache.set(trackId, null);
        if (dead) return;
        setTiming(null);
        setState("none");
      }
    })();

    return () => {
      dead = true;
    };
  }, [trackId]);

  return { timing, state };
}

/** Test/debug helper: drop the in-memory cache. */
export function clearTimingCache(): void {
  cache.clear();
  indexPromise = null;
}
