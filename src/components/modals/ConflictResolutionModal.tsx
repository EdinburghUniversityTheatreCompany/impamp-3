import React, { useState, useCallback, useMemo } from "react"; // Removed useEffect
import {
  ItemConflict,
  ProfileSyncData,
  applyConflictResolutions,
  type ConflictResolutionState,
  type FieldResolutions,
  type ResolutionChoice,
} from "@/lib/syncUtils";
import { Profile, PadConfiguration, PageMetadata } from "@/lib/db";
import type { SyncConflictData } from "@/lib/googleDrive/types";
import { conflictOriginLabel } from "@/lib/syncUtils";
import { count } from "@/lib/plural";

interface ConflictResolutionModalProps {
  conflicts: ItemConflict[];
  conflictData: SyncConflictData;
  onResolve: (resolvedData: ProfileSyncData) => void;
  onCancel: () => void;
}

// Helper to get a display name for an item based on conflict info
const getItemDisplayName = (conflict: ItemConflict): string => {
  switch (conflict.storeName) {
    case "profiles":
      // Ensure accessing name property safely
      const profileItem = (conflict.localItem ?? conflict.remoteItem) as
        Profile | undefined;
      return `Profile: ${profileItem?.name ?? "Unknown"}`;
    case "padConfigurations": {
      const item = (conflict.localItem ?? conflict.remoteItem) as
        PadConfiguration | undefined;
      return `Pad Config: Bank ${item?.bankId ?? "?"}, Pad ${item?.padIndex ?? "?"}`;
    }
    case "pageMetadata": {
      const item = (conflict.localItem ?? conflict.remoteItem) as
        PageMetadata | undefined;
      return `Bank Meta: ${item?.bankId ?? "?"} (${item?.name ?? "Unnamed"})`;
    }
    default:
      // Ensure key is stringified if it's a number
      return `Item Key: ${String(conflict.key)}`;
  }
};

// Helper to stringify values for display, handling objects/arrays
const displayValue = (value: unknown): string => {
  if (value === null || value === undefined) return "N/A";
  if (typeof value === "object") {
    try {
      // Use JSON.stringify for consistent serialization, handle potential circular refs if necessary
      return JSON.stringify(value, null, 2); // Pretty print objects/arrays
    } catch (e) {
      console.error("Error stringifying value for display:", e);
      return "[Object Display Error]";
    }
  }
  return String(value);
};

export const ConflictResolutionModal: React.FC<
  ConflictResolutionModalProps
