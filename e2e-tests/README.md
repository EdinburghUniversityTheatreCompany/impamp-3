# End-to-end tests

Playwright specs covering audio playback, profiles, edit mode, keyboard
shortcuts, search, arming and sync refresh.

## Running

```bash
npx playwright test --project=chromium      # what CI gates on
npx playwright test                         # all three browsers
E2E_DEV_SERVER=1 npx playwright test        # against `next dev` instead
```

By default the suite builds the app and serves it with `npm start`. This is
deliberate: Turbopack compiles routes on demand, so several browser workers
hitting a cold `next dev` time out on what is really just compilation. Serving
a production build took the chromium run from 22 passed / 10 flaky / 17 failed
to 39 passed / 0 flaky / 10 failed, and roughly halved the wall-clock time.

`NEXT_PUBLIC_GOOGLE_CLIENT_ID` must be set for the production build to
prerender. The config supplies a placeholder when it is unset — no test signs
in to Google.

### Reusing a server hides your changes

Outside CI the config sets `reuseExistingServer: true`, so if anything is
already listening on the port Playwright **skips the whole webServer command**
— including the `npm run build` in it. Two ways that bites:

- **A leftover server serves the old bundle.** The suite runs green (or red)
  against whatever was built the last time a server actually started, and your
  edits are simply not in it. Nothing warns you.
- **A concurrent build pulls the bundle out from under it.** Running
  `npm run build` in another terminal while a server from an earlier run is
  still up replaces `.next` underneath it, and tests then fail on code that is
  demonstrably present in the source _and_ in the bundle on disk.

Either way the fix is to make sure the server you are testing was built from
the current tree:

```bash
scripts/e2e-server.sh 3100      # kills the old server, rebuilds, restarts
E2E_PORT=3100 npx playwright test --project=chromium
```

`scripts/e2e-server.sh` exists for exactly this: it frees the port first (only
killing a server serving _this_ checkout), rebuilds, and waits for `/up`. When
in doubt, stop the stale server rather than trusting a green run.

## Known failures

CI gates on chromium only. These specs still fail and are **not** regressions
from any recent change — they were already failing before the current round of
merges:

| Spec                                                                                                                         | Why                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audio-playback.spec.ts` — multi-sound modes (sequential / random / round-robin), "prevents dropping onto pad with >1 sound" | Pads never end up with 2+ sounds; needs investigation of the add-sounds-then-save path.                                                                                                                                       |
| `backup-reminders.spec.ts` — "Never" setting, setting change, disappears after export                                        | Drive an export via `select#exportProfile`, which no longer exists: the export UI was rewritten in #71 (streaming ZIP + progress). Specs need rewriting against the new flow.                                                 |
| `edit-mode.spec.ts` — "X button / Delete+click opens modal for multi-sound pad"                                              | Asserts `button[aria-label="Remove sound"]` on a pad. That affordance is gone; removal now lives behind the "delete and move mode" toggle. Needs a product decision on the intended interaction before the spec is rewritten. |
| `profiles.spec.ts` — "Can create a new profile and switch to it"                                                             | Waits on `[data-testid="prompt-input"]`; the create-profile flow appears to have changed.                                                                                                                                     |
| `sync-refresh.spec.ts` — pad grid updates when sync writes new data                                                          | Times out.                                                                                                                                                                                                                    |

Firefox and WebKit have not been run green and are therefore not gated in CI.
