# Review 2026-08-17 — React components and the app router surface

Axis: `src/components/**` and `src/app/**` excluding `src/app/api/`.
Reviewed at `b29585b`, against `plans/repo-review-2026-08-15.md` and
`.claude/current_plan.md`.

---

### 🔴 C1 — Nothing catches a render error, so one failed lazy chunk replaces the whole soundboard while the audio keeps playing

- **Class:** NEW
- **Where:** `src/components/ClientLayout.tsx:20-31`, `src/components/ModalRenderer.tsx:42-49`, `src/components/modals/modalRegistry.ts:97-108`, `public/sw.js:6-12,104-135`

- **Finding:** There is no error boundary anywhere in the app, and no App Router
  error file:

  ```
  $ rg -n "componentDidCatch|getDerivedStateFromError|ErrorBoundary" src/   → no matches
  $ find src/app -name "error.tsx" -o -name "global-error.tsx"             → no matches
  ```

  `ClientLayout` is a flat stack with nothing wrapping it:

  ```tsx
  <GoogleAuthProviderWrapper>
    <KeyboardListenerWrapper>
      <AuthNotification />
      <ClientSideInitializer>{children}</ClientSideInitializer>
      <ProfileManagerHost />
      <ModalRenderer />
    </KeyboardListenerWrapper>
  </GoogleAuthProviderWrapper>
  ```

  `ModalRenderer` renders four `React.lazy` modals behind a bare `Suspense` with
  no error boundary beside it:

  ```tsx
  return (
    <Suspense fallback={<LoadingSpinner />}>
      <LazyModalComponent {...(modalConfig.modalProps || {})} />
    </Suspense>
  );
  ```

  `Suspense` handles the pending case only; a rejected `import()` re-throws on
  the next render attempt and propagates. The service worker makes that
  rejection reachable rather than theoretical: `STATIC_ASSETS` precaches only
  `/`, `/offline.html` and three icons, and the catch-all branch is
  network-first with an opportunistic cache. Offline, a chunk that was never
  fetched before misses the cache and the worker synthesises
  `new Response('Network error happened', { status: 408 })` — the module load
  fails, `lazy()` throws, and with no boundary React unmounts the tree.

- **Impact:** An offline PWA user who presses Help (or Shift+?), or opens the
  bulk importer, the loudness overview, or hits a sync conflict, loses the
  entire application: Next's built-in production handler renders
  "Application error: a client-side exception has occurred" in place of the
  soundboard. The Web Audio graph lives at module scope in `src/lib/audio/`, so
  **whatever was playing keeps playing**, and the only thing that could stop it
  — the Escape panic key in `useKeyboardListener` — has been unmounted with
  everything else. Recovery is a page reload, mid-show. The same blast radius
  applies to any uncaught throw in a rendered component; the offline chunk is
  simply the one with a concrete, non-hypothetical trigger.

- **Fix:** Add `src/app/global-error.tsx` and an `ErrorBoundary` around
  `ModalRenderer` / `ProfileManagerHost` / `{children}` in `ClientLayout`, whose
  fallback (a) offers a "stop all sounds" button calling `stopAllAudio()`
  directly and (b) offers a reload. Separately, either precache the four modal
  chunks in the service worker's `install`, or have the catch-all `.catch()`
  branch return a network error the browser treats as a load failure rather than
  a 408 body.

---

### 🟡 C2 — Every pad claims to be a button, none of them can be operated by a keyboard, and Tab is suppressed app-wide

- **Class:** NEW
- **Where:** `src/components/Pad.tsx:348-362`; compounded by `src/hooks/useKeyboardListener.ts:327-330`

- **Finding:** `Pad` puts itself in the tab order and announces itself as a
  button, but handles only `onClick`:

  ```tsx
  role="button"
  tabIndex={0} // Make it focusable
  ...
  aria-label={`Sound pad ${padIndex + 1}...`}
  ```

  There is no `onKeyDown` anywhere in the file (`rg -n "onKeyDown" src/components/Pad.tsx` → no matches).
  ARIA requires a `role="button"` element to activate on Enter and Space; this
  one activates on neither. Both keys are in fact already claimed globally:
  Enter plays the emergency sound and Space is the Fade-Out-All special pad
  (`SPECIAL_PAD_CONFIG.FADE_OUT_ALL.keyBinding = " "` in `PadGrid.tsx:31`), so
  focusing a pad and pressing Space fades out everything instead.

  The tab order those 64 `tabIndex={0}` elements join does not exist either —
  outside inputs and overlays the global listener eats Tab:

  ```ts
  if (event.key === "Tab") {
    event.preventDefault();
    return; // Stop further processing for Tab key
  }
  ```

  So focus cannot be moved onto a pad by keyboard in the first place, nor onto
  the bank tabs, the Help/Search/Edit buttons, or the profile selector.

