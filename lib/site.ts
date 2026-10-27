export const SITE_NAME = "Ghazal";
export const SITE_TITLE = "Ghazal — a mehfil for the quiet hours";
export const SITE_DESCRIPTION =
  "A single-screen ambient sanctuary for Urdu ghazals. Pick a mood, listen, and let the couplets find you.";

/**
 * Canonical origin for metadata, robots and the sitemap. Set
 * NEXT_PUBLIC_SITE_URL in production; Vercel exposes VERCEL_URL automatically.
 * A localhost fallback keeps development honest instead of inventing a domain.
 */
export function siteUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_URL?.trim();
  if (vercel) return `https://${vercel.replace(/\/+$/, "")}`;
  return "http://localhost:3000";
}
