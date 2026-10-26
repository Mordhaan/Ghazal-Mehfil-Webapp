"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type PresenceState = "connecting" | "live" | "reconnecting";

/**
 * Subscribes to the server's real presence stream.
 *
 * The count is whatever the server reports. It is never generated locally and
 * never defaults to an invented value. While disconnected the UI is told to say
 * so instead of showing a stale number as if it were current.
 *
 * A lightweight heartbeat keeps the server's view of this tab fresh, so a tab
 * that is killed (rather than closed) stops being counted within ~30s instead
 * of lingering.
 */
export function usePresence(): { count: number; state: PresenceState } {
  const [count, setCount] = useState(0);
  const [state, setState] = useState<PresenceState>("connecting");
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const attemptRef = useRef(0);
  const idRef = useRef<string | null>(null);

  const stop = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    if (typeof window === "undefined") return;
    stop();

    try {
      const es = new EventSource("/api/presence");
      esRef.current = es;

      const handle = (ev: MessageEvent) => {
        try {
          const data = JSON.parse(ev.data) as {
            count: number;
            ts?: number;
            id?: string;
          };
          if (typeof data.id === "string" && data.id) idRef.current = data.id;
          if (typeof data.count === "number") {
            setCount(data.count);
            setState("live");
            attemptRef.current = 0;
          }
        } catch {
          /* ignore malformed frame */
        }
      };

      es.addEventListener("presence", handle as EventListener);
      es.onopen = () => setState("live");

      es.onerror = () => {
        setState("reconnecting");
        stop();
        const delay = Math.min(800 * 2 ** attemptRef.current, 12_000);
        attemptRef.current += 1;
        retryRef.current = setTimeout(connect, delay);
      };

      // Heartbeat so an abruptly killed tab stops counting quickly.
      pingRef.current = setInterval(() => {
        fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: idRef.current ?? "" }),
          keepalive: true,
        }).catch(() => {
          /* the SSE error handler will deal with real disconnects */
        });
        setState((s) => (s === "live" ? s : "reconnecting"));
      }, 15_000);
    } catch {
      setState("reconnecting");
    }
  }, [stop]);

  useEffect(() => {
    connect();
    const onVisible = () => {
      if (document.visibilityState === "visible" && !esRef.current) connect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (retryRef.current) clearTimeout(retryRef.current);
      stop();
    };
  }, [connect, stop]);

  return { count, state };
}
