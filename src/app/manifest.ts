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
 * `purpose` is "any maskable", and that is a promise about the artwork: a
 * launcher may crop a maskable icon to a circle of radius 40% of the tile,
 * so nothing but background may lie outside that circle. The old
 * public/manifest.json claimed maskable over full-bleed icons the mask would
 * have clipped; the icons scripts/generate-icons.js derives now keep the glyph
 * inside the safe zone, and scripts/generate-icons.test.ts measures that
 * rather than trusting it. `background_color` is the tile behind the glyph,
 * so the splash screen and the installed icon are one surface — the same test
 * holds the two literals together.
 *
 * Each size is listed twice, once per purpose, because Next's `Icon` type
 * takes a single purpose per entry where the specification would accept
 * "any maskable" in one. The file is the same either way.
 */
const ICON_PURPOSES = ["any", "maskable"] as const;
const ICON_SIZES = [48, 72, 96, 128, 144, 152, 192, 384, 512];

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ImpAmp3 Soundboard",
    short_name: "ImpAmp3",
    description:
      "Web-based soundboard application for triggering audio clips via keyboard shortcuts",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0a",
    theme_color: "#f2801f",
    orientation: "any",
    icons: ICON_SIZES.flatMap((size) =>
      ICON_PURPOSES.map((purpose) => ({
        src: `/icons/icon-${size}x${size}.png`,
        sizes: `${size}x${size}`,
        type: "image/png",
        purpose,
      })),
    ),
    prefer_related_applications: false,
  };
}
