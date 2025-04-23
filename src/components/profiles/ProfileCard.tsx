"use client";

import { useState } from "react";
import { useProfileStore } from "@/store/profileStore";
import { Profile, SyncType } from "@/lib/db";
import { formatDistanceToNow } from "date-fns";

interface ProfileCardProps {
  profile: Profile;
  isActive: boolean;
}

export default function ProfileCard({ profile, isActive }: ProfileCardProps) {
  const { setActiveProfileId, updateProfile, deleteProfile } =
    useProfileStore();
  const [isEditing, setIsEditing] = useState(false);
  const [name, setName] = useState(profile.name);
  const [syncType, setSyncType] = useState<SyncType>(profile.syncType);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSave = async () => {
    try {
      await updateProfile(profile.id!, { name, syncType });
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to update profile:", error);
      alert("Failed to update profile. Please try again.");
    }
  };

  const handleDelete = async () => {
    if (isActive) {
      alert(
        "Cannot delete the active profile. Please switch to another profile first.",
      );
      return;
    }

    try {
      setIsDeleting(true);
      await deleteProfile(profile.id!);
      setIsDeleting(false);
    } catch (error) {
      console.error("Failed to delete profile:", error);
      alert("Failed to delete profile. Please try again.");
      setIsDeleting(false);
    }
  };

  const handleActivate = () => {
    if (!isActive) {
      setActiveProfileId(profile.id!);
    }
  };

  return (
    <div
      className={`border rounded-lg p-4 ${
        isActive
          ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
          : "border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800"
      }`}
    >
      {isEditing ? (
        // Edit mode
        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Profile Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
              placeholder="Profile Name"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Sync Type
            </label>
            <select
              value={syncType}
              onChange={(e) => setSyncType(e.target.value as SyncType)}
              className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="local">Local Only</option>
              <option value="googleDrive">Google Drive</option>
            </select>
            {syncType === "googleDrive" && (
              <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                Google Drive integration will be available in a future update.
              </p>
            )}
          </div>

          <div className="flex space-x-2 pt-2">
            <button
              onClick={handleSave}
              className="px-3 py-1 bg-blue-500 text-white rounded-md text-sm hover:bg-blue-600 transition-colors"
            >
              Save
            </button>
            <button
              onClick={() => {
                setName(profile.name);
                setSyncType(profile.syncType);
                setIsEditing(false);
              }}
              className="px-3 py-1 bg-gray-200 dark:bg-gray-700 text-gray-800 dark:text-gray-200 rounded-md text-sm hover:bg-gray-300 dark:hover:bg-gray-600 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        // View mode
        <>
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
                {profile.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {profile.syncType === "googleDrive"
                  ? "Google Drive Sync"
                  : "Local Storage Only"}
              </p>
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                Created{" "}
                {formatDistanceToNow(new Date(profile.createdAt), {
                  addSuffix: true,
                })}
              </p>
            </div>
            <div className="flex space-x-1">
              {isActive ? (
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                  Active
                </span>
              ) : (
                <button
                  onClick={handleActivate}
                  className="px-2 py-1 bg-blue-100 hover:bg-blue-200 text-blue-700 rounded text-xs transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40"
                >
                  Activate
                </button>
              )}
            </div>
          </div>

          <div className="flex mt-4 space-x-2">
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-1 bg-gray-100 text-gray-800 rounded-md text-sm hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              Edit
            </button>
            {!isActive &&
              (isDeleting ? (
                <button
                  disabled
                  className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm opacity-50 dark:bg-red-900/30 dark:text-red-300"
                >
                  Deleting...
                </button>
              ) : (
                <button
                  onClick={() => {
                    if (
                      window.confirm(
                        `Are you sure you want to delete the profile "${profile.name}"? This cannot be undone.`,
                      )
                    ) {
                      handleDelete();
                    }
                  }}
                  className="px-3 py-1 bg-red-100 text-red-800 rounded-md text-sm hover:bg-red-200 transition-colors dark:bg-red-900/30 dark:text-red-300 dark:hover:bg-red-800/40"
                >
                  Delete
                </button>
              ))}
          </div>
        </>
      )}
    </div>
  );
}
