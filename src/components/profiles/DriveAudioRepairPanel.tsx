"use client";

/**
 * The Maintenance tab's Drive audio repair panel.
 *
 * Drive sync writes the profile's JSON and its audio as separate uploads, so
 * the two can disagree: an upload that failed, a file deleted from Drive by
 * hand, or a profile whose audio predates the upload path all leave pads that
 * play here and are silent on the next device to connect. This walks every
 * Drive-linked profile and re-uploads whatever Drive is missing.
 *
 * Three things the loop below is doing on purpose:
 *
 *  - **Only the linked profiles are in range.** A profile with no
 *    `googleDriveFileId` has nothing on Drive to be missing from, so the count
 *    a user is shown is of profiles that could have been repaired rather than
 *    of profiles they happen to own.
 *  - **One profile's failure is not the run's.** Each call is caught
 *    separately and its message is prefixed with the profile's name, because
 *    "Not authenticated" with no owner names nothing a user can act on.
 *  - **Progress is per profile, not per file.** `repairDriveAudio` reports
 *    nothing until it returns, and a run over a large profile is minutes long;
 *    the counter is what says the button is still working.
 *
 * `repairDriveAudio` arrives as a prop rather than from `useGoogleDriveSync`
 * here: the manager already holds an instance of that hook, and the hook polls
 * the token refresh on a timer, so a second instance for one button would be a
 * second poller for the life of the tab.
 */

import { useState } from "react";
import type { Profile } from "@/lib/db";

export default function DriveAudioRepairPanel({
  profiles,
  repairDriveAudio,
}: {
  profiles: Profile[];
  repairDriveAudio: (
    profileId: number,
    folderId?: string,
  ) => Promise<{ checked: number; uploaded: number; errors: string[] }>;
}) {
  // Drive audio repair state
  const [isRepairingDriveAudio, setIsRepairingDriveAudio] = useState(false);
  const [driveAudioRepairResult, setDriveAudioRepairResult] = useState<{
    profilesChecked: number;
    filesChecked: number;
    filesUploaded: number;
    errors: string[];
  } | null>(null);
  const [driveAudioRepairProgress, setDriveAudioRepairProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const handleRepairDriveAudio = async () => {
    setIsRepairingDriveAudio(true);
    setDriveAudioRepairResult(null);
    setDriveAudioRepairProgress(null);

    const driveProfiles = profiles.filter(
      (p) => p.syncType === "googleDrive" && p.googleDriveFileId,
    );
    setDriveAudioRepairProgress({ current: 0, total: driveProfiles.length });

    let totalChecked = 0;
    let totalUploaded = 0;
    const allErrors: string[] = [];

    for (let i = 0; i < driveProfiles.length; i++) {
      const profile = driveProfiles[i];
      setDriveAudioRepairProgress({
        current: i + 1,
        total: driveProfiles.length,
      });
      try {
        const result = await repairDriveAudio(
          profile.id!,
          profile.googleDriveFolderId ?? undefined,
        );
        totalChecked += result.checked;
        totalUploaded += result.uploaded;
        allErrors.push(...result.errors.map((e) => `[${profile.name}] ${e}`));
      } catch (err) {
        allErrors.push(
          `[${profile.name}] ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    setDriveAudioRepairResult({
      profilesChecked: driveProfiles.length,
      filesChecked: totalChecked,
      filesUploaded: totalUploaded,
      errors: allErrors,
    });
    setDriveAudioRepairProgress(null);
    setIsRepairingDriveAudio(false);
  };

  return (
    <section className="mb-8">
      <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
        Repair Google Drive Audio Files
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        Scans all Drive-linked profiles and re-uploads any audio files that are
        missing from Google Drive (deleted or never uploaded).
      </p>

      <div className="space-y-4">
        <div>
          <button
            onClick={handleRepairDriveAudio}
            disabled={isRepairingDriveAudio}
            data-testid="drive-audio-repair"
            className="px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
          >
            {isRepairingDriveAudio ? (
              <>
                <svg
                  className="animate-spin -ml-1 mr-3 h-5 w-5 text-white inline"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                  ></circle>
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
                {driveAudioRepairProgress
                  ? `Checking profile ${driveAudioRepairProgress.current} of ${driveAudioRepairProgress.total}…`
                  : "Starting…"}
              </>
            ) : (
              "Scan & Repair Drive Audio"
            )}
          </button>
        </div>

        {driveAudioRepairResult && (
          <div
            data-testid="drive-audio-repair-result"
            className={`rounded-lg p-4 ${
              driveAudioRepairResult.errors.length > 0
                ? "bg-yellow-50 dark:bg-yellow-900/20"
                : "bg-green-50 dark:bg-green-900/20"
            }`}
          >
            <h4
              className={`font-medium mb-2 ${
                driveAudioRepairResult.errors.length > 0
                  ? "text-yellow-800 dark:text-yellow-200"
                  : "text-green-800 dark:text-green-200"
              }`}
            >
              Repair Results
            </h4>
            <div className="space-y-2 text-sm">
              <p className="text-gray-600 dark:text-gray-300">
                Profiles checked:{" "}
                <span className="font-medium">
                  {driveAudioRepairResult.profilesChecked}
                </span>
              </p>
              <p className="text-gray-600 dark:text-gray-300">
                Files verified:{" "}
                <span className="font-medium">
                  {driveAudioRepairResult.filesChecked}
                </span>
              </p>
              <p
                className={`font-medium ${
                  driveAudioRepairResult.filesUploaded > 0
                    ? "text-orange-600 dark:text-orange-400"
                    : "text-green-600 dark:text-green-400"
                }`}
              >
                Files re-uploaded:{" "}
                <span className="font-medium">
                  {driveAudioRepairResult.filesUploaded}
                </span>
              </p>

              {driveAudioRepairResult.errors.length > 0 && (
                <div className="mt-2">
                  <p className="text-yellow-800 dark:text-yellow-200 font-medium">
                    Errors encountered:
                  </p>
                  <ul className="mt-1 space-y-1 text-yellow-700 dark:text-yellow-300">
                    {driveAudioRepairResult.errors.map((error, index) => (
                      <li key={index} className="text-xs">
                        • {error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {driveAudioRepairResult.filesUploaded === 0 &&
                driveAudioRepairResult.errors.length === 0 && (
                  <p className="text-green-700 dark:text-green-300 font-medium mt-2">
                    ✅ All audio files are present in Google Drive!
                  </p>
                )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
