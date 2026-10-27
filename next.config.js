/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

/**
 * A pragmatic CSP: it forbids third-party scripts and framing, while allowing
 * the inline bootstrap Next.js emits and the archive.org media host. Fonts are
 * self-hosted, so no Google origins are needed any more.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' https://archive.org https://*.archive.org blob:",
  "connect-src 'self' https://archive.org https://*.archive.org",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          ...(isDev
            ? []
            : [
                {
                  key: "Strict-Transport-Security",
                  value: "max-age=63072000; includeSubDomains; preload",
                },
              ]),
        ],
      },
      // The per-track timelines are content-addressable by media hash and can
      // live in the browser cache for a day. The manifest must stay fresh, so
      // its rule comes after the wildcard (later rules win in Next).
      {
        source: "/timings/:file*.json",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, stale-while-revalidate=604800",
          },
        ],
      },
      {
        source: "/timings/index.json",
        headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
      },
      ...["/icon-192.png", "/icon-512.png", "/icon-maskable-512.png", "/apple-touch-icon.png", "/og.png"].map(
        (source) => ({
          source,
          headers: [
            { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
          ],
        })
      ),
    ];
  },
};

module.exports = nextConfig;
