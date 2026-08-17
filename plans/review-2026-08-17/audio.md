# Review 2026-08-17 — the audio subsystem

Axis: `src/lib/audio/**` (context, decoder, cache, playback, controls, preloader,
strategies, triggerPad, loudness/\*) plus the hooks and stores where the audio
contract is what matters. Branch `main` at `b29585b`.

Five findings. The first is a hard deadlock introduced by the fix pass and is
reproducible in a unit test; the rest are one lifetime bug, one incomplete 🔴
fix, one missing safety net and one polish item.

Everything else on this axis was checked and holds — see "Verified clean" at the
bottom, which includes the P1/P2 playback races, the gain single-source rule,
the BS.1770 maths and the worker actually being emitted by the build.

---

### 🔴 A1 — `loadAndDecodeAudioPipelined` deadlocks on every real preload batch, and poisons the shared in-flight map for the session

- **Class:** REGRESSION (introduced by `d353f90`, the AU3 fix)
- **Where:** `src/lib/audio/decoder.ts:235-287`, driven from
  `src/lib/audio/preloader.ts:316-320` and `:396-403`
- **Finding:** the AU3 fix moved the "wait for a decode slot" loop _inside_ the
  promise that is registered in `activeDecodes`, so each waiter is a member of
  the set it is racing on:

  ```ts
  const work = trackInFlightLoad(id, async () => {
    const audioFileData = await getAudioFile(id);      // first await
    ...
    while (activeDecodes.size >= maxConcurrentDecodes) {
      await Promise.race(activeDecodes);               // races over itself
    }
    ...
  });

  activeDecodes.add(work);
  ...
  await work;
  ```

  `batch.map(async (id) => …)` runs each callback synchronously up to its first
  `await`, which is `await work` — so **every** id in the batch is added to
  `activeDecodes` before any `getAudioFile` resolves. When they resume, each one
  sees `activeDecodes.size >= maxConcurrentDecodes` and blocks on
  `Promise.race(activeDecodes)`. Every member of the set is blocked, nothing can
  settle, and nothing is ever removed. The batch never completes.

  It fires whenever `batch.length >= maxConcurrentDecodes`, which is the normal
  case: `preloader.ts:318` passes a load batch of 8 (IMMEDIATE) or 6, and
  `getDecodeConcurrency` (`preloader.ts:396-403`) returns
  `min(max(cores - 2, 2), 6|8)` — 2 on a 4-core machine, 6 on 8 cores. Two files
  is enough to hang it on a 4-core laptop.

  Verified, not inferred. A probe test against the real module (mocking only
  `../db`, `./context` and `./cache`) times out at 1.5 s on both cases:

  ```
  × does not deadlock when the batch is larger than the decode concurrency
  × a later trigger joining the in-flight entry still resolves
  ```

  The same probe against `git show 8ffc5e0:src/lib/audio/decoder.ts` passes in
  21 ms — the pre-fix code kept the wait _outside_ the tracked promise, so the
  set only ever held real decodes, which can settle.

- **Impact:**
  1. `AudioPreloader.processQueue` awaits `processBatch` (`preloader.ts:284`),
     which awaits the dead promise. `isProcessing` stays `true` forever, so the
     preloader is dead for the rest of the session after the first page load.
     The decoded-buffer cache is therefore never warmed by preloading at all:
     every pad trigger falls to the media-element streaming path (which still
     plays), so the sample-accurate buffer path and the armed-track "instant
     cue" guarantee are silently gone — and streamed tracks are the ones with
     the frame-rate-dependent trim end in A2.
  2. Worse, the deadlocked ids stay in `inFlightLoads` forever. Any later caller
     that joins them never resolves: `loadAndDecodeAudioInstant`
     (`controls.ts:546`, the decode fallback), `loadAndDecodeAudioEnhanced`
     (the error-recovery path) and `loadAndDecodeAudio` (`usePadDrop.ts:108`).
     A pad that needs the decode fallback hangs with its loading spinner up and
     never plays, permanently.
  3. The 618-test unit suite does not catch it — nothing exercises the real
     `loadAndDecodeAudioPipelined` (`preloader.test.ts:8` mocks it out).
