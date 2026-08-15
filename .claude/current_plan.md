# Plan: fix the whole-repo review

Findings live in `plans/repo-review-2026-08-15.md` — 15 🔴, ~60 🟡, ~12 🟢 across
ten axes. Work happens in `.worktrees/fix/repo-review` on branch
`fix/repo-review`, cut from `main` at `8ffc5e0`.

**Mick's decision:** fix everything **except S3** (`IMPAMP_ALLOWED_EMAILS` on the
public host) — that one is his call on the allowed set and stays open.

## Standing rules for this plan

- **Verify each finding against the code before fixing it.** The review was
  written by ten parallel agents; roughly one in eight findings on the last
  branch of this size did not survive contact with the source.
- **Test first where the finding is expressible as a test.** 🔴 P1, P2 and C2
  explicitly are, and the modules they live in (`audio/controls.ts`, `db.ts`
  duplication) have no unit tests at all. Write the failing test, watch it fail,
  then fix.
- **Green baseline at the start of every phase** (`npm test`) before touching
  anything.
- **One atomic commit per logical fix**, not one per phase.
- **Do not refactor beyond the finding.** The review names several large splits
  (`ProfileManager`, `profileStore`, `db.ts`, `importExport.ts`); those are
  phases 10–11 and are deliberately last. Do not start them early because a
  file is open.
- The review's **"Verified clean"** section lists things that were checked and
  hold. Do not "fix" those — notably `ProfileSyncPanel`/`useProfileSync`/
  `syncStatusStore` (a good refactor; D4 is about two leaves it left behind, not
  the trunk) and the audio buffer cache.

## Phase 1 — playback races (🔴 P1, P2)

The worst failures in the app: ESC cannot stop a stranded track, and stopping
one pad cancels another's pending trigger. Self-contained in `src/lib/audio/`.

- [x] 1.1 `src/lib/audio/playback.race.test.ts` — 6 cases, all 6 failed first
- [x] 1.2 P1: `claimPlaybackKey` silences whatever held the key
- [x] 1.3 P2: per-key stop counters + one global for `stopAllTracks`;
      `stopRequestedSince(key, captured)` replaces the bare comparison

**Done.** Commit `d413146`. 525 tests green (was 519). Typecheck clean.
Note the API change: `getStopGeneration()` now takes a playback key and returns
`{global, key}` — only `controls.ts` consumed it.

## Phase 2 — the wire shape and the share-token leak (🔴 S1, 🟡 D1)

- [x] 2.1 `src/lib/profileWire.ts` — allow-list + compile-time exhaustiveness
      assertion over `keyof Profile`, 6 unit tests
- [x] 2.2 Both outbound sites routed through it (`dataAccess.ts:123` and
      `importExport.ts:1399`); `ProfileSyncData.profile` typed `WireProfile`
- [x] 2.4 `dataAccess.wire.test.ts` — verified it fails with the fix reverted
- [ ] 2.3 **Deferred to phase 5.** Collapsing the three _type_ declarations
      touches `importExport.ts`'s legacy paths, which have no tests (TH2). The
      leak is closed without it; the type surgery waits for the tests.

**Done** (except 2.3). Commit `2303298`. 533 tests green, typecheck clean.

Two scope decisions worth not re-opening: the Drive ids still travel, and
`lastBackedUpAt` still travels on the sync blob (only the export drops it, as
it always did). Both were briefly withheld and reverted — withholding either
is a behaviour change, not a security fix. The inbound side needed nothing:
`updateLocalData` already pins the token to the local value.

## Phase 3 — sync correctness (🔴 C1, C3; 🟡 A5, A6, A7, D7, SV5)

- [ ] 3.1 C1: exclude hash fields from `allFields`, re-derive after merge
- [ ] 3.2 C3: hosted-audio branch in `importProfileFromSyncData`
- [ ] 3.3 A6: unify the warning channel across both backends
- [ ] 3.4 A5: server in-flight map keeps joiners' callbacks and replays SSE
- [ ] 3.5 A7: key SSE subscriptions on profile+serverProfileId+shareToken
- [ ] 3.6 D7: one `getHashlessIndex`; store hashes at import time
- [ ] 3.7 SV5: `applyTransition` fails on paused, not only on error

## Phase 4 — pad-config invalidation and keyboard ownership (🔴 C4; 🟡 A8, A9, D6, UI5)

- [ ] 4.1 C4: `useKeyboardListener` consumes `usePadConfigurations`; delete
      `padConfigsRef` and `reloadToken`
- [ ] 4.2 D6: one `savePadConfiguration()` — four call sites collapse
- [ ] 4.3 A8: all three "overlay open" flags into `uiStore` behind
      `isAnyOverlayOpen`
- [ ] 4.4 A9: Delete-key handling moves into `useKeyboardListener`
- [ ] 4.5 UI5: clear `emergencySoundsRef` at the top of `reloadEmergencySounds`

## Phase 5 — storage and import (🔴 C2; 🟡 ST1–ST6; TH2 first)

- [ ] 5.1 TH2: tests for the ZIP path and `importImpamp2Profile` — 31 % of
      `importExport.ts` with no coverage. **Before** any change to it.
- [ ] 5.2 C2: `duplicateProfileLocally` uses `extractPadPlaybackSettings`
- [ ] 5.3 ST2/ST3: import stamps sync bookkeeping; per-record failures surface
- [ ] 5.4 ST4: ZIP import validates and caps
- [ ] 5.5 ST1/ST5/ST6: orphan cleanup atomicity, wire-field filtering, page
      read-modify-write races

