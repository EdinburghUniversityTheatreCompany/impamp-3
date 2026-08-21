// @vitest-environment jsdom
/**
 * Which route to a sound a share-link recipient takes.
 *
 * A profile migrated to hosted audio publishes both: its refs keep the Drive
 * ids they were uploaded with and gain `serverHosted`. The importer's source
 * loop is `if (ref.driveFileId) … else if (ref.serverHosted && …)`, so the
 * Drive route wins whenever both are named.
 *
 * For the owner that is harmless. For a recipient it is backwards. The Drive
 * file is the *owner's*: reaching it needs either a Google sign-in with a
 * grant on that file, or a folder the owner opened to anyone with the link —
 * and a deployment that hosts audio is exactly one where the owner had no
 * reason to arrange either. The download then throws, `importAudioSources`
 * skips the sound, and the pad arrives empty with nothing to retry, because
 * the import runs once. Meanwhile the bytes are on the server and the share
 * token the recipient is holding is the credential for them.
 *
 * So the recipient's copy of the blob names the hosted route — and keeps the
 * Drive id as a fallback rather than as the first choice, because preferring
 * one route must not delete the other.
 */
import { clearAllStores } from "@/lib/testSupport/browserGlobals";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProfileSyncData } from "@/lib/syncUtils";

const mocks = vi.hoisted(() => ({
  fetchServerProfile: vi.fn(),
  requestProfileDownloadUrl: vi.fn(),
  downloadAudioFileAsBlob: vi.fn(),
  fetchWithTimeout: vi.fn(),
  importProfileFromSyncData: vi.fn(),
  updateProfile: vi.fn(),
}));

vi.mock("@/lib/serverSync/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serverSync/api")>()),
  fetchServerProfile: mocks.fetchServerProfile,
}));

vi.mock("@/lib/serverAudio/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/serverAudio/api")>()),
  requestProfileDownloadUrl: mocks.requestProfileDownloadUrl,
}));

vi.mock("@/lib/googleDrive/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/googleDrive/api")>()),
  downloadAudioFileAsBlob: mocks.downloadAudioFileAsBlob,
}));

vi.mock("@/lib/fetchWithTimeout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fetchWithTimeout")>()),
  fetchWithTimeout: mocks.fetchWithTimeout,
}));

import { useProfileStore } from "@/store/profileStore";
import { useConnectServerProfile } from "@/hooks/useConnectServerProfile";
import type { HostedAudioDownloader } from "@/lib/importExport";

const HASH = "a".repeat(64);
const SERVER_ID = "srv-1";

/** A sound the server hosts that still names the owner's Drive file. */
const MIGRATED: ProfileSyncData = {
  _syncFormatVersion: 2,
  profile: { id: 9, name: "Panto" },
  pageMetadata: [],
  padConfigurations: [],
  audioFiles: [
    {
      id: 11,
      name: "ding.mp3",
      type: "audio/mpeg",
      hash: HASH,
      driveFileId: "owners-drive-file",
      serverHosted: true,
    },
  ],
} as unknown as ProfileSyncData;

let container: HTMLDivElement;
let root: Root;

/** Runs a connect and returns what the import was handed. */
async function connect(): Promise<{
  data: ProfileSyncData;
  downloadHostedBlob: HostedAudioDownloader;
}> {
  let connectProfile!: (
    id: string,
    options?: { shareToken?: string | null },
  ) => Promise<unknown>;

  function Probe() {
    connectProfile = useConnectServerProfile() as typeof connectProfile;
    return null;
  }

  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<Probe />);
  });

  await act(async () => {
    await connectProfile(SERVER_ID, { shareToken: "share-token" });
  });

  const call = mocks.importProfileFromSyncData.mock.calls[0];
  return { data: call[0], downloadHostedBlob: call[4] };
}

beforeEach(async () => {
  vi.clearAllMocks();
  // `whenProfilesLoaded` resolves as soon as the initial load is done, and
  // this suite never starts one.
  useProfileStore.setState({
    profiles: [],
    isLoading: false,
    importProfileFromSyncData: mocks.importProfileFromSyncData,
    updateProfile: mocks.updateProfile,
  });
  mocks.importProfileFromSyncData.mockResolvedValue(1);
  mocks.updateProfile.mockResolvedValue(undefined);
  mocks.fetchServerProfile.mockResolvedValue({
    id: SERVER_ID,
    name: "Panto",
    version: 4,
    access: "editor",
    data: MIGRATED,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  await clearAllStores();
});

describe("connecting to a profile whose audio the server hosts", () => {
  it("stops the migrated sound naming the owner's Drive file", async () => {
    const { data } = await connect();

    const ref = data.audioFiles![0];
    // The importer branches on this field's presence, so its absence is what
    // sends the sound down the hosted route.
    expect(ref.driveFileId).toBeUndefined();
    expect(ref.serverHosted).toBe(true);
    expect(ref.hash).toBe(HASH);
  });

  it("fetches those bytes from the server", async () => {
    mocks.requestProfileDownloadUrl.mockResolvedValue({
      url: "https://bucket.test/object",
      contentType: "audio/mpeg",
    });
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      status: 200,
      blob: async () => new Blob(["hosted-bytes"]),
    } as unknown as Response);

    const { downloadHostedBlob } = await connect();
    const blob = await downloadHostedBlob({
      hash: HASH,
      name: "ding.mp3",
      type: "audio/mpeg",
    });

    expect(await blob.text()).toBe("hosted-bytes");
    expect(mocks.requestProfileDownloadUrl).toHaveBeenCalledWith(
      SERVER_ID,
      HASH,
      "share-token",
    );
    expect(mocks.downloadAudioFileAsBlob).not.toHaveBeenCalled();
  });

  it("falls back to Drive when the server turns out not to have them", async () => {
    // A half-finished migration, or an object lost since. Preferring one route
    // must not delete the other.
    mocks.requestProfileDownloadUrl.mockRejectedValue(new Error("404"));
    mocks.downloadAudioFileAsBlob.mockResolvedValue(new Blob(["drive-bytes"]));

    const { downloadHostedBlob } = await connect();
    const blob = await downloadHostedBlob({
      hash: HASH,
      name: "ding.mp3",
      type: "audio/mpeg",
    });

    expect(await blob.text()).toBe("drive-bytes");
    // The owner's file, asked for by this device. The token it goes out with
    // is null here, which is the realistic case: a share-link recipient need
    // not be signed in to Google at all, and `downloadAudioFileAsBlob` then
    // tries the public proxy — the very route that is not there to be tried on
    // a deployment hosting its own audio.
    expect(mocks.downloadAudioFileAsBlob.mock.calls[0][0]).toBe(
      "owners-drive-file",
    );
  });

  it("reports the hosted failure when Drive cannot help either", async () => {
    mocks.requestProfileDownloadUrl.mockRejectedValue(
      new Error("hosted audio gone"),
    );
    mocks.downloadAudioFileAsBlob.mockResolvedValue(null);

    const { downloadHostedBlob } = await connect();

    // The original failure, not "Drive returned null" — the hosted route is
    // the one that was supposed to work.
    await expect(
      downloadHostedBlob({ hash: HASH, name: "ding.mp3", type: "audio/mpeg" }),
    ).rejects.toThrow("hosted audio gone");
  });
});
