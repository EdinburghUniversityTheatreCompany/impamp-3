import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// Bundle analyzer for measuring code splitting improvements
const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  output: "standalone",
  compiler: {
    // Strip `console.log` from production builds, keeping everything that
    // reports a problem or a decision.
    //
    // 302 `console.log` sites shipped to the browser, densest exactly where it
    // costs most: 49 in `useKeyboardListener` on the keydown path, 24 in
    // `controls.ts` (about two per pad trigger), 15 in `playback.ts`, eight in
    // `cache.ts` — one per buffer stored, each building a `toFixed` template
    // whether or not anything reads it. With devtools closed that is a few
    // microseconds a call; with devtools open, which is where an operator
    // debugging a show actually is, it is one to two orders of magnitude more.
    // The transform removes the arguments as well as the call, so the template
    // strings stop being built and stop being shipped.
    //
    // `error` and `warn` stay because they report failures. `info` stays as
    // the level for a message worth having in a venue — the trigger path's
    // "which route did this cue take" line is one, and the server's operational
    // logging is all `info`/`warn`/`error` already, so nothing there goes
    // quiet. `console.log` is left meaning "debug detail", which is what these
    // 302 are.
    removeConsole: { exclude: ["error", "warn", "info"] },
  },
  // Pin the workspace root rather than letting Next infer it. Inference walks
  // up looking for a lockfile, so an unrelated package-lock.json in a parent
  // directory (a stray ~/package-lock.json used to do exactly this) makes Next
  // treat that directory as the root — which both widens the file-tracing scope
  // and, on Next 15, nested the standalone server under the checkout's path
  // relative to that root instead of at .next/standalone/server.js.
  //
  // Next 16.3 emits the server at the root of .next/standalone regardless, so
  // the nesting no longer reproduces; the pin is here so the trace scope and
  // the output layout stay a property of this repo rather than of whatever
  // happens to sit above it. The Dockerfile copies .next/standalone wholesale
  // and runs `node server.js`, which only works with a flat layout.
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "lh3.googleusercontent.com",
      },
    ],
  },
  poweredByHeader: false,
  // Add security headers for the PWA
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            // Report-Only on purpose — see `contentSecurityPolicy` below.
            key: "Content-Security-Policy-Report-Only",
            value: contentSecurityPolicy(),
          },
          {
            // TLS is terminated at kamal-proxy (`ssl: true` in
            // config/deploy.yml), which obtains the certificate but does not
            // add this. Without it, the first request of a session can still
            // be made over plaintext and downgraded.
            //
            // No `preload`, and no `includeSubDomains`: this app is one host
            // under bedlamtheatre.co.uk, and asserting a policy for the whole
            // domain — irreversibly, in the case of preload — is not this
            // deployment's to assert.
            key: "Strict-Transport-Security",
            value: "max-age=31536000",
          },
          {
            // The board needs none of these. Denying them costs nothing and
            // means a compromised dependency cannot quietly ask for the
            // microphone on a machine sitting in a venue.
            key: "Permissions-Policy",
            value:
              "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
          },
        ],
      },
      {
        // The sync API said nothing about caching: no Cache-Control, no ETag,
        // no Last-Modified on any route handler. Chromium happens not to reuse
        // such a response — with no validator there is no heuristic freshness —
        // but "no browser currently does this" is not the same as "nothing may".
        // Any intermediary is free to hold a profile read, and for this API the
        // consequence is a deleted profile coming back or a failed write looking
        // like it landed. The service worker already refuses to touch /api for
        // the same reason; this says it to everything else too.
        //
        // Excluding the two routes that set their own, because a header here
        // *replaces* theirs rather than losing to it — measured, not assumed.
        // The public Drive proxies are deliberately cacheable for an hour, so
        // blanket no-store would send every viewer of a shared board back
        // through this deployment's Google quota for bytes it just served. The
        // SSE stream needs its own no-transform so intermediaries do not buffer
        // it, which is the difference between live updates and none.
        source: "/api/:path((?!drive/public-|profiles/[^/]+/events).*)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-store",
          },
        ],
      },
    ];
  },
};

