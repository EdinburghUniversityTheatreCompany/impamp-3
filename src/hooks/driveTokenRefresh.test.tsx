// @vitest-environment jsdom
/**
 * What every backend does with a refreshed Drive token.
 *
 * Three call sites hand Google Drive code a "here is a newer token" callback:
 * `useGoogleDriveSync` (its own API surface and its validation poll),
 * `useServerSync` (audio still comes from Drive, so a server sync carries a
 * Drive token), and `useProfileSync` (moving a profile to Drive has to create
 * its folder first). All three wrote the same handler by hand, and the copies
 * drifted: only the first refused a refresh that came back without an access
 * token.
 *
 * That guard is the whole point. `refreshAccessToken` builds its result as
 * `accessToken: data.access_token` with no check, so a 200 that omits the
 * field yields `accessToken: undefined` — and the unguarded copies then wrote
 * `isGoogleSignedIn: true` with no token and, through
 * `setGoogleAuthDetails`, cleared `needsReauth`. The one state that would
 * have prompted the user to sign in again is exactly what gets erased.
 */
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenInfo } from "@/lib/googleDrive/types";

const mocks = vi.hoisted(() => ({
  syncServerProfile: vi.fn(),
  applyServerConflictResolution: vi.fn(),
  fetchCurrentUser: vi.fn(),
  ensureProfileDriveFolder: vi.fn(),
  applyTransition: vi.fn(),
}));

vi.mock("@/lib/serverSync/sync", () => ({
  syncServerProfile: mocks.syncServerProfile,
  applyServerConflictResolution: mocks.applyServerConflictResolution,
}));

vi.mock("@/lib/serverSync/api", () => ({
  fetchCurrentUser: mocks.fetchCurrentUser,
  createServerShare: vi.fn(),
  deleteServerShare: vi.fn(),
  listServerShares: vi.fn(),
  deleteServerProfile: vi.fn(),
  ORIGIN_ID: "test-origin",
}));

vi.mock("@/hooks/applySyncedProfile", () => ({
  applySyncedProfile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/googleDrive/sync", () => ({
  ensureProfileDriveFolder: mocks.ensureProfileDriveFolder,
  syncProfile: vi.fn(),
  applyConflictResolution: vi.fn(),
  uploadMissingAudioFiles: vi.fn(),
  repairDriveAudioFiles: vi.fn(),
}));

vi.mock("@/lib/applyTransition", () => ({
  applyTransition: mocks.applyTransition,
}));

vi.mock("@/lib/serverAudio/transfer", () => ({
  canHostAudio: vi.fn().mockResolvedValue(false),
}));

import { useProfileStore } from "@/store/profileStore";
import { useServerSync } from "@/hooks/useServerSync";
import { useProfileSync } from "@/hooks/useProfileSync";
import type { Profile } from "@/lib/db";

/** A store that already knows the user has to sign in again. */
function signedInButStale(): void {
  useProfileStore.setState({
    googleUser: { name: "Ada", email: "ada@example.com" },
    googleAccessToken: "old-token",
    googleRefreshToken: "refresh-token",
    tokenExpiresAt: 1,
    isGoogleSignedIn: true,
    needsReauth: true,
  });
}

/** What a refresh looks like when the server answered without a token. */
const TOKENLESS = {
  accessToken: undefined,
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3600_000,
} as unknown as TokenInfo;

const GOOD: TokenInfo = {
  accessToken: "new-token",
  refreshToken: "refresh-token",
  expiresAt: Date.now() + 3600_000,
};

let container: HTMLDivElement;
let root: Root;

async function render(Component: () => null): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Component />);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchCurrentUser.mockResolvedValue(null);
  mocks.syncServerProfile.mockResolvedValue({ status: "skipped", reason: "x" });
  mocks.ensureProfileDriveFolder.mockResolvedValue("folder-1");
  signedInButStale();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await clearAllStores();
});

describe("the token refresh a server sync carries", () => {
  /** Runs one server sync and returns the Drive refresh callback it passed. */
  async function captureCallback(): Promise<(t: TokenInfo) => void> {
    let sync!: (id: number) => Promise<unknown>;
    function Probe() {
      sync = useServerSync().syncProfile;
      return null;
    }
    await render(Probe);
    await act(async () => {
      await sync(1);
    });
    const driveAccess = mocks.syncServerProfile.mock.calls[0][2];
    return driveAccess.onTokenRefresh;
  }

  it("installs a token that actually arrived", async () => {
    const onTokenRefresh = await captureCallback();

    act(() => onTokenRefresh(GOOD));

    const s = useProfileStore.getState();
    expect(s.googleAccessToken).toBe("new-token");
    expect(s.needsReauth).toBe(false);
  });

  it("leaves the re-auth prompt standing when the refresh brought no token", async () => {
    const onTokenRefresh = await captureCallback();

    act(() => onTokenRefresh(TOKENLESS));

    const s = useProfileStore.getState();
    expect(s.googleAccessToken).toBe("old-token");
    expect(s.needsReauth).toBe(true);
  });
});

describe("the token refresh a move-to-Drive carries", () => {
  /** Starts a transition and returns the Drive refresh callback it passed. */
  async function captureCallback(): Promise<(t: TokenInfo) => void> {
    const profile = {
      id: 1,
      name: "Board",
      syncType: "local",
      createdAt: new Date(),
      updatedAt: new Date(),
    } as Profile;

    let commit!: (
      plan: never,
      confirm: () => Promise<boolean>,
    ) => Promise<unknown>;
    function Probe() {
      commit = useProfileSync(profile).commit as typeof commit;
      return null;
    }
    await render(Probe);

    mocks.applyTransition.mockImplementation(
      async (
        _profile: Profile,
        _plan: unknown,
        deps: { ensureDriveFolder: (id: number) => Promise<void> },
      ) => {
        await deps.ensureDriveFolder(1);
        return { ok: true, warnings: [] };
      },
    );

    await act(async () => {
      await commit({ fieldUpdates: {} } as never, async () => true);
    });

    // (id, name, tokenInfo, onTokenRefresh)
    return mocks.ensureProfileDriveFolder.mock.calls[0][3];
  }

  it("leaves the re-auth prompt standing when the refresh brought no token", async () => {
    const onTokenRefresh = await captureCallback();

    act(() => onTokenRefresh(TOKENLESS));

    const s = useProfileStore.getState();
    expect(s.googleAccessToken).toBe("old-token");
    expect(s.needsReauth).toBe(true);
  });
});
