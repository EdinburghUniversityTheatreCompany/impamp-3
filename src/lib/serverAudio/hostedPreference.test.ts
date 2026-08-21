/**
 * `preferHostedAudio` — and, just as much, what it must leave alone.
 *
 * It rewrites a profile blob so a recipient fetches migrated sounds from the
 * server rather than from the owner's Drive. The behaviour that matters to
 * the user is covered end to end through the connect hook in
 * `hooks/connectServerHostedAudio.test.tsx`; these are the edges around it,
 * where the cost of being over-eager is a sound that had a working route and
 * now has none.
 */
import { describe, expect, it } from "vitest";
import { preferHostedAudio } from "./hostedPreference";
import type { ProfileSyncData } from "@/lib/syncUtils";

const HASH = "a".repeat(64);

function blobWith(audioFiles: unknown[]): ProfileSyncData {
  return {
    _syncFormatVersion: 2,
    profile: { id: 1, name: "Panto" },
    pageMetadata: [],
    padConfigurations: [{ profileId: 1, bankId: "0", padIndex: 0 }],
    audioFiles,
  } as unknown as ProfileSyncData;
}

describe("preferHostedAudio", () => {
  it("displaces the Drive id of a sound the server also holds", () => {
    const { data, driveFallbacks } = preferHostedAudio(
      blobWith([
        {
          id: 1,
          name: "ding.mp3",
          hash: HASH,
          driveFileId: "owners-file",
          serverHosted: true,
        },
      ]),
    );

    expect(data.audioFiles![0].driveFileId).toBeUndefined();
    // Displaced, not discarded: it is the fallback if the server has not
    // really got the bytes.
    expect(driveFallbacks.get(HASH)).toBe("owners-file");
  });

  it("leaves a Drive-only sound alone", () => {
    const { data, driveFallbacks } = preferHostedAudio(
      blobWith([{ id: 1, name: "ding.mp3", hash: HASH, driveFileId: "f" }]),
    );

    expect(data.audioFiles![0].driveFileId).toBe("f");
    expect(driveFallbacks.size).toBe(0);
  });

  it("leaves a hosted sound with no hash alone", () => {
    // The hosted route fetches by hash. Without one there is nothing to
    // prefer, and dropping the Drive id would strand the sound.
    const { data } = preferHostedAudio(
      blobWith([
        { id: 1, name: "ding.mp3", driveFileId: "f", serverHosted: true },
      ]),
    );

    expect(data.audioFiles![0].driveFileId).toBe("f");
  });

  it("hands back the same blob when nothing moved", () => {
    // Identity, so the overwhelmingly common case — a profile with no hosted
    // audio at all — gives the importer exactly what arrived.
    const original = blobWith([
      { id: 1, name: "ding.mp3", hash: HASH, driveFileId: "f" },
    ]);

    expect(preferHostedAudio(original).data).toBe(original);
    expect(
      preferHostedAudio(blobWith([]) as ProfileSyncData).data.audioFiles,
    ).toEqual([]);
  });

  it("changes nothing but the audio references", () => {
    const original = blobWith([
      {
        id: 1,
        name: "ding.mp3",
        hash: HASH,
        driveFileId: "owners-file",
        serverHosted: true,
      },
    ]);

    const { data } = preferHostedAudio(original);

    expect(data.padConfigurations).toBe(original.padConfigurations);
    expect(data.profile).toBe(original.profile);
    // And the ref keeps everything the importer needs off it.
    expect(data.audioFiles![0]).toMatchObject({
      id: 1,
      name: "ding.mp3",
      hash: HASH,
      serverHosted: true,
    });
  });
});
