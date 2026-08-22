import Icon, { type IconProps } from "./Icon";

/** A head and shoulders, standing for a profile. */
export default function UserIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
      <circle cx="12" cy="7" r="4" />
    </Icon>
  );
}
