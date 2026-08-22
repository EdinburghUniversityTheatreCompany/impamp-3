import Icon, { type IconProps } from "./Icon";

/** A plus, for anything that adds. */
export default function PlusIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M12 4v16m8-8H4" />
    </Icon>
  );
}
