import Icon, { type IconProps } from "./Icon";

/** An outlined pencil, for the editing entries in the profile menu. */
export default function PencilIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </Icon>
  );
}