- **Impact:** The soundboard's main surface is inoperable by keyboard and
  mis-announced to assistive tech: a screen-reader user hears "Sound pad 3:
  Applause, button" and pressing Enter plays the emergency bank instead.
  Anyone navigating by keyboard cannot reach any header control at all. The
  per-pad hotkeys (`q`, `w`, …) are the only route in, and they are undiscoverable
  without sight of the pad's key badge.

- **Fix:** Give `Pad` an `onKeyDown` that fires the same handler on `Enter` and
  `" "` with `preventDefault()`, and restrict the global Tab suppression to the
  case it was written for (stopping the browser from tabbing _away_ mid-show) —
  or drop it, since the pad hotkeys already `preventDefault` their own keys. If
  the pads genuinely should not be tab stops, remove `tabIndex={0}` rather than
  leaving 64 unreachable, unactivatable ones.

---

### 🟡 C3 — Escape is now a dead key while the profile manager is open: it neither closes the overlay nor stops the audio

- **Class:** REGRESSION (commit `6a2ce80`, finding A8)
- **Where:** `src/hooks/useKeyboardListener.ts:306-311`, `src/components/profiles/ProfileManager.tsx:580`

- **Finding:** A8 was fixed by making the global listener bail whenever any
  overlay is up:

  ```ts
  // While anything is open on top it owns the keyboard (Escape, Tab,
  // typing, etc.). ...
  if (isAnyOverlayOpen) {
    return;
  }
  ```

  `useIsAnyOverlayOpen` includes `isProfileManagerOpen`. But nothing on top
  handles Escape. `ProfileManager`'s overlay is a plain div with no keydown
  listener and no backdrop `onClick`:

  ```tsx
  <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/50">
  ```

  (`rg -n "Escape|onKeyDown" src/components/profiles/ProfileManager.tsx` → no
  matches.) `Modal.tsx:34-46` and `SearchModal.tsx:46-52` both register their
  own Escape handler; the profile manager — the one overlay rendered outside the
  modal system — never got one. Before `6a2ce80` the guard read
  `if (isModalOpen) return;`, so Escape fell through to the panic stop
  (`useKeyboardListener.ts:426-430`).

- **Impact:** With the profile manager open, Escape does nothing whatsoever. The
  documented panic button ("ESC: Stop all sounds", CLAUDE.md and the on-screen
  hint in `ActiveTracksPanel.tsx:66-74`) is silently disabled, and the overlay
  itself cannot be dismissed by keyboard — the only exit is clicking the ×.
  `e2e-tests/overlay-keyboard.spec.ts:46-71` locks in the swallow but never
  asserts that anything replaced it.

- **Fix:** Give `ProfileManager` the same Escape effect `Modal` has (capture
  phase, `stopImmediatePropagation`, calling `closeProfileManager`) plus a
  backdrop `onClick`, and extend the e2e test to assert the manager closed. The
  general form is D8 (consolidate on `Modal`), deliberately deferred — but the
  swallow shipped without it, so the Escape handler cannot wait for that.

---

### 🟡 C4 — UI1 was fixed for the mouse only: the keyboard, Ctrl+Click and the grid itself still act on the previous bank

- **Class:** RECURRENCE (claimed fixed in `034e4eb`, "Refs … UI1")
- **Where:** `src/components/PadGrid.tsx:272`, `src/hooks/useKeyboardListener.ts:217-224,521,546`, `src/hooks/pad/usePadInteractions.ts:286-316`, `src/hooks/usePadConfigurations.ts:119-127`

