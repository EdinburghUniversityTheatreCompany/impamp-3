import React, { useState, useCallback, useMemo } from "react"; // Removed useEffect
import {
  ItemConflict,
  ProfileSyncData,
  Syncable,
  deepClone,
} from "@/lib/syncUtils"; // Removed FieldConflict (unused in this file)
import { Profile, PadConfiguration, PageMetadata } from "@/lib/db";
import Modal from "@/components/Modal"; // Assuming a basic Modal component exists

type ResolutionChoice =
  | "local"
  | "remote"
  | "keep"
  | "delete"
  | "accept"
  | "discard";
type FieldResolutions = Record<string, ResolutionChoice>; // field -> 'local' | 'remote'
type ConflictResolutionState = Record<
  string | number,
  ResolutionChoice | FieldResolutions
>; // conflict.key -> choice or field choices

interface ConflictResolutionModalProps {
  conflicts: ItemConflict[];
  conflictData: {
    local: ProfileSyncData;
    remote: ProfileSyncData;
    fileId: string;
  };
  onResolve: (resolvedData: ProfileSyncData) => void;
  onCancel: () => void;
}

// Helper to get a display name for an item based on conflict info
const getItemDisplayName = (conflict: ItemConflict): string => {
  switch (conflict.storeName) {
    case "profiles":
      // Ensure accessing name property safely
      const profileItem = (conflict.localItem ?? conflict.remoteItem) as
        | Profile
        | undefined;
      return `Profile: ${profileItem?.name ?? "Unknown"}`;
    case "padConfigurations": {
      const item = (conflict.localItem ?? conflict.remoteItem) as
        | PadConfiguration
        | undefined;
      return `Pad Config: Page ${item?.pageIndex ?? "?"}, Pad ${item?.padIndex ?? "?"}`;
    }
    case "pageMetadata": {
      const item = (conflict.localItem ?? conflict.remoteItem) as
        | PageMetadata
        | undefined;
      return `Page Meta: Page ${item?.pageIndex ?? "?"} (${item?.name ?? "Unnamed"})`;
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

  const buildResolvedData = useCallback((): ProfileSyncData => {
    const resolved = deepClone(conflictData.local); // Start with local as base
    const now = Date.now();

    const resolvedPadConfigs = new Map(
      resolved.padConfigurations.map((p) => [
        `${p.pageIndex}-${p.padIndex}`,
        p,
      ]),
    );
    const resolvedPageMeta = new Map(
      resolved.pageMetadata.map((p) => [p.pageIndex.toString(), p]),
    );

    conflicts.forEach((conflict) => {
      const keyStr = String(conflict.key);
      const resolution = resolutions[keyStr];
      if (!resolution) return;

      switch (conflict.type) {
        case "field_conflict": {
          const fieldResolutions = resolution as FieldResolutions;
          let targetItem: Syncable | undefined | null = null;

          if (conflict.storeName === "profiles") {
            targetItem = resolved.profile;
          } else if (conflict.storeName === "padConfigurations") {
            targetItem = resolvedPadConfigs.get(keyStr);
          } else if (conflict.storeName === "pageMetadata") {
            targetItem = resolvedPageMeta.get(keyStr);
          }

          if (targetItem) {
            let itemModified = false;
            conflict.fieldConflicts?.forEach((fc) => {
              const choice = fieldResolutions[fc.field];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const currentValStr = JSON.stringify(
                (targetItem as any)[fc.field],
              ); // Use any for dynamic access

              if (choice === "local") {
                const localValStr = JSON.stringify(fc.localValue);
                if (currentValStr !== localValStr) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (targetItem as any)[fc.field] = fc.localValue; // Use any for dynamic assignment
                  itemModified = true;
                }
                if (!targetItem._fieldsModified)
                  targetItem._fieldsModified = {};
                targetItem._fieldsModified[fc.field] = fc.localModTime;
              } else if (choice === "remote") {
                const remoteValStr = JSON.stringify(fc.remoteValue);
                if (currentValStr !== remoteValStr) {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  (targetItem as any)[fc.field] = fc.remoteValue; // Use any for dynamic assignment
                  itemModified = true;
                }
                if (!targetItem._fieldsModified)
                  targetItem._fieldsModified = {};
                targetItem._fieldsModified[fc.field] = fc.remoteModTime;
              }
            });
            // Update the overall modified time only if a field actually changed value
            if (itemModified) {
              targetItem._modified = now;
            } else {
              // If only timestamps changed, still update _modified to latest of the chosen fields
              const latestFieldMod = conflict.fieldConflicts
                ? Math.max(
                    0,
                    ...conflict.fieldConflicts.map((fc) =>
                      fieldResolutions[fc.field] === "local"
                        ? fc.localModTime
                        : fc.remoteModTime,
                    ),
                  )
                : 0;
              targetItem._modified = Math.max(
                targetItem._modified ?? 0,
                latestFieldMod,
              );
            }
          }
          break;
        }
        case "local_only": {
          if (resolution === "delete") {
            if (conflict.storeName === "padConfigurations") {
              resolvedPadConfigs.delete(keyStr);
            } else if (conflict.storeName === "pageMetadata") {
              resolvedPageMeta.delete(keyStr);
            }
          }
          // If 'keep', it's already in the local base, ensure its timestamp reflects this sync
          else if (resolution === "keep") {
            let targetItem: Syncable | undefined | null = null;
            if (conflict.storeName === "padConfigurations")
              targetItem = resolvedPadConfigs.get(keyStr);
            else if (conflict.storeName === "pageMetadata")
              targetItem = resolvedPageMeta.get(keyStr);
            if (targetItem) targetItem._modified = now; // Mark as touched by this sync
          }
          break;
        }
        case "remote_only": {
          if (resolution === "accept" && conflict.remoteItem) {
            const itemToAdd = deepClone(conflict.remoteItem);
            // Ensure sync fields exist and mark as modified now
            itemToAdd._created = itemToAdd._created ?? now;
            itemToAdd._modified = now;
            itemToAdd._fieldsModified = itemToAdd._fieldsModified ?? {};
            // Mark all fields as modified at this time
            Object.keys(itemToAdd).forEach((k) => {
              if (
                !k.startsWith("_") &&
                k !== "id" &&
                k !== "createdAt" &&
                k !== "updatedAt"
              ) {
                if (!itemToAdd._fieldsModified) itemToAdd._fieldsModified = {};
                itemToAdd._fieldsModified[k] = now;
              }
            });

            if (conflict.storeName === "padConfigurations") {
              resolvedPadConfigs.set(keyStr, itemToAdd as PadConfiguration);
            } else if (conflict.storeName === "pageMetadata") {
              resolvedPageMeta.set(keyStr, itemToAdd as PageMetadata);
            }
          }
          break;
        }
      }
    });

    resolved.padConfigurations = Array.from(resolvedPadConfigs.values());
    resolved.pageMetadata = Array.from(resolvedPageMeta.values());
    resolved._lastSyncTimestamp = now; // Set final sync timestamp for the whole profile data

    // Ensure top-level profile _modified reflects the latest change
    const latestItemMod = Math.max(
      0,
      ...resolved.padConfigurations.map((p) => p._modified ?? 0),
      ...resolved.pageMetadata.map((p) => p._modified ?? 0),
    );
    resolved.profile._modified = Math.max(
      resolved.profile._modified ?? 0,
      latestItemMod,
      now,
    );

    return resolved;
  }, [conflictData, resolutions, conflicts]);

  const handleResolveClick = useCallback(() => {
    if (!allConflictsResolved || isResolving) return;
    setIsResolving(true);
    try {
      const resolvedData = buildResolvedData();
      console.log("Resolved Data:", resolvedData); // Log for debugging
      onResolve(resolvedData);
    } catch (error) {
      console.error("Error building resolved data:", error);
      // TODO: Show error to user in the modal?
      setIsResolving(false);
    }
  }, [allConflictsResolved, isResolving, buildResolvedData, onResolve]);

  return (
    <Modal isOpen={true} onClose={onCancel} title="Resolve Sync Conflicts">
      <div className="p-4 space-y-4 max-h-[70vh] overflow-y-auto text-sm">
        <p className="text-sm text-yellow-700 bg-yellow-100 p-2 rounded border border-yellow-200">
          Changes were made to this profile both locally and in Google Drive.
          Please resolve the conflicts below.
        </p>

        {Object.entries(groupedConflicts).map(([key, itemConflicts]) => (
          <div
            key={key}
            className="border border-gray-300 rounded p-3 space-y-3 bg-white shadow-sm"
          >
            <h3 className="font-semibold text-base border-b pb-1 mb-2">
              {getItemDisplayName(itemConflicts[0])}
            </h3>

            {itemConflicts.map((conflict, index) => (
              <div key={`${key}-${index}`}>
                {conflict.type === "field_conflict" && (
                  <div className="space-y-3">
                    <h4 className="font-medium text-sm">Field Conflicts:</h4>
                    {conflict.fieldConflicts?.map((fc) => (
                      <div key={fc.field} className="border-t pt-3 mt-2">
                        <p className="font-semibold text-gray-800">
                          {fc.field}:
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs mt-1">
                          {/* Local Value */}
                          <div className="bg-blue-50 p-2 rounded border border-blue-100">
                            <strong className="block text-blue-800 mb-1">
                              Local Value:
                            </strong>
                            <pre className="whitespace-pre-wrap break-words bg-white p-1 rounded text-[11px] max-h-24 overflow-auto">
                              {displayValue(fc.localValue)}
                            </pre>
                            <span className="text-gray-500 text-[10px] block mt-1">
                              {" "}
                              (Modified:{" "}
                              {fc.localModTime
                                ? new Date(fc.localModTime).toLocaleString()
                                : "Unknown"}
                              )
                            </span>
                          </div>
                          {/* Remote Value */}
                          <div className="bg-green-50 p-2 rounded border border-green-100">
                            <strong className="block text-green-800 mb-1">
                              Remote Value:
                            </strong>
                            <pre className="whitespace-pre-wrap break-words bg-white p-1 rounded text-[11px] max-h-24 overflow-auto">
                              {displayValue(fc.remoteValue)}
                            </pre>
                            <span className="text-gray-500 text-[10px] block mt-1">
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
                          <label className="text-xs flex items-center cursor-pointer">
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
                          <label className="text-xs flex items-center cursor-pointer">
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
                  <div className="border-t pt-3 mt-2">
                    <h4 className="font-medium text-sm text-blue-700">
                      Item Exists Only Locally:
                    </h4>
                    <pre className="text-xs bg-blue-50 p-2 rounded border border-blue-100 whitespace-pre-wrap break-words my-1 max-h-32 overflow-auto">
                      {displayValue(conflict.localItem)}
                    </pre>
                    <div className="mt-2 space-x-2">
                      <button
                        onClick={() => handleItemChoiceChange(key, "keep")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "keep" ? "bg-blue-600 text-white ring-2 ring-blue-300" : "bg-blue-100 text-blue-800 hover:bg-blue-200"}`}
                      >
                        Keep Local Item
                      </button>
                      <button
                        onClick={() => handleItemChoiceChange(key, "delete")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "delete" ? "bg-red-600 text-white ring-2 ring-red-300" : "bg-red-100 text-red-800 hover:bg-red-200"}`}
                      >
                        Delete Local Item
                      </button>
                    </div>
                  </div>
                )}

                {conflict.type === "remote_only" && (
                  <div className="border-t pt-3 mt-2">
                    <h4 className="font-medium text-sm text-green-700">
                      Item Exists Only Remotely:
                    </h4>
                    <pre className="text-xs bg-green-50 p-2 rounded border border-green-100 whitespace-pre-wrap break-words my-1 max-h-32 overflow-auto">
                      {displayValue(conflict.remoteItem)}
                    </pre>
                    <div className="mt-2 space-x-2">
                      <button
                        onClick={() => handleItemChoiceChange(key, "accept")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "accept" ? "bg-green-600 text-white ring-2 ring-green-300" : "bg-green-100 text-green-800 hover:bg-green-200"}`}
                      >
                        Accept Remote Item
                      </button>
                      <button
                        onClick={() => handleItemChoiceChange(key, "discard")}
                        className={`px-3 py-1 text-xs rounded font-medium ${resolutions[key] === "discard" ? "bg-gray-600 text-white ring-2 ring-gray-300" : "bg-gray-200 text-gray-800 hover:bg-gray-300"}`}
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

      <div className="flex justify-end p-4 border-t bg-gray-50">
        <button
          onClick={onCancel}
          disabled={isResolving}
          className="mr-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
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
    </Modal>
  );
};
