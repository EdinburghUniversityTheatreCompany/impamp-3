// Google Drive API response types
export interface DriveFile {
  kind: string;
  id: string;
  name: string;
  mimeType: string;
  appProperties?: Record<string, string>;
  modifiedTime?: string;
}

export interface DriveFileList {
  kind: string;
  incompleteSearch: boolean;
  files: DriveFile[];
}

// Sync-related types
export type SyncStatus = "idle" | "syncing" | "conflict" | "error" | "success";

export interface SyncResultSuccess {
  status: "success";
  data: ProfileSyncData;
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
