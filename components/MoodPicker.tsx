"use client";

import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { Mood } from "@/lib/types";

/**
 * Moods are typeset, not illustrated. Each entry is a numbered line in a small
 * weather almanac: an index, a name, and one italic line of weather beneath it.
 * Colour only ever appears as a thread, a numeral, and a wash — never as a
 * badge — so the panel reads as one column of text instead of five cards.
 */
export default function MoodPicker({
  moods,
  activeId,
  onSelect,
}: {
  moods: Mood[];
  activeId: string;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [peekId, setPeekId] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const activeIndex = Math.max(
    0,
    moods.findIndex((m) => m.id === activeId)
  );
  const active = moods[activeIndex] ?? moods[0];
  const peek = moods.find((m) => m.id === peekId) ?? active;

  const focusAt = (i: number) => {
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-mood-row]");
    if (!rows?.length) return;
    rows[Math.min(rows.length - 1, Math.max(0, i))]?.focus({ preventScroll: true });
  };

  const move = (from: number, delta: number) => {
    const n = moods.length;
    if (!n) return;
    focusAt((((from + delta) % n) + n) % n);
  };

  const close = (refocus = true) => {
    setOpen(false);
    setPeekId(null);
    // Defer the refocus: moving focus inside the same Enter keydown would let
    // that keystroke activate the freshly focused trigger and reopen the panel.
    if (refocus) {
      setTimeout(() => triggerRef.current?.focus({ preventScroll: true }), 0);
    }
  };

  // Land keyboard focus on the mood you already live in.
  useLayoutEffect(() => {
    if (!open) return;
    focusAt(activeIndex);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div
      className="relative"
      onKeyDown={(e) => {
        // Space belongs to the focused control here, not to the global play
        // shortcut (the window listener would otherwise preventDefault it).
        if (e.key === " " || e.code === "Space") e.stopPropagation();
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setOpen((v) => !v);
          setPeekId(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
          }
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="mood-listbox"
        aria-label={`Mood: ${active?.name ?? "choose"}`}
        className="mood-trigger glass flex items-center gap-1.5 rounded-full py-2 pl-3.5 pr-3 text-left transition-transform active:scale-[0.98]"
        style={{ "--mood": active?.color ?? "#cbb894" } as CSSProperties}
      >
        <span className="truncate text-[11.5px] leading-none tracking-[0.01em] text-white/88">
          {active?.name ?? "mood"}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          className={`shrink-0 text-white/40 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => close()} />
          <div
            className="absolute right-0 z-30 mt-2 w-[338px] max-w-[calc(100vw-1.5rem)]"
            style={{ "--peek": peek?.color ?? "#cbb894" } as CSSProperties}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                close();
              }
            }}
          >
            <div className="glass mood-panel animate-fade-swap">
              <div className="mood-head">
                <span className="text-[9px] font-normal uppercase tracking-[0.26em] text-white/28">
                  tonight&apos;s weather
                </span>
                <span className="tabnum text-[9px] tracking-[0.14em] text-white/28">
                  {String(activeIndex + 1).padStart(2, "0")}
                  <span className="text-white/16"> / {String(moods.length).padStart(2, "0")}</span>
                </span>
              </div>

              <ul
                id="mood-listbox"
                ref={listRef}
                className="mood-list"
                role="listbox"
                aria-label="Choose a mood"
                onMouseLeave={() => setPeekId(null)}
              >
                {moods.map((m, i) => {
                  const on = m.id === activeId;
                  return (
                    <li key={m.id}>
                      <button
                        type="button"
                        data-mood-row
                        data-on={on ? "true" : "false"}
                        role="option"
                        aria-selected={on}
                        tabIndex={i === activeIndex ? 0 : -1}
                        onMouseEnter={() => setPeekId(m.id)}
                        onFocus={() => setPeekId(m.id)}
                        onClick={() => {
                          onSelect(m.id);
                          close();
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            move(i, 1);
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            move(i, -1);
                          } else if (e.key === "Home") {
                            e.preventDefault();
                            focusAt(0);
                          } else if (e.key === "End") {
                            e.preventDefault();
                            focusAt(moods.length - 1);
                          } else if (e.key === "Tab") {
                            setOpen(false);
                            setPeekId(null);
                          }
                        }}
                        className="mood-row"
                        style={{ "--mood": m.color, "--i": i } as CSSProperties}
                      >
                        <span className="mood-num" aria-hidden="true">
                          {String(i + 1).padStart(2, "0")}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="mood-name">{m.name}</span>
                          <span className="mood-note">{m.vibe_description}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mood-foot">
                <span className="mood-foot-dot" aria-hidden="true" />
                <span className="truncate text-[8.5px] uppercase tracking-[0.18em] text-white/32">
                  {peek?.tags?.length
                    ? peek.tags.slice(0, 3).join(" · ")
                    : "a mehfil for the quiet hours"}
                </span>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
