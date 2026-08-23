/**
 * Running the same async work over many items, a few at a time.
 *
 * Sync moves audio one file per network round trip, and until now it did so
 * strictly in series everywhere except one place. A first sync of a 960-sound
 * board is 960 sequential uploads — at a conservative 400ms each, about six
 * minutes of pure waiting, during which the run holds
 * `withAudioImportInProgress` and therefore blocks every orphan sweep and
 * audio deleter.
 *
 * The Drive *download* path already knew this and ran a four-way pool
 * (`DRIVE_DOWNLOAD_CONCURRENCY` in `importExport.ts`); the upload paths and the
 * hosted-audio paths did not. This is that pool, extracted so there is one of
 * it rather than four — the duplication gate runs at threshold 0, so a second
 * hand-rolled copy fails the commit rather than the review.
 *
 * @module lib/concurrency
 */

/**
 * The default width of a pool.
 *
 * Four, because that is what the Drive downloader has used in production and
 * because it is comfortably under what a browser will open to one host anyway.
 * Higher would not go faster; it would just queue in the socket pool instead of
 * here, while making a slow response harder to attribute.
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Runs `work` over every item, at most `concurrency` at a time.
 *
 * Items are taken in order but **complete out of order**, so anything the
 * callback accumulates must not depend on completion order. Nothing this
 * replaces did — the callers collect warnings and counters, not sequences.
 *
 * A callback that throws rejects the whole run, as `Promise.all` would; every
 * current caller catches per item, which is what lets one bad file be reported
 * without abandoning the rest.
 *
 * `concurrency <= 1` runs strictly in series, which is worth keeping as a real
 * path rather than a degenerate pool: it is what a caller asks for when it
 * wants failures attributable in order, and the importer already exposed it.
 *
 * @param items - What to work through
 * @param concurrency - How many may be in flight at once
 * @param work - Called once per item, with its index
 */
export async function forEachWithConcurrency<T>(
  items: Iterable<T>,
  concurrency: number,
  work: (item: T, index: number) => Promise<void>,
): Promise<void> {
  // Materialised because callers pass a `Set` as readily as an array — the
  // audio ids a profile names are a Set — and a shared cursor needs indexing.
  const list = Array.isArray(items) ? (items as T[]) : [...items];
  if (list.length === 0) return;

  if (concurrency <= 1) {
    for (let i = 0; i < list.length; i++) {
      await work(list[i], i);
    }
    return;
  }

  // A shared cursor rather than pre-slicing into `concurrency` chunks: the
  // items here are audio files of wildly different sizes, and a static split
  // leaves one worker holding every large file while the others have finished.
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, list.length) },
    async () => {
      while (next < list.length) {
        const index = next++;
        await work(list[index], index);
      }
    },
  );

  await Promise.all(workers);
}
