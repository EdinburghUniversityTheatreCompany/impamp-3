/**
 * The one place that knows which modifier key means what on which platform.
 *
 * Keep new chords going through here rather than reading `ctrlKey` directly:
 * a chord written as Control-only is silently unreachable on a Mac, and the
 * only symptom is a pad that plays when the operator meant to arm it.
 */

/**
 * True when a mouse or keyboard event carries the "arm" chord — Ctrl on
 * Windows and Linux, Command on macOS.
 *
 * Control alone is not enough. macOS reserves Control+click as the secondary
 * click and the browser acts on that before the page sees it: Chrome
 * dispatches `contextmenu` and no `click` at all, Firefox dispatches
 * `auxclick`, and only Safari still delivers a `click` — on top of a context
 * menu nobody asked for. So the chord this app documented was, on a Mac,
 * either a no-op or a context menu, and arming a cue with the mouse could not
 * be done at all.
 *
 * Command is the modifier macOS leaves to the application, and Command+click
 * arrives as an ordinary `click` with `metaKey` set. Both are accepted
 * everywhere rather than switching on the platform: Command is unreachable on
 * a PC keyboard (the Windows key is claimed by the OS), and Control still
 * reaches the page from a Mac *keyboard* even where the mouse chord does not,
 * so accepting both costs nothing and removes a platform test from the hot
 * path of every click.
 */
export const hasArmModifier = (event: {
  ctrlKey: boolean;
  metaKey: boolean;
}): boolean => event.ctrlKey || event.metaKey;

/**
 * True on macOS, iOS and iPadOS — used only to *label* the chord, never to
 * decide whether it fired.
 *
 * `navigator.platform` is deprecated but is still the only string every
 * browser agrees on; `userAgentData.platform` is preferred where it exists and
 * the user agent is the last resort. iPadOS reports itself as "MacIntel",
 * which is the right answer here anyway.
 */
export const isApplePlatform = (): boolean => {
  if (typeof navigator === "undefined") return false;

  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } })
      .userAgentData?.platform ||
    navigator.platform ||
    navigator.userAgent ||
    "";

  return /mac|iphone|ipad|ipod/i.test(platform);
};

/**
 * How to write the arm modifier in help text and tooltips: the Command glyph
 * on Apple platforms, "Ctrl" everywhere else.
 */
export const armModifierLabel = (isApple: boolean): string =>
  isApple ? "⌘" : "Ctrl";
