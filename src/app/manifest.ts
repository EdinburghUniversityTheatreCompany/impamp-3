import type { MetadataRoute } from "next";

/**
 * The web app manifest, served by Next at /manifest.webmanifest and linked
 * automatically from the document head.
 *
 * This is the only manifest. There used to be a second, hand-written
 * public/manifest.json which nothing linked but anyone could still fetch, and
 * the two had drifted: different theme colours, different icon `purpose`, and
 * two icon sizes (144 and 152) that the static file advertised but which had
 * never existed on disk, so an installing browser fetched two 404s. Those two
 * sizes now exist — see scripts/generate-icons.js — and the static file is
 * gone.
 *
 * `purpose` stays "any" rather than "any maskable", which is what the old file
 * claimed. These icons are full-bleed: the glyph reaches close enough to the
 * corners that a launcher's circular mask would clip it. Declaring maskable
 * without a safe zone drawn for it is a promise the artwork does not keep.
 */
const ICON_SIZES = [48, 72, 96, 128, 144, 152, 192, 384, 512];

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ImpAmp3 Soundboard",
    short_name: "ImpAmp3",
    description:
      "Web-based soundboard application for triggering audio clips via keyboard shortcuts",
    start_url: "/",
    display: "standalone",
    background_color: "#000000",
    theme_color: "#f2801f",
    orientation: "any",
    icons: ICON_SIZES.map((size) => ({
      src: `/icons/icon-${size}x${size}.png`,
      sizes: `${size}x${size}`,
      type: "image/png",
      purpose: "any",
    })),
    prefer_related_applications: false,
  };
}
