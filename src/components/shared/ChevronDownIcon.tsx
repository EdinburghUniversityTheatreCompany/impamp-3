/**
 * The disclosure chevron.
 *
 * Inline markup because the project has no icon library and no sprite, and
 * every other icon here is written the same way. It lives in one place so the
 * next disclosure control copies an import rather than a path definition —
 * this exact glyph was already duplicated between the profile switcher and the
 * sync chip.
 */
export default function ChevronDownIcon({
  className = "",
}: {
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}
