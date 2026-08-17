/**
 * Pads that still carry the pre-V3 singular `audioFileId`.
 *
 * They should not exist — `migrateStoreV4` rewrites them into `audioFileIds` —
 * but that migration catches a per-record update error and *continues*, so a
 * record whose rewrite failed keeps the old shape and survives every later
 * upgrade. Two places then disagree about it: `deleteProfile` counts such a
 * pad as still referencing its sound, and `collectReferencedAudioFileIds` —
 * which is what the orphan scan and the "clean up unused audio" button use —
 * does not. The disagreement resolves as the deletion of a sound a pad is
 * still using, from a button labelled "clean up".
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const {
  getDb,
  collectReferencedAudioFileIds,
  findOrphanedAudioFiles,
  cleanupOrphanedAudioFiles,
} = await import("@/lib/db");
type PadConfiguration = import("@/lib/db").PadConfiguration;

/** A pad as the failed migration left it: singular id, no `audioFileIds`. */
function legacyPad(audioFileId: number): PadConfiguration {
  return {
    profileId: 1,
    pageIndex: 0,
    padIndex: 0,
    audioFileId,
    playbackType: "round-robin",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as unknown as PadConfiguration;
}

/** One sound, named only by a pad the V4 migration never rewrote. */
async function seedLegacyPadWithSound() {
  const db = await getDb();
  const audioFileId = await db.add("audioFiles", {
    name: "horn.wav",
    type: "audio/wav",
    blob: new Blob(["horn"], { type: "audio/wav" }),
    createdAt: new Date(0),
  });
  await db.add("padConfigurations", legacyPad(audioFileId));
  return { db, audioFileId };
}

beforeEach(async () => {
  await clearAllStores();
});

describe("a pad left on the pre-V3 shape", () => {
  it("counts as referencing its sound", () => {
    expect(collectReferencedAudioFileIds([legacyPad(41)])).toEqual(
      new Set([41]),
    );
  });

  it("keeps that sound out of the orphan scan", async () => {
    const { audioFileId } = await seedLegacyPadWithSound();

    const { orphanedIds } = await findOrphanedAudioFiles();
    expect(orphanedIds.has(audioFileId)).toBe(false);
  });

  it("survives the clean-up button", async () => {
    const { db, audioFileId } = await seedLegacyPadWithSound();

    await cleanupOrphanedAudioFiles();

    expect(await db.get("audioFiles", audioFileId)).toBeDefined();
  });
});
