"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Mood } from "@/lib/types";

/**
 * A 32×32 sketch of each mood's weather — crescent, orbit, rain, a broken
 * diamond. Abstract on purpose: at 24px it should read as atmosphere, not
 * as an icon set.
 */
function Motif({ id }: { id: string }) {
  switch (id) {
    case "3am-melancholy":
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <path d="M20 7.4a9.6 9.6 0 1 0 0 17.2 12 12 0 0 1 0-17.2z" />
          <circle className="solid twinkle" cx="8.7" cy="9.6" r="1.15" />
          <circle className="solid twinkle-late" cx="10.4" cy="23.4" r="0.7" />
        </svg>
      );

    case "tender-romance":
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <path d="M16 25C13.5 23 6 18.1 6 13.1a5.4 5.4 0 0 1 10-2.9 5.4 5.4 0 0 1 10 2.9c0 5-7.5 9.9-10 11.9z" />
          <circle className="solid pulse" cx="16" cy="15.1" r="1.55" />
        </svg>
      );

    case "sufi-transcendence":
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <g className="orbit">
            <ellipse cx="16" cy="16" rx="10.7" ry="4.3" transform="rotate(-28 16 16)" opacity="0.8" />
            <circle className="solid" cx="26.7" cy="16" r="1.15" transform="rotate(-28 16 16)" />
          </g>
          <g className="orbit-rev">
            <ellipse
              cx="16"
              cy="16"
              rx="10.7"
              ry="4.3"
              transform="rotate(58 16 16)"
              opacity="0.35"
            />
          </g>
          <circle className="solid" cx="16" cy="16" r="1.7" />
        </svg>
      );

    case "rebellious-philosophical":
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <path d="M15.4 7.6H9.4a1.8 1.8 0 0 0-1.8 1.8v13.2a1.8 1.8 0 0 0 1.8 1.8h13.2a1.8 1.8 0 0 0 1.8-1.8v-8.4" />
          <circle className="solid flicker" cx="27.2" cy="10.6" r="1.05" />
        </svg>
      );

    case "lofi-rain-chill":
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <path className="rain" d="M11 7.6 9 13.1" />
          <path className="rain rain-2" d="M17.2 6.2 15.2 11.7" />
          <path className="rain rain-3" d="M23.4 8 21.4 13.5" />
          <path d="M7.6 25.4c2.2-1.5 4.4-1.5 6.6 0" opacity="0.45" />
        </svg>
      );

    default:
      return (
        <svg viewBox="0 0 32 32" className="mood-motif" aria-hidden="true" focusable="false">
          <circle cx="16" cy="16" r="7" opacity="0.6" />
          <circle className="solid" cx="16" cy="16" r="1.6" />
        </svg>
      );
  }
}

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

  const close = (refocus = true) => {
    setOpen(false);
    setPeekId(null);
    if (refocus) triggerRef.current?.focus({ preventScroll: true });
  };

  // Land keyboard focus on the mood you already live in.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => focusAt(activeIndex));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
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
        className="glass flex items-center gap-2 rounded-full py-1.5 pl-2 pr-2.5 text-left transition-transform active:scale-[0.98]"
        style={{ "--mood": active?.color ?? "#cbb894" } as CSSProperties}
      >
        <span className="mood-chip" aria-hidden="true">
          <Motif id={active?.id ?? ""} />
        </span>
        <span className="max-w-[92px] truncate text-[11.5px] font-medium text-white/90 sm:max-w-none">
          {active?.name ?? "mood"}
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          className={`text-white/45 transition-transform duration-300 ${open ? "rotate-180" : ""}`}
          aria-hidden="true"
        >
          <path d="M6 9l6 6 6-6" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => close()} />
          <div
            className="absolute right-0 z-30 mt-2 w-[300px] max-w-[calc(100vw-2rem)]"
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
                <span className="text-[8.5px] font-medium uppercase tracking-[0.24em] text-white/30">
                  tonight&apos;s weather
                </span>
                <span className="tabnum text-[9px] tracking-[0.1em] text-white/30">
                  {String(activeIndex + 1).padStart(2, "0")}
                  <span className="text-white/20"> / {String(moods.length).padStart(2, "0")}</span>
                </span>
              </div>

              <ul
                id="mood-listbox"
                ref={listRef}
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
                            focusAt(i + 1);
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            focusAt(i - 1);
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
                        className="mood-row group"
                        style={{ "--mood": m.color, "--i": i } as CSSProperties}
                      >
                        <span className="mood-tile" aria-hidden="true">
                          <Motif id={m.id} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={`block truncate text-[12.5px] font-medium leading-tight transition-colors ${
                              on ? "text-white" : "text-white/80 group-hover:text-white/95"
                            }`}
                          >
                            {m.name}
                          </span>
                          <span
                            className={`mt-[3px] block text-[10.5px] leading-[1.45] transition-colors line-clamp-2 ${
                              on ? "text-white/60" : "text-white/40 group-hover:text-white/50"
                            }`}
                          >
                            {m.vibe_description}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="mood-foot">
                <span className="mood-foot-dot" aria-hidden="true" />
                <span className="truncate text-[8.5px] uppercase tracking-[0.16em] text-white/35">
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
