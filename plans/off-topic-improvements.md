# Off-topic improvements

Things noticed while working on other tasks, deliberately left out of scope.
Each entry: what, where, why it matters.

Drained on 2026-08-14 — everything that was here is either landed (see the
`chore/drain-backlog` commits) or listed below because it is genuinely still
open. Deferred dependency upgrades live in `plans/deferred-upgrades.md`, not
here.

## Code

- **The profile selector button has no accessible name of its own.** It is
  labelled only by the active profile's name, so a name-based locator (or a
  screen-reader user) cannot tell it apart from a pad or armed-track button
  whose sound is named similarly — `createAndSwitchToProfile` in the E2E
  helpers has to match it by `aria-haspopup` instead.

- **`ProfileCard`'s "Synced" status can never be seen.** `getSyncStatusDisplay`
  returns "Synced" only when `driveHookStatus === "success"` _and_
  `lastSyncInitiatedByThisCard` — but the flag is cleared on exactly those two
  statuses, "idle" and "success". So the message is unreachable in practice.
  Clearing on "idle" alone looks like the intent. Left alone because it is a UI
  behaviour change rather than a refactor, and the path needs a real Google
  account to exercise (the OAuth origin is `localhost:3000` only, so it cannot
  be checked from a worktree on another port).

## Docs

## Done

- ~~`npm run lint` is broken (`next lint` removed in Next 16)~~ — fixed in
  `c4de6b7`, along with the two unused-import errors it had been hiding.
- ~~The e2e port is hard-coded to 3000~~ — fixed on main in `4508931`.
- ~~No unit-test layer at all~~ — Vitest added in `46c5046`.
- ~~`sharp` carried four libvips CVEs~~ — closed by the 0.35.3 upgrade;
  `npm audit` went from 7 high to 0.
- ~~Four dependencies with no import sites~~ — `uuid`, `@types/uuid` (a
  deprecated stub), `jwt-decode` and `google-api-javascript-client` (an
  abandoned v0.1.0 npm mirror) removed in the dependency-upgrade pass.
- ~~`clearAllArmedTracks` had no callers, so profile switches left stale
  cues armed~~ — wired into `setActiveProfileId`.
