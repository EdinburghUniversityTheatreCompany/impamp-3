// @vitest-environment jsdom
/**
 * What a screen reader is told about the app's four radio groups.
 *
 * These assertions are about references resolving, which is the failure mode
 * that got past every previous review: `aria-labelledby` and `htmlFor` are
 * plain strings, so a group can carry a perfectly reasonable-looking
 * `aria-labelledby="playbackType-label"` while nothing in the document has
 * that id — and the markup reads correct, the tests pass, and the control
 * announces as an unnamed "group". Nothing in TypeScript or ESLint can see
 * it; only resolving the id against the rendered document can.
 *
 * So each check below ends at an element, never at an attribute value. The
 * groups are rendered through the real modal rather than mounted by hand,
 * because the label lives in `FormField` and the reference lives in
 * `RadioGroup` — the whole bug was in the gap between the two, and a test that
 * mounted either alone could not have seen it.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import EditPadForm from "@/components/modals/EditPadForm";
import PlaybackSettingsForm from "@/components/settings/PlaybackSettingsForm";
import ProfileEditForm from "@/components/profiles/ProfileEditForm";
import { RadioGroup } from "@/components/forms";
import { activePadBehaviorOptions } from "@/components/forms/activePadBehaviorOptions";
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

/**
 * The accessible name of an element, by the two routes that apply to a
 * `role="radiogroup"`: `aria-labelledby` (resolved through the document, so an
 * id naming nothing yields "") and then `aria-label`. A group has no name from
 * its own contents, which is exactly why the reference has to land.
 */
function accessibleNameOf(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy !== null) {
    return labelledBy
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
      .filter(Boolean)
      .join(" ");
  }
  return element.getAttribute("aria-label")?.trim() ?? "";
}

/** The text of everything `aria-describedby` points at, in order. */
function descriptionOf(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ");
}

function groupsIn(harness: FormModalHarness): HTMLElement[] {
  return [
    ...harness.container.querySelectorAll<HTMLElement>("[role=radiogroup]"),
  ];
}

/**
 * The `for` attributes of labels that name nothing a label may name.
 *
 * `<label for>` is defined only against a labelable element — an input, a
 * select, a textarea, a button. A radio group is a `<div>`, so a label naming
 * it is inert twice over: the id resolves to nothing, and clicking the label
 * does nothing where a user has learned it focuses the control.
 */
function danglingLabelsIn(harness: FormModalHarness): string[] {
  const labelable = "input, select, textarea, button, meter, output, progress";
  return [...harness.container.querySelectorAll<HTMLLabelElement>("label[for]")]
    .filter((label) => {
      const target = document.getElementById(label.htmlFor);
      return target === null || !target.matches(labelable);
    })
    .map((label) => label.htmlFor);
}

const padValues: PadFormValues = {
  name: "Horn",
  playbackType: "sequential",
  // Empty on purpose: a pad with sounds makes the form read them back out of
  // IndexedDB, which this environment has none of.
  audioFileIds: [],
  audioGainSettings: undefined,
  padGainDb: undefined,
  isDisabled: false,
  activePadBehavior: undefined,
};

const profileValues: ProfileFormValues = {
  name: "Default",
  backupReminderPeriod: 7 * 24 * 60 * 60 * 1000,
  activePadBehavior: "continue",
};

const settingsValues: PlaybackSettingsFormValues = {
  fadeoutDuration: 3,
  activePadBehavior: "continue",
};

