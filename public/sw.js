/**
 * ImpAmp3 service worker — the app shell, cached; the sync, never.
 *
 * This is a soundboard driven live during performances. Losing the venue's
 * wifi mid-show must not take the board down, so everything the board itself
 * needs is served from Cache Storage: the HTML document, the JavaScript and
 * CSS Next emits, the fonts those stylesheets pull in, and the icons. Sounds
 * need nothing from here — they are Blobs in IndexedDB and were never fetched
 * over HTTP in the first place.
 *
 * ## What is cached, and what is deliberately not
 *
 * - `/_next/static/**` — content-hashed and therefore immutable. Cache-first.
 * - `/`, and any other navigated document — cached after a *successful*
 *   network fetch, so the offline fallback is always the last page that
 *   actually loaded. Keyed by path, never by full URL — see
 *   `documentCacheKey`.
 * - `/icons/**`, `/favicon.ico`, `/manifest.webmanifest`, `/offline.html` —
 *   the small unhashed set an installed PWA needs. Cache-first, refreshed by
 *   each new build (see cache naming below).
 * - `/api/**` — **never touched.** This is the syncing, and it is the one
 *   thing that genuinely needs the network. A stale sync response could
 *   resurrect a deleted profile or hide a failed write, which is worse than an
 *   honest network error. The handler returns without calling `respondWith`,
 *   so the browser performs its ordinary fetch and fails offline exactly as it
 *   would with no service worker at all.
 * - `/up` — a health check that reported the cache would be a lie.
 * - Cross-origin requests — Google Drive and the presigned Wasabi URLs. Those
 *   are short-lived, credentialed, and not ours to keep.
 * - Anything not on that list (RSC payloads, `POST`s, `/_next/image`) —
 *   passthrough. A small, explicit allow-list is easier to reason about than a
 *   catch-all with exceptions, and the failure mode of forgetting an entry is
 *   "it needs the network", not "it served something stale".
 *
 * ## How the precache list is built
 *
 * It isn't. A hand-maintained list of hashed chunk names is exactly the "two
 * copies that drift" failure this repo keeps hitting, and it would be stale
 * the first time anyone ran `next build`.
 *
 * Instead the worker derives the list at install time by walking the asset
 * graph outwards from the live HTML: fetch `/`, pull every `/_next/static/…`
 * reference out of it, fetch those, pull the references out of *them*, and
 * repeat until nothing new appears. That works because Turbopack writes the
 * chunk paths for dynamic imports into the parent chunk as plain string
 * literals, and CSS names its fonts the same way — so lazily-loaded screens
 * (the profile manager, the help and bulk-import modals, the waveform trimmer)
 * come along for free rather than only being cached once you have opened them
 * online. The list is therefore always exactly what this build ships.
 *
 * ## Update semantics: never mid-show
 *
 * There is no `skipWaiting()`. A new worker activating under a live page would
 * swap chunks beneath an already-running board — a half-updated app, or an
 * unexpected reload, during a performance is the single worst thing this app
 * could do. So a new build installs quietly in the background and waits. It
 * takes over the next time every tab has been closed and the app is opened
 * again, which for this app is the next show. There is no "update ready"
 * prompt for the same reason: a dialog asking a question during a cue is
 * itself the failure.
 *
 * Nothing listens for `controllerchange` to reload the page either, and that
 * omission is the point.
 *
 * ## Cache naming
 *
 * The registration URL carries a `?build=` parameter (see
 * `src/lib/serviceWorker/register.ts`), which changes with every build. A
 * changed script URL is what makes the browser treat this as a new worker at
 * all, and it doubles as the cache version: each build gets its own caches and
 * deletes every older one when it activates. That gives bounded storage and,
 * more usefully, a cache that always holds one coherent build rather than a
 * sediment of chunks from several.
 */

/* global clients */

const BUILD =
  new URL(self.location.href).searchParams.get("build") || "unversioned";
const SHELL_CACHE = `impamp-shell-${BUILD}`;
const ASSET_CACHE = `impamp-assets-${BUILD}`;
const OWN_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);
const CACHE_PREFIX = "impamp-";

const SHELL_URL = "/";
const OFFLINE_URL = "/offline.html";

