import Icon, { type IconProps } from "./Icon";

/** An information mark in a ring. */
export default function InfoCircleIcon(props: IconProps) {
  return (
    <Icon viewBox="0 0 24 24" {...props}>
      <path d="M13 16h-1v-4h-1m1-4h.01M12 2a10 10 0 100 20A10 10 0 0012 2z" />
    </Icon>
  );
}
