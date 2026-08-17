# Review 2026-08-17 — dead code, leftovers and duplication

Repo at `/home/mick/Stack/Programmeren/impamp-2`, branch `main`, HEAD `b29585b`
("Merge fix/repo-review: the whole-repo review, fixed"). Baseline
`npx tsc --noEmit` exits 0, so everything below is measured against a tree that
compiles.

**Headline:** the fix pass genuinely deleted 560 lines of dead code and
extracted six shared helpers, and most of the L1/L2/L3/L4/L7/L8 leftovers are
gone. What it did _not_ do is finish the extractions. Four of the helpers it
created (`triggerPad`, `syncReplay`, `parseJsonBody`, `useRemoteList`) sit next
to un-migrated copies of the very rule they exist to own — and in two cases the
copies have already drifted from the helper. That is the repo's signature
failure mode reappearing one commit after it was named.

The one 🔴 is not a duplication at all: the PWA the README and CLAUDE.md
describe does not exist. Its service worker has never been registered.

---

### 🔴 D1 — The service worker is never registered, so the "offline-first PWA" the docs promise does not exist

- **Class:** NEW
- **Where:** `public/sw.js` (5.5 KB), `public/offline.html`, `public/manifest.json`; claimed by `README.md:25,165-174` and `CLAUDE.md:105,202`
- **Finding:** nothing in the app registers the service worker. There is no
  `navigator.serviceWorker` call anywhere, and `layout.tsx` neither imports nor
  references `sw.js`:

  ```
  $ rg -n 'sw\.js|serviceWorker' src
  (no output)

  $ rg -n 'navigator\.' src
  src/hooks/useGoogleDriveSync.ts:344:      if (typeof navigator !== "undefined" && navigator.onLine === false)
  src/components/profiles/SharingPanel.tsx:110:    await navigator.clipboard.writeText(shareUrl);
  src/components/profiles/ServerSharingPanel.tsx:99:    await navigator.clipboard.writeText(
  src/lib/audio/preloader.ts:398:      typeof navigator !== "undefined" && navigator.hardwareConcurrency
  src/lib/audio/cache.ts:24:// Type extension for navigator.deviceMemory
  ```

  `public/offline.html` is referenced only from inside `public/sw.js`'s
  `STATIC_ASSETS` list, so it is unreachable too. The only other mention of the
  file in the repo is an eslint ignore entry for it (`eslint.config.mjs:18`) —
  i.e. the lint config is configured to look away from a file that never runs.

  Meanwhile `README.md:25` states "**Offline-First PWA**: Operates fully offline
  after initial load using PWA techniques" and `README.md:170-171` "Works offline
  after the initial load / Caches audio files for offline playback".

- **Impact:** this is a soundboard for live performance. A user who reads the
  README and plans to run a show on a laptop with no network gets a blank page,
  not a cached app. The dead 5.5 KB is trivial; the documentation asserting it
  works is the harm. It is also the reason nobody noticed — the code exists, so
  a reader checking "is there a service worker?" finds one.
- **Fix:** decide, then make the repo say the same thing twice. Either register
  it (a `useEffect` in `ClientLayout` calling
  `navigator.serviceWorker.register("/sw.js")`, plus an e2e assertion that the
  registration lands, because an unregistered SW is invisible), or delete
  `public/sw.js`, `public/offline.html` and the `eslint.config.mjs:18` ignore
  and strike the offline claims from `README.md:25,165-174` and
  `CLAUDE.md:105,202`.

---

### 🟡 D2 — "Build a Drive token from the store" is written four times and "apply a refreshed token" three times; they have already drifted on `needsReauth`

