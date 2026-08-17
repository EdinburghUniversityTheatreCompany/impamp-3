/**
 * Regenerates the PWA icon set in public/icons from a single master image.
 *
 * This script used to draw the icons from scratch with node-canvas — black
 * squares with the word "ImpAmp3" and three arcs — and it could not run at
 * all, because `canvas` has never been a dependency of this repo. That left
 * the icon set unreproducible: the orange PNGs that are actually checked in
 * came from somewhere else entirely, and the two sizes the old
 * public/manifest.json advertised (144 and 152) were simply missing, so an
 * installing browser fetched two 404s.
 *
 * So the master is now the largest icon that exists, and every other size is a
 * resize of it with sharp — the image library this repo already depends on and
 * already uses for the favicon. Running this is idempotent and its output is
 * what is committed, which is the only arrangement in which "how were these
 * made?" has an answer.
 *
 * Not a build step: icons change roughly never, and rasterising eight sizes on
 * every `next build` would be pure cost. Run it by hand after changing the
 * master:
 *
 *   node scripts/generate-icons.js
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const iconsDir = path.join(__dirname, "../public/icons");
const masterPath = path.join(iconsDir, "icon-512x512.png");

/**
 * Kept in step with the `icons` array in src/app/manifest.ts, which is the one
 * place these are declared to a browser. 144 and 152 are here because iOS and
 * older Android launchers ask for them by name; the rest are the conventional
 * ladder.
 */
const sizes = [48, 72, 96, 128, 144, 152, 192, 384, 512];

const master = await sharp(fs.readFileSync(masterPath));
const { width, height } = await master.metadata();
if (width !== 512 || height !== 512) {
  throw new Error(`Expected a 512x512 master, got ${width}x${height}`);
}

for (const size of sizes) {
  const output = path.join(iconsDir, `icon-${size}x${size}.png`);
  const buffer = await sharp(fs.readFileSync(masterPath))
    .resize(size, size, { fit: "cover" })
    .png()
    .toBuffer();
  fs.writeFileSync(output, buffer);
  console.log(`Generated ${path.relative(process.cwd(), output)}`);
}
