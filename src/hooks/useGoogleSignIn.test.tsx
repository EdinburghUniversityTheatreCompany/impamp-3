// @vitest-environment jsdom
/**
 * What a cancelled sign-in popup is allowed to touch.
 *
 * `useGoogleSignIn` was extracted from three hand-written copies — in
 * `ProfileManager`, `AuthNotification` and `/drive/open` — and picked up one
 * line none of them had: `clearGoogleAuthDetails()` in the popup's error
 * handler, under a comment that a failed popup "can leave a half-written slice
 * behind".
 *
 * It cannot. `setGoogleAuthDetails` is a single `set()` with all six fields,
 * called once at the end of `onSuccess`; `useGoogleLogin` calls either
 * `onSuccess` or `onError`, never both; and every failure inside `onSuccess`
 * is caught and reported through the *option* `onError`, which does not clear.
 * So there is no state for the popup handler to tidy up — only the session the
 * user already had.
 *
 * Which is what this covers. All three entry points can be reached while
 * signed in: `AuthNotification` renders only when signed in, `ProfileManager`
 * offers sign-in again to re-grant a scope, and the auth slice is persisted,
 * so `/drive/open` can be opened in a browser that is already signed in.
 * Closing the popup then signed the user out of Google everywhere — access
 * token, refresh token and user gone — and, because
 * `clearGoogleAuthDetails` also sets `needsReauth: false`, without even
 * leaving the prompt that would have told them.
 */
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The config the hook handed to `useGoogleLogin` on the last render. */
let loginConfig: {
  onError: (e: { error?: string; error_description?: string }) => void;
} | null = null;

vi.mock("@react-oauth/google", () => ({
  useGoogleLogin: (config: never) => {
    loginConfig = config;
    return () => {};
  },
}));

import { useProfileStore } from "@/store/profileStore";
import { useGoogleSignIn } from "@/hooks/useGoogleSignIn";

let container: HTMLDivElement;
let root: Root;

const SIGNED_IN = {
  googleUser: { name: "Ada", email: "ada@example.com" },
  googleAccessToken: "live-token",
  googleRefreshToken: "refresh-token",
  tokenExpiresAt: Date.now() + 3_600_000,
  isGoogleSignedIn: true,
  needsReauth: false,
};

beforeEach(async () => {
  loginConfig = null;
  useProfileStore.setState(SIGNED_IN);

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await clearAllStores();
});

describe("a sign-in popup that fails", () => {
  async function mountWith(onError?: (m: string) => void): Promise<void> {
    function Probe() {
      useGoogleSignIn({ onError });
      return null;
    }
    await act(async () => {
      root.render(<Probe />);
    });
  }

  it("leaves the session the user already had", async () => {
    await mountWith();

    act(() => loginConfig!.onError({ error: "popup_closed" }));

    const s = useProfileStore.getState();
    expect(s.isGoogleSignedIn).toBe(true);
    expect(s.googleAccessToken).toBe("live-token");
    expect(s.googleRefreshToken).toBe("refresh-token");
  });

  it("leaves a standing re-auth prompt standing", async () => {
    useProfileStore.setState({ needsReauth: true });
    await mountWith();

    act(() => loginConfig!.onError({ error: "popup_closed" }));

    expect(useProfileStore.getState().needsReauth).toBe(true);
  });

  it("still tells the caller what went wrong", async () => {
    const onError = vi.fn();
    await mountWith(onError);

    act(() =>
      loginConfig!.onError({
        error: "access_denied",
        error_description: "The user denied the request",
      }),
    );

    expect(onError).toHaveBeenCalledWith(
      "Login failed: The user denied the request",
    );
  });
});
