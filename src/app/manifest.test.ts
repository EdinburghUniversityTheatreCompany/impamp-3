import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import manifest from "./manifest";

/**
 * The manifest names files by path and size, and a browser that installs the
 * app fetches every one of them. Two sizes it once advertised had never
 * existed on disk, so the install fetched two 404s and nothing in the tree
 * said so.
 */
describe("manifest icons", () => {
  const icons = manifest().icons ?? [];

  it("declares at least one icon", () => {
    expect(icons.length).toBeGreaterThan(0);
  });

  it.each(icons.map((icon) => [icon.src, icon.sizes] as const))(
    "%s exists at %s",
    async (src, sizes) => {
      const file = path.join(process.cwd(), "public", src);
      expect(fs.existsSync(file), `${src} missing`).toBe(true);
      const meta = await sharp(file).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(sizes);
    },
  );

  it("offers every icon file as both any and maskable", () => {
    // generate-icons.test.ts is what proves the safe zone; this is the
    // declaration that relies on it. One entry per purpose, because Next's
    // Icon type has no room for the specification's "any maskable".
    const purposesBySrc = new Map<string, Set<string>>();
    for (const icon of icons) {
      const set = purposesBySrc.get(icon.src) ?? new Set();
      set.add(icon.purpose ?? "");
      purposesBySrc.set(icon.src, set);
    }
    expect(purposesBySrc.size).toBeGreaterThan(0);
    for (const [src, purposes] of purposesBySrc) {
      expect([...purposes].sort(), src).toEqual(["any", "maskable"]);
    }
  });
});
