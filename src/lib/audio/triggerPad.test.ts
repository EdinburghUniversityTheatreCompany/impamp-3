/**
 * What `triggerPad` actually hands the engine.
 *
 * `TriggerablePad` used to be a hand-written copy of `PadPlaybackSettings`,
 * and `triggerPad` copied every one of its fields into
 * `triggerAudioForPadInstant` one at a time. Every caller builds its argument
 * by spreading `extractPadPlaybackSettings(pad)` into an object literal — and
 * TypeScript exempts spread-in properties from excess-property checking, so a
 * field the interface did not declare, or one the enumeration forgot, was
 * dropped in complete silence: no compiler error anywhere, on either side.
 * `TriggerablePad` now extends the type and `triggerPad` spreads the value,
 * which closes both halves.
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
import { triggerPad, type TriggerablePad } from "./triggerPad";

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

describe("triggerPad forwards the pad it was given", () => {
  it("carries a field no hand-written list mentions", async () => {
    // The regression above in its general form. `activePadBehavior` was
    // dropped because two hand-written lists had to gain it and one did not;
    // any future pad field is exposed to exactly that, and no compiler check
    // can see it happen. Standing in for that future field with one no type
    // declares is what makes this case *about the mechanism*: it can only
    // pass if `triggerPad` forwards what it was handed, rather than copying
    // out the fields it happens to know today.
    const pad = {
      padIndex: 3,
      audioFileIds: [10],
      playbackType: "sequential",
      fieldNobodyListed: "carried",
    } as unknown as TriggerablePad;

    await triggerPad(pad, WHERE, {});

    expect(engineArgs()).toHaveProperty("fieldNobodyListed", "carried");
  });

  it("carries every field extractPadPlaybackSettings produces", async () => {
    // The key set is read back at run time rather than written out here, so
    // this case grows a new assertion the moment `PadPlaybackSettings` grows
    // a member — which is the one place a new pad field has to be declared.
    const pad = padOnDisk({
      audioTrimSettings: { 10: { trimStart: 0.5, trimEnd: 2 } },
      audioGainSettings: { 10: -6 },
      padGainDb: -3,
      isDisabled: false,
      activePadBehavior: "layer",
    });
    const settings = extractPadPlaybackSettings(pad);

    await triggerPad({ ...settings, padIndex: pad.padIndex }, WHERE, {});

    for (const [field, value] of Object.entries(settings)) {
      expect(engineArgs()).toHaveProperty(field, value);
    }
  });
});
