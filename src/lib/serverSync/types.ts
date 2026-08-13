/**
 * Types for server-backed profile sync.
 *
 * Deliberately mirrors the Google Drive sync surface (`SyncStatus`,
 * `SyncResult`) so the two backends stay interchangeable from the UI's
 * point of view.
 */

import type { ProfileSyncData, ItemConflict } from "@/lib/syncUtils";

export type { ProfileSyncData, ItemConflict };

export type ServerRole = "owner" | "editor" | "viewer";

export interface ServerProfileSummary {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  access: ServerRole;
  ownerEmail: string;
}

export interface ServerProfilePayload {
  id: string;
  name: string;
  version: number;
  updatedAt: number;
  access: ServerRole;
  data: ProfileSyncData;
}

export interface ServerShare {
  id: number;
  role: "viewer" | "editor";
  email: string | null;
  linkToken: string | null;
  createdAt: number;
}

export interface ServerUser {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  isAdmin: boolean;
  canUploadAudio: boolean;
}

export type ServerSyncStatus =
  | "idle"
  | "syncing"
  | "success"
  | "error"
  | "conflict";

export type ServerSyncResult =
  | {
      status: "success";
      version: number;
      data: ProfileSyncData;
      warnings?: string[];
    }
  | { status: "unchanged"; version: number }
  | { status: "skipped"; reason: string }
  | { status: "conflict"; conflicts: ItemConflict[] }
  | { status: "error"; error: string };

/** Raised when the server rejects a write because someone else got there first. */
export class VersionConflictError extends Error {
  constructor(
    public readonly currentVersion: number,
    public readonly currentName: string,
    public readonly currentData: ProfileSyncData,
  ) {
    super(`Profile changed on the server (now version ${currentVersion})`);
    this.name = "VersionConflictError";
  }
}

/** Raised when the caller isn't signed in to the server. */
export class NotSignedInError extends Error {
  constructor() {
    super("Not signed in to the ImpAmp server");
    this.name = "NotSignedInError";
  }
}