- **Class:** RECURRENCE (D10's `currentDriveToken` bullet), now worse
- **Where:** `src/hooks/useGoogleDriveSync.ts:262-289` (two copies in one file) · `src/hooks/useProfileSync.ts:326-334` · `src/hooks/useServerSync.ts:287-295`; the refresh handler at `useGoogleDriveSync.ts:305-324`, `useProfileSync.ts:336-344`, `useServerSync.ts:211-220`
- **Finding:**

  ```
  $ rg -n 'accessToken:.*googleAccessToken|expiresAt: .*tokenExpiresAt' src
  src/hooks/useGoogleDriveSync.ts:267:      accessToken: authState.googleAccessToken,
  src/hooks/useGoogleDriveSync.ts:269:      expiresAt: authState.tokenExpiresAt || 0,
  src/hooks/useGoogleDriveSync.ts:286:      accessToken: s.googleAccessToken,
  src/hooks/useGoogleDriveSync.ts:288:      expiresAt: s.tokenExpiresAt || 0,
  src/hooks/useProfileSync.ts:330:    accessToken: s.googleAccessToken,
  src/hooks/useProfileSync.ts:332:    expiresAt: s.tokenExpiresAt || 0,
  src/hooks/useServerSync.ts:291:    accessToken: state.googleAccessToken,
  src/hooks/useServerSync.ts:293:    expiresAt: state.tokenExpiresAt || 0,
  ```

  `useProfileSync.ts:326` and `useServerSync.ts:287` are the _same function_,
  same name, byte-identical apart from the local being called `s` vs `state` —
  eight lines, so comfortably under jscpd's 50-token floor. **The
  `useProfileSync` copy carries the explanatory comment** ("The Drive token as
  it is _now_, not as it was when this hook last rendered"); the `useServerSync`
  copy has none.

  The refresh side has already drifted. `useGoogleDriveSync.ts:318` clears the
  re-auth prompt after a successful refresh:

  ```ts
  useProfileStore.setState({ needsReauth: false });
  ```

  Neither `useProfileSync.ts:336-344` nor the inline copy at
  `useServerSync.ts:211-220` does. Both call `setGoogleAuthDetails` with the same
  four arguments and stop there.

- **Impact:** a token refreshed _during a sync_ (either sync path) leaves
  `needsReauth: true` set, so the user keeps being told to sign in again on a
  session that just successfully refreshed. Only a refresh through the polling
  path in `useGoogleDriveSync` clears it. Any future change to how a token is
  assembled or applied has to be made in four and three places respectively.
- **Fix:** one `src/lib/googleAuth.ts` (or a slice of the existing
  `authUtils.ts`) exporting `currentDriveToken(): TokenInfo | null` and
  `applyRefreshedToken(token: TokenInfo): void`, the latter owning the
  `needsReauth: false` reset. All seven sites call it. `useGoogleDriveSync`'s
  render-time `currentTokenInfo` memo can stay as the render-safe read, but
  should be built by calling the shared function.

### 🟡 D3 — `triggerPad` was extracted to be the one way to trigger a pad; `useKeyboardListener` still has two hand-written copies, and they have drifted from it

- **Class:** REGRESSION (of the fix pass's own `4540062`)
- **Where:** `src/lib/audio/triggerPad.ts:63` (the helper) vs `src/hooks/useKeyboardListener.ts:128-176` (`playEmergencySound`) and `src/hooks/useKeyboardListener.ts:608-660` (the keyboard pad trigger)
- **Finding:** `triggerPad.ts:1-13` states the problem it was created to fix:
  "three call sites — `usePadInteractions`, the search modal and the armed-track
  player in `playbackStore` — each built the same four by hand, each recomputing
  `generatePadLoadingKey(profileId, pageIndex, padIndex)` inside every one of
  them." Those three were migrated. There were five:

  ```
  $ rg -n 'generatePadLoadingKey' src --glob '!*.test.*'
  src/store/loadingStore.ts:55:export function generatePadLoadingKey(
  src/store/loadingStore.ts:71:    const key = generatePadLoadingKey(profileId, pageIndex, padIndex);
  src/hooks/useKeyboardListener.ts:19:  generatePadLoadingKey,
  src/hooks/useKeyboardListener.ts:148:      const loadingKey = generatePadLoadingKey(
  src/hooks/useKeyboardListener.ts:159:      const loadingKey = generatePadLoadingKey(
  src/hooks/useKeyboardListener.ts:171:      const loadingKey = generatePadLoadingKey(
  src/hooks/useKeyboardListener.ts:628:            const loadingKey = generatePadLoadingKey(
  src/hooks/useKeyboardListener.ts:640:            const loadingKey = generatePadLoadingKey(
  src/hooks/useKeyboardListener.ts:653:            const loadingKey = generatePadLoadingKey(
  src/lib/audio/triggerPad.ts:71:  const loadingKey = generatePadLoadingKey(
  ```

  Six more recomputations of the key inside individual callbacks, in exactly the
  shape the helper's doc comment describes as the bug. **The helper carries the
  careful comment** ("The loading key is computed once here rather than in each
  callback, and cleared on both success and failure — a pad left in its loading
  state after an error is the failure mode the three hand-written copies each
  had to remember to avoid"); the two keyboard copies do not.

  Concrete drift already present: `triggerPad.ts:86` passes
  `isDisabled: pad.isDisabled` down to `triggerAudioForPadInstant`, which gates
  on it at `controls.ts:293`. Neither keyboard copy passes it. Both happen to be
  safe today only because they filter separately and earlier —
  `useKeyboardListener.ts:86` for emergency sounds and
  `useKeyboardListener.ts:573` for the keyboard trigger — which is a third and
  fourth copy of the "a disabled pad must not fire" rule (the others live at
  `controls.ts:293`, `usePadInteractions.ts:259,299` and `SearchModal.tsx:138`).

- **Impact:** the loading-state contract now has three authors. A future change
  to how loading is reported (or to `TriggerablePad`) reaches the click, search
  and armed paths and silently skips the keyboard and emergency paths — which
  are the paths a live operator actually uses.
- **Fix:** route both keyboard call sites through `triggerPad`, passing
  `{ logPrefix: "[KeyboardListener]" }` and, for `playEmergencySound`, the
  emergency pad's own `{ activeProfileId: sound.profileId, currentPageIndex:
sound.pageIndex }` context. That deletes ~90 lines and both remaining
  `generatePadLoadingKey` clusters.

### 🟡 D4 — `parseJsonBody` was un-exported rather than adopted, while five routes re-inline it

- **Class:** REGRESSION
- **Where:** `src/lib/server/audioRequests.ts:182-191` (now private) vs `src/app/api/admin/users/[id]/route.ts:37-42`, `src/app/api/test/session/route.ts:36-41`, `src/app/api/profiles/[id]/shares/route.ts:67-72`, `src/app/api/auth/google/exchange/route.ts:31-40`, `src/app/api/auth/google/refresh/route.ts:33-42`
- **Finding:** the previous review said, verbatim: "Note `parseJsonBody` is dead
  **while three routes re-inline what it does** — see D10." The fix pass
  responded by removing the `export`:

  ```
  $ git show bc70ec8 -- src/lib/server/audioRequests.ts
  -export async function parseJsonBody<T extends object>(
  +async function parseJsonBody<T extends object>(
  ```

  There are now five re-inlined copies, not three:

  ```
  $ rg -n -B2 -A4 'await request\.json\(\)' src/app --glob '*.ts'
  src/app/api/admin/users/[id]/route.ts-38-  try {
  src/app/api/admin/users/[id]/route.ts:39:    body = await request.json();
  src/app/api/admin/users/[id]/route.ts-40-  } catch {
  src/app/api/admin/users/[id]/route.ts-41-    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  ... (same five-line shape in test/session, profiles/[id]/shares,
      auth/google/exchange, auth/google/refresh)
  ```

- **Impact:** the un-export is worse than leaving it exported, because the next
  reader grepping for a shared body parser finds nothing and writes a sixth
  copy. Three of the five already return the identical string `"Invalid JSON
body"`; the two auth routes return a different message, so the API's error
  vocabulary is already inconsistent for the same failure.
- **Fix:** move `parseJsonBody` out of `audioRequests.ts` into
  `src/lib/server/apiAuth.ts` (or a new `requestBody.ts`), export it, and have
  all five routes call it. `audioRequests.ts:233` already does.

### 🟡 D5 — `syncReplay.ts` extracted the replay and the fan-out but left the coalescing wrapper written twice

- **Class:** REGRESSION
- **Where:** `src/lib/googleDrive/sync.ts:500-538` (`syncProfile`) and `src/lib/serverSync/sync.ts:113-142` (`syncServerProfile`)
- **Finding:** `syncReplay.ts:11-13` says why it exists: "Shared rather than
  written once per backend, because writing it twice is how this codebase
  produces bugs: jscpd refused the commit that had two copies of it, which is
  exactly what that gate is for." The wrapper _around_ those two shared calls is
  still two copies with the same six steps in the same order — join-or-start,
  add to listener set, replay on join, build the fan-out, run, delete both maps
  in `finally`:

  ```
  # googleDrive/sync.ts:506               # serverSync/sync.ts:119
  const inFlight = inFlightSyncs.get(id)  const running = inFlight.get(profileId)
  listeners?.add(callbacks)               listeners?.add(callbacks)
  return inFlight.then((result) => {      return running.then((result) => {
    listeners?.delete(callbacks)            listeners?.delete(callbacks)
    replaySyncOutcome(result, callbacks)    replaySyncOutcome(result, callbacks)
  const listeners = new Set([callbacks])  const listeners = new Set([callbacks])
  inFlightListeners.set(profileId, ...)   inFlightListeners.set(profileId, ...)
  const fanOut = fanOutSyncCallbacks(...)  const fanOut = fanOutSyncCallbacks(...)
  .finally(() => { delete; delete })      .finally(() => { delete; delete })
  ```

  jscpd misses it because the two maps have different names and different generic
  parameters. The comment "The run reports to whoever is waiting at the time, not
  only to whoever started it" is duplicated verbatim in both.

- **Impact:** the whole point of `syncReplay.ts` was that this coalescing
  protocol is where the "joiner never hears the outcome" bug lived — a bug the
  server backend had and Drive did not, precisely because it was two copies. The
  registration half is still two copies, so the next asymmetry lands the same way
  (e.g. an eviction on abort, or a per-profile timeout, added to one map pair
  only).
- **Fix:** add `coalesceSyncRun<R, C>(registry, profileId, callbacks, start)` to
  `syncReplay.ts`, where `registry` bundles the two maps. Both entry points
  become four lines.

### 🟡 D6 — "Does this profile hold someone else's Drive ids?" is decided by two rules that disagree, and a third comment claims they cannot

- **Class:** NEW
- **Where:** `src/lib/syncState.ts:190-192` (via `resolveOwnership` at `:148-164`) and `src/lib/syncReconcile.ts:35-46`
- **Finding:** two independent predicates over the same question.

  ```
  # syncState.ts:190 — raises the "borrowed-drive-folder" defect
  if (target === "server" && ownership === "collaborator" && hasDriveIds)

  # syncReconcile.ts:35 — decides what the automatic sweep clears
  profile.syncType === "server" &&
  Boolean(profile.serverShareToken) &&
  profile.serverRole !== "owner" &&
  Boolean(profile.googleDriveFileId || profile.googleDriveFolderId)
  ```

  `resolveOwnership` returns `"collaborator"` for `serverRole === "editor"` with
  no share token (`syncState.ts:155-157`). `hasBorrowedDriveLink` returns `false`
  for that same profile, because it requires a `serverShareToken`. Both copies
  carry a careful comment defending their own choice — `syncReconcile.ts:19-21`
  ("An email-invited editor has no token and is deliberately left alone") and
  `syncState.ts:158-161` ("It misses an email-invited editor, who has no token —
  which is exactly why `serverRole` is preferred above") — i.e. the two modules
  read the same evidence and made opposite calls, each documented, neither aware
  the other exists.

  A third place asserts they agree. `SyncDefectBanner.tsx:12-15`: "with the
  exception of borrowed Drive ids, which are provably not this device's and are
  cleared on load (see `lib/syncReconcile.ts`)." And `borrowed-drive-folder` is
  deliberately absent from the banner's `FIXABLE` map (`:38-41`), so it gets no
  repair button.

- **Impact:** an email-invited editor whose profile carries Drive ids sees a
  permanent amber banner — "This profile still points at the Google Drive folder
  of whoever shared it. Sounds you add cannot be published there." — with no
  button, and an automatic sweep that has decided not to touch it. The one defect
  the UI declines to offer a fix for is the one the sweep declines to fix.
- **Fix:** one exported predicate. Either `hasBorrowedDriveLink` calls
  `getSyncState(profile).defects.includes("borrowed-drive-folder")`, or
  `detectDefects` calls `hasBorrowedDriveLink`. Whichever direction, the choice
  about the email-invited editor gets made once, and the `SyncDefectBanner`
  comment becomes true.

### 🟡 D7 — `getHashlessIndex` is still two copies, and a server sync still builds both

- **Class:** RECURRENCE (D7 of 2026-08-15; `.claude/current_plan.md:71-73` records it as knowingly unfinished)
- **Where:** `src/lib/googleDrive/sync.ts:313-325` and `src/lib/serverAudio/transfer.ts:258-269`
- **Finding:**

  ```
  $ rg -n 'getHashlessIndex' src
  src/lib/serverAudio/transfer.ts:258:  const getHashlessIndex = async (): Promise<Map<string, number>> => {
  src/lib/serverAudio/transfer.ts:271:    if ((await getHashlessIndex()).has(ref.hash)) continue;
  src/lib/googleDrive/sync.ts:313:  const getHashlessIndex = async (): Promise<Map<string, number>> => {
  src/lib/googleDrive/sync.ts:336:      const localId = (await getHashlessIndex()).get(ref.hash);
  ```

  Same six statements: memoise, `getDb()`, `getAllKeys("audioFiles")`,
  `ensureAudioFileHash` per id, set, return. The only differences are the loop
  variable name (`computed` vs `computedHash`) and whether `getAllKeys` is
  hoisted into a local — enough to slip under jscpd. **The Drive copy carries the
  fuller comment** ("the blobs are read one at a time so the whole audio library
  never sits in memory at once"); the `serverAudio` copy has a shorter one and
  does not mention the memory property.

  `serverSync/sync.ts:35-42` imports `downloadMissingAudioFiles` _and_
  `downloadProfileAudio`, so a server sync on a Wasabi deployment can build both
  indexes, hashing the whole local library twice.

- **Impact:** the two lazy indexes cannot be shared or capped together, and the
  memory constraint is documented in only one of them.
- **Fix:** `ensureHashIndex()` in `src/lib/db.ts` (next to `ensureAudioFileHash`),
  memoised per-process, bounded to the hashes actually asked for. Both call sites
  use it.

### 🟡 D8 — Two PWA manifests, drifted, and the stale one points at icons that do not exist

- **Class:** NEW
- **Where:** `src/app/manifest.ts` (Next's app-router manifest, served) and `public/manifest.json` (orphan, served at `/manifest.json`)
- **Finding:** both describe the same app; they no longer agree.

  | key                | `src/app/manifest.ts` | `public/manifest.json` |
  | ------------------ | --------------------- | ---------------------- |
  | `background_color` | `#000000`             | `#ffffff`              |
  | `theme_color`      | `#f2801f`             | `#000000`              |
  | `purpose`          | `"any"`               | `"any maskable"`       |
  | icons              | 6 sizes               | 8 sizes                |

  Two of the JSON copy's icons do not exist on disk:

  ```
  $ find public/icons -type f
  public/icons/icon.svg
  public/icons/icon-512x512.png
  public/icons/icon-384x384.png
  public/icons/icon-72x72.png
  public/icons/icon-96x96.png
  public/icons/icon-48x48.png
  public/icons/icon-192x192.png
  public/icons/icon-128x128.png
  ```

  `icon-144x144.png` and `icon-152x152.png` are referenced by
  `public/manifest.json:32-45` and are absent. They would have come from
  `scripts/generate-icons.js:10` (`const sizes = [72, 96, 128, 144, 152, 192,
384, 512]`) — see D14, that script is itself dead.

- **Impact:** whichever manifest a tool picks up decides the install icon and
  splash colour, and they give different answers. An install prompt driven by
  `/manifest.json` 404s on two icons. And the theme colour a maintainer edits is
  a coin flip — `layout.tsx:30`'s `viewport.themeColor` is a _third_ value
  (`#000000`), so the app currently declares three different theme colours.
- **Fix:** delete `public/manifest.json`. Reconcile `themeColor` in
  `layout.tsx:30` with `theme_color` in `src/app/manifest.ts` (pick `#f2801f`;
  it is the only one that is a brand colour rather than a default). Add
  `icon-144x144.png` and `icon-152x152.png` to `src/app/manifest.ts` only if they
  are generated first.

### 🟡 D9 — The pad-save sequence is still open-coded at five sites, plus two variants that omit part of it

- **Class:** RECURRENCE (D6; `.claude/current_plan.md:79-81` records 4.2 as only half done)
- **Where:** `src/hooks/pad/usePadDrop.ts:82-105` · `src/hooks/pad/usePadInteractions.ts:112-141` · `src/hooks/pad/usePadInteractions.ts:197-220` · `src/hooks/pad/usePadSwap.ts:75-95` · `src/components/PadGrid.tsx:341-353`; variants at `src/components/modals/LoudnessOverviewModalContent.tsx:294-318` and `src/components/modals/BulkImportModalContent.tsx:323-337`
- **Finding:** the sequence "write the pad → `refreshPadConfigs()` →
  `requestSync(profileId)` → `if (await isEmergencyPage(...))
  incrementEmergencySoundsVersion()" appears five times:

  ```
  $ rg -n 'isEmergencyPage|incrementEmergencySoundsVersion' src --glob '!*.test.*' | rg ':[0-9]+: *(const isEmergency|if \(await isEmergencyPage|isEmergencyPage\()'
  src/hooks/pad/usePadInteractions.ts:140:          if (await isEmergencyPage(activeProfileId, currentPageIndex)) {
  src/hooks/pad/usePadInteractions.ts:211:          const isEmergency = await isEmergencyPage(
  src/hooks/pad/usePadSwap.ts:89:        const isEmergency = await isEmergencyPage(
  src/hooks/pad/usePadDrop.ts:98:        const isEmergency = await isEmergencyPage(
  src/components/PadGrid.tsx:345:          isEmergencyPage(activeProfileId, currentPageIndex).then(
  ```

  Three of the five wrap it in a `console.log` with different wording ("updated
  after drop", "Pad removed on emergency page", "updated after bulk import"); two
  log nothing. `PadGrid.tsx:345` is the only one that does not `await` — it fires
  a floating `.then()`.

  The two variants differ in substance: `LoudnessOverviewModalContent.tsx:317-318`
  calls `incrementPadConfigsVersion()` + `requestSync()` but never
  `refreshPadConfigs()` and never checks the emergency page;
  `BulkImportModalContent.tsx:337` calls only `requestSync`, delegating the rest
  to `PadGrid`'s `onAssignmentComplete` callback.

- **Impact:** C4 was exactly this shape — one write path invalidating one of the
  three caches. It was fixed by making `refreshPadConfigs` bump the shared
  counter, which removed one of the four steps from the "must remember" list but
  left the other three. The next write path (or the next step added to the
  sequence) has five places to reach and two half-implementations to notice.
- **Fix:** the `savePadConfiguration()` the previous review specified —
  `{ profileId, pageIndex, padIndex, ... }` in, upsert + `refreshPadConfigs` +
  `requestSync` + emergency check out — living next to `upsertPadConfiguration`
  in a hook (it needs store access) such as `usePadPersistence`.

### 🟡 D10 — `NEXT_PUBLIC_GOOGLE_APP_ID` is read but set nowhere, and `NEXT_PUBLIC_GOOGLE_API_KEY` is set only at runtime, where a client bundle cannot see it

- **Class:** NEW
- **Where:** `src/components/profiles/ProfileManager.tsx:1113` and `:1115`; `config/deploy.yml:58`; `Dockerfile:20-22`
- **Finding:**

  ```
  $ rg -n 'NEXT_PUBLIC_GOOGLE_APP_ID|NEXT_PUBLIC_GOOGLE_API_KEY' . --no-ignore -g '!node_modules' -g '!.git' -g '!*.tsbuildinfo'
  ./config/deploy.yml:58:    NEXT_PUBLIC_GOOGLE_API_KEY: $NEXT_PUBLIC_GOOGLE_FILE_PICKER_API_KEY
  ./src/components/profiles/ProfileManager.tsx:1113:  app-id={process.env.NEXT_PUBLIC_GOOGLE_APP_ID}
  ./src/components/profiles/ProfileManager.tsx:1115:  process.env.NEXT_PUBLIC_GOOGLE_API_KEY

  $ rg -n 'ARG|ENV' Dockerfile
  6:ARG NODE_VERSION=24.19.0
  20:ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
  22:ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
  ```

  `NEXT_PUBLIC_GOOGLE_APP_ID` has exactly one occurrence in the whole repo: the
  read. There is no fnox key, no `deploy.yml` entry, no Dockerfile ARG.

  `NEXT_PUBLIC_GOOGLE_API_KEY` is set, but in `deploy.yml`'s `env.clear:` block —
  a container _runtime_ variable. `ProfileManager.tsx:1` is `"use client"`, and
  Next inlines `NEXT_PUBLIC_*` into the client bundle at build time; only
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID` is passed as a build arg (`deploy.yml:48`,
  `Dockerfile:20`). So the runtime value never reaches the browser either.

- **Impact:** in the deployed image the Drive Picker element is rendered with
  `app-id={undefined}` and `developer-key={undefined}`. The `deploy.yml:58`
  entry looks like configuration and is inert — the exact "config key nothing
  reads" shape. Not verified against the live deployment; verified from the build
  inputs.
- **Fix:** add both to `Dockerfile` as `ARG`/`ENV` alongside
  `NEXT_PUBLIC_GOOGLE_CLIENT_ID`, pass them through `deploy.yml`'s
  `builder.args`, and add `NEXT_PUBLIC_GOOGLE_APP_ID` to `fnox.toml`. Then move
  the `env.clear:` entry for the API key out, since it does nothing there. If the
  app id genuinely is not needed, delete the read at `:1113`.

### 🟡 D11 — `SPECIAL_PAD_INDICES` and `MS_IN_DAY` are each recomputed rather than shared

- **Class:** RECURRENCE (D10)
- **Where:** `src/components/PadGrid.tsx:38-41` vs `src/components/modals/BulkImportModalContent.tsx:10-13`; `src/hooks/useProfileEdit.ts:37-38`, `src/components/profiles/ProfileEditForm.tsx:24`, `src/components/profiles/ProfileCard.tsx:29`
- **Finding:**

  ```
  # PadGrid.tsx:38 — derived from SPECIAL_PAD_CONFIG
  const SPECIAL_PAD_INDICES = [
    SPECIAL_PAD_CONFIG.STOP_ALL.index,
    SPECIAL_PAD_CONFIG.FADE_OUT_ALL.index,
  ];

  # BulkImportModalContent.tsx:10 — the arithmetic written out again
  const SPECIAL_PAD_INDICES = [
    1 * GRID_COLS + (GRID_COLS - 1), // Stop All (Row 2, last col)
    2 * GRID_COLS + (GRID_COLS - 1), // Fade Out All (Row 3, last col)
  ];
  ```

  Move a special pad in `SPECIAL_PAD_CONFIG` and bulk import starts happily
  assigning audio to it.

  ```
  $ rg -n 'MS_IN_DAY|DEFAULT_BACKUP_REMINDER' src --glob '!*.test.*'
  src/hooks/useProfileEdit.ts:37:    const MS_IN_DAY = 1000 * 60 * 60 * 24;
  src/hooks/useProfileEdit.ts:38:    const DEFAULT_REMINDER_PERIOD = 30 * MS_IN_DAY;
  src/components/profiles/ProfileEditForm.tsx:24:  const MS_IN_DAY = 1000 * 60 * 60 * 24;
  src/components/profiles/ProfileCard.tsx:29:const MS_IN_DAY = 1000 * 60 * 60 * 24;
  src/lib/db.ts:177:export const DEFAULT_BACKUP_REMINDER_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
  ```

  `useProfileEdit.ts:38` re-derives the default reminder period as `30 *
MS_IN_DAY` inside a function body, while `db.ts:177` already exports exactly
  that value and `ProfileCard.tsx:9` imports it.

- **Impact:** the special-pad one is the drift risk (two answers to "which pads
  are reserved"). `MS_IN_DAY` is cosmetic, but the re-derived 30-day default is
  not: change `DEFAULT_BACKUP_REMINDER_PERIOD_MS` and the edit dialog keeps
  pre-filling 30.
- **Fix:** export `SPECIAL_PAD_CONFIG` / `SPECIAL_PAD_INDICES` from
  `src/lib/constants.ts` (which already owns `GRID_COLS`); add `MS_IN_DAY` there
  too; `useProfileEdit.ts` imports `DEFAULT_BACKUP_REMINDER_PERIOD_MS`.

### 🟡 D12 — The admin gate is copied verbatim across both admin routes

- **Class:** RECURRENCE (D10)
- **Where:** `src/app/api/admin/audio/route.ts:15-20` and `src/app/api/admin/users/[id]/route.ts:23-30`
- **Finding:**

  ```
  $ rg -n 'is_admin !== 1' src
  src/app/api/admin/users/[id]/route.ts:25:  if (admin.is_admin !== 1) {
  src/app/api/admin/audio/route.ts:18:  if (user.is_admin !== 1) {
  ```

  Both are the same four lines — `requireUser` → `instanceof NextResponse` →
  `is_admin !== 1` → 404-not-403 — differing only in the local's name. The
  "answer 404 rather than 403 so the existence of an admin surface isn't
  advertised" reasoning is written out in both route doc comments.

- **Impact:** an authorisation rule with two authors. A third admin route will be
  written by copying whichever one the author opened, and a change to the policy
  (e.g. audit logging on admin access, or moving off `is_admin` to a role) has to
  find both. `apiAuth.ts` already owns `requireUser`, so the natural home exists.
- **Fix:** `requireAdmin(request): AuthorizedRequest | NextResponse` in
  `src/lib/server/apiAuth.ts`, carrying the 404 comment. Both routes become one
  line.

### 🟡 D13 — `Pad` still takes `isConfigured` and `soundCount`, which mean the same thing and are made to disagree on purpose

- **Class:** RECURRENCE (L4, fourth bullet — the one bullet of L4 the fix pass did not take)
- **Where:** `src/components/Pad.tsx:18-19`; supplied by `src/components/PadGrid.tsx:118-119` and `:383-384`, `:406-407`
- **Finding:**

  ```
  $ rg -n 'isConfigured' src/components/PadGrid.tsx
  118:        isConfigured={soundCount > 0}
  119:        soundCount={soundCount}
  383:            isConfigured={true} // Special pads are always "configured"
  384:            soundCount={2} // Treat special pads as having multiple sounds to disable drop logic
  406:            isConfigured={true} // Special pads are always "configured"
  407:            soundCount={2} // Treat special pads as having multiple sounds to disable drop logic
  ```

  For a normal pad `isConfigured` is defined as `soundCount > 0`. For the two
  special pads it is faked, and `soundCount` is set to a lie (`2`) to make an
  unrelated rule (`isDropDisabled = soundCount > 1`, `Pad.tsx:172`) come out
  right. `Pad.tsx` then reads them independently in nine places, including
  `Pad.tsx:312` (`isConfigured && onCtrlClick && soundCount > 0` — belt and
  braces for a condition that is one condition).

- **Impact:** two props that can disagree, kept in sync by comments. The drop
  rule and the "is this pad empty" rule are entangled, so changing either
  requires knowing the special pads are lying.
- **Fix:** `Pad` takes `soundCount` only, deriving `isConfigured` internally.
  Replace the `soundCount={2}` lie with an explicit `isDropDisabled` prop (or
  reuse the existing `isSpecialPad`, which `PadGrid.tsx:370` already computes).

---

### 🟢 D14 — Nine exports with zero references anywhere in the repo

- **Class:** NEW (three of them created by the fix pass)
- **Where:** listed below
- **Finding:** each of these appears in exactly one file — its own definition —
  and is not used privately within it either. Search over `src`, `e2e-tests`,
  `scripts`, `docs`, `plans`:

  ```
  $ for s in getActivePlaybackKeys useActivePlayback selectModalState \
      generateTimestamp resetLoudnessWorker resetGoogleTokenRefreshState \
      AUDIO_MODULE_VERSION formatAuthError shouldAttemptTokenRefresh; do
      printf "%-32s %s\n" "$s" "$(rg -w "$s" src e2e-tests scripts docs plans -l | tr '\n' ' ')"
    done
  getActivePlaybackKeys            src/lib/audio/playback.ts
  useActivePlayback                src/store/playbackStore.ts
  selectModalState                 plans/repo-review-2026-08-15.md src/store/uiStore.ts
  generateTimestamp                src/lib/syncUtils.ts
  resetLoudnessWorker              plans/review-2026-08-17/audio.md src/lib/audio/loudness/analyseOffThread.ts
  resetGoogleTokenRefreshState     src/hooks/useGoogleDriveSync.ts
  AUDIO_MODULE_VERSION             src/lib/audio/index.ts
  formatAuthError                  src/lib/googleDrive/auth.ts
  shouldAttemptTokenRefresh        src/lib/googleDrive/auth.ts
  ```

  (Only defining files; the two `plans/` hits are review documents.) Line numbers:
  `playback.ts:679`, `playbackStore.ts:226`, `uiStore.ts:50`, `syncUtils.ts:22`,
  `analyseOffThread.ts:114`, `useGoogleDriveSync.ts:144`, `audio/index.ts:48`,
  `auth.ts:105`, `auth.ts:121`.

  Two are worth calling out:

  - **`getActivePlaybackKeys` was reported as deleted and was not.** `bc70ec8`'s
    commit message lists it among the "dead exports and dead surface" it removed.
    What it actually removed was the one-line wrapper `getPlayingAudioKeys` in
    `controls.ts` and the import; the leaf survived at `playback.ts:679`. Same
    shape as the `preloadAudioFiles`/`preloadAudioForPage` chain the same commit
    describes finding — "the leaf looked alive because something still referenced
    it" — except this time the leaf is the survivor.
  - **`resetLoudnessWorker` and `resetGoogleTokenRefreshState` were born dead**,
    added by `3fb5e0a` and `2be7efb` respectively as test seams that no test
    uses. `git log -S` confirms neither has been touched since.

  `selectModalState` was already named in L12 of the previous review ("has no
  consumer") and survived the pass.

- **Impact:** `formatAuthError` and `shouldAttemptTokenRefresh` are genuinely
  unreachable functions, not just over-exported — deleting the `export` would
  make them lint errors. The rest are surface, but `AUDIO_MODULE_VERSION = "1.0.0"`
  in the module's public API is actively misleading: it advertises a version
  contract nothing checks.
- **Fix:** delete `formatAuthError`, `shouldAttemptTokenRefresh`,
  `getActivePlaybackKeys`, `useActivePlayback`, `selectModalState`,
  `generateTimestamp` (it is `Date.now()` with a docstring) and
  `AUDIO_MODULE_VERSION` outright. Keep `resetLoudnessWorker` and
  `resetGoogleTokenRefreshState` **only if** a test is written that calls them in
  the same commit; otherwise delete those too.

### 🟢 D15 — Three unreachable guards left behind by the fix pass's own refactors

- **Class:** REGRESSION
- **Where:** `src/components/profiles/ProfileManager.tsx:575-577` · `src/hooks/useKeyboardListener.ts:352-358` (with `:196` and `:677`)
- **Finding:**

  1. `a0b0004` added `ProfileManagerHost`, which renders `<ProfileManager />`
     only when open (`ProfileManagerHost.tsx:39`). `ProfileManager` still
     subscribes to the same flag (`:96`, `:112`) and still bails on it 575 lines
     in:

     ```
     src/components/profiles/ProfileManagerHost.tsx:40:  return isProfileManagerOpen ? <ProfileManager /> : null;
     src/components/profiles/ProfileManager.tsx:575:  if (!isProfileManagerOpen) {
     src/components/profiles/ProfileManager.tsx:576:    return null;
     ```

     The inner branch can no longer be taken. `ProfileManagerHost`'s doc comment
     is even written as an obituary for it — "used to decide it was invisible six
     hundred lines into its own body" — while the decision is still there.

  2. `6a2ce80` added `useIsAnyOverlayOpen`, which ORs in `isSearchModalOpen`
     (`useIsAnyOverlayOpen.ts:33`). `useKeyboardListener.ts:310` returns on it.
     The pre-existing search guard 43 lines later is therefore unreachable:

     ```
     src/hooks/useKeyboardListener.ts:310:      if (isAnyOverlayOpen) {
     src/hooks/useKeyboardListener.ts:311:        return;
     ...
     src/hooks/useKeyboardListener.ts:353:      if (isSearchModalOpen) {
     src/hooks/useKeyboardListener.ts:354:        console.log(
     src/hooks/useKeyboardListener.ts:355:          "[KeyboardListener] Ignoring key press while search modal is open.",
     ```

     `isSearchModalOpen` is still destructured at `:196` and still listed in the
     handler's dependency array at `:677` to feed it.

- **Impact:** the second one is the more expensive: a reader trying to work out
  who owns the keyboard while search is open now finds two answers 43 lines
  apart, and the dead one is the more specific-looking of the two. That is
  precisely the "one rule written twice, one copy gets the fix" trap, in its dead
  form.
- **Fix:** delete `ProfileManager.tsx:575-577` and its `isProfileManagerOpen`
  subscription; delete `useKeyboardListener.ts:352-358`, the `isSearchModalOpen`
  half of the destructure at `:196`, and its dep at `:677`.

### 🟢 D16 — A dead build script that cannot run, and two npm scripts that set an env var nothing reads

- **Class:** NEW
- **Where:** `scripts/generate-icons.js` · `package.json:11-12`
- **Finding:**

  ```
  $ rg -n 'generate-icons' . --no-ignore -g '!node_modules' -g '!.git' -g '!*.tsbuildinfo' | grep -v '^./scripts/'
  (no output)
  ```

  No npm script, no CI step, no docs reference it. It also imports `canvas`
  (`scripts/generate-icons.js:3`), which is not in `package.json` — it would
  throw `ERR_MODULE_NOT_FOUND` on the first line if anything did run it. It is
  the origin of the phantom `icon-144x144.png` / `icon-152x152.png` in D8.

  ```
  $ rg 'BUNDLE_ANALYZE' . --no-ignore -g '!node_modules' -g '!.git'
  ./package.json:    "analyze:server": "BUNDLE_ANALYZE=server npm run build",
  ./package.json:    "analyze:client": "BUNDLE_ANALYZE=client npm run build",
  ```

  `next.config.ts:8` reads `process.env.ANALYZE` only. So `npm run analyze:server`
  and `npm run analyze:client` are plain production builds that produce no
  analysis and no error — they look like they worked.

- **Impact:** small, but `analyze:server` silently succeeding while doing nothing
  is worse than not existing.
- **Fix:** delete `scripts/generate-icons.js` (or add `canvas` and wire it to a
  script — but `generate-favicon.js` already covers the favicon and the PNGs are
  committed). Delete `analyze:server` and `analyze:client`, or make
  `next.config.ts` honour `BUNDLE_ANALYZE`.

### 🟢 D17 — Five unreferenced Next.js starter SVGs

- **Class:** NEW
- **Where:** `public/file.svg`, `public/globe.svg`, `public/next.svg`, `public/window.svg`, `public/vercel.svg`
- **Finding:**

  ```
  $ for f in file.svg globe.svg next.svg window.svg vercel.svg; do
      echo "--- $f"
      rg -l --no-ignore -g '!node_modules' -g '!.git' -g '!public/**' \
             -g '!package-lock.json' -g '!tsconfig.tsbuildinfo' -F "$f" .
    done
  --- file.svg
  --- globe.svg
  --- next.svg
  --- window.svg
  --- vercel.svg
  ```

  Zero references each. These are `create-next-app` template assets, untouched
  since the 8 Apr 2025 scaffold.

- **Impact:** ~3.3 KB shipped in every image and every deploy, and a Vercel logo
  in a repo deployed with Kamal.
- **Fix:** `git rm public/{file,globe,next,window,vercel}.svg`.

### 🟢 D18 — ~864 KB of tracked prose nothing routes a reader to

- **Class:** DEFERRED (L9; `.claude/current_plan.md:193-195` records it as needing Mick's decision)
- **Where:** `docs/original-impamp-code.txt` (616 KB), `docs/superpowers/` (184 KB), `docs/refactoring-plan.md` (28 KB), `SPEC.md` (24 KB), `ui-design-bible.md` (12 KB)
- **Finding:** still exactly as reported. The only inbound references are the
  previous review itself and two build-gate exemptions:

  ```
  $ rg -n 'refactoring-plan|SPEC\.md|ui-design-bible|original-impamp-code|docs/superpowers' \
        README.md CLAUDE.md docs/*.md hk.pkl .github/workflows/*.yml
  hk.pkl:79:    // docs/original-impamp-code.txt is an intentional full-text reference dump of the legacy
  hk.pkl:84:        exclude = List("docs/original-impamp-code.txt")
  .github/workflows/ci.yml:233:          # docs/original-impamp-code.txt is an intentional full-text reference dump of
  .github/workflows/ci.yml:237:            [ "$f" = "docs/original-impamp-code.txt" ] && continue
  ```

  `docs/superpowers/plans/…-loudness-normalisation.md` is referenced only by
  itself. `README.md`'s other links all resolve now — L8 is genuinely fixed.

- **Impact:** `docs/refactoring-plan.md` is the live one: it has a "Progress
  Tracking" section, so an agent or contributor opening it reads it as current
  work when the plan of record is `plans/`.
- **Fix:** your call, unchanged from last time. The cheap half is free of it:
  either delete `docs/refactoring-plan.md` or prepend a two-line "superseded by
  `plans/`, kept for history" header, which removes the only actively misleading
  one without deleting anything you might want.

### 🟢 D19 — Small leftovers

- **Class:** NEW / RECURRENCE
- **Where and finding:**
  - `src/store/playbackStore.ts:4` — `// import { ActiveTrack } from '@/lib/audio'; // Removed unused import`. A commented-out import annotated with the reason it was commented out.
  - `src/hooks/useKeyboardListener.ts:667` — a commented-out `console.log`, preceded by a comment saying it "might be redundant … but can be useful".
  - `e2e-tests/audio-playback.spec.ts:197` — `// TODO: Test fadeout`. The only TODO/FIXME/HACK left in `src` or `e2e-tests`; the pass cleared both `src` ones (L7).
  - `e2e-tests/test-helpers.ts:350` (`getPlayingSoundIndex`) and `:369` (`stopPlayingTrack`) are exported but used only by `triggerAndReadSoundIndex` in the same file — over-exported, not dead. Listed so the next sweep does not report them as dead and delete them.
  - Three declared theme colours for one app: `layout.tsx:30` `#000000`, `src/app/manifest.ts` `#f2801f`, `public/manifest.json` `#000000` (see D8).
- **Fix:** delete the two commented-out lines; either write the fadeout test or
  drop the TODO; drop the `export` from the two e2e helpers.

---

## Verified clean — do not re-report

These were checked against the current tree and hold:

- **Both barrel files are used.** L2 named `src/hooks/modal/index.ts` (deleted)
  and `src/lib/audio/strategies/index.ts` — the latter is now imported by
  `controls.ts:20` (`import { getStrategy } from "./strategies"`). `src/lib/audio/index.ts`
  is imported by six files via `@/lib/audio`, which is why searching only for
  relative paths would "prove" it dead.
- **`SharingPanel` / `ServerSharingPanel` (D4) is adequately resolved.** The
  shared load-and-error rule is `useRemoteList`, called from both. What is left
  duplicated is ~25 lines of invite-form markup, and the two panels' substance
  genuinely differs (public-link access vs share tokens). Not worth another pass.
- **Hash-keyed pad fields are centralised.** The `audioFileIds` → `audioFileHashes`
  / `*ByHash` mapping has one table (`syncUtils.ts:85-87`) and one translation
  site each way; no second copy.
- **All four `exposeE2EHook` hooks are consumed** by `e2e-tests` — none is dead.
- **Every dependency in `package.json` is used**, including `fake-indexeddb`
  (via `src/lib/testSupport/browserGlobals.ts:20`) and `sharp`
  (`scripts/generate-favicon.js`).
- **`README.md`'s links all resolve** (L8 fixed), and `src` has no TODO/FIXME.
- The ~20 exports referenced only by their own tests (`clearAudioBufferPins`,
  `getAudioCacheStats`, `makeApiRequest`, `closeDb`, `proofDigest`, …) are
  legitimate test seams, checked individually. Not dead.

## Still open from 2026-08-15, unchanged and knowingly deferred

Recorded so a third review does not re-derive them as new:

- **D1** (three profile→JSON type declarations): `ProfileExport`
  (`importExport.ts:71`), `ProfileExportLean` (`:1420`), `ProfileSyncData`
  (`syncUtils.ts:360`) all still exist. `profileWire.ts` closed the _leak_; the
  type collapse was explicitly deferred to a phase that did not run
  (`.claude/current_plan.md:52-55`).
- **D8** (four hand-rolled modal overlays): `Modal.tsx:85`, `SearchModal.tsx:153`,
  `WaveformTrimmer.tsx:424`, `ProfileManager.tsx:580` — four independent
  `fixed inset-0 … bg-black/50` containers, still with different z-indexes
  (`z-50`, `z-50`, `z-60`, `z-50`) and still only one of them implementing
  Escape-with-`stopImmediatePropagation`.
- **A1** (`profileStore`, 1161 lines) and **A2** (`ClientSideInitializer`) — both
  deliberately not done, with reasoning at `.claude/current_plan.md:178-190`.
  Neither is a dead-code or duplication finding; noted only so this section is
  complete.
