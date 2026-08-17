import { useEffect } from "react";

/**
 * Escape closes this overlay, and nothing underneath it sees the key.
 *
 * Both halves matter here. `useKeyboardListener` bails the moment any overlay
 * is open — `isAnyOverlayOpen` covers the modal system, the search context and
 * the profile manager — because an overlay owns the keyboard while it is up.
 * That guard was added on its own, and the profile manager is the one overlay
 * rendered outside the modal system, so it had nothing to replace what the
 * guard swallowed: with it open, Escape neither dismissed it nor reached the
 * panic stop. It was simply a dead key, and the × in the corner was the only
 * way out.
 *
 * Capture phase and `stopImmediatePropagation` are what make it work: the
 * global listener sits on `window` too, so being first past the post is the
 * only way to keep Escape from doubling as "stop every sound in the room" the
 * moment the overlay closes.
 *
 * `isOpen` is doing more work than the name suggests, and callers should pass
 * more than "am I open". Two of these can be mounted at once — `ProfileCard`
 * opens modals from inside the profile manager — and among capture listeners
 * on the same target the *earlier registration* wins, which is the overlay
 * mounted first, i.e. the one furthest from the user. So an overlay that can
 * have another on top of it must pass false while that is the case.
 *
 * @param isOpen - Whether this overlay is open *and* on top
 * @param onClose - Called when Escape is pressed
 */
export function useEscapeToClose(isOpen: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!isOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };

    window.addEventListener("keydown", handleEscape, true);
    return () => window.removeEventListener("keydown", handleEscape, true);
  }, [isOpen, onClose]);
}
