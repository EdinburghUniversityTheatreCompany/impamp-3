// @vitest-environment jsdom
/**
 * The pad's own `activePadBehavior` override, around the four hand-built
 * objects in `usePadInteractions`.
 *
 * Every one of them enumerates the pad's playback fields by hand: the edit
 * form's `initialValues`, the record its `onSubmit` writes back, the
 * `ArmedTrackState` the arm chord queues, and the reset an emptied pad is
 * written with. None of the four is tied by any compiler check to the other
 * three, or to `PadConfiguration`, so an optional field missing from one of
 * them is silently legal — and the failure is invisible: the pad plays, it
 * just plays with the wrong retrigger behaviour.
 *
 * The click-to-play path is here too, because it spreads
 * `extractPadPlaybackSettings(pad)` into a `TriggerablePad`, and TypeScript
 * exempts spread-in properties from excess-property checking.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PadConfiguration } from "@/lib/db";
import type { PadFormValues } from "@/types/forms";

const mocks = vi.hoisted(() => ({
  upsertPadConfiguration: vi.fn(),
  triggerPad: vi.fn(),
  ensureAudioContextActive: vi.fn(),
  armTrack: vi.fn(),
  openFormModal: vi.fn(),
  openModal: vi.fn(),
  closeModal: vi.fn(),
  requestSync: vi.fn(),
  incrementPadConfigsVersion: vi.fn(),
}));

vi.mock("@/lib/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db")>()),
  upsertPadConfiguration: mocks.upsertPadConfiguration,
}));
vi.mock("@/lib/audio", () => ({
  triggerPad: mocks.triggerPad,
  ensureAudioContextActive: mocks.ensureAudioContextActive,
}));
vi.mock("@/store/playbackStore", () => ({
  playbackStoreActions: { armTrack: mocks.armTrack, removeArmedTrack: vi.fn() },
}));
vi.mock("@/hooks/modal/useFormModal", () => ({
  useFormModal: () => ({ openFormModal: mocks.openFormModal }),
}));
// A selector hook *and* a `getState`: the pad-write tail in `padWrites` reads
// the store imperatively, because the two modal components that share it are
// not wired to `usePadConfigurations` at all.
vi.mock("@/store/profileStore", () => {
  const state = {
    activeProfileId: 1,
    requestSync: mocks.requestSync,
    incrementPadConfigsVersion: mocks.incrementPadConfigsVersion,
  };
  const useProfileStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useProfileStore.getState = () => state;
  return { useProfileStore };
});
vi.mock("@/store/uiStore", () => ({
  useUIStore: (
    selector: (s: {
      openModal: typeof mocks.openModal;
      closeModal: typeof mocks.closeModal;
    }) => unknown,
  ) => selector({ openModal: mocks.openModal, closeModal: mocks.closeModal }),
}));
vi.mock("@/components/modals/EditPadModalContent", () => ({
  default: () => null,
}));
vi.mock("@/components/modals/padEditSession", () => ({
  createPadEditSession: () => ({ savedFileIds: [] }),
}));
vi.mock("@/components/modals/ConfirmModalContent", () => ({
  default: () => null,
}));

import { usePadInteractions } from "./usePadInteractions";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const PAD_INDEX = 3;

function padOnDisk(over: Partial<PadConfiguration> = {}): PadConfiguration {
  return {
    profileId: 1,
    bankId: "0",
    padIndex: PAD_INDEX,
    name: "Horn",
    audioFileIds: [10],
    playbackType: "sequential",
    padGainDb: -3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as PadConfiguration;
}

let container: HTMLDivElement;
let root: Root;

/** Mounts the hook over a board holding exactly `pad`, and returns its handlers. */
function mountOver(pad: PadConfiguration) {
  let handlers: ReturnType<typeof usePadInteractions> | undefined;
  function Probe() {
    handlers = usePadInteractions({
      currentBankId: "0",
      padConfigs: new Map([[PAD_INDEX, pad]]),
      hasInteractedRef: { current: true },
    });
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return handlers!;
}

/** The edit modal's config, as it was handed to `openFormModal`. */
const formConfig = () =>
  mocks.openFormModal.mock.calls[0][0] as {
    initialValues: PadFormValues;
    onSubmit: (values: PadFormValues) => Promise<void>;
  };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.upsertPadConfiguration.mockResolvedValue(1);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("the pad edit form", () => {
  it("opens showing the pad's own override", () => {
    mountOver(padOnDisk({ activePadBehavior: "layer" })).handleEditInteraction(
      PAD_INDEX,
    );

    expect(formConfig().initialValues).toMatchObject({
      activePadBehavior: "layer",
      // Beside it so a pass cannot mean "initialValues carried nothing".
      padGainDb: -3,
    });
  });

  it("opens with no override on a pad that follows the profile", () => {
    mountOver(padOnDisk()).handleEditInteraction(PAD_INDEX);

    expect(formConfig().initialValues).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
  });

  it("writes the override back on save", async () => {
    mountOver(padOnDisk()).handleEditInteraction(PAD_INDEX);

    await act(async () => {
      await formConfig().onSubmit({
        ...formConfig().initialValues,
        activePadBehavior: "layer",
      });
    });

    expect(mocks.upsertPadConfiguration).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPadConfiguration.mock.calls[0][0]).toMatchObject({
      activePadBehavior: "layer",
      padIndex: PAD_INDEX,
    });
  });

  it("writes an explicit undefined when the pad is set back to the profile default", async () => {
    // Not the same as omitting the key: `upsertPadConfiguration` merges
    // `{...existing, ...padConfig}`, so an omitted key would leave the old
    // override in place and "Use profile default" would not stick.
    mountOver(padOnDisk({ activePadBehavior: "layer" })).handleEditInteraction(
      PAD_INDEX,
    );

    await act(async () => {
      await formConfig().onSubmit({
        ...formConfig().initialValues,
        activePadBehavior: undefined,
      });
    });

    expect(mocks.upsertPadConfiguration.mock.calls[0][0]).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
  });
});

