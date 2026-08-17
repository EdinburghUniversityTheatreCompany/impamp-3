# Review 2026-08-17 — Zustand stores and custom hooks

Axis: `src/store/` (profileStore, playbackStore, uiStore, syncStatusStore, loadingStore)
and `src/hooks/` (including `hooks/pad/` and `hooks/modal/`). Reviewed at `b29585b`.

Baseline read first: `plans/repo-review-2026-08-15.md` §"Architecture and state"
(A1–A14) and `.claude/current_plan.md` §"Deliberately not done, and why".

**What genuinely landed from the last pass** (checked, not assumed, so the next
review does not re-spend budget here): A4 — `syncRequestQueue` now drains
(`clearSyncRequest`, and `ClientSideInitializer` diffs against `previousQueue`).
A7 — SSE streams are keyed `${id}:${serverProfileId}:${shareToken}`.
A8 — `useIsAnyOverlayOpen` is one place to ask. A9 — `PadGrid`'s Delete key has
`blur` + `visibilitychange`. A12 — the Google refresh throttle and in-flight
promise are module-level. A13 — **zero** whole-store subscriptions remain; every
selector in the tree returns a primitive, a stable function or a stored
reference, and `ProfileManager` uses `useShallow`. A14 (first half) —
`submitBox` is written from an effect, not during render.

---

### 🟡 S1 — The keyboard listener lost its "drop the previous bank's pads" guard, and plays the old bank's sound under the new bank's key

- **Class:** REGRESSION (introduced by `988084d`, the C4 fix)
- **Where:** `src/hooks/useKeyboardListener.ts:217-224`, against
  `src/components/PadGrid.tsx:265-272` and `src/hooks/usePadConfigurations.ts:119-127`
- **Finding:** `usePadConfigurations` deliberately keeps the last successful
  result while the next request is in flight — `padConfigs: profileId ? (result?.padConfigs ?? NO_CONFIGS) : NO_CONFIGS`
  with `isLoading: profileId !== null && result?.requestKey !== requestKey`.
  `PadGrid` knows this and guards on it at `:265-272`, and the comment spells
  the consequence out:

  ```ts
  // `usePadConfigurations` keeps the last successful result while the next
  // request is in flight, so between pressing a bank key and the read
  // resolving these are still the *previous* bank's pads — shown under the
  // new bank's number. Acting on them played the old bank's sound at the
  // new bank's position, and in edit mode edited or deleted it.
  if (isLoadingConfigs) return;
  ```

  `useKeyboardListener` consumes the same hook and takes no such guard:

  ```ts
  const { padConfigs } = usePadConfigurations(
    activeProfileId === null ? null : String(activeProfileId),
    currentPageIndex,
  );
  const padConfigsRef = useRef<Map<number, PadConfiguration>>(padConfigs);
  useEffect(() => {
    padConfigsRef.current = padConfigs;
  }, [padConfigs]);
  ```

  `handleKeyDown` reads `padConfigsRef.current` (`:521`, `:546`) with no
  `isLoading` check, and then triggers with the _new_ coordinates:
  `activeProfileId: activeProfileId as number, currentPageIndex: currentPageIndex`
  (`:612-613`).

  This is a regression, not an old wart. The code this replaced cleared the map
  itself, with a comment saying why — `git show 8ffc5e0:src/hooks/useKeyboardListener.ts`:

  ```ts
  // Token to discard resolutions of superseded loads (e.g. rapid bank switching)
  const requestId = ++configLoadRequestRef.current;
  // Drop the previous bank's configs immediately so keys don't trigger stale pads
  padConfigsRef.current = new Map();
  ```

  The C4 fix removed the private fetch (correctly — it was the second source of
  truth) but did not carry over either of its two protections.

- **Impact:** press `2` to change bank and then a pad key before the IndexedDB
  read resolves, and the _old_ bank's sound plays, registered under the new
  bank's playback key and with the old pad's trim/gain settings. Same window on
  a profile switch. It is short (one indexed range query), but it is exactly the
  window `PadGrid` decided was worth a guard for mouse clicks, and the keyboard
  is how this app is actually driven during a show.
