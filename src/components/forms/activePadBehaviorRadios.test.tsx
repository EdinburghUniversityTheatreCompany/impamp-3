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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import EditPadForm from "@/components/modals/EditPadForm";
import PlaybackSettingsForm from "@/components/settings/PlaybackSettingsForm";
import ProfileEditForm from "@/components/profiles/ProfileEditForm";
import type { FormModalRenderProps } from "@/hooks/modal/useFormModal";
import {
  mountFormModalHarness,
  type FormModalHarness,
} from "@/lib/testSupport/formModalHarness";
import type {
  PadFormValues,
  PlaybackSettingsFormValues,
  ProfileFormValues,
} from "@/types/forms";

let form: FormModalHarness;

beforeEach(() => {
  form = mountFormModalHarness();
});

afterEach(() => {
  form.teardown();
});

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
    const opened = form.openForm(padValues(), renderPadForm);

    form.chooseOption("edit-pad-active-behavior-layer");
    await opened.save();

    expect(opened.submitted).toHaveLength(1);
    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    // Beside it, so a pass cannot mean "the form submitted an empty object".
    expect(opened.submitted[0]).toHaveProperty("name", "Horn");
  });

  it("saves each of the other three behaviours as itself", async () => {
    for (const behavior of ["continue", "stop", "restart"] as const) {
      const opened = form.openForm(padValues(), renderPadForm);
      form.chooseOption(`edit-pad-active-behavior-${behavior}`);
      await opened.save();
      expect(opened.submitted[0]).toHaveProperty("activePadBehavior", behavior);
      form.clear();
    }
  });

  it("leaves a pad with no override undefined when the group is untouched", async () => {
    const opened = form.openForm(padValues(), renderPadForm);

    await opened.save();

    // Not "absent": `upsertPadConfiguration` merges `{...existing, ...pad}`,
    // so a missing key preserves whatever was stored before.
    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", undefined);
    expect(Object.keys(opened.submitted[0])).toContain("activePadBehavior");
  });

  it("shows 'use profile default' checked for a pad with no override", () => {
    form.openForm(padValues(), renderPadForm);

    // The empty string is the follow-the-profile radio. Reading the checked
    // value rules out both "no radio checked" and "checked the profile's
    // behaviour instead", which look the same to a test that only counts
    // options.
    expect(form.checkedValueOf("edit-pad-active-behavior-group")).toBe("");
  });

  it("shows the pad's own override checked when it has one", () => {
    form.openForm(padValues({ activePadBehavior: "layer" }), renderPadForm);

    expect(form.checkedValueOf("edit-pad-active-behavior-group")).toBe("layer");
  });

  it("saves undefined again when a layered pad is put back on the profile default", async () => {
    const opened = form.openForm(
      padValues({ activePadBehavior: "layer" }),
      renderPadForm,
    );

    form.chooseOption("edit-pad-active-behavior-");
    await opened.save();

    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", undefined);
    expect(Object.keys(opened.submitted[0])).toContain("activePadBehavior");
  });

  it("offers exactly the four behaviours plus the profile default", () => {
    form.openForm(padValues(), renderPadForm);

    const group = form.container.querySelector(
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
    const opened = form.openForm(settingsValues("continue"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    form.chooseOption("playback-settings-active-behavior-layer");
    await opened.save();

    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    // The other field of the same form, so a pass means "this field changed"
    // rather than "the form was replaced by the one value under test".
    expect(opened.submitted[0]).toHaveProperty("fadeoutDuration", 3);
  });

  it("keeps Playback Settings on its stored behaviour when untouched", async () => {
    const opened = form.openForm(settingsValues("restart"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    // Read the group first: without this, the test passes on a form that
    // rendered no radios at all, since untouched values reach `onSubmit`
    // whatever the form did with them.
    expect(form.checkedValueOf("playback-settings-active-behavior-group")).toBe(
      "restart",
    );
    await opened.save();

    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", "restart");
  });

  it("shows a profile already set to layer as checked", () => {
    form.openForm(settingsValues("layer"), (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    expect(form.checkedValueOf("playback-settings-active-behavior-group")).toBe(
      "layer",
    );
  });

  it("saves 'layer' from the profile editor", async () => {
    const opened = form.openForm(profileValues("continue"), (props) => (
      <ProfileEditForm {...props} />
    ));

    form.chooseOption("profile-active-behavior-layer");
    await opened.save();

    expect(opened.submitted[0]).toHaveProperty("activePadBehavior", "layer");
    expect(opened.submitted[0]).toHaveProperty("name", "Default");
  });

  it("shows a profile editor already set to layer as checked", () => {
    form.openForm(profileValues("layer"), (props) => (
      <ProfileEditForm {...props} />
    ));

    expect(form.checkedValueOf("profile-active-behavior-group")).toBe("layer");
  });

  it("offers no follow-the-profile option, because a profile has nothing to follow", () => {
    form.openForm(profileValues("continue"), (props) => (
      <ProfileEditForm {...props} />
    ));

    const group = form.container.querySelector(
      '[data-testid="profile-active-behavior-group"]',
    )!;
    const values = [...group.querySelectorAll("input")].map((i) => i.value);
    expect(values).toEqual(["continue", "stop", "restart", "layer"]);
  });
});
