// @vitest-environment jsdom
/**
 * The three radio groups that choose what a trigger does to a pad that is
 * already playing: Playback Settings, the profile editor, and the pad
 * editor's own override.
 *
 * These go through the REAL `useFormModal`, not a stand-in for it, because the
 * question is not "does the option render" but "does picking it end up in the
 * values `onSubmit` is handed". Rendering alone would pass with an `onChange`
 * wired to the wrong field, or to nothing at all.
 *
 * The pad group carries the case the other two cannot have: `undefined` is a
 * value there, and a distinct one. It means "ask the profile", resolved at
 * every trigger by `resolveActivePadBehavior` — so a form that helpfully
 * substituted the profile's current answer would freeze that answer into the
 * pad, and changing the profile later would leave this pad behind.
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import EditPadForm from "@/components/modals/EditPadForm";
import PlaybackSettingsForm from "@/components/settings/PlaybackSettingsForm";
import ProfileEditForm from "@/components/profiles/ProfileEditForm";
import { useFormModal } from "@/hooks/modal/useFormModal";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import { useUIStore } from "@/store/uiStore";
import type {
  PadFormValues,
  PlaybackSettingsFormValues,
  ProfileFormValues,
} from "@/types/forms";

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useUIStore.getState().closeModal();
});

/**
 * Opens a real form modal over `initialValues` and mounts whatever content it
 * puts in the UI store, which is the same path `usePadInteractions` and
 * `usePlaybackSettings` take. Returns a `save()` that runs the modal's own
 * confirm handler, and the list of value sets `onSubmit` received.
 */
function openForm<V extends Record<string, unknown>>(
  initialValues: V,
  renderForm: (props: FormModalRenderProps<V>) => React.ReactNode,
) {
  const submitted: V[] = [];

  function Harness() {
    const { openFormModal } = useFormModal();
    React.useEffect(() => {
      openFormModal<V>({
        title: "Test",
        initialValues,
        renderForm,
        onSubmit: (values) => {
          submitted.push(values);
        },
      });
    }, [openFormModal]);
    const content = useUIStore((state) => state.modalConfig?.content);
    return <>{content}</>;
  }

  act(() => {
    root.render(<Harness />);
  });

  return {
    submitted,
    save: async () => {
      const onConfirm = useUIStore.getState().modalConfig?.onConfirm;
      if (!onConfirm) throw new Error("the modal has no confirm handler");
      await act(async () => {
        await onConfirm();
      });
    },
  };
}

/** Clicks the radio with this test id, failing loudly when it is absent. */
function chooseOption(testId: string) {
  const radio = container.querySelector<HTMLInputElement>(
    `input[data-testid="${testId}"]`,
  );
  if (!radio) throw new Error(`no radio with data-testid="${testId}"`);
  act(() => {
    radio.click();
  });
}

/** The value of the checked radio in a group, or null when none is checked. */
function checkedValueOf(groupTestId: string): string | null {
  const group = container.querySelector(`[data-testid="${groupTestId}"]`);
  if (!group) throw new Error(`no radio group "${groupTestId}"`);
  const checked = group.querySelectorAll<HTMLInputElement>("input:checked");
  if (checked.length > 1) {
    throw new Error(`${checked.length} radios checked in "${groupTestId}"`);
  }
  return checked[0]?.value ?? null;
}

const padValues = (over: Partial<PadFormValues> = {}): PadFormValues => ({
  name: "Horn",
  playbackType: "sequential",
  // Empty on purpose: a pad with sounds makes the form read them back out of
  // IndexedDB, which this environment has none of.
  audioFileIds: [],
  audioGainSettings: undefined,
  padGainDb: undefined,
  isDisabled: false,
  activePadBehavior: undefined,
  ...over,
});

const renderPadForm = (props: FormModalRenderProps<PadFormValues>) => (
  <EditPadForm {...props} />
);

