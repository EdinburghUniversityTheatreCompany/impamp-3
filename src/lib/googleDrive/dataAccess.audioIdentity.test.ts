/**
 * What the sync path is allowed to treat as "the same sound".
 *
 * Everywhere else in the app the answer is the bytes and nothing else —
 * `addOrReuseAudioFile`, `findAudioFileIdByHashIn`, `importAudioSources`. The
 * Drive reader was the last place that would also accept a matching *name*,
 * and a name is not an identity: `horn.wav` from one library and `horn.wav`
 * from another are two recordings, and merging them onto one row makes every
 * pad on both sides play whichever arrived first, with nothing left to compare
 * against afterwards.
 *
 * The fixtures are therefore built the way the hazard is: a local row that
 * predates hashing, so the store has no hash to match on, and a remote
 * reference whose name agrees and whose bytes do not — or the reverse, whose
 * bytes agree and whose name does not.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";
import {
  addAudioFiles,
  addLegacyAudioFile,
} from "@/lib/testSupport/audioFixtures";
import { stubLoudnessPipeline } from "@/lib/testSupport/loudnessPipelineStub";

// Writing an audio row fires a background analysis that reaches Web Audio,
// which node does not have. Its rejection is logged after this file has
// finished, and that log is what tears the worker down mid-run under
// coverage. See loudnessPipelineStub.ts.
stubLoudnessPipeline();

const { updateLocalData, backfillDriveFileIdsFromRemote } =
  await import("./dataAccess");
const { getDb } = await import("@/lib/db");
type ProfileSyncData = import("@/lib/syncUtils").ProfileSyncData;
type AudioFile = import("@/lib/db").AudioFile;
type PadConfiguration = import("@/lib/db").PadConfiguration;

const PROFILE_ID = 1;

/** The two recordings this suite keeps apart. */
const OURS = "the horn we recorded";
const THEIRS = "a completely different horn";

type AudioRef = ProfileSyncData["audioFiles"][number];

function syncData(audioFiles: AudioRef[], padIds: number[]): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: { id: PROFILE_ID, name: "Show board" },
    padConfigurations: [
      {
        profileId: PROFILE_ID,
        bankId: "0",
        padIndex: 0,
        name: "Horn",
        audioFileIds: padIds,
        playbackType: "sequential",
        createdAt: new Date(0),
        updatedAt: new Date(1000),
      },
    ],
    pageMetadata: [],
    audioFiles,
  } as unknown as ProfileSyncData;
}

/** Base64 as a legacy blob carries it, for bytes given as a string. */
const asBase64 = (bytes: string) => Buffer.from(bytes).toString("base64");

async function storedPad(): Promise<PadConfiguration> {
  const db = await getDb();
  const pads = await db.getAllFromIndex(
    "padConfigurations",
    "profileId",
    PROFILE_ID,
  );
  return pads[0];
}

async function audioRow(id: number): Promise<AudioFile | undefined> {
  return (await getDb()).get("audioFiles", id);
}

const audioRowCount = async () => (await getDb()).count("audioFiles");

beforeEach(async () => {
  await clearAllStores();
  const db = await getDb();
  await db.put("profiles", {
    id: PROFILE_ID,
    name: "Show board",
    syncType: "googleDrive",
    audioLocation: "googleDrive",
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  });
});