## Phase 6 — server security and hot paths (🔴 S2, R1, R5; 🟡 SV1–SV4, P2–P6, P10, P13, P14)

- [ ] 6.1 S2: commit requires proof of possession, not just a known hash
- [ ] 6.2 R1: relational `profile_audio(profile_id, hash)` — no whole-DB scan
- [ ] 6.3 R5: `getProfileMeta` on the 304, DELETE and both SSE paths
- [ ] 6.4 SV1–SV4: uncommitted-object sweep, admin flag on email match, Drive
      proxy referer gate, presign TTL
- [ ] 6.5 P2/P3: stringify once; splice the stored blob instead of parse+restringify
- [ ] 6.6 P4/P5/P6/P10/P14: query and index fixes, statement cache

## Phase 7 — network resilience and the N+1 sweep (🔴 R2, R4; 🟡 N1–N6, P11, P12)

- [ ] 7.1 R2: one `fetchWithTimeout`; expiry on `inFlight` and `capability`;
      service-worker timeout
- [ ] 7.2 N1–N6: one `getAudioMetadataForProfile(profileId)` cursor helper
      replaces all six `for (id of ids) await getAudioFile(id)` copies
- [ ] 7.3 R4: `serverHosted` short-circuit, batched marking, bounded pool
- [ ] 7.4 P11, P12

## Phase 8 — loudness off the main thread (🔴 R3; 🟡 P9)

- [ ] 8.1 Sliding-sum block loop (4× reduction, no accuracy change) — verify
      against the existing `analyse.test.ts` expectations
- [ ] 8.2 Worker for `analyseLoudness` + `computeHopTruePeak`
- [ ] 8.3 Route every `analyseAndStore` through the coalescing queue
- [ ] 8.4 P9: re-enable zip.js workers, or yield between entries

## Phase 9 — connect flows and component 🔴s (🔴 U1, U2; 🟡 D2, D3, D4, D8, A3)

- [ ] 9.1 U1: `/server/open` calls `useConnectServerProfile`
- [ ] 9.2 D2: `useConnectDriveProfile()` — four copies collapse
- [ ] 9.3 D3: `useGoogleSignIn()` — three copies collapse
- [ ] 9.4 U2: `ProfileManagerHost` gate (kills the eager Drive Picker import)
- [ ] 9.5 A3: `applyConflictResolutions` moves to `syncUtils.ts`, unit-tested
- [ ] 9.6 D4, D8

## Phase 10 — store and hook architecture (🟡 A1, A2, A4, A10–A14, UI1–UI4, UI6, UI7, D5)

The big splits. Deliberately after all correctness work.

- [ ] 10.1 A1: split `profileStore` (profile / auth / ui / settings / transfer)
- [ ] 10.2 A2: `startSyncScheduler` out of `ClientSideInitializer`
- [ ] 10.3 A4: `syncRequestQueue` drains
- [ ] 10.4 A10: one `useAppLifecycle()`
- [ ] 10.5 A11, A12, A13, A14
- [ ] 10.6 UI1–UI4, UI6, UI7, D5

## Phase 11 — audio subsystem and dead code (🟡 AU1–AU6; 🟢 L1–L7)

- [ ] 11.1 AU1/AU2: delete the ~200 unreachable lines and the two fake
      streaming decoders
- [ ] 11.2 AU3, AU4, AU5, AU6
- [ ] 11.3 L1: 18 dead exports · L2 barrels · L3 registry · L4 dead props ·
      L5 unreachable UI · L6 stale comment · L7 the two TODOs

## Phase 12 — test suite health (🔴 T1; 🟡 TH1, TH3–TH8)

- [ ] 12.1 T1: `profiles.spec.ts:100` retargeted at `[data-testid="profile-card"]`
- [ ] 12.2 TH6: the two missing `await`s
- [ ] 12.3 TH4: drop the forbidden `{ timeout: 5000 }`
- [ ] 12.4 TH5: `getArmedTrackNames` fails loudly
- [ ] 12.5 TH3: replace the five load-bearing sleeps with positive signals
- [ ] 12.6 TH8: adopt the existing helpers; extract the ten duplicated clusters
- [ ] 12.7 TH7: rewrite the stale "known failures" table
- [ ] 12.8 TH1: unit tests for the highest-risk untested modules

## Phase 13 — infrastructure and docs (🔴 S4; 🟡 I1–I9; 🟢 L8–L12)

- [ ] 13.1 S4: `.dockerignore` — `.worktrees/`, `certificates/`, `data/`, …
- [ ] 13.2 I1 root user · I7 debug echo · I4 `Dockerfile.dev` Node 24 + widen
      `check_version_sync.sh`
- [ ] 13.3 I2/I3: re-pin actions, restore `check_action_refs.sh`
- [ ] 13.4 I5: eslint + vitest in `hk.pkl` · I6: `npm audit` in CI + dependabot
- [ ] 13.5 I8: single-instance note in `config/deploy.yml` · I9 patch bumps
- [ ] 13.6 L8 doc drift (incl. the CLAUDE.md "Pinned Versions" contradiction and
      the `Record<audioFileId,…>` five-sites correction) · L10 eslint config ·
      L11, L12
- [ ] 13.7 L9: **ask Mick** before deleting the ~850 KB of orphaned docs

## Then

Full unit + chromium E2E on the branch, merge to main, suites again on merged
main, push, watch CI.

## Status

- Started 2026-08-15. Nothing executed yet.
- **Next step:** create the worktree, then Phase 1.1.
