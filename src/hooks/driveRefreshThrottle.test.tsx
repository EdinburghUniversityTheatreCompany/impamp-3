// @vitest-environment jsdom
/**
 * One refresh attempt per minute, across every copy of the hook.
 *
 * `useGoogleDriveSync` runs a token-validation poll, and
 * `ClientSideInitializer`, `ProfileManager`, every `ProfileCard`,
 * `ProfileSyncPanel`, `SharingPanel`, `ConnectProfileList`,
 * `useConnectServerProfile` and both share-link pages mount it — so opening
 * the profile manager on ten profiles adds a dozen instances to one that has
 * been polling since the app loaded. The throttle is therefore module-level:
 * held per instance, each newcomer arrives with a fresh throttle and asks
 * again, and every answer writes the refreshed token to the store, last
 * writer winning.
 *
 * `auth.ts`'s in-flight promise does not cover this and cannot. It coalesces
 * refreshes that *race*; instances mounted at different times ask one after
 * another, each after the last has settled and cleared it. That is why the
 * first case below mounts in two batches rather than twelve at once — twelve
 * at once is the shape the in-flight promise already handles, and it passes
 * with a per-instance throttle, measuring nothing.
 *
 * The second case is the other half of the same guard: a refresh **feeds the
 * effect that fired it**. Installing the token writes the store, the store
 * re-runs the validation effect, and a token still stale by `isTokenValid`'s
 * five-minute buffer sends it straight back round. Nothing else stops that.
 *
 * Both count `POST /api/auth/google/refresh` requests rather than mocking
 * `sharedCheckAndRefresh`, because the request count is what the user's
 * account and Google's issuance actually see.
 */

// Must be the first import: it installs `window` before `db.ts` can read it.
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Every `POST /api/auth/google/refresh` the run made. */
let refreshCalls = 0;

/**
 * Every refreshed token is granted 60 seconds, which is *inside*
 * `isTokenValid`'s five-minute buffer — so the token a refresh installs is
 * already stale when it lands, and nothing but the throttle stops the next
 * ask. A real short-lived grant behaves the same way.
 */
const GRANT_SECONDS = 60;

vi.mock("@/lib/fetchWithTimeout", () => ({
  fetchWithTimeout: vi.fn(async (url: string): Promise<Response> => {
    if (String(url).includes("/api/auth/google/refresh")) {
      refreshCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: `fresh-${refreshCalls}`,
          expires_in: GRANT_SECONDS,
        }),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      text: async () => "{}",
      json: async () => ({}),
    } as unknown as Response;
  }),
}));

import { useProfileStore } from "@/store/profileStore";
import {
  resetGoogleTokenRefreshState,
  useGoogleDriveSync,
} from "@/hooks/useGoogleDriveSync";

/**
 * Signed in, holding a token that expired a minute ago, and not yet told to
 * sign in again — the state the poll exists to act on.
 */
function signedInWithAnExpiredToken(): void {
  useProfileStore.setState({
    googleUser: { name: "Ada", email: "ada@example.com" },
    googleAccessToken: "stale-token",
    googleRefreshToken: "refresh-token",
    tokenExpiresAt: Date.now() - 60_000,
    isGoogleSignedIn: true,
    needsReauth: false,
  });
}

function Probe() {
  useGoogleDriveSync();
  return null;
}

const mounted: { root: Root; container: HTMLDivElement }[] = [];

/** Mounts `count` more copies of the hook, as opening a panel would. */
async function mountInstances(count: number): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <>
        {Array.from({ length: count }, (_, i) => (
          <Probe key={i} />
        ))}
      </>,
    );
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  refreshCalls = 0;
  resetGoogleTokenRefreshState();
  signedInWithAnExpiredToken();
});

afterEach(async () => {
  await act(async () => {
    for (const { root } of mounted) root.unmount();
  });
  for (const { container } of mounted) container.remove();
  mounted.length = 0;
  await clearAllStores();
});

describe("the Drive token-validation poll", () => {
  it("does not re-ask when more copies mount after one has already asked", async () => {
    await mountInstances(1);
    expect(refreshCalls).toBe(1);

    // The profile manager opens over a board that has been polling since load.
    await mountInstances(10);

    expect(refreshCalls).toBe(1);
  });

  it("does not loop when the refreshed token is itself already stale", async () => {
    await mountInstances(1);

    expect(useProfileStore.getState().googleAccessToken).toBe("fresh-1");
    expect(refreshCalls).toBe(1);
  });
});
