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
 * Read-only for now: this shows the state honestly. Choosing between the
 * options comes with the transitions.
 */

import {
  audioLocationLabel,
  syncTargetLabel,
  type SyncState,
} from "@/lib/syncState";
import type { Availability } from "@/hooks/useProfileSync";
import type { AudioLocation, SyncType } from "@/lib/db";

const TARGETS: SyncType[] = ["local", "googleDrive", "server"];
const AUDIO: AudioLocation[] = ["googleDrive", "server", "local"];

/** Why each target is worth having, in the terms someone choosing would use. */
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

interface AxisProps {
  legend: string;
  options: string[];
  labelFor: (value: string) => string;
  noteFor: (value: string) => string;
  selected: string;
  availabilityFor: (value: string) => Availability | undefined;
  testIdPrefix: string;
}

/**
 * One axis. Options that are unavailable stay visible with the reason
 * attached — the old UI hid the server-sync button when signed out, so the
 * feature was invisible rather than merely unavailable.
 */
function Axis({
  legend,
  options,
  labelFor,
  noteFor,
  selected,
  availabilityFor,
  testIdPrefix,
}: AxisProps) {
  return (
    <fieldset>
      <legend className="text-xs font-semibold uppercase text-gray-600 dark:text-gray-400">
        {legend}
      </legend>
      <ul className="mt-2 space-y-1">
        {options.map((option) => {
          const isSelected = option === selected;
          const availability = availabilityFor(option);
          const unavailable = availability && !availability.ok;

          return (
            <li
              key={option}
              data-testid={`${testIdPrefix}-${option}`}
              data-selected={isSelected}
              className={`rounded-md px-2 py-1 text-xs ${
                isSelected
                  ? "bg-blue-50 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200"
                  : "text-gray-600 dark:text-gray-400"
              }`}
            >
              <span className="font-medium">
                {isSelected ? "● " : "○ "}
                {labelFor(option)}
              </span>
              <span className="ml-1 text-gray-500 dark:text-gray-500">
                {noteFor(option)}
              </span>
              {unavailable && !isSelected && (
                <span className="mt-0.5 block text-gray-400 italic dark:text-gray-500">
                  {availability.reason}
                </span>
              )}
            </li>
          );
        })}
      </ul>
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
}

export default function SyncAxes({ state, availability }: SyncAxesProps) {
  return (
    <div className="space-y-3" data-testid="sync-axes">
      <Axis
        legend="Profile syncs to"
        options={TARGETS}
        labelFor={(v) => syncTargetLabel(v as SyncType)}
        noteFor={(v) => TARGET_NOTES[v as SyncType]}
        selected={state.target}
        availabilityFor={(v) =>
          v === "googleDrive"
            ? availability.google
            : v === "server"
              ? availability.server
              : undefined
        }
        testIdPrefix="sync-target"
      />

      {state.target === "local" ? (
        // With nowhere to sync there is nobody to publish sounds to, so the
        // second axis has exactly one answer and asking it would be noise.
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Sounds stay on this device — there is nowhere else for them to go
          until this profile syncs somewhere.
        </p>
      ) : (
        <Axis
          legend="Sounds are stored in"
          options={AUDIO.filter(
            // A Drive profile's blob carries no server id, so a collaborator
            // would have no route to ask this server for the bytes.
            (a) => !(state.target === "googleDrive" && a === "server"),
          )}
          labelFor={(v) => audioLocationLabel(v as AudioLocation)}
          noteFor={(v) => AUDIO_NOTES[v as AudioLocation]}
          selected={state.audio}
          availabilityFor={(v) =>
            v === "server" ? availability.hostedAudio : undefined
          }
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
