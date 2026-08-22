import Icon, { type IconProps } from "./Icon";

/** A speaker with the level arrowed downwards, for a fade out. */
export default function FadeOutIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M15.536 8.464a5 5 0 010 7.072M12 9.5l-3 3L12 15.5m4.5-4.5h-7.5" />
    </Icon>
  );
}