/**
 * The unhashed files an installed PWA needs that the HTML does not reference:
 * the offline fallback, and the icons a launcher or tab shows. `/` itself and
 * the manifest are handled separately (the first is the shell, the second is
 * linked from the HTML but lives outside `/_next/static/`).
 */
const EXTRA_SHELL_URLS = [
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.ico",
  "/icons/icon-192x192.png",
  "/icons/icon-512x512.png",
];

/** Same-origin paths outside `/_next/static/` that are safe to serve cache-first. */
const CACHEABLE_SHELL_PATHS = new Set([
  OFFLINE_URL,
  "/manifest.webmanifest",
  "/favicon.ico",
]);

/**
 * Matches a Next build asset reference, in HTML (`/_next/static/chunks/x.js`),
 * in JavaScript (`"static/chunks/x.js"` — Turbopack's dynamic-import lists),
 * and in CSS (`url(/_next/static/media/x.woff2)`). Deliberately loose about
 * the directory segment so `chunks/`, `css/`, `media/` and the build-id
 * directory are all covered without naming any of them.
 *
 * `.ts` is deliberately *not* in the extension list. A production build does
 * emit `/_next/static/media/analyse.worker.<hash>.ts`, and precaching it looks
 * like the right thing to do, but that asset is a decoy — see the comment in
 * src/lib/audio/loudness/analyseOffThread.ts. Nothing ever loads it.
 */
const ASSET_REFERENCE =
  /static\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.(?:js|mjs|css|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif)/g;

/** Extensions worth re-reading for further references. */
const TEXT_ASSET = /\.(?:js|mjs|css)$/;

/**
 * Bounds on the graph walk. Neither has ever been reached by a real build —
 * they exist so a pathological or hostile response cannot turn install into an
 * unbounded crawl of the origin.
 */
const MAX_GRAPH_DEPTH = 8;
const MAX_ASSETS = 500;

/** Pulls the distinct `/_next/static/…` URLs referenced by a blob of text. */
function collectAssetUrls(text) {
  const matches = text.match(ASSET_REFERENCE);
  if (!matches) return [];
  return [...new Set(matches)].map((match) => `/_next/${match}`);
}

/**
 * Walks the asset graph outwards from `seedText`, caching everything it finds.
 *
 * A single missing or 404 asset must not fail the install: the regex is
 * deliberately loose, so an occasional false positive (a string in the bundle
 * that merely looks like a chunk path) is expected and harmless.
 */
async function cacheAssetGraph(seedText) {
  const cache = await caches.open(ASSET_CACHE);
  const seen = new Set();
  let frontier = collectAssetUrls(seedText);

  for (let depth = 0; depth < MAX_GRAPH_DEPTH && frontier.length > 0; depth++) {
    const discovered = [];

    await Promise.all(
      frontier.map(async (url) => {
        if (seen.has(url) || seen.size >= MAX_ASSETS) return;
        seen.add(url);

        try {
          // No `cache: "reload"` here: these URLs are content-hashed, so the
          // HTTP cache cannot hold a wrong answer, and the page has usually
          // just fetched them anyway.
          const response = await fetch(url);
          if (!response.ok) return;
          await cache.put(url, response.clone());
          if (TEXT_ASSET.test(url)) {
            discovered.push(...collectAssetUrls(await response.text()));
          }
        } catch {
          // Offline or a false-positive URL. Either way, keep going.
        }
      }),
    );

    frontier = discovered;
  }

  return seen.size;
}

/**
 * Fetches the shell fresh, caches it, and caches everything it transitively
 * references. Failing here fails the install, which is correct: a worker that
 * activated without the shell would take control and then serve nothing.
 */
async function precache() {
  const response = await fetch(SHELL_URL, { cache: "reload" });
  if (!response.ok) {
    throw new Error(`Cannot precache the app shell: HTTP ${response.status}`);
  }

  const shellCache = await caches.open(SHELL_CACHE);
  await shellCache.put(SHELL_URL, response.clone());

  const assetCount = await cacheAssetGraph(await response.text());

  // Best-effort: an icon that fails to fetch is not a reason to have no
  // offline app at all.
  await Promise.all(
    EXTRA_SHELL_URLS.map((url) =>
      shellCache
        .add(new Request(url, { cache: "reload" }))
        .catch((error) =>
          console.warn(`[sw] could not precache ${url}:`, error),
        ),
    ),
  );

  console.info(`[sw] build ${BUILD} precached ${assetCount} build assets`);
}

