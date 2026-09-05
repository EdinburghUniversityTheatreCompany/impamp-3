import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import {
  APP_ICON_SIZES,
  composeAppIcon,
  faviconSvgPath,
  iconsDir,
  renderFavicon,
} from "./generate-icons.js";

/**
 * The icons are committed output, and every one of them is derived from
 * public/icons/icon.svg. Two things are worth a test here. The derivation
 * itself: the home-screen icon promises the launcher a maskable safe zone,
 * and that promise is geometry the artwork either keeps or does not. And the
 * committed files: a PNG edited by hand, or an SVG changed without re-running
 * the script, drifts silently — a browser fetches whatever is on disk and
 * nothing goes red.
 */

const FAVICON_SVG = fs.readFileSync(faviconSvgPath);
const ORANGE = { r: 0xf2, g: 0x80, b: 0x1f, a: 255 };
const BACKGROUND = { r: 0x0a, g: 0x0a, b: 0x0a, a: 255 };

type Pixel = { r: number; g: number; b: number; a: number };

async function readPixels(png: Buffer) {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const at = (x: number, y: number): Pixel => {
    const i = (y * info.width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  return { width: info.width, height: info.height, at, data };
}

describe("the favicon", () => {
  it("fills the window interior with the app's orange", async () => {
    const png = await renderFavicon(FAVICON_SVG, 64);
    const { at } = await readPixels(png);
    expect(at(32, 40)).toEqual(ORANGE);
  });

  it("stays transparent outside the frame", async () => {
    // A favicon sits on whatever the tab strip is coloured; a background of
    // its own would be a square on every tab.
    const png = await renderFavicon(FAVICON_SVG, 64);
    const { at } = await readPixels(png);
    expect(at(1, 1).a).toBe(0);
  });
});

describe("composeAppIcon", () => {
  it("keeps everything outside the maskable safe zone as plain background", async () => {
    // The safe zone is a circle of radius 40% of the tile: a launcher may cut
    // anything outside it away. Anything but background out there is
    // artwork the user will see clipped.
    const size = 512;
    const { at } = await readPixels(await composeAppIcon(FAVICON_SVG, size));
    const centre = size / 2;
    const radius = 0.4 * size;
    let offending: string | null = null;
    for (let y = 0; y < size && !offending; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x - centre + 0.5;
        const dy = y - centre + 0.5;
        if (dx * dx + dy * dy <= radius * radius) continue;
        const p = at(x, y);
        if (
          p.r !== BACKGROUND.r ||
          p.g !== BACKGROUND.g ||
          p.b !== BACKGROUND.b ||
          p.a !== 255
        ) {
          offending = `${x},${y} = ${JSON.stringify(p)}`;
          break;
        }
      }
    }
    expect(offending).toBeNull();
  });

  it("puts the orange window in the middle of the tile", async () => {
    const { at } = await readPixels(await composeAppIcon(FAVICON_SVG, 512));
    expect(at(256, 300)).toEqual(ORANGE);
  });

  it("renders the requested size", async () => {
    const meta = await sharp(await composeAppIcon(FAVICON_SVG, 48)).metadata();
    expect([meta.width, meta.height]).toEqual([48, 48]);
  });
});

/**
 * Pixel-compared with a small tolerance rather than byte-compared: a libvips
 * upgrade may encode the same image differently, and that is not drift.
 */
async function expectSameImage(
  committed: Buffer,
  fresh: Buffer,
  label: string,
) {
  const a = await readPixels(committed);
  const b = await readPixels(fresh);
  expect([a.width, a.height], label).toEqual([b.width, b.height]);
  let worst = 0;
  for (let i = 0; i < a.data.length; i += 1) {
    worst = Math.max(worst, Math.abs(a.data[i] - b.data[i]));
  }
  expect(
    worst,
    `${label} differs from what the script produces`,
  ).toBeLessThanOrEqual(2);
}

describe("the committed icons", () => {
  it.each(APP_ICON_SIZES)(
    "the %i px icon is what generate-icons.js produces",
    async (size) => {
      const committed = fs.readFileSync(
        path.join(iconsDir, `icon-${size}x${size}.png`),
      );
      await expectSameImage(
        committed,
        await composeAppIcon(FAVICON_SVG, size),
        `icon-${size}x${size}.png`,
      );
    },
  );

  it("favicon.ico is what generate-favicon.js produces", async () => {
    const committed = fs.readFileSync(
      path.join(iconsDir, "../../src/app/favicon.ico"),
    );
    await expectSameImage(
      committed,
      await renderFavicon(FAVICON_SVG, 256),
      "favicon.ico",
    );
  });
});
