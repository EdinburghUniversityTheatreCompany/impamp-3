"use client";

/**
 * The two questions a profile's syncing actually answers.
 *
 * The app has always had two axes here — where the profile syncs, and where
 * its sounds live — and one field to say them with. A server-synced profile
 * publishing its audio through a Google Drive folder is a real, working
 * combination that `serverSync/sync.ts` implements and nothing displayed, so
 * people arrived at it by accident and could not tell they were in it.
 *
 * Choosing an option moves the profile there. What that costs is said before
 * it happens, not after.
 */

import {
  audioLocationLabel,
  isLegalPair,
  syncTargetLabel,
  type SyncState,
} from "@/lib/syncState";
import type { Availability } from "@/hooks/useProfileSync";
import type { AudioLocation, SyncType } from "@/lib/db";

const TARGETS: SyncType[] = ["local", "googleDrive", "server"];
const AUDIO: AudioLocation[] = ["googleDrive", "server", "local"];

/** Why each option is worth having, in the terms someone choosing would use. */
const TARGET_NOTES: Record<SyncType, string> = {
  local: "Nothing leaves this browser.",
  googleDrive: "Backed up to your own Drive; share the folder to collaborate.",
  server:
    "Collaborators see edits within seconds, and can be invited by email.",
};

const AUDIO_NOTES: Record<AudioLocation, string> = {
  googleDrive: "Collaborators fetch them from the Drive folder.",
  server: "Hosted here. Nobody needs Drive access to hear them.",
  local: "Nobody else can hear them.",
};

interface AxisProps<T extends string> {
  legend: string;
  name: string;
  options: T[];
  labelFor: (value: T) => string;
  noteFor: (value: T) => string;
  selected: T;
  availabilityFor: (value: T) => Availability | undefined;
  disabled: boolean;
  onChoose: (value: T) => void;
  testIdPrefix: string;
}

/**
 * One axis, as a radio group.
 *
 * Options that are unavailable stay visible and disabled with the reason
 * attached. The old UI hid the server-sync button when signed out, so the
 * feature was invisible rather than merely out of reach — and nothing told
 * anyone it existed.
 */
function Axis<T extends string>({
  legend,
  name,
  options,
  labelFor,
  noteFor,
  selected,
  availabilityFor,
  disabled,
  onChoose,
  testIdPrefix,
}: AxisProps<T>) {
  return (
    <fieldset disabled={disabled}>
      <legend className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-400">
        {legend}
      </legend>
      <div className="mt-2 space-y-1">
        {options.map((option) => {
          const availability = availabilityFor(option);
          const unavailable = Boolean(availability && !availability.ok);
          const isSelected = option === selected;
          const id = `${testIdPrefix}-${option}-input`;

          return (
            <div
              key={option}
              data-testid={`${testIdPrefix}-${option}`}
              data-selected={isSelected}
              className={`flex items-start gap-2 rounded-md px-2 py-1 text-xs ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-900/30"
                  : unavailable
                    ? "opacity-70"
                    : ""
              }`}
            >
              <input
                type="radio"
                id={id}
                name={name}
                checked={isSelected}
                disabled={disabled || (unavailable && !isSelected)}
                onChange={() => onChoose(option)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0"
              />
              <label htmlFor={id} className="flex-1">
                <span className="font-medium text-gray-800 dark:text-gray-200">
                  {labelFor(option)}
                </span>{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  {noteFor(option)}
                </span>
                {unavailable && !isSelected && (
                  <span className="mt-0.5 block text-gray-400 italic dark:text-gray-500">
                    {availability?.reason}
                  </span>
                )}
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

interface SyncAxesProps {
  state: SyncState;
  availability: {
    google: Availability;
    server: Availability;
    hostedAudio: Availability;
  };
  /** True while a move is being carried out, or when none is allowed. */
  disabled: boolean;
  onChooseTarget: (target: SyncType) => void;
  onChooseAudio: (audio: AudioLocation) => void;
}

export default function SyncAxes({
  state,
  availability,
  disabled,
  onChooseTarget,
  onChooseAudio,
}: SyncAxesProps) {
  return (
    <div className="space-y-3" data-testid="sync-axes">
      <Axis
        legend="Profile syncs to"
        name="sync-target"
        options={TARGETS}
        labelFor={syncTargetLabel}
        noteFor={(v) => TARGET_NOTES[v]}
        selected={state.target}
        availabilityFor={(v) =>
          v === "googleDrive"
            ? availability.google
            : v === "server"
              ? availability.server
              : undefined
        }
        disabled={disabled}
        onChoose={onChooseTarget}
        testIdPrefix="sync-target"
      />

      {state.target === "local" ? (
        // With nowhere to sync there is nobody to publish sounds to, so the
        // second question has one answer and asking it would be noise.
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sounds stay on this device — there is nowhere else for them to go
          until this profile syncs somewhere.
        </p>
      ) : (
        <Axis
          legend="Sounds are stored in"
          name="audio-location"
          options={AUDIO.filter((a) => isLegalPair(state.target, a))}
          labelFor={audioLocationLabel}
          noteFor={(v) => AUDIO_NOTES[v]}
          selected={state.audio}
          availabilityFor={(v) =>
            v === "server" ? availability.hostedAudio : undefined
          }
          disabled={disabled}
          onChoose={onChooseAudio}
          testIdPrefix="audio-location"
        />
      )}

      {!state.audioIsExplicit && state.target !== "local" && (
        <p className="text-xs text-gray-400 dark:text-gray-500">
          Worked out from this profile&rsquo;s existing links — it predates
          being able to choose.
        </p>
      )}
    </div>
  );
}
