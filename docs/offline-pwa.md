# Offline and the service worker

ImpAmp3 is used live during performances. Losing the venue's wifi mid-show must
not take the board down, so the app caches itself and runs from that cache.

Sounds never needed this. Audio is stored as Blobs in IndexedDB and is not
fetched over HTTP at all, so playback was always independent of the network.
What was missing was the app around them: without a cached shell, a reload with
no connection gave a blank page and the sounds sat there unreachable.

For a year the repo claimed to have solved this and had not. `public/sw.js`
existed, was gitignored, was registered nowhere, and would not have worked if
it had been — it precached nothing under `/_next/static`, so the shell could
not have booted. That is the history worth knowing before changing anything
here: the code existing is not the same as the feature existing, which is why
`e2e-tests/offline.spec.ts` cuts the network for real rather than asserting
that a registration happened.

## What works offline

After one online visit:

| Works                                   | Needs the network            |
| --------------------------------------- | ---------------------------- |
| Launching the board, switching banks    | Google Drive sync            |
| Triggering pads, all playback           | Server sync and its SSE feed |
| Editing pads and banks                  | Hosted (Wasabi) audio        |
| Profile management, import and export   | Signing in                   |
| Search, arming, every keyboard shortcut |                              |

One thing degrades rather than failing: analysing the loudness of a
_newly added_ sound runs on the main thread instead of in a Web Worker, because
worker scripts are deliberately not served from the cache (see below). The
result is identical, just slower, and only while offline.

## The caching rules

Implemented in `public/sw.js`, which carries the full reasoning inline.

- **`/_next/static/**`** — cache-first. Those URLs are content-hashed, so the
  cache cannot hold a wrong answer.
- **Navigated documents** — network-first. HTML is the one file whose URL does
  not change when its contents do, so a deploy has to be able to land. The last
  successful response is kept as the offline fallback, which means what you get
  offline is the last page that actually worked.
- **`/icons/**`, `/manifest.webmanifest`, `/favicon.ico`, `/offline.html`** —
  cache-first. Unhashed, but each build gets its own cache, so they refresh.
- **`/api/**` and `/up`** — never cached and never intercepted. This is the one
  thing that genuinely needs the network. A stale sync response could resurrect
  a deleted profile or hide a failed write, which is worse than an honest
  network error, and a health check answered from a cache is a lie.
- **Cross-origin** — never touched. Those are Google Drive and the presigned
  Wasabi URLs: short-lived, credentialed, and not ours to keep.
- **Worker scripts** — never intercepted. Turbopack passes a Web Worker its
  bootstrap configuration in the URL _fragment_, and Cache Storage excludes
  fragments when matching, so a cached response starts a worker that
  immediately fails with "Missing worker bootstrap config". This is what makes
  loudness analysis fall back to the main thread offline.
- **Everything else** — passthrough. The allow-list is deliberately small: the
  cost of forgetting an entry is "it needs the network", not "it served
  something stale".

## There is no precache list

Hand-maintaining a list of hashed chunk names is the "two copies that drift"
failure this repo keeps hitting, and it would be wrong the first time anyone
ran `next build`.

Instead the worker derives it at install by walking the asset graph out from
the live HTML: fetch `/`, pull the `/_next/static/…` references out of it,
fetch those, pull the references out of them, and repeat until nothing new
turns up. Turbopack writes dynamic-import chunk paths into the parent chunk as
plain string literals, and CSS names its fonts the same way, so lazily-loaded
screens — the profile manager, the help and bulk-import modals, the waveform
trimmer — are cached without being named anywhere.

Measured against a current build that reaches 37 assets in three rounds. The
only build assets it does not reach are the chunks for `/drive/open` and
`/server/storage`, which need the network to do anything at all, and font
subsets for scripts the page does not use.

## Updates: never mid-show

**A new version never takes over a running page.** The worker does not call
`skipWaiting()`, nothing listens for `controllerchange`, and there is no
"update ready" prompt. All three omissions are deliberate.

A new build installs quietly in the background and waits. It takes over the
next time the app is opened with no tab still holding the old one — for this
app, the next show. Being one version behind for an evening costs nothing;
swapping an app's code under a live board, or throwing a dialog during a cue,
could cost the performance.

`sw.js` is byte-identical between deploys, so nothing in the file itself would
tell a browser a new version exists. The registration URL therefore carries the
build id from `src/generated/build-info.json`
(`/sw.js?build=<commit>-<buildDate>`, see `src/lib/serviceWorker/register.ts`).
That changed URL is what triggers the update check, and it doubles as the cache
version: one cache set per build, older ones deleted on activate, so storage
stays bounded and the cache always holds one coherent build rather than a
sediment of several.

**If a client seems stuck on an old build**, it is almost always a tab that has
never been closed. Closing every tab of the app and reopening is the supported
fix. Failing that, the browser's "Update on reload" / unregister controls under
devtools → Application → Service Workers.

## Development

The worker registers **in production builds only**, and `next dev` actively
unregisters anything already there and deletes the `impamp-*` caches.

Both halves matter. Turbopack moves chunk URLs on every edit, so a cache-first
worker would serve a developer their own stale bundle. And a registration
outlives the server that created it while being scoped to an origin, not a
server — so one `npm start` on port 3000 would otherwise haunt `npm run dev` on
the same port indefinitely. The unregister is what stops that.

To exercise the worker locally you therefore need a production build:

```bash
npm run build
npm start
```

The Playwright suite runs against a production build already, so it exercises
the worker exactly as a deploy does.

## Tests

`e2e-tests/offline.spec.ts`. Every test cuts the network with
`context.setOffline(true)` and then uses the app; none of them assert that a
registration happened, because that is the thing that was true for a year while
the feature did not exist.

- The board loads, switches banks and **plays a pad** with no network.
- A screen never opened while online — the profile manager — still opens
  offline, which is the test for the asset-graph walk specifically.
- No cache holds any URL under `/api`, and offline a request to one fails.

Each was checked by breaking what it is meant to catch. Two did not catch it at
first; see the commit message on `e2e-tests/offline.spec.ts` for what changed
and why. If you modify the caching strategy, re-do that: run the suite against
a deliberately broken worker and confirm it goes red.
