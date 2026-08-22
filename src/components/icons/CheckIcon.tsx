import Icon, { type IconProps } from "./Icon";

/** An outlined tick, for a completed or settled state. */
export default function CheckIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M5 13l4 4L19 7" />
    </Icon>
  );
}
