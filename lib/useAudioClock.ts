"use client";

import { useEffect, useState } from "react";

/**
 * Returns the audio element's clock at animation-frame resolution.
 *
 * `timeupdate` fires ~4x/second, which is fine for a progress bar and useless
 * for a word-by-word lyric highlight (up to 250 ms of visible lag). Reading
 * `currentTime` inside rAF keeps the text locked to the media clock; the media
 * element remains the single source of truth, so pause/seek/buffer all stay
 * correct without extra bookkeeping.
 *
 * The ref is read on every frame instead of once on mount: playback hands off
 * between two decks at track boundaries, and the hook has to follow the deck
 * that is audible now rather than the one that existed when it mounted.
 */
export function useAudioClock(
  audioRef: { current: HTMLAudioElement | null },
  active = true
): number {
  const [time, setTime] = useState(0);

  useEffect(() => {
    let raf = 0;
    let last = -1;
    let bound: HTMLAudioElement | null = null;

    const onSeek = () => {
      if (bound) setTime(bound.currentTime);
    };

    const tick = () => {
      const el = audioRef.current;
      if (el && el !== bound) {
        bound?.removeEventListener("seeked", onSeek);
        bound?.removeEventListener("loadedmetadata", onSeek);
        el.addEventListener("seeked", onSeek);
        el.addEventListener("loadedmetadata", onSeek);
        bound = el;
        last = -1;
      }
      if (el) {
        const v = el.currentTime;
        if (Math.abs(v - last) > 0.008) {
          last = v;
          setTime(v);
        }
      }
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      bound?.removeEventListener("seeked", onSeek);
      bound?.removeEventListener("loadedmetadata", onSeek);
    };
  }, [audioRef, active]);

  return time;
}
