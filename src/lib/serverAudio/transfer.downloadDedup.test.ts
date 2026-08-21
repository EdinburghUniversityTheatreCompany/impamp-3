/**
 * What `downloadProfileAudio` does with bytes the library turns out to
 * already hold.
 *
 * It checks by hash before it asks for a download ticket, so the ordinary
 * duplicate never reaches the write. That check is a separate transaction
 * from the write, though, and several syncs run at once in one browser — one
 * per connected profile, plus whatever a second tab is doing. Two of them
 * pulling the same shared sound both miss the check, both download, and both
 * write. `addAudioFile` stored two rows for that.
 *
 * Its own fixtures rather than the mocked-database ones in `transfer.test.ts`:
 * that suite replaces `@/lib/db` wholesale, so it can see which function was
 * called and not what the store ends up holding — and the pre-check tests
 * there return before the write, so they pass whichever way the write goes.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSyncData } from "@/lib/syncUtils";

const requestProfileDownloadUrl = vi.fn();
vi.doMock("./api", async () => ({
  ...(await vi.importActual<typeof import("./api")>("./api")),
  requestProfileDownloadUrl,
}));

const { addAudioFile, computeBlobHash, getDb } = await import("@/lib/db");
const { downloadProfileAudio } = await import("./transfer");

/** The same bytes every time, as a fresh Blob. */
function horn(): Blob {
  return new Blob(["the horn bytes"], { type: "audio/wav" });
}

/** A hosted reference to the horn, as a profile blob would carry it. */
async function hornRef(): Promise<ProfileSyncData["audioFiles"]> {
  return [
    {
      id: 1,
      name: "horn.wav",
      type: "audio/wav",
      hash: await computeBlobHash(horn()),
      serverHosted: true,
    },
  ];
}

/**
 * Makes the transfer itself land the same bytes before it returns them.
 *
 * That is what a second sync finishing first looks like from in here: the
 * download is where the time goes, and it sits outside the check above it.
 */
function raceAgainstAnotherSync(): void {
  vi.mocked(fetch).mockImplementation(async () => {
    await addAudioFile({ name: "horn.wav", type: "audio/wav", blob: horn() });
    return new Response(horn(), { status: 200 });
  });
}

beforeEach(async () => {
  await clearAllStores();
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn());
  requestProfileDownloadUrl.mockResolvedValue({
    url: "https://bucket.test/get",
    sizeBytes: 14,
    contentType: "audio/wav",
    expiresInSeconds: 3600,
  });
  vi.mocked(fetch).mockResolvedValue(new Response(horn(), { status: 200 }));
});

describe("downloadProfileAudio", () => {
  it("stores audio the library does not have", async () => {
    const result = await downloadProfileAudio("srv", await hornRef());

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(result.downloaded).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("horn.wav");
    expect(rows[0].hash).toBe(await computeBlobHash(horn()));
    expect(rows[0].serverHosted).toBe(true);
  });

  it("keeps one row when another sync lands the same bytes mid-download", async () => {
    raceAgainstAnotherSync();

    await downloadProfileAudio("srv", await hornRef());

    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });

  it("records that the bucket holds a row it reused", async () => {
    // Reuse returns the row exactly as it found it, so the flag saying these
    // bytes are already in the bucket is still missing. Without it the next
    // push uploads them again — `uploadProfileAudio` decides what to send
    // from this very field.
    raceAgainstAnotherSync();

    await downloadProfileAudio("srv", await hornRef());

    const db = await getDb();
    const rows = await db.getAll("audioFiles");
    expect(rows).toHaveLength(1);
    expect(rows[0].serverHosted).toBe(true);
  });

  it("does not ask for a download ticket for bytes it already holds", async () => {
    // The pre-check earns its keep: the point is to skip the transfer, not
    // merely to avoid the second row.
    await addAudioFile({
      name: "horn-under-another-name.wav",
      type: "audio/wav",
      blob: horn(),
    });

    const result = await downloadProfileAudio("srv", await hornRef());

    expect(requestProfileDownloadUrl).not.toHaveBeenCalled();
    expect(result.downloaded).toBe(0);
    const db = await getDb();
    expect(await db.getAll("audioFiles")).toHaveLength(1);
  });
});
