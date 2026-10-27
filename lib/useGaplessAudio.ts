"use client";

import { useCallback, useEffect, useRef } from "react";

export type AudioStatus = "idle" | "loading" | "ready" | "error";

type Options = {
  /** URL of the recording that should be audible now (null = nothing loaded). */
  src: string | null;
  /** URL the queue will play next. Kept warm on the idle deck. */
  nextSrc: string | null;
  playing: boolean;
  volume: number;
  muted: boolean;
  onTime?: (t: number) => void;
  onDuration?: (d: number) => void;
  onStatus?: (s: AudioStatus) => void;
  onEnded?: () => void;
  onError?: () => void;
  /** Autoplay was refused (usually a missing user gesture). */
  onBlocked?: () => void;
};

/** readyState that means the browser can start output without an immediate stall. */
const CAN_START = 2;
/** How long the idle deck is nudged with muted playback to make it buffer. */
const KICK_MS = 4000;
/** Let the track that just started get its own buffer before we compete. */
const KICK_DELAY_MS = 2500;

/**
 * Two audio elements, one audible and one holding the next track.
 *
 * The single-element player could only start fetching a track after `ended`
 * fired, so every transition paid a full round trip to archive.org and the
 * mehfil went silent. Here the idle deck is filled with the queue's next
 * recording while the current one plays; when the track ends the already
 * buffered element is promoted, so the next song starts on the same tick.
 *
 * A paused element is not a priority for the network: measured in Chrome, the
 * idle deck sat at readyState 0 for a whole track with `preload="auto"`, and
 * the next song still had to be fetched from scratch. Playing it muted for a
 * few seconds changes that — the browser treats it as active, buffers ahead,
 * and keeps filling after the pause. After the kick the deck holds minutes of
 * audio and is inaudible the whole time.
 *
 * The elements stay in the React tree (see `slotRefs`) so their buffering is
 * inspectable in DevTools and `preload` still applies between kicks.
 */
