/**
 * The one `<svg>` element in the application.
 *
 * Every icon in `src/components/icons/` is this component plus its own path
 * data, which is how the three things that had drifted stay fixed: the size
 * and colour arrive as classes from the call site rather than as attributes
 * baked into the markup, the paint (stroke weight, line caps) is one table
 * instead of a `strokeLinecap="round"` repeated on every `<path>`, and the
 * accessibility is decided here rather than remembered — an icon is hidden
 * from assistive technology unless it is given a name.
 *
 * Naming in this directory describes the *glyph*, not the caller, so a second
 * "close" button finds `XIcon` rather than inventing `CloseButtonIcon`. Where
 * two visually different glyphs mean the same thing — an outline check and a
 * solid one, an outline pencil and a filled one — both are kept and named for
 * their weight. Collapsing those is a design decision, not a deduplication:
 * the header toolbar is a coherent set of 16px filled glyphs and the profile
 * menu a coherent set of 24px outlined ones, and unifying across them would
 * make each set inconsistent to fix a duplication that is only skin-deep.
 *
 * @module components/icons/Icon
 */

import type { ReactNode, SVGProps } from "react";

export interface IconProps {
  /**
   * Sizing and colour, as Tailwind classes. This is the only place either is
   * set — no icon carries a `width`, `height` or `text-*` of its own.
   */
  className?: string;

  /**
   * An accessible name, for the rare icon that is the only thing carrying its
   * meaning. Leave it off — the default — whenever the icon sits next to text
   * that says the same thing or inside a control that is already labelled, and
   * the icon is hidden from assistive technology instead. Announcing it twice
   * is worse than not announcing it.
   */
  title?: string;
}

type Paint = "outline" | "solid" | "none";

interface BaseIconProps extends IconProps {
  /** The glyph's own coordinate system. */
  viewBox: string;

  /**
   * How the glyph is painted. `none` is for the two icons that paint
   * themselves: the spinner, whose arc and track differ, and the Google mark,
   * whose four paths are brand colours.
   */
  paint?: Paint;

  children: ReactNode;
}

const paints: Record<Paint, SVGProps<SVGSVGElement>> = {
  outline: {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  solid: { fill: "currentColor" },
  // `fill="none"` even here: an `<svg>` with no fill defaults to black, which
  // every child inherits — that is what would fill the spinner's track disc.
  none: { fill: "none" },
};

export default function Icon({
  className = "h-5 w-5",
  title,
  viewBox,
  paint = "outline",
  children,
}: BaseIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={viewBox}
      className={className}
      {...paints[paint]}
      {...(title
        ? { role: "img", "aria-label": title }
        : { "aria-hidden": true })}
    >
      {children}
    </svg>
  );
}
