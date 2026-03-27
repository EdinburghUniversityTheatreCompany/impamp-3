"use client";

import { useState, useEffect, useCallback } from "react";
import { useGoogleDriveSync } from "@/hooks/useGoogleDriveSync";
import type { DrivePermission } from "@/lib/googleDrive/types";

interface SharingPanelProps {
  folderId: string;
  profileFileId: string;
}

export default function SharingPanel({
  folderId,
  profileFileId,
}: SharingPanelProps) {
  const {
    listFolderPermissions,
    setPublicLinkAccess,
    inviteUser,
    removePermission,
  } = useGoogleDriveSync();

  const [permissions, setPermissions] = useState<DrivePermission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"reader" | "writer">("writer");
  const [isInviting, setIsInviting] = useState(false);

  const [publicAccess, setPublicAccess] = useState<"off" | "reader" | "writer">(
    "off",
  );
  const [isSettingPublic, setIsSettingPublic] = useState(false);

  const [shareUrl] = useState(
    `https://drive.google.com/file/d/${profileFileId}/view`,
  );
  const [shareCopied, setShareCopied] = useState(false);

  const loadPermissions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const perms = await listFolderPermissions(folderId);
      setPermissions(perms);
      const anyonePerm = perms.find((p) => p.type === "anyone");
      if (!anyonePerm) {
        setPublicAccess("off");
      } else {
        setPublicAccess(anyonePerm.role === "writer" ? "writer" : "reader");
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to load permissions",
      );
    } finally {
      setLoading(false);
    }
  }, [folderId, listFolderPermissions]);

  useEffect(() => {
    loadPermissions();
  }, [loadPermissions]);

  const handlePublicAccessChange = async (
    access: "off" | "reader" | "writer",
  ) => {
    setIsSettingPublic(true);
    setError(null);
    try {
      await setPublicLinkAccess(folderId, access);
      setPublicAccess(access);
      await loadPermissions();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to update public access",
      );
    } finally {
      setIsSettingPublic(false);
    }
  };

  const handleInvite = async () => {
    if (!inviteEmail.trim()) return;
    setIsInviting(true);
    setError(null);
    try {
      await inviteUser(folderId, inviteEmail.trim(), inviteRole);
      setInviteEmail("");
      await loadPermissions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite user");
    } finally {
      setIsInviting(false);
    }
  };

  const handleRemove = async (permissionId: string) => {
    setError(null);
    try {
      await removePermission(folderId, permissionId);
      await loadPermissions();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to remove permission",
      );
    }
  };

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(shareUrl);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 3000);
  };

  const userPermissions = permissions.filter(
    (p) => p.type === "user" || p.type === "group",
  );

  return (
    <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 space-y-3">
      <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase">
        Sharing
      </h4>

      {error && (
        <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
      )}

      {/* Public link access */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-600 dark:text-gray-400 w-28 shrink-0">
          Anyone with link:
        </span>
        <select
          value={publicAccess}
          onChange={(e) =>
            handlePublicAccessChange(
              e.target.value as "off" | "reader" | "writer",
            )
          }
          disabled={isSettingPublic}
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300 disabled:opacity-50"
        >
          <option value="off">Off (private)</option>
          <option value="reader">Can view</option>
          <option value="writer">Can edit</option>
        </select>
      </div>

      {/* Share link */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 dark:text-gray-400 truncate flex-1 font-mono">
          {shareUrl.length > 45 ? shareUrl.slice(0, 45) + "…" : shareUrl}
        </span>
        <button
          onClick={handleCopyLink}
          className="px-2 py-0.5 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600 shrink-0"
        >
          {shareCopied ? "Copied!" : "Copy"}
        </button>
      </div>

      {/* People with access */}
      <div className="space-y-1">
        <p className="text-xs font-medium text-gray-600 dark:text-gray-400">
          People with access:
        </p>
        {loading ? (
          <p className="text-xs text-gray-400">Loading…</p>
        ) : (
          <ul className="space-y-1">
            {userPermissions.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-2"
              >
                <span className="text-xs text-gray-700 dark:text-gray-300 truncate">
                  {p.emailAddress ?? p.displayName ?? "Unknown"}
                </span>
                <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">
                  {p.role === "owner"
                    ? "Owner"
                    : p.role === "writer"
                      ? "Can edit"
                      : "Can view"}
                </span>
                {p.role !== "owner" && (
                  <button
                    onClick={() => handleRemove(p.id)}
                    className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300 shrink-0"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Invite people */}
      <div className="flex items-center gap-1 flex-wrap">
        <input
          type="email"
          placeholder="Email address"
          value={inviteEmail}
          onChange={(e) => setInviteEmail(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleInvite()}
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300 flex-1 min-w-0"
        />
        <select
          value={inviteRole}
          onChange={(e) => setInviteRole(e.target.value as "reader" | "writer")}
          className="text-xs px-2 py-1 border border-gray-300 dark:border-gray-600 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 dark:bg-gray-700 dark:text-gray-300"
        >
          <option value="writer">Can edit</option>
          <option value="reader">Can view</option>
        </select>
        <button
          onClick={handleInvite}
          disabled={isInviting || !inviteEmail.trim()}
          className="px-2 py-1 text-xs bg-blue-100 text-blue-800 rounded hover:bg-blue-200 transition-colors dark:bg-blue-900/30 dark:text-blue-300 dark:hover:bg-blue-800/40 disabled:opacity-50"
        >
          {isInviting ? "Inviting…" : "Invite"}
        </button>
      </div>
    </div>
  );
}