describe("updateLocalData — a sound is its bytes, not its file name", () => {
  it("does not hand a pad the same-named recording this device happens to hold", async () => {
    // A reference the reader cannot identify: no hash, and no bytes to hash.
    // The only thing it shares with the local row is the file name, and the
    // recordings are different.
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    const warnings = await updateLocalData(
      PROFILE_ID,
      syncData(
        [
          {
            id: 900,
            name: "horn.wav",
            type: "audio/wav",
            driveFileId: "drive-theirs",
          },
        ],
        [900],
      ),
    );

    expect(
      (await storedPad()).audioFileIds,
      "the pad must lose the reference rather than be given a different sound",
    ).toEqual([]);
    expect(warnings.join(" ")).toContain("horn.wav");
    // And the Drive id for *their* recording must not be filed against ours,
    // which would publish our bytes as theirs on the next upload.
    expect((await audioRow(ours.id))?.driveFileIds).toBeUndefined();
    expect(await audioRowCount()).toBe(1);
  });

  it("reuses the row it already holds when a legacy reference names those bytes", async () => {
    // The other direction: the names disagree and the bytes are the same, and
    // this device's row predates hashing, so the store has nothing to match
    // on until the blob is hashed.
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    await updateLocalData(
      PROFILE_ID,
      syncData(
        [
          {
            id: 900,
            name: "airhorn-take-2.wav",
            type: "audio/wav",
            hash: ours.hash,
            data: asBase64(OURS),
          },
        ],
        [900],
      ),
    );

    expect((await storedPad()).audioFileIds).toEqual([ours.id]);
    expect(
      await audioRowCount(),
      "the same recording must not be stored a second time",
    ).toBe(1);
  });

  it("puts the Drive id on the legacy row it reused", async () => {
    // Reuse writes nothing, so the caller has to backfill. Without it the next
    // sync uploads bytes Drive already holds and this profile already names.
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    await updateLocalData(
      PROFILE_ID,
      syncData(
        [
          {
            id: 900,
            name: "airhorn-take-2.wav",
            type: "audio/wav",
            hash: ours.hash,
            data: asBase64(OURS),
            driveFileId: "drive-ours",
          },
        ],
        [900],
      ),
    );

    expect((await audioRow(ours.id))?.driveFileIds).toEqual({
      [PROFILE_ID]: "drive-ours",
    });
  });

  it("still backfills the Drive id onto a row matched by its stored hash", async () => {
    // The ordinary case, which the rewrite must not lose.
    const [id] = await addAudioFiles([
      { name: "horn.wav", hash: "hash-ours", type: "audio/wav" },
    ]);

    await updateLocalData(
      PROFILE_ID,
      syncData(
        [
          {
            id: 900,
            name: "horn.wav",
            type: "audio/wav",
            hash: "hash-ours",
            driveFileId: "drive-ours",
          },
        ],
        [900],
      ),
    );

    expect((await storedPad()).audioFileIds).toEqual([id]);
    expect((await audioRow(id))?.driveFileIds).toEqual({
      [PROFILE_ID]: "drive-ours",
    });
  });

  it("stores a genuinely new legacy sound rather than reusing anything", async () => {
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    await updateLocalData(
      PROFILE_ID,
      syncData(
        [
          {
            id: 900,
            name: "horn.wav",
            type: "audio/wav",
            data: asBase64(THEIRS),
          },
        ],
        [900],
      ),
    );

    expect(await audioRowCount()).toBe(2);
    const pad = await storedPad();
    expect(pad.audioFileIds).toHaveLength(1);
    expect(pad.audioFileIds?.[0]).not.toBe(ours.id);
  });
});

describe("backfillDriveFileIdsFromRemote — same rule, before the upload", () => {
  it("does not file a Drive id against a same-named local recording", async () => {
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    // A whole reference as a blob carries it, name included — the parameter
    // type no longer has anywhere to put the name, which is the point.
    const theirs: AudioRef[] = [
      {
        id: 900,
        name: "horn.wav",
        type: "audio/wav",
        driveFileId: "drive-theirs",
      },
    ];
    await backfillDriveFileIdsFromRemote(theirs, PROFILE_ID);

    // Adopting it would make this profile claim their Drive file holds our
    // bytes, and `uploadMissingAudioFiles` would then never publish ours.
    expect((await audioRow(ours.id))?.driveFileIds).toBeUndefined();
  });

  it("hashes a legacy row so audio already on Drive is not uploaded again", async () => {
    const ours = await addLegacyAudioFile("horn.wav", OURS, "audio/wav");

    const theirs: AudioRef[] = [
      {
        id: 900,
        name: "airhorn-take-2.wav",
        type: "audio/wav",
        hash: ours.hash,
        driveFileId: "drive-ours",
      },
    ];
    await backfillDriveFileIdsFromRemote(theirs, PROFILE_ID);

    // This is what pays for dropping the name fallback: the bytes still match,
    // by the one thing that means the same on both devices.
    expect((await audioRow(ours.id))?.driveFileIds).toEqual({
      [PROFILE_ID]: "drive-ours",
    });
  });
});