- **Fix:** keep the decode-slot wait outside the registered promise, or — better
  and keeping AU3's property — register the entry before the first await but
  make the gate not include the waiter. Concretely: acquire the slot from a
  semaphore whose queue is separate from the in-flight set, e.g. hold a
  `Set<Promise>` of _decodes only_ (added after the wait, before
  `decodeAudioBlob`) and race on that, or drop the hand-rolled gate for a small
  counted semaphore. Add the probe above as a regression test — it is six lines
  and fails against today's code.

---

### 🟡 A2 — a streamed track's trim end is enforced only from `requestAnimationFrame`, so a backgrounded tab plays straight past it

- **Class:** NEW (the old report's AU5 noted "frame-rate dependent"; the hidden-tab case, where the frame rate is _zero_, is not in it)
- **Where:** `src/lib/audio/playback.ts:995-1012`, loop control at `:1076-1098`
- **Finding:** buffer playback gets its trim natively —
  `source.start(0, trimStart, trimmedDuration)` (`playback.ts:353`). Media
  element playback has no equivalent, so the end point is policed by the
  monitoring loop:

  ```ts
  // Enforce the trim end manually — buffer sources handle this natively
  // via source.start(when, offset, duration), media elements don't
  if (
    track.trimEnd !== undefined &&
    element.currentTime >= track.trimEnd &&
    !track.isFading
  ) { … cleanupTrack(key); return; }
  ```

  That block only runs inside `playbackLoopTick`, which is scheduled purely by
  `requestAnimationFrame` (`playback.ts:1078`, `:1097`) — there is no
  `timeupdate` listener and no timer anywhere in `src/lib/audio/`
  (`rg "timeupdate|setInterval" src/lib/audio/` finds only the cache's LRU
  sweep). Browsers do not fire rAF in a hidden tab, and `context.ts:90-96`
  deliberately keeps audio running when the tab is hidden ("sounds currently
  playing should continue uninterrupted while the tab is in the background").
  So while the tab is hidden the trim end is never checked, and the element
  plays to the natural end of the file; it is only cut off when the tab becomes
  visible again and the loop resumes.

- **Impact:** on a live board, switching to another tab/window mid-cue turns a
  trimmed sound into the whole file — the untrimmed tail (often the part that
  was trimmed off because it is unwanted) goes to air. With A1 in place this is
  the _default_ playback path, since nothing warms the buffer cache. Even
  foreground, the cut is up to one frame late and drifts with load.
- **Fix:** schedule the cut instead of polling for it. On `loadedmetadata` (or
  as soon as `trimEnd` is known), ramp the track's own gain node to zero at
  `context.currentTime + (trimEnd - element.currentTime)` and pair it with a
  `setTimeout` to `cleanupTrack` — timers still fire in a hidden tab (throttled
  to ~1 s, which the gain ramp already covers audibly). Keep the rAF check as
  the belt-and-braces backstop it already is.

---

### 🟡 A3 — `analyseAndStore` still decodes outside the in-flight registry, discards the buffer, and runs unqueued from `addAudioFile`

- **Class:** RECURRENCE (R3's third fix — "route every `analyseAndStore` call through the coalescing queue" — and AU3's "related" half were not done; plan item 8.3 is still unchecked while the status block reports R3 complete)
- **Where:** `src/lib/audio/loudness/pipeline.ts:108-125`, fired from
  `src/lib/db.ts:556-568`
- **Finding:**

  ```ts
  let buffer = getCachedAudioBuffer(audioFileId);
  if (!buffer) {
    const file = await getAudioFile(audioFileId);
    if (!file) return null;
    buffer = await decodeAudioBlob(file.blob); // not via inFlightLoads,
  } // result never cached
  const analysis = await analyseAudioBufferOffThread(buffer);
  ```

  `decodeAudioBlob` is the raw decoder: it neither joins `inFlightLoads` nor
  calls `cacheAudioBuffer`, so a file being decoded for playback at the same
  moment is decoded twice and the analysis decode is thrown away. And
  `addAudioFile` fires it per file with no gate:

  ```ts
  void import("@/lib/audio/loudness/pipeline").then(({ analyseAndStore }) =>
    analyseAndStore(id),
  );
  ```

  The bulk-import modal (`BulkImportModalContent.tsx:316`) calls `addAudioFile`
  in a loop, so importing N sounds starts N overlapping analyses. Each holds a
  fully decoded `AudioBuffer` _and_ a full per-channel copy — `analyseOffThread`
  copies before transferring, deliberately (`analyseOffThread.ts:83-86`) — until
  the single worker gets to it. The worker is serial, so the copies queue up in
  its message queue rather than draining. Forty 3-minute stereo files is roughly
  2.7 GB resident; a hundred 5-minute files is far past what a tab survives.

  Note the ZIP/Drive import path is fine — `importExport.ts:833` deliberately
  goes through `runBackfill`, which is batched three at a time
  (`pipeline.ts:27`, `:227`). It is only the `addAudioFile` fan-out that is
  ungated.

- **Impact:** double decode work on every drag-and-drop assignment (`usePadDrop`
  decodes the same file at `:108` while the analysis decodes it again), and a
  memory spike proportional to the number of files bulk-imported at once, which
  is exactly the scenario R3 was raised for. The main-thread freeze R3 named is
  genuinely fixed; the "no queue, no concurrency cap" half is not.
- **Fix:** route `analyseAndStore` through the same bounded queue `runBackfill`
  already uses (or have `addAudioFile` simply enqueue and let one coalescing
  sweep drain it), and make it decode through `loadAndDecodeAudio` so the decode
  is shared with playback and the result lands in the buffer cache instead of
  being discarded.

---

### 🟡 A4 — nothing bounds a loudness-worker round trip, and one worker error disables the worker for the session

- **Class:** NEW
- **Where:** `src/lib/audio/loudness/analyseOffThread.ts:30-70`, `:88-110`;
  consequences at `src/lib/audio/loudness/pipeline.ts:227-245`, `:270-291`
- **Finding:** `analyseAudioBufferOffThread` posts to the worker and awaits a
  reply with no deadline:

  ```ts
  return await new Promise<LoudnessAnalysis>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    instance.postMessage(
      { id, channels, sampleRate },
      channels.map((c) => c.buffer),
    );
  });
  ```

  Only two things ever settle it: a matching `onmessage`, or `onerror`. There is
  no `messageerror` handler and no timeout, so a worker that is killed (memory
  pressure — see A3 for how it gets there) or a reply that fails to deserialise
  leaves the entry in `pending` forever.

  That hang propagates: `analyseAndStore` awaits it, `runBackfillSweep` awaits
  `Promise.all(batch.map(…))` (`pipeline.ts:227`), so `step` is never
  rescheduled, the sweep's promise never resolves, `backfillInFlight` never
  clears (`pipeline.ts:285-289`), and every later `runBackfill()` — including
  the re-analyse button and every `refreshProfileLoudness` on profile
  activation — joins a dead promise. That is precisely the failure mode the
  `.catch` at `pipeline.ts:234-245` was written to prevent for a _different_
  cause; the worker reopens the same hole upstream of it.

  Secondly, `onerror` sets `workerUnavailable = true` permanently
  (`analyseOffThread.ts:57-67`) and never retries. One transient failure and
  every subsequent analysis silently runs on the main thread again — R3's freeze
  back, with no signal. (The fallback path itself is correct: it calls the same
  `analyseLoudness`, so worker and main thread cannot diverge numerically.)

  Third, the test seam `resetLoudnessWorker()` does `pending.clear()` without
  rejecting, so anything awaiting at that moment hangs.

- **Impact:** a single unanswered analysis wedges all loudness backfill for the
  session — new sounds stay unmeasured and play at 0 dB normalisation with no
  error anywhere, and the re-analyse button does nothing. A single worker error
  quietly downgrades to the behaviour R3 was raised to remove.
- **Fix:** give each request a timeout (`AbortSignal.timeout`-style: a
  `setTimeout` that rejects and deletes from `pending`, generous — a minute —
  since long files are legitimately slow); the existing `catch` then falls back
  to the main thread. Add a `messageerror` handler alongside `onerror`. Reject
  rather than drop in `resetLoudnessWorker`. Consider making `workerUnavailable`
  recoverable — e.g. re-create once on the next request after an error rather
  than never again.

---

### 🟢 A5 — a stop during the decode fallback leaves the pad's loading overlay up forever

- **Class:** NEW
- **Where:** `src/lib/audio/controls.ts:546-580`, with the wiring at
  `src/lib/audio/triggerPad.ts:91-99` and the UI at `PadGrid.tsx:125` /
  `Pad.tsx:411-423`
- **Finding:** `loadAndDecodeAudioInstant` reports a loading state before it
  does anything (`decoder.ts:540-545`), which `triggerPad` forwards to
  `loadingStoreActions.setPadLoadingState`. The only two things that clear it
  are `onAudioReady` and `onError`. The stop-cancel branch calls neither:

  ```ts
  // Bail out if a stop was requested while we were loading
  if (stopRequestedSince(playbackKey, triggerGeneration)) {
    console.log(`… Load cancelled by a stop request for key: ${playbackKey}`);
    return;
  }
  ```

  `PadGrid.tsx:125` passes `isLoading={loadingState !== null}`, so the entry
  left behind keeps `Pad.tsx:411`'s overlay mounted. Since the leftover status
  is `"ready"`, none of the three text branches match and the pad shows a
  spinner with no label over a full progress bar until the next successful
  trigger of that pad clears it.

  Reachability is narrow on its own — the decode path is only entered when
  media-element streaming fails for that file — but it is exactly the path A1
  strands, and ESC during a slow load is an ordinary thing to do.

- **Fix:** clear the loading state on the cancellation branches too — simplest
  is to give `triggerPad` a `finally` that clears the key, since every terminal
  outcome (played, failed, cancelled) wants it gone.

---

## Verified clean (checked, and holds)

- **P1 / P2 are genuinely fixed.** `claimPlaybackKey` (`playback.ts:307-318`)
  disposes a displaced occupant before overwriting the map entry, so a rapid
  retrigger can no longer strand a track outside `stopAllTracks`' reach.
  Generations are split into one global (`stopAllTracks`, `playback.ts:876`) and
  one per key (`stopTrack`, `:813-816`), read through
  `stopRequestedSince(key, captured)` — stopping pad B cannot cancel pad A's
  pending trigger. `controls.ts` re-baselines after its own bookkeeping stops
  (`:527`), which is what keeps the decode fallback alive.
- **The gain single-source rule holds.** An exhaustive grep for level arithmetic
  (`10 ** (…/20)`, `Math.pow(10`, `20 * Math.log10`) outside
  `loudness/gain.ts` finds only measurement (`query.ts:22,75`), the K-filter
  shelf coefficient (`kWeighting.ts:43`), the `MAX_GAIN` constant and a test
  fixture. `overview.ts:87` and `controls.ts:392` both call `resolveGain`, and
  both feed it the same defaults, so the table cannot disagree with playback.
- **AU4 and AU6 are fixed.** `handleAudioFallback` returns
  `{ buffer, audioFileId }` and `buildPlayParams(playingFileId)` recomputes
  trim, gain and the reported id from the substitute (`controls.ts:200-259`,
  `:415-453`). `getAvailableIndices?()` is on the `PlaybackStrategy` interface
  (`types.ts:46`), so the round-robin cast is gone.
- **The BS.1770 maths is right.** The sliding block sum (`analyse.ts:91-117`)
  adds the entering hop and subtracts the leaving one over the correct ranges
  and resyncs every 512 blocks; channel weights exclude LFE and weight surrounds
  at 1.41 only for the layouts Web Audio actually defines (`analyse.ts:35-44`);
  K-weighting is derived per sample rate by bilinear transform rather than
  hardcoded at 48 kHz (`kWeighting.ts`); the true-peak polyphase branches are
  normalised to unity DC and phase 0 is the raw sample (`truePeak.ts:25-65`,
  `:90-94`); `measureRange` includes only fully-contained gating blocks but any
  overlapping peak hop, which is the right asymmetry (`query.ts:58-83`).
- **The worker really is emitted.** `npm run build` (exit 0) produces
  `turbopack-worker-*.js` plus a chunk containing `self.onmessage` and the
  analysis code, so the `new URL("./analyse.worker.ts", import.meta.url)`
  construction is not silently falling back to the main thread in production.
- **Object URLs and media elements are disposed exactly once**
  (`disposedMediaElements` WeakSet, `playback.ts:65,212-233`), including on the
  displaced-by-claim path, the fade-completed-but-key-taken path
  (`:759-770`) and the constructor-threw path (`:591-593`).
- **The buffer cache is sound**: byte-accurate accounting, reference-counted
  pins balanced by `armTrack`/`removeArmedTrack`/`clearAllArmedTracks`
  (`playbackStore.ts:145-183`), and the interval only runs while entries exist.
- **`getStrategy` keying is correct** — stateful strategies are per playback key
  and the maps are bounded by pad count.