- **Finding:** `usePadConfigurations` deliberately serves the previous bank's map
  while the next read is in flight:

  ```ts
  padConfigs: profileId ? (result?.padConfigs ?? NO_CONFIGS) : NO_CONFIGS,
  isLoading: profileId !== null && result?.requestKey !== requestKey,
  ```

  `034e4eb` added the guard to exactly one consumer, `handlePadClick`:

  ```ts
  if (isLoadingConfigs) return;
  ```

  Three other readers of the same stale map were left alone:

  1. **The keyboard trigger** — `useKeyboardListener.ts:217` destructures
     `const { padConfigs } = usePadConfigurations(...)` and discards `isLoading`,
     then copies it into a ref (`:221-224`) that the pad-key handler reads at
     `:521` and `:546`. Pressing `4` then `q` inside the read window plays
     bank 3's pad 0.
  2. **Ctrl+Click to arm** — `PadWithLoading` wires `onCtrlClick` to
     `handleArmTrack` (`PadGrid.tsx:91-94`), and `handleArmTrack`
     (`usePadInteractions.ts:293`) does `padConfigs.get(padIndex)` with no
     loading check, so the wrong cue gets queued under the new bank's key.
  3. **The rendering itself** — `padElements` (`PadGrid.tsx:362-436`) maps
     `padConfigs` unconditionally, which is the original UI1 complaint verbatim:
     the grid shows bank 3's names under bank 4's highlighted tab.

- **Impact:** Keyboard is the primary input for this app, so the fix landed on
  the least-used of the three paths. The user-visible failure UI1 described —
  press a bank key, immediately hit a pad key, get the previous bank's sound —
  is unchanged. Ctrl+Click arms the wrong cue into the queue, which surfaces
  later at F9 rather than immediately.

- **Fix:** Return `isLoading` from `usePadConfigurations` to the keyboard
  listener and gate the pad-key branch on it (and `handleArmTrack` likewise);
  render the grid's pads as empty/dimmed while `isLoadingConfigs`, rather than
  as the old bank's contents.

---

### 🟡 C5 — Every armed track's Play button plays the _first_ armed track, not the one it is attached to

- **Class:** NEW
- **Where:** `src/components/ArmedTracksPanel.tsx:154-156,185-193`, `src/components/shared/TrackItem.tsx:217-221`, `src/store/playbackStore.ts:186-196`

- **Finding:** Each row's play button is labelled for its own track but wired to
  the queue-head action:

  ```tsx
  {armedTracksArray.map((track: ArmedTrackState) => (
    <TrackItem
      key={track.key}
      name={track.name}
      onPlay={() => handlePlayNext()}        // ← ignores `track`
      onRemove={() => handleRemoveArmedTrack(track.key)}
  ```

  `handlePlayNext` calls `playbackStoreActions.playNextArmedTrack()`, which is
  explicitly FIFO:

  ```ts
  // Get the first armed track (we'll use FIFO order)
  const firstKey = Array.from(state.armedTracks.keys())[0];
  ```

  `TrackItem` meanwhile advertises the row's own track:

  ```tsx
  <button onClick={handlePlayClick} aria-label={`Play ${name}`}>
  ```

  Note `onRemove` on the very next line _does_ pass `track.key`, so the omission
  is a wiring slip, not a deliberate constraint.

- **Impact:** With more than one track armed, clicking the green Play on any row
  but the first plays and disarms a **different** cue than the button names — a
  wrong sound going out live, and the intended cue left sitting in the queue.
  The panel gives no indication anything unexpected happened.

- **Fix:** Add `playArmedTrack(key)` to the playback store (the existing
  `playNextArmedTrack` body parameterised on `key` instead of
  `keys()[0]`, with `playNextArmedTrack` delegating to it), and pass
  `onPlay={() => playArmedTrack(track.key)}`.

---

### 🟡 C6 — The shared `Modal` is not a dialog: no role, no focus move, no focus trap, no focus restore

- **Class:** NEW (distinct from the deferred D8, which is about the _other_ four overlays)
- **Where:** `src/components/Modal.tsx:78-113`

- **Finding:** The modal system's root is a bare div pair:

  ```tsx
  <div
    data-testid="custom-modal-overlay"
    className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 ..."
    onClick={onClose}
  >
    <div data-testid="custom-modal" className="relative bg-white ..." onClick={stopPropagation}>
  ```

  No `role="dialog"`, no `aria-modal="true"`, no `aria-labelledby` pointing at
  the `<h2 data-testid="modal-title">` it renders 30 lines below, and no effect
  that moves focus into the dialog, keeps it there, or returns it on close.
  `rg -n 'role="dialog"|aria-modal|focus\(\)' src/components/Modal.tsx` → no
  matches. `SearchModal` at least focuses its input (`SearchModal.tsx:37-43`);
  the system modal does none of it.

