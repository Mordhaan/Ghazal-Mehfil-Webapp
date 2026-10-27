"use client";

import { useEffect, useRef } from "react";

/**
 * Lock-screen / hardware-media-key integration. On a phone this is the
 * difference between "a web page that makes sound" and a player: the artwork,
 * title and transport appear on the lock screen, and the headphone buttons
 * work without the tab being visible.
 *
 * Every call is guarded: Safari shipped Media Session late and still throws on
 * unsupported actions, which must never take the player down.
 */

const ARTWORK = [
  { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
  { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
];

type Options = {
  title: string;
  artist: string;
  album?: string;
  playing: boolean;
  duration: number;
  position: number;
  onPlay: () => void;
  onPause: () => void;
  onNext: () => void;
  onPrev: () => void;
  onSeek: (t: number) => void;
};

const ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
  "seekbackward",
  "seekforward",
  "stop",
] as const;

function session(): MediaSession | null {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return null;
  return navigator.mediaSession;
}

export function useMediaSession(options: Options): void {
  const latest = useRef(options);
  latest.current = options;

  const { title, artist, album, playing, duration, position } = options;
  const whole = Math.floor(position);

  useEffect(() => {
    const ms = session();
    if (!ms || typeof MediaMetadata === "undefined") return;
    try {
      ms.metadata = new MediaMetadata({
        title: title || "Ghazal",
        artist: artist || "a mehfil for the quiet hours",
        album: album ?? "",
        artwork: ARTWORK,
      });
    } catch {
      /* metadata is a nicety, not a requirement */
    }
  }, [title, artist, album]);

  useEffect(() => {
    const ms = session();
    if (!ms) return;
    try {
      ms.playbackState = playing ? "playing" : "paused";
    } catch {
      /* noop */
    }
  }, [playing]);

  useEffect(() => {
    const ms = session();
    if (!ms || !Number.isFinite(duration) || duration <= 0) return;
    try {
      ms.setPositionState({
        duration,
        playbackRate: 1,
        position: Math.min(duration, Math.max(0, whole)),
      });
    } catch {
      /* some browsers reject position state for live/unknown durations */
    }
  }, [whole, duration]);

  useEffect(() => {
    const ms = session();
    if (!ms) return;

    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* unsupported action on this browser */
      }
    };

    set("play", () => latest.current.onPlay());
    set("pause", () => latest.current.onPause());
    set("stop", () => latest.current.onPause());
    set("previoustrack", () => latest.current.onPrev());
    set("nexttrack", () => latest.current.onNext());
    set("seekto", (details) => {
      if (typeof details.seekTime === "number") latest.current.onSeek(details.seekTime);
    });
    set("seekbackward", (details) => {
      const step = details.seekOffset ?? 10;
      latest.current.onSeek(Math.max(0, latest.current.position - step));
    });
    set("seekforward", (details) => {
      const step = details.seekOffset ?? 10;
      latest.current.onSeek(latest.current.position + step);
    });

    return () => {
      for (const action of ACTIONS) set(action, null);
    };
  }, []);
}
