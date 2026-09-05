/**
 * Regenerates the PWA icon set in public/icons from public/icons/icon.svg.
 *
 * That SVG is the favicon, and it is now the only piece of artwork in the
 * repo: every home-screen icon is the same glyph, scaled to sit inside a
 * launcher's maskable safe zone, on the app's dark background. One source
 * means the tab and the phone show the same mark, and a change to the glyph
 * is one edit and one run of this script.
 *
 * It was not always so. The script used to draw the icons from scratch with
 * node-canvas — which was never a dependency, so it could not run — and the
 * orange PNGs actually checked in came from somewhere else entirely. Then the
 * largest of those PNGs served as the master for a while, which made the set
 * reproducible but left the original drawing unrecoverable and the favicon a
 * separate design.
 *
 * Not a build step: icons change roughly never, and rasterising nine sizes on
 * every `next build` would be pure cost. Run it by hand after changing the
 * SVG, and commit the output — scripts/generate-icons.test.ts checks that the
 * committed files are what this produces:
 *
 *   node scripts/generate-icons.js
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const iconsDir = path.join(__dirname, "../public/icons");
export const faviconSvgPath = path.join(iconsDir, "icon.svg");

/**
 * Kept in step with the `icons` array in src/app/manifest.ts, which is the one
 * place these are declared to a browser; src/app/manifest.test.ts checks that
 * every size it declares exists. 144 and 152 are here because iOS and older
 * Android launchers ask for them by name; the rest are the conventional
 * ladder.
 */
export const APP_ICON_SIZES = [48, 72, 96, 128, 144, 152, 192, 384, 512];

/**
 * The tile behind the glyph: the dark-mode `--background` in
 * src/app/globals.css, and the manifest's `background_color`, so the splash
 * screen and the installed icon are one surface. generate-icons.test.ts holds
 * the manifest to this value.
 */
export const APP_ICON_BACKGROUND = "#0a0a0a";

/**
 * How much of the tile the glyph spans. The maskable safe zone is a circle of
 * radius 40% of the tile, and a launcher may cut everything outside it away.
 * The glyph's viewBox is square but the frame's top corners sit at y=1 of 16,
 * so at 0.56 the farthest corner of any drawn pixel lies about 0.385 tile
 * widths from the centre — inside the circle, with room for anti-aliasing.
 * The test measures that rather than trusting this arithmetic.
 */
const GLYPH_SCALE = 0.56;

/** The favicon SVG rasterised at `size`, transparent outside the frame. */
export function renderFavicon(svg, size) {
  return sharp(svg).resize(size, size).png().toBuffer();
}

/** The home-screen icon at `size`: the glyph centred on the dark tile. */
export async function composeAppIcon(svg, size) {
  const glyphSize = Math.round(size * GLYPH_SCALE);
  const glyph = await renderFavicon(svg, glyphSize);
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: APP_ICON_BACKGROUND,
    },
  })
    .composite([{ input: glyph, gravity: "centre" }])
    .png()
    .toBuffer();
}

export async function writeAppIcons() {
  const svg = fs.readFileSync(faviconSvgPath);
  for (const size of APP_ICON_SIZES) {
    const output = path.join(iconsDir, `icon-${size}x${size}.png`);
    fs.writeFileSync(output, await composeAppIcon(svg, size));
    console.log(`Generated ${path.relative(process.cwd(), output)}`);
  }
}

// Only when run as a script. The exports above are imported by
// generate-favicon.js and by the tests.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await writeAppIcons();
}
