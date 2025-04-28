"use client";

import React, { useState } from "react";

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
              <li>Select "Manage Profiles" to open the Profile Manager</li>
              <li>Switch to the "Import/Export" tab</li>
              <li>Select the profile you want to export from the dropdown</li>
              <li>
                Click "Export Profile" to download a JSON file containing your
                profile data
              </li>
            </ol>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Note: Exporting a profile also updates its "last backed up"
              timestamp, which resets the backup reminder.
            </p>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Importing Profiles</h4>
            <p>Import profiles from previously exported files:</p>
            <ol className="list-decimal pl-5 space-y-1">
              <li>Click on the profile selector in the top-right corner</li>
              <li>Select "Manage Profiles" to open the Profile Manager</li>
              <li>Switch to the "Import/Export" tab</li>
              <li>
                Click "Select File to Import" and choose a previously exported
                JSON file
              </li>
              <li>
                The system will create a new profile with all the imported
                sounds and configurations
              </li>
            </ol>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-2">
              Note: ImpAmp3 supports importing both ImpAmp3 and ImpAmp2 format
              files.
            </p>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Backup Reminders</h4>
            <p>
              ImpAmp3 can remind you when profiles haven't been backed up
              recently:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>
                Each profile has a configurable backup reminder period (default:
                30 days)
              </li>
              <li>
                When a profile hasn't been backed up for the specified period, a
                notification will appear
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
          <h3 className="text-lg font-medium">Google Drive Sync</h3>

          <div className="p-4 bg-blue-50 dark:bg-blue-900/20 text-blue-800 dark:text-blue-200 rounded-md">
            <p className="font-medium">Coming Soon</p>
            <p className="mt-2">
              Google Drive integration will be available in a future update.
              This feature will allow you to:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Sync your profiles across multiple devices</li>
              <li>Automatically back up your configurations</li>
              <li>Access your sounds from anywhere</li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Planned Features</h4>
            <ul className="list-disc pl-5 space-y-1">
              <li>Create Google Drive-synced profiles</li>
              <li>Automatic background syncing</li>
              <li>Conflict resolution for changes made on multiple devices</li>
              <li>Sync status indicators</li>
              <li>Selective sync options for large profiles</li>
            </ul>
          </div>

          <div className="space-y-2 mt-4">
            <h4 className="font-medium">Current Alternatives</h4>
            <p>
              Until Google Drive sync is available, you can use these methods to
              sync your profiles:
            </p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Export profiles to JSON files and manually transfer them</li>
              <li>
                Use a third-party file sync service to sync the exported JSON
                files
              </li>
              <li>Back up your profiles regularly using the export feature</li>
            </ul>
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
              <li>Click "Add Sound(s)..." to select additional audio files</li>
              <li>Use drag-and-drop to reorder sounds in the list</li>
              <li>Click the 'X' button next to a sound to remove it</li>
              <li>Select a playback mode (see below)</li>
              <li>Click "Save Changes" to apply your configuration</li>
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
                randomly selected sound that hasn't been played yet in the
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
              <li>
                For round-robin mode, try to use sounds of similar length and
                style for consistency
              </li>
            </ul>
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
      </div>
    </div>
  );
};

export default HelpModalContent;
