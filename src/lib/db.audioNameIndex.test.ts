/**
 * The `name` index on `audioFiles` stays, and nothing is allowed to read it.
 *
 * It has been there since DB v1 and has no readers left: the Drive reader's
 * name fallback was the last one, and `aa56833` removed it after it merged two
 * different recordings that happened to share a file name onto one row. An
 * unused index is a fair question — remove it with a v8 migration, or keep it?
 *
 * Kept, deliberately. It costs one index entry per audio row written, against a
 * blob, a SHA-256 and a loudness analysis on the same insert, so the saving is
 * unmeasurable. Removing it costs a schema bump, which every client runs on its
 * next load, which the `blocked` handler exists to explain when a second tab is
 * open, and which a still-cached PWA shell asking for version 7 answers with a
 * hard `VersionError`. That is a real, one-way cost for no user-visible gain.
 *
 * And the removal would not buy the thing it looks like it buys. The hazard is
 * *matching audio by name*, and the bug that proved it did not need this index:
 * a cursor over the store, or a name comparison in memory, writes the same bug
 * with no index in sight. So the guard is on the reader, not on the index —
 * which is what the second test here is. Deleting the index would leave that
 * guard doing all the work it does today.
 *
 * If a later change does remove it, this file is the place that has to be
 * argued with: the first test fails, and the v8 migration wants a test of its
 * own beside `db.v7Sequencing.test.ts`.
 */

// Must be the first import: it installs fake-indexeddb before `db.ts` runs.
import "@/lib/testSupport/browserGlobals";
import { describe, expect, it } from "vitest";
import { sourceFilesMatching } from "@/lib/testSupport/sourceScan";

const { getDb } = await import("@/lib/db");

describe("the audioFiles name index", () => {
  it("is still part of the schema", async () => {
    const db = await getDb();
    const tx = db.transaction("audioFiles", "readonly");
    // `hash` is the identity index and is read constantly; `name` is the one
    // being kept without a reader, so both are named here — a schema change
    // that dropped the wrong one would otherwise pass.
    expect([...tx.store.indexNames].sort()).toEqual(["hash", "name"]);
    await tx.done;
  });

  it("has no readers, and neither does any other lookup by sound name", () => {
    // A source scan. The rule cannot be expressed as a type or as an
    // assertion on behaviour: it is "nobody ever writes this", and its only
    // failure is a new call site, in a file nothing here imports.
    const offenders = sourceFilesMatching(/index\(\s*["']name["']\s*\)/);

    // `importExport.ts` is the exception and the only one: its lookup is on
    // `profiles`, where the index is unique and is what mints "Roadshow (2)"
    // for an imported profile whose name is taken. A *sound* has no such
    // claim on its name — `horn.wav` from two libraries is two recordings —
    // so identity is the SHA-256 of the bytes and nothing else.
    //
    // Failing here with a new file? Check which store it reaches for. If it
    // is `audioFiles`, that is the bug `aa56833` fixed, arriving again; match
    // on the content hash instead (`lookupLocalAudioByHash`).
    expect(offenders).toEqual(["lib/importExport.ts"]);
  });
});