describe("the pad editor's override", () => {
  it("saves 'layer' when the pad is set to layer", async () => {
    const form = openForm(padValues(), renderPadForm);

    chooseOption("edit-pad-active-behavior-layer");
    await form.save();

    expect(form.submitted).toHaveLength(1);
    expect(form.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    // Beside it, so a pass cannot mean "the form submitted an empty object".
    expect(form.submitted[0]).toHaveProperty("name", "Horn");
  });

  it("saves each of the other three behaviours as itself", async () => {
    for (const behavior of ["continue", "stop", "restart"] as const) {
      const form = openForm(padValues(), renderPadForm);
      chooseOption(`edit-pad-active-behavior-${behavior}`);
      await form.save();
      expect(form.submitted[0]).toHaveProperty("activePadBehavior", behavior);
      act(() => root.render(<></>));
    }
  });

  it("leaves a pad with no override undefined when the group is untouched", async () => {
    const form = openForm(padValues(), renderPadForm);

    await form.save();

    // Not "absent": `upsertPadConfiguration` merges `{...existing, ...pad}`,
    // so a missing key preserves whatever was stored before.
    expect(form.submitted[0]).toHaveProperty("activePadBehavior", undefined);
    expect(Object.keys(form.submitted[0])).toContain("activePadBehavior");
  });

  it("shows 'use profile default' checked for a pad with no override", () => {
    openForm(padValues(), renderPadForm);

    // The empty string is the follow-the-profile radio. Reading the checked
    // value rules out both "no radio checked" and "checked the profile's
    // behaviour instead", which look the same to a test that only counts
    // options.
    expect(checkedValueOf("edit-pad-active-behavior-group")).toBe("");
  });

  it("shows the pad's own override checked when it has one", () => {
    openForm(padValues({ activePadBehavior: "layer" }), renderPadForm);

    expect(checkedValueOf("edit-pad-active-behavior-group")).toBe("layer");
  });

  it("saves undefined again when a layered pad is put back on the profile default", async () => {
    const form = openForm(
      padValues({ activePadBehavior: "layer" }),
      renderPadForm,
    );

    chooseOption("edit-pad-active-behavior-");
    await form.save();

    expect(form.submitted[0]).toHaveProperty("activePadBehavior", undefined);
    expect(Object.keys(form.submitted[0])).toContain("activePadBehavior");
  });

  it("offers exactly the four behaviours plus the profile default", () => {
    openForm(padValues(), renderPadForm);

    const group = container.querySelector(
      '[data-testid="edit-pad-active-behavior-group"]',
    )!;
    const values = [...group.querySelectorAll("input")].map((i) => i.value);
    expect(values).toEqual(["", "continue", "stop", "restart", "layer"]);
  });
});

describe("the profile-level default", () => {
  const settingsValues = (
    behavior: PlaybackSettingsFormValues["activePadBehavior"],
  ): PlaybackSettingsFormValues => ({
    fadeoutDuration: 3,
    activePadBehavior: behavior,
  });

  const profileValues = (
    behavior: ProfileFormValues["activePadBehavior"],
  ): ProfileFormValues => ({
    name: "Default",
    backupReminderPeriod: 7 * 24 * 60 * 60 * 1000,
    activePadBehavior: behavior,
  });

  it("saves 'layer' from Playback Settings", async () => {
    const form = openForm(settingsValues("continue"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    chooseOption("playback-settings-active-behavior-layer");
    await form.save();

    expect(form.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    // The other field of the same form, so a pass means "this field changed"
    // rather than "the form was replaced by the one value under test".
    expect(form.submitted[0]).toHaveProperty("fadeoutDuration", 3);
  });

  it("keeps Playback Settings on its stored behaviour when untouched", async () => {
    const form = openForm(settingsValues("restart"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    // Read the group first: without this, the test passes on a form that
    // rendered no radios at all, since untouched values reach `onSubmit`
    // whatever the form did with them.
    expect(checkedValueOf("playback-settings-active-behavior-group")).toBe(
      "restart",
    );
    await form.save();

    expect(form.submitted[0]).toHaveProperty("activePadBehavior", "restart");
  });

  it("shows a profile already set to layer as checked", () => {
    openForm(settingsValues("layer"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    expect(checkedValueOf("playback-settings-active-behavior-group")).toBe(
      "layer",
    );
  });

  it("saves 'layer' from the profile editor", async () => {
    const form = openForm(profileValues("continue"), (props) => (
      <ProfileEditForm {...props} />
    ));

    chooseOption("profile-active-behavior-layer");
    await form.save();

    expect(form.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    expect(form.submitted[0]).toHaveProperty("name", "Default");
  });

  it("shows a profile editor already set to layer as checked", () => {
    openForm(profileValues("layer"), (props) => <ProfileEditForm {...props} />);

    expect(checkedValueOf("profile-active-behavior-group")).toBe("layer");
  });

  it("offers no follow-the-profile option, because a profile has nothing to follow", () => {
    openForm(profileValues("continue"), (props) => (
      <ProfileEditForm {...props} />
    ));

    const group = container.querySelector(
      '[data-testid="profile-active-behavior-group"]',
    )!;
    const values = [...group.querySelectorAll("input")].map((i) => i.value);
    expect(values).toEqual(["continue", "stop", "restart", "layer"]);
  });
});
