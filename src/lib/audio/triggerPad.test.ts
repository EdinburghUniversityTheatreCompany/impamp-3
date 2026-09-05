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

// ---------------------------------------------------------------------------
// A pad that cannot play.
//
// `Pad.tsx` has rendered an `"error"` loading status since the overlay was
// written, and nothing ever set it: `onError` cleared the loading key at once,
// so a failed press looked exactly like a press nobody made. The cases below
// pin the state the pad is left in, the notice the operator gets, and that
// the error state goes away on its own without taking a newer state with it.
// ---------------------------------------------------------------------------
import { afterEach } from "vitest";
import { generatePadLoadingKey, useLoadingStore } from "@/store/loadingStore";
import { noticeActions, useNoticeStore } from "@/store/noticeStore";
import { ERROR_OVERLAY_MS } from "./triggerPad";

const KEY = generatePadLoadingKey(
  WHERE.activeProfileId,
  WHERE.currentBankId,
  3,
);
const loadingState = () =>
  useLoadingStore.getState().padLoadingStates.get(KEY) ?? null;
const notices = () => useNoticeStore.getState().notices.map((n) => n.message);

type EngineArgs = {
  onLoadingStateChange: (state: {
    audioFileId: number;
    status: "loading";
    startTime: number;
  }) => void;
  onAudioReady: () => void;
  onError: (error: string) => void;
};

/** An engine that starts loading and then gives up with `message`. */
const failingWith = (message: string) =>
  mocks.triggerAudioForPadInstant.mockImplementation(
    async (args: EngineArgs) => {
      args.onLoadingStateChange({
        audioFileId: 10,
        status: "loading",
        startTime: 0,
      });
      args.onError(message);
    },
  );

const applause = {
  padIndex: 3,
  audioFileIds: [10],
  playbackType: "sequential" as const,
  name: "Applause",
};

describe("triggerPad when the pad cannot play", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => {});
    noticeActions.dismissAll();
    useLoadingStore.getState().actions.clearAllLoadingStates();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    noticeActions.dismissAll();
    useLoadingStore.getState().actions.clearAllLoadingStates();
  });

  it("leaves the pad in an error state instead of clearing the overlay", async () => {
    failingWith("Failed to load audio file ID: 10 for pad 3");

    await triggerPad(applause, WHERE);

    expect(loadingState()).toMatchObject({
      status: "error",
      error: "Failed to load audio file ID: 10 for pad 3",
    });
  });

  it("tells the operator which pad failed and why", async () => {
    failingWith("Failed to load audio file ID: 10 for pad 3");

    await triggerPad(applause, WHERE);

    expect(notices()).toEqual([
      "Could not play Applause: Failed to load audio file ID: 10 for pad 3",
    ]);
  });

  it("names an unnamed pad by its number", async () => {
    failingWith("boom");

    await triggerPad({ ...applause, name: undefined }, WHERE);

    expect(notices()).toEqual(["Could not play pad 4: boom"]);
  });

  it("still hands the failure to the caller", async () => {
    failingWith("boom");
    const onError = vi.fn();

    await triggerPad(applause, WHERE, { onError });

    expect(onError).toHaveBeenCalledWith("boom");
  });

  it("clears the error state by itself once the operator has had time to see it", async () => {
    failingWith("boom");
    await triggerPad(applause, WHERE);

    vi.advanceTimersByTime(ERROR_OVERLAY_MS - 1);
    expect(loadingState()?.status).toBe("error");

    vi.advanceTimersByTime(1);
    expect(loadingState()).toBeNull();
  });

  it("does not clear a newer state the next press has since written", async () => {
    // The operator presses again before the error has timed out and the
    // second press is loading. The first press's timer must not wipe that
    // out, or the pad shows nothing while a sound is on its way.
    failingWith("boom");
    await triggerPad(applause, WHERE);

    useLoadingStore.getState().actions.setPadLoadingState(KEY, {
      audioFileId: 10,
      status: "loading",
      startTime: 1,
    });
    vi.advanceTimersByTime(ERROR_OVERLAY_MS);

    expect(loadingState()?.status).toBe("loading");
  });

  it("still clears the overlay for a press that was cancelled mid-load", async () => {
    // The outcome the `finally` exists for: stopped while loading, so neither
    // `onAudioReady` nor `onError` fires. Kept red-able so the error branch
    // above cannot be implemented by never clearing at all.
    mocks.triggerAudioForPadInstant.mockImplementation(
      async (args: EngineArgs) => {
        args.onLoadingStateChange({
          audioFileId: 10,
          status: "loading",
          startTime: 0,
        });
      },
    );

    await triggerPad(applause, WHERE);

    expect(loadingState()).toBeNull();
  });
});
