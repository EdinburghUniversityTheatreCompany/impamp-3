import clsx from "clsx";
import Icon, { type IconProps } from "./Icon";

/**
 * The busy spinner.
 *
 * `animate-spin` is applied here rather than asked of the caller, because a
 * spinner that only spins if you remember the class is a spinner that will
 * eventually sit still. The two copies this replaces had already drifted: the
 * four in the maintenance panels drew the arc that follows the ring, the two
 * on the Drive open page drew a wedge from the centre, for no reason anyone
 * recorded. They are the ring now.
 */
export default function SpinnerIcon({
  className = "h-5 w-5",
  ...props
}: IconProps) {
  return (
    <Icon
      viewBox="0 0 24 24"
      paint="none"
      className={clsx("animate-spin", className)}
      {...props}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </Icon>
  );
}
