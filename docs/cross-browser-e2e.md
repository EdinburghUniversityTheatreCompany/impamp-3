# Cross-browser E2E: what Firefox and WebKit actually tell us

The Playwright suite gates on **chromium only**. Firefox and WebKit run in CI
as a separate, non-gating `e2e-cross-browser` job (`continue-on-error: true`).

This document records why, so nobody re-triages these failures from scratch or
"fixes" them by changing the app. Both browsers were run to completion locally
and in CI on 2026-08-13 (commit `f0486eb`).

## Summary

| Project  | Local         | CI        | Cause                               |
| -------- | ------------- | --------- | ----------------------------------- |
| chromium | 64 passed     | 64 passed | — (this is the gate)                |
| firefox  | **64 passed** | 17 failed | No audio device on the CI runner    |
| webkit   | 38 failed     | 38 failed | WebKit can't put Blobs in IndexedDB |

Neither failure mode is a bug a user would hit. Neither is worth gating on.

## WebKit — cannot store a Blob in IndexedDB

Every WebKit failure has the same origin. Assigning a sound to a pad dies at:

```
UnknownError: Error preparing Blob/File data to be stored in object store
```

Playwright ships the WPE MiniBrowser build of WebKit on Linux, and that build
rejects **every** Blob written to IndexedDB. Putting a `File`, an in-memory
`Blob` and an `ArrayBuffer` into a scratch object store from `page.evaluate`
gives:

| value stored             | chromium | firefox | webkit         |
| ------------------------ | -------- | ------- | -------------- |
| `File` from a file input | ok       | ok      | `UnknownError` |
| in-memory `Blob`         | ok       | ok      | `UnknownError` |
| empty `Blob`             | ok       | ok      | `UnknownError` |
| `ArrayBuffer`            | ok       | ok      | ok             |

An _empty_ Blob fails, so this is not about size, and not about the file-backed
handle `setInputFiles` hands the page.

impamp stores audio as `AudioFile.blob`, written through `addAudioFile` in
`src/lib/db.ts`. So under WebKit no pad ever receives a sound, and that single
failure cascades into all 38: armed-tracks, audio-playback, edit-mode,
pad-disable, search-modal and import-export all assume a pad with a sound on it.
The 26 that pass are the ones that never touch audio.

**This is not a Safari bug.** Blob-in-IndexedDB is a normal, working pattern in
released Safari; it is this headless Linux build that lacks it. A red WebKit run
is therefore not evidence of anything broken for Safari users.

**What it would take to go green:** store `ArrayBuffer` in the `audioFiles`
object store instead of `Blob`, and migrate existing records. That is a real
schema change to production data, taken on solely to satisfy a harness
limitation. Not worth it. If the `audioFiles` schema is ever revised for other
reasons, prefer `ArrayBuffer` and WebKit comes along for free.

## Firefox — passes locally, fails in CI for want of an audio device

Firefox is **64/64 green locally**. In CI, 17 tests fail, and all of them fail
the same way: the sound is assigned and the pad renders it, but nothing ever
appears in the active-tracks panel — playback never starts.

GitHub's `ubuntu-latest` runner has no audio output device. A development
machine running PipeWire or PulseAudio does. Chromium tolerates the missing sink
in a way Firefox does not.

**What it would take to go green:** give the runner a dummy sink (install
`pulseaudio` and start it, or a PipeWire equivalent) in the
`e2e-cross-browser` job. That is plausible and fairly cheap — but it buys a
green tick on a browser that already passes on every machine a developer
actually has, so it has not been done.

## Running them yourself

Not part of the everyday loop — downloading these browsers is slow and the fast
feedback path stays chromium.

```bash
npx playwright install firefox webkit
npx playwright test --project=firefox --workers=2
npx playwright test --project=webkit  --workers=2
```

`--workers=2` matters. Playwright sizes its default pool from the CPU count, and
on a many-core machine with modest free RAM that pool gets OOM-killed — the run
dies with exit code 137 and no output at all.
