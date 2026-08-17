# State of play — 2026-08-17 (evening)

Both whole-repo reviews are answered. `plans/repo-review-2026-08-17.md` is the
report; `plans/review-2026-08-17/` holds the per-axis detail.

**Every 🔴 in that review is closed.** What remains is 🟡/🟢 plus a handful of
items discovered while fixing, and four decisions that are Mick's.

## Gates on `main`

802 unit tests + 1 expected failure · 152 chromium e2e · line coverage 38.5%
with a CI ratchet · typecheck, eslint, prettier, jscpd 0%, version-sync,
action-pins, actionlint, zizmor all clean · production image builds and runs.

**Running e2e:** always `E2E_PORT=<free port>`. Port 3000 is often held by
another project of Mick's, and `reuseExistingServer` does not check _what_ is
listening — a collision reports every test failing. And never read a piped
`tail`/`grep` as the verdict; redirect to a file and echo `$?`.

## Open, by size of the thread

1. **Duplication tail — D2, D3, D4, D5, D6, D7, D9, D11, D13, D14, D15, D19.**
   Verified still present: `getHashlessIndex` is two copies (`googleDrive/sync.ts`,
   `serverAudio/transfer.ts`); Drive-token construction is spread across three
   hooks; the pad-save sequence is open-coded at six sites; `Pad` still takes
   both `isConfigured` and `soundCount`. This is the repo's signature failure
   mode and the largest remaining block.
2. **Test 🟡 tail — T19, T20, T22, T23, T25, T28, T30, T31, T32, T33.** Mostly
   assertions that are weaker than they look, plus T31 (no e2e at all for hosted
   audio, SSE, share revocation, trimming, admin authz) and T30 (CI is the most
   forgiving config, so it cannot see this suite's flake class).
3. **Sync — SY4, SY7, SY8, SY9.** SY4 matters most: audio downloaded from Drive
   is stored under the hash the _sender_ claimed, never verified. The hosted
   path computes a hash (`serverAudio/transfer.ts:139`); the Drive path does not.
4. **Performance — P2, P3, P4, P5, P8.** P3 is measured: `@hello-pangea/dnd` is
   28.3 KB gzipped of a 326.5 KB first load, for a library reachable only after
   the pad editor opens. The fix is in `usePadInteractions` / `modalRegistry`.
   **P6 is a correction, not a task** — the `structuredClone` fix the earlier
   review prescribed measures 18% worse. Do not apply it.
5. **Server — SV5, SV6, SV14.** SV6 verified still live: the Drive proxy's
   origin gate keeps a `Referer` fallback, which is one `curl -H` away.
6. **R6** — `/drive/open` signs you out of Google when the sign-in popup fails,
   because the shared hook clears auth and the three copies it replaced did not.
   Verified present; whether it is wrong is a judgement call.

## Found while fixing, not in the review

- **T8 is a live product bug.** An import racing an orphan cleanup
  deterministically leaves a pad naming a deleted audio file:
  `importAudioSources` commits each file in its own transaction and writes pads
  later. Recorded as an expected failure that goes red when fixed. **The fix is
  a design choice** — grace period on recent audio, one transaction spanning the
  import, or a lock.
- **Tab is suppressed app-wide**, so Help, Search, the bank tabs and the profile
  selector are keyboard-unreachable. This is C2's other half.
- **`useSearch` hard-codes `Bank N`**, contradicting the review's own premise
  for C9.
- **The "N of M pads failed" import message is unreachable**: a rejected
  IndexedDB request aborts the transaction before the message is assembled. The
  outcome is still right; the wording is dead.
- **Theme-colour drift**: `layout.tsx` `#000000` vs `manifest.ts` `#f2801f`.
- **A pre-existing audio-start flake** in `activatePad`, seen once and not
  catalogued by the review.
- Analysing a _newly added_ sound while offline runs on the main thread — an
  accepted cost of never caching worker scripts.

## Mick's calls

- **`IMPAMP_ALLOWED_EMAILS`** on the public host.
- **SV8 / SV9** — rate limiting and per-account quotas. Declined deliberately:
  the quota numbers are the policy, and a per-IP limiter has to know which proxy
  header to trust behind Kamal.
- **T8's design choice**, above.
- **Deploy.** Nothing has shipped. The production `impamp_data` volume was
  chowned to uid 1000 in an earlier session, with a verified backup first.
