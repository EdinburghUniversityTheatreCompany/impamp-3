// @vitest-environment jsdom
/**
 * The wrapper's one job when Google is not configured: still be a provider.
 *
 * `useGoogleLogin` throws outright without an enclosing `GoogleOAuthProvider`,
 * and it is called during render — `AuthNotification` calls `useGoogleSignIn`
 * unconditionally, on the only page there is. So a wrapper that renders its
 * children *outside* a provider does not degrade to "Drive sign-in does
 * nothing"; it takes the whole board down.
 *
 * That is exactly what a clean checkout did. The production path already
 * mounted a provider with a placeholder client id, but the development path
 * returned a setup-instructions box with the children inside a plain `<div>`,
 * so `npm run dev` — the command the README and CLAUDE.md both give — answered
 * 500 on every request with "Google OAuth components must be used within
 * GoogleOAuthProvider".
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useGoogleLogin } from "@react-oauth/google";
import GoogleAuthProviderWrapper from "./GoogleAuthProviderWrapper";

vi.mock("@/store/profileStore", () => ({
  useProfileStore: {
    getState: () => ({
      isGoogleSignedIn: false,
      googleUser: null,
      googleAccessToken: null,
    }),
  },
}));

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** Calls the hook the way `AuthNotification` does: during render, always. */
function ChildThatSignsIn() {
  useGoogleLogin({ flow: "auth-code" });
  return <p data-testid="board">the board</p>;
}

let container: HTMLDivElement;
let root: Root;
let clientId: string | undefined;

beforeEach(() => {
  clientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (clientId === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
  else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = clientId;
  vi.restoreAllMocks();
});

/** Renders the wrapper around a child that needs the provider. */
function render(): void {
  act(() => {
    root.render(
      <GoogleAuthProviderWrapper>
        <ChildThatSignsIn />
      </GoogleAuthProviderWrapper>,
    );
  });
}

describe.each(["development", "production", "test"])(
  "with no client id configured, NODE_ENV=%s",
  (nodeEnv) => {
    // Every environment, because the one that was broken was `development`
    // alone: the other two already mounted a provider with a placeholder id,
    // and only the dev branch returned its setup-instructions box with the
    // children outside any provider. A fix for "the dev server 500s" that is
    // only tested at NODE_ENV=test tests the path that already worked.
    beforeEach(() => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    });
    afterEach(() => vi.unstubAllEnvs());

    it("still renders the board", () => {
      render();

      expect(container.querySelector('[data-testid="board"]')).not.toBeNull();
    });

    it("says so on the console, so a developer who wanted Drive finds out", () => {
      render();

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("NEXT_PUBLIC_GOOGLE_CLIENT_ID"),
      );
    });
  },
);

describe("with a client id configured", () => {
  it("renders the board and stays quiet", () => {
    process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = "client-id.apps.example.com";

    render();

    expect(container.querySelector('[data-testid="board"]')).not.toBeNull();
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining("NEXT_PUBLIC_GOOGLE_CLIENT_ID"),
    );
  });
});
