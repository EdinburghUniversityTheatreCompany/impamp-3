import Icon, { type IconProps } from "./Icon";

/** Three sliders, evoking per-sound gain controls. */
export default function SlidersIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M4 6h6m4 0h6M4 6a2 2 0 104 0 2 2 0 00-4 0zM4 18h10m4 0h2M4 18a2 2 0 104 0 2 2 0 00-4 0zM4 12h2m4 0h10M14 12a2 2 0 104 0 2 2 0 00-4 0z" />
    </Icon>
  );
}
