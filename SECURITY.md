# Security notes

## Reporting

This is a self-hosted, single-tenant listening app. If you find a vulnerability,
open a private security advisory on the repository rather than a public issue,
and include the affected route plus a minimal reproduction.

## Runtime posture

- No accounts, cookies, analytics or user data. Preferences live in
  `localStorage`; taps live in `localStorage` until exported by hand.
- The only server-side state is the SSE presence map, which holds no personal
  data and is discarded when the process exits.
- Audio and poetry are public content from archive.org and Rekhta; the app
  stores only their metadata and links back to the source.
- `next.config.js` sets CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy` and COOP.
- `/sync` is an internal tool: it is `noindex`, disallowed in `robots.txt`, and
  writes nothing to the server.

## Dependency advisories

`npm audit --omit=dev` currently reports two package-level findings (several
advisories) against the pinned Next.js 14 line:

| Advisory | Path in this app | Exposure |
| :--- | :--- | :--- |
| Image Optimizer `remotePatterns` DoS | `next/image` | **Not used** — there are no images in the app. |
| RSC request deserialization / rewrite smuggling DoS | Next server | Request-level DoS only; no auth or tenant data to reach. |
| Bundled PostCSS issues | Build-time CSS pipeline | **Not runtime** — CSS is compiled during `next build`. |

The upstream fix is Next 16, a major upgrade (different lint pipeline and
React requirements), so it is deliberately not taken in the same change as the
player work. Until then, deploy behind a reverse proxy with request-rate and
body-size limits, and keep `node_modules` out of the served tree.

## Presence caveat

`app/api/presence/route.ts` counts SSE connections in process memory. It is
correct for one long-lived Node process. A multi-instance deployment needs a
shared counter (for example Redis) or sticky routing; otherwise each instance
reports only its own listeners.
