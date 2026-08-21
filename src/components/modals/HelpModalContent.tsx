"use client";

import React, { useState } from "react";
import { useIsApplePlatform } from "@/hooks/useIsApplePlatform";
import { armModifierLabel } from "@/lib/platform";
import buildInfo from "@/generated/build-info.json";

// Define the tab interface
interface HelpTab {
  id: string;
  label: string;
  content: React.ReactNode;
}

const HelpModalContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>("keyboard");

  // The arm chord is Ctrl on Windows and Linux and Command on a Mac, so the
  // help has to name whichever one the reader actually has. The bank chords
  // below stay Ctrl on every platform — see `useKeyboardListener`.
  const modifier = armModifierLabel(useIsApplePlatform());

  // Define the tabs and their content
  const tabs: HelpTab[] = [
    {
      id: "keyboard",
      label: "Keyboard Shortcuts",
      content: (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Keyboard Shortcuts</h3>

          <div className="space-y-2">
            <h4 className="font-medium">Sound Playback</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Q
                </kbd>{" "}
                through{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  /
                </kbd>
                : Trigger sounds on the corresponding pads (QWERTY layout)
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  ESC
                </kbd>
                : Stop all currently playing sounds immediately
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Space
                </kbd>
                : Fade out all currently playing sounds
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Enter
                </kbd>
                : Play the next emergency sound (round-robin through all sounds
                on emergency banks)
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  F9
                </kbd>
                : Play the next armed track (see &quot;Arming Tracks&quot;
                below)
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Bank Navigation</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  1
                </kbd>{" "}
                through{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  9
                </kbd>
                : Switch to banks 1-9
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  0
                </kbd>
                : Switch to bank 10
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Ctrl+1
                </kbd>{" "}
                through{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Ctrl+9
                </kbd>
                : Switch to banks 11-19
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Ctrl+0
                </kbd>
                : Switch to bank 20
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Interface Controls</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Shift
                </kbd>{" "}
                (hold): Enter edit mode for renaming pads and banks
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {modifier}
                </kbd>{" "}
                + Click on pad: Arm a track to be played later with F9
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {modifier}+F
                </kbd>
                : Open search modal to find sounds across all banks
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Shift+?
                </kbd>
                : Open this help modal
              </li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Arming Tracks</h4>
            <p>
              You can &quot;arm&quot; tracks to be played later without
              interrupting your current workflow:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Hold{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {modifier}
                </kbd>{" "}
                and click on a pad to arm it for later playback
              </li>
              <li>
                You can also arm tracks from search results with{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {modifier}
                </kbd>{" "}
                + Click
              </li>
              <li>
                Or without leaving the search box: type, then{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  {modifier}
                </kbd>{" "}
                +{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Enter
                </kbd>{" "}
                arms the first result and{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Enter
                </kbd>{" "}
                plays it
              </li>
              <li>
                Armed tracks appear in the Armed Tracks panel at the bottom of
                the screen
              </li>
              <li>
                Press{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  F9
                </kbd>{" "}
                to play the next armed track
              </li>
              <li>
                You can also click the Play button on any armed track in the
                panel
              </li>
              <li>
                Armed tracks remain armed even if you continue browsing or
                playing other sounds directly
              </li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      id: "import-export",
      label: "Import/Export",
      content: (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Import/Export Functionality</h3>

          <div className="space-y-2">
            <h4 className="font-medium">Exporting Profiles</h4>
            <p>
              Export your profiles to back them up or transfer them to another
              device:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Click on the profile selector in the top-right corner</li>
              <li>
                Select &quot;Manage Profiles&quot; to open the Profile Manager
              </li>
              <li>Switch to the &quot;Import/Export&quot; tab</li>
              <li>
                In the &quot;Export Profiles&quot; section, check the boxes next
                to the profiles you want to export.
              </li>
              <li>
                Click the &quot;Export Selected (...)&quot; button to download a
                single JSON file containing all selected profiles.
              </li>
            </ol>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Importing Profiles</h4>
            <p>Import profiles from previously exported files:</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Click on the profile selector in the top-right corner</li>
              <li>
                Select &quot;Manage Profiles&quot; to open the Profile Manager
              </li>
              <li>Switch to the &quot;Import/Export&quot; tab</li>
              <li>
                Click &quot;Select File to Import&quot; and choose a previously
                exported JSON file
              </li>
              <li>
                The system will create new profiles with all the imported sounds
                and configurations (handling name conflicts automatically).
              </li>
            </ol>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Note: ImpAmp3 supports importing multi-profile files,
              single-profile files (V2 format), and legacy ImpAmp2 format files.
            </p>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Backup Reminders</h4>
            <p>
              ImpAmp3 can remind you when profiles haven&apos;t been backed up
              recently:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Each profile has a configurable backup reminder period (default:
                30 days)
              </li>
              <li>
                When a profile hasn&apos;t been backed up for the specified
                period, a notification will appear
              </li>
              <li>
                To configure the reminder period, edit the profile in the
                Profile Manager
              </li>
              <li>
                Set the number of days between reminders, or disable reminders
                entirely
              </li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      id: "sync",
      label: "Syncing",
      content: (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Syncing and sharing</h3>

          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 rounded-md">
            <p className="font-medium">Two questions, not one</p>
            <p className="mt-1 text-sm">
              Where a profile <em>syncs</em> and where its <em>sounds</em> live
              are separate choices. A profile can sync through the ImpAmp server
              while its sounds stay in your Google Drive — that is a normal,
              working arrangement, not a half-finished one.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Finding the settings</h4>
            <p>
              Open <strong>Manage Profiles</strong>, then click the grey line
              under a profile&apos;s name — it says where that profile syncs.
              Everything about syncing is behind it.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Where a profile syncs</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>This device only</strong> — nothing leaves this browser.
                Export a backup file yourself.
              </li>
              <li>
                <strong>Google Drive</strong> — kept in your own Drive. Share
                the folder to let others use it. Changes appear within a minute
                or so.
              </li>
              <li>
                <strong>ImpAmp server</strong> — collaborators see edits within
                seconds and can be invited by email or a share link. Needs an
                account on this server, which signing in with Google creates.
              </li>
            </ul>
            <p className="text-sm">
              Options you cannot use right now stay visible and say why, rather
              than disappearing.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Where the sounds live</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                <strong>Google Drive folder</strong> — collaborators fetch them
                from there, so keep the folder shared.
              </li>
              <li>
                <strong>ImpAmp server</strong> — hosted here, so nobody needs
                Drive access. Only available if this server is set up for it and
                your account is approved.
              </li>
              <li>
                <strong>This device only</strong> — nobody else can hear them.
                The profile still syncs; collaborators get silent pads.
              </li>
            </ul>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">Sharing</h4>
            <p>
              Sharing the profile and sharing its sounds are separate grants,
              and the panel shows both when they apply. Someone who can edit a
              profile but cannot reach its sounds gets silent pads — which is
              why the two sit side by side.
            </p>
          </div>

          <div className="space-y-2">
            <h4 className="font-medium">When something is wrong</h4>
            <p>
              The status line turns amber and says &quot;needs attention&quot;,
              and the panel explains what happened in words. If two people
              changed the same thing, a window asks which version to keep,
              naming the backend the conflict is with.
            </p>
          </div>
        </div>
      ),
    },
    {
      id: "multi-sound",
      label: "Multiple Sounds",
      content: (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Multiple Sounds on a Pad</h3>

          <div className="space-y-2">
            <h4 className="font-medium">Adding Multiple Sounds</h4>
            <p>
              You can assign multiple sounds to a single pad and control how
              they play:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>
                Enter Edit Mode by holding{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Shift
                </kbd>
              </li>
              <li>Shift+click on a pad to open the Edit Pad modal</li>
              <li>
                Click &quot;Add Sound(s)...&quot; to select additional audio
                files
              </li>
              <li>Use drag-and-drop to reorder sounds in the list</li>
              <li>
                Click the &apos;X&apos; button next to a sound to remove it
              </li>
              <li>
                Untick &quot;Pad active&quot; to disable the pad. It keeps its
                sounds but will not play until you tick the box again — handy
                for taking a sound out of a show without deleting it. Disabled
                pads are dimmed and marked &quot;OFF&quot;.
              </li>
              <li>Select a playback mode (see below)</li>
              <li>
                Click &quot;Save Changes&quot; to apply your configuration
              </li>
            </ol>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Playback Modes</h4>
            <p>When a pad has multiple sounds, you can choose how they play:</p>
            <ul className="list-disc pl-5 space-y-2">
              <li>
                <span className="font-medium">Sequential:</span> Always plays
                the first sound in the list.
                <span className="text-sm text-gray-500 dark:text-gray-400 block mt-1">
                  Best for when you have a primary sound but want alternatives
                  available for quick editing.
                </span>
              </li>
              <li>
                <span className="font-medium">Random:</span> Plays a randomly
                selected sound from the list each time the pad is triggered.
                <span className="text-sm text-gray-500 dark:text-gray-400 block mt-1">
                  Great for variety and unpredictability, like random audience
                  reactions or varied sound effects.
                </span>
              </li>
              <li>
                <span className="font-medium">Round-Robin:</span> Plays a
                randomly selected sound that hasn&apos;t been played yet in the
                current cycle. Once all sounds have played, the cycle resets.
                <span className="text-sm text-gray-500 dark:text-gray-400 block mt-1">
                  Ideal for ensuring variety without repetition, such as
                  different variations of the same sound effect.
                </span>
              </li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Tips for Multi-Sound Pads</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                You cannot drag-and-drop files directly onto pads that already
                have multiple sounds
              </li>
              <li>
                To add sounds to a multi-sound pad, you must use the Edit Pad
                modal
              </li>
              <li>
                The pad name can be different from any of the sound filenames
              </li>
              <li>
                Consider using descriptive pad names that indicate the type of
                sounds contained
              </li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Trimming Sounds</h4>
            <p>
              You can set start and end points for each sound to play only a
              specific portion:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Open the Edit Pad modal (Shift+click on a pad)</li>
              <li>
                Click the{" "}
                <span className="px-1.5 py-0.5 text-xs font-medium rounded bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300">
                  Trim
                </span>{" "}
                button next to any sound in the list
              </li>
              <li>
                Drag the green (start) and red (end) handles on the waveform to
                select the region you want to play
              </li>
              <li>
                Click &quot;Preview&quot; to hear the trimmed region before
                saving
              </li>
              <li>
                Click &quot;Apply&quot; to confirm, then &quot;Save
                Changes&quot;
              </li>
            </ol>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Trim settings are saved per sound and are included when exporting
              or syncing profiles. The original audio file is never modified.
            </p>
          </div>

          <div className="space-y-2 mt-6 p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 rounded-md">
            <h4 className="font-medium">Bulk Import Feature</h4>
            <p className="mt-2">
              Need to import many sound files at once? The Bulk Import feature
              allows you to assign multiple audio files to empty pads in a
              single operation.
            </p>
            <ol className="list-decimal pl-5 space-y-2 mt-3">
              <li>
                Toggle <strong>Delete/Swap Mode</strong> using the trash/move
                icon in the toolbar
              </li>
              <li>
                Click the <strong>Bulk Import</strong> button that appears above
                the pad grid
              </li>
              <li>
                In the modal that opens:
                <ul className="list-disc pl-5 space-y-1 mt-1">
                  <li>
                    Add audio files using the &quot;Add Files&quot; button
                  </li>
                  <li>
                    Drag files from the left panel onto empty pads in the right
                    panel
                  </li>
                  <li>
                    Use &quot;Auto-Assign&quot; to automatically place files on
                    available pads
                  </li>
                  <li>Rearrange assignments by dragging between pads</li>
                  <li>
                    Click &quot;Save Assignments&quot; when you&apos;re done
                  </li>
                </ul>
              </li>
            </ol>
            <p className="mt-2 text-sm">
              <strong>Note:</strong> You can only assign to empty pads. Pads
              that already have sounds (shown in gray) or special pads like
              &quot;Stop All&quot; cannot receive bulk assignments.
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-[70vh]">
      {/* Tabs */}
      <div className="flex border-b border-gray-200 dark:border-gray-700 overflow-x-auto">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`px-4 py-2 font-medium text-sm border-b-2 transition-colors ${
              activeTab === tab.id
                ? "border-blue-500 text-blue-600 dark:text-blue-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            }`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {tabs.find((tab) => tab.id === activeTab)?.content}
      </div>

      {/* Footer */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 text-sm text-gray-500 dark:text-gray-400">
        <p>
          Press{" "}
          <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
            Shift+?
          </kbd>{" "}
          at any time to open this help page.
        </p>
        <p className="mt-2">
          Version: {buildInfo.version}-{buildInfo.commitHash}
        </p>
      </div>
    </div>
  );
};

export default HelpModalContent;
