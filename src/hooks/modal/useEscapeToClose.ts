import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * The open overlays' Escape handlers, outermost first.
 *
 * A stack rather than a listener per overlay, because a listener per overlay
 * gets the ordering exactly backwards. Among capture-phase listeners on the
 * same target the *earlier registration* wins, and the earlier registration is
 * always the overlay that mounted first — i.e. the one furthest from the user.
 * So the profile manager would have eaten the Escape meant for a confirm dialog
 * opened from inside it, and the pad editor the one meant for the waveform
 * trimmer portalled on top of it. That second case is not hypothetical: it is
 * exactly how Escape in the trimmer used to close the whole editor and discard
 * the edit.
 *
 * One window listener dispatching to the top of the stack gets it right by
 * construction, and keeps working however deep the overlays go.
 */
const escapeStack: Array<MutableRefObject<() => void>> = [];

let isListening = false;

function handleWindowKeydown(event: KeyboardEvent) {
  if (event.key !== "Escape") return;

  const topmost = escapeStack[escapeStack.length - 1];
  if (!topmost) return;

  // Escape must not reach the global keyboard listener, where it doubles as
  // the panic button that stops every sound in the room. That listener is on
  // `window` too, so capture phase plus stopImmediatePropagation is the only
  // way to be sure of getting there first.
  event.preventDefault();
  event.stopImmediatePropagation();
  topmost.current();
}

function startListening() {
  if (isListening) return;
  window.addEventListener("keydown", handleWindowKeydown, true);
  isListening = true;
}

function stopListening() {
  if (!isListening) return;
  window.removeEventListener("keydown", handleWindowKeydown, true);
  isListening = false;
}

/**
 * Escape closes this overlay, and nothing underneath it sees the key.
 *
 * `useKeyboardListener` bails the moment any overlay is open — `isAnyOverlayOpen`
 * covers the modal system, the search context and the profile manager — because
 * an overlay owns the keyboard while it is up. That guard was added on its own,
 * and the profile manager is the one overlay rendered outside the modal system,
 * so it had nothing to replace what the guard swallowed: with it open, Escape
 * neither dismissed it nor reached the panic stop. It was simply a dead key,
 * and the × in the corner was the only way out.
 *
 * Nesting is handled for you: the most recently opened overlay is the one
 * Escape closes, and closing it hands Escape back to the one below.
 *
 * @param isOpen - Whether this overlay is currently open
 * @param onClose - Called when Escape is pressed while it is topmost
 */
export function useEscapeToClose(isOpen: boolean, onClose: () => void): void {
  // The handler is read through a ref so that a new `onClose` identity — which
  // is every render, for the inline arrow functions most callers pass — does
  // not re-order the stack by unregistering and pushing again.
  const handlerRef = useRef(onClose);
  useEffect(() => {
    handlerRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    escapeStack.push(handlerRef);
    startListening();

    return () => {
      const index = escapeStack.lastIndexOf(handlerRef);
      if (index !== -1) escapeStack.splice(index, 1);
      if (escapeStack.length === 0) stopListening();
    };
  }, [isOpen]);
}
