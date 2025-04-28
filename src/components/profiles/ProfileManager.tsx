"use client";

import { useState, useRef, ChangeEvent } from "react";
import { useProfileStore } from "@/store/profileStore";
import { SyncType } from "@/lib/db";
import ProfileCard from "./ProfileCard";

export default function ProfileManager() {
  const {
    profiles,
    activeProfileId,
    isProfileManagerOpen,
    closeProfileManager,
    createProfile,
    exportMultipleProfilesToJSON,
    importProfileFromJSON,
    importProfileFromImpamp2JSON,
    importMultipleProfilesFromJSON,
  } = useProfileStore();

  const [newProfileName, setNewProfileName] = useState("");
  const [newProfileSyncType, setNewProfileSyncType] =
    useState<SyncType>("local");
  const [isCreating, setIsCreating] = useState(false);
  const [activeTab, setActiveTab] = useState<"profiles" | "import-export">(
    "profiles",
  );

  const [isExporting, setIsExporting] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState<string | null>(null);
  const [exportSelectionIds, setExportSelectionIds] = useState<Set<number>>(
    new Set(),
  ); // New state for export tab selection

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Handler for export selection changes in the Import/Export tab
  const handleExportSelectChange = (profileId: number, isSelected: boolean) => {
    setExportSelectionIds((prevSelected) => {
      const newSelected = new Set(prevSelected);
      if (isSelected) {
        newSelected.add(profileId);
      } else {
        newSelected.delete(profileId);
      }
      return newSelected;
    });
  };

  const handleCreateProfile = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!newProfileName.trim()) {
      alert("Please enter a profile name");
      return;
    }

    try {
      setIsCreating(true);
      await createProfile({
        name: newProfileName.trim(),
        syncType: newProfileSyncType,
      });
      setNewProfileName("");
      setNewProfileSyncType("local");
      setIsCreating(false);
    } catch (error) {
      console.error("Failed to create profile:", error);
      alert("Failed to create profile. Please try again.");
      setIsCreating(false);
    }
  };

  if (!isProfileManagerOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black bg-opacity-50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-3xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
            Profile Manager
          </h2>
          <button
            onClick={closeProfileManager}
            className="text-gray-400 hover:text-gray-500 dark:hover:text-gray-300"
            aria-label="Close"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 dark:border-gray-700">
          <nav className="px-6 flex space-x-4">
            <button
              onClick={() => setActiveTab("profiles")}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === "profiles"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Profiles
            </button>
            <button
              onClick={() => setActiveTab("import-export")}
              className={`py-3 font-medium text-sm border-b-2 ${
                activeTab === "import-export"
                  ? "border-blue-500 text-blue-600 dark:text-blue-400"
                  : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              }`}
            >
              Import / Export
            </button>
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === "profiles" && (
            <div>
              {/* Existing Profiles */}
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                Your Profiles
              </h3>

              {profiles.length === 0 ? (
                <div className="text-gray-500 dark:text-gray-400 italic">
                  No profiles found.
                </div>
              ) : (
                <div className="space-y-4">
                  {profiles.map((profile) => (
                    <ProfileCard
                      key={profile.id}
                      profile={profile}
                      isActive={profile.id === activeProfileId}
                    />
                  ))}
                </div>
              )}

              {/* Create New Profile */}
              <div className="mt-8 pt-6 border-t border-gray-200 dark:border-gray-700">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Create New Profile
                </h3>

                <form onSubmit={handleCreateProfile} className="space-y-4">
                  <div>
                    <label
                      htmlFor="profileName"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Profile Name
                    </label>
                    <input
                      id="profileName"
                      type="text"
                      value={newProfileName}
                      onChange={(e) => setNewProfileName(e.target.value)}
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                      placeholder="Enter profile name"
                      required
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="syncType"
                      className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1"
                    >
                      Storage Type
                    </label>
                    <select
                      id="syncType"
                      value={newProfileSyncType}
                      onChange={(e) =>
                        setNewProfileSyncType(e.target.value as SyncType)
                      }
                      className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
                    >
                      <option value="local">Local Only</option>
                      <option value="googleDrive">Google Drive</option>
                    </select>
                    {newProfileSyncType === "googleDrive" && (
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                        Google Drive integration will be available in a future
                        update.
                      </p>
                    )}
                  </div>

                  <div>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className={`px-4 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-colors ${
                        isCreating ? "opacity-70 cursor-not-allowed" : ""
                      }`}
                    >
                      {isCreating ? "Creating..." : "Create Profile"}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          )}

          {activeTab === "import-export" && (
            <div>
              {/* Export Section - Revised for Multi-Select */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Export Profiles
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Select one or more profiles below to export their
                  configurations to a single file.
                </p>

                {/* New Multi-Select List */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700 max-h-60 overflow-y-auto mb-4">
                  <h4 className="text-md font-medium text-gray-800 dark:text-gray-200 mb-3">
                    Select Profiles to Export:
                  </h4>
                  {profiles.length === 0 ? (
                    <p className="text-sm text-gray-500 dark:text-gray-400 italic">
                      No profiles available to export.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {profiles.map((profile) => (
                        <div key={profile.id} className="flex items-center">
                          <input
                            id={`export-profile-${profile.id}`}
                            type="checkbox"
                            checked={exportSelectionIds.has(profile.id!)}
                            onChange={(e) =>
                              handleExportSelectChange(
                                profile.id!,
                                e.target.checked,
                              )
                            }
                            className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500 dark:focus:ring-blue-600 dark:ring-offset-gray-800 focus:ring-2 dark:bg-gray-700 dark:border-gray-600"
                          />
                          <label
                            htmlFor={`export-profile-${profile.id}`}
                            className="ml-2 block text-sm text-gray-900 dark:text-gray-300"
                          >
                            {profile.name}{" "}
                            {profile.id === activeProfileId ? "(Active)" : ""}
                          </label>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Updated Export Selected Button */}
                <button
                  onClick={async () => {
                    if (exportSelectionIds.size === 0) {
                      // Use new state
                      alert("Please select at least one profile to export.");
                      return;
                    }
                    // Check if the function exists before calling
                    if (!exportMultipleProfilesToJSON) {
                      console.error(
                        "exportMultipleProfilesToJSON function is not available in the profile store.",
                      );
                      alert("Multi-export functionality is not available.");
                      return;
                    }
                    try {
                      setIsExporting(true);
                      // Call the multi-export function from the store using new state
                      await exportMultipleProfilesToJSON(
                        Array.from(exportSelectionIds),
                      );
                      setIsExporting(false);
                      setExportSelectionIds(new Set()); // Clear selection after export
                    } catch (error) {
                      console.error(
                        "Failed to export selected profiles:",
                        error,
                      );
                      setIsExporting(false);
                      alert(
                        "Failed to export selected profiles. Please try again.",
                      );
                    }
                  }}
                  disabled={isExporting || exportSelectionIds.size === 0} // Use new state
                  className={`px-4 py-2 ${
                    exportSelectionIds.size > 0 // Use new state
                      ? "bg-green-500 text-white hover:bg-green-600"
                      : "bg-gray-200 text-gray-500"
                  } rounded-md transition-colors ${
                    isExporting || exportSelectionIds.size === 0 // Use new state
                      ? "cursor-not-allowed"
                      : ""
                  }`}
                >
                  {isExporting
                    ? "Exporting..."
                    : `Export Selected (${exportSelectionIds.size})`}
                </button>
              </section>

              {/* Import Section (Remains the same) */}
              <section className="mb-8">
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Import Profile
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Import a previously exported profile configuration file.
                </p>

                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <input
                    type="file"
                    ref={fileInputRef}
                    data-testid="import-profile-file-input"
                    className="hidden"
                    accept=".json,.iajson"
                    onChange={async (e: ChangeEvent<HTMLInputElement>) => {
                      // Reset states
                      setImportError(null);
                      setImportSuccess(null);

                      const file = e.target.files?.[0];
                      if (!file) return;

                      try {
                        setIsImporting(true);

                        // Read the file
                        const reader = new FileReader();
                        reader.onload = async (event) => {
                          const content = event.target?.result as string;
                          if (!content) {
                            setImportError("Failed to read file content.");
                            setIsImporting(false);
                            return;
                          }

                          try {
                            const parsedData = JSON.parse(content);

                            // --- Check for Multi-Profile Format (Version 1) ---
                            if (
                              parsedData &&
                              parsedData.exportVersion === 1 &&
                              Array.isArray(parsedData.profiles)
                            ) {
                              console.log(
                                "Attempting import as multi-profile format (v1)...",
                              );
                              // Check if the function exists before calling (Uncommented)
                              if (!importMultipleProfilesFromJSON) {
                                console.error(
                                  "importMultipleProfilesFromJSON function is not available in the profile store.",
                                );
                                throw new Error(
                                  "Multi-import functionality is not available.",
                                );
                              }
                              // Use store function
                              const results =
                                await importMultipleProfilesFromJSON(content);
                              // Add explicit types for filter/map parameters
                              const successes = results.filter(
                                (r: { result: number | Error }) =>
                                  typeof r.result === "number",
                              ).length;
                              const failures = results.length - successes;
                              let message = `Multi-profile import complete: ${successes} succeeded`;
                              if (failures > 0) {
                                message += `, ${failures} failed.`;
                                const failedNames = results
                                  .filter(
                                    (r: { result: number | Error }) =>
                                      r.result instanceof Error,
                                  )
                                  .map(
                                    (r: { profileName: string }) =>
                                      r.profileName,
                                  ) // Add type here too
                                  .join(", ");
                                message += ` Failed profiles: ${failedNames}`;
                                setImportError(message); // Show summary as error if any failed
                              } else {
                                setImportSuccess(message); // Show as success only if all succeeded
                              }
                              setIsImporting(false);

                              // --- Check for Single Profile Format (Version 2) ---
                            } else if (
                              parsedData &&
                              parsedData.exportVersion === 2 &&
                              parsedData.profile
                            ) {
                              console.log(
                                "Attempting import as current single profile format (v2)...",
                              );
                              const currentProfileId =
                                await importProfileFromJSON(content);
                              setImportSuccess(
                                `Profile imported successfully! (New ID: ${currentProfileId})`,
                              );
                              setIsImporting(false);

                              // --- Check for Legacy Impamp2 Format (heuristic check) ---
                            } else if (
                              parsedData &&
                              parsedData.pages &&
                              typeof parsedData.pages === "object" &&
                              !parsedData.exportVersion
                            ) {
                              // Heuristic: has 'pages' object, no 'exportVersion'
                              console.log(
                                "Attempting import as impamp2 format...",
                              );
                              const impamp2ProfileId =
                                await importProfileFromImpamp2JSON(content);
                              setImportSuccess(
                                `Impamp2 profile imported successfully! (New ID: ${impamp2ProfileId})`,
                              );
                              setIsImporting(false);
                            } else {
                              // --- Unrecognized format ---
                              console.error(
                                "Unrecognized file format.",
                                parsedData,
                              );
                              setImportError(
                                "Failed to import: Unrecognized or invalid file format.",
                              );
                              setIsImporting(false);
                            }
                          } catch (error) {
                            console.error(
                              "Error during import processing:",
                              error,
                            );
                            let finalErrorMessage =
                              "Failed to import profile: ";
                            if (error instanceof SyntaxError) {
                              finalErrorMessage +=
                                "Invalid JSON format in file.";
                            } else if (error instanceof Error) {
                              finalErrorMessage += error.message; // Use the specific error message
                            } else {
                              finalErrorMessage +=
                                "An unknown error occurred during import.";
                            }
                            setImportError(finalErrorMessage);
                            setIsImporting(false);
                          } finally {
                            // Reset the file input regardless of success or failure
                            if (fileInputRef.current) {
                              fileInputRef.current.value = "";
                            }
                          }
                        };

                        reader.onerror = () => {
                          setImportError("Failed to read file");
                          setIsImporting(false);
                        };

                        reader.readAsText(file);
                      } catch (error) {
                        const errorMessage =
                          error instanceof Error
                            ? error.message
                            : "An unknown error occurred";
                        setImportError(
                          `Failed to import profile: ${errorMessage}`,
                        );
                        setIsImporting(false);
                      }
                    }}
                  />

                  {importError && (
                    <div className="mb-4 p-2 bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-300 rounded border border-red-200 dark:border-red-800">
                      {importError}
                    </div>
                  )}

                  {importSuccess && (
                    <div className="mb-4 p-2 bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-300 rounded border border-green-200 dark:border-green-800">
                      {importSuccess}
                    </div>
                  )}

                  <button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isImporting}
                    className={`px-4 py-2 ${
                      isImporting
                        ? "bg-gray-200 text-gray-500 cursor-not-allowed"
                        : "bg-blue-500 text-white hover:bg-blue-600"
                    } rounded-md transition-colors`}
                  >
                    {isImporting ? "Importing..." : "Select File to Import"}
                  </button>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    Only import files that were previously exported from ImpAmp2
                    or ImpAmp3.
                  </p>
                </div>
              </section>

              {/* Google Drive Integration */}
              <section>
                <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-4">
                  Google Drive Integration
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Connect your profiles to Google Drive to sync your sound
                  configurations across devices.
                </p>

                {/* TODO: Implement Google Drive integration */}
                <div className="bg-gray-50 dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
                  <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
                    Google Drive integration will be available in a future
                    update.
                  </p>
                  <button
                    disabled
                    className="px-4 py-2 bg-gray-200 text-gray-500 rounded-md cursor-not-allowed"
                  >
                    Connect to Google Drive
                  </button>
                </div>
              </section>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-700 flex justify-end">
          <button
            onClick={closeProfileManager}
            className="px-4 py-2 bg-gray-100 text-gray-800 rounded-md hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
