# Audio Deduplication and Bank Transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every inbound audio path reuse a row that already holds the same bytes. Then let a user export any number of banks to a `.iaz` archive. Then let the user import those banks into the active profile.

**Architecture:** A content hash decides reuse at each write. A new `reused` flag tells a rollback which rows it may delete. A new archive format, `exportVersion: 4`, holds N banks and one shared audio folder. The import reads the manifest first, asks the user where each bank goes, then writes each bank through one core function. Audio reuse keeps a re-import of a bank into its source profile from the addition of new blobs.

**Tech Stack:** TypeScript 6 strict, Next.js 16, React 19, Zustand 5, idb 8 over IndexedDB. Archives use `@zip.js/zip.js`. Tests use Vitest 4.1 with `fake-indexeddb`, and Playwright 1.62 for E2E.

**Spec:** docs/superpowers/specs/2026-08-19-banks-and-layering-design.md (§1 and §2)

**Depends on:** the bank identity plan (docs/superpowers/plans/2026-08-19-bank-identity-and-reordering.md) must be merged first.

## Global Constraints

- Node 24.19.0 everywhere. `node:sqlite` sets the floor at 22.13.
- Vitest 4.1 runs in the **node** environment. There is no DOM and no IndexedDB by default.
- A database test imports `@/lib/testSupport/browserGlobals` **first**, then imports `db.ts` and `importExport.ts` **dynamically**. Static imports are hoisted above the `window` assignment.
- `getDb` memoises its connection. Each suite empties the object stores between tests with `clearAllStores()`.
- autoIncrement counters keep their value across `clearAllStores()`. Assert against an id the store returned, never a literal.
- `@zip.js/zip.js` is the only archive library. Load it through `getZipJs()`, which turns web workers off.
- TypeScript strict mode is on. Path alias `@/*` maps to `src/*`.
- Run the unit suite with `npm test`. Run the E2E suite with `npm run test:e2e`.
- The coverage floor in `vitest.config.ts` is a ratchet. Raise it when a run comes in above it. Never lower it.
- `hk` runs prettier before each commit. Run `npx prettier --write <files>` if a commit fails on format.
- `audioGainSettings` and `audioTrimSettings` are keyed by audio file id. Every re-key goes through `remapAudioFileIdKeys`, `remapPadSettingsOnImport` or `extractPadPlaybackSettings`. A hand-rolled copy is what CLAUDE.md forbids.
- An IndexedDB transaction closes on the first `await` that is not one of its own requests. Compute each hash **before** you open a transaction.
- §0 is merged, so `PadConfiguration` has `bankId: string` and has no `pageIndex`. `PageMetadata` has both `bankId` and `pageIndex`. The unique pad index is `[profileId, bankId, padIndex]`.
- Do not import `src/lib/server/**` from any client module.
- Commit after each step that has a green test run. Keep each commit atomic.

---

## File Structure

| File                                                    | Responsibility                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/db.ts`                                         | Add `addOrReuseAudioFile`, `findAudioFileIdByHashIn`, `startBackgroundAnalysis`; export `clearAudioCacheEntries`            |
| `src/lib/db.audioDedup.test.ts`                         | New. Unit tests for reuse on write and for cross-profile delete safety                                                      |
| `src/lib/audioDedup.ts`                                 | New. Find and collapse duplicate audio rows already in the database                                                         |
| `src/lib/audioDedup.test.ts`                            | New. Unit tests for the preview and the collapse                                                                            |
| `src/lib/importExport.ts`                               | Reuse audio inside `importAudioSources`; export the ZIP entry readers and `getZipJs`                                        |
| `src/lib/importExport.dedup.test.ts`                    | New. Unit tests for reuse and rollback along the import paths                                                               |
| `src/lib/bankTransfer.ts`                               | New. `BankExport`, bank collection, `exportBanksToZip`, `readArchiveManifest`, `writeBankIntoProfile`, `importBanksFromZip` |
| `src/lib/bankTransfer.test.ts`                          | New. Unit tests for the bank round trip, placement, capacity and rollback                                                   |
| `src/lib/bankUtils.ts`                                  | Add the `MAX_BANKS` constant                                                                                                |
| `src/hooks/pad/usePadDrop.ts`                           | Reuse an audio row when a file is dropped on a pad                                                                          |
| `src/components/modals/EditPadForm.tsx`                 | Reuse an audio row when a sound is added in the pad editor                                                                  |
| `src/components/modals/BulkImportModalContent.tsx`      | Reuse an audio row during a bulk assignment                                                                                 |
| `src/lib/googleDrive/sync.ts`                           | Reuse an audio row after a Drive download                                                                                   |
| `src/lib/serverAudio/transfer.ts`                       | Reuse an audio row after a hosted download                                                                                  |
| `src/store/profileStore.ts`                             | Actions `exportBanksToZip` and `importBanksFromArchive`                                                                     |
| `src/components/profiles/ProfileManager.tsx`            | The "Export banks" section, the bank import branch, and the duplicate audio panel                                           |
| `src/components/profiles/BankImportPlacementDialog.tsx` | New. The per-bank placement dropdowns and the capacity line                                                                 |
| `src/app/page.tsx`                                      | Use `MAX_BANKS` in place of the literal 20                                                                                  |
| `e2e-tests/bank-transfer.spec.ts`                       | New. Export two banks, import them back, assert both grids                                                                  |
| `CLAUDE.md`                                             | Record the new format and the new helpers                                                                                   |

---

# Part A — Audio deduplication by content hash

## Task 1: `addOrReuseAudioFile`

**Files:**

- `src/lib/db.ts` — add after `addAudioFile` (line 562-592) and after `getAudioFileByHash` (line 734)
- `src/lib/db.audioDedup.test.ts` — new file

**Interfaces:**

Consumes:

```ts
export async function computeBlobHash(blob: Blob): Promise<string>;
export interface AudioFile {
  id?: number;
  blob: Blob;
  name: string;
  type: string;
  hash?: string;
  createdAt: Date;
  driveFileIds?: Record<number, string>;
  loudness?: LoudnessAnalysis;
  serverHosted?: boolean;
}
```

Produces:

```ts
export async function findAudioFileIdByHashIn(
  hashIndex: { getAll(key: string): Promise<AudioFile[]> },
  hash: string,
): Promise<number | undefined>;

export async function addOrReuseAudioFile(
  audioFile: Omit<AudioFile, "id" | "createdAt">,
): Promise<{ id: number; reused: boolean }>;
```

**Why this is a second function and not a change to `addAudioFile`:** the import rollback calls `deleteUnreferencedAudioFiles(createdAudioIds)`. A rollback must never delete a row that it only reused. The `reused` flag is the one piece of information that lets a caller tell a new row from a reused one. Silent reuse inside `addAudioFile` would take that information away from every current caller.

### Steps

- [ ] **Step 1: Write the test for reuse on a hash match.**

  Create `src/lib/db.audioDedup.test.ts`:

  ```ts
  /**
   * Reuse of an audio row that already holds the same bytes.
   *
   * `addAudioFile` computes a content hash and then adds a row anyway, so the
   * same sound imported twice has always cost two blobs. The reuse rule lives
   * in a second function rather than inside `addAudioFile`, because the import
   * rollback deletes what it created and must never delete a row it reused.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const { addAudioFile, addOrReuseAudioFile, computeBlobHash, getDb } =
    await import("./db");

  /** The same bytes every time, as a fresh Blob. */
  function horn(): Blob {
    return new Blob(["the horn bytes"], { type: "audio/wav" });
  }

  beforeEach(async () => {
    await clearAllStores();
  });

  describe("addOrReuseAudioFile", () => {
    it("returns the id of the row that already holds these bytes", async () => {
      const first = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });
      const second = await addOrReuseAudioFile({
        name: "horn-copy.wav",
        type: "audio/wav",
        blob: horn(),
      });

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(second.id).toBe(first.id);

      const db = await getDb();
      expect(await db.getAll("audioFiles")).toHaveLength(1);
    });

    it("adds a row when the bytes are new", async () => {
      const first = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });
      const second = await addOrReuseAudioFile({
        name: "stab.wav",
        type: "audio/wav",
        blob: new Blob(["different bytes"], { type: "audio/wav" }),
      });

      expect(second.reused).toBe(false);
      expect(second.id).not.toBe(first.id);

      const db = await getDb();
      expect(await db.getAll("audioFiles")).toHaveLength(2);
    });

    it("reuses a row that `addAudioFile` wrote earlier", async () => {
      // The library a user already has was written by the old path. Reuse has
      // to see those rows, or the first import after the upgrade duplicates
      // every sound on the board.
      const oldId = await addAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });

      const result = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });

      expect(result).toEqual({ id: oldId, reused: true });
    });

    it("trusts a hash the caller supplies, and does not read the blob", async () => {
      // Sync and archive paths carry a hash with each reference. Trusting it
      // is what lets a shared sound be reused before its bytes are read.
      const declared = await computeBlobHash(horn());
      const first = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
        hash: declared,
      });

      const second = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: new Blob(["other bytes entirely"], { type: "audio/wav" }),
        hash: declared,
      });

      expect(second).toEqual({ id: first.id, reused: true });
    });

    it("stores the hash on the row it creates", async () => {
      const { id } = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });

      const db = await getDb();
      const record = await db.get("audioFiles", id);
      expect(record?.hash).toBe(await computeBlobHash(horn()));
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/db.audioDedup.test.ts
  ```

  Expect: `SyntaxError: The requested module './db' does not provide an export named 'addOrReuseAudioFile'`.

- [ ] **Step 3: Extract the background analysis trigger.**

  In `src/lib/db.ts`, cut the `if (typeof window !== "undefined")` block from `addAudioFile` (lines 578-591) into a module function above `addAudioFile`:

  ```ts
  /**
   * Starts the loudness analysis for one new audio file.
   *
   * Shared by `addAudioFile` and `addOrReuseAudioFile` so that a row gets its
   * analysis from either writer. A reused row keeps the analysis it has, which
   * is the whole saving: each set of bytes is analysed once.
   */
  function startBackgroundAnalysis(id: number): void {
    if (typeof window === "undefined") return;
    void import("@/lib/audio/loudness/pipeline")
      .then(({ analyseAndStore }) => analyseAndStore(id))
      .catch((error) => {
        console.warn(
          `[Loudness] Background analysis failed for audio file ${id}:`,
          error,
        );
      });
  }
  ```

  Replace the cut block in `addAudioFile` with `startBackgroundAnalysis(id);`.

- [ ] **Step 4: Add the two new functions.**

  In `src/lib/db.ts`, below `getAudioFileByHash` (line 734-742):

  ```ts
  /**
   * The one answer to "does a row already hold these bytes?".
   *
   * Takes the index rather than the hash alone, so a caller that is already
   * inside a transaction can ask without opening a second one — which is what
   * keeps the decision and the write atomic in `addOrReuseAudioFile` and in
   * `importAudioSources`. Two copies of this rule would drift.
   */
  export async function findAudioFileIdByHashIn(
    hashIndex: { getAll(key: string): Promise<AudioFile[]> },
    hash: string,
  ): Promise<number | undefined> {
    const matches = await hashIndex.getAll(hash);
    return matches.find((file) => file.id !== undefined)?.id;
  }

  /**
   * Adds an audio file, or returns the id of the row that already holds these
   * bytes.
   *
   * Deliberately separate from `addAudioFile`. Callers use the return value to
   * decide what to clean up: `importProfileCore` hands its created ids to
   * `deleteUnreferencedAudioFiles` when an import fails, and a rollback must
   * never delete a row that another profile depends on. `reused` is what lets
   * the caller tell the two apart.
   *
   * The hash is computed before the transaction opens. `crypto.subtle` is not
   * an IndexedDB request, so an await on it inside a transaction closes it.
   */
  export async function addOrReuseAudioFile(
    audioFile: Omit<AudioFile, "id" | "createdAt">,
  ): Promise<{ id: number; reused: boolean }> {
    const hash = audioFile.hash ?? (await computeBlobHash(audioFile.blob));
    const db = await getDb();
    const tx = db.transaction("audioFiles", "readwrite");
    const store = tx.objectStore("audioFiles");

    const existingId = await findAudioFileIdByHashIn(store.index("hash"), hash);
    if (existingId !== undefined) {
      await tx.done;
      return { id: existingId, reused: true };
    }

    const id = await store.add({ ...audioFile, hash, createdAt: new Date() });
    await tx.done;
    startBackgroundAnalysis(id);
    return { id, reused: false };
  }
  ```

- [ ] **Step 5: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/db.audioDedup.test.ts
  ```

  Expect 5 passed.

- [ ] **Step 6: Run the whole suite, then commit.**

  ```bash
  npm test
  git add src/lib/db.ts src/lib/db.audioDedup.test.ts
  git commit -m "feat(db): add addOrReuseAudioFile, which reuses a row by content hash"
  ```

---

## Task 2: Reuse inside the import audio writer

**Files:**

- `src/lib/importExport.ts` — `AudioImportOutcome` (line 408-414), `importAudioSources` (line 471-559), `importProfileCore` (line 880 pushes the created ids)
- `src/lib/importExport.dedup.test.ts` — new file

**Interfaces:**

Consumes: `findAudioFileIdByHashIn`, `computeBlobHash` from `./db`.

Produces:

```ts
interface AudioImportOutcome {
  /** Original export id → the id the local store assigned. */
  audioIdMap: Map<number, number>;
  /** Only the rows this import created, so a rollback deletes no reused row. */
  createdIds: number[];
  failures: AudioImportFailure[];
}
```

**Design note:** the reuse check runs **before** `getBlob()` when the source carries a hash. `AudioFileRef.hash` and `ProfileSyncData`'s audio refs both carry one, so a sound that two banks share costs one read of the archive rather than two. When the source has no hash, the blob is read, the hash is computed, and the check runs a second time inside the write transaction. The second check closes the window that the blob read opens.

### Steps