- **Impact:** Opening the pad editor, the bank editor, Help, the bulk importer
  or the conflict resolver leaves focus on the trigger _behind_ the overlay. A
  screen reader announces nothing on open and continues reading the page
  underneath as if the modal were not there; a keyboard user tabs straight out
  of the dialog into the obscured page. On close, focus is lost to `<body>`.

- **Fix:** Add `role="dialog" aria-modal="true"` and `aria-labelledby` to the
  inner container; on open, store `document.activeElement`, focus the dialog (or
  its first focusable child), trap Tab/Shift+Tab within it, and restore focus on
  unmount. One change here fixes every modal in the app, since they all render
  through `ModalRenderer`.

---

### 🟢 C7 — Search results are clickable divs; the arm gesture has no keyboard equivalent

- **Class:** NEW
- **Where:** `src/components/search/SearchModal.tsx:221-237`

- **Finding:**

  ```tsx
  <div
    key={`${result.pageIndex}-${result.padIndex}`}
    onClick={(e) => handleResultClick(e, result)}
    className={`... cursor-pointer ...`}
    data-testid="search-result-item"
    aria-disabled={result.isDisabled}
    title={... `Click to play. Ctrl+Click to arm track.`}
  >
  ```

  No `role`, no `tabIndex`, no key handler. The `aria-disabled` on a div with no
  role is inert. `handleResultClick` branches on `e.ctrlKey`
  (`SearchModal.tsx:142-146`), so arming exists only as a mouse chord.

- **Impact:** Ctrl+F opens a modal, focuses its input, and then offers results
  that cannot be selected without a mouse — the one flow in the app that starts
  from the keyboard dead-ends there.

- **Fix:** Make each result a `<button type="button">` (or add
  `role="button" tabIndex={0}` plus Enter/Space handling), and give arming a
  keyboard route — Ctrl+Enter on the focused result, or a second small button
  per row.

---

### 🟢 C8 — Escape inside the waveform trimmer closes the whole pad editor and discards the edit

- **Class:** NEW
- **Where:** `src/components/WaveformTrimmer.tsx:423-589`, `src/components/Modal.tsx:34-46`, `src/components/modals/EditPadForm.tsx:385-408`

- **Finding:** `WaveformTrimmer` portals a second overlay on top of the pad-edit
  modal (`createPortal(content, document.body)`, `z-60`) and registers no
  keydown handler of its own — `rg -n "Escape|keydown" src/components/WaveformTrimmer.tsx`
  → no matches. The modal underneath registered a **capture-phase, window-level**
  handler that stops all further propagation:

  ```ts
  window.addEventListener("keydown", handleEscape, true);
  ...
  event.stopImmediatePropagation();
  onClose();
  ```

  So Escape while trimming is handled by the outer modal.

- **Impact:** Pressing Escape to back out of the trimmer closes the entire pad
  editor instead, throwing away the trim range _and_ every other unsaved change
  on that pad (name, playback mode, gains, sound order). The trimmer's own
  Cancel button is the only safe way out, and nothing says so.

- **Fix:** Give `WaveformTrimmer` its own capture-phase Escape handler calling
  `onClose()` with `stopImmediatePropagation()`. It is mounted after the modal,
  so it wins the capture race and the outer handler never sees the event.

---

### 🟢 C9 — The loudness overview labels banks by number, ignoring the names everywhere else uses

- **Class:** NEW
- **Where:** `src/components/modals/LoudnessOverviewModalContent.tsx:198`

- **Finding:**

  ```ts
  getBankName: (pageIndex) => `Bank ${pageIndex + 1}`,
  ```

  The component already loads pad configurations for the profile but never
  touches `pageMetadata`. `useSearch.ts:96-136,190-191` builds a real
  `bankNames` map from `pageMetadata` for the same purpose, and `app/page.tsx:295-344`
  renders the tabs from it.

