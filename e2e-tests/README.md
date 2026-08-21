# End-to-end tests

Playwright specs covering audio playback, profiles, edit mode, keyboard
shortcuts, search, arming and sync refresh — plus server sync, the sync panel,
following, borrowed Drive links, loudness and gain, pad disabling, bulk import,
upload rollback and import defaults. (The first list was the whole of this
paragraph for a long time, while more than half the suite went undescribed.)

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

None. The chromium suite is 177/177.

This section used to list five, and by the time anyone checked, four of them
described causes that no longer existed in the specs at all — `select#exportProfile`,
`button[aria-label="Remove sound"]` and `[data-testid="prompt-input"]` return no
matches in the files named, because those tests had been rewritten and the table
had not. A "known failures" list nobody re-checks is worse than none: it teaches
you to read a red run as expected.

If something here starts failing, fix it or delete it. If it genuinely has to
stay red for a while, put the reason next to the test with `test.fixme`, where
it cannot rot out of sight of the thing it describes.

Firefox and WebKit have not been run green and are therefore not gated in CI.
