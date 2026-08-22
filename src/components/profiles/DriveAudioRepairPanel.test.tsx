// @vitest-environment jsdom
/**
 * The Maintenance tab's Drive audio repair panel.
 *
 * The panel owns no data of its own: `repairDriveAudio` does the work, one
 * profile at a time, and everything here is about which profiles it is called
 * for and what the user is told about a run that partly failed. Those are
 * exactly the parts a browser test cannot reach — repairing for real needs a
 * Google account, a Drive folder and audio missing from it — so they had no
 * test at all while this lived inside `ProfileManager`.
 *
 * Three things it has to get right, each of which is a test below:
 *
 *  - **Only Drive-linked profiles are in range.** A local profile, or a
 *    Drive-typed one that has never been uploaded, has nothing on Drive to be
 *    missing from. Calling for them would fail per profile and fill the error
 *    list with rows the user cannot act on; counting them would report more
 *    profiles checked than were.
 *  - **One profile's failure is not the run's.** The loop catches per profile,
 *    so a thrown "Not authenticated" on the second of three must not cost the
 *    third its repair — and the message has to name its profile, because
 *    "Not authenticated" on its own names nothing.
 *  - **Silence is a result too.** A run that uploaded nothing and failed at
 *    nothing says everything is present, rather than showing three zeroes and
 *    letting the user guess.
 *
 * No database here: this panel takes its profiles and its repair function as
 * props, which is also how the manager avoids a second `useGoogleDriveSync`
 * instance for one button.
 */

import * as React from "react";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPanel, type MountedPanel } from "@/lib/testSupport/reactPanel";
import DriveAudioRepairPanel from "@/components/profiles/DriveAudioRepairPanel";
import type { Profile } from "@/lib/db";

type RepairOutcome = { checked: number; uploaded: number; errors: string[] };

/** A profile row with only the fields this panel reads spelled out. */
function profile(fields: Partial<Profile> & { id: number; name: string }) {
  return {
    syncType: "googleDrive",
    lastBackedUpAt: 0,
    backupReminderPeriod: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...fields,
  } as Profile;
}

const LINKED = profile({
  id: 1,
  name: "Main Show",
  googleDriveFileId: "file-main",
  googleDriveFolderId: "folder-main",
});
const ALSO_LINKED = profile({
  id: 2,
  name: "Understudy",
  googleDriveFileId: "file-under",
});
/** Drive-typed but never uploaded: there is no Drive copy to repair against. */
const NEVER_UPLOADED = profile({ id: 3, name: "Draft" });
const LOCAL = profile({ id: 4, name: "Rehearsal", syncType: "local" });

let panel: MountedPanel;

async function mount(
  profiles: Profile[],
  repair: (profileId: number, folderId?: string) => Promise<RepairOutcome>,
): Promise<ReturnType<typeof vi.fn>> {
  const spy = vi.fn(repair);
  panel = await mountPanel(
    <DriveAudioRepairPanel profiles={profiles} repairDriveAudio={spy} />,
  );
  return spy;
}

const nothingMissing = async (): Promise<RepairOutcome> => ({
  checked: 4,
  uploaded: 0,
  errors: [],
});

const result = () => panel.required("drive-audio-repair-result").textContent;

afterEach(async () => {
  await panel.unmount();
});

describe("choosing what to repair", () => {
  it("visits only the profiles that have something on Drive", async () => {
    const repair = await mount(
      [LOCAL, LINKED, NEVER_UPLOADED, ALSO_LINKED],
      nothingMissing,
    );

    await panel.click("drive-audio-repair");

    expect(repair).toHaveBeenCalledTimes(2);
    expect(repair.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(result()).toContain("Profiles checked: 2");
  });

  it("passes the profile's folder, and undefined when it has none", async () => {
    // The folder is what a *shared* profile's audio lives in; a profile with
    // none is repaired against the app-data folder instead, and passing null
    // through would be a folder id of "null".
    const repair = await mount([LINKED, ALSO_LINKED], nothingMissing);

    await panel.click("drive-audio-repair");

    expect(repair.mock.calls[0]).toEqual([1, "folder-main"]);
    expect(repair.mock.calls[1]).toEqual([2, undefined]);
  });
});

describe("reporting the run", () => {
  it("adds the per-profile counts up", async () => {
    const repair = await mount([LINKED, ALSO_LINKED], async (profileId) =>
      profileId === 1
        ? { checked: 12, uploaded: 3, errors: [] }
        : { checked: 5, uploaded: 1, errors: [] },
    );

    await panel.click("drive-audio-repair");

    expect(repair).toHaveBeenCalledTimes(2);
    expect(result()).toContain("Files verified: 17");
    expect(result()).toContain("Files re-uploaded: 4");
  });

  it("says everything is present when nothing was uploaded or failed", async () => {
    await mount([LINKED], nothingMissing);

    await panel.click("drive-audio-repair");

    expect(result()).toContain("All audio files are present in Google Drive");
    expect(panel.container.textContent).not.toContain("Errors encountered");
  });

  it("names the profile every error came from", async () => {
    await mount([LINKED, ALSO_LINKED], async (profileId) =>
      profileId === 1
        ? { checked: 2, uploaded: 0, errors: ["cue.wav: 404"] }
        : nothingMissing(),
    );

    await panel.click("drive-audio-repair");

    expect(result()).toContain("[Main Show] cue.wav: 404");
    expect(result()).toContain("Errors encountered");
    // An error anywhere means the run cannot claim everything is present.
    expect(result()).not.toContain("All audio files are present");
  });

  it("keeps going after a profile throws, and names that one too", async () => {
    const repair = await mount([LINKED, ALSO_LINKED], async (profileId) => {
      if (profileId === 1) throw new Error("Not authenticated with Drive");
      return { checked: 5, uploaded: 2, errors: [] };
    });

    await panel.click("drive-audio-repair");

    expect(repair).toHaveBeenCalledTimes(2);
    expect(result()).toContain("[Main Show] Not authenticated with Drive");
    // The profile after the failure was still repaired, and its numbers are
    // in the total.
    expect(result()).toContain("Files re-uploaded: 2");
    expect(result()).toContain("Profiles checked: 2");
  });

  it("reports a run with no Drive profiles as a run, not as nothing", async () => {
    const repair = await mount([LOCAL, NEVER_UPLOADED], nothingMissing);

    await panel.click("drive-audio-repair");

    expect(repair).not.toHaveBeenCalled();
    expect(result()).toContain("Profiles checked: 0");
  });
});

describe("while it runs", () => {
  it("counts the profiles off and refuses a second press", async () => {
    let release: (outcome: RepairOutcome) => void;
    const repair = await mount(
      [LINKED, ALSO_LINKED],
      () =>
        new Promise<RepairOutcome>((resolve) => {
          release = resolve;
        }),
    );

    await panel.click("drive-audio-repair");

    const button = panel.required("drive-audio-repair") as HTMLButtonElement;
    // `repairDriveAudio` reports nothing until it returns and a large profile
    // takes minutes, so this counter is the only sign the button is working.
    expect(button.textContent).toContain("Checking profile 1 of 2");
    expect(button.disabled).toBe(true);
    expect(panel.testId("drive-audio-repair-result")).toBeNull();

    await panel.press(button);
    expect(repair).toHaveBeenCalledTimes(1);

    await act(async () => {
      release!({ checked: 1, uploaded: 0, errors: [] });
    });
    await panel.settle();
    expect(panel.required("drive-audio-repair").textContent).toContain(
      "Checking profile 2 of 2",
    );
  });
});
