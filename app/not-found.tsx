import Link from "next/link";

export default function NotFound() {
  return (
    <div className="stage flex min-h-[100dvh] items-center justify-center px-6">
      <div className="vignette" />
      <div className="glass relative z-10 w-full max-w-md rounded-3xl p-7 text-center">
        <p className="tabnum text-[10px] uppercase tracking-[0.28em] text-white/35">404</p>
        <h1 className="roman mt-3 text-[2rem] leading-tight text-white/90">
          This page never made it to the mehfil
        </h1>
        <p className="mt-3 text-[12.5px] leading-relaxed text-white/45">
          The address is wrong, or the page has been retitled. The player is still
          where you left it.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex rounded-full bg-white px-4 py-2 text-[12px] font-medium text-black"
        >
          Return to the player
        </Link>
      </div>
    </div>
  );
}
