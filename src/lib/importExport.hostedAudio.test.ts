/**
 * `importProfileFromSyncData` — joining a profile whose audio is hosted by
 * this app's own server rather than by Drive.
 *
 * The import recognised two ways to get at a sound: a `driveFileId`, and the
 * legacy base64 `data` field. A server-hosted file has neither — it carries
 * `serverHosted` and a content hash — so every one of them was `console.warn`ed
 * and skipped.
 *
 * This is the only path `useConnectServerProfile` takes, so on a deployment
 * with `IMPAMP_S3_*` configured, accepting a share link imported a profile
 * whose pads were all empty. Worse, the import stamps every field fresh, so the
 * first sync afterwards raised a conflict whose "keep local" answer published
 * the emptied pads back to the person who shared them.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { importProfileFromSyncData } = await import("./importExport");
const { getDb } = await import("./db");
type ProfileSyncData = import("./syncUtils").ProfileSyncData;

const donorProfile = {
  id: 99,
  name: "Hosted board",
  syncType: "server" as const,
  audioLocation: "server" as const,
  serverProfileId: "srv-theirs",
  backupReminderPeriod: 1234,
  lastBackedUpAt: 555,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

/** A blob whose bytes identify which reference produced it. */
const blobFor = (name: string) =>
  new Blob([`bytes:${name}`], { type: "audio/mpeg" });

/**
 * The same blob with a different set of audio references, so the three ways of
 * carrying bytes can be tested against one fixture rather than three copies.
 */
function syncDataWith(audioFiles: unknown[]): ProfileSyncData {
  const data = hostedSyncData() as unknown as { audioFiles: unknown[] };
  data.audioFiles = audioFiles;
  return data as unknown as ProfileSyncData;
}

function hostedSyncData(): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: donorProfile,
    pageMetadata: [],
    padConfigurations: [
      {
        profileId: 99,
        pageIndex: 0,
        padIndex: 0,
        name: "Horn",
        playbackType: "round-robin",
        audioFileIds: [200, 201],
        audioFileHashes: ["hash-horn", "hash-stab"],
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    audioFiles: [
      // No driveFileId, no embedded data — the shape a hosted-audio
      // deployment actually publishes.
      {
        id: 200,
        name: "horn.mp3",
        type: "audio/mpeg",
        hash: "hash-horn",
        serverHosted: true,
      },
      {
        id: 201,
        name: "stab.mp3",
        type: "audio/mpeg",
        hash: "hash-stab",
        serverHosted: true,
      },
    ],
  } as ProfileSyncData;
}

const noDriveDownload = async () => null;

beforeEach(async () => {
  await clearAllStores();
});

describe("joining a profile whose audio the server hosts", () => {
  it("downloads the sounds instead of importing empty pads", async () => {
    const db = await getDb();
    const downloadHosted = vi.fn(async (ref: { hash: string; name: string }) =>
      blobFor(ref.hash),
    );

    const profileId = await importProfileFromSyncData(
      db,
      hostedSyncData(),
      noDriveDownload,
      undefined,
      { syncType: "local" },
      downloadHosted,
    );

    expect(downloadHosted).toHaveBeenCalledTimes(2);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads).toHaveLength(1);
    expect(pads[0].audioFileIds).toHaveLength(2);

    // The pad must point at real local audio, not at nothing.
    const stored = await Promise.all(
      pads[0].audioFileIds!.map((id) => db.get("audioFiles", id)),
    );
    expect(stored.map((f) => f?.name)).toEqual(["horn.mp3", "stab.mp3"]);
    expect(stored.map((f) => f?.hash)).toEqual(["hash-horn", "hash-stab"]);
  });

  it("records that the imported audio is server-hosted", async () => {
    const db = await getDb();

    const profileId = await importProfileFromSyncData(
      db,
      hostedSyncData(),
      noDriveDownload,
      undefined,
      { syncType: "local" },
      async (ref: { hash: string }) => blobFor(ref.hash),
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const first = await db.get("audioFiles", pads[0].audioFileIds![0]);

    // Re-deriving this each sync is what the stored flag exists to avoid.
    expect(first?.serverHosted).toBe(true);
  });

  it("still imports the pad when no hosted downloader is supplied", async () => {
    // An ordinary Drive connect passes no hosted downloader. It must not throw.
    const db = await getDb();

    const profileId = await importProfileFromSyncData(
      db,
      hostedSyncData(),
      noDriveDownload,
      undefined,
      { syncType: "local" },
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads).toHaveLength(1);
  });
});

/**
 * The hash travels on the same `ref` whichever route carries the bytes, but
 * only the hosted branch above read it. The Drive and base64 branches dropped
 * it, and `importAudioSources` writes through a raw transaction rather than
 * `addAudioFile`, so nothing computed a replacement afterwards — the record
 * landed hashless.
 *
 * Expensive rather than wrong: the next sync needing a hash index finds none
 * and reads and SHA-256s every audio file in the library, one blob at a time,
 * on the main thread. Accept a Drive share of a large board and you pay for
 * the whole library to rebuild what you were handed.
 */
describe("the hash a shared profile already supplied", () => {
  /** `horn` by Drive file and also flagged hosted; `stab` as embedded base64. */
  const mixedRefs = [
    {
      id: 200,
      name: "horn.mp3",
      type: "audio/mpeg",
      hash: "hash-horn",
      driveFileId: "drive-horn",
      // A board migrated to hosted audio publishes both routes deliberately,
      // so this combination is legitimate and the Drive branch is what runs.
      serverHosted: true,
    },
    {
      id: 201,
      name: "stab.mp3",
      type: "audio/mpeg",
      hash: "hash-stab",
      data: Buffer.from("stab-bytes").toString("base64"),
    },
  ];

  /** Imports the mixed blob and returns the audio rows the pad names. */
  async function importMixed() {
    const db = await getDb();
    const profileId = await importProfileFromSyncData(
      db,
      syncDataWith(mixedRefs),
      async () => blobFor("horn"),
      undefined,
      { syncType: "local" },
    );
    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const rows = await Promise.all(
      pads[0].audioFileIds!.map((id) => db.get("audioFiles", id)),
    );
    return { drive: rows[0], base64: rows[1] };
  }

  it("is stored whichever route the bytes arrived by", async () => {
    const { drive, base64 } = await importMixed();

    expect([drive?.name, base64?.name]).toEqual(["horn.mp3", "stab.mp3"]);
    expect([drive?.hash, base64?.hash]).toEqual(["hash-horn", "hash-stab"]);
  });

  it("keeps serverHosted when a sound is published by both routes", async () => {
    // Losing this re-uploads a library the server already holds.
    expect((await importMixed()).drive?.serverHosted).toBe(true);
  });
});
