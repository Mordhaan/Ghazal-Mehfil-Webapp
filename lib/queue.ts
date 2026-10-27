import type { Track } from "@/lib/types";

/** Stable key for timing files: the media hash, not the positional id. */
export function timingKey(track: Pick<Track, "id" | "tkey">): string {
  return track.tkey ?? track.id;
}

/** Whether a timing file exists for this recording (given the manifest keys). */
export function hasTiming(
  track: Pick<Track, "id" | "tkey">,
  keys: Set<string> | null | undefined
): boolean {
  return Boolean(keys?.has(timingKey(track)));
}

/**
 * The queue the transport should actually walk. `keys === null` means the
 * manifest is still loading, so the honest answer is "do not filter yet"
 * rather than an empty queue that would stop the mehfil.
 */
export function applyTimedFilter(
  tracks: Track[],
  keys: Set<string> | null | undefined
): Track[] {
  if (!keys) return tracks;
  return tracks.filter((track) => hasTiming(track, keys));
}

/** Clamp a queue position to a valid index, tolerating an empty queue. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(length - 1, Math.max(0, Math.trunc(index)));
}
