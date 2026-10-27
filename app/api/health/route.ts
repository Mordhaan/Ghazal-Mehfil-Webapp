import catalog from "@/data/catalog.json";
import timingIndex from "@/public/timings/index.json";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type HealthCatalog = { generated?: string; tracks: unknown[]; ghazals: unknown[] };
type HealthIndex = { generated?: string; tracks: Record<string, unknown> };

/**
 * Liveness + data freshness for a deploy check or an uptime monitor. It reads
 * only build-time data, so it answers quickly and never touches archive.org.
 */
export function GET(): Response {
  const cat = catalog as unknown as HealthCatalog;
  const index = timingIndex as unknown as HealthIndex;
  const timed = Object.keys(index.tracks ?? {}).length;

  return Response.json(
    {
      ok: true,
      service: "ghazal",
      version: process.env.npm_package_version ?? "1.1.0",
      uptimeSeconds: Math.round(process.uptime()),
      catalogue: {
        generated: cat.generated ?? null,
        tracks: cat.tracks.length,
        ghazals: cat.ghazals.length,
        timed,
      },
      timingsGenerated: index.generated ?? null,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
