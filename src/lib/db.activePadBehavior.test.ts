/**
 * The per-pad override of the profile's activePadBehavior.
 *
 * Undefined means "follow the profile", so pads written before this field
 * existed keep behaving exactly as they did. The resolver is the only place
 * that rule is written down.
 */
import { describe, expect, it } from "vitest";
import { extractPadPlaybackSettings, resolveActivePadBehavior } from "./db";

describe("resolveActivePadBehavior", () => {
  it("follows the profile when the pad says nothing", () => {
    expect(resolveActivePadBehavior({}, "restart")).toBe("restart");
    expect(
      resolveActivePadBehavior({ activePadBehavior: undefined }, "stop"),
    ).toBe("stop");
  });

  it("lets the pad beat the profile", () => {
    expect(
      resolveActivePadBehavior({ activePadBehavior: "layer" }, "continue"),
    ).toBe("layer");
  });
});

describe("extractPadPlaybackSettings", () => {
  it("carries the override, so a pad swap and a duplicate keep it", () => {
    const settings = extractPadPlaybackSettings({
      audioFileIds: [1],
      activePadBehavior: "layer",
    });
    expect(settings.activePadBehavior).toBe("layer");
  });

  it("leaves the override undefined when the pad has none", () => {
    const settings = extractPadPlaybackSettings({ audioFileIds: [1] });
    expect(settings.activePadBehavior).toBeUndefined();
  });
});

/**
 * The override across the wire.
 *
 * The plan for this task proposed asserting `typeof detectProfileConflicts ===
 * "function"`, which cannot fail for any defect this change could introduce.
 * These cases run a real merge instead: the sync layer is generic over field
 * names — `SyncedPadConfiguration extends PadConfiguration`, the Drive
 * write-back spreads whole pad rows, and `compareSyncableItems` votes on the
 * keys the object actually has — so the claim that sync "needs no field-list
 * change" is only true while that genericity holds. These are what would
 * notice if it stopped.
 */
describe("the override survives the wire", () => {
  const LAST_SYNC = 1_000;
  const LOCAL_EDIT = 2_000;
  const REMOTE_EDIT = 3_000;

  type SyncedPadConfiguration = import("./syncUtils").SyncedPadConfiguration;
  type ProfileSyncData = import("./syncUtils").ProfileSyncData;

  const pad = (
    over: Partial<SyncedPadConfiguration>,
    modifiedAt: number,
  ): SyncedPadConfiguration =>
    ({
      profileId: 1,
      bankId: "0",
      padIndex: 0,
      name: "Horn",
      playbackType: "sequential",
      audioFileIds: [10],
      createdAt: new Date(0),
      updatedAt: new Date(modifiedAt),
      _created: 0,
      _modified: modifiedAt,
      ...over,
    }) as SyncedPadConfiguration;

  const blob = (pads: SyncedPadConfiguration[]): ProfileSyncData =>
    ({
      _syncFormatVersion: 2,
      _lastSyncTimestamp: LAST_SYNC,
      profile: {
        id: 1,
        name: "Test profile",
        syncType: "googleDrive" as const,
        lastBackedUpAt: 0,
        backupReminderPeriod: 0,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      padConfigurations: pads,
      pageMetadata: [],
      audioFiles: [],
    }) as unknown as ProfileSyncData;

  it("is adopted from the remote when only the remote changed it", async () => {
    const { detectProfileConflicts } = await import("./syncUtils");

    const { conflicts, requiresManualResolution, mergedData } =
      await detectProfileConflicts(
        blob([pad({ _fieldsModified: {} }, LAST_SYNC)]),
        blob([
          pad(
            {
              activePadBehavior: "layer",
              _fieldsModified: { activePadBehavior: REMOTE_EDIT },
            },
            REMOTE_EDIT,
          ),
        ]),
      );

    expect(conflicts).toHaveLength(0);
    expect(requiresManualResolution).toBe(false);
    expect(mergedData.padConfigurations[0].activePadBehavior).toBe("layer");
    // And the merge records that it now holds the remote's stamp, or the next
    // sync reads the field as never having been touched on this device.
    expect(
      mergedData.padConfigurations[0]._fieldsModified?.activePadBehavior,
    ).toBe(REMOTE_EDIT);
  });

  it("is kept locally when only this device changed it", async () => {
    const { detectProfileConflicts } = await import("./syncUtils");

    const { mergedData } = await detectProfileConflicts(
      blob([
        pad(
          {
            activePadBehavior: "layer",
            _fieldsModified: { activePadBehavior: LOCAL_EDIT },
          },
          LOCAL_EDIT,
        ),
      ]),
      blob([pad({ _fieldsModified: {} }, LAST_SYNC)]),
    );

    expect(mergedData.padConfigurations[0].activePadBehavior).toBe("layer");
  });

  it("raises a conflict when both devices changed it differently", async () => {
    const { detectProfileConflicts } = await import("./syncUtils");

    const { conflicts, requiresManualResolution } =
      await detectProfileConflicts(
        blob([
          pad(
            {
              activePadBehavior: "restart",
              _fieldsModified: { activePadBehavior: LOCAL_EDIT },
            },
            LOCAL_EDIT,
          ),
        ]),
        blob([
          pad(
            {
              activePadBehavior: "layer",
              _fieldsModified: { activePadBehavior: REMOTE_EDIT },
            },
            REMOTE_EDIT,
          ),
        ]),
      );

    expect(requiresManualResolution).toBe(true);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].fieldConflicts).toContainEqual(
      expect.objectContaining({
        field: "activePadBehavior",
        localValue: "restart",
        remoteValue: "layer",
      }),
    );
  });

  it("is stamped as modified when a pad is written with it", async () => {
    const { initialSyncFields } = await import("./db");
    const stamps = initialSyncFields(
      { audioFileIds: [1], activePadBehavior: "layer" },
      1000,
    );
    expect(stamps._fieldsModified.activePadBehavior).toBe(1000);
  });
});