- [ ] **Step 1: Write the test for reuse and rollback.**

  Create `src/lib/importExport.dedup.test.ts`:

  ```ts
  /**
   * What an import does when the library already holds the bytes.
   *
   * Audio rows are global, not per profile, so the same sounds imported twice
   * used to cost two blobs. Reuse fixes that, and it makes the rollback rule
   * load-bearing: a failed import must delete only the rows it created, or a
   * retry takes a sound out from under a profile that was here first.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const {
    exportProfilesToZip,
    importProfilesFromZip,
    importProfileFromSyncData,
  } = await import("./importExport");
  const {
    getDb,
    addAudioFile,
    addProfile,
    computeBlobHash,
    upsertPadConfiguration,
    upsertPageMetadata,
  } = await import("./db");
  type ProfileSyncData = import("./syncUtils").ProfileSyncData;

  const SHARED_BYTES = "the shared horn bytes";

  function sharedBlob(): Blob {
    return new Blob([SHARED_BYTES], { type: "audio/mpeg" });
  }

  async function seedProfile(name: string) {
    const profileId = await addProfile({ name, syncType: "local" });
    const audioFileId = await addAudioFile({
      name: "horn.mp3",
      type: "audio/mpeg",
      blob: sharedBlob(),
    });
    await upsertPadConfiguration({
      profileId,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      audioFileIds: [audioFileId],
      playbackType: "sequential",
    });
    await upsertPageMetadata({
      profileId,
      bankId: "0",
      pageIndex: 0,
      name: "Opening",
      isEmergency: false,
    });
    return { profileId, audioFileId };
  }

  beforeEach(async () => {
    await clearAllStores();
  });

  describe("importing bytes the library already holds", () => {
    it("adds a second profile but no second blob", async () => {
      const db = await getDb();
      const { profileId, audioFileId } = await seedProfile("Show board");

      const archive = await exportProfilesToZip([profileId], "blob");
      await importProfilesFromZip(archive!, db);

      expect(await db.getAll("profiles")).toHaveLength(2);
      expect(await db.getAll("audioFiles")).toHaveLength(1);

      const imported = (await db.getAll("profiles")).find(
        (p) => p.id !== profileId,
      )!;
      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        imported.id!,
      );
      expect(pads[0].audioFileIds).toEqual([audioFileId]);
    });

    it("leaves a row that the failed import only reused", async () => {
      // The row is an orphan: no pad names it. Without the reused flag the
      // rollback would count it as one of its own and delete it.
      const db = await getDb();
      const orphanId = await addAudioFile({
        name: "orphan.mp3",
        type: "audio/mpeg",
        blob: sharedBlob(),
      });

      await expect(
        importProfileFromSyncData(db, collidingPads(), async () =>
          sharedBlob(),
        ),
      ).rejects.toThrow();

      expect(await db.get("audioFiles", orphanId)).toBeDefined();
      expect(await db.getAll("profiles")).toHaveLength(0);
    });

    it("still deletes a row that the failed import created", async () => {
      const db = await getDb();

      await expect(
        importProfileFromSyncData(db, collidingPads(), async () =>
          sharedBlob(),
        ),
      ).rejects.toThrow();

      expect(await db.getAll("audioFiles")).toHaveLength(0);
    });
  });

  /**
   * Two pads on one bank and pad index. The second breaks the unique index, so
   * the pad writer throws after the audio is already written.
   */
  function collidingPads(): ProfileSyncData {
    const pad = {
      profileId: 42,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      playbackType: "round-robin" as const,
      audioFileIds: [200],
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    return {
      _syncFormatVersion: 2,
      profile: {
        id: 42,
        name: "Board",
        syncType: "local",
        backupReminderPeriod: 1234,
        lastBackedUpAt: 555,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      pageMetadata: [],
      padConfigurations: [pad, { ...pad, name: "Collides" }],
      audioFiles: [
        {
          id: 200,
          name: "horn.mp3",
          type: "audio/mpeg",
          driveFileId: "drive-1",
        },
      ],
    } as unknown as ProfileSyncData;
  }
  ```

  The reuse test above deliberately supplies no hash on the sync ref, so the blob read path is the one under test. `computeBlobHash` is imported for the next step's use and to keep the import list stable.

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/importExport.dedup.test.ts
  ```

  Expect the first test to fail with `expected [ …2 items… ] to have a length of 1 but got 2`, and the second to fail because the orphan row is gone.

- [ ] **Step 3: Add `createdIds` to the outcome type.**

  In `src/lib/importExport.ts`, change `AudioImportOutcome` (line 408):

  ```ts
  /** What `importAudioSources` managed to write, and what it did not. */
  interface AudioImportOutcome {
    /** Original export id → the id the local store assigned. */
    audioIdMap: Map<number, number>;
    /**
     * Only the rows this import created.
     *
     * The rollback deletes from this list, so a row that was merely reused
     * stays. `audioIdMap.values()` used to fill that role, and once reuse
     * exists it names rows another profile depends on.
     */
    createdIds: number[];
    failures: AudioImportFailure[];
  }
  ```

- [ ] **Step 4: Add the reuse branch to `importAudioSources`.**

  Add `findAudioFileIdByHashIn` to the `./db` import list at the top of `src/lib/importExport.ts`.

  Add this helper above `importAudioSources`:

  ```ts
  /** The id of a row that already holds these bytes, in its own transaction. */
  async function findExistingAudioId(
    db: IDBPDatabase<ImpAmpDBSchema>,
    hash: string,
  ): Promise<number | undefined> {
    const tx = db.transaction("audioFiles", "readonly");
    const id = await findAudioFileIdByHashIn(
      tx.objectStore("audioFiles").index("hash"),
      hash,
    );
    await tx.done;
    return id;
  }
  ```

  Inside `importAudioSources`, declare `const createdIds: number[] = [];` beside `audioIdMap`, replace the body of `importOne`'s `try` block, and return `createdIds`:

  ```ts
  const importOne = async (
    source: ImportAudioSource,
    reportBytes: boolean,
  ): Promise<void> => {
    try {
      // A hash the source already carries lets the reuse check run before
      // the bytes are read. Archive refs and sync refs both carry one, so a
      // sound that two banks share costs one extraction rather than two.
      const knownId = source.hash
        ? await findExistingAudioId(db, source.hash)
        : undefined;

      if (knownId !== undefined) {
        audioIdMap.set(source.originalId, knownId);
      } else {
        const blob = await source.getBlob(
          reportBytes
            ? (bytesDone) => {
                onProgress?.({
                  fileName: source.name,
                  processedFiles: completedFiles,
                  totalFiles: audioSources.length,
                  processedBytes: processedBytes + bytesDone,
                  totalBytes,
                });
              }
            : undefined,
        );
        const hash = source.hash ?? (await computeBlobHash(blob));
        const audioTx = db.transaction("audioFiles", "readwrite");
        const store = audioTx.objectStore("audioFiles");
        // Asked a second time inside the write transaction, because the blob
        // read above is a window in which another writer could land the same
        // bytes. Deciding and writing in one transaction closes it.
        const raced = await findAudioFileIdByHashIn(store.index("hash"), hash);
        let newAudioId: number;
        if (raced === undefined) {
          newAudioId = await store.add({
            blob,
            name: source.name,
            type: source.type,
            createdAt: now,
            loudness: deserialiseLoudness(source.loudness) ?? undefined,
            hash,
            serverHosted: source.serverHosted,
          });
          createdIds.push(newAudioId);
        } else {
          newAudioId = raced;
        }
        await audioTx.done;
        audioIdMap.set(source.originalId, newAudioId);
      }
    } catch (error) {
      console.error(
        `Failed to import audio file: ${source.name} (Original ID: ${source.originalId})`,
        error,
      );
      failures.push({ name: source.name, error });
    }
    completedFiles++;
    processedBytes += source.size ?? 0;
    onProgress?.({
      fileName: source.name,
      processedFiles: completedFiles,
      totalFiles: audioSources.length,
      processedBytes,
      totalBytes,
    });
  };
  ```

  Change the return statement to `return { audioIdMap, createdIds, failures };`.

  Note that the record now always carries a hash. The old writer stored `hash: source.hash`, so a source without one produced a hashless row.

- [ ] **Step 5: Take the created ids from the new field.**

  In `importProfileCore` (line 874-881), change:

  ```ts
  const {
    audioIdMap,
    createdIds,
    failures: audioFailures,
  } = await importAudioSources(
    db,
    audioSources,
    now,
    onAudioProgress,
    audioConcurrency,
  );
  createdAudioIds.push(...createdIds);
  ```

- [ ] **Step 6: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/importExport.dedup.test.ts src/lib/importExport.zip.test.ts src/lib/importExport.failedImport.test.ts
  ```

  Expect all three files green.

- [ ] **Step 7: Run the whole suite, then commit.**

  ```bash
  npm test
  git add src/lib/importExport.ts src/lib/importExport.dedup.test.ts
  git commit -m "feat(import): reuse an audio row by hash, and roll back only what was created"
  ```

---

## Task 3: Reuse on every other inbound path

**Files:**

- `src/hooks/pad/usePadDrop.ts` line 71
- `src/components/modals/EditPadForm.tsx` line 184
- `src/components/modals/BulkImportModalContent.tsx` line 316
- `src/lib/googleDrive/sync.ts` line 367
- `src/lib/serverAudio/transfer.ts` line 299
- `src/lib/db.ts` line 1827, inside `replaceMissingAudioFile`

**Interfaces:**

Consumes: `addOrReuseAudioFile` from Task 1.
Produces: no new export. Each call site reads `.id` from the result.

**Scope:** these six sites are the complete list of `addAudioFile` callers outside tests. Confirm the list before you change anything:

```bash
rg -n 'addAudioFile' src/ -g '!*.test.*'
```

`src/lib/testSupport/audioFixtures.ts` may keep `addAudioFile`, because a fixture that wants two rows with the same bytes needs the writer that makes them.

### Steps

- [ ] **Step 1: Write the test for the replace path.**

  Add to `src/lib/db.audioDedup.test.ts`:

  ```ts
  describe("replaceMissingAudioFile", () => {
    it("points the pad at the row that already holds the bytes", async () => {
      const { addProfile, upsertPadConfiguration, replaceMissingAudioFile } =
        await import("./db");
      const db = await getDb();

      const profileId = await addProfile({ name: "Repair", syncType: "local" });
      const keeperId = await addAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        name: "Broken",
        audioFileIds: [999999],
        playbackType: "sequential",
      });

      const replacement = new File([horn()], "horn.wav", { type: "audio/wav" });
      await replaceMissingAudioFile(profileId, "0", 0, 999999, replacement);

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      expect(pads[0].audioFileIds).toEqual([keeperId]);
      expect(await db.getAll("audioFiles")).toHaveLength(1);
    });
  });
  ```

  After §0, `replaceMissingAudioFile` takes `bankId` in place of `pageIndex`. Check its signature before you write the call.

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/db.audioDedup.test.ts
  ```

  Expect `expected [ 2 ] to deeply equal [ 1 ]`, with a second audio row present.

- [ ] **Step 3: Change `replaceMissingAudioFile`.**

  In `src/lib/db.ts` line 1827, replace the `addAudioFile` call:

  ```ts
  // Reuse rather than add: a replacement is very often a second copy of a
  // file the library already holds, and a repair should not double it.
  const { id: newId } = await addOrReuseAudioFile({
    name: file.name,
    type: file.type,
    blob,
    hash,
  });
  ```

- [ ] **Step 4: Run the test and see it pass, then commit.**

  ```bash
  npx vitest run src/lib/db.audioDedup.test.ts
  git add src/lib/db.ts src/lib/db.audioDedup.test.ts
  git commit -m "fix(db): reuse an audio row when a missing file is replaced"
  ```

- [ ] **Step 5: Change the pad drop path.**

  In `src/hooks/pad/usePadDrop.ts`, change the import on line 12 to `addOrReuseAudioFile`, and line 71:

  ```ts
  // Reuse by content hash: the same file dropped on two pads must name
  // one row, not two.
  const { id: audioFileId } = await addOrReuseAudioFile({
    blob: file,
    name: file.name,
    type: file.type,
  });
  ```

- [ ] **Step 6: Change the pad editor path.**

  In `src/components/modals/EditPadForm.tsx`, change the import on line 28 and line 184:

  ```ts
  const { id: newFileId } = await addOrReuseAudioFile({
    blob: file,
    name: file.name,
    type: file.type,
  });
  ```

- [ ] **Step 7: Change the bulk import path.**

  In `src/components/modals/BulkImportModalContent.tsx`, change the import on line 5 and line 316:

  ```ts
  const { id: audioFileId } = await addOrReuseAudioFile({
    blob: file,
    name: file.name,
    type: file.type,
  });
  ```

- [ ] **Step 8: Change the Drive download path.**

  In `src/lib/googleDrive/sync.ts`, change the import on line 13 and line 367:

  ```ts
  await addOrReuseAudioFile({
    blob,
    name: ref.name,
    type: ref.type,
    hash: ref.hash,
    driveFileIds: { [profileId]: ref.driveFileId },
  });
  ```

  Keep the `existingFile` branch above it. That branch also backfills `driveFileIds`, which reuse alone does not do.

- [ ] **Step 9: Change the hosted download path.**

  In `src/lib/serverAudio/transfer.ts`, change the import on line 14 and line 299 to `await addOrReuseAudioFile(stored);`.

- [ ] **Step 10: Check the types, lint, and run the suite.**

  ```bash
  npx tsc --noEmit
  npm run lint
  npm test
  ```

  Expect no type errors, no lint errors, and a green suite.

- [ ] **Step 11: Commit.**

  ```bash
  git add src/hooks/pad/usePadDrop.ts src/components/modals/EditPadForm.tsx src/components/modals/BulkImportModalContent.tsx src/lib/googleDrive/sync.ts src/lib/serverAudio/transfer.ts
  git commit -m "fix(audio): reuse an audio row on every inbound path"
  ```

---

## Task 4: Cross-profile audio safety

**Files:**

- `src/lib/db.audioDedup.test.ts` — add a describe block

**Interfaces:**

Consumes: `deleteProfile`, `deleteUnreferencedAudioFiles` from `./db`.
Produces: no new code. This task adds tests to code that already exists.

**Why:** pads in different profiles now share audio rows. `deleteProfile` already keeps a row that a pad in another profile names, and `deleteUnreferencedAudioFiles` already keeps a referenced row. Both behaviours were incidental before reuse. Both are critical after it, so both get a direct test.

### Steps

- [ ] **Step 1: Write the tests.**

  Add to `src/lib/db.audioDedup.test.ts`:

  ```ts
  describe("audio shared between profiles", () => {
    /** Two profiles whose pads name the very same audio row. */
    async function twoProfilesOneSound() {
      const { addProfile, upsertPadConfiguration } = await import("./db");
      const { id: audioFileId } = await addOrReuseAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });
      const ids: number[] = [];
      for (const name of ["Show A", "Show B"]) {
        const profileId = await addProfile({ name, syncType: "local" });
        await upsertPadConfiguration({
          profileId,
          bankId: "0",
          padIndex: 0,
          name: "Horn",
          audioFileIds: [audioFileId],
          playbackType: "sequential",
        });
        ids.push(profileId);
      }
      return { audioFileId, profileIds: ids };
    }

    it("keeps the sound when one of the two profiles is deleted", async () => {
      const { deleteProfile } = await import("./db");
      const db = await getDb();
      const { audioFileId, profileIds } = await twoProfilesOneSound();

      await deleteProfile(profileIds[0]);

      expect(await db.get("audioFiles", audioFileId)).toBeDefined();
    });

    it("deletes the sound when the last profile that names it goes", async () => {
      const { deleteProfile } = await import("./db");
      const db = await getDb();
      const { audioFileId, profileIds } = await twoProfilesOneSound();

      await deleteProfile(profileIds[0]);
      await deleteProfile(profileIds[1]);

      expect(await db.get("audioFiles", audioFileId)).toBeUndefined();
    });

    it("keeps a referenced row out of a rollback sweep", async () => {
      const { deleteUnreferencedAudioFiles } = await import("./db");
      const db = await getDb();
      const { audioFileId } = await twoProfilesOneSound();

      const removed = await deleteUnreferencedAudioFiles([audioFileId]);

      expect(removed).toBe(0);
      expect(await db.get("audioFiles", audioFileId)).toBeDefined();
    });
  });
  ```

- [ ] **Step 2: Run the tests.**

  ```bash
  npx vitest run src/lib/db.audioDedup.test.ts
  ```

  Expect all green on the first run. These tests pin behaviour that already works; a red one here means `deleteProfile` or `deleteUnreferencedAudioFiles` has a cross-profile bug that reuse makes reachable. Fix the source, not the test.

- [ ] **Step 3: Commit.**

  ```bash
  git add src/lib/db.audioDedup.test.ts
  git commit -m "test(db): pin cross-profile audio safety, which reuse makes load-bearing"
  ```

---

## Task 5: `findDuplicateAudioGroups`

**Files:**

- `src/lib/audioDedup.ts` — new file
- `src/lib/audioDedup.test.ts` — new file
- `src/lib/db.ts` — export `clearAudioCacheEntries` (line 903)

**Interfaces:**

Consumes: `ensureAudioFileHash`, `getDb` from `./db`.

Produces:

```ts
export interface DuplicateAudioGroup {
  hash: string;
  canonicalId: number;
  duplicateIds: number[];
  reclaimableBytes: number;
}

export async function findDuplicateAudioGroups(): Promise<
  DuplicateAudioGroup[]
