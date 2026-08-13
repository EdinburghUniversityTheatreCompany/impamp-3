# Off-topic improvements

Things noticed while working on something else. Out of scope at the time they
were spotted; recorded here so they aren't lost.

## ESLint findings, unblocked by repairing `npm run lint` (2026-08-13)

Next 16 removed `next lint`, so `npm run lint` had been failing with "Invalid
project directory provided, no such directory: .../lint" — exiting 0 while
linting nothing. The dependency-upgrade pass repointed the script at `eslint .`
and gave the flat config the ignores `next lint` used to supply implicitly.

That makes the command work again, and it immediately surfaces 7 pre-existing
findings. None are regressions from the upgrade and none are gated by CI or the
hk pre-commit hook (neither runs eslint), so they were left alone:

| File                                           | Finding                                                                                                                          |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `e2e-tests/edit-mode.spec.ts:1`                | `Page` imported but never used                                                                                                   |
| `e2e-tests/edit-mode.spec.ts:14`               | `PlaybackType` imported but never used                                                                                           |
| `next.config.ts:4`                             | `require()` style import forbidden                                                                                               |
| `wallaby.config.js:33`                         | `wallaby` param defined but never used                                                                                           |
| `wallaby.config.js:35`                         | `require()` style import forbidden                                                                                               |
| `src/components/ClientSideInitializer.tsx:249` | `react-hooks/exhaustive-deps`: `debounceTimersRef.current` read in an effect cleanup — copy it into a variable inside the effect |
| `src/hooks/usePadConfigurations.ts:89`         | `react-hooks/exhaustive-deps`: `padConfigsVersion` is an unnecessary `useCallback` dependency                                    |

The two `require()` errors are in config files that legitimately need CJS
interop; they probably want a scoped override in `eslint.config.mjs` rather
than a code change.

### …then 15 more, once eslint-config-next reached 16

The same pass took `eslint-config-next` 15 -> 16, which turns on the React
Compiler-era `react-hooks` rules. Count went 7 -> 22. Every one of these is an
existing code pattern newly flagged, not something the upgrade broke:

| Rule                                   | Sites                                                                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-hooks/set-state-in-effect` (10) | `app/drive/open/page.tsx:133`, `AuthNotification.tsx:137`, `ClientSideInitializer.tsx:55`, `BulkImportModalContent.tsx:68`, `ProfileCard.tsx:258`, `ProfileManager.tsx:288`, `SharingPanel.tsx:63`, `useGoogleDriveSync.ts:210`, `usePadConfigurations.ts:92`, `useSearch.ts:70` |
| `react-hooks/immutability` (2)         | `WaveformTrimmer.tsx:151`, `hooks/pad/usePadInteractions.ts:265`                                                                                                                                                                                                                 |
| `react-hooks/refs` (2)                 | `WaveformTrimmer.tsx:208`, `useKeyboardListener.ts:688`                                                                                                                                                                                                                          |
| `react-hooks/purity` (1)               | `ProfileCard.tsx:495`                                                                                                                                                                                                                                                            |

`set-state-in-effect` dominates and is the one worth a real look: each site is
a state write during an effect, which is the pattern React Compiler will refuse
to optimise. Working through them is a genuine refactor, not a lint sweep.

Worth considering afterwards: add eslint to the hk pre-commit steps and the CI
lint job, so the command that now works is actually enforced. Do the cleanup
first — wiring it up while 17 errors stand would just gate every commit.

## Unused dependencies (2026-08-13)

Spotted while upgrading. Nothing in `src/`, `e2e-tests/` or `scripts/` imports
these, and they are not ambient type packages:

- `uuid` + `@types/uuid` — `@types/uuid` is additionally a deprecated stub;
  uuid has shipped its own types since v9. `uuid` was still carried through
  three majors (11 -> 14) in this pass because removing a dependency is a
  different decision from upgrading one.
- `jwt-decode` — no import sites.
- `google-api-javascript-client` — no import sites. Note this is a
  long-abandoned npm mirror (v0.1.0), not Google's real client.
- `@types/gapi`, `@types/google.picker` — ambient globals, but no `gapi.` or
  `google.picker` reference survives in `src/`; the Drive picker is used via
  the `@googleworkspace/drive-picker-element` web component instead.

Dropping these would shrink the install and remove four packages from future
upgrade rounds.

## Node version pins disagree (2026-08-13)

Three different Node majors are pinned across the repo:

- `Dockerfile` — `node:22-alpine` (what production actually runs)
- `.github/workflows/ci.yml` — `node-version: lts/*` (24 as of writing)
- `mise.toml` — `node = "latest"` (26.x)

`scripts/check_version_sync.sh` doesn't catch it because it only compares pins
that name a concrete version. Worth settling on one (probably the current LTS)
so the image, CI and local dev agree.
