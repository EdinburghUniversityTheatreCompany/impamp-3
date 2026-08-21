/**
 * What an import does when the library already holds the bytes.
 *
 * Audio rows are global, not per profile, so the same sounds imported twice
 * used to cost two blobs. Reuse fixes that, and it makes the rollback rule
 * load-bearing: a failed import must delete only the rows it created, or a
 * retry takes a sound out from under whatever was here first.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. Its rejection is logged after this file has
// finished, and that log is what tears the worker down mid-run under
// coverage. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

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

const hashOfSharedBytes = await computeBlobHash(sharedBlob());

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

  it("reuses a sound the source names by hash without reading its bytes", async () => {
    // The whole point of trusting a supplied hash: the archive entry is never
    // extracted and the Drive file is never downloaded. Re-importing a board
    // whose sounds are already here should cost no reads at all.
    const db = await getDb();
    const existingId = await addAudioFile({
      name: "already-here.mp3",
      type: "audio/mpeg",
      blob: sharedBlob(),
    });
    const download = vi.fn(async () => sharedBlob());

    const profileId = await importProfileFromSyncData(
      db,
      hashedRef(await computeBlobHash(sharedBlob())),
      download,
    );

    expect(download).not.toHaveBeenCalled();
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads[0].audioFileIds).toEqual([existingId]);
    expect(await db.getAll("audioFiles")).toHaveLength(1);
    // Reuse writes nothing: name and type belong to whoever wrote the row,
    // not to the archive that happened to name the same bytes second.
    expect((await db.get("audioFiles", existingId))?.name).toBe(
      "already-here.mp3",
    );
  });

  it("writes one row when two sources race in with the same bytes", async () => {
    // Sync imports run four downloads at a time and neither ref carries a
    // hash, so both blobs are in hand before either is written. Only the
    // check inside the write transaction can collapse them.
    const db = await getDb();
    const download = vi.fn(async () => sharedBlob());

    const profileId = await importProfileFromSyncData(
      db,
      twoHashlessRefsOnePad(),
      download,
    );

    expect(download).toHaveBeenCalledTimes(2);
    expect(await db.getAll("audioFiles")).toHaveLength(1);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const rows = await db.getAll("audioFiles");
    expect(pads[0].audioFileIds).toEqual([rows[0].id, rows[0].id]);
  });

  it("hashes a source that arrives without one", async () => {
    // Storing `hash: source.hash` straight through leaves an archive with no
    // hash producing a row invisible to the hash index — and the next sync
    // that needs one then SHA-256s every blob in the library.
    const db = await getDb();
    const profileId = await importProfileFromSyncData(
      db,
      twoHashlessRefsOnePad(),
      async () => sharedBlob(),
    );
    expect(profileId).toBeGreaterThan(0);

    const rows = await db.getAll("audioFiles");
    expect(rows[0].hash).toBe(await computeBlobHash(sharedBlob()));
  });

  it("hashes a source whose hash is an empty string", async () => {
    // An archive manifest and a sync blob are both unvalidated JSON, so ""
    // is a shape that reaches here. Stored as-is it becomes a key that every
    // later empty-hash row would sit under; treated as absent, the bytes get
    // their real hash.
    const db = await getDb();
    const data = twoHashlessRefsOnePad();
    data.audioFiles = data.audioFiles!.map((ref) => ({ ...ref, hash: "" }));

    await importProfileFromSyncData(db, data, async () => sharedBlob());

    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);
    expect(rows[0].hash).toBe(await computeBlobHash(sharedBlob()));
  });

  it("leaves a row that the failed import only reused", async () => {
    // The row is an orphan: no pad names it, so `deleteUnreferencedAudioFiles`
    // has nothing keeping it. Without the created/reused distinction the
    // rollback counts it as one of its own and deletes bytes it never wrote.
    const db = await getDb();
    const orphanId = await addAudioFile({
      name: "orphan.mp3",
      type: "audio/mpeg",
      blob: sharedBlob(),
    });

    await expect(
      importProfileFromSyncData(db, collidingPads(), async () => sharedBlob()),
    ).rejects.toThrow();

    expect(await db.get("audioFiles", orphanId)).toBeDefined();
    expect(await db.getAll("profiles")).toHaveLength(0);
  });

  it("leaves a row the failed import reused without ever reading it", async () => {
    // The other half of the same rule, and the one a rollback test keyed to a
    // hashless ref cannot reach: this import reused the row at the *pre-read*
    // check, before `getBlob` was called at all. That branch has its own
    // `audioIdMap.set`, so it has its own chance to file a reused row as one
    // of its own — and the rollback would then delete bytes it never wrote.
    const db = await getDb();
    const orphanId = await addAudioFile({
      name: "orphan.mp3",
      type: "audio/mpeg",
      blob: sharedBlob(),
    });
    const data = collidingPads();
    data.audioFiles = data.audioFiles!.map((ref) => ({
      ...ref,
      hash: hashOfSharedBytes,
    }));
    const download = vi.fn(async () => sharedBlob());

    await expect(
      importProfileFromSyncData(db, data, download),
    ).rejects.toThrow();

    expect(download).not.toHaveBeenCalled();
    expect(await db.get("audioFiles", orphanId)).toBeDefined();
    expect(await db.getAll("profiles")).toHaveLength(0);
  });

  it("still deletes a row that the failed import created", async () => {
    const db = await getDb();

    await expect(
      importProfileFromSyncData(db, collidingPads(), async () => sharedBlob()),
    ).rejects.toThrow();

    expect(await db.getAll("audioFiles")).toHaveLength(0);
  });
});

const donorProfile = {
  id: 42,
  name: "Board",
  syncType: "local",
  backupReminderPeriod: 1234,
  lastBackedUpAt: 555,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const donorPad = {
  profileId: 42,
  bankId: "0",
  padIndex: 0,
  name: "Horn",
  playbackType: "round-robin" as const,
  audioFileIds: [200],
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** One pad naming one Drive-hosted sound, whose ref carries a content hash. */
function hashedRef(hash: string): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [donorPad],
    audioFiles: [
      {
        id: 200,
        name: "horn.mp3",
        type: "audio/mpeg",
        driveFileId: "drive-1",
        hash,
      },
    ],
  } as unknown as ProfileSyncData;
}

/** One pad naming two hashless refs that turn out to hold the same bytes. */
function twoHashlessRefsOnePad(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [{ ...donorPad, audioFileIds: [200, 201] }],
    audioFiles: [
      { id: 200, name: "horn.mp3", type: "audio/mpeg", driveFileId: "drive-1" },
      { id: 201, name: "copy.mp3", type: "audio/mpeg", driveFileId: "drive-2" },
    ],
  } as unknown as ProfileSyncData;
}

/**
 * Two pads on one bank and pad index. The second breaks the unique index, so
 * the pad writer throws after the audio is already written.
 */
function collidingPads(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [donorPad, { ...donorPad, name: "Collides" }],
    audioFiles: [
      { id: 200, name: "horn.mp3", type: "audio/mpeg", driveFileId: "drive-1" },
    ],
  } as unknown as ProfileSyncData;
}