>;
```

**Why a new module:** `collapseDuplicateAudioGroups` in Task 6 calls `remapAudioFileIdKeys`, which lives in `importExport.ts`. `importExport.ts` imports `db.ts`, so the same call from inside `db.ts` would make a cycle. A module above both has no such problem.

### Steps

- [ ] **Step 1: Write the test first.**

  Create `src/lib/audioDedup.test.ts`:

  ```ts
  /**
   * The one-off cleanup for the duplication already in a user's database.
   *
   * Audio rows are global, and until reuse landed every import wrote a fresh
   * blob for a sound the library already held. This finds those groups and
   * collapses each one onto a single row, and it must carry the per-sound gain
   * and trim across — those are keyed by audio file id, which is exactly the
   * hazard CLAUDE.md names.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const { findDuplicateAudioGroups, collapseDuplicateAudioGroups } =
    await import("./audioDedup");
  const { getDb, addAudioFile, addProfile, upsertPadConfiguration } =
    await import("./db");

  function horn(): Blob {
    return new Blob(["the horn bytes"], { type: "audio/wav" });
  }

  /** Two rows holding the same bytes. `addAudioFile` never reuses, by design. */
  async function twoCopiesOfTheHorn(): Promise<[number, number]> {
    const first = await addAudioFile({
      name: "horn.wav",
      type: "audio/wav",
      blob: horn(),
    });
    const second = await addAudioFile({
      name: "horn (1).wav",
      type: "audio/wav",
      blob: horn(),
    });
    return [first, second];
  }

  beforeEach(async () => {
    await clearAllStores();
  });

  describe("findDuplicateAudioGroups", () => {
    it("reports nothing when every row is unique", async () => {
      await addAudioFile({
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
      });
      await addAudioFile({
        name: "stab.wav",
        type: "audio/wav",
        blob: new Blob(["other bytes"], { type: "audio/wav" }),
      });

      expect(await findDuplicateAudioGroups()).toEqual([]);
    });

    it("groups rows that hold the same bytes and elects the lowest id", async () => {
      const [first, second] = await twoCopiesOfTheHorn();

      const groups = await findDuplicateAudioGroups();

      expect(groups).toHaveLength(1);
      expect(groups[0].canonicalId).toBe(first);
      expect(groups[0].duplicateIds).toEqual([second]);
      expect(groups[0].reclaimableBytes).toBe(horn().size);
    });

    it("prefers a row that already carries a loudness analysis", async () => {
      const [first, second] = await twoCopiesOfTheHorn();
      const db = await getDb();
      const analysed = (await db.get("audioFiles", second))!;
      await db.put("audioFiles", {
        ...analysed,
        loudness: {
          algoVersion: 1,
          sampleRate: 48000,
          duration: 1,
          blockMeanSquare: new Float32Array([0.5]),
          hopTruePeak: new Float32Array([0.5]),
        },
      });

      const groups = await findDuplicateAudioGroups();

      // The analysis is the expensive part, so the row that has one wins even
      // though its id is higher.
      expect(groups[0].canonicalId).toBe(second);
      expect(groups[0].duplicateIds).toEqual([first]);
    });

    it("hashes a row that has none before it groups", async () => {
      // Rows written before the hash field existed carry none, so a scan that
      // skipped them would report a clean database on the very libraries that
      // need the cleanup most.
      const db = await getDb();
      const first = await db.add("audioFiles", {
        name: "horn.wav",
        type: "audio/wav",
        blob: horn(),
        createdAt: new Date(0),
      });
      const second = await db.add("audioFiles", {
        name: "horn (1).wav",
        type: "audio/wav",
        blob: horn(),
        createdAt: new Date(0),
      });

      const groups = await findDuplicateAudioGroups();

      expect(groups).toHaveLength(1);
      expect(groups[0].canonicalId).toBe(first);
      expect(groups[0].duplicateIds).toEqual([second]);
      expect((await db.get("audioFiles", second))?.hash).toBeTruthy();
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/audioDedup.test.ts
  ```

  Expect `Failed to load url ./audioDedup`.

- [ ] **Step 3: Create the module with the scan.**

  Create `src/lib/audioDedup.ts`:

  ```ts
  /**
   * Removal of the duplicate audio rows a library has already accumulated.
   *
   * `addOrReuseAudioFile` stops new duplicates. This clears the ones that
   * arrived before it, which is every sound a user imported twice.
   *
   * The module sits above `db.ts` rather than inside it, because the collapse
   * re-keys `audioTrimSettings` and `audioGainSettings` through
   * `remapAudioFileIdKeys`, and that helper lives in `importExport.ts`, which
   * imports `db.ts`. One rule, one place, and no import cycle.
   */

  import { getDb, ensureAudioFileHash } from "./db";

  export interface DuplicateAudioGroup {
    /** The content hash every row in the group shares. */
    hash: string;
    /** The row that survives the collapse. */
    canonicalId: number;
    /** The rows the collapse deletes. */
    duplicateIds: number[];
    /** Bytes the collapse gives back. */
    reclaimableBytes: number;
  }

  /**
   * Groups the audio rows that hold identical bytes.
   *
   * Reads only. Nothing is written except a hash on a row that lacks one, which
   * is what makes the grouping possible at all.
   */
  export async function findDuplicateAudioGroups(): Promise<
    DuplicateAudioGroup[]
  > {
    const db = await getDb();

    // The hash pass runs first and outside any transaction. `ensureAudioFileHash`
    // reads a blob and calls crypto.subtle, and an await on either closes an
    // IndexedDB transaction under it.
    for (const key of await db.getAllKeys("audioFiles")) {
      await ensureAudioFileHash(key);
    }

    const byHash = new Map<
      string,
      { id: number; size: number; analysed: boolean }[]
    >();
    let cursor = await db.transaction("audioFiles").store.openCursor();
    while (cursor) {
      const record = cursor.value;
      if (record.id !== undefined && record.hash) {
        const rows = byHash.get(record.hash) ?? [];
        // `blob.size` is metadata on the Blob handle, so the bytes stay on disk.
        rows.push({
          id: record.id,
          size: record.blob.size,
          analysed: record.loudness !== undefined,
        });
        byHash.set(record.hash, rows);
      }
      cursor = await cursor.continue();
    }

    const groups: DuplicateAudioGroup[] = [];
    for (const [hash, rows] of byHash) {
      if (rows.length < 2) continue;
      // A row with an analysis wins, then the lowest id. The analysis is the
      // expensive thing to lose; the id keeps the choice stable between runs.
      const ranked = [...rows].sort(
        (a, b) => Number(b.analysed) - Number(a.analysed) || a.id - b.id,
      );
      const [canonical, ...duplicates] = ranked;
      groups.push({
        hash,
        canonicalId: canonical.id,
        duplicateIds: duplicates.map((row) => row.id),
        reclaimableBytes: duplicates.reduce((sum, row) => sum + row.size, 0),
      });
    }

    return groups;
  }
  ```

- [ ] **Step 4: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/audioDedup.test.ts
  ```

  Expect 4 passed.

- [ ] **Step 5: Commit.**

  ```bash
  npm test
  git add src/lib/audioDedup.ts src/lib/audioDedup.test.ts
  git commit -m "feat(audio): report the duplicate audio groups in a library"
  ```

---

## Task 6: `collapseDuplicateAudioGroups`

> **WARNING — request a human review of this task before you merge it.** The function deletes audio rows that the user did not select one by one. Run it only behind the preview and the confirmation that Task 7 builds.

**Files:**

- `src/lib/audioDedup.ts` — add the collapse
- `src/lib/audioDedup.test.ts` — add a describe block
- `src/lib/db.ts` — export `clearAudioCacheEntries` (line 903)

**Interfaces:**

Consumes: `remapAudioFileIdKeys` from `./importExport`, `clearAudioCacheEntries` from `./db`.

Produces:

```ts
export async function collapseDuplicateAudioGroups(
  groups: DuplicateAudioGroup[],
): Promise<{ removedFiles: number; reclaimedBytes: number }>;
```

### Steps

- [ ] **Step 1: Write the test first.**

  Add to `src/lib/audioDedup.test.ts`:

  ```ts
  describe("collapseDuplicateAudioGroups", () => {
    /** A pad on the duplicate row, with a trim and a gain keyed by that id. */
    async function padOnTheDuplicate(duplicateId: number) {
      const profileId = await addProfile({ name: "Show", syncType: "local" });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 2,
        name: "Horn",
        audioFileIds: [duplicateId],
        audioTrimSettings: { [duplicateId]: { trimStart: 0.5, trimEnd: 2.5 } },
        audioGainSettings: { [duplicateId]: -4.5 },
        padGainDb: 3,
        playbackType: "sequential",
      });
      return profileId;
    }

    it("does nothing when there is nothing to collapse", async () => {
      const db = await getDb();
      await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });

      const result = await collapseDuplicateAudioGroups(
        await findDuplicateAudioGroups(),
      );

      expect(result).toEqual({ removedFiles: 0, reclaimedBytes: 0 });
      expect(await db.getAll("audioFiles")).toHaveLength(1);
    });

    it("points the pad at the survivor and deletes the duplicate", async () => {
      const db = await getDb();
      const [first, second] = await twoCopiesOfTheHorn();
      const profileId = await padOnTheDuplicate(second);

      const result = await collapseDuplicateAudioGroups(
        await findDuplicateAudioGroups(),
      );

      expect(result.removedFiles).toBe(1);
      expect(result.reclaimedBytes).toBe(horn().size);
      expect(await db.get("audioFiles", second)).toBeUndefined();

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      expect(pads[0].audioFileIds).toEqual([first]);
    });

    it("carries the per-sound trim and gain onto the survivor's id", async () => {
      // The five-places hazard. A hand-rolled copy of this loop is how a
      // duplicated profile lost every gain setting once already.
      const db = await getDb();
      const [first, second] = await twoCopiesOfTheHorn();
      const profileId = await padOnTheDuplicate(second);

      await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      expect(pads[0].audioTrimSettings).toEqual({
        [first]: { trimStart: 0.5, trimEnd: 2.5 },
      });
      expect(pads[0].audioGainSettings).toEqual({ [first]: -4.5 });
      expect(pads[0].padGainDb).toBe(3);
    });

    it("keeps a setting whose id is not part of any group", async () => {
      // "keep" is the right mode for this remap. "drop" would delete every
      // setting on a pad whose sound was never duplicated.
      const db = await getDb();
      const [first, second] = await twoCopiesOfTheHorn();
      const untouched = await addAudioFile({
        name: "stab.wav",
        type: "audio/wav",
        blob: new Blob(["other bytes"], { type: "audio/wav" }),
      });
      const profileId = await addProfile({ name: "Show", syncType: "local" });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        name: "Two sounds",
        audioFileIds: [second, untouched],
        audioGainSettings: { [second]: -4.5, [untouched]: 1.5 },
        playbackType: "round-robin",
      });

      await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      expect(pads[0].audioFileIds).toEqual([first, untouched]);
      expect(pads[0].audioGainSettings).toEqual({
        [first]: -4.5,
        [untouched]: 1.5,
      });
    });

    it("lists the survivor once when a pad named both rows", async () => {
      const db = await getDb();
      const [first, second] = await twoCopiesOfTheHorn();
      const profileId = await addProfile({ name: "Show", syncType: "local" });
      await upsertPadConfiguration({
        profileId,
        bankId: "0",
        padIndex: 0,
        name: "Both",
        audioFileIds: [first, second],
        playbackType: "round-robin",
      });

      await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      expect(pads[0].audioFileIds).toEqual([first]);
    });

    it("keeps the loudness analysis on the survivor", async () => {
      const db = await getDb();
      const [first, second] = await twoCopiesOfTheHorn();
      const analysed = (await db.get("audioFiles", second))!;
      await db.put("audioFiles", {
        ...analysed,
        loudness: {
          algoVersion: 1,
          sampleRate: 48000,
          duration: 1,
          blockMeanSquare: new Float32Array([0.5]),
          hopTruePeak: new Float32Array([0.5]),
        },
      });

      await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

      expect(await db.get("audioFiles", first)).toBeUndefined();
      expect((await db.get("audioFiles", second))?.loudness).toBeDefined();
    });

    it("stamps the pads it rewrote, so a merge keeps the new ids", async () => {
      const db = await getDb();
      const [, second] = await twoCopiesOfTheHorn();
      const profileId = await padOnTheDuplicate(second);
      const before = (
        await db.getAllFromIndex("padConfigurations", "profileId", profileId)
      )[0];

      await collapseDuplicateAudioGroups(await findDuplicateAudioGroups());

      const after = (
        await db.getAllFromIndex("padConfigurations", "profileId", profileId)
      )[0];
      expect(after._modified).toBeGreaterThanOrEqual(before._modified ?? 0);
      expect(after._fieldsModified?.audioFileIds).toBeGreaterThan(0);
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/audioDedup.test.ts
  ```

  Expect `does not provide an export named 'collapseDuplicateAudioGroups'`.

- [ ] **Step 3: Export the cache clearer from `db.ts`.**

  In `src/lib/db.ts` line 903, change `async function clearAudioCacheEntries` to `export async function clearAudioCacheEntries`. Add one line to its doc comment:

  ```ts
  /**
   * Drops decoded-buffer cache entries for audio whose records have gone.
   *
   * Exported because the duplicate collapse deletes rows too, and a stale
   * decoded buffer under a deleted id is a sound that plays after its row is
   * gone.
   * …
   */
  ```

- [ ] **Step 4: Add the collapse.**

  Add to `src/lib/audioDedup.ts`:

  ```ts
  import { clearAudioCacheEntries, getDb, ensureAudioFileHash } from "./db";
  import { remapAudioFileIdKeys } from "./importExport";
  ```

  ```ts
  /**
   * Points every pad at each group's canonical row, then deletes the rest.
   *
   * One transaction over both stores, so no pad can start to name a row
   * between the decision and the delete.
   *
   * The two `Record<audioFileId, …>` maps go through `remapAudioFileIdKeys` in
   * "keep" mode. "keep" is correct here: an id that belongs to no group is not
   * a duplicate, so its setting stays under its own key. "drop" would delete
   * every setting on every pad the collapse touched.
   *
   * @param groups The output of `findDuplicateAudioGroups`, after the user
   *   confirmed the preview
   * @returns How many rows went, and how many bytes came back
   */
  export async function collapseDuplicateAudioGroups(
    groups: DuplicateAudioGroup[],
  ): Promise<{ removedFiles: number; reclaimedBytes: number }> {
    if (groups.length === 0) return { removedFiles: 0, reclaimedBytes: 0 };

    const idMap = new Map<number, number>();
    for (const group of groups) {
      for (const duplicateId of group.duplicateIds) {
        idMap.set(duplicateId, group.canonicalId);
      }
    }

    const db = await getDb();
    const tx = db.transaction(["audioFiles", "padConfigurations"], "readwrite");
    const padStore = tx.objectStore("padConfigurations");
    const audioStore = tx.objectStore("audioFiles");
    const nowMs = Date.now();
    const now = new Date();

    let cursor = await padStore.openCursor();
    while (cursor) {
      const pad = cursor.value;
      const ids = pad.audioFileIds ?? [];
      if (ids.some((id) => idMap.has(id))) {
        // A pad that named both rows would otherwise list one sound twice, so
        // the mapped list is made unique.
        const mapped = [...new Set(ids.map((id) => idMap.get(id) ?? id))];
        await cursor.update({
          ...pad,
          audioFileIds: mapped,
          audioTrimSettings: remapAudioFileIdKeys(
            pad.audioTrimSettings,
            idMap,
            "keep",
          ),
          audioGainSettings: remapAudioFileIdKeys(
            pad.audioGainSettings,
            idMap,
            "keep",
          ),
          updatedAt: now,
          // Stamped so a merge does not put the old ids back. The wire form
          // names sounds by content hash, so the other devices see no change
          // at all — the stamps only keep this device's numeric ids settled.
          _modified: nowMs,
          _fieldsModified: {
            ...(pad._fieldsModified ?? {}),
            audioFileIds: nowMs,
            audioTrimSettings: nowMs,
            audioGainSettings: nowMs,
          },
        });
      }
      cursor = await cursor.continue();
    }

    let removedFiles = 0;
    let reclaimedBytes = 0;
    for (const duplicateId of idMap.keys()) {
      const record = await audioStore.get(duplicateId);
      if (!record) continue;
      reclaimedBytes += record.blob.size;
      await audioStore.delete(duplicateId);
      removedFiles++;
    }
    await tx.done;

    await clearAudioCacheEntries(idMap.keys());
    return { removedFiles, reclaimedBytes };
  }
  ```

- [ ] **Step 5: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/audioDedup.test.ts
  ```

  Expect 11 passed across both describe blocks.

- [ ] **Step 6: Run the whole suite, then commit.**

  ```bash
  npm test
  git add src/lib/audioDedup.ts src/lib/audioDedup.test.ts src/lib/db.ts
  git commit -m "feat(audio): collapse duplicate audio rows, keeping trim and gain"
  ```

---

## Task 7: The duplicate audio panel in the Maintenance tab

> **WARNING — request a human review of this task and Task 6 together before you merge them.** The button deletes audio rows. The preview and the confirmation are the whole safety story.

**Files:**

- `src/components/profiles/ProfileManager.tsx` — state near line 168, a handler near line 446, a section in the Maintenance tab near line 1188

**Interfaces:**

Consumes: `findDuplicateAudioGroups`, `collapseDuplicateAudioGroups`, `DuplicateAudioGroup`.
Produces: no export.

**Behaviour:** the scan runs first and reports the counts. The delete button appears only after the scan finds something, and it names the count in its label, exactly as the orphan section already does.

### Steps

- [ ] **Step 1: Add the state.**

  In `src/components/profiles/ProfileManager.tsx`, below the orphan cleanup state (line 168-180):

  ```tsx
  // Duplicate audio state. Preview first, delete second: this action removes
  // audio rows the user never picked one by one, so it never runs on one click.
  const [isScanningDuplicates, setIsScanningDuplicates] = useState(false);
  const [isCollapsingDuplicates, setIsCollapsingDuplicates] = useState(false);
  const [duplicateGroups, setDuplicateGroups] = useState<
    DuplicateAudioGroup[] | null
  >(null);
  const [duplicateResult, setDuplicateResult] = useState<{
    removedFiles: number;
    reclaimedBytes: number;
  } | null>(null);
  ```

  Add the type import at the top of the file:

  ```tsx
  import type { DuplicateAudioGroup } from "@/lib/audioDedup";
  ```

- [ ] **Step 2: Add the two handlers.**

  Below `handleCleanupOrphans` (line 489):

  ```tsx
  const handleScanDuplicates = async () => {
    setIsScanningDuplicates(true);
    setDuplicateGroups(null);
    setDuplicateResult(null);
    try {
      const { findDuplicateAudioGroups } = await import("@/lib/audioDedup");
      setDuplicateGroups(await findDuplicateAudioGroups());
    } catch (error) {
      console.error("Failed to scan for duplicate audio files:", error);
    } finally {
      setIsScanningDuplicates(false);
    }
  };

  const handleCollapseDuplicates = async () => {
    if (!duplicateGroups || duplicateGroups.length === 0) return;
    const rows = duplicateGroups.reduce(
      (n, group) => n + group.duplicateIds.length,
      0,
    );
    if (
      !window.confirm(
        `Delete ${rows} duplicate audio file${rows === 1 ? "" : "s"}? ` +
          "Every pad that uses one will be pointed at the copy that stays.",
      )
    ) {
      return;
    }
    setIsCollapsingDuplicates(true);
    try {
      const { collapseDuplicateAudioGroups } = await import("@/lib/audioDedup");
      setDuplicateResult(await collapseDuplicateAudioGroups(duplicateGroups));
      setDuplicateGroups(null);
      // Pads now name different ids, so every cached copy of pad data is stale.
      useProfileStore.getState().incrementPadConfigsVersion();
    } catch (error) {
      console.error("Failed to collapse duplicate audio files:", error);
    } finally {
      setIsCollapsingDuplicates(false);
    }
  };
  ```

- [ ] **Step 3: Add the section.**

  In the Maintenance tab, below the "Orphaned Audio Files" section (which ends at line 1371):

  ```tsx
  {
    /* Duplicate Audio Files Section */
  }
  <section className="mb-8">
    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
      Duplicate Audio Files
    </h3>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
      Scan for audio files stored more than once. Imports before this release
      wrote a fresh copy of every sound, even one this browser already held. The
      scan reports what it found; nothing is deleted until you confirm.
    </p>

    <div className="space-y-4">
      <button
        onClick={handleScanDuplicates}
        disabled={isScanningDuplicates || isCollapsingDuplicates}
        data-testid="scan-duplicate-audio"
        className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
      >
        {isScanningDuplicates ? "Scanning..." : "Scan for Duplicates"}
      </button>

      {duplicateGroups && (
        <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 space-y-2 text-sm">
          <p className="text-gray-600 dark:text-gray-300">
            Duplicate groups:{" "}
            <span className="font-medium">{duplicateGroups.length}</span>
          </p>
          <p className="text-gray-600 dark:text-gray-300">
            Files to remove:{" "}
            <span className="font-medium">
              {duplicateGroups.reduce(
                (n, group) => n + group.duplicateIds.length,
                0,
              )}
            </span>
          </p>
          <p className="text-gray-600 dark:text-gray-300">
            Space to reclaim:{" "}
            <span className="font-medium">
              {Math.round(
                duplicateGroups.reduce(
                  (n, group) => n + group.reclaimableBytes,
                  0,
                ) / 1048576,
              )}{" "}
              MB
            </span>
          </p>
          {duplicateGroups.length > 0 && (
            <button
              onClick={handleCollapseDuplicates}
              disabled={isCollapsingDuplicates}
              data-testid="collapse-duplicate-audio"
              className="mt-2 px-4 py-2 bg-red-500 text-white rounded-md hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
            >
              {isCollapsingDuplicates
                ? "Removing..."
                : `Remove ${duplicateGroups.reduce(
                    (n, group) => n + group.duplicateIds.length,
                    0,
                  )} Duplicates`}
            </button>
          )}
        </div>
      )}

      {duplicateResult && (
        <div className="rounded-lg p-4 bg-green-50 dark:bg-green-900/20 text-sm text-green-700 dark:text-green-300">
          Removed {duplicateResult.removedFiles} file
          {duplicateResult.removedFiles === 1 ? "" : "s"} and reclaimed{" "}
          {Math.round(duplicateResult.reclaimedBytes / 1048576)} MB.
        </div>
      )}
    </div>
  </section>;
  ```

- [ ] **Step 4: Check the types and lint.**

  ```bash
  npx tsc --noEmit
  npm run lint
  ```

- [ ] **Step 5: Run the app and use the panel.**

  Ask the user to start the dev server if it does not run. Then open Manage Profiles, open the Maintenance tab, press "Scan for Duplicates" on a library with a known duplicate, and press the delete button. Check that the pads still play.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/components/profiles/ProfileManager.tsx
  git commit -m "feat(profiles): preview and remove duplicate audio in the Maintenance tab"
  ```

- [ ] **Step 7: Stop and ask for a review.**

  Part A is complete. Tell the user that Task 6 and Task 7 delete audio rows, and ask for a review before the branch merges. Do not start Part B until Part A is merged.

---

# Part B — Bank export and import

## Task 8: `BankExport` and `collectBankDataForZip`

**Files:**

- `src/lib/importExport.ts` — factor the audio half out of `collectProfileDataForZip` (line 1454-1519)
- `src/lib/bankTransfer.ts` — new file
- `src/lib/bankUtils.ts` — add `MAX_BANKS`
- `src/app/page.tsx` — use `MAX_BANKS` at line 364

**Interfaces:**

Consumes:

```ts
export interface AudioFileRef {
  id: number;
  name: string;
  type: string;
  loudness?: SerialisedLoudness;
  hash?: string;
}
export function collectReferencedAudioFileIds(
  padConfigurations: (Pick<PadConfiguration, "audioFileIds"> & {
    audioFileId?: number;
  })[],
): Set<number>;
```

Produces:

```ts
// src/lib/importExport.ts
export async function collectAudioForPads(
  padConfigurations: PadConfiguration[],
): Promise<{
  audioFiles: AudioFileRef[];
  audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
}>;

// src/lib/bankUtils.ts
export const MAX_BANKS = 20;

// src/lib/bankTransfer.ts
export interface BankExport {
  exportVersion: 4;
  exportDate: string;
  sourceBankId: string;
  page: Omit<PageMetadata, "id" | "profileId" | "bankId" | "pageIndex">;
  padConfigurations: Omit<PadConfiguration, "id" | "profileId" | "bankId">[];
  audioFiles: AudioFileRef[];
}

export async function collectBankDataForZip(
  profileId: number,
  bankId: string,
): Promise<{
  bank: BankExport;
  audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
  sourceProfileName: string;
}>;
```

### Steps

- [ ] **Step 1: Write the test first.**

  Create `src/lib/bankTransfer.test.ts`:

  ```ts
  /**
   * Bank export and import.
   *
   * A bank archive reuses the profile archive's layout with a new manifest
   * version, so the two are told apart by a number rather than by a guess. The
   * round trip is the right shape of test: the writer and the reader agree
   * about a format defined in one place and read in another, which is where
   * this codebase goes wrong.
   */

  // Must be the first import: it installs `window` before `db.ts` can read it.
  import { clearAllStores } from "@/lib/testSupport/browserGlobals";
  import { beforeEach, describe, expect, it } from "vitest";

  const {
    collectBankDataForZip,
    exportBanksToZip,
    readArchiveManifest,
    importBanksFromZip,
  } = await import("./bankTransfer");
  const {
    getDb,
    addProfile,
    addAudioFile,
    upsertPadConfiguration,
    upsertPageMetadata,
  } = await import("./db");

  /** One bank with one two-sound pad, plus the trim and gain that must travel. */
  async function seedBank(
    profileId: number,
    bankId: string,
    pageIndex: number,
    options: { name: string; isEmergency?: boolean; soundBytes?: string } = {
      name: "Stings",
    },
  ) {
    const bytes = options.soundBytes ?? `bytes for ${bankId}`;
    const audioFileId = await addAudioFile({
      name: `${bankId}.wav`,
      type: "audio/wav",
      blob: new Blob([bytes], { type: "audio/wav" }),
    });

    await upsertPageMetadata({
      profileId,
      bankId,
      pageIndex,
      name: options.name,
      isEmergency: options.isEmergency ?? false,
    });

    await upsertPadConfiguration({
      profileId,
      bankId,
      padIndex: 3,
      keyBinding: "q",
      name: "Horn",
      audioFileIds: [audioFileId],
      audioTrimSettings: { [audioFileId]: { trimStart: 0.25, trimEnd: 1.75 } },
      audioGainSettings: { [audioFileId]: -4.5 },
      padGainDb: 2,
      playbackType: "sequential",
      isDisabled: true,
    });

    return { audioFileId };
  }

  beforeEach(async () => {
    await clearAllStores();
  });

  describe("collectBankDataForZip", () => {
    it("collects one bank, its pads and its sounds", async () => {
      const profileId = await addProfile({ name: "Show A", syncType: "local" });
      const { audioFileId } = await seedBank(profileId, "b1", 0, {
        name: "Stings",
        isEmergency: true,
      });
      // A second bank that must not come along.
      await seedBank(profileId, "b2", 1, { name: "Beds" });

      const { bank, audioBlobs, sourceProfileName } =
        await collectBankDataForZip(profileId, "b1");

      expect(bank.exportVersion).toBe(4);
      expect(bank.sourceBankId).toBe("b1");
      expect(bank.page.name).toBe("Stings");
      expect(bank.page.isEmergency).toBe(true);
      expect(bank.padConfigurations).toHaveLength(1);
      expect(bank.padConfigurations[0].padIndex).toBe(3);
      expect(bank.audioFiles.map((ref) => ref.id)).toEqual([audioFileId]);
      expect(audioBlobs.size).toBe(1);
      expect(sourceProfileName).toBe("Show A");
    });

    it("refuses a bank the profile does not have", async () => {
      const profileId = await addProfile({ name: "Show A", syncType: "local" });

      await expect(collectBankDataForZip(profileId, "nope")).rejects.toThrow(
        /bank/i,
      );
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect `Failed to load url ./bankTransfer`.

- [ ] **Step 3: Add `MAX_BANKS`.**

  At the top of `src/lib/bankUtils.ts`:

  ```ts
  /**
   * How many banks a profile can hold.
   *
   * The keyboard decides this: keys 1-9 and 0, then Ctrl with the same ten. It
   * was a literal 20 inside the "Add Bank" handler, and the bank import needs
   * the same number to check capacity before it writes.
   */
  export const MAX_BANKS = 20;
  ```

  In `src/app/page.tsx` line 364, change `if (nextIndex >= 20)` to `if (nextIndex >= MAX_BANKS)`, change the message to `` `Maximum number of banks reached (${MAX_BANKS})` ``, and add `MAX_BANKS` to the `@/lib/bankUtils` import.

- [ ] **Step 4: Factor the audio collection out of `collectProfileDataForZip`.**

  In `src/lib/importExport.ts`, above `collectProfileDataForZip` (line 1454):

  ```ts
  /**
   * The audio a set of pads names, as export references plus their blobs.
   *
   * Shared by the profile export and the bank export. One rule for "what audio
   * belongs in this archive", so a bank archive can never disagree with a
   * profile archive about the reference shape.
   */
  export async function collectAudioForPads(
    padConfigurations: PadConfiguration[],
  ): Promise<{
    audioFiles: AudioFileRef[];
    audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
  }> {
    const audioFiles: AudioFileRef[] = [];
    const audioBlobs = new Map<
      number,
      { blob: Blob; name: string; type: string }
    >();

    for (const audioFileId of collectReferencedAudioFileIds(
      padConfigurations,
    )) {
      const audioFile = await getAudioFile(audioFileId);
      if (!audioFile) {
        console.warn(
          `Audio file ID ${audioFileId} referenced but not found in DB.`,
        );
        continue;
      }
      audioFiles.push({
        id: audioFileId,
        name: audioFile.name,
        type: audioFile.type,
        loudness: audioFile.loudness
          ? serialiseLoudness(audioFile.loudness)
          : undefined,
        hash: audioFile.hash,
      });
      audioBlobs.set(audioFileId, {
        blob: audioFile.blob,
        name: audioFile.name,
        type: audioFile.type,
      });
    }

    return { audioFiles, audioBlobs };
  }
  ```

  Replace lines 1467-1502 of `collectProfileDataForZip` with:

  ```ts
  const { audioFiles, audioBlobs } =
    await collectAudioForPads(padConfigurations);
  ```

- [ ] **Step 5: Create `bankTransfer.ts` with the collector.**

  ```ts
  /**
   * Export and import of individual banks.
   *
   * A bank archive is the profile archive with a different manifest version:
   * `manifest.json`, one `banks/<n>/bank.json` for each bank, and one shared
   * `audio/<id>` folder. Five banks that share a sound store it once.
   *
   * The import is two-phase, because a bank has to be given a slot before
   * anything is written. `readArchiveManifest` answers "what is in this file",
   * the UI asks the user where each bank goes, and `importBanksFromZip` writes.
   */

  import { IDBPDatabase } from "idb";
  import {
    ImpAmpDBSchema,
    PadConfiguration,
    PageMetadata,
    getAllPageMetadataForProfile,
    getDb,
    getProfile,
  } from "./db";
  import { AudioFileRef, collectAudioForPads } from "./importExport";

  /** One bank, as it is written into `banks/<n>/bank.json`. */
  export interface BankExport {
    exportVersion: 4;
    exportDate: string;
    /** Identity of the bank this came from, for the update-in-place offer. */
    sourceBankId: string;
    /** pageIndex is advisory; import chooses the position. */
    page: Omit<PageMetadata, "id" | "profileId" | "bankId" | "pageIndex">;
    padConfigurations: Omit<PadConfiguration, "id" | "profileId" | "bankId">[];
    audioFiles: AudioFileRef[];
  }

  /**
   * Collects one bank and the audio its pads name.
   *
   * The profile id and the bank id are dropped from every record: the import
   * assigns its own. `pageIndex` goes too, because a bank's position belongs
   * to the profile that holds it, not to the bank.
   */
  export async function collectBankDataForZip(
    profileId: number,
    bankId: string,
  ): Promise<{
    bank: BankExport;
    audioBlobs: Map<number, { blob: Blob; name: string; type: string }>;
    sourceProfileName: string;
  }> {
    const profile = await getProfile(profileId);
    if (!profile) {
      throw new Error(`Profile with ID ${profileId} not found`);
    }

    const pages = await getAllPageMetadataForProfile(profileId);
    const page = pages.find((candidate) => candidate.bankId === bankId);
    if (!page) {
      throw new Error(`Bank ${bankId} not found in profile ${profileId}`);
    }

    // getPadConfigurationsForProfileBank ranges on the profileBankPad index.
    // A scan of every pad in the profile would be a second copy of the
    // "pads of a bank" rule, and it would drift from that one.
    const pads = await getPadConfigurationsForProfileBank(profileId, bankId);
    const { audioFiles, audioBlobs } = await collectAudioForPads(pads);

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const {
      id: _pageId,
      profileId: _pageProfileId,
      bankId: _pageBankId,
      pageIndex: _pageIndex,
      ...pageContent
    } = page;
    /* eslint-enable @typescript-eslint/no-unused-vars */

    return {
      bank: {
        exportVersion: 4,
        exportDate: new Date().toISOString(),
        sourceBankId: bankId,
        page: pageContent,
        padConfigurations: pads.map((pad) => {
          /* eslint-disable @typescript-eslint/no-unused-vars */
          const {
            id: _padId,
            profileId: _padProfileId,
            bankId: _padBankId,
            ...padContent
          } = pad;
          /* eslint-enable @typescript-eslint/no-unused-vars */
          return padContent;
        }),
        audioFiles,
      },
      audioBlobs,
      sourceProfileName: profile.name,
    };
  }
  ```

- [ ] **Step 6: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts src/lib/importExport.zip.test.ts
  ```

  Expect the two `collectBankDataForZip` tests green and the profile round trip still green.

- [ ] **Step 7: Commit.**

  ```bash
  npm test
  git add src/lib/bankTransfer.ts src/lib/bankTransfer.test.ts src/lib/importExport.ts src/lib/bankUtils.ts src/app/page.tsx
  git commit -m "feat(banks): collect one bank for export, and name the 20-bank cap"
  ```

---

## Task 9: `exportBanksToZip`

**Files:**

- `src/lib/bankTransfer.ts`
- `src/lib/bankTransfer.test.ts`

**Interfaces:**

Consumes: `getZipJs`, `TransferProgressCallback` from `./importExport`.

Produces:

```ts
export interface BankZipManifest {
  exportVersion: 4;
  exportDate: string;
  banks: { name: string; folder: string; sourceProfileName: string }[];
}

export async function exportBanksToZip(
  profileId: number,
  bankIds: string[],
  target: WritableStream | "blob",
  onProgress?: TransferProgressCallback,
): Promise<Blob | null>;
```

**Note:** `getZipJs` is module-private in `importExport.ts` today. Export it. It configures zip.js once, and a second copy of that configuration would let the two archive writers differ.

### Steps

- [ ] **Step 1: Write the test first.**

  Add to `src/lib/bankTransfer.test.ts`:

  ```ts
  /** Lists the entry names inside an archive Blob. */
  async function entryNames(archive: Blob): Promise<string[]> {
    const zipjs = await import("@zip.js/zip.js");
    zipjs.configure({ useWebWorkers: false });
    const reader = new zipjs.ZipReader(new zipjs.BlobReader(archive));
    try {
      return (await reader.getEntries()).map((entry) => entry.filename).sort();
    } finally {
      await reader.close();
    }
  }

  describe("exportBanksToZip", () => {
    it("writes a manifest, one bank entry per bank and the audio", async () => {
      const profileId = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(profileId, "b1", 0, { name: "Stings" });
      await seedBank(profileId, "b2", 1, { name: "Beds" });

      const archive = await exportBanksToZip(profileId, ["b1", "b2"], "blob");

      expect(archive).toBeInstanceOf(Blob);
      const names = await entryNames(archive!);
      expect(names).toContain("manifest.json");
      expect(names).toContain("banks/0/bank.json");
      expect(names).toContain("banks/1/bank.json");
      expect(names.filter((name) => name.startsWith("audio/"))).toHaveLength(2);
    });

    it("stores a sound two banks share exactly once", async () => {
      const profileId = await addProfile({ name: "Show A", syncType: "local" });
      const { audioFileId } = await seedBank(profileId, "b1", 0, {
        name: "Stings",
        soundBytes: "one set of bytes",
      });
      await upsertPageMetadata({
        profileId,
        bankId: "b2",
        pageIndex: 1,
        name: "Beds",
        isEmergency: false,
      });
      await upsertPadConfiguration({
        profileId,
        bankId: "b2",
        padIndex: 0,
        name: "Same horn",
        audioFileIds: [audioFileId],
        playbackType: "sequential",
      });

      const archive = await exportBanksToZip(profileId, ["b1", "b2"], "blob");

      const names = await entryNames(archive!);
      expect(names.filter((name) => name.startsWith("audio/"))).toEqual([
        `audio/${audioFileId}`,
      ]);
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect `does not provide an export named 'exportBanksToZip'`.

- [ ] **Step 3: Export `getZipJs`.**

  In `src/lib/importExport.ts` line 1534, change `async function getZipJs()` to `export async function getZipJs()`.

- [ ] **Step 4: Add the writer.**

  Add to `src/lib/bankTransfer.ts`:

  ```ts
  import {
    AudioFileRef,
    TransferProgressCallback,
    collectAudioForPads,
    getZipJs,
  } from "./importExport";
  ```

  ```ts
  /** The manifest at the root of a bank archive. */
  export interface BankZipManifest {
    exportVersion: 4;
    exportDate: string;
    banks: { name: string; folder: string; sourceProfileName: string }[];
  }

  /**
   * Exports banks as a `.iaz` archive, one entry per bank and one shared audio
   * folder.
   *
   * It does **not** stamp `lastBackedUpAt`. A selection of banks is not a
   * backup of the profile, and a claim otherwise would silence the backup
   * reminder on data that nobody exported.
   *
   * @param profileId The profile the banks come from
   * @param bankIds Which banks to write, in the order they appear
   * @param target A WritableStream to stream to disk, or "blob"
   * @param onProgress Optional progress callback for the audio phase
   * @returns The archive Blob when target is "blob", otherwise null
   */
  export async function exportBanksToZip(
    profileId: number,
    bankIds: string[],
    target: WritableStream | "blob",
    onProgress?: TransferProgressCallback,
  ): Promise<Blob | null> {
    const zipjs = await getZipJs();

    onProgress?.({
      phase: "preparing",
      processedFiles: 0,
      totalFiles: 0,
      processedBytes: 0,
      totalBytes: 0,
    });

    const manifestBanks: BankZipManifest["banks"] = [];
    const bankJsonEntries: { path: string; json: string }[] = [];
    const allAudioBlobs = new Map<
      number,
      { blob: Blob; name: string; type: string }
    >();

    for (let i = 0; i < bankIds.length; i++) {
      const { bank, audioBlobs, sourceProfileName } =
        await collectBankDataForZip(profileId, bankIds[i]);
      const folder = String(i);
      manifestBanks.push({ name: bank.page.name, folder, sourceProfileName });
      bankJsonEntries.push({
        path: `banks/${folder}/bank.json`,
        json: JSON.stringify(bank, null, 2),
      });
      for (const [id, data] of audioBlobs) {
        // Shared, so a sound two banks use is stored once.
        if (!allAudioBlobs.has(id)) allAudioBlobs.set(id, data);
      }
    }

    const totalFiles = allAudioBlobs.size;
    let totalBytes = 0;
    for (const { blob } of allAudioBlobs.values()) totalBytes += blob.size;

    const blobWriter =
      target === "blob" ? new zipjs.BlobWriter("application/zip") : null;
    const zipWriter = new zipjs.ZipWriter(
      blobWriter ?? (target as WritableStream),
    );

    const manifest: BankZipManifest = {
      exportVersion: 4,
      exportDate: new Date().toISOString(),
      banks: manifestBanks,
    };
    await zipWriter.add(
      "manifest.json",
      new zipjs.TextReader(JSON.stringify(manifest, null, 2)),
      { level: 6 },
    );
    for (const { path, json } of bankJsonEntries) {
      await zipWriter.add(path, new zipjs.TextReader(json), { level: 6 });
    }

    let processedFiles = 0;
    let processedBytes = 0;
    for (const [id, { blob, name }] of allAudioBlobs) {
      onProgress?.({
        phase: "audio",
        fileName: name,
        processedFiles,
        totalFiles,
        processedBytes,
        totalBytes,
      });
      // Audio formats are compressed already, so STORE them.
      await zipWriter.add(`audio/${id}`, new zipjs.BlobReader(blob), {
        level: 0,
        onprogress: async (progress: number) => {
          onProgress?.({
            phase: "audio",
            fileName: name,
            processedFiles,
            totalFiles,
            processedBytes: processedBytes + progress,
            totalBytes,
          });
        },
      });
      processedFiles++;
      processedBytes += blob.size;
    }

    onProgress?.({
      phase: "finalizing",
      processedFiles,
      totalFiles,
      processedBytes,
      totalBytes,
    });
    await zipWriter.close();

    return blobWriter ? blobWriter.getData() : null;
  }
  ```

- [ ] **Step 5: Run the test and see it pass.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect 4 passed.

- [ ] **Step 6: Commit.**

  ```bash
  npm test
  git add src/lib/bankTransfer.ts src/lib/bankTransfer.test.ts src/lib/importExport.ts
  git commit -m "feat(banks): write an exportVersion 4 archive holding N banks"
  ```

---

## Task 10: `readArchiveManifest`

**Files:**

- `src/lib/importExport.ts` — lift the ZIP entry readers out of `importProfilesFromZip` (lines 1705-1729)
- `src/lib/bankTransfer.ts`
- `src/lib/bankTransfer.test.ts`

**Interfaces:**

Produces:

```ts
// src/lib/importExport.ts
export function zipEntryReaders(entries: Entry[]): {
  entryByName: Map<string, Entry>;
  readEntryText: (name: string) => Promise<string | null>;
  parseEntryJson: (name: string, text: string) => unknown;
};

// src/lib/bankTransfer.ts
export interface BankSummary {
  /** The archive folder, and the key of the placement map. */
  folder: string;
  name: string;
  isEmergency: boolean;
  padCount: number;
  audioCount: number;
  sourceProfileName: string;
  sourceBankId: string;
}

export async function readArchiveManifest(
  blob: Blob,
): Promise<{ kind: "profiles" } | { kind: "banks"; banks: BankSummary[] }>;
```

**Deviation from the spec, on purpose:** the spec says this reads `manifest.json` only. `manifest.json` carries a name and a folder, so it cannot report `padCount`, `audioCount`, `isEmergency` or `sourceBankId`, and the dialog needs all four. The function therefore reads `manifest.json` plus each `banks/<n>/bank.json`. Those are metadata entries, capped by `MAX_ZIP_METADATA_BYTES`; no audio entry is touched.

### Steps

- [ ] **Step 1: Write the test first.**

  Add to `src/lib/bankTransfer.test.ts`:

  ```ts
  /** Builds a .iaz-shaped archive with exactly the entries given. */
  async function makeArchive(entries: Record<string, string>): Promise<Blob> {
    const zipjs = await import("@zip.js/zip.js");
    zipjs.configure({ useWebWorkers: false });
    const writer = new zipjs.ZipWriter(new zipjs.BlobWriter("application/zip"));
    for (const [name, text] of Object.entries(entries)) {
      await writer.add(name, new zipjs.TextReader(text));
    }
    return writer.close();
  }

  describe("readArchiveManifest", () => {
    it("describes each bank in a bank archive", async () => {
      const profileId = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(profileId, "b1", 0, { name: "Stings", isEmergency: true });
      await seedBank(profileId, "b2", 1, { name: "Beds" });
      const archive = await exportBanksToZip(profileId, ["b1", "b2"], "blob");

      const described = await readArchiveManifest(archive!);

      expect(described.kind).toBe("banks");
      if (described.kind !== "banks") throw new Error("unreachable");
      expect(described.banks).toHaveLength(2);
      expect(described.banks[0]).toMatchObject({
        folder: "0",
        name: "Stings",
        isEmergency: true,
        padCount: 1,
        audioCount: 1,
        sourceProfileName: "Show A",
        sourceBankId: "b1",
      });
      expect(described.banks[1].sourceBankId).toBe("b2");
    });

    it("says a profile archive is a profile archive", async () => {
      const { exportProfilesToZip } = await import("./importExport");
      const profileId = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(profileId, "b1", 0, { name: "Stings" });
      const archive = await exportProfilesToZip([profileId], "blob");

      expect(await readArchiveManifest(archive!)).toEqual({ kind: "profiles" });
    });

    it("says a legacy single-profile archive is a profile archive", async () => {
      const archive = await makeArchive({
        "profile.json": JSON.stringify({ exportVersion: 2, profile: {} }),
      });

      expect(await readArchiveManifest(archive)).toEqual({ kind: "profiles" });
    });

    it("refuses an archive that is neither", async () => {
      const archive = await makeArchive({ "readme.txt": "hello" });

      await expect(readArchiveManifest(archive)).rejects.toThrow(
        /missing manifest\.json or profile\.json/,
      );
    });

    it("refuses a bank entry that is not valid JSON", async () => {
      const archive = await makeArchive({
        "manifest.json": JSON.stringify({
          exportVersion: 4,
          exportDate: "2026-08-19T00:00:00.000Z",
          banks: [{ name: "Stings", folder: "0", sourceProfileName: "Show A" }],
        }),
        "banks/0/bank.json": "{ not json",
      });

      await expect(readArchiveManifest(archive)).rejects.toThrow(
        /banks\/0\/bank\.json .* not valid JSON/,
      );
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect `does not provide an export named 'readArchiveManifest'`.

- [ ] **Step 3: Lift the entry readers to module scope.**

  In `src/lib/importExport.ts`, add `import type { Entry } from "@zip.js/zip.js";` at the top, and add this above `importProfilesFromZip`:

  ```ts
  /**
   * The two readers every archive path needs, bound to one set of entries.
   *
   * Lifted out of `importProfilesFromZip` so the bank reader shares the size
   * cap and the "which entry failed" error text rather than re-stating them.
   */
  export function zipEntryReaders(entries: Entry[]): {
    entryByName: Map<string, Entry>;
    readEntryText: (name: string) => Promise<string | null>;
    parseEntryJson: (name: string, text: string) => unknown;
  } {
    const entryByName = new Map(entries.map((e) => [e.filename, e]));

    // A metadata entry is read into a single string, so its *uncompressed* size
    // is what matters, not the archive's. Without this an archive of a few
    // hundred kilobytes could name a manifest that expands to gigabytes.
    const readEntryText = async (name: string): Promise<string | null> => {
      const entry = entryByName.get(name);
      if (!entry || entry.directory) return null;

      const size = entry.uncompressedSize ?? 0;
      if (size > MAX_ZIP_METADATA_BYTES) {
        throw new Error(
          `The entry ${name} in this archive is implausibly large (${Math.round(size / 1024 / 1024)} MB) and was not read.`,
        );
      }

      const zipjs = await getZipJs();
      return entry.getData(new zipjs.TextWriter());
    };

    const parseEntryJson = (name: string, text: string): unknown => {
      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`${name} in this archive is not valid JSON.`);
      }
    };

    return { entryByName, readEntryText, parseEntryJson };
  }
  ```

  Inside `importProfilesFromZip`, delete the two closures and replace lines 1698-1729 with:

  ```ts
  const entries = await zipReader.getEntries();
  const { entryByName, readEntryText, parseEntryJson } =
    zipEntryReaders(entries);
  ```

- [ ] **Step 4: Add the reader.**

  Add to `src/lib/bankTransfer.ts`:

  ```ts
  import { MAX_BANKS } from "./bankUtils";
  import { getZipJs, zipEntryReaders } from "./importExport";
  ```

  ```ts
  /** What the placement dialog shows for one bank in an archive. */
  export interface BankSummary {
    /** The archive folder, and the key of the placement map. */
    folder: string;
    name: string;
    isEmergency: boolean;
    padCount: number;
    audioCount: number;
    sourceProfileName: string;
    sourceBankId: string;
  }

  /**
   * Says what an archive holds, without a write of any kind.
   *
   * The manifest version routes the file, so the `.iaz` extension and the file
   * input's accept list stay as they are. The bank entries are read too, since
   * the manifest alone cannot report a pad count or an emergency flag; those
   * are small JSON documents under the same size cap, and no audio entry is
   * read.
   */
  export async function readArchiveManifest(
    blob: Blob,
  ): Promise<{ kind: "profiles" } | { kind: "banks"; banks: BankSummary[] }> {
    const zipjs = await getZipJs();
    const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(blob));

    try {
      const { readEntryText, parseEntryJson } = zipEntryReaders(
        await zipReader.getEntries(),
      );

      const manifestText = await readEntryText("manifest.json");
      if (!manifestText) {
        if (await readEntryText("profile.json")) return { kind: "profiles" };
        throw new Error(
          "Invalid .iaz file: missing manifest.json or profile.json",
        );
      }

      const manifest = parseEntryJson("manifest.json", manifestText) as {
        exportVersion?: number;
        banks?: { name: string; folder: string; sourceProfileName: string }[];
      };

      if (manifest.exportVersion === 3) return { kind: "profiles" };
      if (manifest.exportVersion !== 4 || !Array.isArray(manifest.banks)) {
        throw new Error("Invalid or unsupported .iaz archive format.");
      }

      const banks: BankSummary[] = [];
      for (const entry of manifest.banks) {
        const path = `banks/${entry.folder}/bank.json`;
        const text = await readEntryText(path);
        if (!text) throw new Error(`Missing ${path}`);
        const bank = parseEntryJson(path, text) as Partial<BankExport>;
        if (!bank.page || !Array.isArray(bank.padConfigurations)) {
          throw new Error(`${path} does not contain a bank.`);
        }
        banks.push({
          folder: entry.folder,
          name: bank.page.name,
          isEmergency: bank.page.isEmergency,
          padCount: bank.padConfigurations.length,
          audioCount: bank.audioFiles?.length ?? 0,
          sourceProfileName: entry.sourceProfileName,
          sourceBankId: bank.sourceBankId ?? "",
        });
      }

      return { kind: "banks", banks };
    } finally {
      try {
        await zipReader.close();
      } catch {
        // ignore close errors
      }
    }
  }
  ```

- [ ] **Step 5: Run the tests and see them pass.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts src/lib/importExport.zip.test.ts
  ```

  Expect 9 passed in the bank file, and the four malformed-archive tests in the zip file still green. Those four cover the readers you just moved.

- [ ] **Step 6: Commit.**

  ```bash
  npm test
  git add src/lib/bankTransfer.ts src/lib/bankTransfer.test.ts src/lib/importExport.ts
  git commit -m "feat(banks): read an archive manifest and describe the banks in it"
  ```

---

## Task 11: `writeBankIntoProfile`

**Files:**

- `src/lib/bankTransfer.ts`
- `src/lib/bankTransfer.test.ts`

**Interfaces:**

Consumes: `importAudioSources`, `remapPadSettingsOnImport` from `./importExport`; `upsertPadConfiguration`, `upsertPageMetadata`, `extractPadPlaybackSettings`, `createBank`, `getPadConfigurationsForProfileBank` from `./db`. The last two come from the bank identity plan.

Produces:

```ts
export type BankPlacement =
  { kind: "add" } | { kind: "replace"; bankId: string } | { kind: "skip" };

export async function writeBankIntoProfile(
  db: IDBPDatabase<ImpAmpDBSchema>,
  args: {
    profileId: number;
    mode: BankPlacement;
    bank: BankExport;
    audioSources: ImportAudioSource[];
  },
): Promise<{
  written: boolean;
  bankId?: string;
  pageIndex?: number;
  createdAudioIds: number[];
}>;
```

**Why this shape:** an in-app "merge profile into…" is the same core, called over the banks of another profile. It needs no file round trip. That feature stays outside this spec. The seam costs little now and much later.

`importAudioSources` is module-private in `importExport.ts`. Export it.

### Steps

- [ ] **Step 1: Write the test first.**

  Add to `src/lib/bankTransfer.test.ts`:

  ```ts
  describe("writeBankIntoProfile", () => {
    /** A bank collected from one profile, with sources that hold its blobs. */
    async function bankAndSources(profileId: number, bankId: string) {
      const { bank, audioBlobs } = await collectBankDataForZip(
        profileId,
        bankId,
      );
      const audioSources = bank.audioFiles.map((ref) => ({
        originalId: ref.id,
        name: ref.name,
        type: ref.type,
        hash: ref.hash,
        getBlob: async () => audioBlobs.get(ref.id)!.blob,
      }));
      return { bank, audioSources };
    }

    it("adds a bank at the first free position with a fresh bankId", async () => {
      const { writeBankIntoProfile } = await import("./bankTransfer");
      const db = await getDb();
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      const target = await addProfile({ name: "Show B", syncType: "local" });
      await seedBank(target, "t0", 0, { name: "Held" });

      const { bank, audioSources } = await bankAndSources(source, "b1");
      const result = await writeBankIntoProfile(db, {
        profileId: target,
        mode: { kind: "add" },
        bank,
        audioSources,
      });

      expect(result.written).toBe(true);
      expect(result.pageIndex).toBe(1);
      expect(result.bankId).not.toBe("b1");

      const pages = await db.getAllFromIndex(
        "pageMetadata",
        "profileId",
        target,
      );
      expect(pages.map((page) => page.name).sort()).toEqual(["Held", "Stings"]);
    });

    it("keeps the target bankId and clears its old pads on replace", async () => {
      const { writeBankIntoProfile } = await import("./bankTransfer");
      const db = await getDb();
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      const target = await addProfile({ name: "Show B", syncType: "local" });
      await seedBank(target, "t0", 0, { name: "Old bank" });
      // A pad the incoming bank does not define; replace must clear it.
      await upsertPadConfiguration({
        profileId: target,
        bankId: "t0",
        padIndex: 11,
        name: "Leftover",
        audioFileIds: [],
        playbackType: "sequential",
      });

      const { bank, audioSources } = await bankAndSources(source, "b1");
      const result = await writeBankIntoProfile(db, {
        profileId: target,
        mode: { kind: "replace", bankId: "t0" },
        bank,
        audioSources,
      });

      expect(result.bankId).toBe("t0");
      const pads = (
        await db.getAllFromIndex("padConfigurations", "profileId", target)
      ).filter((pad) => pad.bankId === "t0");
      expect(pads.map((pad) => pad.padIndex)).toEqual([3]);

      const pages = await db.getAllFromIndex(
        "pageMetadata",
        "profileId",
        target,
      );
      expect(pages).toHaveLength(1);
      expect(pages[0].name).toBe("Stings");
    });

    it("writes nothing on skip", async () => {
      const { writeBankIntoProfile } = await import("./bankTransfer");
      const db = await getDb();
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      const target = await addProfile({ name: "Show B", syncType: "local" });

      const { bank, audioSources } = await bankAndSources(source, "b1");
      const result = await writeBankIntoProfile(db, {
        profileId: target,
        mode: { kind: "skip" },
        bank,
        audioSources,
      });

      expect(result).toEqual({ written: false, createdAudioIds: [] });
      expect(
        await db.getAllFromIndex("pageMetadata", "profileId", target),
      ).toHaveLength(0);
    });

    it("re-keys the trim and gain onto the ids it wrote", async () => {
      const { writeBankIntoProfile } = await import("./bankTransfer");
      const db = await getDb();
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      const target = await addProfile({ name: "Show B", syncType: "local" });

      const { bank, audioSources } = await bankAndSources(source, "b1");
      await writeBankIntoProfile(db, {
        profileId: target,
        mode: { kind: "add" },
        bank,
        audioSources,
      });

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        target,
      );
      const newAudioId = pads[0].audioFileIds[0];
      expect(pads[0].audioGainSettings).toEqual({ [newAudioId]: -4.5 });
      expect(pads[0].audioTrimSettings).toEqual({
        [newAudioId]: { trimStart: 0.25, trimEnd: 1.75 },
      });
      expect(pads[0].padGainDb).toBe(2);
      expect(pads[0].playbackType).toBe("sequential");
      expect(pads[0].isDisabled).toBe(true);
      expect(pads[0].keyBinding).toBe("q");
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect `does not provide an export named 'writeBankIntoProfile'`.

- [ ] **Step 3: Export the audio importer.**

  In `src/lib/importExport.ts` line 471, change `async function importAudioSources` to `export async function importAudioSources`, and add one line to its comment:

  ```ts
  // Exported for the bank import, which needs the same reuse-by-hash rule and
  // the same created-versus-reused split its rollback depends on.
  ```

- [ ] **Step 4: Add the core.**

  Add to `src/lib/bankTransfer.ts`:

  ```ts
  import {
    DEFAULT_PLAYBACK_TYPE,
    extractPadPlaybackSettings,
    upsertPadConfiguration,
    upsertPageMetadata,
  } from "./db";
  import {
    ImportAudioSource,
    importAudioSources,
    remapPadSettingsOnImport,
  } from "./importExport";
  ```

  ```ts
  /** Where one incoming bank goes in the target profile. */
  export type BankPlacement =
    { kind: "add" } | { kind: "replace"; bankId: string } | { kind: "skip" };

  /**
   * Writes one bank into a profile.
   *
   * "add" mints a fresh `bankId` and takes the first free position. "replace"
   * keeps the target's `bankId`, clears its pads, and writes the incoming ones,
   * so identity survives and a merge reads a content change rather than a new
   * bank. "skip" writes nothing.
   *
   * Audio ids are remapped through `importAudioSources` and
   * `remapPadSettingsOnImport`, never by hand. Reuse by content hash means a
   * bank imported back into the profile it came from adds no blobs.
   *
   * @returns Which bank it wrote, and the audio rows it created — the rollback
   *   deletes from that list and leaves every reused row alone
   */
  export async function writeBankIntoProfile(
    db: IDBPDatabase<ImpAmpDBSchema>,
    args: {
      profileId: number;
      mode: BankPlacement;
      bank: BankExport;
      audioSources: ImportAudioSource[];
    },
  ): Promise<{
    written: boolean;
    bankId?: string;
    pageIndex?: number;
    createdAudioIds: number[];
  }> {
    const { profileId, mode, bank, audioSources } = args;
    if (mode.kind === "skip") return { written: false, createdAudioIds: [] };

    const now = new Date();
    const { audioIdMap, createdIds, failures } = await importAudioSources(
      db,
      audioSources,
      now,
    );
    if (failures.length > 0) {
      const names = failures.map((failure) => failure.name).join("; ");
      throw new Error(
        `${failures.length} of ${audioSources.length} sounds could not be imported (${names}).`,
      );
    }

    const pages = await getAllPageMetadataForProfile(profileId);
    let bankId: string;
    let pageIndex: number;

    if (mode.kind === "replace") {
      const target = pages.find((page) => page.bankId === mode.bankId);
      if (!target) {
        throw new Error(`Bank ${mode.bankId} is no longer in this profile.`);
      }
      bankId = target.bankId;
      pageIndex = target.pageIndex;

      // Clear the pads first. A pad the incoming bank does not define has to
      // go, or the replaced bank keeps sounds from the bank it replaced.
      const existingPads = await getPadConfigurationsForProfileBank(
        profileId,
        bankId,
      );
      const tx = db.transaction("padConfigurations", "readwrite");
      const store = tx.objectStore("padConfigurations");
      for (const pad of existingPads) {
        if (pad.id !== undefined) await store.delete(pad.id);
      }
      await tx.done;

      await upsertPageMetadata({
        profileId,
        bankId,
        pageIndex,
        name: bank.page.name,
        isEmergency: bank.page.isEmergency,
      });
    } else {
      // createBank owns the cap check, the free-slot search, the new id and
      // the initial sync fields. A second copy of those four rules here would
      // drift from it, and it would also drop the sync fields.
      const created = await createBank(
        profileId,
        bank.page.name,
        bank.page.isEmergency,
      );
      bankId = created.bankId;
      pageIndex = created.pageIndex;
    }

    for (const pad of bank.padConfigurations) {
      const audioFileIds = (pad.audioFileIds ?? [])
        .map((originalId) => audioIdMap.get(originalId))
        .filter((newId): newId is number => newId !== undefined);

      await upsertPadConfiguration({
        profileId,
        bankId,
        padIndex: pad.padIndex,
        keyBinding: pad.keyBinding,
        // Through the shared helper, so a new pad field cannot be dropped here
        // without being dropped everywhere at once.
        ...extractPadPlaybackSettings({
          ...pad,
          audioFileIds,
          audioTrimSettings: remapPadSettingsOnImport(
            pad.audioTrimSettings,
            audioIdMap,
          ),
          audioGainSettings: remapPadSettingsOnImport(
            pad.audioGainSettings,
            audioIdMap,
          ),
          playbackType: pad.playbackType ?? DEFAULT_PLAYBACK_TYPE,
        }),
      });
    }

    return { written: true, bankId, pageIndex, createdAudioIds: createdIds };
  }
  ```

- [ ] **Step 5: Run the tests and see them pass.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect 13 passed.

- [ ] **Step 6: Commit.**

  ```bash
  npm test
  git add src/lib/bankTransfer.ts src/lib/bankTransfer.test.ts src/lib/importExport.ts
  git commit -m "feat(banks): write one bank into a profile, as an add or a replace"
  ```

---

## Task 12: `importBanksFromZip`

**Files:**

- `src/lib/bankTransfer.ts`
- `src/lib/bankTransfer.test.ts`

**Interfaces:**

Consumes: `deleteUnreferencedAudioFiles` from `./db`, `readArchiveManifest`, `writeBankIntoProfile`.

Produces:

```ts
export interface BankImportResult {
  written: {
    folder: string;
    name: string;
    bankId: string;
    pageIndex: number;
  }[];
  skipped: string[];
}

export async function importBanksFromZip(
  blob: Blob,
  db: IDBPDatabase<ImpAmpDBSchema>,
  options: {
    profileId: number;
    placements: Record<string, BankPlacement>;
  },
  onProgress?: TransferProgressCallback,
): Promise<BankImportResult>;
```

**Order of work:**

1. Read the manifest and every bank entry.
2. Count the free slots. Refuse the whole set if the "add" placements need more.
3. Snapshot each replace target's page row and pad rows.
4. Write each bank in folder order.
5. On any failure, restore the snapshots, delete the banks added so far, and pass the created audio ids to `deleteUnreferencedAudioFiles`.

### Steps

- [ ] **Step 1: Write the test first.**

  Add to `src/lib/bankTransfer.test.ts`:

  ```ts
  describe("importBanksFromZip", () => {
    /** A source profile with two banks, and an empty target profile. */
    async function twoBankArchive() {
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      await seedBank(source, "b2", 1, { name: "Beds" });
      const archive = await exportBanksToZip(source, ["b1", "b2"], "blob");
      const target = await addProfile({ name: "Show B", syncType: "local" });
      return { source, target, archive: archive! };
    }

    it("adds both banks and brings their pads and sounds", async () => {
      const db = await getDb();
      const { target, archive } = await twoBankArchive();

      const result = await importBanksFromZip(archive, db, {
        profileId: target,
        placements: { "0": { kind: "add" }, "1": { kind: "add" } },
      });

      expect(result.written).toHaveLength(2);
      expect(result.skipped).toEqual([]);

      const pages = await db.getAllFromIndex(
        "pageMetadata",
        "profileId",
        target,
      );
      expect(pages.map((page) => page.name).sort()).toEqual(["Beds", "Stings"]);
      expect(pages.map((page) => page.pageIndex).sort()).toEqual([0, 1]);

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        target,
      );
      expect(pads).toHaveLength(2);
      expect(pads.every((pad) => pad.audioFileIds.length === 1)).toBe(true);
    });

    it("skips the bank the placement map says to skip", async () => {
      const db = await getDb();
      const { target, archive } = await twoBankArchive();

      const result = await importBanksFromZip(archive, db, {
        profileId: target,
        placements: { "0": { kind: "add" }, "1": { kind: "skip" } },
      });

      expect(result.written).toHaveLength(1);
      expect(result.skipped).toEqual(["Beds"]);
      expect(
        await db.getAllFromIndex("pageMetadata", "profileId", target),
      ).toHaveLength(1);
    });

    it("adds no blob when a bank goes back into the profile it came from", async () => {
      const db = await getDb();
      const source = await addProfile({ name: "Show A", syncType: "local" });
      await seedBank(source, "b1", 0, { name: "Stings" });
      const archive = await exportBanksToZip(source, ["b1"], "blob");
      const before = (await db.getAll("audioFiles")).length;

      await importBanksFromZip(archive!, db, {
        profileId: source,
        placements: { "0": { kind: "add" } },
      });

      expect(await db.getAll("audioFiles")).toHaveLength(before);
    });

    it("refuses the whole set before any write when the slots run out", async () => {
      const db = await getDb();
      const { target, archive } = await twoBankArchive();
      // Fill the target to one free slot.
      for (let index = 0; index < 19; index++) {
        await upsertPageMetadata({
          profileId: target,
          bankId: `full-${index}`,
          pageIndex: index,
          name: `Bank ${index + 1}`,
          isEmergency: false,
        });
      }

      await expect(
        importBanksFromZip(archive, db, {
          profileId: target,
          placements: { "0": { kind: "add" }, "1": { kind: "add" } },
        }),
      ).rejects.toThrow(/free slot/i);

      expect(
        await db.getAllFromIndex("pageMetadata", "profileId", target),
      ).toHaveLength(19);
    });

    it("refuses a malformed archive without a write", async () => {
      const db = await getDb();
      const target = await addProfile({ name: "Show B", syncType: "local" });
      const archive = await makeArchive({ "readme.txt": "hello" });

      await expect(
        importBanksFromZip(archive, db, {
          profileId: target,
          placements: {},
        }),
      ).rejects.toThrow(/missing manifest\.json or profile\.json/);

      expect(
        await db.getAllFromIndex("pageMetadata", "profileId", target),
      ).toHaveLength(0);
    });

    it("restores every target bank when a later bank fails", async () => {
      const db = await getDb();
      const { target, archive } = await twoBankArchive();
      await seedBank(target, "t0", 0, { name: "Original" });

      // The second placement names a bank that is not there, so the write of
      // the first has to be undone.
      await expect(
        importBanksFromZip(archive, db, {
          profileId: target,
          placements: {
            "0": { kind: "replace", bankId: "t0" },
            "1": { kind: "replace", bankId: "gone" },
          },
        }),
      ).rejects.toThrow(/no longer in this profile/);

      const pages = await db.getAllFromIndex(
        "pageMetadata",
        "profileId",
        target,
      );
      expect(pages).toHaveLength(1);
      expect(pages[0].name).toBe("Original");

      const pads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        target,
      );
      expect(pads).toHaveLength(1);
      expect(pads[0].padIndex).toBe(3);
    });
  });
  ```

- [ ] **Step 2: Run the test and see it fail.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect `does not provide an export named 'importBanksFromZip'`.

- [ ] **Step 3: Add the import.**

  Add to `src/lib/bankTransfer.ts`:

  ```ts
  import { deleteUnreferencedAudioFiles } from "./db";
  ```

  ```ts
  export interface BankImportResult {
    written: {
      folder: string;
      name: string;
      bankId: string;
      pageIndex: number;
    }[];
    skipped: string[];
  }

  /** Every row of one bank, as it stood before the import touched it. */
  interface BankSnapshot {
    page: PageMetadata | undefined;
    pads: PadConfiguration[];
  }

  /**
   * Imports banks from a `.iaz` archive into one profile.
   *
   * Two-phase on purpose: `readArchiveManifest` runs first and the user picks a
   * slot for each bank, because a bank cannot be written before its slot is
   * known.
   *
   * Capacity is checked across the whole set before the first write. Rollback
   * puts every target bank back and deletes the audio rows this attempt
   * created, so a refusal leaves the profile exactly as it was.
   */
  export async function importBanksFromZip(
    blob: Blob,
    db: IDBPDatabase<ImpAmpDBSchema>,
    options: { profileId: number; placements: Record<string, BankPlacement> },
    onProgress?: TransferProgressCallback,
  ): Promise<BankImportResult> {
    const { profileId, placements } = options;
    const described = await readArchiveManifest(blob);
    if (described.kind !== "banks") {
      throw new Error("This archive holds profiles, not banks.");
    }

    const zipjs = await getZipJs();
    const zipReader = new zipjs.ZipReader(new zipjs.BlobReader(blob));
    const createdAudioIds: number[] = [];
    const snapshots = new Map<string, BankSnapshot>();
    const addedBankIds: string[] = [];

    try {
      const { entryByName, readEntryText, parseEntryJson } = zipEntryReaders(
        await zipReader.getEntries(),
      );

      // Phase one: read every bank entry, then check capacity. Both happen
      // before the first write, so an over-capacity set costs nothing.
      const loaded: { summary: BankSummary; bank: BankExport }[] = [];
      for (const summary of described.banks) {
        const path = `banks/${summary.folder}/bank.json`;
        const text = await readEntryText(path);
        if (!text) throw new Error(`Missing ${path}`);
        loaded.push({
          summary,
          bank: parseEntryJson(path, text) as BankExport,
        });
      }

      const pages = await getAllPageMetadataForProfile(profileId);
      const freeSlots = MAX_BANKS - pages.length;
      const wantedSlots = loaded.filter(
        ({ summary }) =>
          (placements[summary.folder] ?? { kind: "skip" }).kind === "add",
      ).length;
      if (wantedSlots > freeSlots) {
        throw new Error(
          `This profile has ${freeSlots} free slot${freeSlots === 1 ? "" : "s"}, and the import needs ${wantedSlots}.`,
        );
      }

      // Snapshot each replace target before the first write. This reads the
      // pads of the profile once and partitions them, rather than one indexed
      // read per target. Keep it that way: an import can replace many banks.
      const allPads = await db.getAllFromIndex(
        "padConfigurations",
        "profileId",
        profileId,
      );
      for (const { summary } of loaded) {
        const mode = placements[summary.folder];
        if (mode?.kind !== "replace") continue;
        snapshots.set(mode.bankId, {
          page: pages.find((page) => page.bankId === mode.bankId),
          pads: allPads.filter((pad) => pad.bankId === mode.bankId),
        });
      }

      const written: BankImportResult["written"] = [];
      const skipped: string[] = [];
      let doneFiles = 0;

      for (const { summary, bank } of loaded) {
        const mode = placements[summary.folder] ?? { kind: "skip" };
        if (mode.kind === "skip") {
          skipped.push(summary.name);
          continue;
        }

        const audioSources: ImportAudioSource[] = [];
        for (const ref of bank.audioFiles) {
          const entry = entryByName.get(`audio/${ref.id}`);
          if (!entry || entry.directory) {
            console.warn(
              `Audio file ${ref.id} referenced by bank "${summary.name}" not found in archive.`,
            );
            continue;
          }
          const getData = entry.getData.bind(entry);
          audioSources.push({
            originalId: ref.id,
            name: ref.name,
            type: ref.type,
            size: entry.uncompressedSize,
            loudness: ref.loudness,
            hash: ref.hash,
            getBlob: () => getData(new zipjs.BlobWriter(ref.type)),
          });
        }

        onProgress?.({
          phase: "audio",
          fileName: summary.name,
          processedFiles: doneFiles,
          totalFiles: loaded.length,
          processedBytes: doneFiles,
          totalBytes: loaded.length,
        });

        const result = await writeBankIntoProfile(db, {
          profileId,
          mode,
          bank,
          audioSources,
        });
        createdAudioIds.push(...result.createdAudioIds);
        if (mode.kind === "add" && result.bankId) {
          addedBankIds.push(result.bankId);
        }
        written.push({
          folder: summary.folder,
          name: summary.name,
          bankId: result.bankId!,
          pageIndex: result.pageIndex!,
        });
        doneFiles++;
      }

      onProgress?.({
        phase: "finalizing",
        processedFiles: loaded.length,
        totalFiles: loaded.length,
        processedBytes: loaded.length,
        totalBytes: loaded.length,
      });

      return { written, skipped };
    } catch (error) {
      await rollbackBankImport(db, profileId, snapshots, addedBankIds);
      if (createdAudioIds.length > 0) {
        try {
          // Only the rows this attempt created. A row it reused belongs to
          // whoever had it first.
          await deleteUnreferencedAudioFiles(createdAudioIds);
        } catch (cleanupError) {
          console.error(
            "Failed to clean up audio files from the failed bank import:",
            cleanupError,
          );
        }
      }
      throw error;
    } finally {
      try {
        await zipReader.close();
      } catch {
        // ignore close errors
      }
    }
  }

  /** Puts every touched bank back the way the snapshot found it. */
  async function rollbackBankImport(
    db: IDBPDatabase<ImpAmpDBSchema>,
    profileId: number,
    snapshots: Map<string, BankSnapshot>,
    addedBankIds: string[],
  ): Promise<void> {
    if (snapshots.size === 0 && addedBankIds.length === 0) return;

    const restore = new Set([...snapshots.keys(), ...addedBankIds]);
    const tx = db.transaction(
      ["pageMetadata", "padConfigurations"],
      "readwrite",
    );
    const pageStore = tx.objectStore("pageMetadata");
    const padStore = tx.objectStore("padConfigurations");

    let padCursor = await padStore.index("profileId").openCursor(profileId);
    while (padCursor) {
      if (restore.has(padCursor.value.bankId)) await padCursor.delete();
      padCursor = await padCursor.continue();
    }

    let pageCursor = await pageStore.index("profileId").openCursor(profileId);
    while (pageCursor) {
      if (restore.has(pageCursor.value.bankId)) await pageCursor.delete();
      pageCursor = await pageCursor.continue();
    }

    for (const snapshot of snapshots.values()) {
      if (snapshot.page) await pageStore.put(snapshot.page);
      for (const pad of snapshot.pads) await padStore.put(pad);
    }

    await tx.done;
  }
  ```

- [ ] **Step 4: Run the tests and see them pass.**

  ```bash
  npx vitest run src/lib/bankTransfer.test.ts
  ```

  Expect 19 passed.

- [ ] **Step 5: Run the whole suite, then commit.**

  ```bash
  npm test
  git add src/lib/bankTransfer.ts src/lib/bankTransfer.test.ts
  git commit -m "feat(banks): import banks with a placement map, a capacity check and a rollback"
  ```

---

## Task 13: The store actions

**Files:**

- `src/store/profileStore.ts` — the `ProfileState` interface near line 105, the action near line 701, the filename helper at line 176

**Interfaces:**

Produces:

```ts
exportBanksToZip: (
  profileId: number,
  bankIds: string[],
  bankNames: string[],
  onProgress?: TransferProgressCallback,
) => Promise<boolean>;

importBanksFromArchive: (
  file: Blob,
  profileId: number,
  placements: Record<string, BankPlacement>,
  onProgress?: TransferProgressCallback,
) => Promise<BankImportResult>;
```

**Filename:** `impamp-bank-<sanitised name>-<YYYY-MM-DD>.iaz` for one bank, `impamp-banks-<n>-<YYYY-MM-DD>.iaz` for several.

### Steps

- [ ] **Step 1: Add the filename helper.**

  Below `_buildExportFilename` in `src/store/profileStore.ts` (line 189):

  ```ts
  // Banks get their own filename rule. A bank export is not a profile export,
  // and a file called impamp-show-a-2026-08-19.iaz that holds two banks is how
  // a restore goes wrong six months later.
  const _buildBankExportFilename = (bankNames: string[]): string => {
    const date = new Date().toISOString().split("T")[0];
    if (bankNames.length === 1) {
      const sanitized = (bankNames[0] || "bank")
        .replace(/[^a-z0-9]/gi, "-")
        .toLowerCase();
      return `impamp-bank-${sanitized}-${date}.iaz`;
    }
    return `impamp-banks-${bankNames.length}-${date}.iaz`;
  };
  ```

- [ ] **Step 2: Declare the two actions.**

  In the `ProfileState` interface, below `importProfilesFromZip` (line 118):

  ```ts
  exportBanksToZip: (
    profileId: number,
    bankIds: string[],
    bankNames: string[],
    onProgress?: TransferProgressCallback,
  ) => Promise<boolean>;
  importBanksFromArchive: (
    file: Blob,
    profileId: number,
    placements: Record<string, BankPlacement>,
    onProgress?: TransferProgressCallback,
  ) => Promise<BankImportResult>;
  ```

  Add the type import at the top:

  ```ts
  import type { BankImportResult, BankPlacement } from "@/lib/bankTransfer";
  ```

- [ ] **Step 3: Implement the export action.**

  Below `exportMultipleProfilesToZip` (line 790):

  ```ts
          exportBanksToZip: async (
            profileId: number,
            bankIds: string[],
            bankNames: string[],
            onProgress?: TransferProgressCallback,
          ) => {
            if (bankIds.length === 0) return false;
            const { exportBanksToZip } = await import("../lib/bankTransfer");
            const filename = _buildBankExportFilename(bankNames);

            // The picker has to be called while the click's user activation is
            // still valid, exactly as the profile export does.
            if (typeof window.showSaveFilePicker === "function") {
              let handle: FileSystemFileHandle | null = null;
              try {
                handle = await window.showSaveFilePicker({
                  suggestedName: filename,
                  types: [
                    {
                      description: "ImpAmp bank archive",
                      accept: { "application/zip": [".iaz"] },
                    },
                  ],
                });
              } catch (pickerError) {
                if (
                  pickerError instanceof DOMException &&
                  pickerError.name === "AbortError"
                ) {
                  return false;
                }
                console.warn(
                  "Save picker failed, falling back to blob download:",
                  pickerError,
                );
              }

              if (handle) {
                const writable = await handle.createWritable();
                try {
                  await exportBanksToZip(
                    profileId,
                    bankIds,
                    writable,
                    onProgress,
                  );
                } catch (error) {
                  try {
                    await writable.abort();
                  } catch {
                    // stream may already be closed
                  }
                  throw error;
                }
                // No lastBackedUpAt stamp. A selection of banks is not a backup
                // of the profile, and a stamp here would silence the reminder
                // on data nobody exported.
                return true;
              }
            }

            const zipBlob = await exportBanksToZip(
              profileId,
              bankIds,
              "blob",
              onProgress,
            );
            return zipBlob !== null && _triggerBlobDownload(zipBlob, filename);
          },
  ```

- [ ] **Step 4: Implement the import action.**

  Below `importProfilesFromZip` (line 845):

  ```ts
          importBanksFromArchive: async (
            file: Blob,
            profileId: number,
            placements: Record<string, BankPlacement>,
            onProgress?: TransferProgressCallback,
          ) => {
            const { importBanksFromZip } = await import("../lib/bankTransfer");
            const { getDb } = await import("@/lib/db");
            const db = await getDb();
            const result = await importBanksFromZip(
              file,
              db,
              { profileId, placements },
              onProgress,
            );
            // The board's cached copies of pad data are all stale now.
            get().incrementPadConfigsVersion();
            get().requestSync(profileId);
            return result;
          },
  ```

- [ ] **Step 5: Check the types, lint and suite.**

  ```bash
  npx tsc --noEmit
  npm run lint
  npm test
  ```

- [ ] **Step 6: Commit.**

  ```bash
  git add src/store/profileStore.ts
  git commit -m "feat(profiles): store actions for bank export and bank import"
  ```

---

## Task 14: The "Export banks" section

**Files:**

- `src/components/profiles/ProfileManager.tsx` — state near line 152, a section in the Import/Export tab below the "Export Profiles" section (line 717-816)

**Interfaces:**

Consumes: `exportBanksToZip` from the store, `getAllPageMetadataForProfile` from `@/lib/db`.
Produces: no export.

### Steps

- [ ] **Step 1: Add the state and the bank loader.**

  Below the export selection state (line 152):

  ```tsx
  // Bank export state. The bank list is loaded per profile, because a bank
  // belongs to exactly one profile and the checkbox list has to follow the
  // profile select.
  const [bankExportProfileId, setBankExportProfileId] = useState<number | null>(
    activeProfileId,
  );
  const [bankOptions, setBankOptions] = useState<
    { bankId: string; name: string; pageIndex: number }[]
  >([]);
  const [bankSelectionIds, setBankSelectionIds] = useState<Set<string>>(
    new Set(),
  );
  const [isExportingBanks, setIsExportingBanks] = useState(false);
  const [bankExportProgress, setBankExportProgress] =
    useState<TransferProgress | null>(null);
  ```

  Add the effect below the other effects:

  ```tsx
  useEffect(() => {
    if (bankExportProfileId === null) {
      setBankOptions([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const { getAllPageMetadataForProfile } = await import("@/lib/db");
      const pages = await getAllPageMetadataForProfile(bankExportProfileId);
      if (cancelled) return;
      setBankOptions(
        pages
          .map((page) => ({
            bankId: page.bankId,
            name: page.name,
            pageIndex: page.pageIndex,
          }))
          .sort((a, b) => a.pageIndex - b.pageIndex),
      );
      setBankSelectionIds(new Set());
    })();
    return () => {
      cancelled = true;
    };
  }, [bankExportProfileId]);
  ```

- [ ] **Step 2: Add the section.**

  Below the "Export Profiles" section, before the "Import Profile" section:

  ```tsx
  {
    /* Export Banks Section */
  }
  <section className="mb-8">
    <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
      Export banks
    </h3>
    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
      Export one or more banks to a file you can import into another profile.
      This does not count as a backup of the whole profile.
    </p>

    <label
      className="block text-sm text-gray-700 dark:text-gray-300 mb-2"
      htmlFor="bank-export-profile"
    >
      Profile
    </label>
    <select
      id="bank-export-profile"
      data-testid="bank-export-profile"
      value={bankExportProfileId ?? ""}
      onChange={(e) =>
        setBankExportProfileId(
          e.target.value === "" ? null : Number(e.target.value),
        )
      }
      className="mb-4 block w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm"
    >
      {profiles.map((profile) => (
        <option key={profile.id} value={profile.id}>
          {profile.name}
          {profile.id === activeProfileId ? " (Active)" : ""}
        </option>
      ))}
    </select>

    <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700 max-h-60 overflow-y-auto mb-4">
      {bankOptions.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400 italic">
          This profile has no banks to export.
        </p>
      ) : (
        <div className="space-y-2">
          {bankOptions.map((bank) => (
            <div key={bank.bankId} className="flex items-center">
              <input
                id={`export-bank-${bank.bankId}`}
                type="checkbox"
                checked={bankSelectionIds.has(bank.bankId)}
                onChange={(e) =>
                  setBankSelectionIds((previous) => {
                    const next = new Set(previous);
                    if (e.target.checked) next.add(bank.bankId);
                    else next.delete(bank.bankId);
                    return next;
                  })
                }
                className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
              />
              <label
                htmlFor={`export-bank-${bank.bankId}`}
                className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
              >
                {bank.pageIndex + 1}: {bank.name}
              </label>
            </div>
          ))}
        </div>
      )}
    </div>

    <button
      data-testid="export-selected-banks"
      onClick={async () => {
        if (bankExportProfileId === null || bankSelectionIds.size === 0) return;
        const ordered = bankOptions.filter((bank) =>
          bankSelectionIds.has(bank.bankId),
        );
        try {
          setIsExportingBanks(true);
          const done = await exportBanksToZip(
            bankExportProfileId,
            ordered.map((bank) => bank.bankId),
            ordered.map((bank) => bank.name),
            setBankExportProgress,
          );
          if (done) setBankSelectionIds(new Set());
        } catch (error) {
          console.error("Failed to export banks:", error);
          alert("Failed to export the selected banks. Please try again.");
        } finally {
          setIsExportingBanks(false);
          setBankExportProgress(null);
        }
      }}
      disabled={isExportingBanks || bankSelectionIds.size === 0}
      className={`px-4 py-2 ${
        bankSelectionIds.size > 0
          ? "bg-green-500 text-white hover:bg-green-600"
          : "bg-gray-200 text-gray-500"
      } rounded-md transition-colors ${
        isExportingBanks || bankSelectionIds.size === 0
          ? "cursor-not-allowed"
          : ""
      }`}
    >
      {isExportingBanks
        ? "Exporting..."
        : `Export Selected (${bankSelectionIds.size})`}
    </button>

    {isExportingBanks && bankExportProgress && (
      <TransferProgressBar progress={bankExportProgress} verb="Exporting" />
    )}
  </section>;
  ```

- [ ] **Step 3: Read the new action from the store.**

  Add `exportBanksToZip` to both the destructure and the `useShallow` selector at lines 93-125.

- [ ] **Step 4: Check the types and lint.**

  ```bash
  npx tsc --noEmit
  npm run lint
  ```

- [ ] **Step 5: Run the app and export a bank.**

  Do these steps in sequence:

  1. Open Manage Profiles.
  2. Open the Import / Export tab.
  3. Select one bank.
  4. Press "Export Selected (1)".
  5. Check that a `.iaz` file lands on disk.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/components/profiles/ProfileManager.tsx
  git commit -m "feat(profiles): add an Export banks section to the Import / Export tab"
  ```

---

## Task 15: The bank import placement dialog

**Files:**

- `src/components/profiles/BankImportPlacementDialog.tsx` — new file
- `src/components/profiles/ProfileManager.tsx` — the file input handler at line 828-940

**Interfaces:**

Produces:

```tsx
export default function BankImportPlacementDialog(props: {
  banks: BankSummary[];
  targetProfileName: string;
  targetBanks: { bankId: string; name: string; pageIndex: number }[];
  freeSlots: number;
  isImporting: boolean;
  onCancel: () => void;
  onImport: (placements: Record<string, BankPlacement>) => void;
}): React.ReactElement;
```

**Rules the dialog enforces:**

- The target profile is the active profile and is read-only.
- Each row offers "Add as new bank", one "Replace <bank>" option per bank in the target, and "Skip".
- A row whose `sourceBankId` matches a bank in the target starts on "Replace" of that bank.
- The Import button is disabled while the "add" rows outnumber the free slots.

### Steps

- [ ] **Step 1: Create the dialog.**

  ```tsx
  "use client";

  import { useState } from "react";
  import type { BankPlacement, BankSummary } from "@/lib/bankTransfer";

  interface TargetBank {
    bankId: string;
    name: string;
    pageIndex: number;
  }

  /**
   * Asks where each bank in an archive should go.
   *
   * A bank cannot be written before its slot is chosen, so this stands between
   * the file input and the import. Capacity is checked here as well as inside
   * `importBanksFromZip`: the check in the library is the guarantee, and this
   * one is what stops the user pressing a button that cannot work.
   */
  export default function BankImportPlacementDialog({
    banks,
    targetProfileName,
    targetBanks,
    freeSlots,
    isImporting,
    onCancel,
    onImport,
  }: {
    banks: BankSummary[];
    targetProfileName: string;
    targetBanks: TargetBank[];
    freeSlots: number;
    isImporting: boolean;
    onCancel: () => void;
    onImport: (placements: Record<string, BankPlacement>) => void;
  }) {
    const [placements, setPlacements] = useState<Record<string, BankPlacement>>(
      () => {
        const initial: Record<string, BankPlacement> = {};
        for (const bank of banks) {
          // A bank whose identity is already in the profile defaults to a
          // replace of that bank, which is what "I edited this and want it
          // back" needs.
          const match = targetBanks.find(
            (target) => target.bankId === bank.sourceBankId,
          );
          initial[bank.folder] = match
            ? { kind: "replace", bankId: match.bankId }
            : { kind: "add" };
        }
        return initial;
      },
    );

    const addCount = Object.values(placements).filter(
      (placement) => placement.kind === "add",
    ).length;
    const overCapacity = addCount > freeSlots;
    const sourceName = banks[0]?.sourceProfileName ?? "another profile";

    return (
      <div
        className="border border-gray-200 dark:border-gray-700 rounded-lg p-4 mb-4"
        data-testid="bank-import-dialog"
      >
        <h4 className="font-medium text-gray-900 dark:text-gray-100 mb-1">
          Import {banks.length} bank{banks.length === 1 ? "" : "s"} from &ldquo;
          {sourceName}&rdquo;
        </h4>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Into: {targetProfileName} (active)
        </p>

        <div className="space-y-3">
          {banks.map((bank) => (
            <div
              key={bank.folder}
              className="flex flex-wrap items-center gap-3 text-sm"
            >
              <span className="font-medium text-gray-900 dark:text-gray-100 min-w-32">
                {bank.name}
              </span>
              <span className="text-gray-500 dark:text-gray-400">
                {bank.padCount} pad{bank.padCount === 1 ? "" : "s"},{" "}
                {bank.audioCount} sound{bank.audioCount === 1 ? "" : "s"}
              </span>
              <select
                aria-label={`Where to put ${bank.name}`}
                data-testid={`bank-placement-${bank.folder}`}
                value={placementValue(placements[bank.folder])}
                onChange={(e) =>
                  setPlacements((previous) => ({
                    ...previous,
                    [bank.folder]: placementFromValue(e.target.value),
                  }))
                }
                className="ml-auto rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-2 py-1"
              >
                <option value="add">Add as new bank</option>
                {targetBanks.map((target) => (
                  <option
                    key={target.bankId}
                    value={`replace:${target.bankId}`}
                  >
                    Replace {target.pageIndex + 1}: {target.name}
                  </option>
                ))}
                <option value="skip">Skip</option>
              </select>
            </div>
          ))}
        </div>

        <p
          className={`mt-4 text-sm ${
            overCapacity
              ? "text-red-600 dark:text-red-400"
              : "text-gray-500 dark:text-gray-400"
          }`}
        >
          {freeSlots} free slot{freeSlots === 1 ? "" : "s"} available
          {overCapacity
            ? `, and ${addCount} new bank${addCount === 1 ? "" : "s"} were asked for.`
            : "."}
        </p>

        <div className="mt-4 flex gap-2">
          <button
            onClick={onCancel}
            disabled={isImporting}
            className="px-4 py-2 rounded-md bg-gray-200 text-gray-700 hover:bg-gray-300 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={() => onImport(placements)}
            disabled={isImporting || overCapacity}
            data-testid="confirm-bank-import"
            className="px-4 py-2 rounded-md bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            {isImporting ? "Importing..." : "Import"}
          </button>
        </div>
      </div>
    );
  }

  /** The dropdown value for a placement. */
  function placementValue(placement: BankPlacement | undefined): string {
    if (!placement) return "add";
    if (placement.kind === "replace") return `replace:${placement.bankId}`;
    return placement.kind;
  }

  /** The placement a dropdown value means. */
  function placementFromValue(value: string): BankPlacement {
    if (value === "skip") return { kind: "skip" };
    if (value.startsWith("replace:")) {
      return { kind: "replace", bankId: value.slice("replace:".length) };
    }
    return { kind: "add" };
  }
  ```

- [ ] **Step 2: Add the branch to the file input handler.**

  In `ProfileManager.tsx`, add the state below the import state:

  ```tsx
  // A bank archive stops here rather than importing straight away: the user
  // has to choose a slot for each bank first.
  const [pendingBankImport, setPendingBankImport] = useState<{
    file: File;
    banks: BankSummary[];
    targetBanks: { bankId: string; name: string; pageIndex: number }[];
  } | null>(null);
  ```

  In the `format === "zip"` branch (line 851), read the manifest first:

  ```tsx
                        if (format === "zip") {
                          const { readArchiveManifest } =
                            await import("@/lib/bankTransfer");
                          const described = await readArchiveManifest(file);

                          if (described.kind === "banks") {
                            if (activeProfileId === null) {
                              setImportError(
                                "Select a profile before you import banks into it.",
                              );
                              return;
                            }
                            const { getAllPageMetadataForProfile } =
                              await import("@/lib/db");
                            const pages =
                              await getAllPageMetadataForProfile(activeProfileId);
                            setPendingBankImport({
                              file,
                              banks: described.banks,
                              targetBanks: pages
                                .map((page) => ({
                                  bankId: page.bankId,
                                  name: page.name,
                                  pageIndex: page.pageIndex,
                                }))
                                .sort((a, b) => a.pageIndex - b.pageIndex),
                            });
                            return;
                          }

                          // Handles both single- and multi-profile archives;
                          // audio streams straight from the file to IndexedDB.
                          const results = await importProfilesFromZip(
  ```

  The rest of that branch stays as it is. The `finally` block clears the file input. That behaviour is correct, because the import that waits holds its own `File` reference.

- [ ] **Step 3: Render the dialog.**

  Inside the "Import Profile" section, above the error and success boxes:

  ```tsx
  {
    pendingBankImport && (
      <BankImportPlacementDialog
        banks={pendingBankImport.banks}
        targetProfileName={
          profiles.find((profile) => profile.id === activeProfileId)?.name ??
          "the active profile"
        }
        targetBanks={pendingBankImport.targetBanks}
        freeSlots={MAX_BANKS - pendingBankImport.targetBanks.length}
        isImporting={isImporting}
        onCancel={() => setPendingBankImport(null)}
        onImport={async (placements) => {
          setImportError(null);
          setImportSuccess(null);
          try {
            setIsImporting(true);
            const result = await importBanksFromArchive(
              pendingBankImport.file,
              activeProfileId!,
              placements,
              setImportProgress,
            );
            setPendingBankImport(null);
            setImportSuccess(
              `Imported ${result.written.length} bank${
                result.written.length === 1 ? "" : "s"
              }${
                result.skipped.length > 0
                  ? `, and skipped ${result.skipped.join(", ")}`
                  : ""
              }.`,
            );
          } catch (error) {
            setImportError(
              error instanceof Error
                ? error.message
                : "Failed to import the banks.",
            );
          } finally {
            setIsImporting(false);
            setImportProgress(null);
          }
        }}
      />
    );
  }
  ```

  Add the imports at the top of the file:

  ```tsx
  import BankImportPlacementDialog from "./BankImportPlacementDialog";
  import type { BankSummary } from "@/lib/bankTransfer";
  import { MAX_BANKS } from "@/lib/bankUtils";
  ```

  Add `importBanksFromArchive` to the store destructure and to the `useShallow` selector.

- [ ] **Step 4: Check the types and lint.**

  ```bash
  npx tsc --noEmit
  npm run lint
  ```

- [ ] **Step 5: Run the app and import a bank archive.**

  Export two banks. Then select the file in the import section. Then check each of these:

  - The dialog appears.
  - A bank already in the profile starts on "Replace".
  - The import writes both banks.

- [ ] **Step 6: Commit.**

  ```bash
  git add src/components/profiles/BankImportPlacementDialog.tsx src/components/profiles/ProfileManager.tsx
  git commit -m "feat(profiles): ask where each imported bank goes before any write"
  ```

---

## Task 16: The E2E round trip

**Files:**

- `e2e-tests/bank-transfer.spec.ts` — new file

**Interfaces:**

Consumes: `gotoApp`, `waitForAppReady`, `enterEditMode`, `createTestAudioFilePath`, `openProfileManager` from `./test-helpers`.

**Note:** E2E gates on chromium only. Do not run Firefox or WebKit for this; see `docs/cross-browser-e2e.md`.

### Steps

- [ ] **Step 1: Write the spec.**

  ```ts
  import { test, expect } from "@playwright/test";
  import { gotoApp, waitForAppReady, openProfileManager } from "./test-helpers";

  /**
   * Export two banks and import them back into the same profile.
   *
   * The unit tests cover the format and the placement rules. This covers the
   * two things they cannot: that the browser's save path produces a file the
   * import path accepts, and that the grid shows the banks afterwards.
   */

  test.describe("bank export and import", () => {
    test("exports two banks and imports them back as new banks", async ({
      page,
    }, testInfo) => {
      await gotoApp(page);
      await waitForAppReady(page);

      // Two named banks with one pad each, written straight into IndexedDB.
      // The UI for that is covered elsewhere, and this test is about transfer.
      await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("impamp3DB");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const profileId = await new Promise<number>((resolve, reject) => {
          const tx = db.transaction("profiles", "readonly");
          const all = tx.objectStore("profiles").getAll();
          all.onsuccess = () => resolve(all.result[0].id);
          all.onerror = () => reject(all.error);
        });

        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction("pageMetadata", "readwrite");
          const store = tx.objectStore("pageMetadata");
          for (const [index, name] of [
            [0, "Stings"],
            [1, "Beds"],
          ] as const) {
            store.put({
              profileId,
              bankId: `e2e-${index}`,
              pageIndex: index,
              name,
              isEmergency: false,
              createdAt: new Date(),
              updatedAt: new Date(),
              _created: Date.now(),
              _modified: Date.now(),
              _fieldsModified: { name: Date.now() },
            });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      });
      await page.reload();
      await waitForAppReady(page);

      await openProfileManager(page);
      await page.getByRole("button", { name: "Import / Export" }).click();

      // Select both banks and export them.
      await page.getByTestId("bank-export-profile").waitFor();
      await page.locator('input[id^="export-bank-"]').first().check();
      await page.locator('input[id^="export-bank-"]').nth(1).check();

      const download = page.waitForEvent("download");
      await page.getByTestId("export-selected-banks").click();
      const archive = await download;
      const archivePath = testInfo.outputPath("banks.iaz");
      await archive.saveAs(archivePath);

      // Import the same archive back, both banks as new banks.
      await page
        .getByTestId("import-profile-file-input")
        .setInputFiles(archivePath);
      await expect(page.getByTestId("bank-import-dialog")).toBeVisible();
      await page.getByTestId("bank-placement-0").selectOption("add");
      await page.getByTestId("bank-placement-1").selectOption("add");
      await page.getByTestId("confirm-bank-import").click();

      await expect(page.getByText(/Imported 2 banks/)).toBeVisible();

      // Four banks now carry the two names, two of each.
      const names = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("impamp3DB");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        return new Promise<string[]>((resolve, reject) => {
          const tx = db.transaction("pageMetadata", "readonly");
          const all = tx.objectStore("pageMetadata").getAll();
          all.onsuccess = () =>
            resolve(all.result.map((page: { name: string }) => page.name));
          all.onerror = () => reject(all.error);
        });
      });
      expect(names.filter((name) => name === "Stings")).toHaveLength(2);
      expect(names.filter((name) => name === "Beds")).toHaveLength(2);
    });
  });
  ```

- [ ] **Step 2: Run the spec.**

  ```bash
  npx playwright test bank-transfer.spec.ts --project=chromium
  ```

  Expect 1 passed. A download event that never arrives means the browser took the `showSaveFilePicker` path. The chromium of Playwright hides that API by default. The blob fallback is therefore the path under test.

- [ ] **Step 3: Commit.**

  ```bash
  git add e2e-tests/bank-transfer.spec.ts
  git commit -m "test(e2e): export two banks and import them back"
  ```

---

## Task 17: Documentation

**Files:**

- `CLAUDE.md` — the "Import/Export System" section and the "Key Features Implementation" list

### Steps

- [ ] **Step 1: Update the Import/Export section.**

  Replace the "Import/Export System" list with:

  ```markdown
  Multi-format support in `src/lib/importExport.ts` and `src/lib/bankTransfer.ts`:

  - V2 format supports multi-sound pads with playback strategies
  - V1 legacy format migration from ImpAmp2
  - Multi-profile export/import functionality
  - `exportVersion: 3` is a profile archive; `exportVersion: 4` is a bank
    archive. Both are `.iaz`, and the manifest version routes the file —
    `readArchiveManifest` is the only place that decides which is which
  - A bank archive holds N banks and one shared `audio/` folder, so five banks
    that use one sound store it once
  - A bank import is two-phase: read the manifest, let the user place each
    bank, then write. Capacity is checked across the whole set before the
    first write, and a failure restores every bank it touched
  ```

- [ ] **Step 2: Add the deduplication note.**

  Add to the "Key Features Implementation" list:

  ```markdown
  - **Audio deduplication** - `addOrReuseAudioFile` returns the id of the row
    that already holds the same bytes, with a `reused` flag. Every inbound path
    uses it. Do **not** fold the reuse into `addAudioFile`: the import rollback
    calls `deleteUnreferencedAudioFiles` on what it created, and the flag is
    the only thing that stops a rollback deleting a row another profile
    depends on. Audio rows are shared across profiles as a result, so
    `deleteProfile`'s cross-profile keep is load-bearing rather than
    incidental. `src/lib/audioDedup.ts` clears the duplicates already in a
    library, behind a preview and a confirmation
  ```

- [ ] **Step 3: Extend the five-places warning.**

  Add one sentence to the `audioGainSettings` bullet:

  ```markdown
  and `collapseDuplicateAudioGroups`, which re-keys through
  `remapAudioFileIdKeys` in **"keep"** mode — "drop" there would delete every
  setting on every pad it touched
  ```

- [ ] **Step 4: Format, then commit.**

  ```bash
  npx prettier --write CLAUDE.md
  git add CLAUDE.md
  git commit -m "docs: record the bank archive format and the audio reuse rule"
  ```

---

## Closing checks

- [ ] **Run the whole unit suite with coverage.**

  ```bash
  npm run test:coverage
  ```

  Expect green, and expect the four numbers above the thresholds in `vitest.config.ts`. Raise the thresholds if the run comes in comfortably above them. Never lower them.

- [ ] **Run the E2E suite on chromium.**

  ```bash
  npm run test:e2e -- --project=chromium
  ```

- [ ] **Lint and type-check.**

  ```bash
  npm run lint
  npx tsc --noEmit
  ```

- [ ] **Ask for the review.**

  Tell the user that Task 6 and Task 7 delete audio rows and need a review before the branch merges. Report the coverage numbers and the E2E result. Merge only after the user agrees.
