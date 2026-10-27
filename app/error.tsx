"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[ghazal] render error", error);
  }, [error]);

  return (
    <div className="stage flex min-h-[100dvh] items-center justify-center px-6">
      <div className="vignette" />
      <div className="glass relative z-10 w-full max-w-md rounded-3xl p-7 text-center">
        <p className="text-[10px] uppercase tracking-[0.28em] text-white/35">interrupted</p>
        <h1 className="roman mt-3 text-[1.9rem] leading-tight text-white/90">
          The mehfil lost its thread
        </h1>
        <p className="mt-3 text-[12.5px] leading-relaxed text-white/45">
          Something failed while rendering this screen. The recordings and poems are
          still intact.
        </p>
        {error.digest && (
          <p className="tabnum mt-3 text-[10px] text-white/25">ref · {error.digest}</p>
        )}
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-white px-4 py-2 text-[12px] font-medium text-black"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-full border border-white/15 px-4 py-2 text-[12px] text-white/70 hover:bg-white/10"
          >
            Back to the mehfil
          </a>
        </div>
      </div>
    </div>
  );
}
