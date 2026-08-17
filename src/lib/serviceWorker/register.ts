/**
 * Service worker registration.
 *
 * The worker itself is `public/sw.js`; its header comment carries the caching
 * and update reasoning. This module owns two decisions:
 *
 * 1. **Only production builds register.** In `next dev`, Turbopack recompiles
 *    on every edit and the chunk URLs move constantly, so a cache-first worker
 *    would serve a developer their own stale bundle — and, because a
 *    registration survives the server that created it, it would keep doing so
 *    after they went back to `npm run dev`. That has a nasty corollary: the
 *    e2e suite and `npm run dev` both default to port 3000, and a service
 *    worker is scoped to an origin, not to a server. So dev does not merely
 *    skip registering: it actively unregisters anything already there and
 *    drops our caches. Without that, one `npm start` on port 3000 would haunt
 *    the dev server indefinitely.
 *
 *    The Playwright suite runs against a production build (see
 *    playwright.config.ts), so it exercises the worker exactly as a deploy
 *    does — which is the only configuration worth asserting on.
 *
 * 2. **The registration URL carries the build.** `sw.js` is byte-identical
 *    across deploys, so nothing would tell the browser a new version exists;
 *    it would keep the worker installed months ago, whose precached chunk
 *    URLs no longer resolve. Putting the build id in the query string makes
 *    each build a distinct script URL, which is both what triggers the update
 *    check and what versions the caches.
 */

import buildInfo from "@/generated/build-info.json";

/**
 * `buildDate` rather than `commitHash` alone: a rebuild from the same commit
 * still produces different hashed chunk names, so the commit is not on its own
 * a description of what is deployed. The hash is kept because it is the half a
 * human reads in devtools.
 */
const BUILD_ID = `${buildInfo.commitHash}-${buildInfo.buildDate}`;

const SERVICE_WORKER_URL = `/sw.js?build=${encodeURIComponent(BUILD_ID)}`;

const CACHE_PREFIX = "impamp-";

async function removeServiceWorkers(): Promise<void> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  await Promise.all(registrations.map((r) => r.unregister()));

  if (!("caches" in window)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((name) => name.startsWith(CACHE_PREFIX))
      .map((name) => caches.delete(name)),
  );
}

function whenLoaded(run: () => void): void {
  // Registration competes with the app's own startup fetches for bandwidth,
  // and the worker's install immediately re-fetches the whole asset graph, so
  // hold it until the page has finished loading. `readyState` is checked
  // because a React effect can easily run after `load` has already fired, and
  // a listener added then never runs at all.
  if (document.readyState === "complete") {
    run();
  } else {
    window.addEventListener("load", run, { once: true });
  }
}

/**
 * Registers the service worker in production, and makes sure there isn't one
 * anywhere else. Safe to call more than once; the browser treats a repeat
 * registration of the same URL as a no-op update check.
 */
export function registerServiceWorker(): void {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

  if (process.env.NODE_ENV !== "production") {
    void removeServiceWorkers().catch((error) => {
      console.warn("Could not clear the development service worker:", error);
    });
    return;
  }

  whenLoaded(() => {
    void navigator.serviceWorker
      .register(SERVICE_WORKER_URL)
      .then((registration) => {
        // Purely informational. Nothing prompts the user and nothing reloads
        // the page: a waiting worker takes over the next time the app is
        // opened with no other tab holding the old one, which is the whole
        // point of not calling skipWaiting().
        if (registration.waiting) {
          console.info(
            "[sw] a newer build is installed and will be used next launch",
          );
        }
      })
      .catch((error) => {
        // An unregistered worker only costs offline support, so this must
        // never be allowed to surface as an unhandled rejection.
        console.warn("Service worker registration failed:", error);
      });
  });
}
