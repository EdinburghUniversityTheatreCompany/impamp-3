import Icon, { type IconProps } from "./Icon";

/** A solid tick, for marking the selected item in a dense list. */
export default function CheckSolidIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 20 20" paint="solid" {...props}>
      <path
        fillRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </Icon>
  );
}
