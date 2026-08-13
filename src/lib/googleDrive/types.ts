// Re-export types from other files that we need
import type { ProfileSyncData, ItemConflict } from "@/lib/syncUtils";

// Google Drive Permissions API types
export interface DrivePermission {
  id: string;
  type: "user" | "group" | "domain" | "anyone";
  role:
    | "owner"
    | "organizer"
    | "fileOrganizer"
    | "writer"
    | "commenter"
    | "reader";
  emailAddress?: string;
  displayName?: string;
  photoLink?: string;
  pendingOwner?: boolean;
}

// Google Drive API response types
export interface DriveFile {
  kind: string;
  id: string;
  name: string;
  mimeType: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
  parents?: string[];
}

export interface DriveFileList {
  kind: string;
  incompleteSearch: boolean;
  files: DriveFile[];
  nextPageToken?: string;
}

// Sync-related types
export type SyncStatus = "idle" | "syncing" | "conflict" | "error" | "success";

// Data handed to the conflict resolution UI. `merged` is the automatically
// merged result (remote wins and remote-only additions already applied) and is
// the base the resolution must build on; `local` and `remote` are kept for
// display purposes only.
export interface SyncConflictData {
  local: ProfileSyncData;
  remote: ProfileSyncData;
  merged: ProfileSyncData;
  fileId: string;
}

// These interfaces are part of the SyncResult type union
export interface SyncResultSuccess {
  status: "success";
  data: ProfileSyncData;
  warnings?: string[];
}

export interface SyncResultError {
  status: "error";
  error: string;
}

export interface SyncResultPaused {
  status: "paused";
  resumeTime: number;
}

export interface SyncResultSkipped {
  status: "skipped";
  reason: string;
}

export interface SyncResultConflict {
  status: "conflict";
  conflicts: ItemConflict[];
}

export type SyncResult =
  | SyncResultSuccess
  | SyncResultError
  | SyncResultPaused
  | SyncResultSkipped
  | SyncResultConflict;

// Auth-related types
export interface TokenInfo {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
}

// Re-export types from other files that we need
export type { ProfileSyncData, ItemConflict } from "@/lib/syncUtils";