- **Fix:** destructure `isLoading` and keep the ref aligned with the request it
  belongs to — `padConfigsRef.current = isLoading ? NO_CONFIGS : padConfigs;`
  (export `NO_CONFIGS` from `usePadConfigurations`, or use a local empty map).
  Two lines, and it restores the rule the deleted code stated.

---

### 🟡 S2 — Emergency sounds are invalidated by a different counter from every other copy of pad data, and no sync path bumps it

- **Class:** RECURRENCE (C4 — "pad configurations live in three places; two
  write paths invalidate only one" — was fixed for two of the three copies)
- **Where:** `src/hooks/useKeyboardListener.ts:271-276` vs
  `src/hooks/applySyncedProfile.ts:11-13`
- **Finding:** the emergency-sound set is a third cached copy of pad
  configuration data, held in a module-level ref and reloaded only when
  `emergencySoundsVersion` changes:

  ```ts
  useEffect(() => {
    console.log(
      `Loading emergency sounds (version: ${emergencySoundsVersion})`,
    );
    reloadEmergencySounds();
  }, [activeProfileId, reloadEmergencySounds, emergencySoundsVersion]);
  ```

  Every caller of `incrementEmergencySoundsVersion` is a _local_ edit path —
  `app/page.tsx:188` (bank emergency flag), `usePadInteractions.ts:141,216`,
  `usePadDrop.ts:103`, `usePadSwap.ts:94`, `PadGrid.tsx:348` (bulk import).
  The sync path bumps the _other_ counter only:

  ```ts
  export async function applySyncedProfile(profileId: number): Promise<void> {
    useProfileStore.getState().incrementPadConfigsVersion();
  ```

  `grep -rn incrementEmergencySoundsVersion src/lib` returns nothing. So a sync
  refreshes the grid and the keyboard's ordinary pad map, and leaves the
  emergency set untouched.

- **Impact:** a collaborator (or your own edit from another device/tab) changes
  the sound on an emergency bank, or marks a new bank as emergency. Sync applies
  it, the grid updates — and pressing **Enter** still fires the sound the
  emergency set was loaded with, until you switch profile or make a local
  emergency edit. On the one feature named "emergency".
- **Fix:** bump both counters in `applySyncedProfile`, or better, derive the
  emergency set from `padConfigsVersion` too — make its effect depend on
  `padConfigsVersion` as well and delete the second counter, so there is one
  invalidation signal for all three copies of pad data.

---

### 🟡 S3 — `reloadEmergencySounds` has no generation token, so the previous profile's load can land last

- **Class:** NEW (a partial fix of the bug the code's own comment claims to have closed)
- **Where:** `src/hooks/useKeyboardListener.ts:233-268`
- **Finding:** the reload clears the ref before awaiting, and says so:

  ```ts
  // Dropped before the await, not after it. These refs are module-global, so
  // they survive a profile switch, and between the switch and this load
  // resolving Enter played the *previous* profile's emergency sound.
  const previousSounds = emergencySoundsRef.current;
  emergencySoundsRef.current = [];

  const sounds = await loadEmergencySounds(activeProfileId);
  ...
  emergencySoundsRef.current = sounds;
  ```

  That closes the window _during_ the await, but nothing discards a superseded
  load when it resolves. Switching profile A → B starts B's load while A's is
  still running, and `loadEmergencySounds` is not one read but a metadata read
  followed by one `getPadConfigurationsForProfilePage` **per emergency page**
  (`:62-103`). A profile with three emergency banks takes four sequential reads;
  a profile with none takes one. So B (few pages) routinely finishes before A
  (many pages), and A's write lands last:
  `emergencySoundsRef.current = <profile A's sounds>` while B is active.

- **Impact:** Enter fires an emergency sound from the profile you just left —
  the precise failure the comment above says was fixed. `playEmergencySound`
  uses `sound.profileId`/`sound.pageIndex` from the stale record, so it plays
  cleanly and looks correct.
- **Fix:** the same monotonic token `setCurrentPageIndex` already uses
  (`profileStore.ts:184`, `pageIndexRequestToken`): capture
  `const token = ++emergencyLoadToken` before the await and drop the write if
  `token !== emergencyLoadToken` after it.

---

### 🟡 S4 — `armedTracks` is a private snapshot of pad configuration that no write path ever re-syncs

- **Class:** NEW
- **Where:** `src/store/playbackStore.ts:22-35`, `src/hooks/pad/usePadInteractions.ts:126-134`
- **Finding:** `ArmedTrackState` copies the pad's whole playback definition into
  the playback store:

  ```ts
  audioFileIds: number[];
  playbackType: PlaybackType;
  audioTrimSettings?: Record<number, { trimStart: number; trimEnd: number }>;
  audioGainSettings?: Record<number, number>;
  padGainDb?: number;
  ```

  and `playNextArmedTrack` plays from that copy, never re-reading the pad
  (`playbackStore.ts:199-216`). The only write path that touches an armed track
  is the _disabled_ case in the pad editor:

  ```ts
  if (updatedPadConfigData.isDisabled) {
    playbackStoreActions.removeArmedTrack(
      `armed-${activeProfileId}-${currentPageIndex}-${padIndex}`,
    );
  }
  ```

  Nothing else does. `handleRemoveInteraction` (delete the sound),
  `handleSwapPads` (`usePadSwap.ts`), `handleDropAudio` (`usePadDrop.ts`) and
  `applySyncedProfile` all leave the armed entry pointing at the pre-edit
  sounds, trim and gain. The armed sounds are also _pinned_ in the audio cache
  by id (`armTrack` → `pinAudioBuffer`), so an id that has left the pad keeps a
  pin.

- **Impact:** arm a pad (Ctrl+click), then change or remove its sound, then hit
  F9 — you get the sound the pad had when you armed it, at the gain it had then.
  After a swap in delete/move mode the cue fires the sound that moved away. If
  the orphan cleanup has since deleted the audio file, F9 fires nothing and logs
  an error. This is the one path in the app where "what will play" is decided
  from a copy taken minutes earlier.
- **Fix:** either re-read the pad at trigger time in `playNextArmedTrack`
  (store only `padInfo` + `name` in `ArmedTrackState`), or disarm the pad key
  from every write path — best via the single `savePadConfiguration()` helper
  D6 was going to introduce.

---

### 🟡 S5 — `currentPageIndex` survives a profile switch without being validated against the new profile

- **Class:** NEW
- **Where:** `src/store/profileStore.ts:285-316`
- **Finding:** `setActiveProfileId` resets the two mode flags and clears armed
  cues, and deliberately leaves pad loading to `usePadConfigurations` — but says
  nothing about the current bank:

  ```ts
  set({
    activeProfileId: id,
    isEditMode: false,
    isDeleteMoveMode: false,
  });
  ```

  `setCurrentPageIndex` refuses any index ≥ 10 that the active profile has no
  `pageMetadata` for (`:341-371`) — precisely because banks 11–20 are opt-in.
  A profile switch bypasses that check entirely, and nothing else in the tree
  resets the index (`grep -rn setCurrentPageIndex src --glob '!*.test.*'` →
  `profileStore.ts`, `useKeyboardListener.ts`, `app/page.tsx` bank tabs and the
  add-bank button; no profile-switch caller).

- **Impact:** be on bank 16 in profile A (which has it), switch to profile B
  (which does not): `PadGrid` renders 48 empty pads, `app/page.tsx:288` renders
  bank tabs from `Object.keys(bankNames)` so **no tab is selected**, and the
  board looks broken. Worse in edit mode — dropping a sound writes a
  `padConfiguration` at `pageIndex: 15` with no matching `pageMetadata`, so no
  tab is ever drawn for it and `setCurrentPageIndex(16)` refuses to go there.
  The pad is unreachable except through search, and it syncs in that state.
- **Fix:** in `setActiveProfileId`, reset `currentPageIndex: 0` on a real switch
  (`previousId !== id`) — cheap and always correct — or re-validate the index
  against the new profile's page metadata the way `setCurrentPageIndex` does.

---

### 🟡 S6 — `profileStore.error` is written from seventeen places and read by nobody

- **Class:** NEW
- **Where:** `src/store/profileStore.ts` — `error` set at `:279, :500, :522,
:547, :592, :646, :682, :753, :776, :780, :790, :830, :859, :944, :980, :1085,
:1113`
- **Finding:** every store action funnels its failure into a
  `set({ error: "Failed to …" })`. Nothing reads it:
  `rg 'useProfileStore\(\)'`finds no whole-store subscription anywhere (A13 is
  genuinely fixed), and no selector anywhere in`src/components`, `src/hooks`or`src/app`selects`state.error`from this store — the only`status.error`in
  the UI is`SyncControls.tsx:147`, which reads `syncStatusStore`.

  Two actions make it consequential by swallowing rather than rethrowing:

  ```ts
  // setActivePadBehavior — profileStore.ts:934-948
  } catch (error) {
    set({ error: `Failed to set active pad behavior: ${errorMessage}` });
    // Re-throw might be useful depending on how calling code handles errors
    // throw error;
  }
  ```

  `setNormalisation` (`:970-982`) is the same shape, and its caller
  (`ProfileCard.tsx:371,396`) is a `void setNormalisation(...)` on a checkbox
  and a slider.

  `exportMultipleProfilesToZip` is the sharpest case: it writes
  `"Profiles exported, but failed to update backup timestamp: …"` and then
  `return true` (`:749-756`, `:771-778`), so the caller is told the export
  succeeded and the explanation goes into a field with no readers — while
  `lastBackedUpAt` did not move, so the backup reminder will fire again.

- **Impact:** a failed setting write reverts the control silently; a failed
  timestamp update is reported as a clean export. Every diagnostic the store
  bothers to compose is discarded.
- **Fix:** either render it (an error region fed by `useProfileStore(s => s.error)`
  with a `clearError` action), or delete the field and let the actions throw —
  what must not stay is fifteen writes to a channel with zero readers, which
  reads as error handling and is not.

---

### 🟢 S7 — `useModal()` subscribes to `isModalOpen` unconditionally, so opening any modal re-renders the whole pad grid

- **Class:** NEW
- **Where:** `src/hooks/modal/useModal.tsx:61`, reached from
  `src/hooks/pad/usePadInteractions.ts:56`
- **Finding:** `usePadInteractions` is careful to take only what it needs:

  ```ts
  // Consumed by PadGrid, so a bare subscription meant opening *any* modal
  // re-rendered the grid's whole handler tree.
  const openModal = useUIStore((s) => s.openModal);
  const closeModal = useUIStore((s) => s.closeModal);
  const { openFormModal } = useFormModal();
  ```

  but `useFormModal` calls `useModal()`, which always subscribes:
  `const isModalOpen = useUIStore((state) => state.isModalOpen);` — whether the
  caller destructures it or not. `PadGrid → usePadInteractions → useFormModal →
useModal` therefore re-renders `PadGrid` (and its 48 `Pad`s) on every modal
  open and close, which is the outcome the comment above says was avoided.

- **Impact:** wasted renders on a user-paced event, so no visible bug — but the
  stated invariant is not actually held.
- **Fix:** make the subscription opt-in (`useModal({ trackOpen: true })`), or
  have `useFormModal` build on the store actions directly rather than on
  `useModal`.

---

### 🟢 S8 — `canEditActiveProfile()` answers "yes" for the whole initial load

- **Class:** NEW
- **Where:** `src/store/profileStore.ts:432-436`
- **Finding:**

  ```ts
  canEditActiveProfile: () => {
    const { profiles, activeProfileId } = get();
    const active = profiles.find((p) => p.id === activeProfileId);
    return active ? getSyncState(active).canEdit : true;
  },
  ```

  `activeProfileId` is rehydrated from localStorage synchronously at store
  creation (`partialize`, `:1137-1146`), but `profiles` stays `[]` until
  `fetchProfiles()` resolves. In that window `active` is `undefined` and the
  gate opens. `app/page.tsx:47-56` computes `readOnlyReason` from the same
  lookup, so the VIEW ONLY banner is absent too, and `usePadDrop`'s
  re-read-fresh guard (`usePadDrop.ts:56`) reads the same optimistic `true`.

- **Impact:** for the first frames after a reload on a followed or view-only
  profile, Shift enters edit mode and a drop is accepted, with no banner
  explaining anything — and those edits are what the next sync destroys, which
  is the whole reason the gate exists. The window is short (one IndexedDB read)
  and needs an implausibly fast user, so this is a correctness statement rather
  than an observed bug.
- **Fix:** distinguish "no active profile" from "active profile not loaded yet":
  return `true` only when `activeProfileId === null`, and `false` while
  `isLoading` and the id is set.

---

### 🟢 S9 — `syncStatusStore.clear` / `clearAll` have no callers, and a deleted profile's status entry outlives it

- **Class:** NEW
- **Where:** `src/store/syncStatusStore.ts:99-107`; `profileStore.deleteProfile`
  at `:527-550`
- **Finding:** `rg 'syncStatusActions\.'` finds only `patch` and `noteSynced`
  (in `useProfileSync.ts`, `useServerSync.ts`, `ProfileCard.tsx`). Neither
  `clear` nor `clearAll` is called anywhere outside `syncStatusStore.test.ts`,
  and `deleteProfile` removes the profile from `profiles` without touching
  `byProfileId`. The map only grows for the life of the tab.
- **Impact:** none observable today — IndexedDB `autoIncrement` does not reuse
  ids, so a stale entry cannot be inherited by a new profile. It is an unenforced
  cross-store invariant and two dead actions that look like the enforcement.
- **Fix:** call `syncStatusActions.clear(id)` from `deleteProfile` (and from the
  unlink path in `applyTransition`), which is what the actions were written for.

---

### 🟢 S10 — `useBackupReminders` re-runs a full per-profile DB scan on every `profiles` identity change, with no cancellation

- **Class:** NEW
- **Where:** `src/hooks/useBackupReminders.ts:17-70`
- **Finding:** the effect depends on `profiles`, whose array identity is
  replaced by `applySyncedProfile`, `updateProfile`, `pauseSync`, `resumeSync`,
  `setNormalisation`, `createProfile` and `fetchProfiles`. For each profile that
  survives the sync-health filter it awaits `hasProfileChangedSince`, which is
  two full `index("profileId").getAll(profileId)` scans over
  `padConfigurations` and `pageMetadata` (`db.ts:1258-1274`). There is no
  `cancelled` flag, so overlapping runs can settle out of order.
- **Impact:** small in practice — the `state.isLinked && !state.paused &&
state.defects.length === 0` filter skips every healthily-syncing profile, so
  only local profiles are scanned — but every background sync triggers the
  sweep, and the final `setProfilesNeedingReminder` compares by id-set only, so
  an older run can win.
- **Fix:** the standard `let cancelled = false` teardown this file's neighbours
  all have (`useRemoteList.ts:57-72`, `useSearch.ts:82`), plus a cheaper
  trigger than the whole `profiles` array (the profile ids and their
  `lastBackedUpAt`).

---

## Deferred items — re-checked, reasoning holds

- **A1 (split `profileStore`, 1177 lines) and A2 (`startSyncScheduler` out of
  `ClientSideInitializer`)** are still open and still structure-only. Their
  symptoms are genuinely gone: no whole-store subscriptions remain, the queue
  drains, the SSE key is complete. Nothing found on this axis needs the split to
  be fixed — S1–S10 are all local changes. The deferral reasoning stands.
- **A11 (`useGoogleDriveSync` keeps a second copy of the auth slice, then works
  around its own staleness)** is unchanged (`useGoogleDriveSync.ts:190-290`), but
  is now demonstrably harmless: the copy is selector-driven with
  `fireImmediately`, gates only effect re-runs, and every callback reads
  `getFreshTokenInfo()`. Structure-only, correctly deferred.
- **A14's second half** — React elements stored in `uiStore.modalConfig.content`
  — is unchanged and still the reason `uiStore` can never be persisted. Also
  structure-only; the render-phase assignment that made it a _bug_ is fixed.
