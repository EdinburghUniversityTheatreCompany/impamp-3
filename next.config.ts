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

export default withBundleAnalyzer(nextConfig);
