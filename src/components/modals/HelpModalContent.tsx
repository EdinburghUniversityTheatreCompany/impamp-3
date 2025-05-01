"use client";

import React, { useState } from "react";
import buildInfo from "@/generated/build-info.json";

// Define the tab interface
interface HelpTab {
  id: string;
  label: string;
  content: React.ReactNode;
}

const HelpModalContent: React.FC = () => {
  const [activeTab, setActiveTab] = useState<string>("keyboard");

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
                  Ctrl
                </kbd>{" "}
                + Click on pad: Arm a track to be played later with F9
              </li>
              <li>
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Ctrl+F
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
                  Ctrl
                </kbd>{" "}
                and click on a pad to arm it for later playback
              </li>
              <li>
                You can also arm tracks from search results with{" "}
                <kbd className="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded font-mono text-sm">
                  Ctrl
                </kbd>{" "}
                + Click
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
      id: "google-drive",
      label: "Google Drive Sync",
      content: (
        <div className="space-y-4">
          <h3 className="text-lg font-medium">Google Drive Synchronization</h3>

          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 rounded-md">
            <p className="font-medium">
              Collaborative Profile Sync via Google Drive
            </p>
            <p className="mt-2">
              You can synchronize your profiles across devices and share them
              with others using Google Drive. ImpAmp3 uses Google Drive&apos;s
              hidden AppData folder for storing files, which doesn&apos;t count
              toward your storage quota and keeps your main Drive organized.
            </p>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Linking a Profile to Google Drive</h4>
            <p>
              Each profile can be linked to a Google Drive file, enabling
              automatic synchronization:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Sign in with your Google account in the Profile Manager</li>
              <li>On any profile card, click:</li>
              <ul className="list-disc pl-5 space-y-1 mt-1">
                <li>
                  <strong>Link to new Drive file</strong> - Create a new sync
                  file in Drive
                </li>
                <li>
                  <strong>Link to existing file</strong> - Connect to a file
                  already in Drive
                </li>
              </ul>
              <li>
                Once linked, you&apos;ll see the sync status displayed on the
                profile card
              </li>
            </ol>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Automatic Synchronization</h4>
            <p>For linked profiles, synchronization happens automatically:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>When the application loads</li>
              <li>
                When your internet connection is restored after being offline
              </li>
              <li>Every 15 minutes while the application is open</li>
              <li>
                You can also manually sync anytime by clicking &quot;Sync
                Now&quot; on the profile card
              </li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Conflict Resolution</h4>
            <p>If changes are made to the same profile on different devices:</p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                ImpAmp3 will detect conflicts and display a resolution modal
              </li>
              <li>
                You can choose which version to keep for each changed field
              </li>
              <li>
                The system preserves both local-only and remote-only data
                automatically
              </li>
              <li>
                Once resolved, changes are synchronized back to Google Drive
              </li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Collaboration with Others</h4>
            <p>
              Share your profiles with others for collaborative soundboards:
            </p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Link a profile to Google Drive</li>
              <li>Open Google Drive in your browser</li>
              <li>
                Find the linked file (format:{" "}
                <code>impamp-profile-profilename.json</code>)
              </li>
              <li>Right-click and select &quot;Share&quot;</li>
              <li>Add email addresses of people you want to share with</li>
              <li>
                They can then link their local profiles to this shared file
              </li>
            </ol>
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