> = ({ conflicts, conflictData, onResolve, onCancel }) => {
  const [resolutions, setResolutions] = useState<ConflictResolutionState>({});
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  // Group conflicts by item key for easier rendering
  const groupedConflicts = useMemo(() => {
    const groups: Record<string | number, ItemConflict[]> = {};
    conflicts.forEach((conflict) => {
      const keyStr = String(conflict.key); // Ensure key is string for object access
      if (!groups[keyStr]) {
        groups[keyStr] = [];
      }
      groups[keyStr].push(conflict);
    });
    return groups;
  }, [conflicts]);

  const handleFieldChoiceChange = (
    conflictKey: string | number,
    field: string,
    choice: "local" | "remote",
  ) => {
    const keyStr = String(conflictKey);
    setResolutions((prev) => {
      const currentItemResolutions = (prev[keyStr] ?? {}) as FieldResolutions;
      return {
        ...prev,
        [keyStr]: {
          ...currentItemResolutions,
          [field]: choice,
        },
      };
    });
  };

  const handleItemChoiceChange = (
    conflictKey: string | number,
    choice: ResolutionChoice,
  ) => {
    const keyStr = String(conflictKey);
    setResolutions((prev) => ({
      ...prev,
      [keyStr]: choice,
    }));
  };

  const allConflictsResolved = useMemo(() => {
    return conflicts.every((conflict) => {
      const keyStr = String(conflict.key);
      const resolution = resolutions[keyStr];
      if (!resolution) return false;
      if (conflict.type === "field_conflict") {
        const fieldResolutions = resolution as FieldResolutions;
        // Ensure fieldConflicts is not null/undefined before checking
        return conflict.fieldConflicts?.every(
          (fc) => fieldResolutions[fc.field],
        );
      }
      return true; // local_only or remote_only just need a top-level choice
    });
  }, [conflicts, resolutions]);

  const buildResolvedData = useCallback(
    (): ProfileSyncData =>
      applyConflictResolutions(conflictData.merged, conflicts, resolutions),
    [conflictData, resolutions, conflicts],
  );

  const handleResolveClick = useCallback(() => {
    if (!allConflictsResolved || isResolving) return;
    setIsResolving(true);
    setResolveError(null);
    try {
      const resolvedData = buildResolvedData();
      console.log("Resolved Data:", resolvedData); // Log for debugging
      onResolve(resolvedData);
    } catch (error) {
      console.error("Error building resolved data:", error);
      // Said out loud rather than logged and swallowed. This is the last step
      // of resolving a conflict by hand, and failing it silently left the
      // button re-enabled with no explanation — so the natural response is to
      // press it again and get the same nothing.
      setResolveError(
        error instanceof Error
          ? error.message
          : "Could not apply those choices. Nothing has been changed.",
      );
      setIsResolving(false);
    }
  }, [allConflictsResolved, isResolving, buildResolvedData, onResolve]);

  return (
    <>
      <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto text-sm">
        {resolveError && (
          <p
            role="alert"
            data-testid="conflict-resolve-error"
            className="text-sm text-red-700 dark:text-red-300 bg-red-100 dark:bg-red-900/40 p-3 rounded border border-red-200 dark:border-red-700"
          >
            {resolveError}
          </p>
        )}
        <div className="text-sm text-yellow-800 dark:text-yellow-200 bg-yellow-100 dark:bg-yellow-900/40 p-3 rounded border border-yellow-200 dark:border-yellow-700 space-y-2">
          <p>
            Both your local copy and {conflictOriginLabel(conflictData.origin)}{" "}
            were modified since the last sync. Choose which version to keep for
            each conflict below.
          </p>
          <div className="text-xs text-yellow-700 dark:text-yellow-300 space-y-0.5">
            {conflictData.local._lastSyncTimestamp && (
              <p>
                Last sync:{" "}
                {new Date(
                  conflictData.local._lastSyncTimestamp,
                ).toLocaleString()}
              </p>
            )}
            {conflictData.local.profile._modified && (
              <p>
                Local last modified:{" "}
                {new Date(
                  conflictData.local.profile._modified,
                ).toLocaleString()}
              </p>
            )}
            {conflictData.remote.profile._modified && (
              <p>
                Remote last modified:{" "}
                {new Date(
                  conflictData.remote.profile._modified,
                ).toLocaleString()}
              </p>
            )}
            <p>{count(conflicts.length, "conflict", "conflicts")} to resolve</p>
          </div>
        </div>

        {Object.entries(groupedConflicts).map(([key, itemConflicts]) => (
          <div
            key={key}
            className="border border-gray-300 dark:border-gray-600 rounded p-3 space-y-3 bg-white dark:bg-gray-800 shadow-sm"
          >
            <h3 className="font-semibold text-base border-b dark:border-gray-600 pb-1 mb-2 text-gray-900 dark:text-gray-100">
              {getItemDisplayName(itemConflicts[0])}
            </h3>

            {itemConflicts.map((conflict, index) => (
              <div key={`${key}-${index}`}>
                {conflict.type === "field_conflict" && (
                  <div className="space-y-3">
                    <h4 className="font-medium text-sm text-gray-700 dark:text-gray-300">
                      Field Conflicts:
                    </h4>
                    {conflict.fieldConflicts?.map((fc) => (
                      <div
                        key={fc.field}
                        className="border-t dark:border-gray-600 pt-3 mt-2"
                      >
                        <p className="font-semibold text-gray-800 dark:text-gray-200">
                          {fc.field}:
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mt-1">
                          {/* Local Value */}
                          <div className="bg-blue-50 dark:bg-blue-900/30 p-2 rounded border border-blue-100 dark:border-blue-800">
                            <strong className="block text-blue-800 dark:text-blue-300 mb-1">
                              Local Value:
                            </strong>
                            <pre className="whitespace-pre-wrap break-words bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-1 rounded text-[11px] max-h-24 overflow-auto">
                              {displayValue(fc.localValue)}
                            </pre>
                            <span className="text-gray-500 dark:text-gray-400 text-[10px] block mt-1">
                              {" "}
                              (Modified:{" "}
                              {fc.localModTime
                                ? new Date(fc.localModTime).toLocaleString()
                                : "Unknown"}
                              )
                            </span>
                          </div>
                          {/* Remote Value */}
                          <div className="bg-green-50 dark:bg-green-900/30 p-2 rounded border border-green-100 dark:border-green-800">
                            <strong className="block text-green-800 dark:text-green-300 mb-1">
                              Remote Value:
                            </strong>
                            <pre className="whitespace-pre-wrap break-words bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-200 p-1 rounded text-[11px] max-h-24 overflow-auto">
                              {displayValue(fc.remoteValue)}
                            </pre>
                            <span className="text-gray-500 dark:text-gray-400 text-[10px] block mt-1">
                              {" "}
                              (Modified:{" "}
                              {fc.remoteModTime
                                ? new Date(fc.remoteModTime).toLocaleString()
                                : "Unknown"}
                              )
                            </span>
                          </div>
                        </div>
                        {/* Resolution Choice */}
                        <div className="mt-2 space-x-3 flex items-center">
                          <label className="text-xs flex items-center cursor-pointer text-gray-700 dark:text-gray-300">
                            <input
                              type="radio"
                              name={`conflict-${key}-${fc.field}`}
                              checked={
                                (resolutions[key] as FieldResolutions)?.[
                                  fc.field
                                ] === "local"
                              }
                              onChange={() =>
                                handleFieldChoiceChange(key, fc.field, "local")
                              }
                              className="mr-1 h-3 w-3"
                            />
                            Keep Local
                          </label>
                          <label className="text-xs flex items-center cursor-pointer text-gray-700 dark:text-gray-300">
                            <input
                              type="radio"
                              name={`conflict-${key}-${fc.field}`}
                              checked={
                                (resolutions[key] as FieldResolutions)?.[
                                  fc.field
                                ] === "remote"
                              }
                              onChange={() =>
                                handleFieldChoiceChange(key, fc.field, "remote")
                              }
                              className="mr-1 h-3 w-3"
                            />
                            Keep Remote
                          </label>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {conflict.type === "local_only" && (
                  <div className="border-t dark:border-gray-600 pt-3 mt-2">
                    <h4 className="font-medium text-sm text-blue-700 dark:text-blue-400">
                      Item Exists Only Locally:
                    </h4>
                    <pre className="text-xs bg-blue-50 dark:bg-blue-900/30 text-gray-800 dark:text-gray-200 p-2 rounded border border-blue-100 dark:border-blue-800 whitespace-pre-wrap break-words my-1 max-h-32 overflow-auto">
                      {displayValue(conflict.localItem)}
                    </pre>
                    <div className="mt-2 space-x-2">
                      <button
                        onClick={() => handleItemChoiceChange(key, "keep")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "keep" ? "bg-blue-600 text-white ring-2 ring-blue-300" : "bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 hover:bg-blue-200 dark:hover:bg-blue-800/60"}`}
                      >
                        Keep Local Item
                      </button>
                      <button
                        onClick={() => handleItemChoiceChange(key, "delete")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "delete" ? "bg-red-600 text-white ring-2 ring-red-300" : "bg-red-100 dark:bg-red-900/40 text-red-800 dark:text-red-300 hover:bg-red-200 dark:hover:bg-red-800/60"}`}
                      >
                        Delete Local Item
                      </button>
                    </div>
                  </div>
                )}

                {conflict.type === "remote_only" && (
                  <div className="border-t dark:border-gray-600 pt-3 mt-2">
                    <h4 className="font-medium text-sm text-green-700 dark:text-green-400">
                      Item Exists Only Remotely:
                    </h4>
                    <pre className="text-xs bg-green-50 dark:bg-green-900/30 text-gray-800 dark:text-gray-200 p-2 rounded border border-green-100 dark:border-green-800 whitespace-pre-wrap break-words my-1 max-h-32 overflow-auto">
                      {displayValue(conflict.remoteItem)}
                    </pre>
                    <div className="mt-2 space-x-2">
                      <button
                        onClick={() => handleItemChoiceChange(key, "accept")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "accept" ? "bg-green-600 text-white ring-2 ring-green-300" : "bg-green-100 dark:bg-green-900/40 text-green-800 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800/60"}`}
                      >
                        Accept Remote Item
                      </button>
                      <button
                        onClick={() => handleItemChoiceChange(key, "discard")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "discard" ? "bg-gray-600 text-white ring-2 ring-gray-300" : "bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 hover:bg-gray-300 dark:hover:bg-gray-600"}`}
                      >
                        Discard Remote Item
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="flex justify-end p-4 border-t dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
        <button
          onClick={onCancel}
          disabled={isResolving}
          className="mr-2 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={handleResolveClick}
          disabled={!allConflictsResolved || isResolving}
          className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 border border-transparent rounded-md shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isResolving ? "Resolving..." : "Resolve Conflicts"}
        </button>
      </div>
    </>
  );
};
