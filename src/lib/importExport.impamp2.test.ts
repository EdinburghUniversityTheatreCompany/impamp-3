/**
 * The legacy impamp2 import — the app's on-ramp for anyone arriving from the
 * original ImpAmp.
 *
 * It had no test of any kind, and it was the one import path the hardening
 * pass never touched: pages and pads written with no sync bookkeeping, audio
 * written with no content hash and no loudness analysis, and every per-record
 * failure logged and swallowed under a "profile imported successfully!"
 * message.
 *
 * These assertions are deliberately about what ends up in the stores rather
 * than about how it gets there, so they hold across routing this path through
 * the shared `importProfileCore`.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { beforeEach, describe, expect, it } from "vitest";

const { importImpamp2Profile } = await import("./importExport");
const { getDb } = await import("./db");

type Impamp2Pad = import("./importExport").Impamp2Pad;

const dataUrl = (bytes: string, mime = "audio/mpeg") =>
  `data:${mime};base64,${btoa(bytes)}`;

function pad(overrides: Partial<Impamp2Pad> = {}): Impamp2Pad {
  return {
    page: "0",
    key: "q",
    name: "Kick",
    file: dataUrl("kick bytes"),
    filename: "kick.mp3",
    filesize: 10,
    startTime: null,
    endTime: null,
    updatedAt: 0,
    readable: true,
    ...overrides,
  };
}

/** The smallest export the original app produces: one page, two pads. */
function impamp2Json(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    padCount: 2,
    pages: {
      "0": {
        pageNo: "0",
        name: "Opening",
        emergencies: 0,
        updatedAt: 0,
        pads: {
          q: pad(),
          w: pad({ key: "w", name: "Snare", file: dataUrl("snare bytes") }),
        },
      },
      ...overrides,
    },
  });
}

const importIt = async (json = impamp2Json()) => {
  const db = await getDb();
  const profileId = await importImpamp2Profile(db, json);
  return { db, profileId };
};

beforeEach(async () => {
  await clearAllStores();
});

describe("importing an impamp2 export", () => {
  it("brings the pads, their keys and their sounds across", async () => {
    const { db, profileId } = await importIt();

    const profile = await db.get("profiles", profileId);
    expect(profile?.name).toBe("Opening");
    expect(profile?.syncType).toBe("local");

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads.map((p) => p.keyBinding).sort()).toEqual(["q", "w"]);

    const kick = pads.find((p) => p.keyBinding === "q")!;
    expect(kick.padIndex).toBe(0);
    expect(kick.name).toBe("Kick");
    expect(kick.audioFileIds).toHaveLength(1);

    const audio = await db.get("audioFiles", kick.audioFileIds[0]);
    expect(audio?.name).toBe("kick.mp3");
    expect(await audio!.blob.text()).toBe("kick bytes");
  });

  it("brings the bank name across", async () => {
    const { db, profileId } = await importIt();
    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      profileId,
    );

    expect(pages.map((p) => [p.pageIndex, p.name])).toEqual([[0, "Opening"]]);
  });

  it("repairs the legacy octet-stream MIME type from the filename", async () => {
    // V1 exports label every sound application/octet-stream, which decodes to
    // silence. The filename is the only evidence of the real format.
    const { db, profileId } = await importIt(
      JSON.stringify({
        padCount: 1,
        pages: {
          "0": {
            pageNo: "0",
            name: "Opening",
            emergencies: 0,
            updatedAt: 0,
            pads: {
              q: pad({
                file: dataUrl("wav bytes", "application/octet-stream"),
                filename: "horn.WAV",
              }),
            },
          },
        },
      }),
    );

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    const audio = await db.get("audioFiles", pads[0].audioFileIds[0]);
    expect(audio?.type).toBe("audio/wav");
  });

  it("stamps every record it writes, so a first sync cannot overwrite it", async () => {
    // Without this the merge reads each field's local timestamp as 0, and a
    // remote copy wins every differing field — see importExport.syncFields.
    const { db, profileId } = await importIt();

    const profile = await db.get("profiles", profileId);
    expect(profile?._modified).toBeGreaterThan(0);

    const pads = await db.getAllFromIndex(
      "padConfigurations",
      "profileId",
      profileId,
    );
    expect(pads[0]._modified).toBeGreaterThan(0);
    expect(pads[0]._fieldsModified?.audioFileIds).toBeGreaterThan(0);

    const pages = await db.getAllFromIndex(
      "pageMetadata",
      "profileId",
      profileId,
    );
    expect(pages[0]._modified).toBeGreaterThan(0);
    expect(pages[0]._fieldsModified?.name).toBeGreaterThan(0);
  });

  it("hashes the audio it imports", async () => {
    // A record that lands hashless makes the next sync that needs a hash read
    // and SHA-256 every audio file in the library, one blob at a time.
    const { db } = await importIt();
    const audioFiles = await db.getAll("audioFiles");

    expect(audioFiles).toHaveLength(2);
    for (const file of audioFiles) {
      expect(file.hash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("fails the import rather than reporting a half-written board", async () => {
    // Two page keys that parse to the same index collide on the unique
    // profilePage constraint. Every writer in this path used to catch its own
    // failures and carry on, and the UI then printed "imported successfully".
    const json = impamp2Json({
      "00": {
        pageNo: "00",
        name: "Collides",
        emergencies: 0,
        updatedAt: 0,
        pads: {},
      },
    });
    const db = await getDb();

    await expect(importImpamp2Profile(db, json)).rejects.toThrow();

    expect(await db.getAll("profiles")).toHaveLength(0);
    expect(await db.getAll("audioFiles")).toHaveLength(0);
  });

  it("still refuses a file that is not an impamp2 export", async () => {
    const db = await getDb();

    await expect(importImpamp2Profile(db, "{oh no")).rejects.toThrow(
      /Invalid impamp2 JSON format/,
    );
    await expect(importImpamp2Profile(db, "{}")).rejects.toThrow(
      /pages.*not found|Invalid impamp2/,
    );
  });
});