/**
 * Where a navigated document is filed: its path, with the query dropped.
 *
 * A share link is `/server/open?id=…&token=…`, and the token in it is the
 * whole credential. Keying the cache on `request.url` wrote that token into a
 * Cache Storage key that then outlived the visit — it is only evicted when the
 * next build changes `?build=` and `activate` deletes the old caches. Cache
 * Storage is not a place a credential has any business being, and nothing here
 * needed it there.
 *
 * Dropping the query costs nothing, because no document this app serves varies
 * with it. Every page that reads a query parameter — `/server/open`,
 * `/drive/open` — is a client component reading `useSearchParams` in the
 * browser, so the HTML is identical whatever the link says; the parameters
 * still reach the page from `location`, which the cache never touched. The
 * only observable change is that opening a *second* share link offline now
 * finds the same page rather than falling through to the board, which is the
 * better answer of the two.
 *
 * The write and the offline read must use this same key or they stop matching,
 * which is a bug with no symptom online.
 */
function documentCacheKey(requestUrl) {
  const url = new URL(requestUrl);
  return url.origin + url.pathname;
}

/**
 * Documents are network-first: a deploy has to be able to land, and the HTML
 * is the one file whose URL does not change when its contents do. The cached
 * copy is only ever a fallback, and it is refreshed on every successful load
 * so what you get offline is the last thing that actually worked.
 */
async function handleNavigation(request) {
  const cacheKey = documentCacheKey(request.url);
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch (error) {
    const cache = await caches.open(SHELL_CACHE);
    const cached =
      (await cache.match(cacheKey)) ??
      // Any other route falls back to the board itself rather than to the
      // "you are offline" page: the board is what the user came for, and the
      // routes that are not it (`/drive/open`, `/server/*`) need the network
      // to do anything anyway.
      (await cache.match(SHELL_URL)) ??
      (await cache.match(OFFLINE_URL));
    if (cached) return cached;
    throw error;
  }
}

/** Cache-first, populating the cache on a miss. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  // No skipWaiting() — see the update-semantics note at the top of this file.
  event.waitUntil(precache());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter(
            (name) => name.startsWith(CACHE_PREFIX) && !OWN_CACHES.has(name),
          )
          .map((name) => caches.delete(name)),
      );

      // Safe despite the no-skipWaiting rule above: a *replacement* worker
      // only reaches activate once every page the old one controlled is gone,
      // so there is no live board to claim out from under. On a first install
      // there is no previous worker, and the page that just loaded matches the
      // assets we cached — claiming it there is what makes the very first
      // visit survive going offline without a second reload.
      await clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // The sync. Never cached, never intercepted — see the header comment.
  if (url.pathname.startsWith("/api/") || url.pathname === "/up") return;

  // Worker scripts must come from the network, and this is not a preference.
  //
  // Turbopack bootstraps a Web Worker by putting its configuration in the URL
  // *fragment* — the loudness analysis worker is loaded as
  // `turbopack-worker-<hash>.js#params=[[…chunks…]]`, and the bootstrap reads
  // it back off `self.location.hash`. A response served from Cache Storage
  // carries the bare URL, so the fragment is gone by the time the worker
  // starts and it dies with "Missing worker bootstrap config" — which
  // `loudness-worker.spec.ts` caught, and which nothing else would have: the
  // analysis silently falls back to the main thread, produces identical
  // numbers, and merely blocks the thread that is also feeding Web Audio.
  //
  // Leaving these to the network also leaves the worker uncontrolled, so its
  // own imports bypass this worker too, which is the consistent behaviour.
  // The cost is that analysing a *newly added* sound offline runs on the main
  // thread. Playback, including of everything already analysed, is unaffected.
  if (
    request.destination === "worker" ||
    request.destination === "sharedworker"
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(handleNavigation(request));
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (
    url.pathname.startsWith("/icons/") ||
    CACHEABLE_SHELL_PATHS.has(url.pathname)
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