describe("clicking a pad", () => {
  it("carries the override to the trigger", async () => {
    const pad = padOnDisk({ activePadBehavior: "layer" });
    // Mounted outside the `act` below: nesting one inside another leaves the
    // render unflushed, so the hook has not returned its handlers yet.
    const { handlePlaybackInteraction } = mountOver(pad);

    await act(async () => {
      await handlePlaybackInteraction(pad);
    });

    expect(mocks.triggerPad.mock.calls[0][0]).toMatchObject({
      activePadBehavior: "layer",
      padGainDb: -3,
    });
  });
});

describe("arming a pad", () => {
  it("carries the override into the cue", () => {
    mountOver(padOnDisk({ activePadBehavior: "layer" })).handleArmTrack(
      PAD_INDEX,
    );

    expect(mocks.armTrack.mock.calls[0][1]).toMatchObject({
      activePadBehavior: "layer",
      padGainDb: -3,
    });
  });

  it("leaves a pad with no override following the profile", () => {
    mountOver(padOnDisk()).handleArmTrack(PAD_INDEX);

    expect(mocks.armTrack.mock.calls[0][1]).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
  });
});

describe("emptying a pad", () => {
  it("clears the override along with the other playback settings", async () => {
    // The reset already puts `playbackType` and `isDisabled` back to their
    // defaults. Leaving a "layer" override behind on a pad that no longer
    // holds the sound it was chosen for is the same bug the `isDisabled` reset
    // was added to fix.
    mountOver(
      padOnDisk({ activePadBehavior: "layer" }),
    ).handleRemoveInteraction(PAD_INDEX);

    const confirm = mocks.openModal.mock.calls[0][0] as {
      onConfirm: () => Promise<void>;
    };
    await act(async () => {
      await confirm.onConfirm();
    });

    expect(mocks.upsertPadConfiguration).toHaveBeenCalledTimes(1);
    expect(mocks.upsertPadConfiguration.mock.calls[0][0]).toHaveProperty(
      "activePadBehavior",
      undefined,
    );
    // The key has to actually be present, or the spread-merge preserves the
    // stale override rather than clearing it.
    expect(
      Object.keys(mocks.upsertPadConfiguration.mock.calls[0][0]),
    ).toContain("activePadBehavior");
  });
});
