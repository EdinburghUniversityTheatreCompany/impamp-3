import Icon, { type IconProps } from "./Icon";

/** A cross. Every close control in the application uses it. */
export default function XIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M6 18L18 6M6 6l12 12" />
    </Icon>
  );
}
