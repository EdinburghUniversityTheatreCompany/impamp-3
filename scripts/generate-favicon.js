/**
 * Writes src/app/favicon.ico from public/icons/icon.svg. This one is a build
 * step (see `prebuild` in package.json), so the checked-in file is always
 * what the SVG says. The rasteriser is shared with generate-icons.js, which
 * derives the home-screen set from the same SVG.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { faviconSvgPath, renderFavicon } from "./generate-icons.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const faviconPath = path.join(__dirname, "../src/app/favicon.ico");

/** A PNG in a .ico's clothing; every browser this app targets accepts that. */
const faviconSize = 256;

try {
  const svg = fs.readFileSync(faviconSvgPath);
  fs.writeFileSync(faviconPath, await renderFavicon(svg, faviconSize));
  console.log("✓ Favicon generated successfully!");
} catch (error) {
  console.error("Error generating favicon:", error);
  process.exit(1);
}