describe("every radio group announces a name", () => {
  it("names the pad editor's two groups from their own visible labels", () => {
    form.openForm(padValues, (props) => <EditPadForm {...props} />);

    // Both, and in order, so a fix that names one group and leaves the other
    // — they are eighteen lines apart in the same file — cannot pass.
    expect(groupsIn(form).map(accessibleNameOf)).toEqual([
      "Playback Mode",
      "When already playing",
    ]);
  });

  it("names the profile editor's group", () => {
    form.openForm(profileValues, (props) => <ProfileEditForm {...props} />);

    expect(groupsIn(form).map(accessibleNameOf)).toEqual([
      "When a pad is triggered while already playing:",
    ]);
  });

  it("names the playback settings group", () => {
    form.openForm(settingsValues, (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    expect(groupsIn(form).map(accessibleNameOf)).toEqual([
      "Behavior when a pad is triggered while already playing:",
    ]);
  });
});

describe("every label points at something", () => {
  it("in the pad editor", () => {
    form.openForm(padValues, (props) => <EditPadForm {...props} />);

    expect(danglingLabelsIn(form)).toEqual([]);
  });

  it("in the profile editor", () => {
    form.openForm(profileValues, (props) => <ProfileEditForm {...props} />);

    expect(danglingLabelsIn(form)).toEqual([]);
  });

  it("in playback settings", () => {
    form.openForm(settingsValues, (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    expect(danglingLabelsIn(form)).toEqual([]);
  });
});

describe("an option's description is announced with it", () => {
  it("attaches each behaviour's explanation to its own radio", () => {
    form.openForm(settingsValues, (props) => (
      <PlaybackSettingsForm {...props} />
    ));

    const described = [
      ...form.container.querySelectorAll<HTMLInputElement>(
        "[role=radiogroup] input[type=radio]",
      ),
    ].map((radio) => ({
      value: radio.value,
      description: descriptionOf(radio),
    }));

    // Against the option list itself rather than a copy of the strings: the
    // point is that the text a user reads is the text a listener hears, and a
    // literal here would pass while the two drifted.
    expect(described).toEqual(
      activePadBehaviorOptions.map((option) => ({
        value: option.value,
        description: option.description,
      })),
    );
  });

  it("leaves a radio with nothing to explain undescribed", () => {
    form.openForm(padValues, (props) => <EditPadForm {...props} />);

    // Playback Mode's options carry no description, so pointing at an empty
    // element would announce a pause and nothing else.
    const [playbackMode] = groupsIn(form);
    const describedBy = [
      ...playbackMode.querySelectorAll<HTMLInputElement>("input[type=radio]"),
    ].map((radio) => radio.getAttribute("aria-describedby"));

    expect(describedBy).toEqual([null, null, null]);
  });
});

describe("a validation message is written once", () => {
  // Nothing validates these fields today, so this is the state the first
  // validator to arrive would put its form into.
  const REJECTED = "Pick one of these.";

  /** How many elements carry exactly this message and nothing else. */
  function timesShown(message: string): number {
    return [...form.container.querySelectorAll("p")].filter(
      (paragraph) => paragraph.textContent?.trim() === message,
    ).length;
  }

  /** One opened form, reduced to the confirm the message depends on. */
  type Submittable = { save(): Promise<void> };

  const validatedGroups: [string, () => Submittable][] = [
    [
      "the pad editor's playback mode",
      () =>
        form.openForm(
          padValues,
          (props) => <EditPadForm {...props} />,
          () => ({
            playbackType: REJECTED,
          }),
        ),
    ],
    [
      "the pad editor's already-playing override",
      () =>
        form.openForm(
          padValues,
          (props) => <EditPadForm {...props} />,
          () => ({
            activePadBehavior: REJECTED,
          }),
        ),
    ],
    [
      "the profile editor",
      () =>
        form.openForm(
          profileValues,
          (props) => <ProfileEditForm {...props} />,
          () => ({ activePadBehavior: REJECTED }),
        ),
    ],
    [
      "playback settings",
      () =>
        form.openForm(
          settingsValues,
          (props) => <PlaybackSettingsForm {...props} />,
          () => ({ activePadBehavior: REJECTED }),
        ),
    ],
  ];

  it.each(validatedGroups)("in %s", async (_where, open) => {
    const opened = open();

    await opened.save();

    expect(timesShown(REJECTED)).toBe(1);
  });

  it("still says it when a group is used without a FormField", () => {
    // The message has one owner and it is `FormField`, which already owns the
    // label and the spacing. `RadioGroup` keeps its own `error` all the same:
    // a group outside a field has nowhere else to say it, so dropping the
    // prop from the component would make that case silent instead of doubled.
    form.render(
      <RadioGroup
        id="standalone"
        name="standalone"
        options={[{ value: "one", label: "One" }]}
        value="one"
        onChange={() => {}}
        error={REJECTED}
      />,
    );

    expect(timesShown(REJECTED)).toBe(1);
  });
});
