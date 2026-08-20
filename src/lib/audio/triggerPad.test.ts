/**
 * What `triggerPad` actually hands the engine.
 *
 * `TriggerablePad` is hand-written and `triggerPad` hand-enumerates every one
 * of its fields into `triggerAudioForPadInstant`. Both production call sites
 * build their argument by spreading `extractPadPlaybackSettings(pad)` into an
 * object literal — and TypeScript exempts spread-in properties from
 * excess-property checking, so a field the interface does not declare, or one
 * the enumeration below forgets, is dropped in complete silence: no compiler
 * error anywhere, on either side.
 *
 * That is the `audioGainSettings`-remapped-in-five-places failure shape, and
 * it is why this file asserts on the object the engine receives rather than on
 * the types. A test that only constructed a `TriggerablePad` would pass
 * against a `triggerPad` that threw the field away.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ triggerAudioForPadInstant: vi.fn() }));

vi.mock("./controls", () => ({
  triggerAudioForPadInstant: mocks.triggerAudioForPadInstant,
}));

import { extractPadPlaybackSettings, type PadConfiguration } from "@/lib/db";
import { triggerPad } from "./triggerPad";

const WHERE = { activeProfileId: 1, currentBankId: "0" };

/** The arguments the engine was handed by the last trigger. */
const engineArgs = () => mocks.triggerAudioForPadInstant.mock.calls[0][0];

function padOnDisk(over: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: 3,
    name: "Applause",
    audioFileIds: [10],
    playbackType: "sequential",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as PadConfiguration;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("triggerPad carries the pad's activePadBehavior override", () => {
  it("passes an explicit override through to the engine", async () => {
    await triggerPad(
      { padIndex: 3, audioFileIds: [10], playbackType: "sequential" },
      WHERE,
      {},
    );
    expect(engineArgs().activePadBehavior).toBeUndefined();

    mocks.triggerAudioForPadInstant.mockClear();

    await triggerPad(
      {
        padIndex: 3,
        audioFileIds: [10],
        playbackType: "sequential",
        activePadBehavior: "layer",
      },
      WHERE,
      {},
    );
    expect(engineArgs().activePadBehavior).toBe("layer");
  });

  it("survives the spread both production call sites use", async () => {
    // `usePadInteractions` and `playbackStore`'s armed player both build their
    // argument exactly like this. The spread is the step that type-checks
    // while silently dropping anything `TriggerablePad` does not declare, so
    // going through it here is the whole point of this case.
    const pad = padOnDisk({ activePadBehavior: "layer", padGainDb: -3 });

    await triggerPad(
      { ...extractPadPlaybackSettings(pad), padIndex: pad.padIndex },
      WHERE,
      {},
    );

    expect(engineArgs()).toMatchObject({
      activePadBehavior: "layer",
      // Asserted beside it so a passing case cannot mean "the spread carried
      // nothing at all" — this one has been carried since before the override
      // existed.
      padGainDb: -3,
      audioFileIds: [10],
    });
  });

  it("leaves a pad with no override undefined rather than defaulting it", async () => {
    // Undefined *is* the value that means "follow the profile". A default
    // applied anywhere on this path would freeze the profile's setting onto
    // the pad at trigger time, and `resolveActivePadBehavior` would never see
    // that the pad had said nothing.
    const pad = padOnDisk();

    await triggerPad(
      { ...extractPadPlaybackSettings(pad), padIndex: pad.padIndex },
      WHERE,
      {},
    );

    expect(engineArgs()).toHaveProperty("activePadBehavior", undefined);
  });
});