- **Impact:** On a board with named banks ("Act 1 SFX", "Interval"), the
  loudness table's first column and its bank filter say "Bank 3" while the tab
  above says "3: Act 1 SFX" — the user has to translate between the two views
  to find the sound they were looking at.

- **Fix:** Load `getAllPageMetadataForProfile(activeProfileId)` in the existing
  mount effect (it is one more read alongside the pad fetch) and resolve
  `getBankName` from it, falling back to `Bank ${convertIndexToBankNumber(pageIndex)}`.

---

### 🟢 C10 — Playback state has no live region, so nothing about it is announced

- **Class:** NEW
- **Where:** `src/components/ActiveTracksPanel.tsx:76-108`, `src/components/ArmedTracksPanel.tsx:175-197`

- **Finding:** The only `aria-live`/`role="status"` in the whole component tree
  are two `role="alert"`s
  (`BackupReminderNotification.tsx:26`, `ConflictResolutionModal.tsx:337`) —
  `rg -n 'aria-live|role="status"' src/components src/app` returns nothing else.
  `ActiveTracksPanel` swaps between "Nothing playing" and a grid of `TrackItem`s
  with no announcement, and `ArmedTracksPanel` returns `null` entirely when the
  queue empties (`ArmedTracksPanel.tsx:149-151`), so the panel appears and
  disappears silently.

- **Impact:** A non-sighted operator gets no confirmation that a pad fired, that
  a track finished, that a cue was armed, or that F9 consumed one — for a tool
  whose entire state is "what is currently making noise", that is the state that
  most needs announcing.

- **Fix:** Wrap the Active Tracks list body in `role="status" aria-live="polite"
aria-atomic="false"` announcing track names on start/stop (not the per-frame
  progress or remaining-time, which would flood), and keep the Armed Tracks
  container mounted with an empty live region rather than returning `null`.

---

## Checked and holding

- **A14** (`useFormModal` assigning during render) is genuinely fixed —
  `useFormModal.tsx:85-144` now fills `submitBox` from a commit-phase effect with
  a matching cleanup, and the fallback path is documented.
- **U2 / ProfileManagerHost** is real: `ProfileManagerHost.tsx:35-41` subscribes
  to one boolean, and `ProfileManager.tsx:83-121` uses `useShallow` over fifteen
  named fields rather than the whole store. The eager
  `@googleworkspace/drive-picker-element` import (`ProfileManager.tsx:302-304`)
  is now behind the gate.
- **UI3** is fixed and the reasoning in the comment at `app/page.tsx:123-132`
  matches the code (`currentPageIndex` out, `padConfigsVersion` in).
- **UI6/UI7** are fixed: `SearchProvider.tsx:334-340` memoises the context value
  with stable callbacks, and `ClientSideInitializer.tsx:64-66,126-128` reads both
  store fields synchronously via initialiser rather than correcting in an effect.
- **A9** is fixed: `PadGrid.tsx:225-256` carries `blur` and `visibilitychange`
  release handlers for the Delete key with full cleanup.
- **Effect cleanup** was checked across the tree — every `setInterval`,
  `ResizeObserver`, `EventSource` reconciliation, document/window listener and
  store subscription in `src/components/**` and `src/app/**` returns a matching
  teardown. The two exceptions are cosmetic `setTimeout(…, 3000)` copy-feedback
  resets (`SharingPanel.tsx:112`, `ServerSharingPanel.tsx:103`) that set state on
  a possibly-unmounted component; harmless under React 19.
- No `createObjectURL` anywhere in the component layer, so no URL leaks.
- List keys: the three `key={index}` sites (`app/page.tsx:300`,
  `ProfileManager.tsx:1358,1618`) are a bank index and two static error lists —
  all stable.

## Still open from the previous review, not re-listed above

- **A3** (175 lines of merge logic inside `ConflictResolutionModal`,
  `buildResolvedData` at `:131-307`) was not extracted and is **not** in the
  plan's "Deliberately not done" list — it looks dropped rather than decided.
  Its error path did get fixed (`:309-330` + `role="alert"`), which may be why.
  It remains the only sync-merge code with no unit test.
- **UI4** (`app/page.tsx:349-446`, the 100-line inline Add-Bank handler with the
  form value smuggled through a `let modalDataValue`) is unchanged. It works;
  it is four lines from a correct `useFormModal` usage for the same job.
