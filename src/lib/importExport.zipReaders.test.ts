/**
 * The two readers every archive path shares, tested against entries no real
 * writer would produce.
 *
 * `zipEntryReaders` is the size cap and the "which entry failed" error text
 * for both the profile importer and the bank reader, so it is the one place
 * either of them checks an archive's claims about itself. Everything it has
 * to defend against is a claim rather than a measurement:
 *
 * - `uncompressedSize` comes out of the archive's central directory. It is
 *   the number the reader is asked to trust *before* it allocates anything,
 *   which is exactly why the cap is checked before `getData` is called and
 *   not after.
 * - Entry names may repeat. The zip format permits it, and a `Map` built by
 *   `new Map(entries.map(...))` silently keeps the last of them — so an
 *   archive could show one `manifest.json` to a tool that reads the first and
 *   another to this app.
 *
 * The entries here are hand-built rather than read out of a real archive on
 * purpose: zip.js refuses to *write* a duplicate name, and a 32 MB entry
 * would have to be 32 MB of real bytes to claim it honestly. A fake can claim
 * anything, which is the point.
 */

import { describe, expect, it, vi } from "vitest";
import type { Entry } from "@zip.js/zip.js";
import { MAX_ZIP_METADATA_BYTES, zipEntryReaders } from "./importExport";

/**
 * An entry that says whatever it is told to say.
 *
 * `uncompressedSize` defaults to the real length, so a test that does not
 * care about the cap gets an honest entry; the cap tests set it by hand.
 */
function fakeEntry(
  filename: string,
  text: string,
  overrides: { uncompressedSize?: number; directory?: boolean } = {},
): { entry: Entry; getData: ReturnType<typeof vi.fn> } {
  const getData = vi.fn(async () => text);
  const entry = {
    filename,
    directory: overrides.directory ?? false,
    uncompressedSize: overrides.uncompressedSize ?? text.length,
    getData,
  } as unknown as Entry;
  return { entry, getData };
}

describe("zipEntryReaders", () => {
  it("reads the text of an entry the archive holds", async () => {
    const { entry } = fakeEntry("manifest.json", '{"exportVersion":4}');
    const { readEntryText } = zipEntryReaders([entry]);

    expect(await readEntryText("manifest.json")).toBe('{"exportVersion":4}');
  });

  it("answers null for an entry the archive does not hold", async () => {
    // A missing entry is ordinary control flow, not a failure: it is how the
    // multi-profile layout is told apart from the legacy single-profile one.
    const { entry } = fakeEntry("manifest.json", "{}");
    const { readEntryText } = zipEntryReaders([entry]);

    expect(await readEntryText("profile.json")).toBeNull();
  });

  it("answers null for a directory entry rather than reading it", async () => {
    const { entry, getData } = fakeEntry("manifest.json", "{}", {
      directory: true,
    });
    const { readEntryText } = zipEntryReaders([entry]);

    expect(await readEntryText("manifest.json")).toBeNull();
    expect(getData).not.toHaveBeenCalled();
  });

  it("refuses an entry whose claimed size is over the cap, before reading it", async () => {
    // The whole value of the cap is that it is checked against the claim, so
    // the bytes are never allocated. A check after the read would be a
    // decoration on a tab that has already gone.
    const { entry, getData } = fakeEntry("manifest.json", "small in reality", {
      uncompressedSize: MAX_ZIP_METADATA_BYTES + 1,
    });
    const { readEntryText } = zipEntryReaders([entry]);

    await expect(readEntryText("manifest.json")).rejects.toThrow(
      /manifest\.json .* implausibly large/,
    );
    expect(getData).not.toHaveBeenCalled();
  });

  it("reads an entry sitting exactly on the cap", async () => {
    const { entry } = fakeEntry("manifest.json", "on the line", {
      uncompressedSize: MAX_ZIP_METADATA_BYTES,
    });
    const { readEntryText } = zipEntryReaders([entry]);

    expect(await readEntryText("manifest.json")).toBe("on the line");
  });

  it("refuses an archive holding two entries with one name", async () => {
    // zip permits it, and the last one silently wins in a Map. Refusing is
    // the only answer that cannot be made to disagree with another reader of
    // the same file.
    const first = fakeEntry("manifest.json", '{"exportVersion":3}');
    const second = fakeEntry("manifest.json", '{"exportVersion":4}');

    expect(() => zipEntryReaders([first.entry, second.entry])).toThrow(
      /two entries named manifest\.json/,
    );
  });

  it("allows two entries whose names merely look alike", async () => {
    const a = fakeEntry("banks/0/bank.json", "a");
    const b = fakeEntry("banks/1/bank.json", "b");
    const { readEntryText } = zipEntryReaders([a.entry, b.entry]);

    expect(await readEntryText("banks/0/bank.json")).toBe("a");
    expect(await readEntryText("banks/1/bank.json")).toBe("b");
  });

  it("truncates an absurd entry name rather than echoing it into an error", async () => {
    // The name is a string out of the file, so it can be megabytes long. An
    // error message built from it goes to a toast and to the console.
    const name = "a".repeat(5000);
    const first = fakeEntry(name, "x");
    const second = fakeEntry(name, "y");

    let message = "";
    try {
      zipEntryReaders([first.entry, second.entry]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/two entries named/);
    expect(message.length).toBeLessThan(200);
  });

  it("parses an entry's JSON", () => {
    const { parseEntryJson } = zipEntryReaders([]);

    expect(parseEntryJson("manifest.json", '{"exportVersion":4}')).toEqual({
      exportVersion: 4,
    });
  });

  it("names the entry that is not valid JSON", () => {
    const { parseEntryJson } = zipEntryReaders([]);

    expect(() => parseEntryJson("banks/0/bank.json", "{ not json")).toThrow(
      /banks\/0\/bank\.json in this archive is not valid JSON/,
    );
  });
});