export function useGaplessAudio(opts: Options) {
  const slotA = useRef<HTMLAudioElement | null>(null);
  const slotB = useRef<HTMLAudioElement | null>(null);
  /** Always points at the deck that is currently allowed to make sound. */
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const latest = useRef(opts);
  const slots = useRef<[HTMLAudioElement | null, HTMLAudioElement | null]>([null, null]);
  /** What each deck was last asked to load, so we never reload the same URL. */
  const primed = useRef<[string | null, string | null]>([null, null]);
  /** The URL the audible deck is playing. */
  const current = useRef<string | null>(null);
  const active = useRef<0 | 1>(0);
  /** No speculative buffering before the first real play. */
  const armed = useRef(false);
  /** Deck currently being nudged, plus its timers. */
  const kickDeck = useRef<HTMLAudioElement | null>(null);
  const kickDelay = useRef<number | null>(null);
  const kickStop = useRef<number | null>(null);
  /** One transparent retry per URL before we give up and skip the track. */
  const retriedFor = useRef<string | null>(null);
  const retryTimer = useRef<number | null>(null);

  const clearKickTimers = useCallback(() => {
    if (kickDelay.current !== null) {
      clearTimeout(kickDelay.current);
      kickDelay.current = null;
    }
    if (kickStop.current !== null) {
      clearTimeout(kickStop.current);
      kickStop.current = null;
    }
  }, []);

  const clearRetryTimer = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
  }, []);

  /** End the nudge and put the deck back at the start, at the user's volume. */
  const settle = useCallback((el: HTMLAudioElement) => {
    if (kickDeck.current !== el) return;
    clearKickTimers();
    kickDeck.current = null;
    el.pause();
    el.currentTime = 0;
    el.muted = latest.current.muted;
    el.volume = latest.current.muted ? 0 : latest.current.volume;
  }, [clearKickTimers]);

  // Keep the newest callbacks visible to the native listeners without
  // re-binding them (re-binding mid-playback is how audio stutters).
  useEffect(() => {
    latest.current = opts;
  });

  useEffect(() => {
    const a = slotA.current;
    const b = slotB.current;
    if (!a || !b) return;
    const els: [HTMLAudioElement, HTMLAudioElement] = [a, b];
    slots.current = els;

    const cleanups: Array<() => void> = [];

    els.forEach((el) => {
      const isActive = () => audioRef.current === el;

      const onTime = () => {
        if (isActive()) latest.current.onTime?.(el.currentTime);
      };
      const onMeta = () => {
        if (!isActive()) return;
        if (Number.isFinite(el.duration) && el.duration > 0) {
          latest.current.onDuration?.(el.duration);
        }
      };
      const onPlaying = () => {
        if (!isActive()) return;
        armed.current = true;
        latest.current.onStatus?.("ready");
      };
      const onWaiting = () => {
        if (isActive()) latest.current.onStatus?.("loading");
      };
      const onCanPlay = () => {
        if (isActive()) latest.current.onStatus?.("ready");
      };
      const onEnded = () => {
        if (!isActive()) return;
        const { src, nextSrc } = latest.current;
        // A one-track queue has nowhere to advance to; loop it here instead of
        // leaving the deck parked at its end.
        if (src && (!nextSrc || nextSrc === src) && el.ended) {
          el.currentTime = 0;
          void el.play().catch(() => latest.current.onBlocked?.());
          latest.current.onTime?.(0);
          return;
        }
        latest.current.onEnded?.();
      };
      const onError = () => {
        if (!isActive()) return;
        // A single 5xx from archive.org is a transient, not a dead recording.
        // Reload once before telling the queue to skip; the retry is invisible
        // unless it also fails.
        const src = latest.current.src ?? "";
        if (src && retriedFor.current !== src) {
          retriedFor.current = src;
          latest.current.onStatus?.("loading");
          clearRetryTimer();
          retryTimer.current = window.setTimeout(() => {
            if (!isActive() || latest.current.src !== src) return;
            el.load();
            if (latest.current.playing) {
              const pr = el.play();
              if (pr && typeof pr.catch === "function") {
                pr.catch(() => latest.current.onBlocked?.());
              }
            }
          }, 700);
          return;
        }
        latest.current.onStatus?.("error");
        latest.current.onError?.();
      };

      el.addEventListener("timeupdate", onTime);
      el.addEventListener("durationchange", onMeta);
      el.addEventListener("loadedmetadata", onMeta);
      el.addEventListener("playing", onPlaying);
      el.addEventListener("waiting", onWaiting);
      el.addEventListener("canplay", onCanPlay);
      el.addEventListener("ended", onEnded);
      el.addEventListener("error", onError);

      cleanups.push(() => {
        el.removeEventListener("timeupdate", onTime);
        el.removeEventListener("durationchange", onMeta);
        el.removeEventListener("loadedmetadata", onMeta);
        el.removeEventListener("playing", onPlaying);
        el.removeEventListener("waiting", onWaiting);
        el.removeEventListener("canplay", onCanPlay);
        el.removeEventListener("ended", onEnded);
        el.removeEventListener("error", onError);
      });
    });

    return () => {
      cleanups.forEach((fn) => fn());
      clearKickTimers();
      clearRetryTimer();
      kickDeck.current = null;
      els.forEach((el) => {
        el.pause();
        el.removeAttribute("src");
        el.load();
      });
      slots.current = [null, null];
      audioRef.current = null;
      current.current = null;
      primed.current = [null, null];
      armed.current = false;
    };
  }, [clearKickTimers, clearRetryTimer]);

  // Promote a deck for the requested track: reuse the one that already holds
  // this URL, otherwise load it into the idle deck.
  useEffect(() => {
    const els = slots.current;
    const [a, b] = els;
    if (!a || !b) return;

    const src = opts.src;
    if (!src) {
      clearKickTimers();
      if (kickDeck.current) {
        const warmed = kickDeck.current;
        kickDeck.current = null;
        warmed.pause();
        warmed.currentTime = 0;
      }
      a.pause();
      b.pause();
      audioRef.current = null;
      current.current = null;
      return;
    }
    if (current.current === src && audioRef.current) return;

    let target: 0 | 1 = 0;
    let found = false;
    for (const i of [0, 1] as const) {
      const el = els[i]!;
      if (el === audioRef.current) continue;
      if (primed.current[i] === src && el.readyState >= CAN_START) {
        target = i;
        found = true;
        break;
      }
    }

    if (!found) {
      const previous = audioRef.current;
      const idleIndex: 0 | 1 = previous ? (active.current === 0 ? 1 : 0) : active.current;
      const el = els[idleIndex]!;
      // Hard cut on manual skips; the old track must not keep singing under
      // the new one while the new one buffers.
      if (previous) previous.pause();
      if (kickDeck.current === el) settle(el);
      el.preload = "auto";
      el.src = src;
      el.load();
      primed.current[idleIndex] = src;
      target = idleIndex;
      latest.current.onStatus?.("loading");
    }

    const el = els[target]!;
    const previous = audioRef.current;
    if (previous && previous !== el) previous.pause();
    // The next track may still be in its muted warm-up; bring it back to 0:00
    // and to the user's volume before it becomes audible.
    if (kickDeck.current === el) settle(el);

    active.current = target;
    audioRef.current = el;
    current.current = src;
    retriedFor.current = null;
    el.volume = latest.current.muted ? 0 : latest.current.volume;
    el.muted = latest.current.muted;

    // The preloaded deck already knows its duration; report it so the UI shows
    // the length immediately instead of 0:00 for a moment.
    if (Number.isFinite(el.duration) && el.duration > 0) {
      latest.current.onDuration?.(el.duration);
    }

    if (latest.current.playing) {
      const pr = el.play();
      if (pr && typeof pr.catch === "function") {
        pr.catch(() => latest.current.onBlocked?.());
      }
    }
  }, [opts.src, settle, clearKickTimers]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    if (opts.playing) {
      armed.current = true;
      const pr = el.play();
      if (pr && typeof pr.catch === "function") {
        pr.catch(() => latest.current.onBlocked?.());
      }
    } else {
      el.pause();
    }
  }, [opts.playing, opts.src]);

  // Load the next recording into the idle deck and nudge it into buffering.
  useEffect(() => {
    const els = slots.current;
    if (!els[0] || !els[1]) return;
    const nextSrc = opts.nextSrc;
    if (!nextSrc || !opts.src || nextSrc === opts.src) return;
    if (!armed.current) return;

    const idleIndex: 0 | 1 = active.current === 0 ? 1 : 0;
    const el = els[idleIndex]!;
    if (primed.current[idleIndex] === nextSrc) return;

    clearKickTimers();
    if (kickDeck.current === el) {
      settle(el);
    } else if (kickDeck.current) {
      const old = kickDeck.current;
      kickDeck.current = null;
      old.pause();
      old.currentTime = 0;
    }

    el.preload = "auto";
    el.src = nextSrc;
    el.load();
    primed.current[idleIndex] = nextSrc;

    let attempts = 0;
    const tryKick = () => {
      // If the track that just started is still fetching its first seconds,
      // wait: competing with it is how a fresh mood change ends up silent.
      const audible = audioRef.current;
      if (audible && audible.readyState < CAN_START) {
        attempts += 1;
        if (attempts <= 20) kickDelay.current = window.setTimeout(tryKick, 1500);
        return;
      }
      // The queue moved on, or this deck was promoted, while we waited.
      if (latest.current.nextSrc !== nextSrc || latest.current.src === nextSrc) return;
      const deck = slots.current[idleIndex];
      if (!deck || audioRef.current === deck) return;

      kickDeck.current = deck;
      deck.volume = 0;
      deck.muted = true;
      const pr = deck.play();
      if (pr && typeof pr.then === "function") {
        pr.then(() => {
          if (kickDeck.current !== deck) return;
          kickStop.current = window.setTimeout(() => settle(deck), KICK_MS);
        }).catch(() => settle(deck));
      } else {
        kickStop.current = window.setTimeout(() => settle(deck), KICK_MS);
      }
    };

    kickDelay.current = window.setTimeout(tryKick, KICK_DELAY_MS);
  }, [opts.src, opts.nextSrc, opts.playing, settle, clearKickTimers]);

  useEffect(() => {
    for (const el of slots.current) {
      if (!el) continue;
      // Never unmute a deck that is being warmed with silent playback.
      if (kickDeck.current === el) {
        el.volume = 0;
        el.muted = true;
        continue;
      }
      el.volume = opts.muted ? 0 : opts.volume;
      el.muted = opts.muted;
    }
  }, [opts.volume, opts.muted]);

  return { audioRef, slotRefs: [slotA, slotB] as const };
}