/**
 * The Content-Security-Policy, shipped **Report-Only** to begin with.
 *
 * There was no CSP at all, which matters more here than for an ordinary app:
 * the Drive proxies serve a stranger's bytes from this app's own origin.
 * `nosniff` is on those responses, but CSP is the layer that contains anything
 * that does get through.
 *
 * Report-Only because the enforcing version cannot be written from reading the
 * source. Two of the origins below were found only by reading a dependency and
 * an env-var contract:
 *
 * - `@react-oauth/google` injects `https://accounts.google.com/gsi/client` at
 *   runtime. A repo-wide grep for `<script>` and `next/script` finds nothing,
 *   which is exactly how "this app loads no third-party scripts" came to be
 *   written down and be wrong.
 * - Hosted audio is uploaded and downloaded **straight from the browser to the
 *   bucket** on presigned URLs, so `connect-src` has to name a host that is
 *   configured per deployment (`IMPAMP_S3_ENDPOINT`) and is absent entirely
 *   when hosting is off.
 *
 * And that second one comes with a caveat that has to be stated rather than
 * discovered: **Next evaluates `headers()` when it builds, not per request**,
 * so `IMPAMP_S3_ENDPOINT` is only picked up if it is set *at build time*.
 * Measured, not assumed — setting it only in the run environment leaves the
 * origin out of the header. `config/deploy.yml` supplies it at run time, so a
 * Kamal-built image ships a policy that does not name the bucket, and hosted
 * audio will show up in the reports. That is survivable precisely because this
 * is Report-Only; it is also the thing that must be fixed before promoting the
 * header, either by passing the endpoint as a build ARG (which pins one image
 * to one bucket) or by emitting the policy from middleware, where the value
 * can be read per request. The nonce that `script-src` wants needs that same
 * middleware, so the two are one piece of work.
 *
 * Neither is the kind of thing to discover by enforcing it in front of an
 * audience. Watch the reports through a real show — a sign-in, a sync, an
 * upload, a shared board — then promote the header to `Content-Security-Policy`
 * and tighten `script-src` with a nonce.
 *
 * `'unsafe-inline'` is in `script-src` deliberately for now: Next inlines its
 * own hydration bootstrap, and removing it needs a nonce, which needs
 * middleware this app does not have. Reporting on it would fire on every page
 * load and teach everyone to ignore the report.
 */
function contentSecurityPolicy(): string {
  // Wasabi (or whatever S3-compatible endpoint is configured). Absent when
  // hosted audio is off, in which case nothing ever connects there.
  const objectStore = process.env.IMPAMP_S3_ENDPOINT?.trim();

  const connect = [
    "'self'",
    "https://www.googleapis.com",
    "https://accounts.google.com",
    ...(objectStore ? [objectStore.replace(/\/+$/, "")] : []),
  ];

  return [
    "default-src 'self'",
    // See the note above: 'unsafe-inline' goes when a nonce arrives.
    "script-src 'self' 'unsafe-inline' https://accounts.google.com",
    // Tailwind and Next both emit inline style attributes.
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${connect.join(" ")}`,
    // `data:` for generated icons, `blob:` for waveforms and object URLs,
    // googleusercontent for the signed-in user's avatar.
    "img-src 'self' data: blob: https://*.googleusercontent.com",
    // Every sound plays from an object URL over IndexedDB bytes.
    "media-src 'self' blob:",
    // The loudness analyser runs off-thread.
    "worker-src 'self' blob:",
    // Google Identity Services renders its prompt in an iframe.
    "frame-src https://accounts.google.com",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    // The same statement as X-Frame-Options: DENY, in the header that
    // supersedes it.
    "frame-ancestors 'none'",
  ].join("; ");
}

export default withBundleAnalyzer(nextConfig);
